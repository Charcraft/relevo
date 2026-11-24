'use strict';
// Ajustes del sistema: viven en la base de datos, se editan desde el panel y se leen en caliente
// (sin reiniciar). Los secretos (tokens, llaves) NO están aquí: siguen en ~/.relevo/agent.env.
const db = require('./db');
const cfg = require('./config');

const HARNESS = [['auto', 'Automático (API, luego Claude Code)'], ['claude', 'Claude Code (plan Pro)'], ['opencode', 'OpenCode'], ['agy', 'Antigravity (agy)'], ['api', 'API de Anthropic']];

const SCHEMA = [
  {
    group: 'cerebro', title: 'Cerebro: harness y modelos',
    help: 'Qué programa piensa por el agente. Puedes cambiarlo en cualquier momento; el cambio aplica al siguiente mensaje.',
    items: [
      { k: 'harness_chat', label: 'Harness del chat con clientes', type: 'select', options: HARNESS, def: 'auto', help: 'Quién redacta las respuestas de WhatsApp y te contesta en Telegram.' },
      { k: 'harness_work', label: 'Harness de producción', type: 'select', options: HARNESS.filter((h) => ['claude', 'opencode', 'agy'].includes(h[0])), def: 'claude', help: 'Quién hace los trabajos (/producir). Con Claude Code trabajan subagentes en sandbox; con opencode o agy trabaja un solo agente.' },
      { k: 'claude_model_routine', label: 'Claude · rutina', type: 'text', def: cfg.CLAUDE_MODEL_ROUTINE, help: 'Preguntas simples. Barato.' },
      { k: 'claude_model_delicate', label: 'Claude · casos delicados', type: 'text', def: cfg.CLAUDE_MODEL_DELICATE, help: 'Precios, pagos, archivos y clientes nuevos.' },
      { k: 'claude_model_work', label: 'Claude · producción pesada', type: 'text', def: cfg.CLAUDE_MODEL_WORK, help: 'Orquestador, redactor y revisor en trabajos pesados.' },
      { k: 'opencode_model_routine', label: 'OpenCode · rutina', type: 'text', def: 'omniroute/code', help: 'Formato proveedor/modelo. Lista: opencode models.' },
      { k: 'opencode_model_delicate', label: 'OpenCode · delicado', type: 'text', def: 'omniroute/code' },
      { k: 'opencode_model_work', label: 'OpenCode · producción', type: 'text', def: 'omniroute/code' },
      { k: 'agy_model_routine', label: 'Antigravity · rutina', type: 'text', def: 'gemini-3.8-flash-medium', help: 'Lista: agy models.' },
      { k: 'agy_model_delicate', label: 'Antigravity · delicado', type: 'text', def: 'gemini-4-argon-medium' },
      { k: 'agy_model_work', label: 'Antigravity · producción', type: 'text', def: 'gemini-4-argon-high' },
      { k: 'api_model_routine', label: 'API · rutina', type: 'text', def: cfg.MODEL_ROUTINE },
      { k: 'api_model_delicate', label: 'API · delicado', type: 'text', def: cfg.MODEL_DELICATE },
    ],
  },
  {
    group: 'ritmo', title: 'Ritmo humano y límites',
    help: 'Lo que protege el número de WhatsApp. Más lento y espaciado = menos riesgo de que lo restrinjan.',
    items: [
      { k: 'debounce_ms', label: 'Espera para juntar mensajes (ms)', type: 'number', min: 1000, max: 60000, def: cfg.DEBOUNCE_MS, help: 'El cliente manda 3 mensajes seguidos y el agente contesta una sola vez.' },
      { k: 'max_out_per_min', label: 'Máximo de mensajes por minuto', type: 'number', min: 1, max: 30, def: cfg.MAX_OUT_PER_MIN },
      { k: 'max_out_per_hour', label: 'Máximo de mensajes por hora', type: 'number', min: 10, max: 500, def: cfg.MAX_OUT_PER_HOUR },
      { k: 'typing_ms_per_char', label: 'Velocidad de "escribiendo" (ms por letra)', type: 'number', min: 10, max: 150, def: 45 },
      { k: 'reply_delay_min_ms', label: 'Pausa antes de responder, mínimo (ms)', type: 'number', min: 300, max: 20000, def: 1200 },
      { k: 'reply_delay_max_ms', label: 'Pausa antes de responder, máximo (ms)', type: 'number', min: 500, max: 30000, def: 3500 },
    ],
  },
  {
    group: 'precios', title: 'Precios y cobro',
    help: 'El agente cotiza dentro de estos límites y los lee en cada conversación. El detalle de cómo cobras está en el editor de conocimiento.',
    items: [
      { k: 'base_price', label: 'Precio base por trabajo (MXN)', type: 'number', min: 20, max: 2000, def: 100 },
      { k: 'price_floor', label: 'Piso (MXN)', type: 'number', min: 20, max: 1000, def: 50 },
      { k: 'price_ceiling', label: 'Tope por trabajo (MXN)', type: 'number', min: 50, max: 5000, def: 250, help: 'Arriba de esto el agente te pregunta antes de cotizar.' },
      { k: 'urgent_price', label: 'Precio urgente y complejo (MXN)', type: 'number', min: 50, max: 5000, def: 250 },
      { k: 'payment_method', label: 'Método de pago', type: 'text', def: 'transferencia SPEI', help: 'Lo que el agente le dice al cliente. Los datos de la cuenta se editan en "Datos de pago".' },
      { k: 'pay_after_draft', label: 'Borrador primero, pago al aprobarlo', type: 'bool', def: true },
      { k: 'ask_if_quoted_with_owner', label: 'Preguntar si el cliente ya cotizó contigo', type: 'bool', def: true, help: 'Evita cotizar distinto a quien ya acordó precio en persona.' },
      { k: 'allowed_discount_pcts', label: 'Descuentos permitidos (%)', type: 'text', def: '10,15,20,30', help: 'Separados por coma. Otro porcentaje sale a tu aprobación.' },
    ],
  },
  {
    group: 'produccion', title: 'Producción de trabajos',
    help: 'Cómo se hacen los trabajos escritos. Todo pasa por tu revisión antes de entregarse.',
    items: [
      { k: 'work_services', label: 'Servicios que produce el sistema', type: 'text', def: 'ensayo,presentacion,formato', help: 'Separados por coma: ensayo, presentacion, formato, tarea, cambridge, curso.' },
      { k: 'work_autostart', label: 'Empezar solo al confirmar el pago', type: 'bool', def: false, help: 'Si está apagado, tú decides con /producir.' },
      { k: 'work_timeout_min', label: 'Tiempo máximo por trabajo (min)', type: 'number', min: 5, max: 180, def: cfg.WORK_TIMEOUT_MIN },
      { k: 'work_heavy_price', label: 'Un trabajo es "pesado" desde (MXN)', type: 'number', min: 50, max: 5000, def: 200, help: 'Los pesados usan el modelo fuerte; el resto, el barato.' },
      { k: 'work_heavy_pages', label: 'o desde (páginas o unidades)', type: 'number', min: 5, max: 500, def: 20 },
    ],
  },
  {
    group: 'avisos', title: 'Avisos y reportes',
    items: [
      { k: 'report_am_hour', label: 'Resumen de la mañana (hora)', type: 'number', min: 0, max: 23, def: 8 },
      { k: 'report_pm_hour', label: 'Cierre del día (hora)', type: 'number', min: 0, max: 23, def: 21 },
      { k: 'unanswered_alert_min', label: 'Avisar si un cliente espera más de (min)', type: 'number', min: 5, max: 600, def: 30 },
      { k: 'notify_new_clients', label: 'Avisar de cada cliente nuevo', type: 'bool', def: true },
    ],
  },
];

