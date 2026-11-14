#!/usr/bin/env python3
"""
Monitor de noticias / press releases del gobierno de EE.UU. — lado GitHub Actions.

Papel en el sistema: RESPALDO + VIGILANTE del Worker de Cloudflare.
  - Si CF_ESTADO_URL está configurado, primero lee el estado del Worker:
      * fuentes que Cloudflare está leyendo bien -> solo sincroniza lo visto
        (no notifica, para no duplicar mensajes);
      * fuentes que Cloudflare no puede leer, o Worker caído -> las revisa y
        notifica él mismo.
  - Si el Worker deja de dar señales, avisa una vez (y otra al recuperarse).
  - Sin CF_ESTADO_URL funciona solo, como monitor principal.

Variables de entorno (en GitHub van como Secrets):
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID          -> Telegram
  SMTP_USER, SMTP_PASSWORD, EMAIL_TO            -> correo (Gmail + contraseña de aplicación)
  SMTP_HOST (default smtp.gmail.com), SMTP_PORT (default 465)
  CF_ESTADO_URL                                 -> https://<worker>.workers.dev/estado
  FUENTES_PATH (default fuentes.json), STATE_PATH (default estado.json)
  DRY_RUN=1  -> imprime en vez de enviar
"""
import hashlib
import html
import json
import os
import re
import smtplib
import sys
import time
import unicodedata
from datetime import datetime, timezone
from email.mime.text import MIMEText
from email.utils import parsedate_to_datetime
from zoneinfo import ZoneInfo
from urllib.parse import urljoin, urlsplit, urlunsplit

import feedparser
import requests
from bs4 import BeautifulSoup

FUENTES_PATH = os.getenv("FUENTES_PATH", "fuentes.json")
PALABRAS_PATH = os.getenv("PALABRAS_PATH", "palabras_clave.json")
STATE_PATH = os.getenv("STATE_PATH", "estado.json")
CF_ESTADO_URL = os.getenv("CF_ESTADO_URL", "").strip()
DRY_RUN = os.getenv("DRY_RUN") == "1"
MAX_RECORDADOS = 200
ZONA = ZoneInfo(os.getenv("ZONA_HORARIA", "America/Mexico_City"))
DIAS = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"]
MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]
FALLOS_PARA_AVISAR = 6            # ~1 hora si corre cada 10 min
CF_SIN_LATIDO_MIN = 15            # minutos sin señal para considerar caído el Worker

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": "Mozilla/5.0 (compatible; MonitorNoticias/2.0)",
    "Accept": "application/rss+xml, application/xml, text/html;q=0.9, */*;q=0.8",
})

# Encabezados de un Chrome real: algunos sitios (State, USDA) usan protección
# anti-bots que rechaza clientes que no parecen navegador.
NAVEGADOR = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,"
              "application/rss+xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

try:  # imita también la "huella" TLS de Chrome, que es lo que revisan los anti-bots
    from curl_cffi import requests as cffi_requests
except ImportError:
    cffi_requests = None


def bajar(url):
    """Descarga la página; si el sitio la rechaza (403/405/429), reintenta
    haciéndose pasar por Chrome."""
    r = SESSION.get(url, timeout=25, headers=NAVEGADOR)
    if r.status_code in (403, 405, 429) and cffi_requests is not None:
        r2 = cffi_requests.get(url, timeout=25, impersonate="chrome", headers={
            "Accept-Language": NAVEGADOR["Accept-Language"]})
        if r2.status_code < 400:
            return r2
        print(f"[warn] {url}: {r.status_code} normal / {r2.status_code} como Chrome",
              file=sys.stderr)
    r.raise_for_status()
    return r


# ---------------------------------------------------------------- estado / ids
def cargar_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def guardar_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")
    os.replace(tmp, path)


def clave_fuente(fuente):
    return hashlib.sha1(fuente["url"].encode()).hexdigest()[:10]


def id_de(url, fuente):
    """Debe coincidir EXACTAMENTE con idDe() de cloudflare/worker.js."""
    if fuente.get("id_regex"):
        m = re.search(fuente["id_regex"], url)
        if m:
            return (m.group(1) if m.groups() else m.group(0)).lower()
    p = urlsplit(url.strip())
    host = p.netloc.lower()
    if (p.scheme == "https" and host.endswith(":443")) or (p.scheme == "http" and host.endswith(":80")):
        host = host.rsplit(":", 1)[0]
    path = p.path.rstrip("/") or "/"
    return urlunsplit((p.scheme.lower(), host, path, "", ""))


