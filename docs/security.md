# Modelo de Seguridad

Relevo opera con datos operativos y conversaciones de clientes, por lo que su exposición a internet sigue un modelo de **defensa en profundidad**:

## 1. Separación estricta de listeners
- **Puerto privado (`PANEL_BIND:8787`, por defecto `127.0.0.1`)**: reservado para red local o VPN privada (WireGuard / Tailscale). Es el único punto donde están habilitadas las rutas de automatización directa (`/api/wa/*`).
- **Puerto público autenticado (`127.0.0.1:8789`)**: pensado para publicarse detrás de un proxy TLS (Cloudflare Tunnel, Tailscale Funnel, Nginx o Vercel same-origin rewrites).
  - Toda ruta `/api/wa/*` responde **`403 Forbidden`** sin importar si la sesión es válida.
  - Toda ruta privada `/api/*` exige sesión válida o API Key `Bearer`; sin ellas devuelve **`401 Unauthorized`**.

## 2. Almacenamiento seguro de credenciales
- La contraseña del dashboard nunca se almacena en texto plano dentro del archivo de autenticación (`panel-auth.json`, permisos `0600`): se deriva con **`crypto.scryptSync`** y una sal aleatoria de 16 bytes, comparada en tiempo constante con **`crypto.timingSafeEqual`**.
- Las sesiones del navegador usan cookies firmadas con **HMAC-SHA256** (`HttpOnly; SameSite=Lax; Secure`), mitigando robo por XSS y ataques CSRF básicos.
- Las API Keys para CMS externo (`rl_...`) se guardan únicamente como hash **SHA-256** y pueden rotarse en un clic desde el panel, revocando al instante la llave anterior.

## 3. Protección contra abusos y errores comunes
- **Anti fuerza bruta:** `POST /api/auth/login` limita a 10 intentos fallidos por IP en una ventana de 15 minutos (`429 Too Many Requests`).
- **Rastreador acotado:** `POST /t` valida `Origin` contra una lista blanca (`TRACK_ORIGINS`), limita a 40 eventos/min por IP, y sanitiza `src` y `path`.
- **Anti Path Traversal:** tanto el servidor de archivos estáticos como `/api/cms/media/:folder/:file` y `/api/cms/notes/:slug` normalizan rutas (`path.basename` / `path.normalize` + verificación de prefijo) y bloquean extensiones sensibles (`.sql`, secretos).
- **No indexación:** el panel y las respuestas API envían `X-Robots-Tag: noindex, nofollow` y `Cache-Control: no-store`.
- **Feed público aislado:** `/api/cms/public` solo lee `_site.json` y entradas explícitamente marcadas como `status: "publicado"`.
