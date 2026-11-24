'use strict';
// Canal de clientes: WhatsApp Web automatizado en la sesión virtual :97 (whatsapp-web.js).
// El navegador es visible por noVNC para escanear el QR y supervisar.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const vault = require('./vault');
const S = require('./settings');

let Client, LocalAuth, MessageMedia;
let client = null;
let state = 'starting';
let lastQrNotify = 0;
let handler = null;
let notifyFn = async () => {};
const buffers = new Map();       // chatId -> { items, timer, name }
const queues = new Map();        // chatId -> Promise (un solo procesamiento a la vez por chat)
const outMin = [], outHour = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

async function limiter() {
  for (;;) {
    const t = Date.now();
    while (outMin.length && t - outMin[0] > 60000) outMin.shift();
    while (outHour.length && t - outHour[0] > 3600000) outHour.shift();
    if (outMin.length < S.get('max_out_per_min') && outHour.length < S.get('max_out_per_hour')) { outMin.push(t); outHour.push(t); return; }
    await sleep(2000);
  }
}

function setState(s, extra) {
  state = s;
  vault.writeStatus([`Sesión virtual relevo (:97): activa`, `WhatsApp Web: ${s}${extra ? ' (' + extra + ')' : ''}`, `Número vinculado: ${client?.info?.wid?.user || 'sin vincular'}`]);
}

const isClientChat = (id) => /@(c\.us|lid)$/.test(id || '');

async function flush(chatId) {
  const b = buffers.get(chatId); if (!b) return;
  buffers.delete(chatId);
  const prev = queues.get(chatId) || Promise.resolve();
  const next = prev.then(() => handler(chatId, b.name, b.items)).catch(async (e) => {
    console.error('[wa] error procesando', chatId, e);
    await notifyFn(`Error atendiendo a ${b.name || chatId}: ${e.message.slice(0, 200)}. Revisa el chat a mano.`);
  });
  queues.set(chatId, next);
}

