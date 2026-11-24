'use strict';
// Lógica central: recibe mensajes de clientes, decide, responde, registra y avisa al dueño.
const path = require('path');
const fs = require('fs');
const cfg = require('./config');
const db = require('./db');
const vault = require('./vault');
const brain = require('./brain');
const guard = require('./guard');
const S = require('./settings');
const courses = require('./courses');

let io = { send: async () => {}, sendFile: async () => {}, notify: async () => {}, notifyFile: async () => {}, notifyPhoto: async () => {}, findChats: async () => [] };
const setIO = (x) => { io = { ...io, ...x }; };

const money = (n) => (n == null ? '-' : '$' + n);
const orderLine = (o) => `PEDIDO #${o.id} ${o.servicio || 'sin servicio'}${o.tamano ? ' (' + o.tamano + ')' : ''} | ${o.estado}${o.estado === 'nuevo' && o.etapa ? '/' + o.etapa : ''} | entrega ${o.entrega || '?'} | ${o.precio != null ? money(o.precio) : (o.rango_min != null ? money(o.rango_min) + '-' + money(o.rango_max) : 'sin precio')} | pagado ${money(o.pagado || 0)}`;

function detectOrigen(text) {
  const t = String(text || '').toLowerCase();
  if (/flyer20|vengo del flyer|del flyer/.test(t)) return 'flyer';
  if (/instagram|insta\b|re\.levo/.test(t)) return 'instagram';
  if (/me recomend|me pasaron tu|un amigo me|una amiga me|me dieron tu n/.test(t)) return 'recomendacion';
  if (/pagina|página|sitio|vi tu web/.test(t)) return 'web';
  return null;
}

async function sendToClient(client, text, by = 'agente') {
  const parts = String(text).split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean).slice(0, 3);
  for (const p of parts) {
    await io.send(client.wa_id, p);
    db.addMessage(client.id, 'out', p, { by });
    vault.logMessage(client, 'out', p, by === 'dueno' ? 'dueno' : 'agente');
  }
  db.markClientAttended(client.id);
}

function applyOrder(client, o) {
  if (!o || (!o.id && !o.servicio)) return null;
  const fields = {};
  for (const k of ['servicio', 'tamano', 'cantidad', 'asunto', 'materia', 'entrega', 'rango_min', 'rango_max', 'precio', 'notas', 'etapa']) if (o[k] !== undefined && o[k] !== null && o[k] !== '') fields[k] = o[k];
  if (client.origen) fields.origen = client.origen;
  let target = null;
  if (o.id) { const x = db.getOrder(Number(o.id)); if (x && x.client_id === client.id) target = x; }
  if (!target) target = db.openOrders(client.id).find((x) => x.estado === 'nuevo' && ['cotizando', 'cotizado'].includes(x.etapa) && (!o.servicio || x.servicio === o.servicio || !x.servicio));
  if (target && target.estado !== 'nuevo') delete fields.etapa;
  const saved = target ? db.updateOrder(target.id, fields) : db.createOrder(client.id, fields);
  vault.syncOrder(saved, client);
  return saved;
}

const lastHold = (client) => {
  const h = db.history(client.id, 6).reverse().find((m) => m.dir === 'out' && m.body === guard.FIXED.hold);
  return h ? Date.now() - h.ts : Infinity;
};

