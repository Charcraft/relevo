/* ==========================================================================
   Relevo · turno de noche
   Interfaz, calculadora, pedido y dos escenas 3D atadas al scroll.
   ========================================================================== */

(function () {
  'use strict';

  var cfg = window.RELEVO || {};
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };

  var query = new URLSearchParams(window.location.search);
  var source = (query.get('utm_source') || '').toLowerCase();
  var fromFlyer = source === 'flyer';

  if (fromFlyer) {
    var flyerPromo = document.getElementById('flyerPromo');
    if (flyerPromo) flyerPromo.hidden = false;
  }

  var digits = String(cfg.whatsapp || '').replace(/\D/g, '');
  var hasWa = digits.length >= 8;
  var waBase = 'https://wa.me/' + digits;

  /* ---------------------------------------------------------------- config */

  if (hasWa) {
    ['topWa', 'heroWa'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) { el.href = waBase; el.target = '_blank'; el.rel = 'noopener'; }
    });

    var footWa = $('#footWa');
    if (footWa) {
      footWa.href = waBase;
      footWa.target = '_blank';
      footWa.rel = 'noopener';
      footWa.textContent = 'WhatsApp · ' + (cfg.whatsappPretty || '+52 000 000 0000');
    }

    var courseWa = $('#courseWa');
    if (courseWa) {
      courseWa.href = waBase + '?text=' + encodeURIComponent('Hola, quiero cotizar un curso completo. Te paso el temario y las fechas.');
      courseWa.target = '_blank';
      courseWa.rel = 'noopener';
    }
  }

  var footIg = $('#footIg');
  var ig = String(cfg.instagram || '').replace(/^@/, '').trim();
  if (footIg && ig) {
    footIg.href = 'https://instagram.com/' + encodeURIComponent(ig);
    footIg.target = '_blank';
    footIg.rel = 'noopener';
    footIg.textContent = '@' + ig;
    footIg.hidden = false;
  }

  var sendLabel = $('#sendLabel');
  var copyBtn = $('#copyBtn');
  if (!hasWa) {
    if (sendLabel) sendLabel.textContent = 'Copiar mi pedido';
    if (copyBtn) copyBtn.hidden = true;
  }

  var year = $('#year');
  if (year) year.textContent = String(new Date().getFullYear());

  /* ----------------------------------------------------------------- reloj */

  var clockEl = $('#clock');
  function tickClock() {
    if (!clockEl) return;
    try {
      clockEl.textContent = new Date().toLocaleTimeString('es-MX', {
        hour: '2-digit', minute: '2-digit', hour12: false
      });
    } catch (err) {
      clockEl.textContent = '--:--';
    }
  }
  tickClock();
  window.setInterval(tickClock, 20000);

  /* ------------------------------------------------------- barra de scroll */

  var scrollBar = $('#scrollBar');
  var hero = $('.hero');
  var scrollState = { p: 0 };

  function updateScrollBar() {
    var max = document.documentElement.scrollHeight - window.innerHeight;
    var p = max > 0 ? clamp(window.scrollY / max, 0, 1) : 0;
    if (scrollBar) scrollBar.style.width = (p * 100).toFixed(2) + '%';
    if (hero) hero.classList.toggle('is-scrolled', window.scrollY > 40);
  }

  /* --------------------------------------------------------------- revelado */

  var revealables = $$('[data-reveal]');
  if (revealables.length) {
    if ('IntersectionObserver' in window && !reduce) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-in');
            io.unobserve(entry.target);
          }
        });
      }, { rootMargin: '0px 0px -10% 0px', threshold: 0.15 });
      revealables.forEach(function (el) { io.observe(el); });
    } else {
      revealables.forEach(function (el) { el.classList.add('is-in'); });
    }
  }

  /* ----------------------------------------------------- resaltar sección */

  var navLinks = $$('.nav a');
  if (navLinks.length && 'IntersectionObserver' in window) {
    var map = {};
    navLinks.forEach(function (link) {
      var href = link.getAttribute('href');
      if (href && href.charAt(0) === '#') map[href.slice(1)] = link;
    });
    var sections = Object.keys(map).map(function (id) { return document.getElementById(id); }).filter(Boolean);

    var navIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var link = map[entry.target.id];
        if (!link || !entry.isIntersecting) return;
        navLinks.forEach(function (l) { l.removeAttribute('aria-current'); });
        link.setAttribute('aria-current', 'true');
      });
    }, { rootMargin: '-45% 0px -50% 0px' });

    sections.forEach(function (s) { navIO.observe(s); });
  }

  /* --------------------------------------------------------- luz del cursor */

  if (!reduce && window.matchMedia('(pointer: fine)').matches) {
    var glow = document.createElement('div');
    glow.className = 'glow';
    glow.setAttribute('aria-hidden', 'true');
    document.body.appendChild(glow);
    var gx = 0, gy = 0, tx = 0, ty = 0, glowOn = false;

    window.addEventListener('pointermove', function (e) {
      tx = e.clientX;
      ty = e.clientY;
      if (!glowOn) { glow.classList.add('is-on'); glowOn = true; }
    }, { passive: true });

    window.addEventListener('pointerleave', function () {
      glow.classList.remove('is-on');
      glowOn = false;
    });

    (function follow() {
      gx += (tx - gx) * 0.08;
      gy += (ty - gy) * 0.08;
      glow.style.transform = 'translate3d(' + gx.toFixed(1) + 'px,' + gy.toFixed(1) + 'px,0)';
      window.requestAnimationFrame(follow);
    })();
  }

  /* ------------------------------------------------------------ calculadora */

  /* El motor vive en assets/js/precios.js para compartirlo con el panel. */
  var P = window.RELEVO_PRECIOS;
  var MODEL = P.MODEL;
  var RUSH = P.RUSH;

  var calcForm = $('#calcForm');
  var extentInput = $('#extent');
  var extLegend = $('#extLegend');
  var calcMin = $('#calcMin');
  var calcMax = $('#calcMax');
  var calcTag = $('#calcTag');
  var calcNote = $('#calcNote');
  var calcSend = $('#calcSend');
  var ticketRange = $('#tkRange');
  var estimate = null;
  var calcTouched = false;

  var mxn = P.mxn;
  var computeRange = P.computeRange;

  function readCalc() {
    var kindEl = $('input[name="kind"]:checked');
    var rushEl = $('input[name="rush"]:checked');
    return {
      kind: kindEl ? kindEl.value : 'ensayo',
      rush: rushEl ? rushEl.value : 'normal',
      extent: clamp(parseInt(extentInput.value, 10) || MODEL[kindEl ? kindEl.value : 'ensayo'].def, 1, 40)
    };
  }

  function renderCalc() {
    var state = readCalc();
    var m = MODEL[state.kind];
    var range = computeRange(state);
    range.service = m.service;
    range.kind = state.kind;
    range.extent = state.extent;
    estimate = range;

    if (extLegend) extLegend.textContent = 'Cuántas ' + m.unit;
    if (calcTag) calcTag.textContent = m.label + ' · ' + state.extent + ' ' + m.unit;
    if (calcMin) calcMin.textContent = mxn(range.lo);
    if (calcMax) calcMax.textContent = mxn(range.hi) + (range.capped ? '+' : '');

    if (calcNote) {
      if (range.capped) {
        calcNote.textContent = 'El techo del rango es $250. Si tu trabajo es más grande, se cotiza aparte con el alcance desglosado.';
      } else if (state.rush === 'rush') {
        calcNote.textContent = 'Incluye el recargo de 30% por entrega en menos de 48 horas.';
      } else if (state.rush === 'week') {
        calcNote.textContent = 'Incluye el recargo de 15% por entrega esta semana.';
      } else {
        calcNote.textContent = 'Incluye portada, índice y revisión. La prisa se cobra aparte si es urgente.';
      }
    }

    if (ticketRange && calcTouched && typeof fService !== 'undefined' && fService && fService.value === m.service) {
      ticketRange.textContent = mxn(range.lo) + ' a ' + mxn(range.hi);
      ticketRange.dataset.filled = '1';
    }

    if (calcSend) {
      if (hasWa) {
        var msg = [
          'Hola, quiero cotizar un trabajo.',
          'Tipo: ' + m.label,
          'Extensión: ' + state.extent + ' ' + m.unit,
          'Entrega: ' + RUSH[state.rush].text,
          'Rango que calculé: ' + mxn(range.lo) + ' a ' + mxn(range.hi) + ' MXN',
          '¿Me confirmas el precio exacto?'
        ].join('\n');
        if (fromFlyer) msg += '\n\nVengo del flyer. Código: FLYER20.';
        calcSend.href = waBase + '?text=' + encodeURIComponent(msg);
        calcSend.target = '_blank';
        calcSend.rel = 'noopener';
      } else {
        calcSend.href = '#pedido';
        calcSend.textContent = 'Llevar esto al formulario';
      }
    }
  }

  if (calcForm) {
    calcForm.addEventListener('change', function (event) {
      if (event.target.name === 'kind') {
        var state = readCalc();
        extentInput.value = String(MODEL[state.kind].def);
      }
      calcTouched = true;
      renderCalc();
    });

    calcForm.addEventListener('input', function (event) {
      if (event.target === extentInput) {
        calcTouched = true;
        renderCalc();
      }
    });

    $$('.stepper__btn', calcForm).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var step = Number(btn.getAttribute('data-step')) || 0;
        var current = parseInt(extentInput.value, 10) || MODEL[readCalc().kind].def;
        extentInput.value = String(clamp(current + step, 1, 40));
        calcTouched = true;
        renderCalc();
      });
    });

    renderCalc();
  }

  /* ------------------------------------------------- rangos desde config */

  $$('[data-range]').forEach(function (el) {
    var key = el.getAttribute('data-range');
    var v = cfg.prices ? cfg.prices[key] : null;
    if (!Array.isArray(v) || v.length < 2) return;
    el.textContent = mxn(v[0]) + ' a ' + mxn(v[1]);
    var row = el.closest ? el.closest('.price') : null;
    var fill = row ? row.querySelector('.price__fill') : null;
    if (fill) {
      fill.style.setProperty('--lo', (clamp(v[0], 0, 250) / 250 * 100).toFixed(1) + '%');
      fill.style.setProperty('--hi', (clamp(v[1], 0, 250) / 250 * 100).toFixed(1) + '%');
    }
  });

  /* ---------------------------------------------------------------- pedido */

  var orderForm = $('#orderForm');
  var fName = $('#fName');
  var fSubject = $('#fSubject');
  var fService = $('#fService');
  var fDate = $('#fDate');
  var fPages = $('#fPages');
  var fBrief = $('#fBrief');
  var status = $('#formStatus');
  var ticket = $('.ticket');
  var ticketPaper = $('#ticketPaper');
  var tk = {
    name: $('#tkName'),
    service: $('#tkService'),
    subject: $('#tkSubject'),
    date: $('#tkDate'),
    format: $('#tkFormat'),
    stamp: $('#tkStamp'),
    number: $('#tkNumber')
  };

  if (tk.number) tk.number.textContent = 'N.º 0' + (Math.floor(Math.random() * 800) + 120);

  function todayISO() {
    var now = new Date();
    var offset = now.getTimezoneOffset() * 60000;
    return new Date(now.getTime() - offset).toISOString().slice(0, 10);
  }
  if (fDate) fDate.min = todayISO();

  function selectedFormat() {
    var checked = $('input[name="format"]:checked');
    return checked ? checked.value : '';
  }

  function prettyDate(value) {
    if (!value) return '';
    var parts = value.split('-');
    if (parts.length !== 3) return value;
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    if (isNaN(d.getTime())) return value;
    try {
      return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch (err) {
      return value;
    }
  }

  function setText(el, value) {
    if (!el) return;
    el.textContent = value || '';
  }

  function ready() {
    return Boolean(fName && fName.value.trim() && fService && fService.value && fDate && fDate.value);
  }

  function refreshTicket() {
    setText(tk.name, fName ? fName.value.trim() : '');
    setText(tk.service, fService ? fService.value : '');
    setText(tk.subject, fSubject ? fSubject.value.trim() : '');
    setText(tk.date, fDate ? prettyDate(fDate.value) : '');
    setText(tk.format, selectedFormat() || 'PDF');

    if (ticketRange) {
      var match = calcTouched && estimate && fService && fService.value && estimate.service === fService.value;
      ticketRange.textContent = match ? mxn(estimate.lo) + ' a ' + mxn(estimate.hi) : 'Sin calcular';
    }

    var isReady = ready();
    if (tk.stamp && !tk.stamp.dataset.sent) tk.stamp.textContent = isReady ? 'LISTO' : 'BORRADOR';
    if (ticket) ticket.classList.toggle('is-ready', isReady);
    if (ticketPaper) ticketPaper.classList.toggle('is-ready', isReady);
  }

  function buildMessage() {
    var lines = [];
    lines.push('Hola, quiero cotizar este trabajo:');
    lines.push('');
    if (fromFlyer) {
      lines.push('Vengo del flyer. Código: FLYER20.');
      lines.push('');
    }
    lines.push('Nombre: ' + (fName && fName.value.trim() ? fName.value.trim() : '(sin nombre)'));
    lines.push('Servicio: ' + (fService && fService.value ? fService.value : '(por definir)'));
    if (fSubject && fSubject.value.trim()) lines.push('Tema: ' + fSubject.value.trim());
    lines.push('Entrega: ' + ((fDate && prettyDate(fDate.value)) || '(por definir)'));
    if (fPages && fPages.value.trim()) lines.push('Extensión: ' + fPages.value.trim());
    if (selectedFormat()) lines.push('Formato: ' + selectedFormat());
    if (estimate && calcTouched && fService && fService.value === estimate.service) {
      lines.push('Rango estimado: ' + mxn(estimate.lo) + ' a ' + mxn(estimate.hi) + ' MXN');
    }
    if (fBrief && fBrief.value.trim()) {
      lines.push('');
      lines.push('Qué pide la actividad:');
      lines.push(fBrief.value.trim());
    }
    lines.push('');
    lines.push('(Enviado desde relevo)');
    return lines.join('\n');
  }

  function setStatus(text, kind) {
    if (!status) return;
    status.textContent = text;
    status.classList.remove('is-ok', 'is-err');
    if (kind) status.classList.add(kind);
  }

  function clearError(input, errEl) {
    if (input) input.removeAttribute('aria-invalid');
    if (errEl) errEl.textContent = '';
  }

  function showError(input, errEl, message) {
    if (input) input.setAttribute('aria-invalid', 'true');
    if (errEl) errEl.textContent = message;
  }

  function validate() {
    var ok = true;
    var first = null;
    var errName = $('#errName');
    var errService = $('#errService');
    var errDate = $('#errDate');

    clearError(fName, errName);
    clearError(fService, errService);
    clearError(fDate, errDate);

    if (!fName.value.trim()) {
      showError(fName, errName, 'Escribe tu nombre para saber a quién va el envío.');
      first = first || fName;
      ok = false;
    }

    if (!fService.value) {
      showError(fService, errService, 'Elige el tipo de trabajo.');
      first = first || fService;
      ok = false;
    }

    if (!fDate.value) {
      showError(fDate, errDate, 'Falta la fecha en la que lo necesitas.');
      first = first || fDate;
      ok = false;
    } else if (fDate.value < todayISO()) {
      showError(fDate, errDate, 'Esa fecha ya pasó. Elige una próxima.');
      first = first || fDate;
      ok = false;
    }

    if (!ok && first) first.focus({ preventScroll: false });
    return ok;
  }

  function copyText(text) {
    return new Promise(function (resolve) {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(function () { resolve(true); }, function () { resolve(legacyCopy(text)); });
      } else {
        resolve(legacyCopy(text));
      }
    });
  }

  function legacyCopy(text) {
    try {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      document.body.appendChild(area);
      area.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(area);
      return ok;
    } catch (err) {
      return false;
    }
  }

  if (orderForm) {
    orderForm.addEventListener('input', function (event) {
      var t = event.target;
      if (t === fName) clearError(fName, $('#errName'));
      if (t === fService) clearError(fService, $('#errService'));
      if (t === fDate) clearError(fDate, $('#errDate'));
      refreshTicket();
      if (status.textContent) setStatus('', null);
    });

    orderForm.addEventListener('change', refreshTicket);

    orderForm.addEventListener('submit', function (event) {
      event.preventDefault();
      if (!validate()) {
        setStatus('Revisa los campos marcados.', 'is-err');
        return;
      }

      var message = buildMessage();

      if (hasWa) {
        window.open(waBase + '?text=' + encodeURIComponent(message), '_blank', 'noopener');
        setStatus('Se abrió WhatsApp con tu pedido escrito. Solo dale enviar.', 'is-ok');
      } else {
        copyText(message).then(function (ok) {
          setStatus(ok
            ? 'Tu pedido está copiado. Pégalo en tu chat de WhatsApp.'
            : 'Tu pedido está listo. Selecciónalo y cópialo a mano.', 'is-ok');
        });
      }

      if (tk.stamp) {
        tk.stamp.textContent = 'ENVIADO';
        tk.stamp.dataset.sent = '1';
      }
    });

    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        if (!validate()) {
          setStatus('Revisa los campos marcados.', 'is-err');
          return;
        }
        copyText(buildMessage()).then(function (ok) {
          setStatus(ok ? 'Pedido copiado. Pégalo donde quieras mandarlo.' : 'No se pudo copiar. Selecciona el texto a mano.', ok ? 'is-ok' : 'is-err');
        });
      });
    }

    refreshTicket();
  }

  /* ------------------------------------------------------------ progreso */

  var turnoSection = $('#turno');
  var turnoBar = $('#turnoBar');
  var turnoPct = $('#turnoPct');
  var steps = $$('.step');
  var turnoStep = -1;

  function progressOf(el) {
    if (!el) return 0;
    var rect = el.getBoundingClientRect();
    var total = rect.height - window.innerHeight;
    if (total <= 0) return 0;
    return clamp(-rect.top / total, 0, 1);
  }

  function paintTurno(p) {
    if (turnoBar) turnoBar.style.width = (p * 100).toFixed(1) + '%';
    if (turnoPct) turnoPct.textContent = Math.round(p * 100) + '%';

    var idx = p < 0.28 ? 0 : p < 0.53 ? 1 : p < 0.78 ? 2 : 3;
    if (idx !== turnoStep) {
      turnoStep = idx;
      steps.forEach(function (s, i) { s.classList.toggle('is-on', i === idx); });
    }
  }

  var sceneState = { heroP: 0, turnoP: 0 };
  var scrollQueued = false;
  function onScroll() {
    if (scrollQueued) return;
    scrollQueued = true;
    window.requestAnimationFrame(function () {
      scrollQueued = false;
      updateScrollBar();
      sceneState.heroP = clamp(window.scrollY / Math.max(1, window.innerHeight), 0, 1);
      sceneState.turnoP = progressOf(turnoSection);
      paintTurno(sceneState.turnoP);
    });
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  updateScrollBar();
  onScroll();

  /* ------------------------------------------------------------ three.js */

  var heroCanvas = $('#heroScene');
  var turnoCanvas = $('#turnoScene');
  var glState = {
    heroVisible: true,
    turnoVisible: false,
    hero: null,
    turno: null
  };

  if ('IntersectionObserver' in window) {
    var visIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.target === heroCanvas) glState.heroVisible = entry.isIntersecting;
        if (entry.target === turnoCanvas) glState.turnoVisible = entry.isIntersecting;
      });
    }, { rootMargin: '120px' });
    if (heroCanvas) visIO.observe(heroCanvas);
    if (turnoCanvas) visIO.observe(turnoCanvas);
  }

  function paperTexture(THREE) {
    var w = 640, h = 860;
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    var g = c.getContext('2d');

    g.fillStyle = '#f0ead9';
    g.fillRect(0, 0, w, h);

    // fibra del papel
    for (var i = 0; i < 900; i += 1) {
      g.fillStyle = 'rgba(90, 76, 54, ' + (0.02 + Math.random() * 0.03).toFixed(3) + ')';
      var x = Math.random() * w;
      var y = Math.random() * h;
      g.fillRect(x, y, 1 + Math.random() * 2, 1);
    }

    // margen
    g.strokeStyle = 'rgba(190, 96, 84, 0.35)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(70, 0);
    g.lineTo(70, h);
    g.stroke();

    // renglones
    g.strokeStyle = 'rgba(74, 92, 140, 0.16)';
    g.lineWidth = 1;
    for (var y2 = 150; y2 < h - 60; y2 += 27) {
      g.beginPath();
      g.moveTo(56, y2);
      g.lineTo(w - 46, y2);
      g.stroke();
    }

    // título
    g.fillStyle = 'rgba(36, 32, 26, 0.72)';
    g.fillRect(150, 78, 300, 12);
    g.fillRect(210, 100, 180, 7);

    // párrafos
    g.fillStyle = 'rgba(40, 36, 30, 0.55)';
    for (var y3 = 166; y3 < h - 90; y3 += 27) {
      var x2 = 84;
      var end = w - 60 - Math.random() * 120;
      while (x2 < end) {
        var word = 18 + Math.random() * 46;
        if (x2 + word > end) word = end - x2;
        if (word > 6) g.fillRect(x2, y3 - 6, word, 4);
        x2 += word + 8;
      }
      if (Math.random() < 0.12) y3 += 27;
    }

    var tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  function glowTexture(THREE) {
    var c = document.createElement('canvas');
    c.width = c.height = 256;
    var g = c.getContext('2d');
    var grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, 'rgba(255, 214, 156, 0.9)');
    grad.addColorStop(0.35, 'rgba(243, 180, 92, 0.28)');
    grad.addColorStop(1, 'rgba(243, 180, 92, 0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    var tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  function dust(THREE, count, spread, size) {
    var positions = new Float32Array(count * 3);
    for (var i = 0; i < count * 3; i += 3) {
      positions[i] = (Math.random() - 0.5) * spread[0];
      positions[i + 1] = (Math.random() - 0.5) * spread[1];
      positions[i + 2] = (Math.random() - 0.5) * spread[2];
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    var mat = new THREE.PointsMaterial({
      color: 0xffd39a,
      size: size,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true
    });
    return new THREE.Points(geo, mat);
  }

  async function initScenes() {
    var THREE;
    try {
      THREE = await import('../vendor/three.module.js');
    } catch (err) {
      document.documentElement.classList.add('no-gl');
      return;
    }

    var tex = paperTexture(THREE);
    var glow = glowTexture(THREE);

    /* -------- hero: hojas flotando en la penumbra -------- */

    if (heroCanvas) {
      var r1 = new THREE.WebGLRenderer({ canvas: heroCanvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
      r1.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.85));
      r1.toneMapping = THREE.ACESFilmicToneMapping;
      r1.toneMappingExposure = 1.02;

      var s1 = new THREE.Scene();
      s1.fog = new THREE.FogExp2(0x08090d, 0.03);

      var cam1 = new THREE.PerspectiveCamera(34, 1, 0.1, 60);
      cam1.position.set(0, 0.35, 7.4);

      var group = new THREE.Group();
      group.position.set(1.55, 0.05, 0);
      s1.add(group);

      var sheets = [];
      var tints = [0xfffaf0, 0xf6efdf, 0xf1e9d7, 0xfbf5e8, 0xefe6d2, 0xfdf7ec, 0xf4ecda];
      for (var i = 0; i < 7; i += 1) {
        var geo = new THREE.PlaneGeometry(2.45, 3.28);
        var mat = new THREE.MeshStandardMaterial({
          map: tex,
          color: tints[i],
          roughness: 0.94,
          metalness: 0,
          side: THREE.DoubleSide
        });
        var mesh = new THREE.Mesh(geo, mat);
        mesh.userData = {
          base: new THREE.Vector3((i - 3) * 0.26, -i * 0.045, -i * 0.24),
          rot: new THREE.Euler((Math.random() - 0.5) * 0.22, (i - 3) * 0.1, (Math.random() - 0.5) * 0.16),
          stack: new THREE.Vector3((i - 3) * 0.04, i * 0.014, -i * 0.03)
        };
        mesh.position.copy(mesh.userData.base);
        mesh.rotation.copy(mesh.userData.rot);
        group.add(mesh);
        sheets.push(mesh);
      }

      var key = new THREE.DirectionalLight(0xffe0bd, 2.6);
      key.position.set(3.4, 4.2, 4.2);
      s1.add(key);

      var fill = new THREE.DirectionalLight(0xffe9d2, 1.5);
      fill.position.set(0.4, 1.4, 6);
      s1.add(fill);

      var rim = new THREE.PointLight(0x5468ff, 18, 16, 2);
      rim.position.set(-3.2, -1.2, 3.4);
      s1.add(rim);

      var amb = new THREE.HemisphereLight(0x4457ff, 0x08090d, 0.55);
      s1.add(amb);

      var sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glow,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      }));
      sprite.scale.set(5.2, 5.2, 1);
      sprite.position.set(1.9, 2.1, -1.6);
      s1.add(sprite);

      var motes = dust(THREE, window.innerWidth < 700 ? 170 : 320, [13, 8, 7], 0.028);
      s1.add(motes);

      var pointer = { x: 0, y: 0, tx: 0, ty: 0 };
      window.addEventListener('pointermove', function (e) {
        pointer.tx = (e.clientX / window.innerWidth - 0.5) * 2;
        pointer.ty = (e.clientY / window.innerHeight - 0.5) * 2;
      }, { passive: true });

      glState.hero = {
        renderer: r1,
        scene: s1,
        camera: cam1,
        group: group,
        sheets: sheets,
        motes: motes,
        pointer: pointer
      };
    }

    /* -------- turno: la hoja que se escribe -------- */

    if (turnoCanvas) {
      var r2 = new THREE.WebGLRenderer({ canvas: turnoCanvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
      r2.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7));

      var s2 = new THREE.Scene();
      s2.fog = new THREE.FogExp2(0x08090d, 0.03);

      var cam2 = new THREE.PerspectiveCamera(34, 1, 0.1, 50);
      cam2.position.set(0.6, 0.1, 6.2);

      var pageGroup = new THREE.Group();
      pageGroup.position.set(0.55, 0, 0);
      s2.add(pageGroup);

      var pageMat = new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: tex },
          uReveal: { value: 0 },
          uWarm: { value: 1 }
        },
        vertexShader: [
          'varying vec2 vUv;',
          'void main() {',
          '  vUv = uv;',
          '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
          '}'
        ].join('\n'),
        fragmentShader: [
          'varying vec2 vUv;',
          'uniform sampler2D uMap;',
          'uniform float uReveal;',
          'uniform float uWarm;',
          'void main() {',
          '  vec3 base = texture2D(uMap, vUv).rgb;',
          '  float edge = 1.0 - uReveal;',
          '  float m = smoothstep(edge - 0.05, edge + 0.05, vUv.y);',
          '  float pen = exp(-pow((vUv.y - edge) * 110.0, 2.0));',
          '  vec3 col = base * mix(0.12, 1.0, m);',
          '  col *= vec3(1.03, 0.99, 0.93);',
          '  col += vec3(1.0, 0.78, 0.42) * pen * 0.38 * uReveal;',
          '  col *= 0.9 + uWarm * 0.12;',
          '  gl_FragColor = vec4(col, 1.0);',
          '}'
        ].join('\n')
      });

      var page = new THREE.Mesh(new THREE.PlaneGeometry(3.05, 4.0), pageMat);
      pageGroup.add(page);

      var edgeGeo = new THREE.EdgesGeometry(new THREE.PlaneGeometry(3.05, 4.0));
      var edgeMat = new THREE.LineBasicMaterial({ color: 0xf3b45c, transparent: true, opacity: 0.22 });
      var pageEdge = new THREE.LineSegments(edgeGeo, edgeMat);
      pageEdge.position.z = 0.002;
      pageGroup.add(pageEdge);

      var ring = new THREE.Mesh(
        new THREE.TorusGeometry(2.25, 0.007, 6, 180),
        new THREE.MeshBasicMaterial({ color: 0xf3b45c, transparent: true, opacity: 0 })
      );
      ring.visible = false;
      s2.add(ring);

      var checkCurve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(-1.06, 0.22, 0.012),
        new THREE.Vector3(-0.34, -0.62, 0.012),
        new THREE.Vector3(1.04, 0.72, 0.012)
      ]);
      var checkGeo = new THREE.TubeGeometry(checkCurve, 56, 0.03, 6, false);
      var checkTotal = checkGeo.index ? checkGeo.index.count : 0;
      checkGeo.setDrawRange(0, 0);
      var checkMat = new THREE.MeshBasicMaterial({ color: 0x9fe3b6 });
      var check = new THREE.Mesh(checkGeo, checkMat);
      check.visible = false;
      pageGroup.add(check);

      var spot = new THREE.PointLight(0xffcf9a, 34, 22, 2);
      spot.position.set(3.4, 3.6, 3.4);
      s2.add(spot);

      var amb2 = new THREE.HemisphereLight(0x4457ff, 0x08090d, 0.5);
      s2.add(amb2);

      var lamp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glow,
        transparent: true,
        opacity: 0.75,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      }));
      lamp.scale.set(9, 9, 1);
      lamp.position.set(4.2, 3.6, -2.5);
      s2.add(lamp);

      var motes2 = dust(THREE, window.innerWidth < 700 ? 120 : 240, [11, 7, 6], 0.022);
      s2.add(motes2);

      glState.turno = {
        renderer: r2,
        scene: s2,
        camera: cam2,
        pageGroup: pageGroup,
        page: page,
        pageMat: pageMat,
        check: check,
        checkGeo: checkGeo,
        checkTotal: checkTotal,
        motes: motes2,
        lamp: lamp
      };
    }

    layoutScenes();

    if (reduce) {
      renderHero(0.25, 0);
      renderTurno(0.6, 0);
    } else {
      loop();
    }
  }

  function layoutScenes() {
    ['hero', 'turno'].forEach(function (key) {
      var sc = glState[key];
      if (!sc) return;
      var canvas = sc.renderer.domElement;
      var w = canvas.clientWidth || canvas.parentElement.clientWidth;
      var h = canvas.clientHeight || canvas.parentElement.clientHeight;
      if (!w || !h) return;
      sc.renderer.setSize(w, h, false);
      sc.camera.aspect = w / h;
      sc.camera.updateProjectionMatrix();

      if (key === 'hero') {
        var aspect = w / h;
        var narrow = aspect < 0.85;
        var mid = !narrow && w < 1220;
        sc.baseY = narrow ? 1.05 : 0.2;
        sc.group.position.x = narrow ? 0 : (mid ? 2.75 : 2.3);
        sc.group.position.y = sc.baseY;
        var scale = narrow ? 0.78 : (mid ? 0.76 : 0.84);
        sc.group.scale.setScalar(scale);
        sc.camera.position.z = narrow ? 8.6 : (mid ? 8.3 : 7.8);
        sc.camera.fov = narrow ? 38 : 34;
        sc.camera.updateProjectionMatrix();
      }

      if (key === 'turno') {
        var small = w / h < 0.9;
        sc.narrow = small;
        sc.pageGroup.position.x = small ? 0 : 1.7;
        sc.pageGroup.position.y = small ? 0.58 : 0.05;
        sc.pageGroup.scale.setScalar(small ? 0.62 : 0.76);
        sc.baseZ = small ? 7.4 : 7.6;
        sc.camera.position.z = sc.baseZ;
        sc.camera.fov = small ? 38 : 32;
        sc.camera.updateProjectionMatrix();
        sc.lamp.position.set(small ? 2.5 : 4.4, small ? 4.6 : 3.8, -2.5);
      }
    });
  }

  function renderHero(p, dt) {
    var sc = glState.hero;
    if (!sc) return;
    var ease = p * p * (3 - 2 * p);

    sc.pointer.x += (sc.pointer.tx - sc.pointer.x) * 0.05;
    sc.pointer.y += (sc.pointer.ty - sc.pointer.y) * 0.05;

    sc.group.position.y = sc.baseY - ease * 0.55;

    sc.sheets.forEach(function (mesh, i) {
      var d = mesh.userData;
      mesh.position.lerpVectors(d.base, d.stack, ease * 0.9);
      mesh.position.y -= p * 0.35;
      mesh.rotation.x = d.rot.x + sc.pointer.y * 0.05 * (1 + i * 0.1);
      mesh.rotation.y = d.rot.y + sc.pointer.x * 0.08 * (1 + i * 0.1) + ease * 0.18;
      mesh.rotation.z = d.rot.z;
    });

    sc.group.rotation.y = -0.1 + sc.pointer.x * 0.07 + ease * 0.22;
    sc.group.rotation.x = 0.05 + sc.pointer.y * 0.05 - ease * 0.16;
    sc.camera.position.y = 0.35 - ease * 0.5;
    sc.camera.lookAt(1.0, 0.1, 0);

    sc.motes.rotation.y += dt * 0.03;
    sc.motes.rotation.x = Math.sin(performance.now() * 0.0001) * 0.05;

    sc.renderer.render(sc.scene, sc.camera);
  }

  function renderTurno(p, dt) {
    var sc = glState.turno;
    if (!sc) return;

    var reveal = clamp((p - 0.06) / 0.66, 0, 1);
    reveal = reveal * reveal * (3 - 2 * reveal);

    sc.pageMat.uniforms.uReveal.value = reveal;
    sc.pageMat.uniforms.uWarm.value = 0.7 + p * 0.5;

    sc.pageGroup.rotation.y = 0.34 - p * 0.44;
    sc.pageGroup.rotation.x = -0.06 + p * 0.05;
    sc.pageGroup.position.z = -p * 0.25;

    var checkP = clamp((p - 0.84) / 0.12, 0, 1);
    sc.check.visible = checkP > 0;
    if (sc.check.visible) sc.checkGeo.setDrawRange(0, Math.round(sc.checkTotal * checkP));

    if (sc.narrow) {
      sc.camera.position.x = 0;
      sc.camera.position.y = 0.12;
      sc.camera.position.z = sc.baseZ - p * 0.3;
      sc.camera.lookAt(0, 0, 0);
    } else {
      sc.camera.position.x = 0.7 - p * 0.55;
      sc.camera.position.y = 0.1 + p * 0.12;
      sc.camera.position.z = sc.baseZ - p * 0.55;
      sc.camera.lookAt(1.15, 0.05, 0);
    }

    sc.motes.rotation.y -= dt * 0.02;
    sc.lamp.material.opacity = 0.55 + p * 0.3;

    sc.renderer.render(sc.scene, sc.camera);
  }

  var clock = { last: 0 };

  function loop(t) {
    var now = t || 0;
    var dt = clock.last ? Math.min((now - clock.last) / 1000, 0.05) : 0.016;
    clock.last = now;

    if (document.hidden) {
      window.requestAnimationFrame(loop);
      return;
    }

    if (glState.hero && glState.heroVisible) renderHero(sceneState.heroP, dt);
    if (glState.turno && glState.turnoVisible) renderTurno(sceneState.turnoP, dt);

    window.requestAnimationFrame(loop);
  }

  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(function () {
      layoutScenes();
      if (reduce) {
        renderHero(0.25, 0);
        renderTurno(0.6, 0);
      }
    }, 140);
  });

  window.addEventListener('scroll', function () {
    if (reduce && glState.turno) renderTurno(sceneState.turnoP, 0);
  }, { passive: true });

  initScenes();
})();
