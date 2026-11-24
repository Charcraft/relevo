'use strict';
// Dos servidores:
//  1) Panel + API (solo por Tailscale): sirve ~/relevo/panel y los datos del negocio.
//  2) Rastreador (127.0.0.1): único endpoint que puede salir a internet si se activa Funnel; solo cuenta visitas.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const db = require('./db');
const analytics = require('./analytics');
const social = require('./social');
const guard = require('./guard');

const SITE = process.env.RELEVO_SITE || path.join(cfg.HOME, 'relevo');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.md': 'text/plain; charset=utf-8', '.ico': 'image/x-icon' };
const json = (res, code, obj, extra = {}) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', ...extra }); res.end(b); };
const body = (req) => new Promise((ok, no) => { let s = ''; req.on('data', (d) => { s += d; if (s.length > 2e6) { no(new Error('muy grande')); req.destroy(); } }); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { no(e); } }); });


const AUTH_FILE = cfg.AUTH_FILE || path.join(cfg.DATA, 'panel-auth.json');
const loginFails = new Map();
function loadAuth() {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch { return null; }
}
function checkPassword(pass) {
  const a = loadAuth(); if (!a || !pass) return false;
  try {
    const derived = crypto.scryptSync(String(pass).trim(), a.salt, 64);
    const expected = Buffer.from(a.hash, 'hex');
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch { return false; }
}
function signSession(exp) {
  const a = loadAuth(); if (!a) return '';
  return crypto.createHmac('sha256', a.secret).update(String(exp)).digest('hex');
}
function parseCookies(req) {
  const out = {};
  const raw = String(req.headers.cookie || '');
  raw.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function verifySession(req) {
  const a = loadAuth(); if (!a) return false;
  const tok = parseCookies(req).relevo_sess || '';
  const [expStr, sig] = tok.split('.');
  const exp = Number(expStr);
  if (!exp || !sig || exp < Date.now()) return false;
  const want = signSession(exp);
  try {
    const b1 = Buffer.from(sig, 'hex'), b2 = Buffer.from(want, 'hex');
    return b1.length === b2.length && crypto.timingSafeEqual(b1, b2);
  } catch { return false; }
}
function makeSessionCookie(req, clear = false) {
  const proto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  const isHttps = proto === 'https' || String(req.headers.host || '').includes('vercel.app') || String(req.headers.host || '').includes('.ts.net');
  const sec = isHttps ? '; Secure' : '';
  if (clear) return 'relevo_sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + sec;
  const exp = Date.now() + 30 * 86400 * 1000;
  return 'relevo_sess=' + encodeURIComponent(exp + '.' + signSession(exp)) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000' + sec;
}


function verifyBearer(req) {
  const a = loadAuth(); if (!a || !a.apiTokenHash) return false;
  const auth = String(req.headers.authorization || '');
  const raw = auth.startsWith('Bearer ') ? auth.slice(7).trim() : String(req.headers['x-api-key'] || '').trim();
  if (!raw) return false;
  try {
    const h = crypto.createHash('sha256').update(raw).digest('hex');
    const b1 = Buffer.from(h, 'hex'), b2 = Buffer.from(a.apiTokenHash, 'hex');
    return b1.length === b2.length && crypto.timingSafeEqual(b1, b2);
  } catch { return false; }
}
function rotateApiToken() {
  const a = loadAuth() || { v: 1 };
  const token = 'rl_' + crypto.randomBytes(20).toString('hex');
  a.apiTokenHash = crypto.createHash('sha256').update(token).digest('hex');
  a.apiTokenPrefix = token.slice(0, 11) + '…';
  a.apiTokenUpdatedAt = new Date().toISOString();
  fs.writeFileSync(AUTH_FILE, JSON.stringify(a, null, 2), { mode: 0o600 });
  try { fs.writeFileSync(path.join(cfg.HOME, '.relevo', 'cms-api-key.txt'), token + '\n', { mode: 0o600 }); } catch {}
  return { token, prefix: a.apiTokenPrefix, updatedAt: a.apiTokenUpdatedAt };
}
function tokenInfo() {
  const a = loadAuth() || {};
  return {
    configured: !!a.apiTokenHash,
    prefix: a.apiTokenPrefix || '',
    updatedAt: a.apiTokenUpdatedAt || null,
    baseUrl: cfg.PUBLIC_BASE_URL || 'http://127.0.0.1:8789',
    backupUrl: cfg.BACKUP_BASE_URL || '',
  };
}
function corsHeaders(req, allowAny = false) {
  const origin = req.headers.origin;
  if (!origin) return {};
  if (!allowAny && !verifyBearer(req) && !ALLOWED.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,x-api-key',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

// ---------- CMS personal (Obsidian 60-CMS + media entregables)
const CMS_DIR = path.join(cfg.VAULT, '60-CMS');
const CMS_SITE_FILE = path.join(CMS_DIR, '_site.json');
const MEDIA_ROOT = path.join(SITE, 'redes-sociales', 'marketing-2026', 'entregables');

function cmsSlug(raw) {
  return String(raw || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || ('nota-' + Date.now().toString(36));
}
function parseFrontmatter(md) {
  const m = String(md || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(md || '') };
  const meta = {};
  m[1].split(/\r?\n/).forEach((line) => {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  return { meta, body: m[2].replace(/^\r?\n/, '') };
}
function buildFrontmatter(meta, body) {
  const lines = ['---'];
  for (const k of ['title', 'category', 'status', 'tags', 'updated']) {
    lines.push(k + ': ' + String(meta[k] || '').replace(/[\r\n]+/g, ' ').trim());
  }
  lines.push('---', '', String(body || ''));
  return lines.join('\n');
}
function readCmsSite() {
  fs.mkdirSync(CMS_DIR, { recursive: true });
  try { return JSON.parse(fs.readFileSync(CMS_SITE_FILE, 'utf8')); } catch { return { negocio: 'Relevo' }; }
}
function listCmsNotes() {
  fs.mkdirSync(CMS_DIR, { recursive: true });
  return fs.readdirSync(CMS_DIR).filter((f) => f.endsWith('.md')).map((f) => {
    const fp = path.join(CMS_DIR, f);
    const st = fs.statSync(fp);
    const parsed = parseFrontmatter(fs.readFileSync(fp, 'utf8'));
    const slug = f.replace(/\.md$/, '');
    return {
      slug,
      title: parsed.meta.title || slug,
      category: parsed.meta.category || 'general',
      status: parsed.meta.status || 'borrador',
      tags: (parsed.meta.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
      updated: parsed.meta.updated || st.mtime.toISOString(),
      body: parsed.body,
      size: st.size,
    };
  }).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}
function listCmsMedia() {
  const items = [];
  for (const folder of ['flyers', 'videos']) {
    const dir = path.join(MEDIA_ROOT, folder);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      const st = fs.statSync(fp);
      if (!st.isFile()) continue;
      items.push({ folder, name: f, size: st.size, url: '/api/cms/media/' + folder + '/' + encodeURIComponent(f) });
    }
  }
  return items;
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/panel') { res.writeHead(308, { location: '/panel/' }); return res.end(); }
  let baseDir = cfg.WEB_DIR;
  let subPath = rel;
  if (rel.startsWith('/panel/')) {
    baseDir = cfg.PANEL_DIR;
    subPath = rel.slice('/panel'.length);
  } else if (rel === '/' || rel === '') {
    subPath = '/index.html';
  } else if (!rel.startsWith('/assets/') && rel !== '/favicon.svg') {
    res.writeHead(404); return res.end('no encontrado');
  }
  if (subPath.endsWith('/')) subPath += 'index.html';
  const resolvedBase = path.resolve(baseDir);
  const file = path.resolve(path.join(resolvedBase, subPath));
  if (!file.startsWith(resolvedBase + path.sep)) { res.writeHead(403); return res.end(); }
  if (/supabase|\.sql$/.test(file)) { res.writeHead(404); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('no encontrado'); }
    const hdrs = { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' };
    if (rel.startsWith('/panel/')) hdrs['x-robots-tag'] = 'noindex, nofollow';
    res.writeHead(200, hdrs);
    res.end(data);
  });
}

function inbox() {
  const clients = db.listClients().slice(0, 60);
  const convs = clients.map((c) => {
    const last = db.lastMessage(c.id); const open = db.openOrders(c.id)[0];
    return {
      id: c.pid || 'c' + c.id, dbId: c.id, name: c.name || c.phone, phone: c.phone, institucion: c.institucion, nivel: c.nivel,
      last: last ? { dir: last.dir, body: (last.body || '').slice(0, 140), ts: last.ts, by: last.by } : null,
      esperando: !!last && last.dir === 'in' && (c.attended_at || 0) < last.ts,
      pedido: open ? { id: open.id, servicio: open.servicio, estado: open.estado, etapa: open.etapa, precio: open.precio } : null,
    };
  }).filter((c) => c.last).sort((a, b) => b.last.ts - a.last.ts);
  return { pausado: db.kvGet('paused') === '1', pendientes: db.openPending().map((p) => ({ id: p.id, cliente: p.name || p.phone, motivo: p.reason, borrador: p.draft, ts: p.ts })), conversaciones: convs };
}

const S = require('./settings');
const llm = require('./llm');
const KNOW = {
  memoria: ['10-Agente/Memoria-del-dueno.md', 'Memoria e instrucciones del dueño'],
  instrucciones: ['10-Agente/INSTRUCCIONES.md', 'Instrucciones del agente'],
  precios: ['00-Negocio/Politica-de-precios.md', 'Política de precios'],
  pago: ['10-Agente/Datos-de-pago.md', 'Datos de pago'],
  checklist: ['10-Agente/Checklist-por-tipo.md', 'Qué datos pedir según el trabajo'],
  respuestas: ['10-Agente/Respuestas-rapidas.md', 'Respuestas rápidas'],
  casos: ['00-Negocio/Casos-reales.md', 'Casos reales'],
  producto: ['00-Negocio/Producto.md', 'Producto y marca'],
  promos: ['00-Negocio/Precios-y-promos.md', 'Precios y promociones'],
};
function statusInfo(waState) {
  const has = (n) => llm.bin(n).includes('/');
  const count = (t) => db.raw.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
  return {
    wa: waState(), pausado: db.kvGet('paused') === '1',
    telegram: { token: !!cfg.TELEGRAM_TOKEN, dueno_vinculado: !!db.kvGet('owner_chat') },
    llaves: { claude_token: !!cfg.CLAUDE_OAUTH_TOKEN, api_key: !!cfg.ANTHROPIC_API_KEY },
    cli: { claude: fs.existsSync(cfg.CLAUDE_BIN), opencode: has('opencode'), agy: has('agy') },
    harness_chat: S.get('harness_chat'), harness_work: S.get('harness_work'),
    vault: cfg.VAULT, panel: cfg.PANEL_URL, novnc: cfg.PUBLIC_URL, tz: cfg.TZ,
    uptime_min: Math.round(process.uptime() / 60), node: process.version,
    datos: { clientes: count('clients'), pedidos: count('orders'), mensajes: count('messages'), pagos: count('payments') },
  };
}

function startPanel({ waState, wa, agent, courses }) {
  function makeHandler(isPublic) {
    return async (req, res) => {
      const url = new URL(req.url, 'http://x');
      // Rastreador público (/t) también disponible desde el proxy HTTPS público
      if (url.pathname === '/t') {
        const origin = req.headers.origin;
        const cors = {
          'access-control-allow-origin': !origin || ALLOWED.includes(origin) ? (origin || '*') : 'null',
          'access-control-allow-methods': 'POST,OPTIONS',
          'access-control-allow-headers': 'content-type',
          vary: 'origin',
        };
        if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
        if (req.method !== 'POST') { res.writeHead(405, cors); return res.end(); }
        const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        const t = Date.now(); const h = (hits.get(ip) || []).filter((x) => t - x < 60000); h.push(t); hits.set(ip, h);
        if (h.length > 40) { res.writeHead(429, cors); return res.end(); }
        try {
          if (origin && !ALLOWED.includes(origin)) { res.writeHead(403, cors); return res.end(); }
          const b = await body(req);
          if (!['page', 'wa'].includes(b.type)) { res.writeHead(400, cors); return res.end(); }
          const src = String(b.src || 'directo').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 40) || 'directo';
          db.addEvent(b.type, String(b.path || '/').replace(/[^\w/.\-]/g, '').slice(0, 80), src);
          res.writeHead(204, cors); return res.end();
        } catch { res.writeHead(400, cors); return res.end(); }
      }
      // Autenticación del panel
      if (url.pathname === '/api/auth/status' && req.method === 'GET') {
        return json(res, 200, { authRequired: isPublic, authenticated: !isPublic || verifySession(req) });
      }
      if (url.pathname === '/api/auth/login' && req.method === 'POST') {
        const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        const now = Date.now();
        const fails = (loginFails.get(ip) || []).filter((ts) => now - ts < 15 * 60000);
        if (fails.length >= 10) return json(res, 429, { error: 'Demasiados intentos fallidos. Espera 15 minutos.' });
        try {
          const b = await body(req);
          if (!checkPassword(b.password)) {
            fails.push(now); loginFails.set(ip, fails);
            return json(res, 401, { error: 'Contraseña incorrecta.' });
          }
          loginFails.delete(ip);
          return json(res, 200, { ok: true }, { 'set-cookie': makeSessionCookie(req, false) });
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
        return json(res, 200, { ok: true }, { 'set-cookie': makeSessionCookie(req, true) });
      }
      // Preflight CORS para integraciones con CMS personal externo (via Bearer / X-API-Key o /api/cms/public)
      if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
        const origin = req.headers.origin || '*';
        res.writeHead(204, {
          'access-control-allow-origin': origin,
          'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
          'access-control-allow-headers': 'content-type,authorization,x-api-key',
          'access-control-max-age': '86400',
          vary: 'origin',
        });
        return res.end();
      }
      // Feed público solo lectura del CMS (sin datos privados de clientes)
      if (req.method === 'GET' && url.pathname === '/api/cms/public') {
        const site = readCmsSite();
        const notes = listCmsNotes().filter((n) => n.status === 'publicado');
        return json(res, 200, { site, notes }, corsHeaders(req, true));
      }
      // Protección estricta en el puerto público (Funnel / Vercel): cookie de sesión O API Key Bearer
      if (isPublic && url.pathname.startsWith('/api/')) {
        if (url.pathname.startsWith('/api/wa/')) return json(res, 403, { error: 'Solo disponible en red privada Tailscale' });
        if (!verifySession(req) && !verifyBearer(req)) return json(res, 401, { error: 'Sesión o API Key requerida', authRequired: true }, corsHeaders(req, true));
      }
      // Inyectar encabezados CORS automáticamente cuando el cliente usa Bearer / X-API-Key
      const apiCors = corsHeaders(req, false);
      const origWriteHead = res.writeHead.bind(res);
      if (Object.keys(apiCors).length) {
        res.writeHead = (code, hdrs = {}) => origWriteHead(code, { ...apiCors, ...hdrs });
      }
      try {
      if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url);
      const m = req.method, p = url.pathname;
      if (m === 'GET' && p === '/api/state') return json(res, 200, { ...db.panelState(), meta: { rev: db.rev(), paused: db.kvGet('paused') === '1', wa: waState(), pendientes: db.openPending().length } });
      if (m === 'GET' && p === '/api/rev') return json(res, 200, { rev: db.rev(), wa: waState(), paused: db.kvGet('paused') === '1' });
      if (m === 'GET' && p === '/api/analytics') return json(res, 200, analytics.compute({ days: Number(url.searchParams.get('days') ?? 90) }));
      if (m === 'GET' && p === '/api/inbox') return json(res, 200, { ...inbox(), wa: waState() });
      let mm;
      if (m === 'GET' && (mm = p.match(/^\/api\/conversation\/(c?\d+|[\w-]+)$/))) {
        const key = mm[1]; const c = db.raw.prepare('SELECT * FROM clients WHERE pid=? OR id=?').get(key, /^c?(\d+)$/.test(key) ? Number(key.replace('c', '')) : -1);
        if (!c) return json(res, 404, { error: 'sin cliente' });
        return json(res, 200, { cliente: { name: c.name, phone: c.phone, institucion: c.institucion, nivel: c.nivel, origen: c.origen }, mensajes: db.history(c.id, 80).map((x) => ({ dir: x.dir, body: x.body, ts: x.ts, by: x.by, adjunto: !!x.media_path })) });
      }
      if (m === 'PUT' && (mm = p.match(/^\/api\/entity\/(client|order|payment)$/))) { const e = await body(req); db.upsertPanelEntity(mm[1], e); return json(res, 200, { ok: true, rev: db.rev() }); }
      if (m === 'DELETE' && (mm = p.match(/^\/api\/entity\/(order)\/([\w-]+)$/))) { db.deletePanelEntity(mm[1], mm[2]); return json(res, 200, { ok: true }); }
      if (m === 'POST' && (p === '/api/agent/pause' || p === '/api/agent/resume')) { db.kvSet('paused', p.endsWith('pause') ? '1' : '0'); return json(res, 200, { pausado: db.kvGet('paused') === '1' }); }
      // ---------- Herramientas internas de WhatsApp (solo red Tailscale privada del panel)
      if (m === 'GET' && p === '/api/wa/messages') {
        if (!wa?.getMessages) return json(res, 503, { error: 'wa no disponible' });
        const cid = url.searchParams.get('chatId');
        if (!cid) return json(res, 400, { error: 'falta chatId' });
        return json(res, 200, { wa: waState(), messages: await wa.getMessages(cid, url.searchParams.get('limit') || 15) });
      }
      if (m === 'GET' && p === '/api/wa/check-number') {
        if (!wa?.resolveNumber) return json(res, 503, { error: 'wa no disponible' });
        const phone = url.searchParams.get('phone') || '';
        return json(res, 200, { wa: waState(), phone, wid: await wa.resolveNumber(phone) });
      }
      if (m === 'GET' && p === '/api/wa/invite-info') {
        if (!wa?.getInviteInfo) return json(res, 503, { error: 'wa no disponible' });
        return json(res, 200, { ok: true, info: await wa.getInviteInfo(url.searchParams.get('code') || '') });
      }
      if (m === 'POST' && p === '/api/wa/accept-invite') {
        if (!wa?.acceptInvite) return json(res, 503, { error: 'wa no disponible' });
        const b = await body(req);
        return json(res, 200, { ok: true, groupId: await wa.acceptInvite(b.code || b.url || '') });
      }
      if (m === 'GET' && p === '/api/wa/community-subgroups') {
        if (!wa?.getCommunitySubgroups) return json(res, 503, { error: 'wa no disponible' });
        return json(res, 200, { ok: true, data: await wa.getCommunitySubgroups(url.searchParams.get('parentId') || '', url.searchParams.get('code') || '') });
      }
      if (m === 'POST' && p === '/api/wa/join-subgroup') {
        if (!wa?.joinSubgroupByName) return json(res, 503, { error: 'wa no disponible' });
        const b = await body(req);
        return json(res, 200, await wa.joinSubgroupByName(b.name || ''));
      }
      if (m === 'GET' && p === '/api/wa/groups') {
        if (!wa?.listGroups) return json(res, 503, { error: 'wa no disponible' });
        return json(res, 200, { ok: true, groups: await wa.listGroups() });
      }
      if (m === 'GET' && p === '/api/wa/contacts') {
        if (!wa?.findChats) return json(res, 503, { error: 'wa no disponible' });
        return json(res, 200, { wa: waState(), results: await wa.findChats(url.searchParams.get('q') || '') });
      }
      if (m === 'POST' && p === '/api/wa/send-file') {
        if (!wa?.sendFile) return json(res, 503, { error: 'wa no disponible' });
        const b = await body(req);
        if (!b.chatId || !b.filePath) return json(res, 400, { error: 'faltan chatId y filePath' });
        const fp = path.resolve(String(b.filePath));
        const okDir = [path.resolve(SITE), path.resolve(cfg.WORK_DIR)].some((d) => fp.startsWith(d + path.sep));
        if (!okDir || !fs.existsSync(fp)) return json(res, 403, { error: 'ruta no permitida o inexistente' });
        await wa.sendFile(String(b.chatId), fp, String(b.caption || ''), { asDocument: b.asDocument !== false });
        return json(res, 200, { ok: true, chatId: b.chatId, file: path.basename(fp) });
      }
      if (m === 'POST' && p === '/api/wa/send-text') {
        if (!wa?.send) return json(res, 503, { error: 'wa no disponible' });
        const b = await body(req);
        if (!b.chatId || !b.text) return json(res, 400, { error: 'faltan chatId y text' });
        await wa.send(String(b.chatId), String(b.text));
        return json(res, 200, { ok: true, chatId: b.chatId });
      }
      // ---------- Sistema: ajustes, conocimiento del agente, pruebas de harness
      if (m === 'GET' && p === '/api/settings') return json(res, 200, { schema: S.SCHEMA, values: S.all(), status: statusInfo(waState) });
      if (m === 'PUT' && p === '/api/settings') { const b = await body(req); return json(res, 200, { values: S.set(b.values || {}) }); }
      if (m === 'GET' && p === '/api/knowledge') return json(res, 200, Object.entries(KNOW).map(([k, v]) => { let st = null; try { st = fs.statSync(path.join(cfg.VAULT, v[0])); } catch {} return { key: k, title: v[1], file: v[0], size: st ? st.size : 0, updated: st ? st.mtimeMs : null }; }));
      if ((mm = p.match(/^\/api\/knowledge\/(\w+)$/)) && KNOW[mm[1]]) {
        const file = path.join(cfg.VAULT, KNOW[mm[1]][0]);
        if (m === 'GET') return json(res, 200, { key: mm[1], title: KNOW[mm[1]][1], file: KNOW[mm[1]][0], text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '' });
        if (m === 'PUT') {
          const b = await body(req); const text = String(b.text ?? '');
          if (text.length > 100000) throw new Error('El texto es demasiado largo');
          const bk = path.join(cfg.HOME, '.relevo', 'knowledge-backups'); fs.mkdirSync(bk, { recursive: true });
          if (fs.existsSync(file)) fs.copyFileSync(file, path.join(bk, `${mm[1]}-${Date.now()}.md`));
          fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
          return json(res, 200, { ok: true });
        }
      }
      if (m === 'POST' && p === '/api/system/test') { const b = await body(req); if (!['api', 'claude', 'opencode', 'agy'].includes(b.harness)) throw new Error('harness no válido'); return json(res, 200, await llm.test(b.harness, b.tier === 'delicate' ? 'delicate' : 'routine')); }
      if (m === 'GET' && p === '/api/social') return json(res, 200, await social.state());
      if (m === 'PUT' && p === '/api/social') { const b = await body(req); return json(res, 200, await social.update(b.redes || {})); }
      if (m === 'POST' && p === '/api/system/restart') { json(res, 200, { ok: true }); setTimeout(() => process.exit(0), 600); return; }   // systemd lo levanta de nuevo
      // ---------- API Key para CMS personal externo
      if (m === 'GET' && p === '/api/auth/token') return json(res, 200, tokenInfo());
      if (m === 'POST' && p === '/api/auth/token/rotate') return json(res, 200, { ok: true, ...rotateApiToken() });

      // ---------- Bandeja interactiva de WhatsApp (responder, aprobar/descartar pendientes, marcar atendido)
      if (m === 'POST' && p === '/api/inbox/reply') {
        if (!agent?.sendToClient) return json(res, 503, { error: 'agente no disponible' });
        const b = await body(req);
        const key = String(b.clientId || b.client || '');
        const c = db.raw.prepare('SELECT * FROM clients WHERE pid=? OR id=?').get(key, /^c?(\d+)$/.test(key) ? Number(key.replace('c', '')) : -1);
        if (!c || !c.wa_id) return json(res, 404, { error: 'cliente sin WhatsApp vinculado' });
        const text = guard.style(String(b.text || '').trim());
        if (!text) return json(res, 400, { error: 'mensaje vacío' });
        await agent.sendToClient(c, text, 'dueno');
        return json(res, 200, { ok: true, sent: text });
      }
      if (m === 'POST' && (mm = p.match(/^\/api\/inbox\/pending\/(\d+)\/(approve|close)$/))) {
        const pid = Number(mm[1]), act = mm[2];
        const b = await body(req);
        if (act === 'approve') {
          if (!agent?.approvePending) return json(res, 503, { error: 'agente no disponible' });
          const r = await agent.approvePending(pid, b.text);
          return json(res, r.ok ? 200 : 400, r);
        }
        db.closePending(pid, b.status || 'descartado');
        return json(res, 200, { ok: true, msg: 'Pendiente #' + pid + ' cerrado.' });
      }
      if (m === 'POST' && (mm = p.match(/^\/api\/inbox\/attended\/(c?\d+|[\w-]+)$/))) {
        const key = mm[1];
        const c = db.raw.prepare('SELECT * FROM clients WHERE pid=? OR id=?').get(key, /^c?(\d+)$/.test(key) ? Number(key.replace('c', '')) : -1);
        if (!c) return json(res, 404, { error: 'cliente no encontrado' });
        db.markClientAttended(c.id);
        db.openPending().filter((x) => x.client_id === c.id).forEach((x) => db.closePending(x.id, 'atendido'));
        return json(res, 200, { ok: true });
      }

      // ---------- Cursos autónomos en el servidor (SiESABI / OPS / plataformas)
      if (m === 'GET' && p === '/api/courses') {
        const jobs = db.listCourseJobs().map((j) => {
          let targets = [];
          try { targets = JSON.parse(j.targets || '[]'); } catch {}
          return {
            id: j.id, order_id: j.order_id, client_id: j.client_id,
            client_name: j.cname || j.phone || ('Cliente #' + j.client_id),
            phone: j.phone || '', email: j.email || '', curp: j.curp || '',
            has_siesabi_pass: !!j.siesabi_pass, has_ops_pass: !!j.ops_pass,
            status: j.status || 'pendiente', step: j.step || '', last_error: j.last_error || '',
            targets, updated: j.updated,
          };
        });
        return json(res, 200, { jobs, novnc: courses?.vncUrl ? courses.vncUrl() : cfg.PUBLIC_URL });
      }
      if (m === 'POST' && (mm = p.match(/^\/api\/courses\/(\d+)\/update$/))) {
        const oid = Number(mm[1]), b = await body(req);
        const patch = {};
        for (const k of ['email', 'siesabi_pass', 'ops_pass', 'curp', 'status', 'step']) {
          if (b[k] !== undefined && String(b[k]).trim() !== '') patch[k] = String(b[k]).trim();
        }
        if (b.clear_error) patch.last_error = '';
        db.upsertCourseJob(oid, patch);
        return json(res, 200, { ok: true });
      }
      if (m === 'POST' && (mm = p.match(/^\/api\/courses\/(\d+)\/action$/))) {
        if (!courses) return json(res, 503, { error: 'módulo de cursos no disponible' });
        const oid = Number(mm[1]), b = await body(req);
        if (b.action === 'resume') { courses.resumeInBackground(oid); return json(res, 200, { ok: true, msg: 'Revisando sesión en navegador del servidor.' }); }
        if (b.action === 'run') { courses.runModulesInBackground(oid); return json(res, 200, { ok: true, msg: 'Ejecutando módulos en segundo plano.' }); }
        if (b.action === 'stop') { courses.stop(oid); db.upsertCourseJob(oid, { status: 'pausado', step: 'Pausado desde el dashboard' }); return json(res, 200, { ok: true, msg: 'Curso pausado.' }); }
        return json(res, 400, { error: 'acción no válida' });
      }

      // ---------- CMS Personal (Sitio + Notas Markdown en Obsidian 60-CMS + Biblioteca de creativos)
      if (m === 'GET' && p === '/api/cms') {
        return json(res, 200, { site: readCmsSite(), notes: listCmsNotes(), media: listCmsMedia(), token: tokenInfo() });
      }
      if (m === 'PUT' && p === '/api/cms/site') {
        const b = await body(req);
        const next = { ...readCmsSite(), ...(b.site || b || {}), updatedAt: new Date().toISOString() };
        fs.mkdirSync(CMS_DIR, { recursive: true });
        fs.writeFileSync(CMS_SITE_FILE, JSON.stringify(next, null, 2));
        return json(res, 200, { ok: true, site: next });
      }
      if (m === 'GET' && p === '/api/cms/notes') return json(res, 200, { notes: listCmsNotes() });
      if ((m === 'POST' && p === '/api/cms/notes') || (m === 'PUT' && (mm = p.match(/^\/api\/cms\/notes\/([a-z0-9_-]+)$/)))) {
        const b = await body(req);
        const slug = mm ? mm[1] : cmsSlug(b.slug || b.title);
        const meta = {
          title: String(b.title || slug).trim(),
          category: String(b.category || 'general').trim(),
          status: ['borrador', 'publicado', 'privado'].includes(b.status) ? b.status : 'borrador',
          tags: Array.isArray(b.tags) ? b.tags.join(', ') : String(b.tags || ''),
          updated: new Date().toISOString(),
        };
        const content = buildFrontmatter(meta, b.body || '');
        fs.mkdirSync(CMS_DIR, { recursive: true });
        fs.writeFileSync(path.join(CMS_DIR, slug + '.md'), content);
        return json(res, 200, { ok: true, slug, note: listCmsNotes().find((n) => n.slug === slug) });
      }
      if (m === 'DELETE' && (mm = p.match(/^\/api\/cms\/notes\/([a-z0-9_-]+)$/))) {
        const fp = path.join(CMS_DIR, mm[1] + '.md');
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
        return json(res, 200, { ok: true });
      }
      if (m === 'GET' && (mm = p.match(/^\/api\/cms\/media\/(flyers|videos)\/([^/]+)$/))) {
        const folder = mm[1], fname = path.basename(decodeURIComponent(mm[2]));
        const fp = path.join(MEDIA_ROOT, folder, fname);
        if (!fs.existsSync(fp)) return json(res, 404, { error: 'archivo no encontrado' });
        const ext = path.extname(fname).toLowerCase();
        const ct = { '.png': 'image/png', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.jpg': 'image/jpeg' }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'content-type': ct, 'content-disposition': 'inline; filename="' + fname.replace(/"/g, '') + '"', 'cache-control': 'private, max-age=3600' });
        fs.createReadStream(fp).pipe(res);
        return;
      }

      return json(res, 404, { error: 'ruta desconocida' });
    } catch (e) { console.error('[panel]', e.message); return json(res, 400, { error: e.message }); }

    };
  }

  const srv = http.createServer(makeHandler(false));
  const host = process.env.PANEL_BIND || '127.0.0.1', port = Number(process.env.PANEL_PORT || 8787);
  srv.listen(port, host, () => console.log(`[panel] http://${host}:${port}/panel/`));

  const pubPort = Number(process.env.PANEL_PUBLIC_PORT || 8789);
  const pubSrv = http.createServer(makeHandler(true));
  pubSrv.listen(pubPort, '127.0.0.1', () => console.log(`[panel-publico] http://127.0.0.1:${pubPort}/panel/ (con sesión)`));
  return srv;
}

// ---------------- rastreador de visitas (solo cuenta; no devuelve ni acepta nada más)
const hits = new Map();
const ALLOWED = (process.env.TRACK_ORIGINS || 'http://127.0.0.1:8787,http://localhost:8787,http://127.0.0.1:8789,http://localhost:4321').split(',');
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function startTracker() {
  const srv = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const cors = { 'access-control-allow-origin': ALLOWED.includes(origin) ? origin : 'null', 'access-control-allow-methods': 'POST,OPTIONS', 'access-control-allow-headers': 'content-type', vary: 'origin' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const t = Date.now(); const h = (hits.get(ip) || []).filter((x) => t - x < 60000); h.push(t); hits.set(ip, h);
    if (h.length > 40) { res.writeHead(429, cors); return res.end(); }
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/t' && req.method === 'POST') {
        if (!ALLOWED.includes(origin)) { res.writeHead(403, cors); return res.end(); }
        const b = await body(req);
        if (!['page', 'wa'].includes(b.type)) { res.writeHead(400, cors); return res.end(); }
        const src = String(b.src || 'directo').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 40) || 'directo';
        db.addEvent(b.type, String(b.path || '/').replace(/[^\w/.\-]/g, '').slice(0, 80), src);
        res.writeHead(204, cors); return res.end();
      }
      res.writeHead(404, cors); res.end();
    } catch { res.writeHead(400, cors); res.end(); }
  });
  const port = Number(process.env.TRACK_PORT || 8788);
  srv.listen(port, '127.0.0.1', () => console.log(`[rastreador] 127.0.0.1:${port}/t`));
  setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (!v.some((x) => t - x < 60000)) hits.delete(k); }, 120000).unref();
  return srv;
}

module.exports = { startPanel, startTracker };

