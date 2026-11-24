'use strict';
// Chat directo con el dueño. Bot API oficial de Telegram con botones interactivos 1-tap para celular.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const db = require('./db');
const agent = require('./agent');
const brain = require('./brain');
const work = require('./work');
const vault = require('./vault');
const courses = require('./courses');

const API = () => `https://api.telegram.org/bot${cfg.TELEGRAM_TOKEN}`;
let running = false;

async function call(method, body, timeout = 15000) {
  const r = await fetch(`${API()}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(timeout) });
  const j = await r.json();
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description}`);
  return j.result;
}

const owner = () => db.kvGet('owner_chat');

function stripUrlButtons(buttons) {
  if (!Array.isArray(buttons)) return null;
  const cleaned = buttons.map((row) => row.filter((b) => !b.url)).filter((row) => row.length);
  return cleaned.length ? cleaned : null;
}

async function send(chatId, text, { log = true, buttons = null } = {}) {
  const t = String(text || '').trim() || '(vacío)';
  const chunks = [];
  for (let i = 0; i < t.length; i += 3800) chunks.push(t.slice(i, i + 3800));
  for (let idx = 0; idx < chunks.length; idx++) {
    const isLast = idx === chunks.length - 1;
    const payload = { chat_id: chatId, text: chunks[idx] };
    if (isLast && buttons && buttons.length) payload.reply_markup = { inline_keyboard: buttons };
    try {
      await call('sendMessage', payload);
    } catch (e) {
      if (isLast && buttons && /BUTTON_URL_INVALID|inline keyboard/i.test(e.message)) {
        const fb = stripUrlButtons(buttons);
        const p2 = { chat_id: chatId, text: chunks[idx] };
        if (fb) p2.reply_markup = { inline_keyboard: fb };
        try { await call('sendMessage', p2); } catch (e2) { console.error('[telegram] envío fallback falló:', e2.message); }
      } else {
        console.error('[telegram] envío falló:', e.message);
      }
    }
  }
  if (log && chatId === owner()) db.addOwnerMessage('out', t);
}

