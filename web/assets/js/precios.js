/* ==========================================================================
   Relevo · motor de precios
   Una sola fuente de verdad para el sitio y para el panel.
   Si cambias una base, cambia en los dos lados a la vez.
   ========================================================================== */

(function () {
  'use strict';

  var MODEL = {
    ensayo:       { base: 90, per: 18, unit: 'páginas',      def: 4,  label: 'Ensayo o investigación', service: 'Ensayo o investigación' },
    presentacion: { base: 60, per: 12, unit: 'diapositivas', def: 10, label: 'Presentación',           service: 'Presentación' },
    cambridge:    { base: 60, per: 18, unit: 'actividades',  def: 5,  label: 'Cambridge One',          service: 'Cambridge One' },
    tarea:        { base: 50, per: 9,  unit: 'actividades',  def: 4,  label: 'Tarea en línea',         service: 'Tarea en línea' },
    formato:      { base: 50, per: 4,  unit: 'páginas',      def: 8,  label: 'PDF y formato',          service: 'PDF y formato' }
  };

  var RUSH = {
    normal: { f: 1,    text: 'más de 5 días' },
    week:   { f: 1.15, text: 'esta semana' },
    rush:   { f: 1.3,  text: 'menos de 48 h' }
  };

  var FLOOR = 50;
  var CEIL = 250;

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function round5(n) { return Math.round(n / 5) * 5; }

  function mxn(n) {
    var v = Math.round(Number(n) || 0);
    return '$' + new Intl.NumberFormat('es-MX').format(v);
  }

  /* Devuelve el rango [lo, hi] que se muestra al cliente. */
  function computeRange(state) {
    var m = MODEL[state.kind] || MODEL.ensayo;
    var rush = RUSH[state.rush] || RUSH.normal;
    var raw = (m.base + m.per * state.extent) * rush.f;
    var lo = round5(Math.max(FLOOR, raw * 0.85));
    var hi = round5(Math.min(CEIL, raw * 1.15));
    if (lo > CEIL) lo = CEIL;
    if (hi < lo) hi = lo;
    return { lo: lo, hi: hi, capped: raw * 1.15 > CEIL, floor: raw * 0.85 < FLOOR };
  }

  /* Precio que se cierra con el cliente: el punto medio del rango,
     redondeado a 5. Es una sugerencia, siempre se puede editar. */
  function suggestedPrice(kind, extent, rush) {
    var r = computeRange({ kind: kind, extent: extent, rush: rush || 'normal' });
    return round5((r.lo + r.hi) / 2);
  }

  window.RELEVO_PRECIOS = {
    MODEL: MODEL,
    RUSH: RUSH,
    FLOOR: FLOOR,
    CEIL: CEIL,
    clamp: clamp,
    round5: round5,
    mxn: mxn,
    computeRange: computeRange,
    suggestedPrice: suggestedPrice
  };
})();
