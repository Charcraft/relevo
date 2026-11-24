'use strict';
// Adaptador enchufable para cola de producción y entregas de trabajos.
const db = require('./db');

let io = { notify: async () => {} };
const setIO = (x) => { io = { ...io, ...x }; };

const PRODUCIBLE = ['ensayo', 'presentacion', 'formato', 'tarea', 'resumen'];

function start(orderId) {
  const o = db.getOrder(Number(orderId));
  if (!o) throw new Error('Pedido no encontrado');
  return { ok: true, orderId: o.id, msg: 'Cola de producción iniciada (modo adaptador).' };
}

async function deliver(orderId) {
  const o = db.getOrder(Number(orderId));
  if (!o) return { ok: false, msg: 'Pedido no encontrado.' };
  return { ok: true, msg: `Entrega lista para PEDIDO #${o.id}.` };
}

module.exports = { setIO, PRODUCIBLE, start, deliver };
