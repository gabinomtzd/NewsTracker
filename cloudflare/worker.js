/**
 * Monitor de noticias del gobierno de EE.UU. — Cloudflare Worker (plan gratis)
 *
 * Corre cada minuto (Cron Trigger). Lee las fuentes de fuentes.json (desde tu
 * repo de GitHub), detecta publicaciones nuevas y manda un mensaje a Telegram.
 *
 * Configuración en el dashboard de Cloudflare (Settings del Worker):
 *   KV binding:   ESTADO              -> un namespace KV
 *   Secrets:      TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, RUN_KEY (una clave cualquiera)
 *   Variables:    FUENTES_URL         -> https://raw.githubusercontent.com/<usuario>/<repo>/main/fuentes.json
 *                 GITHUB_ESTADO_URL   -> https://raw.githubusercontent.com/<usuario>/<repo>/main/estado.json
 *   Trigger:      Cron  "* * * * *"
 *   Opcional (despertador de GitHub):
 *     Secret GITHUB_TOKEN  -> token fine-grained con permiso Actions: Read and write
 *     Text   GITHUB_REPO   -> gabinomtzd/NewsTracker
 *     Si hay fuentes que Cloudflare no puede leer, cada 5 min le ordena a
 *     GitHub correr el workflow (GitHub por sí solo corre cada varias horas).
 *
 * Endpoints:
 *   GET /estado            -> estado en JSON (lo lee GitHub Actions para el respaldo)
 *   GET /run?key=RUN_KEY   -> fuerza una revisión y muestra el log (para probar)
 *
 * Presupuesto del plan gratis: ~1,440 ejecuciones/día (límite 100,000) y
 * ~300 escrituras KV/día (límite 1,000): solo se escribe cuando algo cambia
 * y un "latido" cada 5 minutos.
 */

