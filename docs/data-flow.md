# Flujo de Datos: de la Página Pública al Dashboard y CMS

Este documento detalla paso a paso cómo se capturan, procesan, almacenan y consumen los datos en Relevo.

---

## 1. De la página pública (`web/`) al backend

### A) Telemetría de visitas y clics (`web/assets/js/track.js`)
1. Al cargar `web/index.html`, `track.js` lee `window.RELEVO.track` desde `web/assets/js/config.js` (por defecto `"/t"`).
2. Determina el origen (`src`) en este orden de prioridad:
   - Parámetro de consulta `?utm_source=...` (ej. `flyer`, `instagram`, `grupos`).
   - Dominio de `document.referrer` (si es externo).
   - Fallback: `"directo"`.
3. Envía un evento `POST /t` con `credentials: "omit"` (cero cookies, cero datos personales):
   ```json
   { "type": "page", "path": "/", "src": "instagram" }
   ```
4. Cuando un visitante pulsa cualquier enlace hacia WhatsApp (`a[href*="wa.me"]`), `track.js` captura el clic en fase de captura y envía `{ "type": "wa", "path": "/", "src": "..." }` con `keepalive: true` para no bloquear la navegación.
5. `server.js` valida origen (`ALLOWED`), aplica límite por IP (40 req/min), sanitiza `src` y `path`, y guarda el registro en la tabla `events` de SQLite.

### B) Cotizador en vivo (`web/assets/js/precios.js` + `turno.js`)
1. El usuario elige tipo de trabajo, extensión y fecha límite en la calculadora del sitio.
2. `RELEVO_PRECIOS.estimate()` aplica la fórmula determinística (mínimo `$50`, techo `$250`, recargo por urgencia y tabla de rangos de `config.js`).
3. Genera automáticamente un mensaje estructurado listo para enviar por WhatsApp (`Servicio`, `Extensión`, `Fecha`, `Tema`, `Estimado`).
4. Ese mismo formato es reconocido por el parser de `panel/panel.js` ("Pegar desde WhatsApp") y por el agente en `backend/src/agent.js`, evitando doble captura manual.

---

## 2. Del backend (`SQLite` + `Obsidian Vault`) al Dashboard (`panel/`)

### A) Carga inicial y detección de modo (`panel/store.js`)
```text
GET /api/state
 ├── 200 OK (JSON) ────────────► Modo servidor activo (10 secciones + sync automático)
 ├── 401 { authRequired: true } ► Pantalla de login -> POST /api/auth/login -> recarga
 └── Error / 404 ──────────────► Modo local offline (localStorage + datos de ejemplo)
```

### B) Qué consume cada sección del Dashboard

| Sección | Endpoint(s) | Origen de datos |
|---|---|---|
| **Hoy** | `GET /api/state` | Pedidos activos ordenados por urgencia (`agendaOf()`) + KPIs del mes |
| **Pedidos** | `GET /api/state`, `PUT /api/entity/order`, `DELETE /api/entity/order/:id` | Tabla `orders` + `payments` + exportación directa a CSV UTF-8 |
| **Clientes** | `GET /api/state`, `PUT /api/entity/client` | Tabla `clients` + totales pagados y saldos calculados |
| **Cursos** | `GET /api/courses`, `POST /api/courses/:id/update`, `POST /api/courses/:id/action` | Tabla `course_jobs` + adaptador de automatización |
| **Cotizar** | Local (`web/assets/js/precios.js`) | Mismo motor de precios que la página pública |
| **WhatsApp** | `GET /api/inbox`, `GET /api/conversation/:id`, `POST /api/inbox/reply`, `POST /api/inbox/pending/:id/*` | Tablas `messages`, `pending` y envío directo por adaptador WA |
| **Mi CMS** | `GET /api/cms`, `PUT /api/cms/site`, `POST/PUT/DELETE /api/cms/notes`, `GET /api/auth/token` | Carpeta `60-CMS/*.md` + `_site.json` + media + gestión de API Key |
| **Análisis** | `GET /api/analytics?days=N` | Agregaciones SQLite en `analytics.js` (embudo, series, mapas de calor) |
| **Tráfico** | `GET /api/state` (`events`) | Tabla `events` capturada por `POST /t` |
| **Sistema** | `GET/PUT /api/settings`, `GET/PUT /api/knowledge/:key`, `POST /api/system/test` | Tabla `kv` + archivos Markdown de reglas en bóveda Obsidian |

---

## 3. Hacia tu CMS personal externo

Existen dos formas complementarias de consumir datos desde un CMS personal externo:

1. **Feed público sin autenticación (`GET /api/cms/public`)**
   - Expone exclusivamente `_site.json` (tagline, promo activa, código de descuento, resumen de precios) y las notas con `status: "publicado"`.
   - Nunca expone clientes, pedidos, teléfonos ni notas privadas.
2. **API completa autenticada (`Authorization: Bearer <API_KEY>` o `X-API-Key`)**
   - Permite leer KPIs, cartera, entradas privadas/borradores, crear o editar artículos Markdown y responder mensajes desde cualquier frontend/backend externo con CORS automático.
