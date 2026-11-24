'use strict';
// Barandales en código: no dependen de que el modelo se acuerde de las reglas.
const db = require('./db');

const RE = {
  secrets: /contrase[ñn]a|password|passw|clave de (acceso|mi)|mi (usuario|cuenta) (es|y)|\bnip\b|cvv|n[uú]mero de (la )?tarjeta|datos bancarios|token|codigo de verificaci[oó]n/i,
  liveExam: /ex[aá]men (en vivo|ahora|de hoy en|mientras)|mientras (lo )?presento|presentar(lo)? por m[ií]|suplant|hacerme pasar|que entres? (a|en) mi (cuenta|plataforma)|entra(r)? a mi (cuenta|plataforma|canvas|classroom)/i,
  claims: /indetectable|no se (va a|van a) dar cuenta|garantiz\w+ (la |tu |una )?(calificaci|nota|aprob|diez|10)|100 ?% (seguro|garantizado)|seguro (que )?(pasas|apruebas)|sin que (te )?(detecten|descubran)|burla(r)? (el )?(antiplagio|turnitin|detector)/i,
  paid: /comprobante|ya (te )?(pagu[eé]|deposit[eé]|transfer[ií])|te (pagu[eé]|deposit[eé]|transfer[ií])|hice (el|la) (pago|dep[oó]sito|transferencia)|anticipo (ya )?(listo|enviado)/i,
  delicate: /precio|cu[aá]nto|cotiz|cuesta|costo|curso|pag|transfer|dep[oó]sit|descuent|promo|reembols|devol|queja|molest|mal |error|urgente|hoy|ma[ñn]ana|entrega|revis|corrig|factura/i,
  discount: /(\d{1,3})\s?%/g,
  amounts: /\$\s?(\d{2,5})/g,
};

const S = require('./settings');
// Se leen de Ajustes en cada mensaje (panel > Sistema)
const allowedPct = () => new Set(S.list('allowed_discount_pcts').map(Number));
const maxAmount = () => S.get('price_ceiling');
const floorPrice = () => S.get('price_floor');

const FIXED = {
  hold: 'Dame un momento, lo reviso y te contesto.',
};

function style(s) {
  return String(s || '')
    .replace(/[¡!]/g, '')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Temas que el agente no resuelve solo: no se niega ni responde sobre ellos, se los pasa a Carlos para que decida.
function preCheck(text) {
  const t = String(text || '');
  if (RE.liveExam.test(t)) return { intent: 'otro', reply: '', escalate: true, reason: 'Habla de examen en vivo o de entrar a su cuenta: decide tú' };
  if (RE.secrets.test(t)) return { intent: 'otro', reply: '', escalate: true, reason: 'Mencionó una contraseña, cuenta o datos de acceso: decide tú' };
  return null;
}

function routeTier(text, ctx = {}) {
  if (ctx.hasMedia || ctx.isNew) return 'delicate';
  if ((ctx.openOrders || []).some((o) => ['cotizado', 'anticipo-reportado'].includes(o.etapa) || ['en_proceso', 'entregado'].includes(o.estado))) return 'delicate';
  return RE.delicate.test(String(text || '')) ? 'delicate' : 'routine';
}

// Revisión posterior: devuelve la decisión corregida y si hay que avisar al dueño.
function postCheck(d, incoming) {
  const out = { ...d, notifyOwner: false, flags: [] };
  out.reply = style(d.reply);
  out.escalate = !!d.escalate;
  out.reason = d.reason || '';

  if (RE.claims.test(out.reply)) { out.escalate = true; out.reason = 'El borrador prometía algo no permitido (indetectable/calificación)'; out.flags.push('claims'); }
  for (const m of out.reply.matchAll(RE.discount)) if (!allowedPct().has(Number(m[1]))) { out.escalate = true; out.reason = `Porcentaje fuera de promociones: ${m[1]}%`; out.flags.push('discount'); }
  const isCourse = d.intent === 'curso' || d.order?.servicio === 'curso';
  for (const m of out.reply.matchAll(RE.amounts)) if (Number(m[1]) > maxAmount() && !isCourse) { out.escalate = true; out.reason = `Monto fuera de rango: $${m[1]}`; out.flags.push('amount'); }
  if (out.reply.length > 1400) { out.escalate = true; out.reason = 'Respuesta demasiado larga'; out.flags.push('long'); }
  if (isCourse) { out.escalate = true; out.reason = out.reason || 'Curso completo: se cotiza con el dueño'; out.flags.push('course'); }
  if (d.intent === 'queja') { out.escalate = true; out.reason = out.reason || 'Queja o inconformidad'; }
  if (RE.paid.test(incoming || '') || d.intent === 'pago') { out.notifyOwner = true; out.flags.push('pago-por-confirmar'); }
  if (d.cotizo_con_dueno === true) {
    out.flags.push('cotizo-con-dueno'); out.ownerPrice = true;
    out.precio_declarado = Number(d.precio_declarado) > 0 ? Number(d.precio_declarado) : null;
    if (out.precio_declarado && out.precio_declarado > maxAmount() && !isCourse) { out.escalate = true; out.reason = `El cliente dice que quedó en $${out.precio_declarado}, arriba del tope de ${maxAmount()}`; }
    // mientras Carlos no confirme, el agente no da datos de pago ni cuenta
    if (/\b\d{16,18}\b|clabe|mercado ?pago/i.test(out.reply)) { out.reply = 'Perfecto, lo confirmo con Carlos y seguimos.'; out.flags.push('sin-datos-de-pago'); }
  }

  // El agente solo puede poner estados sin dinero. Pago confirmado = decisión del dueño.
  if (out.order) {
    const o = { ...out.order };
    delete o.estado;                                                   // el agente nunca cambia el estado del pedido
    if (o.etapa && !db.AGENT_ETAPAS.includes(o.etapa)) delete o.etapa;
    if (RE.paid.test(incoming || '')) o.etapa = 'anticipo-reportado';
    for (const k of ['anticipo', 'pagado', 'costo', 'horas']) delete o[k];
    if (!isCourse) {
      if (o.rango_min != null && o.rango_min < floorPrice()) o.rango_min = floorPrice();
      if (o.rango_max != null && o.rango_max > maxAmount()) { out.escalate = true; out.reason = 'Rango por encima de ' + maxAmount(); o.rango_max = maxAmount(); }
    }
    out.order = o;
  }
  return out;
}

module.exports = { preCheck, postCheck, routeTier, style, FIXED, RE };