const MAX_RECORDADOS = 200;
const LATIDO_MS = 5 * 60 * 1000;
const MAX_MENSAJES_POR_CORRIDA = 25;   // límite de subrequests del plan gratis: 50
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(revisar(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/estado") {
      const est = (await env.ESTADO.get("estado", "json")) || {};
      return Response.json(est, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/run") {
      if (!env.RUN_KEY || url.searchParams.get("key") !== env.RUN_KEY) {
        return new Response("clave incorrecta", { status: 403 });
      }
      const log = await revisar(env);
      return new Response(log.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    return new Response("Monitor de noticias: OK");
  },
};

// ------------------------------------------------------------------ núcleo
async function revisar(env) {
  const log = [];
  const est = (await env.ESTADO.get("estado", "json")) || {};
  est._cf = est._cf || {};
  let dirty = false;

  // Fuentes: desde GitHub; si falla, la última copia buena guardada en KV.
  let fuentes = est._cf.fuentes || [];
  if (env.FUENTES_URL) {
    try {
      const r = await fetch(env.FUENTES_URL, { cf: { cacheTtl: 300 } });
      if (r.ok) {
        const nuevas = await r.json();
        if (JSON.stringify(nuevas) !== JSON.stringify(fuentes)) {
          fuentes = nuevas;
          est._cf.fuentes = nuevas;
          dirty = true;
        }
      }
    } catch (e) {
      log.push(`[warn] no pude leer FUENTES_URL: ${e}`);
    }
  }

  let ghEstado = null;
  let presupuesto = MAX_MENSAJES_POR_CORRIDA;
  // Si el Worker estuvo detenido (>10 min sin latido), GitHub cubrió todo:
  // hay que incorporar lo que ya notificó para no repetir mensajes.
  const estuvoDetenido = est._cf.latido && Date.now() - est._cf.latido > 10 * 60 * 1000;
  if (estuvoDetenido) log.push("[info] el Worker estuvo detenido; sincronizando con GitHub");

  for (const f of fuentes) {
    const k = await claveFuente(f.url);
    const st = (est[k] = est[k] || { nombre: f.nombre, vistos: [], fallos: 0, fallando_desde: null });
    st.nombre = f.nombre;

    // Fuentes que este Worker no puede leer (bloqueo): no gastar CPU en ellas.
    // Quedan marcadas como "no cubiertas" para que GitHub las revise.
    if (f.solo_github) {
      if (!st.fallando_desde) { st.fallando_desde = "solo_github"; dirty = true; }
      log.push(`[github] ${f.nombre}: la cubre GitHub`);
      continue;
    }

    let items;
    try {
      items = f.tipo === "html" ? await leerHtml(f) : await leerRss(f);
      if (!items.length) throw new Error("0 notas encontradas (¿cambió la página?)");
    } catch (e) {
      if (!st.fallando_desde) {
        st.fallando_desde = new Date().toISOString();
        dirty = true;
      }
      log.push(`[error] ${f.nombre}: ${e}`);
      continue;
    }

    if (st.fallando_desde || estuvoDetenido) {
      // Se recuperó: incorporar lo que GitHub haya notificado mientras tanto.
      if (st.fallando_desde) log.push(`[recuperada] ${f.nombre}`);
      st.fallando_desde = null;
      dirty = true;
      if (ghEstado === null) ghEstado = await traerJson(env.GITHUB_ESTADO_URL);
      if (ghEstado[k]?.vistos) st.vistos = union(st.vistos, ghEstado[k].vistos);
    }

    const vistos = new Set(st.vistos);
    const ids = items.map((i) => i.id);

    if (!st.vistos.length) {
      log.push(`[seed] ${f.nombre}: ${items.length} notas registradas sin notificar`);
      st.vistos = ids.slice(0, MAX_RECORDADOS);
      dirty = true;
      continue;
    }

    const nuevos = items.filter((i) => !vistos.has(i.id)).reverse(); // viejo -> nuevo
    if (!nuevos.length) {
      log.push(`[ok] ${f.nombre}: sin novedades (${items.length})`);
      continue;
    }

    const fallidos = new Set();
    for (const it of nuevos) {
      if (presupuesto <= 0) { fallidos.add(it.id); continue; }  // se envían en la próxima corrida
      presupuesto--;
      const ok = await enviarTelegram(env, mensaje(f, it));
      if (!ok) fallidos.add(it.id);   // se reintenta el próximo minuto
    }
    log.push(`[nuevo] ${f.nombre}: ${nuevos.length - fallidos.size} enviadas, ${fallidos.size} pendientes`);
    st.vistos = union(ids.filter((id) => !fallidos.has(id)), st.vistos).slice(0, MAX_RECORDADOS);
    dirty = true;
  }

  // Despertador: GitHub cubre las fuentes que fallan aquí, pero su horario
  // automático es muy irregular. Cada 5 min le pedimos que corra ya.
  const pendientes = fuentes.filter((f) => Object.values(est).some(
    (v) => v && v.nombre === f.nombre && v.fallando_desde));
  if (pendientes.length && env.GITHUB_TOKEN && env.GITHUB_REPO && new Date().getUTCMinutes() % 5 === 0) {
    try {
      const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/monitor.yml/dispatches`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "monitor-noticias-worker",
          "content-type": "application/json",
        },
        body: JSON.stringify({ ref: "main" }),
      });
      log.push(`[github] despertado (${pendientes.length} fuentes pendientes): HTTP ${r.status}`);
    } catch (e) {
      log.push(`[github] no se pudo despertar: ${e}`);
    }
  }

  const ahora = Date.now();
  if (dirty || !est._cf.latido || ahora - est._cf.latido > LATIDO_MS) {
    est._cf.latido = ahora;
    await env.ESTADO.put("estado", JSON.stringify(est));
  }
  return log;
}

// ------------------------------------------------------------------ lectura
async function bajar(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/rss+xml;q=0.9,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" },
    cf: { cacheTtl: 0 },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

async function leerRss(f) {
  const xml = await bajar(f.url);
  const bloques = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  const out = [];
  for (const b of bloques) {
    let link = etiqueta(b, "link");
    if (!link) link = (b.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1] || "";
    link = limpiar(link);
    if (!link) continue;
    out.push({
      id: idDe(link, f),
      titulo: limpiar(etiqueta(b, "title")) || "(sin título)",
      url: link,
      fecha: fechaLocal(limpiar(etiqueta(b, "pubDate") || etiqueta(b, "published") || etiqueta(b, "updated"))),
    });
  }
  return out;
}

async function leerHtml(f) {
  const html = await bajar(f.url);
  const patron = new RegExp(f.patron_enlace || ".");
  const base = idDe(f.url, {});
  const out = [], vistos = new Set();
  const re = /<a\s[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let url;
    try { url = new URL(limpiar(m[1]), f.url).href; } catch { continue; }
    const titulo = limpiar(m[2]);
    if (titulo.length < 15 || !patron.test(url)) continue;
    const id = idDe(url, f);
    if (vistos.has(id) || id === base) continue;
    vistos.add(id);
    out.push({ id, titulo, url, fecha: "" });
  }
  return out;
}

function etiqueta(bloque, t) {
  const m = bloque.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`, "i"));
  return m ? m[1] : "";
}

function limpiar(s) {
  return (s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}

// "Tue, 10 Nov 2026 18:22:09 +0000" -> "mar 10 nov, 12:22 (CDMX) · llegó 3 min después"
const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
function fechaLocal(texto) {
  if (!texto) return "";
  const d = new Date(texto);
  if (isNaN(d)) return texto;
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Mexico_City", year: "numeric", month: "numeric", day: "numeric",
    weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d).map((x) => [x.type, x.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  let out = `${DIAS[wd]} ${+p.day} ${MESES[+p.month - 1]}, ${p.hour}:${p.minute} (CDMX)`;
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins >= 0) out += mins < 120 ? ` · llegó ${mins} min después` : ` · llegó ${Math.floor(mins / 60)} h ${mins % 60} min después`;
  return out;
}

// Debe coincidir EXACTAMENTE con monitor.py para que ambos compartan estado.
function idDe(url, f) {
  if (f.id_regex) {
    const m = url.match(new RegExp(f.id_regex));
    if (m) return (m[1] ?? m[0]).toLowerCase();
  }
  const u = new URL(url.trim());
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "") || "/"}`;
}

async function claveFuente(url) {
  const h = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(url));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 10);
}

// ------------------------------------------------------------------ util
function union(a, b) {
  const s = new Set(a);
  return [...a, ...b.filter((x) => !s.has(x))];
}

async function traerJson(url) {
  if (!url) return {};
  try {
    const r = await fetch(url, { cf: { cacheTtl: 0 } });
    return r.ok ? await r.json() : {};
  } catch { return {}; }
}

function esc(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function mensaje(f, it) {
  return `🇺🇸 <b>${esc(f.nombre)}</b>\n\n<b>${esc(it.titulo)}</b>\n` +
    (it.fecha ? `🗓 ${esc(it.fecha)}\n` : "") + `🔗 ${esc(it.url)}`;
}

async function enviarTelegram(env, texto) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return true;
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: texto, parse_mode: "HTML" }),
    });
    return r.ok;
  } catch { return false; }
}