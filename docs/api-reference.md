# Referencia de API REST y CMS Personal

Todas las rutas privadas bajo `/api/*` requieren uno de estos dos mecanismos cuando se accede por el puerto público (`PANEL_PUBLIC_PORT`, por defecto `8789`):

1. **Cookie de sesión** emitida por `POST /api/auth/login` (`relevo_sess`, `HttpOnly; SameSite=Lax; Secure`).
2. **API Key personal** en el encabezado `Authorization: Bearer rl_...` o `X-API-Key: rl_...` (con soporte CORS automático).

---

## Autenticación y API Keys

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `GET` | `/api/auth/status` | Pública | Indica si el listener requiere sesión y si el cliente está autenticado |
| `POST` | `/api/auth/login` | Pública | Valida contraseña (`{ "password": "..." }`) y emite cookie firmada (30 días) |
| `POST` | `/api/auth/logout` | Pública | Invalida la cookie de sesión en el navegador |
| `GET` | `/api/auth/token` | Privada | Devuelve estado y prefijo de la API Key activa + URLs base |
| `POST` | `/api/auth/token/rotate` | Privada | Genera una nueva API Key `rl_...` e invalida la anterior |

## Estado operativo y entidades

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/state` | Snapshot completo (`clients`, `orders`, `payments`, `events`, `meta`) |
| `GET` | `/api/rev` | Revisión incremental actual + estado de WhatsApp y pausa |
| `PUT` | `/api/entity/client` | Crea o actualiza un cliente |
| `PUT` | `/api/entity/order` | Crea o actualiza un pedido |
| `DELETE` | `/api/entity/order/:id` | Elimina un pedido y sus pagos asociados |
| `PUT` | `/api/entity/payment` | Registra un pago y actualiza saldo/estado |

## Analítica y tráfico

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/t` | Rastreador público sin cookies (`{ "type": "page" \| "wa", "path": "/", "src": "..." }`) |
| `GET` | `/api/analytics?days=90` | KPIs, embudo de conversión, series diarias/semanales/mensuales, desgloses e insights |

## Bandeja interactiva de WhatsApp

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/inbox` | Conversaciones recientes, pendientes abiertos y estado del agente |
| `GET` | `/api/conversation/:id` | Historial de mensajes de un cliente |
| `POST` | `/api/inbox/reply` | Envía respuesta directa al cliente (`{ "clientId": "c1", "text": "..." }`) |
| `POST` | `/api/inbox/pending/:id/approve` | Aprueba y envía un borrador pendiente (acepta `{ "text": "..." }` editado) |
| `POST` | `/api/inbox/pending/:id/close` | Descarta o cierra un pendiente |
| `POST` | `/api/inbox/attended/:clientId` | Marca al cliente como atendido |
| `POST` | `/api/agent/pause` / `/resume` | Pausa o reanuda las respuestas automáticas |

## CMS personal (Markdown + Sitio + Media)

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `GET` | `/api/cms/public` | Pública | Feed JSON de solo lectura (`site` + notas con `status: "publicado"`) |
| `GET` | `/api/cms` | Privada | Configuración del sitio, todas las notas, biblioteca de media y metadatos de API Key |
| `PUT` | `/api/cms/site` | Privada | Actualiza `_site.json` (tagline, promos, banner, precios) |
| `GET` | `/api/cms/notes` | Privada | Lista todas las entradas Markdown en `60-CMS/` |
| `POST` | `/api/cms/notes` | Privada | Crea una nueva entrada Markdown con frontmatter YAML |
| `PUT` | `/api/cms/notes/:slug` | Privada | Actualiza una entrada existente |
| `DELETE` | `/api/cms/notes/:slug` | Privada | Elimina una entrada Markdown |
| `GET` | `/api/cms/media/:folder/:file` | Privada | Descarga/visualiza archivos permitidos (`flyers` o `videos`) |

## Ejemplos de integración

### JavaScript / Next.js / Astro
```js
const BASE = "https://tu-dominio.example.com";
const API_KEY = process.env.RELEVO_API_KEY;

// 1. Leer contenido y KPIs para tu CMS personal
const cms = await fetch(`${BASE}/api/cms`, {
  headers: { Authorization: `Bearer ${API_KEY}` },
}).then((r) => r.json());

// 2. Publicar una entrada Markdown desde tu CMS
await fetch(`${BASE}/api/cms/notes`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_KEY}`,
  },
  body: JSON.stringify({
    title: "Promoción de parciales",
    category: "campanas",
    status: "publicado",
    tags: "relevo, promos",
    body: "Contenido en Markdown...",
  }),
});
```

### cURL
```bash
# Feed público sin clave
curl "http://127.0.0.1:8789/api/cms/public"

# Estado completo con API Key
curl -H "Authorization: Bearer rl_tu_api_key" \
  "http://127.0.0.1:8789/api/state"
```
