# Arquitectura Técnica — Relevo

Este documento explica las decisiones de ingeniería detrás de **Relevo**, cómo se desacoplan sus capas y cómo se mantiene simple de operar sin depender de infraestructura costosa.

## 1. Principios de diseño

- **Cero frameworks innecesarios:** tanto el sitio público (`web/`) como el dashboard (`panel/`) están escritos en HTML, CSS y JavaScript puro modular. El backend usa los módulos nativos de Node.js 22 (`node:http`, `node:crypto`, `node:sqlite`), lo que reduce la superficie de ataque, elimina builds pesados y permite arrancar en milisegundos.
- **Fuente única de verdad con doble proyección:** todo estado transaccional vive en SQLite en modo `WAL` (`relevo.db`), mientras que los documentos legibles y el contenido editorial del CMS se sincronizan a archivos Markdown (`.md`) con frontmatter YAML compatibles con Obsidian.
- **Separación de listeners por nivel de confianza:**
  - **Listener privado (`PANEL_BIND:8787`)**: diseñado para localhost o VPN privada (ej. Tailscale). Expone la API operativa completa.
  - **Listener público autenticado (`127.0.0.1:8789`)**: diseñado para exponerse detrás de un túnel HTTPS / proxy inverso same-origin. Exige cookie de sesión firmada o API Key `Bearer` en toda ruta `/api/*` y bloquea explícitamente (`403`) rutas internas de automatización (`/api/wa/*`).
- **Degradación elegante en cliente (`panel/store.js`)**: el dashboard detecta automáticamente si cuenta con backend (`/api/state`). Si el servidor exige sesión (`401`), monta la pantalla de acceso; si se abre de forma estática sin servidor, funciona sobre `localStorage`.

## 2. Capas del sistema

```text
+-------------------------------------------------------------------+
|  PRESENTACIÓN                                                     |
|  web/ (Landing + Calculadora + track.js)                          |
|  panel/ (Dashboard SPA: Hoy, Pedidos, Clientes, Cursos, WA, CMS)  |
+---------------------------------+---------------------------------+
                                  | HTTP/JSON (same-origin o CORS Bearer)
+---------------------------------v---------------------------------+
|  TRANSPORTE Y SEGURIDAD (backend/src/server.js)                   |
|  - Static file server con protección contra path traversal        |
|  - Auth: scrypt + HMAC-SHA256 HttpOnly cookie + SHA-256 Bearer    |
|  - Rate limiter por IP en login y en /t                           |
|  - CORS dinámico para integraciones con CMS personal externo      |
+---------------------------------+---------------------------------+
                                  |
+---------------------------------v---------------------------------+
|  DOMINIO Y ORQUESTACIÓN                                           |
|  - analytics.js: KPIs, embudo, cohortes, mapas de calor, insights |
|  - agent.js + brain.js + llm.js + guard.js: atención automatizada |
|  - settings.js: configuración tipada en runtime                   |
|  - reports.js: resúmenes y recordatorios                          |
+---------------------------------+---------------------------------+
                                  |
+---------------------------------v---------------------------------+
|  PERSISTENCIA                                                     |
|  - db.js: SQLite (node:sqlite, WAL, migraciones aditivas)         |
|  - vault.js + 60-CMS/: Markdown YAML frontmatter + _site.json     |
+-------------------------------------------------------------------+
```

## 3. Modelo de datos (SQLite)

| Tabla | Propósito | Campos clave |
|---|---|---|
| `clients` | Directorio de clientes y atribución | `id`, `pid`, `wa_id`, `name`, `phone`, `institucion`, `nivel`, `origen`, `attended_at` |
| `orders` | Ciclo de vida de pedidos | `id`, `pid`, `client_id`, `servicio`, `asunto`, `entrega`, `precio`, `estado`, `etapa`, `source` |
| `payments` | Abonos y liquidaciones | `id`, `pid`, `order_id`, `amount`, `method`, `at`, `note` |
| `messages` | Historial bidireccional | `id`, `client_id`, `dir` (`in`/`out`), `body`, `media_path`, `ts`, `by` (`cliente`/`agente`/`dueno`) |
| `pending` | Cola de escalamientos con borrador | `id`, `client_id`, `draft`, `reason`, `status` (`abierto`/`enviado`/`descartado`) |
| `events` | Telemetría anónima del sitio | `id`, `type` (`page`/`wa`), `path`, `src`, `at` |
| `course_jobs` | Trabajos de plataformas educativas | `id`, `order_id`, `client_id`, `status`, `step`, `targets`, `updated` |
| `owner_messages` | Memoria de chat operativo del dueño | `id`, `dir`, `body`, `ts` |
| `kv` | Estado de control y ajustes JSON | `k`, `v` (`rev`, `paused`, `settings`, `ignore_ids`) |

## 4. Sincronización incremental del Dashboard

Para evitar recargas completas y reducir ancho de banda:
1. Cada escritura en SQLite incrementa una revisión monotónica (`kv.rev`).
2. `panel/store.js` guarda un snapshot serializado por entidad (`snap.clients`, `snap.orders`, `snap.payments`).
3. Al editar desde la UI, `syncServer()` calcula el *diff* exacto y envía únicamente `PUT /api/entity/:type` o `DELETE /api/entity/order/:id` para las entidades modificadas, encoladas secuencialmente en una cadena de promesas.
4. En segundo plano, `refreshServer()` consulta `GET /api/rev` cada 20s; solo descarga `GET /api/state` si la revisión cambió.

## 5. Resiliencia del enrutador multi-LLM (`llm.js`)

El módulo `llm.js` permite alternar entre API directa o harnesses CLI externos en tiempo de ejecución desde la pestaña **Sistema**. Cuando un proveedor responde con límite de cuota o *rate limit*, registra un *cooldown* temporal por modelo y cae automáticamente en cascada al siguiente modelo disponible, notificando al dueño sin interrumpir la operación.