async function onMessage(msg) {
  try {
    if (msg.fromMe || msg.isStatus || msg.from === 'status@broadcast' || msg.broadcast) return;
    if (!isClientChat(msg.from) || msg.from === '0@c.us' || msg.from === '13135550202@c.us') return;                               // ignora grupos, canales y listas
    if (['e2e_notification', 'notification_template', 'gp2', 'call_log', 'protocol', 'revoked'].includes(msg.type)) return;
    const contact = await msg.getContact().catch(() => null);
    const name = contact?.pushname || contact?.name || '';
    const item = { body: msg.body || '', hasMedia: !!msg.hasMedia, waMsgId: msg.id?._serialized };
    if (msg.hasMedia) {
      try {
        const m = await msg.downloadMedia();
        if (m && m.data && m.data.length * 0.75 <= cfg.MAX_MEDIA_MB * 1048576) {
          const phone = msg.from.split('@')[0];
          const dir = path.join(cfg.DATA, 'media', phone, vault.ymd());
          fs.mkdirSync(dir, { recursive: true });
          const ext = (m.mimetype || '').split('/')[1]?.split(';')[0] || 'bin';
          const fname = (m.filename || `archivo-${Date.now()}.${ext}`).replace(/[\\/:*?"<>|]/g, '_');
          fs.writeFileSync(path.join(dir, fname), Buffer.from(m.data, 'base64'));
          item.mediaPath = path.join(dir, fname); item.mediaName = fname;
        } else item.body += ' [archivo demasiado grande, no guardado]';
      } catch (e) { item.body += ' [no pude descargar el archivo]'; }
    }
    // como una persona: marca leído después de un momento
    setTimeout(() => msg.getChat().then((c) => c.sendSeen()).catch(() => {}), rand(1500, 4000));
    const b = buffers.get(msg.from) || { items: [], name };
    b.items.push(item); b.name = b.name || name;
    clearTimeout(b.timer);
    b.timer = setTimeout(() => flush(msg.from), S.get('debounce_ms'));   // junta ráfagas de mensajes
    buffers.set(msg.from, b);
  } catch (e) { console.error('[wa] onMessage', e); }
}

async function send(chatId, text) {
  if (!client || state !== 'ready') throw new Error('WhatsApp no está listo (' + state + ')');
  await limiter();
  const chat = await client.getChatById(chatId);
  await sleep(rand(S.get('reply_delay_min_ms'), Math.max(S.get('reply_delay_min_ms') + 100, S.get('reply_delay_max_ms'))));
  try { await chat.sendStateTyping(); } catch {}
  await sleep(Math.min(9000, 900 + text.length * S.get('typing_ms_per_char')) + rand(0, 1200));
  await client.sendMessage(chatId, text);
  try { await chat.clearState(); } catch {}
}

async function sendFile(chatId, filePath, caption, opts = {}) {
  if (!client || state !== 'ready') throw new Error('WhatsApp no está listo (' + state + ')');
  await limiter();
  const asDocument = opts.asDocument !== false;
  await client.sendMessage(chatId, MessageMedia.fromFilePath(filePath), { caption: caption || '', sendMediaAsDocument: asDocument });
}

async function findChats(query = '') {
  if (!client || state !== 'ready') throw new Error('WhatsApp no está listo (' + state + ')');
  const q = String(query || '').trim().toLowerCase();
  const map = new Map();
  const chats = await client.getChats().catch(() => []);
  for (const ch of chats) {
    const id = ch.id?._serialized || '';
    if (!id || ch.isGroup) continue;
    map.set(id, { id, name: ch.name || '', pushname: '', number: ch.id?.user || '', source: 'chat' });
  }
  const contacts = await client.getContacts().catch(() => []);
  for (const ct of contacts) {
    const id = ct.id?._serialized || '';
    if (!id || ct.isGroup) continue;
    const prev = map.get(id) || { id, name: '', pushname: '', number: ct.number || ct.id?.user || '', source: 'contact' };
    if (ct.name) prev.name = prev.name || ct.name;
    if (ct.shortName) prev.shortName = ct.shortName;
    if (ct.pushname) prev.pushname = ct.pushname;
    if (ct.number) prev.number = ct.number;
    prev.isMyContact = !!ct.isMyContact;
    map.set(id, prev);
  }
  const all = [...map.values()];
  if (!q) return all.slice(0, 50);
  const digits = q.replace(/\D/g, '');
  return all.filter((x) => {
    const hay = `${x.name} ${x.shortName || ''} ${x.pushname} ${x.number} ${x.id}`.toLowerCase();
    return hay.includes(q) || (digits.length >= 4 && hay.includes(digits));
  }).slice(0, 30);
}

async function start(onBatch, notify) {
  handler = onBatch; notifyFn = notify || notifyFn;
  ({ Client, LocalAuth, MessageMedia } = require('whatsapp-web.js'));
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(cfg.DATA, 'wa-auth') }),
    puppeteer: {
      headless: false,                       // visible en la sesión :97 (DISPLAY) para el QR y la supervisión
      executablePath: cfg.CHROME,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,900', '--lang=es-MX'],
    },
  });
  client.on('qr', async () => {
    setState('esperando-qr');
    if (Date.now() - lastQrNotify > 15 * 60000) {
      lastQrNotify = Date.now();
      await notifyFn(`WhatsApp de Relevo pide vincular el número. Abre ${cfg.PUBLIC_URL}, entra a la sesión relevo y escanea el QR desde WhatsApp > Dispositivos vinculados.`);
    }
  });
  client.on('authenticated', () => setState('autenticado'));
  client.on('auth_failure', async (m) => { setState('fallo-auth', m); await notifyFn('Falló la autenticación de WhatsApp: ' + m); });
  client.on('ready', async () => { setState('ready'); await notifyFn(`WhatsApp de Relevo conectado (${client.info?.wid?.user}). Ya estoy atendiendo.`); });
  client.on('disconnected', async (reason) => {
    setState('desconectado', reason);
    await notifyFn('WhatsApp se desconectó (' + reason + '). Intento reconectar en 30 segundos.');
    setTimeout(() => client.initialize().catch((e) => console.error('[wa] reinit', e.message)), 30000);
  });
  client.on('message', onMessage);
  setState('iniciando');
  await client.initialize();
}


