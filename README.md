# Monitor de noticias del gobierno de EE.UU. → Telegram / correo

Dos piezas gratuitas que se cubren entre sí:

| | Cloudflare Worker (principal) | GitHub Actions (respaldo + vigilante) |
|---|---|---|
| Frecuencia | **cada minuto**, puntual | cada 10 min (con retrasos de GitHub) |
| Qué hace | revisa todas las fuentes y manda a Telegram | lee el estado del Worker; si una fuente falla en Cloudflare o el Worker se cae, la revisa él y te avisa |
| Notifica por | Telegram | Telegram + correo |
| Costo | $0 (plan Free) | $0 (repo público) |

No hay mensajes duplicados: ambos usan los mismos identificadores y se pasan
la lista de "ya vistos" (`/estado` del Worker ↔ `estado.json` del repo).

Fuentes (`fuentes.json`): Casa Blanca (News y Presidential Actions), State Dept,
USDA, USTR y Treasury. Las cuatro primeras tienen RSS; USTR y Treasury no
tienen, así que se leen de su página de press releases.

---

## 1. Bot de Telegram (5 min)
1. En Telegram abre **@BotFather** → `/newbot`. Te da un **token** → `TELEGRAM_BOT_TOKEN`.
2. Mándale "hola" a tu bot.
3. Abre `https://api.telegram.org/bot<TOKEN>/getUpdates` y copia el número de
   `"chat":{"id": ...}` → `TELEGRAM_CHAT_ID`.

## 2. GitHub (respaldo)
1. Crea un repositorio **público** y sube todo el contenido de esta carpeta
   (incluida `.github/workflows/`). Público = minutos de Actions ilimitados y
   gratis; los tokens no se exponen porque van en Secrets.
2. **Settings → Secrets and variables → Actions → New repository secret**:
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` y, si quieres correo,
   `SMTP_USER` (tu Gmail), `SMTP_PASSWORD` (una *contraseña de aplicación* de
   Google), `EMAIL_TO`.
3. **Actions → Monitor de noticias EE.UU. → Run workflow**. La primera corrida
   solo registra lo existente; crea `estado.json` en el repo.
   Revisa el log: cada fuente debe decir `[seed]`. Si alguna dice `403`, ese
   sitio bloquea a GitHub (Cloudflare la cubrirá).

## 3. Cloudflare Worker (principal, cada minuto)
Todo desde el navegador en dash.cloudflare.com (cuenta gratis, sin tarjeta):
1. **Storage & Databases → KV → Create** → nombre `monitor-estado`.
2. **Workers & Pages → Create → Start with Hello World** → nombre
   `monitor-noticias` → Deploy → **Edit code** → borra todo, pega
   `cloudflare/worker.js` → **Deploy**.
3. En el Worker → **Settings**:
   - **Bindings → Add → KV namespace**: nombre de variable `ESTADO`, namespace `monitor-estado`.
   - **Variables and Secrets**:
     - Secret `TELEGRAM_BOT_TOKEN`, Secret `TELEGRAM_CHAT_ID`
     - Secret `RUN_KEY` = cualquier clave inventada (para probar)
     - Text `FUENTES_URL` = `https://raw.githubusercontent.com/<usuario>/<repo>/main/fuentes.json`
     - Text `GITHUB_ESTADO_URL` = `https://raw.githubusercontent.com/<usuario>/<repo>/main/estado.json`
   - **Trigger Events → Add → Cron Triggers** → `* * * * *`
4. Prueba: abre `https://monitor-noticias.<tu-subdominio>.workers.dev/run?key=<RUN_KEY>`.
   Debes ver `[seed]` en cada fuente. Si una dice `HTTP 403`, ese sitio bloquea a
   Cloudflare; GitHub la cubrirá automáticamente.

## 4. Conectar ambos
En GitHub agrega el secreto `CF_ESTADO_URL` =
`https://monitor-noticias.<tu-subdominio>.workers.dev/estado`.
Desde ese momento GitHub deja de notificar las fuentes que Cloudflare lee bien,
y solo actúa si algo falla.

---

## Qué avisos de sistema puedes recibir (⚠️)
- "El Worker de Cloudflare no da señales" → GitHub toma todas las fuentes.
  Otro aviso cuando vuelve.
- "No se puede leer X desde GitHub ni desde Cloudflare (~1 h)" → probablemente
  la página cambió de diseño o bloquea; hay que ajustar `fuentes.json`.

## Agregar o cambiar fuentes
Edita `fuentes.json` en GitHub; el Worker lo relee solo, cada minuto.
- RSS: `{"nombre": "...", "tipo": "rss", "url": "https://.../feed/"}`
- Página sin RSS: `"tipo": "html"`, `"patron_enlace"` (regex que deben cumplir
  las URLs de las notas) y opcional `"id_regex"` (qué parte de la URL identifica
  la nota; evita duplicados cuando el sitio usa varias rutas para la misma).

## Límites del plan gratis (holgados)
- Cloudflare: 1,440 ejecuciones/día de 100,000 permitidas; ~300 escrituras KV/día
  de 1,000; 10 ms de CPU por ejecución (el tiempo de descarga no cuenta). Si en
  los logs del Worker aparece "Exceeded CPU", quita las fuentes `html` del
  Worker y deja que GitHub las cubra.
- GitHub: ilimitado en repos públicos. GitHub pausa workflows programados tras
  60 días sin commits; los commits de `estado.json` lo evitan normalmente. Si
  aun así lo pausa, Cloudflare sigue notificando; solo pierdes el respaldo
  hasta que lo reactives con un clic en la pestaña Actions.

## Prueba local
`pip install -r requirements.txt && DRY_RUN=1 python monitor.py`

## Palabras clave (alertas 🚨)
`palabras_clave.json` (en la raíz) lista los temas a vigilar. Si el **título** de una
nota contiene alguna variante, el mensaje llega marcado con 🚨 y el tema.
- No importan mayúsculas, acentos, guiones ni el posesivo ('s).
- Sí importa singular/plural y formas derivadas (tariff ≠ tariffs): se listan todas.
- Se compara por palabra completa: "import" no se activa con "important".
- Desde Telegram: `/alerta palabra` (agrega, con su plural), `/quitar palabra`, `/alertas`.

## Comandos del bot
/ultimas /ultima /hoy /buscar /fuente /revisar /alertas /alerta /quitar /estado /ayuda,
más un resumen automático a las 20:30 (CDMX). Se activan una vez abriendo
`https://<tu-worker>.workers.dev/telegram/activar?key=<RUN_KEY>`.

## Horario (CDMX)
Lun–vie: 21:00–5:59 cada hora · 6:00–9:59 cada 30 min · 10:00–20:59 cada minuto
(Casa Blanca y Treasury cada 5 min). Sáb–dom: cada hora. Se cambia en las tablas
`HORARIO` / `HORARIO_FINDE` de `cloudflare/worker.js` y `monitor.py`.