const ITEMS = new Map();
for (const g of SCHEMA) for (const it of g.items) ITEMS.set(it.k, it);

function stored() { try { return JSON.parse(db.kvGet('settings', '{}') || '{}'); } catch { return {}; } }

function coerce(it, v) {
  if (it.type === 'bool') return v === true || v === 'true' || v === 1 || v === '1';
  if (it.type === 'number') {
    const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${it.label}: no es un número`);
    if (it.min !== undefined && n < it.min) throw new Error(`${it.label}: mínimo ${it.min}`);
    if (it.max !== undefined && n > it.max) throw new Error(`${it.label}: máximo ${it.max}`);
    return n;
  }
  if (it.type === 'select') { if (!it.options.some((o) => o[0] === v)) throw new Error(`${it.label}: opción no válida`); return v; }
  const s = String(v ?? '').trim();
  if (s.length > 200) throw new Error(`${it.label}: demasiado largo`);
  if (/[\r\n;|&$`<>]/.test(s)) throw new Error(`${it.label}: caracteres no permitidos`);   // estos valores terminan en comandos: nada de shell
  return s;
}

function get(k) {
  const it = ITEMS.get(k); if (!it) throw new Error('ajuste desconocido: ' + k);
  const s = stored();
  return k in s ? s[k] : it.def;
}
const list = (k) => String(get(k)).split(',').map((x) => x.trim()).filter(Boolean);

function all() { const out = {}; for (const k of ITEMS.keys()) out[k] = get(k); out.paused = db.kvGet('paused') === '1'; return out; }

function set(patch) {
  const cur = stored(); const errors = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'paused') { db.kvSet('paused', v === true || v === 'true' || v === '1' ? '1' : '0'); continue; }
    const it = ITEMS.get(k); if (!it) { errors.push('ajuste desconocido: ' + k); continue; }
    try { cur[k] = coerce(it, v); } catch (e) { errors.push(e.message); }
  }
  if (errors.length) throw new Error(errors.join('. '));
  db.kvSet('settings', JSON.stringify(cur));
  return all();
}

module.exports = { SCHEMA, get, list, all, set, HARNESS };