async function getMessages(chatId, limit = 15) {
  if (!client || state !== 'ready') throw new Error('WhatsApp no está listo (' + state + ')');
  const chat = await client.getChatById(chatId);
  const msgs = await chat.fetchMessages({ limit: Number(limit) || 15 });
  return msgs.map((m) => ({
    id: m.id?._serialized,
    fromMe: !!m.fromMe,
    type: m.type,
    body: m.body || '',
    vCards: m.vCards || [],
    timestamp: m.timestamp,
  }));
}

async function resolveNumber(rawPhone) {
  if (!client || state !== 'ready') throw new Error('WhatsApp no está listo (' + state + ')');
  const d = String(rawPhone || '').replace(/\D/g, '');
  const tries = [];
  if (d.length === 10) tries.push('521' + d, '52' + d);
  else if (d.length === 12 && d.startsWith('52')) tries.push('521' + d.slice(2), d);
  else if (d.length === 13 && d.startsWith('521')) tries.push(d, '52' + d.slice(3));
  else if (d) tries.push(d);
  for (const num of tries) {
    const wid = await client.getNumberId(num).catch(() => null);
    if (wid) return wid._serialized;
  }
  return null;
}


async function getInviteInfo(raw) {
  if (!client || state !== 'ready') throw new Error('WhatsApp no está listo (' + state + ')');
  const code = String(raw || '').trim().replace(/^https?:\/\/chat\.whatsapp\.com\//i, '').split(/[?\/]/)[0];
  if (!code) throw new Error('código de invitación vacío');
  return await client.getInviteInfo(code);
}

async function acceptInvite(raw) {
  if (!client || state !== 'ready') throw new Error('WhatsApp no está listo (' + state + ')');
  const code = String(raw || '').trim().replace(/^https?:\/\/chat\.whatsapp\.com\//i, '').split(/[?\/]/)[0];
  if (!code) throw new Error('código de invitación vacío');
  // 1) Intento nativo (funciona una vez cargado el módulo o en versiones compatibles)
  try { return await client.acceptInvite(code); } catch {}
  // 2) Buscar módulo de join/invite ya cargado o abrir vía UI de WhatsApp Web (100% nativo)
  const info = await client.getInviteInfo(code).catch(() => null);
  const targetGid = info?.id?._serialized || null;
  // Revisar si algún módulo en __debug ya expone joinGroupViaInvite
  const direct = await client.pupPage.evaluate(async (inviteCode) => {
    let mmap = {};
    try { mmap = window.require('__debug')?.modulesMap || {}; } catch {}
    for (const k of Object.keys(mmap)) {
      if (!/Invite|JoinGroup/i.test(k) || /^(__requireModule__|rd:)/.test(k)) continue;
      let m = null;
      try { m = window.require(k); } catch {}
      if (!m || typeof m !== 'object') continue;
      for (const fn of Object.keys(m)) {
        if (typeof m[fn] === 'function' && /^(send)?(join|accept)Group(Via)?Invite(RPC)?$/i.test(fn)) {
          try {
            const r = await m[fn](inviteCode);
            return { ok: true, via: k + '.' + fn, gid: r?.gid?._serialized || r?.gid?.$1 || JSON.stringify(r) };
          } catch {}
        }
      }
    }
    return { ok: false };
  }, code);
  if (direct?.ok) return direct.gid || targetGid;

  // 3) Flujo UI nativo: abrir chat con el link (Jefe) o buscar link en DOM y pulsar "Unirse al grupo"
  const page = client.pupPage;
  if (cfg.OWNER_WA_ID) await client.interface.openChatWindow(cfg.OWNER_WA_ID);
  await sleep(2200);

  const clicked = await page.evaluate((inviteCode) => {
    const links = [...document.querySelectorAll('a[href]')];
    const match = links.reverse().find((a) => (a.href || '').includes(inviteCode) || (a.textContent || '').includes(inviteCode));
    if (match) {
      match.scrollIntoView({ block: 'center' });
      match.click();
      return { found: true, text: match.textContent, href: match.href };
    }
    // También buscar en botones/tarjetas de preview de grupo que contengan el link
    const spans = [...document.querySelectorAll('span, div')].filter((el) => el.childElementCount === 0 && (el.textContent || '').includes(inviteCode));
    if (spans.length) {
      const el = spans[spans.length - 1];
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { found: true, text: el.textContent, via: 'span' };
    }
    return { found: false, linkCount: links.length, sampleHrefs: links.slice(-5).map((a) => a.href) };
  }, code);

  if (!clicked.found) {
    throw new Error('No encontré el enlace del grupo en WhatsApp Web: ' + JSON.stringify(clicked));
  }

  // Esperar a que aparezca el diálogo de invitación y pulsar "Unirse al grupo"
  let action = null;
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    action = await page.evaluate(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"], [data-animate-modal-popup="true"]')];
      const root = dialogs[dialogs.length - 1] || document;
      const btns = [...root.querySelectorAll('button, [role="button"]')];
      const texts = btns.map((b) => (b.innerText || b.textContent || '').trim()).filter(Boolean);
      const joinBtn = btns.find((b) => /^(unirse al grupo|join group|unirme al grupo|solicitar unirse|request to join)$/i.test((b.innerText || b.textContent || '').trim()));
      if (joinBtn) { joinBtn.click(); return { state: 'clicked_join', label: (joinBtn.innerText || '').trim(), texts }; }
      const viewBtn = btns.find((b) => /^(ver grupo|view group)$/i.test((b.innerText || b.textContent || '').trim()));
      if (viewBtn) { viewBtn.click(); return { state: 'already_member', label: (viewBtn.innerText || '').trim(), texts }; }
      return dialogs.length ? { state: 'dialog_open', texts } : { state: 'waiting' };
    });
    if (action.state === 'clicked_join' || action.state === 'already_member') break;
  }

  await sleep(3000);
  // Ver qué módulos nuevos se cargaron (útil para llamadas futuras)
  const loadedInviteMods = await page.evaluate(() => {
    try {
      const mmap = window.require('__debug')?.modulesMap || {};
      return Object.keys(mmap).filter((k) => /GroupInviteJob|JoinGroupViaInvite|JoinViaInvite/i.test(k));
    } catch { return []; }
  });
  return { gid: targetGid, subject: info?.subject || '', uiAction: action, loadedInviteMods };
}

