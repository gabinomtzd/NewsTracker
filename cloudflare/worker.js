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
const UA = "Mozilla/5.0 (compatible; MonitorNoticias/2.0)";

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
      const r = await fetch(env.FUENTES_URL, { cf: { cacheTtl: 60 } });
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
    headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/html;q=0.9, */*;q=0.8" },
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
      fecha: limpiar(etiqueta(b, "pubDate") || etiqueta(b, "published") || etiqueta(b, "updated")),
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