async function handleInbound(waId, name, items) {
  if (db.getIgnoredIds().includes(waId)) return { ignored: true };
  const client = db.upsertClient(waId, name);
  for (const it of items) {
    db.addMessage(client.id, 'in', it.body || (it.hasMedia ? '[archivo]' : ''), { media_path: it.mediaPath, wa_msg_id: it.waMsgId });
    vault.logMessage(client, 'in', it.body || '[archivo ' + (it.mediaName || '') + ']');
  }
  const detected = detectOrigen(items.map((i) => i.body).join(' '));
  if (detected && !client.origen) { db.setClientProfile(client.id, { origen: detected }); client.origen = detected; }
  vault.syncClient(db.getClient(client.id));
  const label = `${client.name || 'Sin nombre'} (${client.phone})`;
  const preview = items.map((i) => i.body || '[archivo]').join(' / ').slice(0, 300);

  if (db.kvGet('paused') === '1') { await io.notify(`Pausado. Mensaje de ${label}:\n${preview}`); return { paused: true }; }

  // Si el cliente tiene un trabajo de curso activo en el servidor, delega al motor autónomo de cursos
  const cRes = await courses.onClientMessage(client, items, sendToClient);
  if (cRes && cRes.handled) return cRes;

  // Si otro cliente manda imágenes/PDFs, reenviarlos también al dueño
  for (const it of items) {
    if (it.mediaPath && fs.existsSync(it.mediaPath)) {
      const isImg = /\.(png|jpe?g|webp)$/i.test(it.mediaPath);
      if (isImg) await io.notifyPhoto(it.mediaPath, `Imagen de ${label}: ${preview}`);
      else await io.notifyFile(it.mediaPath, `Archivo de ${label}: ${it.mediaName || path.basename(it.mediaPath)}`);
    }
  }

  const d = await brain.decide(client, items);
  db.setClientProfile(client.id, { ...(d.client || {}), origen: d.origen && d.origen !== 'directo' ? d.origen : (client.origen ? null : d.origen) });
  Object.assign(client, db.getClient(client.id));
  let saved = applyOrder(client, d.order);
  if (d.ownerPrice && !saved) saved = db.createOrder(client.id, {});
  if (d.ownerPrice && saved) {
    const nota = `Dice que ya cotizó con Carlos${d.precio_declarado ? ' en $' + d.precio_declarado : ''}${d.dueno_dijo ? '. Según el cliente: ' + d.dueno_dijo : ''} (por confirmar con Carlos).`;
    saved = db.updateOrder(saved.id, { notas: ((saved.notas ? saved.notas + '\n' : '') + nota).slice(-1500) });
    vault.syncOrder(saved, db.getClient(client.id));
  }
  vault.syncClient(db.getClient(client.id));
  if (d.client_notes) db.setClientNote(client.id, ((client.notes ? client.notes + '\n' : '') + d.client_notes).slice(-1500));

  let sentText = null;
  if (d.escalate) {
    const pid = db.addPending(client.id, d.reply, d.reason);
    const fixed = d.model === 'regla-fija' || d.holdOnly;
    if (fixed && d.reply) { await sendToClient(client, d.reply); sentText = d.reply; }
    else if (lastHold(client) > 30 * 60000) { await sendToClient(client, guard.FIXED.hold); sentText = guard.FIXED.hold; }
    if (!d.ownerPrice) {
      const btns = d.reply && !fixed
        ? [[{ text: `✅ Enviar borrador #${pid}`, callback_data: `ok:${pid}` }, { text: `❌ Descartar`, callback_data: `no:${pid}` }]]
        : [[{ text: `❌ Cerrar pendiente #${pid}`, callback_data: `no:${pid}` }]];
      await io.notify(
        `Necesito tu decisión (PENDIENTE #${pid})\nCliente: ${label} (#${client.id})\nMotivo: ${d.reason}\nDijo: ${preview}\n` +
        (d.reply && !fixed ? `Borrador mío:\n${d.reply}\n\nToca el botón o responde /responder ${client.id} <texto>.` : `Responde con /responder ${client.id} <texto>.`),
        { buttons: btns }
      );
    }
  } else if (d.reply) {
    await sendToClient(client, d.reply); sentText = d.reply;
  }
  if (d.ownerPrice) {
    await io.notify(`${label} dice que ya cotizó contigo${d.precio_declarado ? ' en $' + d.precio_declarado : ' (no dijo el monto)'}.\n` +
      (d.dueno_dijo ? `Lo que cuenta que hablaron: ${d.dueno_dijo}\n` : '') + `Dijo: ${preview}\n` +
      (saved ? `Si es cierto, confirma con /precio ${saved.id} ${d.precio_declarado || '<monto>'}. Si no, /responder ${client.id} <texto>.` : ''));
  }
  if (d.notifyOwner && !d.escalate) {
    await io.notify(`Posible pago de ${label}${saved ? ' (PEDIDO #' + saved.id + ')' : ''}\nDijo: ${preview}\nVerifícalo y confirma con /pagado ${saved ? saved.id : '<pedido>'} <monto>.`);
  }
  if (client.isNew && !d.escalate && S.get('notify_new_clients')) await io.notify(`Cliente nuevo: ${label}\nDijo: ${preview}\nRespondí (${d.model}, ${d.tier}).`);
  return { decision: d, sent: sentText, order: saved };
}

async function approvePending(id, editedText) {
  const p = db.getPending(Number(id));
  if (!p || p.status !== 'abierto') return { ok: false, msg: 'No hay pendiente abierto con ese número.' };
  const text = (editedText || p.draft || '').trim();
  if (!text) return { ok: false, msg: 'El borrador está vacío. Usa /responder ' + p.client_id + ' <texto>.' };
  const c = db.getClient(p.client_id);
  await sendToClient(c, guard.style(text), 'dueno');
  db.closePending(p.id, 'enviado');
  return { ok: true, msg: `Enviado a ${c.name || c.phone}.` };
}

