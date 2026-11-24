'use strict';
// Base de datos única del negocio. El agente escribe aquí; el panel lee y escribe por la API del servidor.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const cfg = require('./config');

fs.mkdirSync(cfg.DATA, { recursive: true });
const db = new DatabaseSync(process.env.RELEVO_DB || path.join(cfg.DATA, 'relevo.db'));
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS clients(
  id INTEGER PRIMARY KEY, wa_id TEXT UNIQUE, name TEXT, phone TEXT,
  tags TEXT DEFAULT '', notes TEXT DEFAULT '', first_seen INTEGER, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL, dir TEXT NOT NULL, body TEXT,
  media_path TEXT, wa_msg_id TEXT, ts INTEGER NOT NULL, by TEXT DEFAULT 'cliente');
CREATE INDEX IF NOT EXISTS msg_client ON messages(client_id, ts);
CREATE TABLE IF NOT EXISTS owner_messages(
  id INTEGER PRIMARY KEY, dir TEXT NOT NULL, body TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS owner_msg_ts ON owner_messages(ts);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL, servicio TEXT, tamano TEXT, entrega TEXT,
  rango_min INTEGER, rango_max INTEGER, precio INTEGER, notas TEXT DEFAULT '', created INTEGER, updated INTEGER);
CREATE TABLE IF NOT EXISTS payments(
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, amount REAL NOT NULL, method TEXT DEFAULT 'transferencia', at INTEGER NOT NULL, note TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY, type TEXT NOT NULL, path TEXT DEFAULT '/', src TEXT DEFAULT 'directo', at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ev_at ON events(at);
CREATE TABLE IF NOT EXISTS pending(
  id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL, draft TEXT, reason TEXT, ts INTEGER, status TEXT DEFAULT 'abierto');
CREATE TABLE IF NOT EXISTS work(
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, status TEXT DEFAULT 'en-cola', dir TEXT, files TEXT DEFAULT '[]',
  summary TEXT DEFAULT '', started INTEGER, finished INTEGER, error TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS course_jobs(
  id INTEGER PRIMARY KEY,
  order_id INTEGER UNIQUE NOT NULL,
  client_id INTEGER NOT NULL,
  cdp_url TEXT DEFAULT 'http://127.0.0.1:9334',
  profile_dir TEXT DEFAULT '',
  email TEXT DEFAULT '',
  siesabi_pass TEXT DEFAULT '',
  ops_pass TEXT DEFAULT '',
  curp TEXT DEFAULT '',
  targets TEXT DEFAULT '[]',
  inventory TEXT DEFAULT '{}',
  status TEXT DEFAULT 'esperando_acceso',
  step TEXT DEFAULT '',
  last_error TEXT DEFAULT '',
  auto_run INTEGER DEFAULT 1,
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
`);

// Migraciones aditivas: agrega columnas nuevas sin perder datos
function ensureCols(table, cols) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, type] of Object.entries(cols)) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}
ensureCols('clients', { institucion: 'TEXT', nivel: 'TEXT', tipo: 'TEXT', origen: 'TEXT', pid: 'TEXT', attended_at: 'INTEGER DEFAULT 0' });
ensureCols('orders', {
  pid: 'TEXT', cantidad: 'INTEGER', asunto: 'TEXT', materia: 'TEXT', costo: 'REAL', horas: 'REAL',
  estado: "TEXT DEFAULT 'nuevo'", etapa: "TEXT DEFAULT 'cotizando'", origen: 'TEXT', source: 'TEXT',
  started_at: 'INTEGER', delivered_at: 'INTEGER', paid_at: 'INTEGER',
});
ensureCols('payments', { pid: 'TEXT' });

const now = () => Date.now();
const q = (sql) => db.prepare(sql);
const kvGet = (k, d = null) => { const r = q('SELECT v FROM kv WHERE k=?').get(k); return r ? r.v : d; };
const kvSet = (k, v) => { q('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v)); };

const PAID = '(SELECT COALESCE(SUM(amount),0) FROM payments WHERE order_id=orders.id)';
const ORDER_SEL = `SELECT orders.*, ${PAID} AS pagado FROM orders`;

const ESTADOS = ['nuevo', 'en_proceso', 'entregado', 'pagado', 'cancelado'];
const ETAPAS = ['cotizando', 'cotizado', 'anticipo-reportado', 'confirmado'];
const AGENT_ETAPAS = ['cotizando', 'cotizado', 'anticipo-reportado'];
const ORDER_COLS = ['servicio', 'tamano', 'cantidad', 'asunto', 'materia', 'entrega', 'rango_min', 'rango_max', 'precio', 'costo', 'horas', 'estado', 'etapa', 'origen', 'source', 'notas', 'started_at', 'delivered_at', 'paid_at', 'pid'];
const COURSE_COLS = ['client_id', 'cdp_url', 'profile_dir', 'email', 'siesabi_pass', 'ops_pass', 'curp', 'targets', 'inventory', 'status', 'step', 'last_error', 'auto_run'];

const num = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

function normalizeMxPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10) return '521' + d;
  if (d.length === 12 && d.startsWith('52')) return '521' + d.slice(2);
  return d;
}

function updateOrder(id, f) {
  const cur = q('SELECT * FROM orders WHERE id=?').get(id);
  if (!cur) return null;
  const sets = [], vals = [];
  const patch = { ...f };
  if (patch.estado && patch.estado !== cur.estado) {
    const t = now();
    if (patch.estado === 'en_proceso' && !cur.started_at) patch.started_at = t;
    if (patch.estado === 'entregado' && !cur.delivered_at) patch.delivered_at = t;
    if (patch.estado === 'pagado' && !cur.paid_at) patch.paid_at = t;
    if (patch.estado !== 'nuevo' && !patch.etapa) patch.etapa = 'confirmado';
  }
  for (const c of ORDER_COLS) if (patch[c] !== undefined) { sets.push(c + '=?'); vals.push(patch[c]); }
  if (!sets.length) return q(ORDER_SEL + ' WHERE id=?').get(id);
  sets.push('updated=?'); vals.push(now()); vals.push(id);
  q('UPDATE orders SET ' + sets.join(',') + ' WHERE id=?').run(...vals);
  return q(ORDER_SEL + ' WHERE id=?').get(id);
}

function addPayment(order_id, amount, { method = 'transferencia', note = '', at = now() } = {}) {
  const o = q('SELECT * FROM orders WHERE id=?').get(order_id);
  if (!o || !(Number(amount) > 0)) return null;
  q('INSERT INTO payments(order_id,amount,method,at,note) VALUES(?,?,?,?,?)').run(order_id, Number(amount), method, at, note);
  const paid = q(`SELECT ${PAID} AS p FROM orders WHERE id=?`).get(order_id).p;
  const patch = {};
  if (o.estado === 'nuevo') { patch.estado = 'en_proceso'; patch.etapa = 'confirmado'; }
  if ((o.estado === 'entregado' || patch.estado === 'entregado') && o.precio && paid >= o.precio) patch.estado = 'pagado';
  if (o.estado === 'en_proceso' && o.precio && paid >= o.precio && o.delivered_at) patch.estado = 'pagado';
  return updateOrder(order_id, patch);
}

module.exports = {
  raw: db, ESTADOS, ETAPAS, AGENT_ETAPAS, PAID, kvGet, kvSet, normalizeMxPhone,
  rev: () => Number(q("SELECT COALESCE(MAX(updated),0) AS m FROM orders").get().m) + Number(q('SELECT COUNT(*) AS c FROM payments').get().c) + Number(q('SELECT COALESCE(MAX(last_seen),0) AS m FROM clients').get().m),

  getIgnoredIds: () => (kvGet('ignore_ids', '') || '').split(',').map((s) => s.trim()).filter(Boolean),
  setIgnoredId(waId, ignore = true) {
    const id = String(waId || '').trim();
    if (!id) return [];
    const set = new Set((kvGet('ignore_ids', '') || '').split(',').map((s) => s.trim()).filter(Boolean));
    if (ignore) set.add(id); else set.delete(id);
    const arr = [...set];
    kvSet('ignore_ids', arr.join(','));
    return arr;
  },

  upsertClient(wa_id, name) {
    const phone = String(wa_id).split('@')[0];
    const ex = q('SELECT * FROM clients WHERE wa_id=?').get(wa_id);
    if (ex) {
      q("UPDATE clients SET last_seen=?, name=COALESCE(NULLIF(name,''),NULLIF(?,'')) WHERE id=?").run(now(), name || '', ex.id);
      return { ...q('SELECT * FROM clients WHERE id=?').get(ex.id), isNew: false };
    }
    const r = q('INSERT INTO clients(wa_id,name,phone,first_seen,last_seen) VALUES(?,?,?,?,?)').run(wa_id, name || '', phone, now(), now());
    return { ...q('SELECT * FROM clients WHERE id=?').get(Number(r.lastInsertRowid)), isNew: true };
  },
  createClient(data = {}) {
    const phone = normalizeMxPhone(data.phone || '');
    const wa_id = data.wa_id || (phone ? phone + '@c.us' : null);
    let existing = null;
    if (wa_id) existing = q('SELECT * FROM clients WHERE wa_id=?').get(wa_id);
    if (!existing && phone.length >= 7) existing = q('SELECT * FROM clients WHERE phone LIKE ?').get('%' + phone.slice(-10));
    if (existing) {
      const sets = ['last_seen=?'], vals = [now()];
      if (data.name && (!existing.name || existing.name.startsWith('Cliente '))) { sets.push('name=?'); vals.push(data.name); }
      if (phone && !existing.phone) { sets.push('phone=?'); vals.push(phone); }
      if (wa_id && !existing.wa_id) { sets.push('wa_id=?'); vals.push(wa_id); }
      for (const k of ['institucion', 'nivel', 'tipo', 'origen']) if (data[k]) { sets.push(`${k}=COALESCE(NULLIF(${k},''),?)`); vals.push(String(data[k]).slice(0, 80)); }
      if (data.notes) { sets.push('notes=?'); vals.push(((existing.notes ? existing.notes + '\n' : '') + data.notes).slice(-1500)); }
      vals.push(existing.id);
      q('UPDATE clients SET ' + sets.join(',') + ' WHERE id=?').run(...vals);
      return { ...q('SELECT * FROM clients WHERE id=?').get(existing.id), isNew: false };
    }
    const t = now();
    const r = q('INSERT INTO clients(wa_id,name,phone,tags,notes,institucion,nivel,tipo,origen,first_seen,last_seen,attended_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(wa_id, data.name || phone || 'Sin nombre', phone, data.tags || '', data.notes || '', data.institucion || null, data.nivel || null, data.tipo || null, data.origen || 'directo', t, t, t);
    return { ...q('SELECT * FROM clients WHERE id=?').get(Number(r.lastInsertRowid)), isNew: true };
  },
  getClient: (id) => q('SELECT * FROM clients WHERE id=?').get(id),
  findClient(txt) {
    const t = String(txt || '').trim();
    if (!t) return null;
    const cleanId = t.replace(/^#/, '');
    if (/^\d+$/.test(cleanId) && cleanId.length <= 6) { const c = q('SELECT * FROM clients WHERE id=?').get(Number(cleanId)); if (c) return c; }
    const digits = t.replace(/\D/g, '');
    if (digits.length >= 7) { const c = q('SELECT * FROM clients WHERE phone LIKE ?').get('%' + digits.slice(-10)); if (c) return c; }
    const exact = q('SELECT * FROM clients WHERE LOWER(name) LIKE LOWER(?) ORDER BY last_seen DESC').get('%' + t + '%');
    if (exact) return exact;
    const tok = t.split(/\s+/).filter((w) => w.length >= 3)[0];
    if (tok) return q('SELECT * FROM clients WHERE LOWER(name) LIKE LOWER(?) ORDER BY last_seen DESC').get('%' + tok + '%');
    return null;
  },
  listClients: () => q('SELECT * FROM clients ORDER BY last_seen DESC').all(),
  recentClients: (n = 20) => q('SELECT * FROM clients ORDER BY last_seen DESC, id DESC LIMIT ?').all(n),
  markClientAttended(id, ts = now()) {
    q('UPDATE clients SET attended_at=? WHERE id=?').run(ts, id);
    return q('SELECT * FROM clients WHERE id=?').get(id);
  },
  setClientNote(id, notes, tags) { q('UPDATE clients SET notes=COALESCE(?,notes), tags=COALESCE(?,tags) WHERE id=?').run(notes ?? null, tags ?? null, id); },
  setClientProfile(id, p = {}) {
    const sets = [], vals = [];
    for (const k of ['institucion', 'nivel', 'tipo', 'origen']) if (p[k]) { sets.push(`${k}=COALESCE(NULLIF(${k},''),?)`); vals.push(String(p[k]).slice(0, 80)); }
    if (sets.length) q('UPDATE clients SET ' + sets.join(',') + ' WHERE id=?').run(...vals, id);
  },

  addMessage(client_id, dir, body, extra = {}) {
    const r = q('INSERT INTO messages(client_id,dir,body,media_path,wa_msg_id,ts,by) VALUES(?,?,?,?,?,?,?)')
      .run(client_id, dir, body || '', extra.media_path || null, extra.wa_msg_id || null, extra.ts || now(), extra.by || (dir === 'in' ? 'cliente' : 'agente'));
    return Number(r.lastInsertRowid);
  },
  history: (client_id, n = 20) => q('SELECT * FROM (SELECT * FROM messages WHERE client_id=? ORDER BY ts DESC, id DESC LIMIT ?) ORDER BY ts, id').all(client_id, n),
  lastMessage: (client_id) => q('SELECT * FROM messages WHERE client_id=? ORDER BY ts DESC, id DESC LIMIT 1').get(client_id),

  addOwnerMessage(dir, body, ts = now()) {
    const text = String(body || '').trim();
    if (!text) return null;
    const r = q('INSERT INTO owner_messages(dir,body,ts) VALUES(?,?,?)').run(dir === 'in' ? 'in' : 'out', text.slice(0, 4000), ts);
    return Number(r.lastInsertRowid);
  },
  ownerHistory: (n = 24) => q('SELECT * FROM (SELECT * FROM owner_messages ORDER BY ts DESC, id DESC LIMIT ?) ORDER BY ts, id').all(n),

  openOrders: (client_id) => q(ORDER_SEL + " WHERE client_id=? AND estado NOT IN ('pagado','cancelado') ORDER BY id DESC").all(client_id),
  getOrder: (id) => q(ORDER_SEL + ' WHERE id=?').get(id),
  allActiveOrders: () => q(`SELECT orders.*, ${PAID} AS pagado, c.name AS cname, c.phone FROM orders JOIN clients c ON c.id=orders.client_id WHERE estado IN ('nuevo','en_proceso','entregado') ORDER BY COALESCE(NULLIF(entrega,''),'9999'), orders.id`).all(),
  createOrder(client_id, f = {}) {
    const r = q('INSERT INTO orders(client_id,created,updated,estado,etapa) VALUES(?,?,?,?,?)').run(client_id, now(), now(), 'nuevo', 'cotizando');
    const id = Number(r.lastInsertRowid);
    const patch = { ...f }; for (const k of ['rango_min', 'rango_max', 'precio', 'cantidad', 'costo', 'horas']) if (k in patch) patch[k] = num(patch[k]);
    return updateOrder(id, { source: 'whatsapp', ...patch });
  },
  updateOrder, addPayment,
  paymentsOf: (order_id) => q('SELECT * FROM payments WHERE order_id=? ORDER BY at').all(order_id),

  addPending(client_id, draft, reason) {
    const r = q('INSERT INTO pending(client_id,draft,reason,ts) VALUES(?,?,?,?)').run(client_id, draft || '', reason || '', now());
    return Number(r.lastInsertRowid);
  },
  getPending: (id) => q('SELECT * FROM pending WHERE id=?').get(id),
  openPending: () => q("SELECT p.*, c.name, c.phone FROM pending p JOIN clients c ON c.id=p.client_id WHERE p.status='abierto' ORDER BY p.id").all(),
  closePending: (id, st) => q('UPDATE pending SET status=? WHERE id=?').run(st, id),

  unansweredSince(minutes) {
    const cutoff = now() - minutes * 60000;
    const recentWindow = now() - 48 * 3600000;
    return q(`SELECT c.*, m.ts AS last_ts, m.body AS last_body FROM clients c
      JOIN messages m ON m.id=(SELECT id FROM messages WHERE client_id=c.id ORDER BY ts DESC,id DESC LIMIT 1)
      WHERE m.dir='in'
        AND m.ts < ?
        AND COALESCE(c.attended_at, 0) < m.ts
        AND (m.ts > ? OR EXISTS (SELECT 1 FROM orders o WHERE o.client_id=c.id AND o.estado IN ('nuevo','en_proceso')))`).all(cutoff, recentWindow);
  },
  money() {
    return q(`SELECT
      COALESCE(SUM(CASE WHEN estado='entregado' THEN MAX(COALESCE(precio,0)-${PAID},0) END),0) AS por_cobrar,
      COALESCE(SUM(CASE WHEN estado IN ('nuevo','en_proceso','entregado') THEN MAX(COALESCE(precio,0)-${PAID},0) END),0) AS saldo_total,
      (SELECT COALESCE(SUM(amount),0) FROM payments) AS cobrado_total FROM orders`).get();
  },

  addEvent: (type, p, src) => q('INSERT INTO events(type,path,src,at) VALUES(?,?,?,?)').run(type === 'wa' ? 'wa' : 'page', String(p || '/').slice(0, 120), String(src || 'directo').toLowerCase().slice(0, 40), now()),

  // ---------- trabajo de producción (orquestación de agentes)
  createWork: (order_id, dir) => Number(q('INSERT INTO work(order_id,dir,started) VALUES(?,?,?)').run(order_id, dir, now()).lastInsertRowid),
  updateWork(id, f) { const s = [], v = []; for (const k of ['status', 'files', 'summary', 'finished', 'error']) if (f[k] !== undefined) { s.push(k + '=?'); v.push(typeof f[k] === 'object' ? JSON.stringify(f[k]) : f[k]); } if (s.length) q('UPDATE work SET ' + s.join(',') + ' WHERE id=?').run(...v, id); },
  getWork: (id) => q('SELECT * FROM work WHERE id=?').get(id),
  workOf: (order_id) => q('SELECT * FROM work WHERE order_id=? ORDER BY id DESC').all(order_id),

  // ---------- automatización de cursos en navegador del servidor
  upsertCourseJob(order_id, f = {}) {
    const cur = q('SELECT * FROM course_jobs WHERE order_id=?').get(Number(order_id));
    if (!cur) {
      const o = q('SELECT * FROM orders WHERE id=?').get(Number(order_id));
      const cid = f.client_id || o?.client_id;
      if (!cid) throw new Error('falta client_id para course_job');
      q('INSERT INTO course_jobs(order_id,client_id,updated) VALUES(?,?,?)').run(Number(order_id), Number(cid), now());
    }
    const sets = [], vals = [];
    for (const c of COURSE_COLS) {
      if (f[c] !== undefined) {
        sets.push(c + '=?');
        vals.push(typeof f[c] === 'object' && f[c] !== null ? JSON.stringify(f[c]) : f[c]);
      }
    }
    if (sets.length) {
      sets.push('updated=?'); vals.push(now()); vals.push(Number(order_id));
      q('UPDATE course_jobs SET ' + sets.join(',') + ' WHERE order_id=?').run(...vals);
    }
    return q('SELECT * FROM course_jobs WHERE order_id=?').get(Number(order_id));
  },
  getCourseJobByOrder: (order_id) => q('SELECT * FROM course_jobs WHERE order_id=?').get(Number(order_id)),
  getCourseJobByClient: (client_id) => q("SELECT * FROM course_jobs WHERE client_id=? AND status NOT IN ('completado','cancelado') ORDER BY updated DESC LIMIT 1").get(Number(client_id)),
  listCourseJobs: () => q('SELECT cj.*, c.name AS cname, c.phone FROM course_jobs cj JOIN clients c ON c.id=cj.client_id ORDER BY cj.updated DESC').all(),

  // ---------- puente con el panel (formato del panel)
  panelState() {
    const clients = q('SELECT * FROM clients ORDER BY id').all().map((c) => ({
      id: c.pid || 'c' + c.id, name: c.name || c.phone, phone: c.phone || '', tags: (c.tags || '').split(',').filter(Boolean), notes: c.notes || '',
      institucion: c.institucion || '', nivel: c.nivel || '', tipo: c.tipo || '', origen: c.origen || '', createdAt: new Date(c.first_seen || now()).toISOString(), wa: !!c.wa_id, dbId: c.id,
    }));
    const cid = new Map(q('SELECT id,pid FROM clients').all().map((c) => [c.id, c.pid || 'c' + c.id]));
    const orders = q(ORDER_SEL + ' ORDER BY id').all().map((o) => ({
      id: o.pid || 'o' + o.id, clientId: cid.get(o.client_id), service: o.servicio || 'ensayo', qty: o.cantidad || 0, subject: o.asunto || o.tamano || '',
      due: o.entrega || '', price: o.precio != null ? o.precio : (o.rango_min != null ? Math.round((o.rango_min + o.rango_max) / 2) : 0),
      priceIsEstimate: o.precio == null, status: o.estado || 'nuevo', etapa: o.etapa, source: o.origen || o.source || 'whatsapp', materia: o.materia || '',
      cost: o.costo, hours: o.horas, notes: o.notas || '', createdAt: new Date(o.created).toISOString(), deliveredAt: o.delivered_at ? new Date(o.delivered_at).toISOString() : null, dbId: o.id,
    }));
    const oid = new Map(q('SELECT id,pid FROM orders').all().map((o) => [o.id, o.pid || 'o' + o.id]));
    const payments = q('SELECT * FROM payments ORDER BY at').all().map((p) => ({ id: p.pid || 'p' + p.id, orderId: oid.get(p.order_id), amount: p.amount, method: p.method, at: new Date(p.at).toISOString(), note: p.note || '' }));
    const events = q('SELECT * FROM events ORDER BY at DESC LIMIT 20000').all().map((e) => ({ id: 'e' + e.id, type: e.type, path: e.path, src: e.src, at: new Date(e.at).toISOString() }));
    return { v: 1, clients, orders, payments, events, settings: { negocio: 'Relevo', recordatorioPagoDias: 3, notaPago: '', demo: false }, savedAt: null };
  },
  upsertPanelEntity(type, e) {
    const iso = (s) => (s ? new Date(s).getTime() : null);
    if (type === 'client') {
      let c = q('SELECT * FROM clients WHERE pid=?').get(e.id) || (/^c\d+$/.test(e.id) ? q('SELECT * FROM clients WHERE id=?').get(Number(e.id.slice(1))) : null);
      const f = { name: e.name, tags: (e.tags || []).join(','), notes: e.notes || '', institucion: e.institucion || null, nivel: e.nivel || null, tipo: e.tipo || null, origen: e.origen || null, phone: String(e.phone || '').replace(/\D/g, '') };
      if (c) { const s = Object.keys(f).map((k) => k + '=?'); q('UPDATE clients SET ' + s.join(',') + ' WHERE id=?').run(...Object.values(f), c.id); return c.id; }
      const r = q('INSERT INTO clients(name,phone,tags,notes,institucion,nivel,tipo,origen,pid,first_seen,last_seen) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(f.name, f.phone, f.tags, f.notes, f.institucion, f.nivel, f.tipo, f.origen, e.id, iso(e.createdAt) || now(), now());
      return Number(r.lastInsertRowid);
    }
    if (type === 'order') {
      const cl = q('SELECT id FROM clients WHERE pid=?').get(e.clientId) || (/^c\d+$/.test(e.clientId) ? { id: Number(e.clientId.slice(1)) } : null);
      if (!cl) throw new Error('cliente desconocido ' + e.clientId);
      let o = q('SELECT * FROM orders WHERE pid=?').get(e.id) || (/^o\d+$/.test(e.id) ? q('SELECT * FROM orders WHERE id=?').get(Number(e.id.slice(1))) : null);
      const f = { servicio: e.service, cantidad: num(e.qty), asunto: e.subject || '', entrega: e.due || '', precio: num(e.price), estado: ESTADOS.includes(e.status) ? e.status : 'nuevo', source: e.source, origen: e.source, materia: e.materia || null, costo: num(e.cost), horas: num(e.hours), notas: e.notes || '' };
      if (o) { updateOrder(o.id, f); return o.id; }
      const r = q('INSERT INTO orders(client_id,created,updated,estado,etapa,pid) VALUES(?,?,?,?,?,?)').run(cl.id, iso(e.createdAt) || now(), now(), 'nuevo', 'confirmado', e.id);
      updateOrder(Number(r.lastInsertRowid), { ...f, source: e.source || 'manual' });
      if (e.deliveredAt) updateOrder(Number(r.lastInsertRowid), { delivered_at: iso(e.deliveredAt) });
      return Number(r.lastInsertRowid);
    }
    if (type === 'payment') {
      const o = q('SELECT id FROM orders WHERE pid=?').get(e.orderId) || (/^o\d+$/.test(e.orderId) ? { id: Number(e.orderId.slice(1)) } : null);
      if (!o) throw new Error('pedido desconocido ' + e.orderId);
      if (q('SELECT id FROM payments WHERE pid=?').get(e.id) || (/^p\d+$/.test(e.id) && q('SELECT id FROM payments WHERE id=?').get(Number(e.id.slice(1))))) return null;
      q('INSERT INTO payments(order_id,amount,method,at,note,pid) VALUES(?,?,?,?,?,?)').run(o.id, Number(e.amount), e.method || 'efectivo', iso(e.at) || now(), e.note || '', e.id);
      return o.id;
    }
    throw new Error('tipo desconocido');
  },
  deletePanelEntity(type, id) {
    if (type === 'order') {
      const o = q('SELECT id FROM orders WHERE pid=?').get(id) || (/^o\d+$/.test(id) ? { id: Number(id.slice(1)) } : null);
      if (o) { q('DELETE FROM payments WHERE order_id=?').run(o.id); q('DELETE FROM orders WHERE id=?').run(o.id); }
    }
  },
};

