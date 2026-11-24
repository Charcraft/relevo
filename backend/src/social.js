'use strict';
// Registro de redes sociales: usuarios y estado de sesión. Las contraseñas viven solo en ~/.relevo/social.env (600) y nunca salen de ahí.
const fs = require('fs');
const path = require('path');
const http = require('http');
const cfg = require('./config');

const FILE = path.join(cfg.HOME, '.relevo', 'social-state.json');
const NETS = [['instagram', 'Instagram'], ['facebook', 'Facebook'], ['tiktok', 'TikTok'], ['x', 'X']];
const STATUS = ['pendiente', 'activa', 'verificacion', 'bloqueada'];
const DEF = { instagram: { user: 'relevo.demo', status: 'verificacion', note: 'Pide reCAPTCHA al entrar desde el servidor. Resolverlo una vez a mano en noVNC.' }, facebook: { user: '', status: 'pendiente', note: '' }, tiktok: { user: '', status: 'pendiente', note: '' }, x: { user: '', status: 'pendiente', note: '' } };

function read() { try { return { ...DEF, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { return { ...DEF }; } }
function chromeUp() { return new Promise((ok) => { const r = http.get('http://127.0.0.1:9333/json/version', { timeout: 1500 }, (x) => { x.resume(); ok(x.statusCode === 200); }); r.on('error', () => ok(false)); r.on('timeout', () => { r.destroy(); ok(false); }); }); }
function hasPassword(net) { try { return new RegExp('^' + net.toUpperCase() + '_PASSWORD=.+', 'm').test(fs.readFileSync(path.join(cfg.HOME, '.relevo', 'social.env'), 'utf8')); } catch { return false; } }

async function state() {
  const s = read();
  return { chrome: await chromeUp(), novnc: cfg.PUBLIC_URL, status_options: STATUS, redes: NETS.map(([k, name]) => ({ key: k, name, user: s[k].user || '', status: s[k].status || 'pendiente', note: s[k].note || '', password_guardada: hasPassword(k) })) };
}
function update(patch) {
  const s = read();
  for (const [k, v] of Object.entries(patch || {})) {
    if (!NETS.some((n) => n[0] === k)) throw new Error('red desconocida: ' + k);
    const cur = s[k] || {};
    if (v.user !== undefined) { const u = String(v.user).trim().replace(/^@/, ''); if (!/^[\w.]{0,40}$/.test(u)) throw new Error('usuario no válido'); cur.user = u; }
    if (v.status !== undefined) { if (!STATUS.includes(v.status)) throw new Error('estado no válido'); cur.status = v.status; }
    if (v.note !== undefined) cur.note = String(v.note).slice(0, 300);
    s[k] = cur;
  }
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
  return state();
}
module.exports = { state, update };
