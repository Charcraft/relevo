'use strict';
// Arranque ligero: levanta el sitio público (web/), el Dashboard (panel/), la API REST,
// el CMS personal y el rastreador de visitas (/t) sin requerir WhatsApp ni Telegram.
const path = require('path');
process.env.RELEVO_DATA = process.env.RELEVO_DATA || path.resolve(__dirname, '../data');
process.env.RELEVO_VAULT = process.env.RELEVO_VAULT || path.resolve(__dirname, '../vault-demo');
process.env.RELEVO_WORK = process.env.RELEVO_WORK || path.resolve(__dirname, '../work');
process.env.RELEVO_AUTH_FILE = process.env.RELEVO_AUTH_FILE || path.join(process.env.RELEVO_DATA, 'panel-auth.json');

const db = require('./db');
const server = require('./server');
const courses = require('./courses');

const stubAgent = {
  async sendToClient(client, text, by = 'dueno') {
    db.addMessage(client.id, 'out', text, { by });
    db.markClientAttended(client.id);
  },
  async approvePending(id, editedText) {
    const p = db.getPending(Number(id));
    if (!p || p.status !== 'abierto') return { ok: false, msg: 'No hay pendiente abierto con ese número.' };
    const text = (editedText || p.draft || '').trim();
    if (!text) return { ok: false, msg: 'El borrador está vacío.' };
    const c = db.getClient(p.client_id);
    if (c) { db.addMessage(c.id, 'out', text, { by: 'dueno' }); db.markClientAttended(c.id); }
    db.closePending(p.id, 'enviado');
    return { ok: true, msg: 'Borrador aprobado y registrado en historial (modo standalone).' };
  },
};

server.startPanel({ waState: () => 'ready', wa: null, agent: stubAgent, courses });
server.startTracker();
console.log('[relevo] modo standalone listo.');
console.log('  Sitio público : http://127.0.0.1:' + (process.env.PANEL_PORT || 8787) + '/');
console.log('  Dashboard     : http://127.0.0.1:' + (process.env.PANEL_PORT || 8787) + '/panel/');
console.log('  Auth pública  : http://127.0.0.1:' + (process.env.PANEL_PUBLIC_PORT || 8789) + '/panel/');
