/* ==========================================================================
   Relevo · conteo de visitas
   Solo cuenta dos cosas: una vista de página y un clic al botón de WhatsApp,
   con el origen (utm_source o de qué sitio viene). No guarda datos personales,
   no usa cookies. Si config.js no tiene "track", no hace nada.
   ========================================================================== */

(function () {
  'use strict';

  var cfg = window.RELEVO || {};
  if (!cfg.track || !window.fetch) return;

  var query = new URLSearchParams(window.location.search);
  var src = (query.get('utm_source') || '').toLowerCase();
  if (!src && document.referrer) {
    try {
      var host = new URL(document.referrer).hostname.replace(/^www\./, '');
      if (host && host !== window.location.hostname) src = host.split('.')[0];
    } catch (err) { /* sin referente */ }
  }
  src = src || 'directo';

  function send(type) {
    try {
      fetch(cfg.track, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: type, path: window.location.pathname, src: src }),
        keepalive: true,
        mode: 'cors',
        credentials: 'omit'
      }).catch(function () {});
    } catch (err) { /* el conteo nunca debe romper la página */ }
  }

  send('page');

  document.addEventListener('click', function (event) {
    var a = event.target.closest && event.target.closest('a[href*="wa.me"], a[href*="whatsapp.com"], [data-wa]');
    if (a) send('wa');
  }, true);
})();