async function sendPhoto(chatId, filePath, caption, { buttons = null } = {}) {
  if (!fs.existsSync(filePath)) return send(chatId, caption || '(imagen no encontrada)', { buttons });
  const buildForm = (btns) => {
    const fd = new FormData();
    fd.append('chat_id', chatId);
    if (caption) fd.append('caption', String(caption).slice(0, 1000));
    if (btns && btns.length) fd.append('reply_markup', JSON.stringify({ inline_keyboard: btns }));
    fd.append('photo', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
    return fd;
  };
  let r = await fetch(`${API()}/sendPhoto`, { method: 'POST', body: buildForm(buttons), signal: AbortSignal.timeout(60000) });
  let j = await r.json();
  if (!j.ok && buttons && /BUTTON_URL_INVALID|inline keyboard/i.test(j.description || '')) {
    r = await fetch(`${API()}/sendPhoto`, { method: 'POST', body: buildForm(stripUrlButtons(buttons)), signal: AbortSignal.timeout(60000) });
    j = await r.json();
  }
  if (!j.ok) throw new Error('telegram sendPhoto: ' + j.description);
}

async function sendDocument(chatId, filePath, caption) {
  const fd = new FormData();
  fd.append('chat_id', chatId); if (caption) fd.append('caption', caption.slice(0, 900));
  fd.append('document', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
  const r = await fetch(`${API()}/sendDocument`, { method: 'POST', body: fd, signal: AbortSignal.timeout(120000) });
  const j = await r.json(); if (!j.ok) throw new Error('telegram sendDocument: ' + j.description);
}

const notifyFile = async (filePath, caption) => {
  if (cfg.TELEGRAM_TOKEN && owner()) await sendDocument(owner(), filePath, caption).catch((e) => console.error('[telegram] archivo:', e.message));
};
const notifyPhoto = async (filePath, caption, opts = {}) => {
  if (!cfg.TELEGRAM_TOKEN || !owner()) return;
  await sendPhoto(owner(), filePath, caption, opts).catch(async (e) => {
    console.error('[telegram] foto:', e.message);
    await send(owner(), caption || '(captura)', { log: false, buttons: opts.buttons });
  });
  if (caption) db.addOwnerMessage('out', '[Foto/Aviso] ' + String(caption).trim());
};
const notify = async (text, opts = {}) => {
  if (!cfg.TELEGRAM_TOKEN || !owner()) { console.log('[aviso sin Telegram]', text.slice(0, 200)); return; }
  await send(owner(), text, { log: false, buttons: opts.buttons || null });
  db.addOwnerMessage('out', '[Aviso] ' + String(text || '').trim());
};

const HELP = `Comandos
/estado  resumen del negocio
/hoy  entregas de hoy y atrasos
/pedidos  pedidos activos
/cobros  lo que falta por cobrar
/pend  decisiones que me esperan
/ok <n>  enviar mi borrador del pendiente n
/no <n>  descartar el pendiente n
/atendido <cliente>  quitar alertas de "esperando respuesta"
/memoria  ver tus instrucciones permanentes guardadas
/curso [pedido] [reanudar|ejecutar|pausar]  control del navegador de cursos
/pantalla [pedido]  ver captura en vivo del navegador de cursos
/vnc  enlace y contraseña del navegador remoto (noVNC)
/responder <cliente> <texto>  escribirle al cliente
/chat <cliente>  ver los últimos mensajes
/pagado <pedido> <monto>  confirmar un pago
/precio <pedido> <monto>  confirmar el precio que Carlos ya acordó
/pedido <n> <estado>  cambiar estado
/producir <pedido>  que el equipo de agentes haga el trabajo
/trabajo <pedido>  estado de la producción
/entregar <pedido>  mandar al cliente lo producido
/revisar <pedido> <cambios>  pedir correcciones al equipo
/panel  enlace del dashboard
/pausar  /reanudar  detener o reactivar las respuestas
Cualquier otro mensaje me lo puedes escribir normal.`;

function hoy() {
  const t = brain.todayStr();
  const o = db.allActiveOrders().filter((x) => x.entrega && x.entrega <= t && !['entregado', 'pagado', 'cancelado'].includes(x.estado));
  if (!o.length) return 'Sin entregas para hoy ni atrasadas.';
  return o.map((x) => `${x.entrega < t ? 'ATRASADO ' : 'HOY '} ${x.cname || x.phone}: ${agent.orderLine(x)}`).join('\n');
}

async function onCallback(cq) {
  const chat = String(cq.message?.chat?.id || '');
  if (chat !== owner()) return;
  const data = String(cq.data || '');
  const ack = (t) => call('answerCallbackQuery', { callback_query_id: cq.id, text: t || 'Listo' }).catch(() => {});

  try {
    if (data.startsWith('ok:')) {
      const id = data.slice(3);
      await ack('Enviando borrador...');
      const r = await agent.approvePending(id);
      return send(chat, r.msg);
    }
    if (data.startsWith('no:')) {
      const id = Number(data.slice(3));
      const p = db.getPending(id);
      if (!p) { await ack('No existe'); return; }
      db.closePending(p.id, 'descartado');
      await ack('Descartado');
      return send(chat, `Descartado PENDIENTE #${p.id}.`);
    }
    if (data === 'vnc:show') {
      await ack('Acceso noVNC');
      return send(chat, courses.vncFooter(), { buttons: [[{ text: '🌐 Abrir navegador', url: courses.vncUrl() }]] });
    }
    if (data.startsWith('curso:')) {
      const [, action, idStr] = data.split(':');
      const oid = Number(idStr) || db.listCourseJobs()[0]?.order_id;
      if (action === 'resume') {
        await ack('Reanudando revisión...');
        await send(chat, `▶️ Reanudando revisión y módulos del PEDIDO #${oid} en el navegador del servidor...`);
        courses.resumeInBackground(oid);
        return;
      }
      if (action === 'run') {
        await ack('Iniciando módulos...');
        await send(chat, `🚀 Iniciando ejecución de módulos del PEDIDO #${oid} en el navegador...`);
        courses.runModulesInBackground(oid);
        return;
      }
      if (action === 'shot') {
        await ack('Capturando pantalla...');
        const s = await courses.captureScreen(oid);
        return notifyPhoto(s.file, `📸 Navegador en vivo (PEDIDO #${s.orderId})\n${s.title}\n${s.url}`, { buttons: courses.courseButtons(s.orderId, { showRun: true }) });
      }
      if (action === 'status') {
        await ack('Estado');
        return send(chat, courses.statusText(oid), { buttons: courses.courseButtons(oid, { showRun: true }) });
      }
      if (action === 'stop') {
        const stopped = courses.stop(oid);
        await ack(stopped ? 'Pausado' : 'No estaba corriendo');
        return send(chat, stopped ? `⏸️ Curso PEDIDO #${oid} pausado.` : `El curso PEDIDO #${oid} no estaba en ejecución.`);
      }
    }
    await ack('Listo');
  } catch (e) {
    await ack('Error');
    await send(chat, 'Error en acción: ' + e.message.slice(0, 200));
  }
}

async function onCommand(chat, text) {
  db.addOwnerMessage('in', text);
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(' ');
  switch (cmd.toLowerCase().replace(/@.*/, '')) {
    case '/ayuda': case '/help': return send(chat, HELP);
    case '/estado': return send(chat, agent.snapshot());
    case '/hoy': return send(chat, hoy());
    case '/pedidos': { const o = db.allActiveOrders(); return send(chat, o.length ? o.map((x) => `${x.cname || x.phone}: ${agent.orderLine(x)}`).join('\n') : 'No hay pedidos activos.'); }
    case '/cobros': { const m = db.money(); const o = db.allActiveOrders().filter((x) => (x.precio || 0) > (x.pagado || 0)); return send(chat, `Por cobrar (entregado): ${agent.money(m.por_cobrar)}\n` + (o.map((x) => `${x.cname || x.phone}: ${agent.orderLine(x)}`).join('\n') || 'Nada pendiente.')); }
    case '/pend': {
      const p = db.openPending();
      if (!p.length) return send(chat, 'Nada pendiente.');
      for (const x of p) {
        await send(chat, `PENDIENTE #${x.id} ${x.name || x.phone}: ${x.reason}${x.draft ? '\n\nBorrador:\n' + x.draft.slice(0, 500) : ''}`, {
          buttons: [[
            { text: `✅ Enviar #${x.id}`, callback_data: `ok:${x.id}` },
            { text: `❌ Descartar #${x.id}`, callback_data: `no:${x.id}` },
          ]],
        });
      }
      return;
    }
    case '/ok': { const r = await agent.approvePending(rest[0]); return send(chat, r.msg); }
    case '/no': { const p = db.getPending(Number(rest[0])); if (!p) return send(chat, 'No existe.'); db.closePending(p.id, 'descartado'); return send(chat, `Descartado PENDIENTE #${p.id}.`); }
    case '/atendido': {
      const c = db.findClient(arg); if (!c) return send(chat, 'No encuentro a ese cliente.');
      db.markClientAttended(c.id);
      db.openPending().filter((p) => p.client_id === c.id).forEach((p) => db.closePending(p.id, 'atendido'));
      return send(chat, `${c.name || c.phone} marcado como atendido. Ya no te avisaré de ese chat hasta que vuelva a escribir.`);
    }
    case '/memoria': {
      const mem = vault.readOwnerRules().trim();
      return send(chat, mem || 'Todavía no hay instrucciones permanentes guardadas. Dime cualquier regla normal aquí y la guardo.');
    }
    case '/vnc': return send(chat, courses.vncFooter(), { buttons: [[{ text: '🌐 Abrir navegador', url: courses.vncUrl() }]] });
    case '/pantalla': {
      const oid = Number(rest[0]) || db.listCourseJobs()[0]?.order_id;
      try {
        const s = await courses.captureScreen(oid);
        return notifyPhoto(s.file, `📸 Navegador en vivo (PEDIDO #${s.orderId})\n${s.title}\n${s.url}`, { buttons: courses.courseButtons(s.orderId, { showRun: true }) });
      } catch (e) { return send(chat, 'No pude tomar captura: ' + e.message); }
    }
    case '/curso': {
      const firstIsNum = /^\d+$/.test(rest[0] || '');
      const oid = firstIsNum ? Number(rest[0]) : db.listCourseJobs()[0]?.order_id;
      const sub = (firstIsNum ? rest[1] : rest[0] || 'estado').toLowerCase();
      if (!oid) return send(chat, 'No hay trabajos de cursos registrados.');
      if (sub === 'reanudar' || sub === 'resume') { courses.resumeInBackground(oid); return send(chat, `▶️ Reanudando revisión del PEDIDO #${oid}...`, { buttons: courses.courseButtons(oid, { showRun: true }) }); }
      if (sub === 'ejecutar' || sub === 'run') { courses.runModulesInBackground(oid); return send(chat, `🚀 Ejecutando módulos del PEDIDO #${oid}...`, { buttons: courses.courseButtons(oid, { showRun: true }) }); }
      if (sub === 'pausar' || sub === 'stop') { courses.stop(oid); return send(chat, `⏸️ Pausado PEDIDO #${oid}.`); }
      return send(chat, courses.statusText(oid), { buttons: courses.courseButtons(oid, { showRun: true }) });
    }
    case '/responder': {
      const c = db.findClient(rest[0] || ''); if (!c) return send(chat, 'No encuentro a ese cliente. Usa su número de cliente o teléfono.');
      const msg = rest.slice(1).join(' '); if (!msg) return send(chat, 'Falta el texto.');
      await agent.sendToClient(c, msg, 'dueno');
      db.openPending().filter((p) => p.client_id === c.id).forEach((p) => db.closePending(p.id, 'atendido'));
      return send(chat, `Enviado a ${c.name || c.phone}.`);
    }
    case '/chat': {
      const c = db.findClient(arg); if (!c) return send(chat, 'No encuentro a ese cliente.');
      return send(chat, `${c.name || c.phone} (#${c.id})\n` + db.history(c.id, 12).map((m) => `${m.dir === 'in' ? '<' : '>'} ${m.body}`).join('\n'));
    }
    case '/pagado': {
      const o = db.getOrder(Number(rest[0])); const monto = Number(rest[1]);
      if (!o || !monto) return send(chat, 'Uso: /pagado <pedido> <monto>');
      const s = db.addPayment(o.id, monto, { method: rest[2] || 'transferencia', note: 'confirmado por el dueño' });
      vault.syncOrder(s, db.getClient(s.client_id));
      const prod = work.PRODUCIBLE.includes(s.servicio);
      if (prod && s.estado === 'en_proceso' && require('./settings').get('work_autostart') && !db.workOf(s.id).length) { try { work.start(s.id); } catch (e) { console.error('[autostart]', e.message); } }
      return send(chat, `Registrado. PEDIDO #${s.id}: pagado $${s.pagado}${s.precio ? ' de $' + s.precio : ''}, estado ${s.estado}.` +
        (s.estado === 'en_proceso' ? (prod ? `\nCuando quieras que el equipo lo haga: /producir ${s.id}` : '\nEste tipo de pedido lo haces tú.') : ''));
    }
    case '/precio': {
      const o = db.getOrder(Number(rest[0])); const monto = Number(rest[1]);
      if (!o || !(monto > 0)) return send(chat, 'Uso: /precio <pedido> <monto> [mensaje al cliente]');
      const s = db.updateOrder(o.id, { precio: monto, etapa: 'cotizado', notas: ((o.notas || '') + `\nPrecio confirmado por Carlos: $${monto}.`).slice(-1500) });
      const c = db.getClient(s.client_id); vault.syncOrder(s, c);
      const custom = rest.slice(2).join(' ');
      if (c.wa_id) await agent.sendToClient(c, custom || `Listo, Carlos me confirma $${monto}. Mándame la actividad o rúbrica y la fecha de entrega para empezar.`, 'dueno');
      return send(chat, `Precio del PEDIDO #${s.id} fijado en $${monto}${c.wa_id ? ' y avisé al cliente' : ''}.`);
    }
    case '/pedido': {
      const o = db.getOrder(Number(rest[0])); const st = rest[1];
      if (!o || !db.ESTADOS.includes(st)) return send(chat, 'Uso: /pedido <n> <' + db.ESTADOS.join('|') + '>');
      const s = db.updateOrder(o.id, { estado: st }); vault.syncOrder(s, db.getClient(s.client_id)); return send(chat, `PEDIDO #${s.id} ahora ${st}.`);
    }
    case '/panel': return send(chat, `Dashboard: ${cfg.PANEL_URL}`, { buttons: [[{ text: '📊 Abrir Panel', url: cfg.PANEL_URL }]] });
    case '/producir': {
      const o = db.getOrder(Number(rest[0])); if (!o) return send(chat, 'Uso: /producir <pedido> [forzar]');
      try { work.start(o.id, { force: rest[1] === 'forzar' }); return send(chat, `PEDIDO #${o.id}: el equipo de agentes empezó. Te aviso cuando haya algo para revisar (puede tardar hasta ${require('./settings').get('work_timeout_min')} min).`); }
      catch (e) { return send(chat, e.message); }
    }
    case '/trabajo': {
      const w = db.workOf(Number(rest[0]))[0]; if (!w) return send(chat, 'Ese pedido no tiene trabajos de producción.');
      return send(chat, `Trabajo #${w.id} del PEDIDO #${rest[0]}: ${w.status}${w.error ? ' (' + w.error + ')' : ''}\nArchivos: ${JSON.parse(w.files || '[]').map((f) => path.basename(f)).join(', ') || '-'}`);
    }
    case '/entregar': { try { const r = await work.deliver(Number(rest[0])); return send(chat, r.msg); } catch (e) { return send(chat, 'No pude entregar: ' + e.message); } }
    case '/revisar': {
      const id = Number(rest[0]); const fb = rest.slice(1).join(' '); if (!id || !fb) return send(chat, 'Uso: /revisar <pedido> <qué corregir>');
      work.start(id, { feedback: fb, force: true }); return send(chat, `Correcciones enviadas al equipo para el PEDIDO #${id}.`);
    }
    case '/pausar': db.kvSet('paused', '1'); return send(chat, 'Pausado. Sigo registrando mensajes pero no respondo a clientes.');
    case '/reanudar': db.kvSet('paused', '0'); return send(chat, 'Reanudado.');
    default: return send(chat, 'No conozco ese comando. /ayuda');
  }
}

async function onFreeText(chat, text) {
  const hist = db.ownerHistory(24);
  db.addOwnerMessage('in', text);
  try {
    const r = await brain.ownerChat(text, agent.snapshot(), hist);
    const done = await agent.applyOwnerActions(r.actions || []);
    const out = [r.text, done.length ? '\n' + done.map((d) => '· ' + d).join('\n') : ''].join('');
    await send(chat, out);
  } catch (e) { await send(chat, 'No pude procesar eso: ' + e.message.slice(0, 200)); }
}

async function onUpdate(u) {
  if (u.callback_query) return onCallback(u.callback_query);
  const m = u.message; if (!m || !m.text) return;
  const chat = String(m.chat.id), text = m.text.trim();
  if (!owner()) {
    const code = (text.match(/^\/start\s+(\S+)/) || [])[1];
    if (cfg.OWNER_PAIR_CODE && code === cfg.OWNER_PAIR_CODE) { db.kvSet('owner_chat', chat); await send(chat, 'Listo, quedaste como dueño de Relevo. Aquí te aviso de todo lo que pase. /ayuda para ver los comandos.'); }
    else await send(chat, 'Este bot es privado. Envía /start <código> con el código que se te dio.');
    return;
  }
  if (chat !== owner()) return;
  if (text.startsWith('/')) await onCommand(chat, text); else await onFreeText(chat, text);
}

async function start() {
  if (!cfg.TELEGRAM_TOKEN) { console.log('[telegram] sin TELEGRAM_BOT_TOKEN: avisos solo en consola'); return; }
  if (running) return; running = true;
  const me = await call('getMe').catch((e) => { console.error('[telegram]', e.message); return null; });
  if (me) console.log('[telegram] bot @' + me.username + (owner() ? ' (dueño vinculado)' : ' (esperando /start <código>)'));
  let offset = Number(db.kvGet('tg_offset', 0));
  (async () => {
    while (running) {
      try {
        const ups = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 40000);
        for (const u of ups) { offset = u.update_id + 1; db.kvSet('tg_offset', offset); await onUpdate(u).catch((e) => console.error('[telegram] update:', e.message)); }
      } catch (e) {
        if (!/aborted due to timeout/i.test(e.message)) console.error('[telegram] poll:', e.message);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  })();
}

module.exports = { start, notify, notifyFile, notifyPhoto, send, sendPhoto, owner, stop: () => { running = false; } };