async function listGroups() {
  if (!client || state !== 'ready') throw new Error('WhatsApp no está listo (' + state + ')');
  const chats = await client.getChats();
  return chats.filter((c) => c.isGroup).map((c) => ({
    id: c.id?._serialized,
    name: c.name || '',
    participants: c.participants?.length || c.groupMetadata?.participants?.length || 0,
    announce: !!c.groupMetadata?.announce,
    desc: c.description || c.groupMetadata?.desc || '',
  }));
}

async function getCommunitySubgroups(parentId, inviteCode) {
  if (!client || state !== 'ready') throw new Error('WhatsApp no está listo (' + state + ')');
  const page = client.pupPage;

  // 1) Abrir la pestaña de Comunidades o el chat/comunidad Poderosísima UP en la UI
  const uiStep = await page.evaluate(async (pid) => {
    const log = [];
    // Cerrar diálogos previos si hubiera
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // Buscar botón de Comunidades en la barra lateral izquierda
    const navBtns = [...document.querySelectorAll('button, [role="button"]')];
    const commBtn = navBtns.find((b) => /comunidad|communit/i.test((b.getAttribute('aria-label') || b.getAttribute('title') || b.innerText || '')));
    if (commBtn) { commBtn.click(); log.push('clicked_comm_tab:' + (commBtn.getAttribute('aria-label') || commBtn.getAttribute('title'))); }
    return log;
  }, parentId);
  await sleep(1800);

  // Hacer clic en "Poderosísima UP" dentro de la lista de comunidades (o en "Ver todos")
  const openRes = await page.evaluate(() => {
    const log = [];
    const spans = [...document.querySelectorAll('span[title], span, div')];
    const target = spans.find((el) => el.childElementCount === 0 && /poderos[ií]sima up/i.test((el.getAttribute('title') || el.textContent || '').trim()));
    if (target) {
      target.click();
      log.push('clicked_community:' + (target.getAttribute('title') || target.textContent));
    }
    return { log, bodyPreview: (document.body.innerText || '').slice(0, 4000) };
  });
  await sleep(2200);

  // Si hay un botón "Ver todos" / "View all" o "Ver grupos", hacer clic
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button, [role="button"], span')];
    const more = btns.find((b) => /^ver todos|^view all|^ver m[aá]s grupos|grupos que puedes unirte/i.test((b.innerText || b.textContent || '').trim()));
    if (more) more.click();
  });
  await sleep(1500);

  const res = await page.evaluate(async (pid) => {
    const out = { parentId: pid, joined: [], unjoined: [], allGroupsInCache: [], fullText: (document.body.innerText || '').slice(0, 5000) };
    const cols = (() => { try { return window.require('WAWebCollections'); } catch { return {}; } })();
    const gmCol = cols?.GroupMetadata || cols?.WAWebGroupMetadataCollection;
    if (gmCol?.getModelsArray) {
      for (const m of gmCol.getModelsArray()) {
        const lp = m.parentGroup?._serialized || m.linkedParent?._serialized || '';
        const id = m.id?._serialized || '';
        if (lp === pid || id === pid) {
          out.joined.push({ id, subject: m.subject || '', desc: m.desc || '', size: m.size || m.participants?.length || 0, announce: !!m.announce, isParent: !!m.isParentGroup, defaultSubgroup: !!m.defaultSubgroup, generalSubgroup: !!m.generalSubgroup });
        }
      }
    }
    try {
      const usCol = cols?.UnjoinedSubgroupMetadata || window.require('WAWebUnjoinedSubgroupMetadataCollection')?.UnjoinedSubgroupMetadataCollection;
      if (usCol?.getModelsArray) {
        for (const m of usCol.getModelsArray()) {
          out.unjoined.push({
            id: m.id?._serialized || String(m.id || ''),
            parent: m.parentGroup?._serialized || m.parentGroupId?._serialized || '',
            subject: m.subject || '',
            desc: m.desc || '',
            size: m.size || 0,
            defaultSubgroup: !!m.defaultSubgroup,
            generalSubgroup: !!m.generalSubgroup,
            membershipApprovalMode: !!m.membershipApprovalMode,
          });
        }
      }
    } catch (e) { out.unjoinedErr = e.message; }
    return out;
  }, parentId);

  return { uiStep, openLog: openRes.log, ...res };
}