function snapshot() {
  const orders = db.allActiveOrders();
  const pend = db.openPending();
  const m = db.money();
  const sin = db.unansweredSince(10);
  const clients = db.recentClients(15);
  const ignored = db.getIgnoredIds();
  const cjobs = db.listCourseJobs();
  return [
    `Fecha: ${brain.todayStr()}. Agente ${db.kvGet('paused') === '1' ? 'PAUSADO' : 'activo'}. Clientes totales: ${db.listClients().length}.`,
    `Por cobrar (entregados): ${money(m.por_cobrar)}. Cobrado total: ${money(m.cobrado_total)}.`,
    `PEDIDOS ACTIVOS (${orders.length}):\n` + (orders.map((o) => `- ${orderLine(o)} | Cliente #${o.client_id} ${o.cname || o.phone}`).join('\n') || '(ninguno)'),
    `CURSOS EN NAVEGADOR DEL SERVIDOR (${cjobs.length}):\n` + (cjobs.map((j) => `- PEDIDO #${j.order_id} (${j.cname || j.phone}) | estado=${j.status} | paso=${j.step || '-'} | correo=${j.email || '-'}`).join('\n') || '(ninguno)'),
    `PENDIENTES DE TU DECISIÓN (${pend.length}):\n` + (pend.map((p) => `- PENDIENTE #${p.id} (Cliente #${p.client_id} ${p.name || p.phone}): ${p.reason}`).join('\n') || '(ninguno)'),
    `CLIENTES ESPERANDO RESPUESTA (>10 min): ${sin.map((c) => `CLIENTE #${c.id} ${c.name || c.phone}`).join(', ') || 'ninguno'}`,
    `CLIENTES REGISTRADOS (recientes):\n` + (clients.map((c) => `- CLIENTE #${c.id} ${c.name || 'Sin nombre'}${c.phone ? ' (' + c.phone + ')' : ''}${c.institucion ? ' · ' + c.institucion : ''}`).join('\n') || '(ninguno)'),
    `NÚMEROS IGNORADOS EN WHATSAPP (ignore_ids): ${ignored.join(', ') || 'ninguno'}`,
  ].join('\n');
}

async function resolveWaTarget(query) {
  const q = String(query || '').trim();
  if (/@(g\.us|c\.us|lid)$/.test(q)) return { client: null, chatId: q, label: q };
  const c = db.findClient(q);
  if (c && c.wa_id) return { client: c, chatId: c.wa_id, label: c.name || c.phone };
  const chats = await (io.findChats ? io.findChats(q) : Promise.resolve([])).catch(() => []);
  if (chats.length) return { client: null, chatId: chats[0].id, label: chats[0].name || chats[0].pushname || chats[0].number || chats[0].id };
  const groups = await (io.listGroups ? io.listGroups() : Promise.resolve([])).catch(() => []);
  const g = groups.find((x) => (x.name || '').toLowerCase().includes(q.toLowerCase()));
  if (g) return { client: null, chatId: g.id, label: g.name || g.id };
  const digits = db.normalizeMxPhone(q);
  if (digits.length >= 10) return { client: c || null, chatId: digits + '@c.us', label: c?.name || digits };
  return null;
}