def a_ms(texto):
    """Fecha del RSS -> milisegundos desde 1970 (o None)."""
    if not texto:
        return None
    try:
        try:
            dt = parsedate_to_datetime(texto)
        except (TypeError, ValueError):
            dt = datetime.fromisoformat(texto.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except Exception:
        return None


# Horario de trabajo (hora de CDMX): (desde, hasta, cada N min); 0 = no corre.
# Debe coincidir con HORARIO de cloudflare/worker.js.
HORARIO = [(0, 6, 60), (6, 10, 30), (10, 21, 1), (21, 24, 60)]   # lunes a viernes
HORARIO_FINDE = [(0, 24, 60)]                                       # sábado y domingo


def en_horario(ahora=None):
    ahora = ahora or datetime.now(ZONA)
    tabla = HORARIO_FINDE if ahora.weekday() >= 5 else HORARIO
    return any(d <= ahora.hour < hh and cada > 0 for d, hh, cada in tabla)


MAX_GUARDADAS = 30


def ultimas(items, previas, nuevas):
    """Las 30 notas más recientes (para los comandos del bot). Igual que en worker.js.
    'det' = cuándo se detectó como nueva (solo para las que llegaron después de empezar)."""
    previas = previas or []
    det = {x["u"]: x.get("det") for x in previas}
    ahora = int(time.time() * 1000)
    actuales = [{"t": i["titulo"][:160], "u": i["url"], "ts": i.get("ts"),
                 "det": det.get(i["url"]) or (ahora - n * 1000 if i["url"] in nuevas else None)}
                for n, i in enumerate(items[:MAX_GUARDADAS])]
    en_pagina = {x["u"] for x in actuales}
    return (actuales + [x for x in previas if x["u"] not in en_pagina])[:MAX_GUARDADAS]


# ---------------------------------------------------------------- palabras clave
# Sin mayúsculas, sin acentos, sin guiones ni signos y por palabra completa
# ("Mexico's" -> sí; "important" no coincide con "import"). Igual que worker.js.
def norm_texto(s):
    s = unicodedata.normalize("NFD", (s or "").lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return " " + re.sub(r"[^a-z0-9]+", " ", s).strip() + " "


def variantes_de(w):
    """Igual que variantesDe() de worker.js: agrega el singular o plural en inglés."""
    b = w.strip()
    lo = b.lower()
    if " " in b:
        return [b]
    if lo.endswith("ies"):
        return [b, b[:-3] + "y"]
    if re.search(r"(ses|xes|zes|ches|shes)$", lo):
        return [b, b[:-2]]
    if lo.endswith("s"):
        return [b, b[:-1]]
    if re.search(r"[^aeiou]y$", lo):
        return [b, b[:-1] + "ies"]
    if re.search(r"(x|z|ch|sh)$", lo):
        return [b, b + "es"]
    return [b, b + "s"]


def preparar_palabras(cf):
    base = cargar_json(PALABRAS_PATH, [])
    extra = [{"tema": w, "variantes": variantes_de(w)} for w in ((cf.get("_cf") or {}).get("alertas_extra") or [])]
    return [{"tema": p["tema"], "vs": [v for v in map(norm_texto, p.get("variantes", [])) if v.strip()]}
            for p in base + extra]


def coincidencias(titulo, palabras):
    t = norm_texto(titulo)
    return [p["tema"] for p in palabras if any(v in t for v in p["vs"])]


def fecha_local(texto):
    """'Tue, 10 Nov 2026 18:22:09 +0000' -> 'mar 10 nov, 12:22 (CDMX) · llegó 3 min después'"""
    if not texto:
        return ""
    try:
        try:
            dt = parsedate_to_datetime(texto)
        except (TypeError, ValueError):
            dt = datetime.fromisoformat(texto.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
    except Exception:
        return texto
    local = dt.astimezone(ZONA)
    out = f"{DIAS[local.weekday()]} {local.day} {MESES[local.month - 1]}, {local:%H:%M} (CDMX)"
    mins = int((datetime.now(timezone.utc) - dt).total_seconds() // 60)
    if mins >= 0:
        out += f" · llegó {mins} min después" if mins < 120 else f" · llegó {mins // 60} h {mins % 60} min después"
    return out


def union(a, b):
    s = set(a)
    return list(a) + [x for x in b if x not in s]


# ---------------------------------------------------------------- lectura
def leer_rss(fuente):
    r = bajar(fuente["url"])
    feed = feedparser.parse(r.content)
    if feed.bozo and not feed.entries:
        raise ValueError(f"RSS inválido: {feed.bozo_exception}")
    items = []
    for e in feed.entries:
        link = (e.get("link") or "").strip()
        if not link:
            continue
        items.append({
            "id": id_de(link, fuente),
            "titulo": html.unescape(e.get("title", "(sin título)")).strip(),
            "url": link,
            "fecha": fecha_local(e.get("published", e.get("updated", ""))),
            "ts": a_ms(e.get("published", e.get("updated", ""))),
        })
    return items


def leer_html(fuente):
    """Para páginas sin RSS: toma los enlaces cuya URL coincide con 'patron_enlace'."""
    r = bajar(fuente["url"])
    r.raise_for_status()
    soup = BeautifulSoup(r.content, "html.parser")  # detecta el charset de la página
    patron = re.compile(fuente.get("patron_enlace", r"."))
    base = id_de(fuente["url"], {})
    items, vistos = [], set()
    for a in soup.find_all("a", href=True):
        url = urljoin(fuente["url"], a["href"].strip())
        titulo = " ".join(a.get_text(" ", strip=True).split())
        if len(titulo) < 15 or not patron.search(url):
            continue
        uid = id_de(url, fuente)
        if uid in vistos or uid == base:
            continue
        vistos.add(uid)
        items.append({"id": uid, "titulo": titulo, "url": url, "fecha": "", "ts": None})
    return items


LECTORES = {"rss": leer_rss, "html": leer_html}


# ---------------------------------------------------------------- envío
def enviar_telegram(texto_html):
    token, chat = os.getenv("TELEGRAM_BOT_TOKEN"), os.getenv("TELEGRAM_CHAT_ID")
    if not (token and chat):
        return False
    r = SESSION.post(
        f"https://api.telegram.org/bot{token}/sendMessage",
        json={"chat_id": chat, "text": texto_html, "parse_mode": "HTML"},
        timeout=20,
    )
    if r.status_code == 429:
        time.sleep(r.json().get("parameters", {}).get("retry_after", 5))
        return enviar_telegram(texto_html)
    r.raise_for_status()
    return True


def enviar_correo(asunto, cuerpo):
    user, pwd, to = os.getenv("SMTP_USER"), os.getenv("SMTP_PASSWORD"), os.getenv("EMAIL_TO")
    if not (user and pwd and to):
        return False
    msg = MIMEText(cuerpo, "plain", "utf-8")
    msg["Subject"], msg["From"], msg["To"] = asunto, user, to
    with smtplib.SMTP_SSL(os.getenv("SMTP_HOST", "smtp.gmail.com"),
                          int(os.getenv("SMTP_PORT", "465")), timeout=30) as s:
        s.login(user, pwd)
        s.sendmail(user, [x.strip() for x in to.split(",")], msg.as_string())
    return True


def notificar(fuente, nuevos, palabras=()):
    for it in nuevos:
        temas = coincidencias(it["titulo"], palabras)
        it["temas"] = temas
        alerta = f"🚨 <b>ALERTA: {html.escape(' · '.join(temas))}</b>\n" if temas else ""
        texto = (alerta + f"🇺🇸 <b>{html.escape(fuente['nombre'])}</b>\n\n"
                 f"<b>{html.escape(it['titulo'])}</b>\n"
                 + (f"🗓 {html.escape(it['fecha'])}\n" if it["fecha"] else "")
                 + f"🔗 {html.escape(it['url'])}")
        if DRY_RUN:
            print("[DRY] Telegram:\n" + texto + "\n")
            continue
        try:
            enviar_telegram(texto)
        except Exception as e:
            print(f"[warn] Telegram falló: {e}", file=sys.stderr)
        time.sleep(1)

    asunto = (f"[{fuente['nombre']}] {nuevos[0]['titulo']}" if len(nuevos) == 1
              else f"[{fuente['nombre']}] {len(nuevos)} publicaciones nuevas")
    if any(it["temas"] for it in nuevos):
        asunto = "🚨 " + asunto
    cuerpo = "\n\n".join("\n".join(x for x in (it["titulo"], it["fecha"], it["url"]) if x)
                         for it in nuevos)
    if DRY_RUN:
        print(f"[DRY] Correo: {asunto}\n{cuerpo}\n")
        return
    try:
        enviar_correo(asunto, cuerpo)
    except Exception as e:
        print(f"[warn] Correo falló: {e}", file=sys.stderr)


def avisar_sistema(texto):
    print("[aviso]", texto)
    if DRY_RUN:
        return
    for fn in (lambda: enviar_telegram(f"⚠️ {html.escape(texto)}"),
               lambda: enviar_correo("⚠️ Monitor de noticias", texto)):
        try:
            fn()
        except Exception:
            pass


# ---------------------------------------------------------------- Cloudflare
def leer_cloudflare():
    """Devuelve (estado_cf, vivo). vivo=None si no hay Worker configurado."""
    if not CF_ESTADO_URL:
        return {}, None
    try:
        r = SESSION.get(CF_ESTADO_URL, timeout=15)
        r.raise_for_status()
        cf = r.json()
        latido = (cf.get("_cf") or {}).get("latido", 0) / 1000
        vivo = (time.time() - latido) < CF_SIN_LATIDO_MIN * 60
        return cf, vivo
    except Exception as e:
        print(f"[warn] No pude leer el estado de Cloudflare: {e}", file=sys.stderr)
        return {}, False


# ---------------------------------------------------------------- main
def main():
    if not en_horario() and os.getenv("FORZAR") not in ("1", "true"):
        print(f"[horario] {datetime.now(ZONA):%H:%M} CDMX: fuera de horario, no se revisa.")
        return
    fuentes = cargar_json(FUENTES_PATH, [])
    estado = cargar_json(STATE_PATH, {})
    meta = estado.setdefault("_gh", {})
    cf, cf_vivo = leer_cloudflare()
    palabras = preparar_palabras(cf)

    if cf_vivo is not None:
        if not cf_vivo and not meta.get("cf_caido"):
            avisar_sistema("El Worker de Cloudflare no da señales. GitHub Actions toma el "
                           "relevo de todas las fuentes (cada ~10 min).")
            meta["cf_caido"] = True
        elif cf_vivo and meta.get("cf_caido"):
            avisar_sistema("El Worker de Cloudflare volvió a funcionar.")
            meta["cf_caido"] = False

    total = 0
    for f in fuentes:
        k = clave_fuente(f)
        st = estado.setdefault(k, {"nombre": f["nombre"], "vistos": [], "fallos": 0})
        st["nombre"] = f["nombre"]
        cf_st = cf.get(k) or {}
        cf_vistos = cf_st.get("vistos") or []

        # Cloudflare la cubre bien -> solo sincronizar, sin notificar.
        if cf_vivo and cf_vistos and not cf_st.get("fallando_desde"):
            st["vistos"] = union(cf_vistos, st["vistos"])[:MAX_RECORDADOS]
            st["fallos"] = 0
            print(f"[cf] {f['nombre']}: cubierta por Cloudflare, sincronizada.")
            continue

        st["vistos"] = union(st["vistos"], cf_vistos)[:MAX_RECORDADOS]
        try:
            items = LECTORES[f.get("tipo", "rss")](f)
            if not items:
                raise ValueError("0 notas encontradas (¿cambió la página?)")
        except Exception as e:
            st["fallos"] = st.get("fallos", 0) + 1
            print(f"[error] {f['nombre']}: {e} (fallo #{st['fallos']})", file=sys.stderr)
            if st["fallos"] == FALLOS_PARA_AVISAR:
                avisar_sistema(f"No se puede leer '{f['nombre']}' desde GitHub"
                               + (" ni desde Cloudflare" if cf_vivo else "")
                               + f" (~1 h). Último error: {e}")
            continue

        if st.get("fallos", 0) >= FALLOS_PARA_AVISAR:
            avisar_sistema(f"La fuente '{f['nombre']}' volvió a funcionar.")
        st["fallos"] = 0

        vistos = set(st["vistos"])
        ids = [it["id"] for it in items]
        urls_nuevas = set()
        if not st["vistos"]:
            print(f"[seed] {f['nombre']}: {len(items)} notas registradas sin notificar.")
        else:
            nuevos = [it for it in items if it["id"] not in vistos][::-1]
            if nuevos:
                print(f"[nuevo] {f['nombre']}: {len(nuevos)}")
                notificar(f, nuevos, palabras)
                total += len(nuevos)
                urls_nuevas = {it["url"] for it in nuevos}
            else:
                print(f"[ok] {f['nombre']}: sin novedades ({len(items)} revisadas).")
        st["vistos"] = union(ids, st["vistos"])[:MAX_RECORDADOS]
        nuevas_ult = ultimas(items, st.get("ultimas"), urls_nuevas)
        if [x["u"] for x in nuevas_ult] != [x["u"] for x in st.get("ultimas") or []] or st.get("uv") != 2:
            st["ultimas"], st["uv"] = nuevas_ult, 2

    guardar_json(STATE_PATH, estado)
    print(f"[fin] {total} notificaciones enviadas.")


if __name__ == "__main__":
    main()
