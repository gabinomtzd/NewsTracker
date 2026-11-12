# Guía: Cloudflare Worker para NewsTracker

Todo se hace desde el navegador en https://dash.cloudflare.com (cuenta gratis, sin tarjeta).
Solo necesitas el archivo `worker.js`. `wrangler.toml` es para desplegar desde terminal (opcional).

## 1. Crear el almacenamiento (KV)
Menú izquierdo → **Storage & Databases → KV** → **Create** → nombre: `monitor-estado` → Create.

## 2. Crear el Worker
1. Menú izquierdo → **Compute (Workers) → Workers & Pages** → **Create** → **Start with Hello World**.
2. Nombre: `monitor-noticias` → **Deploy**.
3. **Edit code** → borra todo lo que trae → pega el contenido completo de `worker.js` → **Deploy**.

## 3. Configurar el Worker (pestaña Settings)
**Bindings → Add → KV namespace**
- Variable name: `ESTADO`
- KV namespace: `monitor-estado`

**Variables and Secrets → Add** (uno por uno)

| Tipo | Nombre | Valor |
|---|---|---|
| Secret | `TELEGRAM_BOT_TOKEN` | el mismo token que pusiste en GitHub |
| Secret | `TELEGRAM_CHAT_ID` | el mismo chat id (o el del canal) |
| Secret | `RUN_KEY` | una clave que inventes, p. ej. `gabino2026prueba` |
| Text | `FUENTES_URL` | `https://raw.githubusercontent.com/gabinomtzd/NewsTracker/main/fuentes.json` |
| Text | `GITHUB_ESTADO_URL` | `https://raw.githubusercontent.com/gabinomtzd/NewsTracker/main/estado.json` |

**Trigger Events → Add → Cron Triggers** → expresión `* * * * *` (cada minuto) → Add.

## 4. Probar
Abre en el navegador (tu subdominio aparece en la página del Worker):

    https://monitor-noticias.<tu-subdominio>.workers.dev/run?key=<tu RUN_KEY>

Debes ver una línea por fuente:
- `[seed] ...` → la lee bien (primera vez, no manda mensajes).
- `[error] ... HTTP 403` → esa fuente bloquea a Cloudflare; GitHub la sigue cubriendo.

Lo más importante: qué dice **USDA**.

## 5. Conectar con GitHub
En GitHub → repo NewsTracker → Settings → Secrets and variables → Actions → New repository secret:
- Nombre: `CF_ESTADO_URL`
- Valor: `https://monitor-noticias.<tu-subdominio>.workers.dev/estado`

Listo: Cloudflare revisa cada minuto y GitHub queda de respaldo.

## Cómo saber que sigue vivo
- Abre `https://monitor-noticias.<tu-subdominio>.workers.dev/estado`: el campo `"latido"` se actualiza cada ~5 min.
- En el Worker → pestaña **Logs / Observability** ves cada ejecución.
- Si se cae más de 15 min, GitHub te manda un ⚠️ por Telegram.