async function applyOwnerActions(actions = []) {
  const done = [];
  for (const a of actions) {
    try {
      if (a.type === 'remember') {
        const added = vault.addOwnerRule(a.rule || a.text);
        done.push(added ? 'Regla guardada en memoria permanente' : 'Esa regla ya estaba en memoria permanente');
      } else if (a.type === 'forget_rule') {
        const n = vault.removeOwnerRule(a.match || a.rule);
        done.push(n ? `Se quitaron ${n} regla(s) de memoria` : 'No encontré ninguna regla con ese texto');
      } else if (a.type === 'create_client') {
        const c = db.createClient({ name: a.name, phone: a.phone, wa_id: a.wa_id, institucion: a.institucion, nivel: a.nivel, tipo: a.tipo, origen: a.origen, notes: a.notes });
        vault.syncClient(c);
        done.push(`${c.isNew ? 'Cliente creado' : 'Cliente actualizado'}: #${c.id} ${c.name}${c.phone ? ' (' + c.phone + ')' : ''}`);
      } else if (a.type === 'create_order') {
        let c = a.client ? db.findClient(a.client) : null;
        if (!c && (a.phone || a.client_name || a.client)) {
          c = db.createClient({
            name: a.client_name || (a.client && !/^\+?\d[\d\s-]+$/.test(String(a.client)) ? a.client : ''),
            phone: a.phone || (a.client && /\d{7,}/.test(String(a.client)) ? a.client : ''),
            institucion: a.institucion, nivel: a.nivel, tipo: a.tipo, origen: a.origen || 'directo', notes: a.client_notes || '',
          });
          vault.syncClient(c);
        }
        if (!c) { done.push('No pude crear el pedido: falta el cliente (nombre o teléfono)'); continue; }
        const st = db.ESTADOS.includes(a.estado) ? a.estado : 'nuevo';
        const fields = {
          servicio: a.servicio || 'tarea', tamano: a.tamano || a.asunto || '', asunto: a.asunto || a.tamano || '',
          materia: a.materia || null, entrega: a.entrega || null, precio: a.precio != null ? Number(a.precio) : null,
          estado: st, etapa: st === 'nuevo' ? (a.precio ? 'cotizado' : 'cotizando') : 'confirmado',
          source: 'manual', notas: a.notas || '',
        };
        const o = db.createOrder(c.id, fields);
        vault.syncOrder(o, c);
        done.push(`Pedido creado: ${orderLine(o)} (${c.name || c.phone})`);
      } else if (a.type === 'send_wa') {
        const t = await resolveWaTarget(a.client);
        if (!t) { done.push('No encontré al contacto/cliente ' + a.client); continue; }
        const clean = guard.style(a.text);
        if (t.client) await sendToClient(t.client, clean, 'dueno');
        else await io.send(t.chatId, clean);
        done.push('Enviado por WhatsApp a ' + t.label);
      } else if (a.type === 'send_wa_file') {
        const t = await resolveWaTarget(a.client);
        if (!t) { done.push('No encontré al contacto/cliente ' + a.client); continue; }
        const fp = path.resolve(String(a.path || ''));
        const okDir = [path.join(cfg.HOME, 'relevo'), cfg.WORK_DIR].some((d) => fp.startsWith(path.resolve(d) + path.sep));
        if (!okDir || !fs.existsSync(fp)) { done.push('Archivo no permitido o no existe: ' + a.path); continue; }
        await io.sendFile(t.chatId, fp, a.caption || '', { asDocument: a.asDocument !== false });
        done.push('Archivo enviado a ' + t.label + ': ' + path.basename(fp));
      } else if (a.type === 'order') {
        const o = db.getOrder(Number(a.id)); if (!o) { done.push('No existe el PEDIDO #' + a.id); continue; }
        if (o.estado === 'pagado' && !a.force) { done.push(`Protección: PEDIDO #${o.id} ya está pagado y no se modificó.`); continue; }
        const f = { ...a.fields }; if (f.estado && !db.ESTADOS.includes(f.estado)) delete f.estado;
        delete f.pagado; delete f.anticipo;
        const s = db.updateOrder(o.id, f); vault.syncOrder(s, db.getClient(s.client_id)); done.push('PEDIDO #' + s.id + ' actualizado');
      } else if (a.type === 'payment') {
        const s = db.addPayment(Number(a.order), Number(a.amount), { method: a.method || 'transferencia', note: 'confirmado por el dueño' });
        if (s) { vault.syncOrder(s, db.getClient(s.client_id)); done.push(`Pago de $${a.amount} registrado en PEDIDO #${s.id} (${s.estado})`); } else done.push('No pude registrar ese pago');
      } else if (a.type === 'close_pending') {
        const st = a.status || 'descartado';
        if (a.id === 'all') {
          const ps = db.openPending();
          ps.forEach((p) => db.closePending(p.id, st));
          done.push(`Se cerraron ${ps.length} pendiente(s)`);
        } else if (a.client) {
          const c = db.findClient(a.client);
          if (!c) { done.push('No encontré al cliente ' + a.client); continue; }
          const ps = db.openPending().filter((p) => p.client_id === c.id);
          ps.forEach((p) => db.closePending(p.id, st));
          done.push(`Se cerraron ${ps.length} pendiente(s) de ${c.name || c.phone}`);
        } else {
          const p = db.getPending(Number(a.id));
          if (!p) { done.push('No existe PENDIENTE #' + a.id); continue; }
          db.closePending(p.id, st);
          done.push(`PENDIENTE #${p.id} cerrado (${st})`);
        }
      } else if (a.type === 'approve_pending') {
        const r = await approvePending(a.id, a.text);
        done.push(r.msg);
      } else if (a.type === 'mark_attended') {
        const c = db.findClient(a.client);
        if (!c) { done.push('No encontré al cliente ' + a.client); continue; }
        db.markClientAttended(c.id);
        let closed = 0;
        if (a.close_pendings !== false) {
          const ps = db.openPending().filter((p) => p.client_id === c.id);
          ps.forEach((p) => { db.closePending(p.id, 'atendido'); closed++; });
        }
        done.push(`${c.name || c.phone} marcado como atendido${closed ? ` y ${closed} pendiente(s) cerrado(s)` : ''}`);
      } else if (a.type === 'note') {
        const c = db.findClient(a.client);
        if (!c) { done.push('No encontré al cliente ' + a.client + ' para guardar nota'); continue; }
        db.setClientNote(c.id, ((c.notes ? c.notes + '\n' : '') + a.text).slice(-1500));
        vault.syncClient(db.getClient(c.id));
        done.push('Nota guardada en ' + (c.name || c.phone));
      } else if (a.type === 'course_update') {
        const oid = Number(a.order) || db.listCourseJobs()[0]?.order_id;
        if (!oid) { done.push('Falta el número de pedido del curso'); continue; }
        const patch = {};
        for (const k of ['email', 'siesabi_pass', 'ops_pass', 'curp']) if (a[k]) patch[k] = String(a[k]).trim();
        patch.last_error = '';
        db.upsertCourseJob(oid, patch);
        done.push(`Credenciales actualizadas en curso PEDIDO #${oid}`);
        if (a.resume !== false) { courses.resumeInBackground(oid); done.push(`Reanudando navegador del PEDIDO #${oid}`); }
      } else if (a.type === 'course_resume') {
        const oid = Number(a.order) || db.listCourseJobs()[0]?.order_id;
        if (!oid) { done.push('No hay curso activo'); continue; }
        if (a.mode === 'run') { courses.runModulesInBackground(oid); done.push(`Ejecutando módulos del PEDIDO #${oid}`); }
        else { courses.resumeInBackground(oid); done.push(`Reanudando revisión del PEDIDO #${oid}`); }
      } else if (a.type === 'course_stop') {
        const oid = Number(a.order) || db.listCourseJobs()[0]?.order_id;
        courses.stop(oid); done.push(`Curso PEDIDO #${oid} pausado`);
      } else if (a.type === 'read_wa') {
        const t = await resolveWaTarget(a.client || 'jefe');
        if (!t) { done.push('No encontré el chat ' + a.client); continue; }
        const msgs = await (io.getMessages ? io.getMessages(t.chatId, Number(a.limit) || 10) : Promise.resolve([]));
        const lines = msgs.slice(-10).map((m) => `[${m.fromMe ? 'Relevo' : t.label}] ${(m.body || '[' + m.type + ']').slice(0, 180)}`);
        done.push(`Últimos mensajes de ${t.label}:\n` + (lines.join('\n') || '(sin mensajes)'));
      } else if (a.type === 'join_group') {
        const gid = await io.acceptInvite(a.url || a.code || '');
        done.push('Unido al grupo: ' + gid);
      } else if (a.type === 'list_groups') {
        const gs = await (io.listGroups ? io.listGroups() : Promise.resolve([]));
        done.push('Grupos actuales:\n' + (gs.map((g) => `- ${g.name || g.id} (${g.participants} miembros) [${g.id}]`).join('\n') || '(ninguno)'));
      } else if (a.type === 'set_ignore') {
        if (cfg.OWNER_WA_ID && a.wa_id === cfg.OWNER_WA_ID && a.ignore === false && !a.force) {
          done.push('Protección: no se quitó Jefe de ignore_ids (usa read_wa para leer el chat sin responderle como cliente).');
          continue;
        }
        const arr = db.setIgnoredId(a.wa_id, a.ignore !== false);
        done.push(`${a.ignore !== false ? 'Ignorado' : 'Desbloqueado para responder'}: ${a.wa_id} (lista actual: ${arr.join(', ') || 'vacía'})`);
      } else if (a.type === 'pause') { db.kvSet('paused', '1'); done.push('Agente pausado'); }
      else if (a.type === 'resume') { db.kvSet('paused', '0'); done.push('Agente reanudado'); }
    } catch (e) { done.push('Error en ' + a.type + ': ' + e.message); }
  }
  return done;
}

module.exports = { setIO, handleInbound, sendToClient, approvePending, snapshot, applyOwnerActions, orderLine, money };