async function joinSubgroupByName(subgroupName) {
  if (!client || state !== 'ready') throw new Error('WhatsApp no está listo (' + state + ')');
  const page = client.pupPage;
  const info = await page.evaluate((target) => {
    const norm = (x) => String(x || '').trim().toLowerCase();
    const want = norm(target);
    const spans = [...document.querySelectorAll('span[title]')];
    let match = spans.find((el) => norm(el.getAttribute('title')) === want);
    if (!match) {
      const btns = [...document.querySelectorAll('[role="button"], [role="listitem"]')];
      match = btns.find((el) => norm((el.innerText || '').split('\n')[0]) === want);
    }
    if (!match) match = spans.find((el) => norm(el.getAttribute('title')).includes(want));
    if (!match) return { found: false };
    match.scrollIntoView({ block: 'center' });
    const r = match.getBoundingClientRect();
    return { found: true, text: match.getAttribute?.('title') || (match.innerText || '').slice(0, 80), x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, subgroupName);
  if (!info.found) return { ok: false, step: 'find_subgroup', info };
  await sleep(400);
  await page.mouse.click(info.x, info.y);
  await sleep(2200);
  // Buscar botón "Unirme al grupo" / "Join group" / "Solicitar unirme" (y clicarlo con mouse real)
  const btnInfo = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button, [role="button"]')];
    const b = btns.find((x) => /^(unirme al grupo|unirse al grupo|join group|solicitar unirme|request to join|aceptar|unirme)$/i.test((x.innerText || x.textContent || '').trim()));
    if (b) {
      const r = b.getBoundingClientRect();
      return { found: true, label: (b.innerText || '').trim(), x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return { found: false, visibleButtons: btns.map((x) => (x.innerText || '').trim()).filter(Boolean).slice(-20) };
  });
  if (btnInfo.found) {
    await page.mouse.click(btnInfo.x, btnInfo.y);
    await sleep(3000);
  }
  return { ok: !!btnInfo.found, info, btnInfo };
}

module.exports = { start, send, sendFile, findChats, getMessages, resolveNumber, getInviteInfo, acceptInvite, listGroups, getCommunitySubgroups, joinSubgroupByName, state: () => state, stop: async () => { try { await client?.destroy(); } catch {} } };

