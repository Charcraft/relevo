'use strict';
// Métricas del negocio para el dashboard. Todo se calcula a partir de la base de datos del agente.
const cfg = require('./config');
const db = require('./db');

const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' });
function lp(ts) {
  const o = {};
  for (const p of fmt.formatToParts(new Date(ts))) o[p.type] = p.value;
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(o.weekday);
  return { ymd: `${o.year}-${o.month}-${o.day}`, ym: `${o.year}-${o.month}`, h: Number(o.hour) % 24, dow };
}
const DAY = 86400000;
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

function group(rows, keyFn, init, add) {
  const m = new Map();
  for (const r of rows) { const k = keyFn(r) || 'sin dato'; if (!m.has(k)) m.set(k, init()); add(m.get(k), r); }
  return m;
}

function compute({ days = 90 } = {}) {
  const t = Date.now();
  const since = days > 0 ? t - days * DAY : 0;
  const clients = db.raw.prepare('SELECT * FROM clients').all();
  const cById = new Map(clients.map((c) => [c.id, c]));
  const orders = db.raw.prepare(`SELECT orders.*, ${db.PAID} AS pagado FROM orders`).all().filter((o) => o.estado !== 'cancelado');
  const pays = db.raw.prepare('SELECT * FROM payments').all();
  const msgs = db.raw.prepare('SELECT client_id,dir,ts FROM messages ORDER BY client_id, ts, id').all();
  const events = db.raw.prepare('SELECT * FROM events WHERE at >= ?').all(t - 60 * DAY);

  // primer pedido de cada cliente → nuevo vs recurrente
  const firstOf = new Map();
  for (const o of [...orders].sort((a, b) => a.created - b.created)) if (!firstOf.has(o.client_id)) firstOf.set(o.client_id, o.id);
  const dim = (o) => {
    const c = cById.get(o.client_id) || {};
    return {
      servicio: o.servicio || 'sin dato',
      nivel: c.nivel || 'sin dato',
      institucion: c.institucion || 'sin dato',
      // "whatsapp", "manual" e "historico" dicen por dónde se capturó el pedido, no cómo conoció Relevo el cliente
      origen: [o.origen, c.origen, o.source].map((x) => String(x || '').toLowerCase()).find((x) => x && !['whatsapp', 'manual', 'historico'].includes(x)) || 'sin dato',
      tipo: firstOf.get(o.client_id) === o.id ? 'nuevo' : 'recurrente',
    };
  };
  const inRange = orders.filter((o) => o.created >= since);
  const rows = inRange.map((o) => ({ o, d: dim(o) }));

  const breakdown = (key) => [...group(rows, (r) => r.d[key],
    () => ({ pedidos: 0, vendido: 0, cobrado: 0, saldo: 0, ciclo: [], costo: 0 }),
    (g, r) => {
      g.pedidos++;
      if (!['nuevo'].includes(r.o.estado)) g.vendido += r.o.precio || 0;
      g.cobrado += r.o.pagado || 0;
      if (['entregado', 'en_proceso'].includes(r.o.estado)) g.saldo += Math.max((r.o.precio || 0) - (r.o.pagado || 0), 0);
      if (r.o.delivered_at) g.ciclo.push((r.o.delivered_at - r.o.created) / DAY);
      g.costo += r.o.costo || 0;
    }).entries()]
    .map(([k, g]) => ({ k, pedidos: g.pedidos, vendido: Math.round(g.vendido), cobrado: Math.round(g.cobrado), saldo: Math.round(g.saldo), ticket: g.pedidos ? Math.round((g.vendido || g.cobrado) / g.pedidos) : 0, ciclo_dias: r1(avg(g.ciclo)), margen: g.costo ? Math.round(g.cobrado - g.costo) : null }))
    .sort((a, b) => b.cobrado - a.cobrado || b.pedidos - a.pedidos);

  // ingresos por periodo (por fecha del pago, base efectivo)
  const byMonth = new Map(), byDay = new Map(), byWeek = new Map();
  for (const p of pays) {
    const l = lp(p.at);
    byMonth.set(l.ym, (byMonth.get(l.ym) || 0) + p.amount);
    byDay.set(l.ymd, (byDay.get(l.ymd) || 0) + p.amount);
    const wk = lp(p.at - l.dow * DAY).ymd;                       // lunes de esa semana
    byWeek.set(wk, (byWeek.get(wk) || 0) + p.amount);
  }
  const months = []; { const base = new Date(); for (let i = 11; i >= 0; i--) { const d = new Date(base.getFullYear(), base.getMonth() - i, 15); const ym = lp(d.getTime()).ym; months.push({ k: ym, ingresos: Math.round(byMonth.get(ym) || 0), pedidos: orders.filter((o) => lp(o.created).ym === ym).length }); } }
  const weeks = []; { const mon = lp(t - lp(t).dow * DAY).ymd; for (let i = 11; i >= 0; i--) { const k = lp(Date.parse(mon + 'T12:00:00Z') - i * 7 * DAY).ymd; weeks.push({ k, ingresos: Math.round(byWeek.get(k) || 0) }); } }
  const daysArr = []; for (let i = 29; i >= 0; i--) { const k = lp(t - i * DAY).ymd; daysArr.push({ k, ingresos: Math.round(byDay.get(k) || 0) }); }

  // cuándo se crean las tareas
  const porHora = Array(24).fill(0), porDow = Array(7).fill(0);
  for (const o of inRange) { const l = lp(o.created); porHora[l.h]++; porDow[l.dow]++; }

  // tiempos de respuesta del agente (primer mensaje de cada ráfaga del cliente → siguiente respuesta)
  const resp = [];
  let cur = null, waitingSince = null;
  for (const m of msgs) {
    if (m.client_id !== cur) { cur = m.client_id; waitingSince = null; }
    if (m.dir === 'in') { if (waitingSince === null) waitingSince = m.ts; }
    else if (waitingSince !== null) { if (waitingSince >= since) resp.push((m.ts - waitingSince) / 60000); waitingSince = null; }
  }

  const delivered = orders.filter((o) => o.delivered_at && o.entrega);
  const aTiempo = delivered.filter((o) => lp(o.delivered_at).ymd <= o.entrega).length;
  const creaPago = orders.filter((o) => o.paid_at).map((o) => (o.paid_at - o.created) / 3600000);
  const creaEntrega = orders.filter((o) => o.delivered_at).map((o) => (o.delivered_at - o.created) / DAY);

  // embudo
  const newClients = clients.filter((c) => c.first_seen >= since);
  const cotizados = inRange.filter((o) => o.etapa !== 'cotizando' || o.estado !== 'nuevo');
  const confirmados = inRange.filter((o) => o.pagado > 0 || ['en_proceso', 'entregado', 'pagado'].includes(o.estado));
  const entregados = inRange.filter((o) => o.delivered_at || ['entregado', 'pagado'].includes(o.estado));
  const cobrados = inRange.filter((o) => o.estado === 'pagado' || (o.precio && o.pagado >= o.precio));

  // cuentas por cobrar con antigüedad
  const porCobrar = orders.filter((o) => ['entregado', 'en_proceso'].includes(o.estado) && (o.precio || 0) > o.pagado)
    .map((o) => ({ pedido: o.id, cliente: (cById.get(o.client_id) || {}).name || (cById.get(o.client_id) || {}).phone, estado: o.estado, saldo: Math.round(o.precio - o.pagado), dias: o.delivered_at ? Math.floor((t - o.delivered_at) / DAY) : null }))
    .sort((a, b) => b.saldo - a.saldo).slice(0, 15);

  // clientes: valor de vida
  const ltv = clients.map((c) => { const os = orders.filter((o) => o.client_id === c.id); return { cliente: c.name || c.phone, pedidos: os.length, cobrado: Math.round(os.reduce((s, o) => s + o.pagado, 0)), nivel: c.nivel || null, institucion: c.institucion || null }; })
    .filter((x) => x.pedidos).sort((a, b) => b.cobrado - a.cobrado).slice(0, 10);
  const conPedidos = new Set(orders.map((o) => o.client_id));
  const recurrentes = [...conPedidos].filter((id) => orders.filter((o) => o.client_id === id).length > 1).length;

  // web
  const vis = events.filter((e) => e.type === 'page'), clk = events.filter((e) => e.type === 'wa');
  const fuentes = [...group(events, (e) => e.src, () => ({ visitas: 0, clics: 0 }), (g, e) => { g[e.type === 'wa' ? 'clics' : 'visitas']++; }).entries()].map(([k, v]) => ({ k, ...v })).sort((a, b) => b.visitas - a.visitas);
  const trafDias = []; for (let i = 13; i >= 0; i--) { const k = lp(t - i * DAY).ymd; trafDias.push({ k, visitas: vis.filter((e) => lp(e.at).ymd === k).length, clics: clk.filter((e) => lp(e.at).ymd === k).length }); }

  const mesActual = lp(t).ym;
  const cobradoTotal = pays.reduce((s, p) => s + p.amount, 0);
  const mesAnt = lp(Date.UTC(new Date().getFullYear(), new Date().getMonth() - 1, 15)).ym;
  const vendidos = orders.filter((o) => o.estado !== 'nuevo' && o.precio);

  return {
    generado: t, dias: days, tz: cfg.TZ,
    kpis: {
      cobrado_total: Math.round(cobradoTotal),
      cobrado_mes: Math.round(byMonth.get(mesActual) || 0),
      cobrado_mes_anterior: Math.round(byMonth.get(mesAnt) || 0),
      por_cobrar: db.money().por_cobrar, saldo_total: db.money().saldo_total,
      pedidos_total: orders.length, pedidos_activos: orders.filter((o) => ['nuevo', 'en_proceso', 'entregado'].includes(o.estado)).length,
      ticket_promedio: vendidos.length ? Math.round(vendidos.reduce((s, o) => s + o.precio, 0) / vendidos.length) : 0,
      clientes_total: clients.length, clientes_nuevos: newClients.length, clientes_recurrentes: recurrentes,
      tasa_recurrencia: conPedidos.size ? r1((recurrentes / conPedidos.size) * 100) : 0,
      conversion_contacto_a_pago: inRange.length ? r1((cobrados.length / inRange.length) * 100) : 0,
      a_tiempo_pct: delivered.length ? r1((aTiempo / delivered.length) * 100) : null,
    },
    tiempos: {
      respuesta_mediana_min: r1(med(resp)), respuesta_p90_min: r1(pct(resp, 0.9)), respuestas_medidas: resp.length,
      creacion_a_pago_horas: r1(med(creaPago)), creacion_a_entrega_dias: r1(med(creaEntrega)),
    },
    serie: { meses: months, semanas: weeks, dias: daysArr },
    por: { servicio: breakdown('servicio'), nivel: breakdown('nivel'), institucion: breakdown('institucion').slice(0, 12), origen: breakdown('origen'), tipo: breakdown('tipo') },
    cuando: { por_hora: porHora, por_dia_semana: porDow },
    // todo el embudo se mide en pedidos (consultas que llegaron a ser una cotización), así cada paso es parte del anterior
    embudo: { contactos: inRange.length, cotizados: cotizados.length, confirmados: confirmados.length, entregados: entregados.length, cobrados: cobrados.length },
    por_cobrar_lista: porCobrar, mejores_clientes: ltv,
    web: { visitas: vis.length, clics: clk.length, conversion: vis.length ? r1((clk.length / vis.length) * 100) : 0, fuentes, dias: trafDias, nota: events.length ? null : 'Aún no llegan visitas desde el sitio.' },
  };
}

module.exports = { compute, lp };
