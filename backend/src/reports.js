'use strict';
// Avisos proactivos al dueño: resumen de la mañana y de la noche, alertas respetando horario.
const cfg = require('./config');
const db = require('./db');
const agent = require('./agent');
const vault = require('./vault');
const brain = require('./brain');
const S = require('./settings');

const parts = () => {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: cfg.TZ, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  return { h: Number(f.find((x) => x.type === 'hour').value), m: Number(f.find((x) => x.type === 'minute').value) };
};
const once = (key) => { if (db.kvGet(key)) return false; db.kvSet(key, '1'); return true; };

function summary(kind) {
  const t = brain.todayStr();
  const orders = db.allActiveOrders();
  const dueToday = orders.filter((o) => o.entrega === t && !['entregado', 'pagado', 'cancelado'].includes(o.estado));
  const late = orders.filter((o) => o.entrega && o.entrega < t && !['entregado', 'pagado', 'cancelado'].includes(o.estado));
  const nuevos = db.listClients().filter((c) => c.first_seen > Date.now() - 86400000);
  const m = db.money();
  const pend = db.openPending();
  const reportados = orders.filter((o) => o.estado === 'nuevo' && o.etapa === 'anticipo-reportado');
  const L = [`${kind === 'am' ? 'Buenos días' : 'Cierre del día'}. ${t}`];
  L.push(`Clientes nuevos (24 h): ${nuevos.length}. Pedidos activos: ${orders.length}.`);
  L.push(`Entregas hoy: ${dueToday.length ? '\n' + dueToday.map((o) => '  · ' + (o.cname || o.phone) + ' ' + agent.orderLine(o)).join('\n') : 'ninguna'}`);
  if (late.length) L.push(`ATRASADOS:\n` + late.map((o) => '  · ' + (o.cname || o.phone) + ' ' + agent.orderLine(o)).join('\n'));
  if (reportados.length) L.push(`Pagos por confirmar: ` + reportados.map((o) => `PEDIDO #${o.id} ${o.cname || o.phone}`).join(', '));
  L.push(`Por cobrar: ${agent.money(m.por_cobrar)}. Cobrado en total: ${agent.money(m.cobrado_total)}.`);
  if (pend.length) L.push(`Decisiones esperándote: ${pend.map((p) => 'PENDIENTE #' + p.id).join(', ')} (/pend)`);
  return L.join('\n');
}

function start({ notify, waState }) {
  setInterval(async () => {
    try {
      const { h, m } = parts(); const day = brain.todayStr();
      if (h === S.get('report_am_hour') && m < 5 && once(`rep:${day}:am`)) { const s = summary('am'); vault.writeReport(day, s); await notify(s); }
      if (h === S.get('report_pm_hour') && m < 5 && once(`rep:${day}:pm`)) { const s = summary('pm'); vault.writeReport(day + '-noche', s); await notify(s); }
      // Alertas solo en horario despierto (08:00 a 22:59) y sin repetir en bucle por el mismo mensaje viejo
      if (h >= 8 && h <= 22 && m < 2 && once(`alert:${day}:${h}`)) {
        const sin = db.unansweredSince(S.get('unanswered_alert_min')).filter(() => db.kvGet('paused') !== '1');
        if (sin.length) {
          const sig = sin.map((c) => `${c.id}:${c.last_ts}`).sort().join(',');
          const prevSig = db.kvGet('last_unanswered_sig', '');
          const prevAt = Number(db.kvGet('last_unanswered_at', 0));
          if (sig !== prevSig || Date.now() - prevAt > 4 * 3600000) {
            db.kvSet('last_unanswered_sig', sig);
            db.kvSet('last_unanswered_at', Date.now());
            await notify(`Clientes sin respuesta desde hace más de ${S.get('unanswered_alert_min')} min: ${sin.map((c) => `${c.name || c.phone} (#${c.id})`).join(', ')}. (Si ya los atendiste, responde /atendido <cliente> o dímelo aquí.)`);
          }
        }
        const late = db.allActiveOrders().filter((o) => o.entrega && o.entrega < day && !['entregado', 'pagado', 'cancelado'].includes(o.estado));
        if (late.length && h % 3 === 0) await notify(`Pedidos atrasados: ${late.map((o) => 'PEDIDO #' + o.id + ' ' + (o.cname || o.phone)).join(', ')}.`);
      }
      const st = waState();
      if (st !== 'ready') { const k = 'wa-down'; const since = Number(db.kvGet(k, 0)) || Date.now(); db.kvSet(k, since); if (Date.now() - since > 10 * 60000 && once(`wadown:${day}:${h}`)) await notify(`WhatsApp lleva más de 10 minutos en estado "${st}". Entra a la sesión relevo para revisarlo.`); }
      else db.kvSet('wa-down', 0);
    } catch (e) { console.error('[reports]', e.message); }
  }, 60000);
}

module.exports = { start, summary };

