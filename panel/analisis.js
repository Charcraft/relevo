/* ==========================================================================
   Relevo · panel · Análisis y bandeja de WhatsApp
   Lee la API del servidor (los datos reales del agente). Solo funciona
   cuando el panel se abre desde el servidor; en Vercel ni se carga la pestaña.
   ========================================================================== */

(function () {
  'use strict';

  var root = null;
  var viewName = null;
  var helpers = {};
  var timer = null;
  var st = { days: 90, serie: 'semanas' };
  var last = null;

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var mx = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  function money(n) { return mx.format(Number(n) || 0); }
  function n1(n) { return n == null ? '–' : (Math.round(n * 10) / 10).toLocaleString('es-MX'); }
  function api(path, opts) {
    var o = Object.assign({ credentials: 'same-origin' }, opts || {});
    return fetch(path, o).then(function (r) {
      if (r.status === 401) { window.location.reload(); throw new Error('Sesión expirada'); }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function ago(ts) {
    var m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'ahora';
    if (m < 60) return 'hace ' + m + ' min';
    if (m < 1440) return 'hace ' + Math.round(m / 60) + ' h';
    return 'hace ' + Math.round(m / 1440) + ' d';
  }
  function minutes(m) {
    if (m == null) return '–';
    if (m < 1) return '<1 min';
    if (m < 90) return Math.round(m) + ' min';
    return n1(m / 60) + ' h';
  }
  function stat(label, value, tone, note) {
    return '<div class="stat ' + (tone ? 'stat--' + tone : '') + '"><span class="stat__label">' + esc(label) + '</span>' +
      '<span class="stat__value">' + esc(value) + '</span>' + (note ? '<span class="stat__note">' + esc(note) + '</span>' : '') + '</div>';
  }
  function head(title, sub, help, right) {
    return '<div class="view__head"><div class="view__title-wrap"><h1 class="view__title">' + esc(title) + '</h1>' +
      (sub ? '<span class="view__meta">' + esc(sub) + '</span>' : '') + '</div>' +
      (right ? '<div class="view__head-right">' + right + '</div>' : '') + '</div>';
  }
  function section(title, inner, extra) {
    return '<div class="section"><div class="section__head"><h2>' + esc(title) + '</h2>' + (extra || '') + '</div>' + inner + '</div>';
  }

  /* ---------------------------------------------------------------- gráficas */

  function bars(rows, key, label, fmt) {
    fmt = fmt || money;
    var max = 1;
    rows.forEach(function (r) { max = Math.max(max, r[key]); });
    var h = ['<div class="bars bars--money" role="img" aria-label="' + esc(label) + '">'];
    rows.forEach(function (r) {
      var pct = Math.max(r[key] ? 4 : 1.5, (r[key] / max) * 100);
      h.push('<div class="bars__col"><span class="bars__val">' + (r[key] ? (r[key] >= 1000 ? n1(r[key] / 1000) + 'k' : r[key]) : '') + '</span>' +
        '<div class="bars__fill" style="height:' + pct + '%" title="' + esc(r.k) + ': ' + fmt(r[key]) + '"></div>' +
        '<span class="bars__label">' + esc(shortLabel(r.k)) + '</span></div>');
    });
    h.push('</div>');
    return h.join('');
  }
  function shortLabel(k) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(k)) return k.slice(8) + '/' + k.slice(5, 7);
    if (/^\d{4}-\d{2}$/.test(k)) return ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][Number(k.slice(5)) - 1];
    return k;
  }

  function breakdown(title, rows, hint) {
    if (!rows || !rows.length) return '<div class="card"><h3>' + esc(title) + '</h3><p class="muted">Sin datos todavía.</p></div>';
    var max = 1;
    rows.forEach(function (r) { max = Math.max(max, r.cobrado, r.vendido); });
    var h = ['<div class="card"><h3>' + esc(title) + '</h3>' + (hint ? '<p class="field__hint">' + esc(hint) + '</p>' : '') + '<ul class="bk">'];
    rows.forEach(function (r) {
      h.push('<li><div class="bk__top"><span class="bk__name">' + esc(r.k) + '</span><span class="bk__n">' + money(r.cobrado) + '</span></div>' +
        '<div class="meter"><i style="width:' + Math.max(2, (r.cobrado / max) * 100) + '%"></i></div>' +
        '<div class="bk__sub">' + r.pedidos + ' pedido' + (r.pedidos === 1 ? '' : 's') + ' · ticket ' + money(r.ticket) +
        (r.ciclo_dias != null ? ' · ' + n1(r.ciclo_dias) + ' d en entregar' : '') + (r.saldo ? ' · por cobrar ' + money(r.saldo) : '') + '</div></li>');
    });
    h.push('</ul></div>');
    return h.join('');
  }

  function funnel(f) {
    var steps = [['Consultas que llegaron a cotización', f.contactos], ['Con precio acordado', f.cotizados], ['Con anticipo', f.confirmados], ['Entregados', f.entregados], ['Cobrados completos', f.cobrados]];
    var top = Math.max(1, f.contactos, f.cotizados);
    var h = ['<ul class="funnel">'];
    steps.forEach(function (s, i) {
      var prev = i ? steps[i - 1][1] : null;
      var conv = prev ? Math.round((s[1] / prev) * 100) + '% del paso anterior' : 'punto de partida';
      h.push('<li><div class="funnel__row"><span>' + esc(s[0]) + '</span><b>' + s[1] + '</b></div>' +
        '<div class="meter meter--amber"><i style="width:' + Math.max(2, (s[1] / top) * 100) + '%"></i></div><div class="bk__sub">' + conv + '</div></li>');
    });
    h.push('</ul>');
    return h.join('');
  }

  function hours(por) {
    var max = Math.max.apply(null, por.concat([1]));
    var h = ['<div class="hrs" role="img" aria-label="Pedidos creados por hora del día">'];
    por.forEach(function (v, i) {
      h.push('<div class="hrs__col" title="' + i + ':00 · ' + v + ' pedidos"><div class="hrs__fill' + (v === max && v ? ' is-peak' : '') + '" style="height:' + Math.max(3, (v / max) * 100) + '%"></div>' +
        '<span>' + (i % 3 === 0 ? i : '') + '</span></div>');
    });
    h.push('</div>');
    return h.join('');
  }
  function dows(por) {
    var names = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
    var max = Math.max.apply(null, por.concat([1]));
    var h = ['<ul class="dow">'];
    por.forEach(function (v, i) {
      h.push('<li><span>' + names[i] + '</span><div class="meter"><i style="width:' + Math.max(2, (v / max) * 100) + '%"></i></div><b>' + v + '</b></li>');
    });
    h.push('</ul>');
    return h.join('');
  }

  /* -------------------------------------------------------- lectura automática */

  function insights(a) {
    var out = [], k = a.kpis, por = a.por, total = por.servicio.reduce(function (s, r) { return s + r.pedidos; }, 0);
    if (total < 3) return ['Todavía hay pocos pedidos para sacar conclusiones. Con 10 o más empiezan a aparecer patrones.'];
    var cobradoTot = por.origen.reduce(function (s, r) { return s + r.cobrado; }, 0) || 1;
    var o = por.origen.filter(function (r) { return r.k !== 'sin dato'; })[0];
    if (o && o.cobrado) out.push('<b>' + esc(o.k) + '</b> es la fuente que más deja: ' + Math.round((o.cobrado / cobradoTot) * 100) + '% de lo cobrado (' + o.pedidos + ' pedidos, ticket ' + money(o.ticket) + ').');
    var ph = a.cuando.por_hora, noche = 0, sum = ph.reduce(function (x, y) { return x + y; }, 0) || 1;
    [20, 21, 22, 23, 0, 1].forEach(function (h) { noche += ph[h]; });
    var peak = ph.indexOf(Math.max.apply(null, ph));
    out.push('El ' + Math.round((noche / sum) * 100) + '% de los pedidos se crea entre 8 pm y 2 am; la hora pico es la de las ' + peak + ':00. Ahí conviene que el agente conteste lo más rápido.');
    var avg = k.ticket_promedio || 1;
    var nv = por.nivel.filter(function (r) { return r.k !== 'sin dato' && r.pedidos >= 2; }).sort(function (x, y) { return y.ticket - x.ticket; })[0];
    if (nv && nv.ticket > avg * 1.15) out.push('Los clientes de <b>' + esc(nv.k) + '</b> pagan más por pedido: ' + money(nv.ticket) + ' contra un promedio de ' + money(avg) + '.');
    var sv = por.servicio[0];
    if (sv) out.push('<b>' + esc(sv.k) + '</b> es el servicio que más ingresa (' + money(sv.cobrado) + ', ' + sv.pedidos + ' pedidos).');
    var lento = por.servicio.filter(function (r) { return r.ciclo_dias != null; }).sort(function (x, y) { return y.ciclo_dias - x.ciclo_dias; })[0];
    if (lento && lento.ciclo_dias > 4) out.push('<b>' + esc(lento.k) + '</b> tarda ' + n1(lento.ciclo_dias) + ' días en entregarse: es el cuello de botella.');
    var t = a.tiempos;
    if (t.respuesta_mediana_min != null) out.push(t.respuesta_mediana_min <= 5 ? 'El agente responde en una mediana de ' + minutes(t.respuesta_mediana_min) + '. Va bien.' : 'La respuesta tarda una mediana de ' + minutes(t.respuesta_mediana_min) + '. Un cliente que cotiza de noche no espera tanto.');
    var f = a.embudo, caidas = [['consulta a precio acordado', f.contactos, f.cotizados], ['precio acordado a anticipo', f.cotizados, f.confirmados], ['anticipo a entrega', f.confirmados, f.entregados]]
      .filter(function (c) { return c[1] >= 3; }).sort(function (x, y) { return (y[1] - y[2]) / y[1] - (x[1] - x[2]) / x[1]; })[0];
    if (caidas && caidas[2] < caidas[1]) out.push('Donde más se pierde es de ' + caidas[0] + ': ' + Math.round(((caidas[1] - caidas[2]) / caidas[1]) * 100) + '% no avanza.');
    if (k.por_cobrar > 0) out.push('Hay ' + money(k.por_cobrar) + ' entregados sin cobrar. Revisa la lista de por cobrar.');
    if (k.tasa_recurrencia) out.push(k.tasa_recurrencia + '% de tus clientes ya repitió: la recompra es la forma más barata de crecer.');
    return out.slice(0, 7);
  }

  /* ----------------------------------------------------------------- ANÁLISIS */

  function renderAnalisis(a) {
    last = a;
    var k = a.kpis, t = a.tiempos, w = a.web;
    var delta = k.cobrado_mes_anterior ? Math.round(((k.cobrado_mes - k.cobrado_mes_anterior) / k.cobrado_mes_anterior) * 100) : null;
    var periodBtns = '<div class="seg--pills" role="group" aria-label="Periodo">' +
      [[30, '30 d'], [90, '90 d'], [365, '1 año'], [0, 'Todo']].map(function (p) {
        return '<button type="button" data-days="' + p[0] + '"' + (st.days === p[0] ? ' aria-pressed="true"' : '') + '>' + p[1] + '</button>';
      }).join('') + '</div>';

    var h = [];
    h.push(head('Análisis', k.pedidos_total + ' pedidos', '', periodBtns));

    h.push('<div class="stats">' +
      stat('Cobrado este mes', money(k.cobrado_mes), 'ok', delta == null ? '' : (delta >= 0 ? '+' : '') + delta + '% vs mes anterior') +
      stat('Por cobrar', money(k.por_cobrar), k.por_cobrar ? 'hot' : '', k.por_cobrar ? 'entregado sin liquidar' : 'al día') +
      stat('Ticket promedio', money(k.ticket_promedio), '', k.clientes_total + ' clientes') +
      stat('Conversión', Math.round(k.conversion_contacto_a_pago) + '%', '', 'consulta a pago') +
      '</div>');

    var ins = insights(a).slice(0, 3);
    h.push(section('Resumen clave', '<ul class="insights">' + ins.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul>'));

    h.push(section('Ingresos',
      '<div class="card"><div class="ana-controls"><div class="seg--pills" role="group" aria-label="Escala">' +
      [['dias', '30 días'], ['semanas', 'Semanas'], ['meses', '12 meses']].map(function (s) {
        return '<button type="button" data-serie="' + s[0] + '"' + (st.serie === s[0] ? ' aria-pressed="true"' : '') + '>' + s[1] + '</button>';
      }).join('') + '</div></div>' + bars(a.serie[st.serie], 'ingresos', 'Ingresos cobrados') + '</div>'));

    var lista = a.por_cobrar_lista.length ? '<ul class="rows">' + a.por_cobrar_lista.map(function (r) {
      return '<li class="row"><div class="row__main"><p class="row__title">' + esc(r.cliente) + '</p><div class="row__meta">Pedido #' + r.pedido +
        (r.dias != null ? ' · hace ' + r.dias + ' d' : '') + '</div></div><div class="row__amount">' + money(r.saldo) + '</div></li>';
    }).join('') + '</ul>' : '<p class="muted" style="margin:0">Sin saldos pendientes.</p>';

    var mejores = a.mejores_clientes.length ? '<ul class="rows">' + a.mejores_clientes.slice(0, 6).map(function (r) {
      return '<li class="row"><div class="row__main"><p class="row__title">' + esc(r.cliente) + '</p><div class="row__meta">' + r.pedidos + ' pedido' + (r.pedidos === 1 ? '' : 's') +
        (r.institucion ? ' · ' + esc(r.institucion) : '') + '</div></div><div class="row__amount">' + money(r.cobrado) + '</div></li>';
    }).join('') + '</ul>' : '<p class="muted" style="margin:0">Aún sin pagos.</p>';

    h.push('<div class="section"><div class="grid grid--2"><div><div class="section__head"><h2>Por cobrar</h2></div>' + lista + '</div><div><div class="section__head"><h2>Mejores clientes</h2></div>' + mejores + '</div></div></div>');

    h.push('<details class="fold"><summary>Embudo y desglose por servicio y origen</summary><div class="fold__body">' +
      '<div style="margin-bottom:20px">' + funnel(a.embudo) + '</div>' +
      '<div class="grid">' + breakdown('Por servicio', a.por.servicio) + breakdown('Por origen', a.por.origen) + breakdown('Por nivel', a.por.nivel) + '</div></div></details>');

    h.push('<details class="fold"><summary>Horarios, tiempos de respuesta y web</summary><div class="fold__body">' +
      '<div class="stats" style="margin-bottom:18px">' +
      stat('Respuesta agente', minutes(t.respuesta_mediana_min), '', 'mediana') +
      stat('Pedido a pago', t.creacion_a_pago_horas == null ? '–' : (t.creacion_a_pago_horas >= 48 ? n1(t.creacion_a_pago_horas / 24) + ' d' : n1(t.creacion_a_pago_horas) + ' h'), '', 'mediana') +
      stat('Visitas web (14 d)', String(w.visitas), '', w.clics + ' clics a WA') + '</div>' +
      '<div class="grid grid--2"><div class="card"><h3>Por hora</h3>' + hours(a.cuando.por_hora) + '</div>' +
      '<div class="card"><h3>Por día</h3>' + dows(a.cuando.por_dia_semana) + '</div></div></div></details>');

    root.innerHTML = h.join('');

    Array.prototype.forEach.call(root.querySelectorAll('[data-days]'), function (b) {
      b.addEventListener('click', function () { st.days = Number(b.getAttribute('data-days')); loadAnalisis(); });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-serie]'), function (b) {
      b.addEventListener('click', function () { st.serie = b.getAttribute('data-serie'); renderAnalisis(last); });
    });
  }

  function loadAnalisis() {
    api('/api/analytics?days=' + st.days).then(function (a) { if (root && viewName === 'analisis') renderAnalisis(a); })
      .catch(function (e) { if (root) root.innerHTML = '<div class="empty"><strong>No pude cargar el análisis.</strong>' + esc(e.message) + '</div>'; });
  }

  /* ----------------------------------------------------------------- WHATSAPP */

  var WA_LABEL = { ready: ['Conectado', 'ok'], 'esperando-qr': ['Falta escanear el QR', 'bad'], iniciando: ['Iniciando', ''], autenticado: ['Autenticando', ''], desconectado: ['Desconectado', 'bad'], 'fallo-auth': ['Falló la autenticación', 'bad'], starting: ['Iniciando', ''] };

  function renderInbox(d) {
    var wa = WA_LABEL[d.wa] || [d.wa, ''];
    var h = [];
    h.push(head('WhatsApp', wa[0] + ' · ' + (d.pausado ? 'agente pausado' : 'agente activo'), '',
      '<button type="button" class="btn ' + (d.pausado ? 'btn--solid' : 'btn--ghost') + ' btn--sm" id="togglePause">' + (d.pausado ? 'Reanudar agente' : 'Pausar agente') + '</button>'));

    if (d.pendientes.length) {
      h.push(section('Necesitan tu decisión', '<ul class="rows">' + d.pendientes.map(function (p) {
        return '<li class="row" data-pend="' + p.id + '"><div class="row__main"><p class="row__title">PENDIENTE #' + p.id + ' · ' + esc(p.cliente) + '</p><div class="row__meta">' + esc(p.motivo) + ' · ' + ago(p.ts) + '</div>' +
          (p.borrador ? '<p class="draft">' + esc(p.borrador) + '</p>' : '') +
          '<div class="pend-edit" hidden><textarea class="kn" style="min-height:90px;margin-top:10px">' + esc(p.borrador || '') + '</textarea>' +
          '<div class="row__actions" style="margin-top:8px"><button type="button" class="btn btn--wa btn--sm" data-p-send="' + p.id + '">Enviar editado</button>' +
          '<button type="button" class="btn btn--quiet btn--sm" data-p-cancel="' + p.id + '">Cancelar</button></div></div></div>' +
          '<div class="row__actions">' +
          (p.borrador ? '<button type="button" class="btn btn--wa btn--sm" data-p-ok="' + p.id + '">Aprobar y enviar</button>' : '') +
          '<button type="button" class="btn btn--ghost btn--sm" data-p-edit="' + p.id + '">Editar</button>' +
          '<button type="button" class="btn btn--quiet btn--sm" data-p-no="' + p.id + '">Descartar</button></div></li>';
      }).join('') + '</ul>'));
    }

    var conv = d.conversaciones.length ? '<ul class="rows">' + d.conversaciones.map(function (c) {
      return '<li class="row"><div class="row__main"><p class="row__title">' + esc(c.name) + (c.esperando ? ' <span class="chip chip--late">espera respuesta</span>' : '') + '</p>' +
        '<div class="row__meta">' + (c.institucion ? esc(c.institucion) + ' · ' : '') + (c.nivel ? esc(c.nivel) + ' · ' : '') + ago(c.last.ts) +
        (c.pedido ? ' · pedido #' + c.pedido.id + ' ' + esc(c.pedido.estado) + (c.pedido.estado === 'nuevo' ? '/' + esc(c.pedido.etapa) : '') : '') + '</div>' +
        '<p class="draft">' + (c.last.dir === 'in' ? '' : (c.last.by === 'dueno' ? 'Tú: ' : 'Agente: ')) + esc(c.last.body) + '</p></div>' +
        '<div class="row__actions">' +
        (c.esperando ? '<button type="button" class="btn btn--ghost btn--sm" data-att="' + esc(c.id) + '">Atendido</button>' : '') +
        '<button type="button" class="btn btn--wa btn--sm" data-conv="' + esc(c.id) + '">Abrir chat</button></div></li>';
    }).join('') + '</ul>' : '<div class="empty"><strong>Todavía no hay conversaciones.</strong>Aparecerán aquí en cuanto un cliente escriba al número de Relevo.</div>';
    h.push(section('Conversaciones recientes', conv));
    root.innerHTML = h.join('');

    var tp = root.querySelector('#togglePause');
    if (tp) tp.addEventListener('click', function () {
      api('/api/agent/' + (d.pausado ? 'resume' : 'pause'), { method: 'POST' }).then(loadInbox);
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-p-ok]'), function (b) {
      b.addEventListener('click', function () {
        b.disabled = true; b.textContent = 'Enviando…';
        api('/api/inbox/pending/' + b.getAttribute('data-p-ok') + '/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then(loadInbox).catch(function (e) { b.disabled = false; window.alert(e.message); });
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-p-edit]'), function (b) {
      b.addEventListener('click', function () {
        var row = b.closest('.row');
        var ed = row && row.querySelector('.pend-edit');
        if (ed) ed.hidden = !ed.hidden;
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-p-cancel]'), function (b) {
      b.addEventListener('click', function () {
        var ed = b.closest('.pend-edit');
        if (ed) ed.hidden = true;
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-p-send]'), function (b) {
      b.addEventListener('click', function () {
        var row = b.closest('.row');
        var ta = row && row.querySelector('.pend-edit textarea');
        b.disabled = true; b.textContent = 'Enviando…';
        api('/api/inbox/pending/' + b.getAttribute('data-p-send') + '/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: ta ? ta.value : '' }) })
          .then(loadInbox).catch(function (e) { b.disabled = false; window.alert(e.message); });
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-p-no]'), function (b) {
      b.addEventListener('click', function () {
        b.disabled = true;
        api('/api/inbox/pending/' + b.getAttribute('data-p-no') + '/close', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'descartado' }) })
          .then(loadInbox).catch(function (e) { b.disabled = false; window.alert(e.message); });
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-att]'), function (b) {
      b.addEventListener('click', function () {
        b.disabled = true;
        api('/api/inbox/attended/' + encodeURIComponent(b.getAttribute('data-att')), { method: 'POST' })
          .then(loadInbox).catch(function (e) { b.disabled = false; window.alert(e.message); });
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-conv]'), function (b) {
      b.addEventListener('click', function () { conversation(b.getAttribute('data-conv'), helpers); });
    });
  }
  function loadInbox() {
    api('/api/inbox').then(function (d) { if (root && viewName === 'whatsapp') renderInbox(d); })
      .catch(function (e) { if (root) root.innerHTML = '<div class="empty"><strong>No pude cargar la bandeja.</strong>' + esc(e.message) + '</div>'; });
  }

  function conversation(id, hp) {
    var open = (hp && hp.openSheet) || helpers.openSheet;
    api('/api/conversation/' + encodeURIComponent(id)).then(function (d) {
      var h = ['<div class="sheet__head"><h2 id="sheetTitle">' + esc(d.cliente.name || d.cliente.phone) + '</h2>' +
        '<button type="button" class="btn btn--quiet btn--sm" data-act="close" style="margin-left:auto">Cerrar</button></div><div class="sheet__body">'];
      h.push('<p class="field__hint" style="margin-top:0">' + [d.cliente.phone, d.cliente.institucion, d.cliente.nivel, d.cliente.origen && 'llegó por ' + d.cliente.origen].filter(Boolean).map(esc).join(' · ') + '</p>');
      h.push('<div class="chat" id="chatThread">' + (d.mensajes.length ? d.mensajes.map(function (m) {
        var who = m.dir === 'in' ? '' : (m.by === 'dueno' ? 'Tú' : 'Agente');
        return '<div class="bubble bubble--' + (m.dir === 'in' ? 'in' : 'out') + '">' + (who ? '<span class="bubble__who">' + who + '</span>' : '') + esc(m.body).replace(/\n/g, '<br>') +
          (m.adjunto ? ' <em>[archivo]</em>' : '') + '<span class="bubble__t">' + new Date(m.ts).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + '</span></div>';
      }).join('') : '<p class="muted">Sin mensajes.</p>') + '</div>');
      h.push('<form class="reply-box" id="waReplyForm">' +
        '<textarea id="waReplyText" rows="2" placeholder="Responder directo por WhatsApp (se aplica tono Relevo)…"></textarea>' +
        '<div class="row__actions">' +
        '<button type="button" class="btn btn--ghost btn--sm" id="waMarkAtt">Marcar atendido</button>' +
        '<button type="submit" class="btn btn--wa btn--sm" id="waSendBtn">Enviar por WhatsApp</button>' +
        '</div></form></div>');
      open(h.join(''));
      var thread = document.getElementById('chatThread');
      if (thread) thread.scrollTop = thread.scrollHeight;
      var form = document.getElementById('waReplyForm');
      if (form) form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var ta = document.getElementById('waReplyText'), btn = document.getElementById('waSendBtn');
        var txt = (ta.value || '').trim(); if (!txt) return;
        btn.disabled = true; btn.textContent = 'Enviando…';
        api('/api/inbox/reply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: id, text: txt }) })
          .then(function () {
            conversation(id, hp);
            if (viewName === 'whatsapp') loadInbox();
          }).catch(function (e) { btn.disabled = false; btn.textContent = 'Enviar por WhatsApp'; window.alert('No se pudo enviar: ' + e.message); });
      });
      var attBtn = document.getElementById('waMarkAtt');
      if (attBtn) attBtn.addEventListener('click', function () {
        attBtn.disabled = true;
        api('/api/inbox/attended/' + encodeURIComponent(id), { method: 'POST' })
          .then(function () { attBtn.textContent = 'Marcado'; if (viewName === 'whatsapp') loadInbox(); })
          .catch(function (e) { attBtn.disabled = false; window.alert(e.message); });
      });
    }).catch(function (e) { window.alert('No pude abrir la conversación: ' + e.message); });
  }


  /* ------------------------------------------------------------------ SISTEMA */

  var sys = { data: null, know: null, msg: '' };

  function control(it, v) {
    var id = ' data-k="' + esc(it.k) + '"';
    if (it.type === 'bool') return '<label class="check"><input type="checkbox"' + id + (v ? ' checked' : '') + '><span>' + (v ? 'Activado' : 'Desactivado') + '</span></label>';
    if (it.type === 'select') return '<select' + id + '>' + it.options.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === v ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
    if (it.type === 'number') return '<input type="number"' + id + ' value="' + esc(v) + '"' + (it.min !== undefined ? ' min="' + it.min + '"' : '') + (it.max !== undefined ? ' max="' + it.max + '"' : '') + '>';
    return '<input type="text"' + id + ' value="' + esc(v) + '" maxlength="200">';
  }

  function flag(v, yes, no) { return '<span class="' + (v ? 'is-ok' : 'is-bad') + '">' + (v ? yes : no) + '</span>'; }

  function renderSistema(d, know, soc) {
    sys.data = d; sys.know = know;
    var s = d.status, v = d.values, h = [];
    h.push(head('Sistema', s.harness_chat + ' · ' + (s.uptime_min >= 90 ? n1(s.uptime_min / 60) + ' h activo' : s.uptime_min + ' min activo'), '',
      '<button type="button" class="btn btn--ghost btn--sm" id="sysPause">' + (s.pausado ? 'Reanudar agente' : 'Pausar agente') + '</button>' +
      '<button type="button" class="btn btn--quiet btn--sm" id="sysRestart">Reiniciar</button>'));
    if (sys.msg) h.push('<p class="sysmsg">' + esc(sys.msg) + '</p>');

    h.push('<div class="stats">' +
      stat('WhatsApp', s.wa === 'ready' ? 'Conectado' : s.wa, s.wa === 'ready' ? 'ok' : 'bad', '') +
      stat('Agente', s.pausado ? 'Pausado' : 'Activo', s.pausado ? 'bad' : 'ok', s.harness_chat) +
      stat('Telegram', s.telegram.dueno_vinculado ? 'Vinculado' : 'Sin vincular', s.telegram.dueno_vinculado ? 'ok' : 'bad', '') +
      stat('Base de datos', s.datos.clientes + ' / ' + s.datos.pedidos, '', 'clientes / pedidos') +
      '</div>');

    h.push('<details class="fold" open><summary>Conocimiento del agente (Obsidian)</summary><div class="fold__body">' +
      '<div class="field"><label for="knSel">Documento</label><select id="knSel">' + know.map(function (k) { return '<option value="' + esc(k.key) + '">' + esc(k.title) + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><textarea id="knText" class="kn" rows="14" spellcheck="false" placeholder="Cargando…"></textarea></div>' +
      '<div class="row__actions" style="justify-content:flex-start"><button type="button" class="btn btn--solid btn--sm" id="knSave">Guardar documento</button><span class="muted" id="knMsg"></span></div></div></details>');

    d.schema.forEach(function (g) {
      h.push('<details class="fold section" data-group="' + esc(g.group) + '" style="margin-bottom:14px"><summary>' + esc(g.title) + '</summary><div class="fold__body">' +
        '<div class="fields">' +
        g.items.map(function (it) {
          return '<div class="field"><label>' + esc(it.label) + '</label>' + control(it, v[it.k]) + (it.help ? '<p class="field__hint">' + esc(it.help) + '</p>' : '') + '</div>';
        }).join('') + '</div><div class="row__actions" style="justify-content:flex-start"><button type="button" class="btn btn--solid btn--sm" data-save="' + esc(g.group) + '">Guardar sección</button></div></div></details>');
    });

    if (soc && soc.redes) {
      h.push('<details class="fold"><summary>Redes sociales (' + (soc.chrome ? 'navegador activo' : 'apagado') + ')</summary><div class="fold__body">' +
        '<div class="fields">' +
        soc.redes.map(function (r) {
          return '<div class="field" data-net="' + esc(r.key) + '"><label>' + esc(r.name) + '</label>' +
            '<input type="text" data-f="user" value="' + esc(r.user) + '" placeholder="usuario" maxlength="40">' +
            '<select data-f="status">' + soc.status_options.map(function (o) { return '<option' + (o === r.status ? ' selected' : '') + '>' + o + '</option>'; }).join('') + '</select>' +
            '<input type="text" data-f="note" value="' + esc(r.note) + '" placeholder="nota" maxlength="300"></div>';
        }).join('') + '</div><div class="row__actions" style="justify-content:flex-start"><button type="button" class="btn btn--solid btn--sm" id="socSave">Guardar redes</button><span class="muted" id="socMsg"></span></div></div></details>');
    }

    h.push('<details class="fold"><summary>Diagnóstico y prueba de modelos</summary><div class="fold__body">' +
      '<div class="tests">' + [['agy', 'Antigravity'], ['opencode', 'OpenCode'], ['claude', 'Claude Code'], ['api', 'API Anthropic']].map(function (x) {
        return '<div class="test"><button type="button" class="btn btn--ghost btn--sm" data-test="' + x[0] + '">Probar ' + x[1] + '</button><span class="test__out muted" id="t-' + x[0] + '">sin probar</span></div>';
      }).join('') + '</div></div></details>');

    root.innerHTML = h.join('');
    bindSistema();
    var sb = root.querySelector('#socSave');
    if (sb) sb.addEventListener('click', function () {
      var body = {}; root.querySelectorAll('[data-net]').forEach(function (b) { var o = {}; b.querySelectorAll('[data-f]').forEach(function (f) { o[f.getAttribute('data-f')] = f.value; }); body[b.getAttribute('data-net')] = o; });
      api('/api/social', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redes: body }) })
        .then(function () { root.querySelector('#socMsg').textContent = 'Guardado.'; }).catch(function (e) { root.querySelector('#socMsg').textContent = e.message; });
    });
    loadKnowledge(root.querySelector('#knSel').value);
  }

  function bindSistema() {
    Array.prototype.forEach.call(root.querySelectorAll('[data-save]'), function (b) {
      b.addEventListener('click', function () {
        var card = b.closest('.section'), vals = {};
        Array.prototype.forEach.call(card.querySelectorAll('[data-k]'), function (el) { vals[el.getAttribute('data-k')] = el.type === 'checkbox' ? el.checked : el.value; });
        b.disabled = true;
        api('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values: vals }) })
          .then(function () { sys.msg = 'Guardado. Aplica desde el siguiente mensaje.'; loadSistema(); })
          .catch(function (e) { b.disabled = false; window.alert('No se guardó: ' + e.message); });
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-test]'), function (b) {
      b.addEventListener('click', function () {
        var hname = b.getAttribute('data-test'), out = root.querySelector('#t-' + hname);
        out.className = 'test__out muted'; out.textContent = 'probando…'; b.disabled = true;
        api('/api/system/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ harness: hname }) })
          .then(function (r) {
            out.className = 'test__out ' + (r.ok ? 'is-ok' : 'is-bad');
            out.textContent = r.ok ? 'funciona · ' + (r.ms / 1000).toFixed(1) + ' s · ' + r.model + ' · "' + r.text + '"' : 'falló · ' + r.error;
          }).catch(function (e) { out.className = 'test__out is-bad'; out.textContent = 'error · ' + e.message; })
          .then(function () { b.disabled = false; });
      });
    });
    var p = root.querySelector('#sysPause');
    if (p) p.addEventListener('click', function () { api('/api/agent/' + (sys.data.status.pausado ? 'resume' : 'pause'), { method: 'POST' }).then(loadSistema); });
    var r = root.querySelector('#sysRestart');
    if (r) r.addEventListener('click', function () {
      if (!window.confirm('Reiniciar al agente. WhatsApp se reconecta solo en unos segundos. ¿Seguir?')) return;
      api('/api/system/restart', { method: 'POST' }).then(function () { sys.msg = 'Reiniciando… se recarga solo en unos segundos.'; window.setTimeout(loadSistema, 14000); });
    });
    var sel = root.querySelector('#knSel');
    if (sel) sel.addEventListener('change', function () { loadKnowledge(sel.value); });
    var ks = root.querySelector('#knSave');
    if (ks) ks.addEventListener('click', function () {
      var key = root.querySelector('#knSel').value, msg = root.querySelector('#knMsg');
      api('/api/knowledge/' + key, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: root.querySelector('#knText').value }) })
        .then(function () { msg.textContent = 'Guardado. El agente lo usa desde el siguiente mensaje.'; })
        .catch(function (e) { msg.textContent = 'No se guardó: ' + e.message; });
    });
  }

  function loadKnowledge(key) {
    var ta = root && root.querySelector('#knText'); if (!ta) return;
    ta.value = ''; ta.placeholder = 'Cargando…';
    api('/api/knowledge/' + key).then(function (k) { if (root && root.querySelector('#knText')) { ta.value = k.text; ta.placeholder = '(vacío)'; } });
  }

  function loadSistema() {
    Promise.all([api('/api/settings'), api('/api/knowledge'), api('/api/social').catch(function () { return null; })]).then(function (r) { if (root && viewName === 'sistema') renderSistema(r[0], r[1], r[2]); })
      .catch(function (e) { if (root) root.innerHTML = '<div class="empty"><strong>No pude cargar el sistema.</strong>' + esc(e.message) + '</div>'; });
  }

  /* ------------------------------------------------------------------- CURSOS */

  function renderCourses(d) {
    var jobs = d.jobs || [];
    var h = [];
    h.push(head('Cursos', jobs.length + (jobs.length === 1 ? ' activo' : ' activos'), '',
      '<a class="btn btn--ghost btn--sm" href="' + esc(d.novnc || '#') + '" target="_blank" rel="noopener">Escritorio remoto ↗</a>'));

    if (!jobs.length) {
      h.push('<div class="empty"><strong>Sin cursos registrados.</strong>Cuando configures uno aparecerá aquí.</div>');
    } else {
      jobs.forEach(function (j) {
        var tone = /complet|listo|termin/i.test(j.status) ? 'pagado' : (/paus|esper/i.test(j.status) ? 'proceso' : 'nuevo');
        h.push('<div class="card" style="margin-bottom:16px" data-course="' + j.order_id + '">' +
          '<div class="bk__top" style="margin-bottom:14px"><h3 style="margin:0">' + esc(j.client_name) + ' · Pedido #' + j.order_id + '</h3>' +
          '<span class="chip chip--' + tone + '">' + esc(j.status) + '</span></div>' +
          '<ul class="kvl" style="margin-bottom:16px">' +
          '<li><span>Paso actual</span><b>' + esc(j.step || '—') + '</b></li>' +
          (j.last_error ? '<li><span>Aviso</span><b class="is-bad">' + esc(j.last_error) + '</b></li>' : '') +
          '<li><span>Plataformas</span><b>' + esc((j.targets || []).map(function (t) { return t.name; }).join(' · ') || '—') + '</b></li></ul>' +
          '<div class="row__actions" style="justify-content:flex-start;margin-bottom:14px">' +
          '<button type="button" class="btn btn--solid btn--sm" data-c-act="resume" data-oid="' + j.order_id + '">Revisar</button>' +
          '<button type="button" class="btn btn--wa btn--sm" data-c-act="run" data-oid="' + j.order_id + '">Ejecutar módulos</button>' +
          '<button type="button" class="btn btn--ghost btn--sm" data-c-act="stop" data-oid="' + j.order_id + '">Pausar</button></div>' +
          '<details class="paste" style="margin-bottom:0"><summary>Credenciales y estado (' + esc(j.email || 'sin correo') + ')</summary>' +
          '<div class="fields" style="margin-top:10px">' +
          '<div class="field"><label>Correo</label><input type="text" data-cf="email" value="' + esc(j.email) + '"></div>' +
          '<div class="field"><label>CURP</label><input type="text" data-cf="curp" value="' + esc(j.curp) + '"></div>' +
          '<div class="field"><label>Nueva contraseña SiESABI</label><input type="text" data-cf="siesabi_pass" placeholder="conservar actual"></div>' +
          '<div class="field"><label>Nueva contraseña OPS</label><input type="text" data-cf="ops_pass" placeholder="conservar actual"></div>' +
          '<div class="field"><label>Estado</label><input type="text" data-cf="status" value="' + esc(j.status) + '"></div>' +
          '<div class="field"><label>Nota / paso</label><input type="text" data-cf="step" value="' + esc(j.step) + '"></div></div>' +
          '<button type="button" class="btn btn--solid btn--sm" data-c-save="' + j.order_id + '">Guardar cambios</button>' +
          '<span class="muted" style="margin-left:10px" data-c-msg="' + j.order_id + '"></span></details></div>');
      });
    }
    root.innerHTML = h.join('');

    Array.prototype.forEach.call(root.querySelectorAll('[data-c-act]'), function (b) {
      b.addEventListener('click', function () {
        var oid = b.getAttribute('data-oid'), act = b.getAttribute('data-c-act');
        b.disabled = true;
        api('/api/courses/' + oid + '/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: act }) })
          .then(function (r) { window.alert(r.msg || 'Listo.'); loadCourses(); })
          .catch(function (e) { b.disabled = false; window.alert(e.message); });
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-c-save]'), function (b) {
      b.addEventListener('click', function () {
        var oid = b.getAttribute('data-c-save');
        var card = b.closest('[data-course]');
        var body = { clear_error: true };
        Array.prototype.forEach.call(card.querySelectorAll('[data-cf]'), function (inp) {
          if (inp.value.trim() !== '') body[inp.getAttribute('data-cf')] = inp.value.trim();
        });
        b.disabled = true;
        api('/api/courses/' + oid + '/update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
          .then(function () { loadCourses(); })
          .catch(function (e) { b.disabled = false; window.alert(e.message); });
      });
    });
  }

  function loadCourses() {
    api('/api/courses').then(function (d) { if (root && viewName === 'cursos') renderCourses(d); })
      .catch(function (e) { if (root) root.innerHTML = '<div class="empty"><strong>No pude cargar cursos.</strong>' + esc(e.message) + '</div>'; });
  }

  /* ------------------------------------------------------------------- MI CMS */

  var cmsSt = { tab: 'notas', selected: null, data: null, revealedToken: '', msg: '' };

  function fmtSize(bytes) {
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    return Math.round(bytes / 1024) + ' KB';
  }

  function renderCms(d) {
    cmsSt.data = d;
    var tabNav = '<div class="seg--pills" role="group" aria-label="Secciones CMS">' +
      [['notas', 'Notas'], ['sitio', 'Sitio y archivos'], ['api', 'API CMS']].map(function (t) {
        return '<button type="button" data-cms-tab="' + t[0] + '" aria-pressed="' + (cmsSt.tab === t[0] ? 'true' : 'false') + '">' + t[1] + '</button>';
      }).join('') + '</div>';
    var h = [];
    h.push(head('Mi CMS', '', '', tabNav));
    if (cmsSt.msg) h.push('<p class="sysmsg">' + esc(cmsSt.msg) + '</p>');

    if (cmsSt.tab === 'notas') {
      var notes = d.notes || [];
      var cur = notes.find(function (n) { return n.slug === cmsSt.selected; }) || (cmsSt.selected === '__new__' ? { slug: '', title: '', category: 'general', status: 'borrador', tags: [], body: '' } : notes[0]) || { slug: '', title: '', category: 'general', status: 'borrador', tags: [], body: '' };
      if (!cmsSt.selected && cur.slug) cmsSt.selected = cur.slug;
      h.push('<div class="cms-grid">' +
        '<div class="card"><div class="bk__top" style="margin-bottom:12px"><h3 style="margin:0">Entradas (' + notes.length + ')</h3>' +
        '<button type="button" class="btn btn--solid btn--sm" id="cmsNew">+ Nueva</button></div>' +
        '<div class="cms-list">' + (notes.length ? notes.map(function (n) {
          var active = cur.slug && n.slug === cur.slug;
          var chipCls = n.status === 'publicado' ? 'pagado' : (n.status === 'privado' ? 'nuevo' : 'proceso');
          return '<button type="button" class="cms-item' + (active ? ' is-active' : '') + '" data-cms-note="' + esc(n.slug) + '">' +
            '<strong>' + esc(n.title) + '</strong>' +
            '<span><span class="chip chip--' + chipCls + '">' + esc(n.status) + '</span> · ' + esc(n.category) + '</span></button>';
        }).join('') : '<p class="muted">Sin entradas aún.</p>') + '</div></div>' +
        '<div class="card"><h3 style="margin-top:0">' + (cur.slug ? 'Editar entrada' : 'Nueva entrada') + '</h3>' +
        '<div class="grid2"><div class="field"><label>Título</label><input type="text" id="cmsTitle" value="' + esc(cur.title) + '" placeholder="Ej. Promociones de cierre de semestre"></div>' +
        '<div class="field"><label>Slug (URL)</label><input type="text" id="cmsSlug" value="' + esc(cur.slug) + '" placeholder="auto-desde-titulo"' + (cur.slug ? ' readonly' : '') + '></div></div>' +
        '<div class="grid2"><div class="field"><label>Categoría</label><input type="text" id="cmsCat" value="' + esc(cur.category) + '" placeholder="general, campañas, guiones, blog"></div>' +
        '<div class="field"><label>Visibilidad</label><select id="cmsStatus">' +
        [['privado', 'Privado (solo tú y API Key)'], ['borrador', 'Borrador'], ['publicado', 'Publicado (visible en /api/cms/public)']].map(function (o) {
          return '<option value="' + o[0] + '"' + (cur.status === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
        }).join('') + '</select></div></div>' +
        '<div class="field"><label>Etiquetas (separadas por coma)</label><input type="text" id="cmsTags" value="' + esc((cur.tags || []).join(', ')) + '" placeholder="relevo, up, promos"></div>' +
        '<div class="field"><label>Contenido (Markdown)</label><textarea id="cmsBody" class="kn" style="min-height:240px">' + esc(cur.body || '') + '</textarea></div>' +
        '<div class="row__actions" style="justify-content:flex-start">' +
        '<button type="button" class="btn btn--solid" id="cmsSaveNote">Guardar entrada</button>' +
        (cur.slug ? '<button type="button" class="btn btn--quiet" style="color:var(--bad)" id="cmsDelNote" data-del="' + esc(cur.slug) + '">Eliminar</button>' : '') +
        '</div></div></div>');
    } else if (cmsSt.tab === 'sitio') {
      var s = d.site || {};
      var media = d.media || [];
      h.push('<div class="section"><div class="section__head"><h2>Configuración de contenido (Feed CMS)</h2></div><div class="card">' +
        '<p class="field__hint" style="margin-top:0">Estos campos se publican en vivo en <a href="/api/cms/public" target="_blank" rel="noopener" class="mono">/api/cms/public</a> para consumirlos desde cualquier página o CMS externo.</p>' +
        '<div class="fields">' +
        '<div class="field"><label>Nombre del negocio</label><input type="text" data-sf="negocio" value="' + esc(s.negocio || '') + '"></div>' +
        '<div class="field"><label>Frase principal (tagline)</label><input type="text" data-sf="tagline" value="' + esc(s.tagline || '') + '"></div>' +
        '<div class="field"><label>Banner / aviso promocional</label><input type="text" data-sf="aviso_banner" value="' + esc(s.aviso_banner || '') + '"></div>' +
        '<div class="field"><label>Código de descuento</label><input type="text" data-sf="codigo_promo" value="' + esc(s.codigo_promo || '') + '"></div>' +
        '<div class="field"><label>Descuento (%)</label><input type="number" data-sf="descuento_pct" value="' + esc(s.descuento_pct || 0) + '"></div>' +
        '<div class="field"><label>Resumen de precios</label><input type="text" data-sf="precios_resumen" value="' + esc(s.precios_resumen || '') + '"></div>' +
        '<div class="field"><label>Promo activa</label><label class="check"><input type="checkbox" data-sf="promo_activa"' + (s.promo_activa ? ' checked' : '') + '><span>Activa en el feed público</span></label></div></div>' +
        '<div class="row__actions" style="justify-content:flex-start"><button type="button" class="btn btn--solid btn--sm" id="cmsSaveSite">Guardar configuración</button></div></div></div>');

      h.push('<div class="section"><div class="section__head"><h2>Biblioteca de flyers y videos (' + media.length + ')</h2></div>' +
        '<div class="media-grid">' + media.map(function (m) {
          return '<div class="media-item"><span class="chip chip--' + (m.folder === 'videos' ? 'nuevo' : 'proceso') + '">' + esc(m.folder) + '</span>' +
            '<strong class="mono" style="font-size:0.84rem;overflow-wrap:anywhere">' + esc(m.name) + '</strong>' +
            '<span class="muted" style="font-size:0.78rem">' + fmtSize(m.size) + '</span>' +
            '<a class="btn btn--ghost btn--sm" href="' + esc(m.url) + '" target="_blank" rel="noopener">Abrir / Descargar</a></div>';
        }).join('') + '</div></div>');
    } else {
      var tk = d.token || {};
      var base = tk.baseUrl || window.location.origin;
      var shownKey = cmsSt.revealedToken || 'TU_API_KEY_AQUI';
      h.push('<div class="grid grid--2">' +
        '<div class="card"><h3>Credenciales para tu CMS personal</h3>' +
        '<p class="field__hint" style="margin-top:0">Usa esta API Key desde tu CMS personal (Next.js, WordPress, Astro, n8n, app móvil o script) con encabezado <span class="mono">Authorization: Bearer &lt;API_KEY&gt;</span> o <span class="mono">X-API-Key</span>. Incluye CORS automático.</p>' +
        '<ul class="kvl" style="margin-bottom:16px">' +
        '<li><span>Base URL (HTTPS)</span><b>' + esc(base) + '</b></li>' +
        '<li><span>Respaldo directo</span><b>' + esc(tk.backupUrl || '') + '</b></li>' +
        '<li><span>Feed público (sin auth)</span><b>' + esc(base) + '/api/cms/public</b></li>' +
        '<li><span>API Key activa</span><b>' + esc(tk.prefix || 'sin generar') + '</b></li></ul>' +
        (cmsSt.revealedToken ? '<div class="token-reveal"><p class="eyebrow" style="margin-bottom:6px">Nueva API Key (guárdala ahora)</p><code class="mono" id="cmsTokenVal">' + esc(cmsSt.revealedToken) + '</code>' +
          '<button type="button" class="btn btn--solid btn--sm" id="cmsCopyToken" style="margin-top:10px">Copiar API Key</button></div>' : '') +
        '<div class="row__actions" style="justify-content:flex-start;margin-top:14px">' +
        '<button type="button" class="btn btn--solid btn--sm" id="cmsRotateToken">' + (tk.configured ? 'Rotar / Generar nueva API Key' : 'Generar API Key') + '</button></div></div>' +

        '<div class="card"><h3>Endpoints disponibles con tu API Key</h3>' +
        '<ul class="kvl">' +
        '<li><span class="mono">GET /api/state</span><b>Clientes, pedidos, pagos y visitas</b></li>' +
        '<li><span class="mono">GET /api/analytics?days=90</span><b>KPIs, embudo y series</b></li>' +
        '<li><span class="mono">GET /api/cms</span><b>Sitio + notas + media</b></li>' +
        '<li><span class="mono">POST /api/cms/notes</span><b>Crear/editar entrada MD</b></li>' +
        '<li><span class="mono">PUT /api/cms/site</span><b>Actualizar promos/config</b></li>' +
        '<li><span class="mono">GET /api/cms/public</span><b>Feed público (sin clave)</b></li>' +
        '<li><span class="mono">GET /api/inbox</span><b>Bandeja WhatsApp y pendientes</b></li>' +
        '<li><span class="mono">POST /api/inbox/reply</span><b>Responder cliente por WA</b></li>' +
        '<li><span class="mono">GET /api/courses</span><b>Estado de cursos autónomos</b></li></ul></div></div>');

      var jsSnippet = 'const res = await fetch("' + base + '/api/cms", {\n  headers: { Authorization: "Bearer ' + shownKey + '" }\n});\nconst data = await res.json();\nconsole.log(data.site, data.notes);';
      var curlSnippet = 'curl -H "Authorization: Bearer ' + shownKey + '" \\\n  "' + base + '/api/state"';
      h.push('<div class="section" style="margin-top:18px"><div class="section__head"><h2>Ejemplos listos para copiar</h2></div>' +
        '<div class="grid grid--2">' +
        '<div class="card"><h3>JavaScript / Next.js / CMS</h3><pre class="code-box">' + esc(jsSnippet) + '</pre></div>' +
        '<div class="card"><h3>cURL / n8n / Backend</h3><pre class="code-box">' + esc(curlSnippet) + '</pre></div></div></div>');
    }

    root.innerHTML = h.join('');

    Array.prototype.forEach.call(root.querySelectorAll('[data-cms-tab]'), function (b) {
      b.addEventListener('click', function () { cmsSt.tab = b.getAttribute('data-cms-tab'); cmsSt.msg = ''; renderCms(cmsSt.data); });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-cms-note]'), function (b) {
      b.addEventListener('click', function () { cmsSt.selected = b.getAttribute('data-cms-note'); cmsSt.msg = ''; renderCms(cmsSt.data); });
    });
    var nb = root.querySelector('#cmsNew');
    if (nb) nb.addEventListener('click', function () { cmsSt.selected = '__new__'; cmsSt.msg = ''; renderCms(cmsSt.data); });
    var sn = root.querySelector('#cmsSaveNote');
    if (sn) sn.addEventListener('click', function () {
      var slug = (root.querySelector('#cmsSlug').value || '').trim();
      var payload = {
        slug: slug || undefined,
        title: root.querySelector('#cmsTitle').value.trim(),
        category: root.querySelector('#cmsCat').value.trim() || 'general',
        status: root.querySelector('#cmsStatus').value,
        tags: root.querySelector('#cmsTags').value,
        body: root.querySelector('#cmsBody').value,
      };
      if (!payload.title) { window.alert('Escribe un título para la entrada.'); return; }
      sn.disabled = true;
      var url = slug ? ('/api/cms/notes/' + encodeURIComponent(slug)) : '/api/cms/notes';
      api(url, { method: slug ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
        .then(function (r) { cmsSt.selected = r.slug; cmsSt.msg = 'Entrada guardada en Obsidian (60-CMS/' + r.slug + '.md).'; loadCms(); })
        .catch(function (e) { sn.disabled = false; window.alert(e.message); });
    });
    var dn = root.querySelector('#cmsDelNote');
    if (dn) dn.addEventListener('click', function () {
      if (!window.confirm('¿Eliminar esta entrada de tu CMS?')) return;
      api('/api/cms/notes/' + encodeURIComponent(dn.getAttribute('data-del')), { method: 'DELETE' })
        .then(function () { cmsSt.selected = null; cmsSt.msg = 'Entrada eliminada.'; loadCms(); })
        .catch(function (e) { window.alert(e.message); });
    });
    var ss = root.querySelector('#cmsSaveSite');
    if (ss) ss.addEventListener('click', function () {
      var site = {};
      Array.prototype.forEach.call(root.querySelectorAll('[data-sf]'), function (el) {
        var k = el.getAttribute('data-sf');
        site[k] = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? Number(el.value) : el.value);
      });
      ss.disabled = true;
      api('/api/cms/site', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ site: site }) })
        .then(function () { cmsSt.msg = 'Configuración del CMS actualizada y publicada en /api/cms/public.'; loadCms(); })
        .catch(function (e) { ss.disabled = false; window.alert(e.message); });
    });
    var rt = root.querySelector('#cmsRotateToken');
    if (rt) rt.addEventListener('click', function () {
      if (!window.confirm('Se generará una nueva API Key y la anterior dejará de funcionar. ¿Continuar?')) return;
      rt.disabled = true;
      api('/api/auth/token/rotate', { method: 'POST' })
        .then(function (r) { cmsSt.revealedToken = r.token; cmsSt.msg = 'Nueva API Key generada. Cópiala y guárdala en tu CMS personal.'; loadCms(); })
        .catch(function (e) { rt.disabled = false; window.alert(e.message); });
    });
    var cp = root.querySelector('#cmsCopyToken');
    if (cp) cp.addEventListener('click', function () {
      navigator.clipboard && navigator.clipboard.writeText(cmsSt.revealedToken).then(function () { cp.textContent = 'Copiada'; });
    });
  }

  function loadCms() {
    api('/api/cms').then(function (d) { if (root && viewName === 'cms') renderCms(d); })
      .catch(function (e) { if (root) root.innerHTML = '<div class="empty"><strong>No pude cargar tu CMS.</strong>' + esc(e.message) + '</div>'; });
  }

  /* -------------------------------------------------------------------- API */

  function mount(name, el, hp) {
    unmount();
    root = el; viewName = name; helpers = hp || {};
    if (name === 'sistema') { loadSistema(); }
    else if (name === 'cursos') { loadCourses(); }
    else if (name === 'cms') { loadCms(); }
    else if (name === 'analisis') { loadAnalisis(); timer = window.setInterval(function () { if (!document.hidden) loadAnalisis(); }, 90000); }
    else { loadInbox(); timer = window.setInterval(function () { if (!document.hidden) loadInbox(); }, 15000); }
  }
  function unmount() { if (timer) window.clearInterval(timer); timer = null; root = null; viewName = null; }

  window.PanelAnalisis = { mount: mount, unmount: unmount, conversation: conversation };
})();
