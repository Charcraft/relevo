/* ==========================================================================
   Relevo · panel
   La regla del panel: cada pedido tiene que decirte qué hacer a continuación,
   y darte el mensaje escrito para que solo lo pegues y lo mandes.
   ========================================================================== */

(function () {
  'use strict';

  var S = window.PanelStore;
  var P = window.RELEVO_PRECIOS;
  var CFG = window.RELEVO || {};
  var MODEL = P.MODEL;

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var viewEl = $('#view');
  var sheet = $('#sheet');
  var toastEl = $('#toast');
  var state = { view: 'hoy', status: 'todos', q: '' };

  var STATUS_ORDER = ['nuevo', 'en_proceso', 'entregado', 'pagado', 'cancelado'];
  var STATUS_LABEL = {
    nuevo: 'Nuevo',
    en_proceso: 'En proceso',
    entregado: 'Entregado',
    pagado: 'Pagado',
    cancelado: 'Cancelado'
  };
  var STATUS_CHIP = {
    nuevo: 'chip--nuevo',
    en_proceso: 'chip--proceso',
    entregado: 'chip--entregado',
    pagado: 'chip--pagado',
    cancelado: 'chip--cancelado'
  };

  /* ---------------------------------------------------------------- básicos */

  function esc(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function money(n) { return P.mxn(n); }

  function todayISO() {
    var d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  function dayDiff(iso) {
    if (!iso) return null;
    var today = new Date(todayISO() + 'T00:00:00');
    var target = new Date(iso + 'T00:00:00');
    if (isNaN(target.getTime())) return null;
    return Math.round((target - today) / 86400000);
  }

  function fmtDate(iso) {
    if (!iso) return 'sin fecha';
    var p = String(iso).split('-');
    if (p.length !== 3) return iso;
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    try {
      return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
    } catch (err) {
      return iso;
    }
  }

  function relDate(iso) {
    var d = dayDiff(iso);
    if (d === null) return 'sin fecha';
    if (d === 0) return 'hoy';
    if (d === 1) return 'mañana';
    if (d === -1) return 'ayer';
    if (d < 0) return 'hace ' + Math.abs(d) + ' días';
    return 'en ' + d + ' días';
  }

  function localDay(value) {
    var d = new Date(value);
    if (isNaN(d.getTime())) return '';
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  function hoursSince(iso) {    if (!iso) return 0;
    return (Date.now() - new Date(iso).getTime()) / 3600000;
  }

  function daysSince(iso) {
    if (!iso) return 0;
    return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  }

  function intlPhone(phone) {
    var d = String(phone || '').replace(/\D/g, '');
    if (d.length === 10) return '52' + d;
    return d;
  }

  function waLink(phone, text) {
    var d = intlPhone(phone);
    if (d.length < 8) return '';
    return 'https://wa.me/' + d + '?text=' + encodeURIComponent(text);
  }

  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('is-on');
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(function () {
      toastEl.classList.remove('is-on');
    }, 2600);
  }

  function clientOf(order) {
    return S.clientById(order.clientId) || { name: 'Sin cliente', phone: '' };
  }

  function servicioTexto(order) {
    var m = MODEL[order.service] || MODEL.ensayo;
    return m.label + (order.qty ? ' de ' + order.qty + ' ' + m.unit : '');
  }

  /* ------------------------------------------------- pegar desde WhatsApp */

  var MESES = { ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5, jul: 6, ago: 7, sep: 8, set: 8, oct: 9, nov: 10, dic: 11 };

  function norm(value) {
    return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  }

  function parsePastedPedido(text) {
    var out = {};
    var campos = {
      'nombre': 'name',
      'servicio': 'service',
      'tema': 'subject',
      'entrega': 'due',
      'extension': 'extent',
      'formato': 'format',
      'rango estimado': 'range',
      'correo': 'email'
    };

    String(text || '').split(/\r?\n/).forEach(function (line) {
      var i = line.indexOf(':');
      if (i < 1) return;
      var key = norm(line.slice(0, i));
      var value = line.slice(i + 1).trim();
      if (!campos[key] || !value) return;
      out[campos[key]] = value;
    });

    if (out.service) {
      var wanted = norm(out.service);
      var match = Object.keys(MODEL).filter(function (key) {
        return norm(MODEL[key].service) === wanted || norm(MODEL[key].label) === wanted;
      })[0];
      out.service = match || null;
    }

    if (out.due) {
      var m = String(out.due).match(/(\d{1,2})\s*(?:de\s*)?([a-záéíóú]{3,})\.?\s*(?:de\s*)?(\d{4})?/i);
      if (m) {
        var mes = MESES[norm(m[2]).slice(0, 3)];
        if (mes !== undefined) {
          var year = m[3] ? Number(m[3]) : new Date().getFullYear();
          var dd = String(Number(m[1])).padStart(2, '0');
          out.due = year + '-' + String(mes + 1).padStart(2, '0') + '-' + dd;
        }
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(out.due)) {
        /* ya viene en ISO */
      } else {
        delete out.due;
      }
    }

    if (out.extent) {
      var n = String(out.extent).match(/\d+/);
      out.extent = n ? Number(n[0]) : null;
    }

    return out;
  }

  function applyPaste() {
    var area = $('#oPaste');
    var parsed = parsePastedPedido(area ? area.value : '');
    var found = 0;

    if (parsed.name) { $('#oClient').value = parsed.name; found += 1; }
    if (parsed.service) {
      $('#oService').value = parsed.service;
      $('#oUnit').textContent = MODEL[parsed.service].unit;
      found += 1;
    }
    if (parsed.subject) { $('#oSubject').value = parsed.subject; found += 1; }
    if (parsed.due) { $('#oDue').value = parsed.due; found += 1; }
    if (parsed.extent) { $('#oQty').value = String(parsed.extent); found += 1; }

    if (!found) {
      toast('No reconocí los campos. Revisa que el mensaje traiga Nombre, Servicio y Tema.');
      return;
    }

    if (parsed.range) {
      var nums = String(parsed.range).match(/\d+/g);
      if (nums && nums[1]) {
        var sugerido = P.round5((Number(nums[0]) + Number(nums[1])) / 2);
        $('#oPrice').value = String(sugerido);
      }
    }

    toast('Listo. Revisa los datos y cierra el precio.');
  }

  /* --------------------------------------------------------------- mensajes */

  var MSG = {
    cotizacion: function (c, o) {
      return [
        'Hola ' + firstName(c) + ', ya revisé lo que me mandaste.',
        '',
        (o.subject || 'Tu trabajo') + ', ' + servicioTexto(o).toLowerCase() + ', para el ' + fmtDate(o.due) + '.',
        'Queda en ' + money(o.price) + ', con revisiones incluidas hasta que cumpla lo que pide la actividad.',
        '¿Te lo aparto?'
      ].join('\n');
    },

    faltaPrecio: function (c, o) {
      return [
        'Hola ' + firstName(c) + ', para cerrarte el precio de ' + (o.subject || 'tu trabajo') + ' me falta un dato.',
        '¿Cuántas ' + (MODEL[o.service] || MODEL.ensayo).unit + ' son y para qué día lo necesitas?',
        'Con eso te doy el número exacto hoy mismo.'
      ].join('\n');
    },

    seguimiento: function (c, o) {
      return [
        'Hola ' + firstName(c) + ', te escribo por ' + (o.subject || 'tu trabajo') + '.',
        '¿Seguimos? Si me dices que sí, lo arranco hoy y te confirmo hora de entrega.'
      ].join('\n');
    },

    aviso: function (c, o) {
      return [
        'Hola ' + firstName(c) + ', te confirmo que ' + (o.subject || 'tu trabajo') + ' va en tiempo para el ' + fmtDate(o.due) + '.',
        'Si necesitas que te lo mande antes, dime y lo ajusto.'
      ].join('\n');
    },

    atrasado: function (c, o) {
      return [
        'Hola ' + firstName(c) + ', te aviso antes de que me lo preguntes: ' + (o.subject || 'tu trabajo') + ' se me está moviendo de la fecha que acordamos.',
        'Lo tengo listo hoy mismo y te mando la hora exacta en cuanto termine.',
        'Si no te sirve así, dime y lo resolvemos.'
      ].join('\n');
    },

    listo: function (c, o) {
      return [
        'Hola ' + firstName(c) + ', ya está listo ' + (o.subject || 'tu trabajo') + '.',
        'Te lo mando por aquí.',
        'Revísalo con lo que pide la actividad y si algo no cuadra lo corrijo sin costo.'
      ].join('\n');
    },

    cobro: function (c, o, saldo) {
      return [
        'Hola ' + firstName(c) + ', te recuerdo el saldo de ' + money(saldo) + ' de ' + (o.subject || 'tu trabajo') + '.',
        'Puede ser por transferencia o en efectivo, como te acomode.',
        'Si ya lo mandaste, ignora este mensaje.'
      ].join('\n');
    },

    recontacto: function (c, o) {
      return [
        'Hola ' + firstName(c) + ', ¿sigue en pie lo de ' + (o.subject || 'tu trabajo') + '?',
        'Tengo espacio esta semana y te lo dejo al mismo precio.'
      ].join('\n');
    }
  };

  function firstName(client) {
    var name = (client && client.name ? client.name : '').trim();
    if (!name) return 'qué tal';
    return name.split(/\s+/)[0];
  }

  /* ------------------------------------------------------- qué toca hacer */

  function agendaOf(order) {
    var client = clientOf(order);
    var balance = S.balanceOf(order);
    var d = dayDiff(order.due);

    if (order.status === 'cancelado') return null;

    if (order.status === 'nuevo') {
      if (!order.price) {
        return { score: 86, label: 'Cerrar el precio', tone: 'hot', text: MSG.faltaPrecio(client, order) };
      }
      if (hoursSince(order.createdAt) >= 20) {
        return { score: 72, label: 'Recontactar', tone: 'quiet', text: MSG.seguimiento(client, order) };
      }
      return { score: 80, label: 'Mandar la cotización', tone: 'hot', text: MSG.cotizacion(client, order) };
    }

    if (order.status === 'en_proceso') {
      if (d !== null && d < 0) {
        return { score: 100 + Math.abs(d), label: 'Avisar del retraso', tone: 'bad', text: MSG.atrasado(client, order) };
      }
      if (d !== null && d === 0) {
        return { score: 94, label: 'Entregar hoy', tone: 'hot', text: MSG.listo(client, order) };
      }
      if (d !== null && d === 1) {
        return { score: 84, label: 'Confirmar entrega', tone: 'hot', text: MSG.aviso(client, order) };
      }
      return { score: 60 - (d === null ? 0 : Math.min(d, 20)), label: 'En proceso', tone: 'quiet', text: MSG.aviso(client, order) };
    }

    if (order.status === 'entregado') {
      if (balance > 0) {
        var dias = daysSince(order.deliveredAt || order.due);
        return {
          score: 66 + Math.min(dias, 30),
          label: 'Cobrar ' + money(balance),
          tone: dias >= 3 ? 'bad' : 'hot',
          text: MSG.cobro(client, order, balance)
        };
      }
      return { score: 10, label: 'Marcar como pagado', tone: 'quiet', text: MSG.listo(client, order) };
    }

    return null;
  }

  function agenda() {
    return S.data.orders
      .map(function (order) { return { order: order, action: agendaOf(order) }; })
      .filter(function (item) { return item.action; })
      .sort(function (a, b) { return b.action.score - a.action.score; });
  }

  /* ------------------------------------------------------------- fragmentos */

  function statusChip(status) {
    return '<span class="chip ' + (STATUS_CHIP[status] || '') + '">' + esc(STATUS_LABEL[status] || status) + '</span>';
  }

  function dueChip(order) {
    var d = dayDiff(order.due);
    if (d === null) return '';
    if (order.status === 'pagado' || order.status === 'cancelado') return '';
    if (d < 0) return '<span class="chip chip--late">' + relDate(order.due) + '</span>';
    if (d === 0) return '<span class="chip chip--today">hoy</span>';
    return '';
  }

  function waButton(phone, text, label, cls) {
    var href = waLink(phone, text);
    if (!href) {
      return '<button type="button" class="btn btn--ghost btn--sm" data-act="sin-telefono">' + esc(label) + '</button>';
    }
    return '<a class="btn ' + (cls || 'btn--wa') + ' btn--sm" href="' + href + '" target="_blank" rel="noopener">' +
      esc(label) + '</a>';
  }

  function orderRow(order, action) {
    var client = clientOf(order);
    var balance = S.balanceOf(order);
    var paid = S.paidOf(order.id);
    var meta = [statusChip(order.status), dueChip(order), esc(client.name)];
    if (!order.subject) meta.push('<span class="dot">·</span>' + esc((MODEL[order.service] || MODEL.ensayo).label));

    var amount = order.price
      ? money(order.price) + (balance > 0 && paid > 0 ? '<small>debe ' + money(balance) + '</small>' : (balance === 0 && paid > 0 ? '<small>pagado</small>' : ''))
      : '<small>sin precio</small>';

    var primaryBtn = action && action.text
      ? waButton(client.phone, action.text, action.label)
      : nextStepButton(order);

    return [
      '<li class="row" data-id="' + esc(order.id) + '">',
      '  <div class="row__main">',
      '    <p class="row__title">' + esc(order.subject || servicioTexto(order)) + '</p>',
      '    <div class="row__meta">' + meta.join('') + '</div>',
      '  </div>',
      '  <div class="row__amount">' + amount + '</div>',
      '  <div class="row__actions">',
      primaryBtn,
      '    <button type="button" class="btn btn--quiet btn--sm" data-act="open-order" data-id="' + esc(order.id) + '">Abrir</button>',
      '  </div>',
      '</li>'
    ].join('');
  }

  function nextStepButton(order) {
    if (order.status === 'nuevo') {
      return '<button type="button" class="btn btn--ghost btn--sm" data-act="status" data-id="' + esc(order.id) + '" data-to="en_proceso">Empezar</button>';
    }
    if (order.status === 'en_proceso') {
      return '<button type="button" class="btn btn--ghost btn--sm" data-act="status" data-id="' + esc(order.id) + '" data-to="entregado">Entregado</button>';
    }
    if (order.status === 'entregado' && S.balanceOf(order) > 0) {
      return '<button type="button" class="btn btn--ghost btn--sm" data-act="pay" data-id="' + esc(order.id) + '">Registrar pago</button>';
    }
    return '';
  }

  /* ------------------------------------------------------------------ HOY */

  function viewHoy() {
    var items = agenda();
    var hoy = todayISO();
    var mes = hoy.slice(0, 7);

    var pendientes = S.data.orders.filter(function (o) {
      return (o.status === 'nuevo' || o.status === 'en_proceso') && dayDiff(o.due) === 0;
    }).length;

    var atrasados = S.data.orders.filter(function (o) {
      return o.status === 'en_proceso' && dayDiff(o.due) !== null && dayDiff(o.due) < 0;
    }).length;

    var porCobrar = S.data.orders.reduce(function (sum, o) {
      if (o.status === 'cancelado') return sum;
      return sum + S.balanceOf(o);
    }, 0);

    var cobradoMes = S.data.payments.reduce(function (sum, p) {
      return String(p.at).slice(0, 7) === mes ? sum + (Number(p.amount) || 0) : sum;
    }, 0);

    var activos = S.data.orders.filter(function (o) {
      return o.status === 'nuevo' || o.status === 'en_proceso' || (o.status === 'entregado' && S.balanceOf(o) > 0);
    }).length;

    var html = [];
    html.push(head('Hoy', fechaLarga()));

    var urgentes = pendientes + atrasados;
    html.push('<div class="stats">');
    html.push(stat('Por cobrar', money(porCobrar), porCobrar ? 'hot' : '', porCobrar ? 'saldo abierto' : 'al día'));
    html.push(stat('Cobrado en ' + nombreMes(), money(cobradoMes), 'ok', ''));
    html.push(stat('Activos', String(activos), '', 'en curso o por cobrar'));
    if (urgentes > 0) {
      html.push(stat('Urgentes', String(urgentes), atrasados ? 'bad' : 'hot', atrasados ? (atrasados + ' atrasado' + (atrasados === 1 ? '' : 's')) : 'entrega hoy'));
    }
    html.push('</div>');

    if (!items.length) {
      html.push('<div class="empty"><strong>Todo al día.</strong>Cuando entre un pedido aparecerá aquí.</div>');
    } else {
      html.push('<div class="section">');
      html.push('<div class="section__head"><h2>Pendientes</h2><span class="section__count">' + items.length + '</span></div>');
      html.push('<ul class="rows">');
      items.forEach(function (item) { html.push(orderRow(item.order, item.action)); });
      html.push('</ul>');
      html.push('</div>');
    }

    return html.join('');
  }

  function stat(label, value, tone, note) {
    return '<div class="stat ' + (tone ? 'stat--' + tone : '') + '">' +
      '<span class="stat__label">' + esc(label) + '</span>' +
      '<span class="stat__value">' + esc(value) + '</span>' +
      (note ? '<span class="stat__note">' + esc(note) + '</span>' : '') +
      '</div>';
  }

  function head(title, sub, helper, right) {
    return '<div class="view__head"><div class="view__title-wrap">' +
      '<h1 class="view__title">' + esc(title) + '</h1>' +
      (sub ? '<span class="view__meta">' + esc(sub) + '</span>' : '') +
      '</div>' + (right ? '<div class="view__head-right">' + right + '</div>' : '') + '</div>';
  }

  function fechaLarga() {
    try {
      return new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
    } catch (err) {
      return todayISO();
    }
  }

  function nombreMes() {
    try {
      return new Date().toLocaleDateString('es-MX', { month: 'long' });
    } catch (err) {
      return todayISO().slice(0, 7);
    }
  }

  /* -------------------------------------------------------------- PEDIDOS */

  function viewPedidos() {
    var list = S.data.orders.slice();

    if (state.status !== 'todos') {
      list = list.filter(function (o) { return o.status === state.status; });
    }

    if (state.q.trim()) {
      var q = state.q.trim().toLowerCase();
      list = list.filter(function (o) {
        var c = clientOf(o);
        return (o.subject || '').toLowerCase().indexOf(q) >= 0 ||
          (c.name || '').toLowerCase().indexOf(q) >= 0;
      });
    }

    list.sort(function (a, b) {
      var da = dayDiff(a.due), db = dayDiff(b.due);
      if (da === null) da = 999;
      if (db === null) db = 999;
      return da - db;
    });

    var html = [];
    html.push(head('Pedidos', S.data.orders.length + ' en total', '',
      '<button type="button" class="btn btn--ghost btn--sm" data-act="export-csv">Exportar CSV</button>'));

    html.push('<div class="toolbar"><div class="seg" role="group" aria-label="Filtrar por estado">');
    ['todos'].concat(STATUS_ORDER).forEach(function (s) {
      var id = 'fs-' + s;
      html.push('<input type="radio" name="filtro" id="' + id + '" value="' + s + '"' + (state.status === s ? ' checked' : '') + '>');
      html.push('<label for="' + id + '">' + esc(s === 'todos' ? 'Todos' : STATUS_LABEL[s]) + '</label>');
    });
    html.push('</div><label class="sr" for="buscar">Buscar</label>' +
      '<input id="buscar" type="search" placeholder="Buscar pedido o cliente…" value="' + esc(state.q) + '"></div>');

    if (!list.length) {
      html.push('<div class="empty"><strong>Sin pedidos en este filtro.</strong>Prueba otro estado o crea uno nuevo.</div>');
    } else {
      html.push('<ul class="rows">');
      list.forEach(function (order) {
        var action = agendaOf(order);
        html.push(orderRow(order, action));
      });
      html.push('</ul>');
    }
    return html.join('');
  }

  /* -------------------------------------------------------------- CLIENTES */

  function clientStats(client) {
    var orders = S.ordersOf(client.id);
    var activos = orders.filter(function (o) { return o.status !== 'cancelado'; });
    return {
      orders: orders.length,
      activos: activos.length,
      pagado: S.totalPaidOf(client.id),
      deuda: S.debtOf(client.id),
      ultimo: orders.slice().sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); })[0]
    };
  }

  function viewClientes() {
    var list = S.data.clients.slice();

    if (state.q.trim()) {
      var q = state.q.trim().toLowerCase();
      list = list.filter(function (c) {
        return (c.name || '').toLowerCase().indexOf(q) >= 0 || (c.phone || '').indexOf(q.replace(/\D/g, '')) >= 0;
      });
    }

    list.sort(function (a, b) { return (a.name || '').localeCompare(b.name || '', 'es'); });

    var html = [];
    html.push(head('Clientes', S.data.clients.length + ' registrados', 'Quién repite, quién debe y qué pidió la última vez.'));

    html.push('<div class="field" style="max-width:420px"><label class="sr" for="buscarC">Buscar cliente</label>' +
      '<input id="buscarC" type="search" placeholder="Nombre o teléfono" value="' + esc(state.q) + '"></div>');

    if (!list.length) {
      html.push('<div class="empty"><strong>Todavía no hay clientes.</strong>Crea un pedido y el cliente se guarda solo.</div>');
    } else {
      html.push('<ul class="rows">');
      list.forEach(function (c) {
        var s = clientStats(c);
        var meta = [];
        meta.push(s.activos + (s.activos === 1 ? ' pedido activo' : ' pedidos activos'));
        if (s.ultimo) meta.push('<span class="dot">·</span>' + esc(s.ultimo.subject || servicioTexto(s.ultimo)));
        var amount = s.deuda > 0
          ? '<span style="color:var(--bad)">' + money(s.deuda) + '<small>debe</small></span>'
          : '<span style="color:var(--ok)">al día<small>' + money(s.pagado) + ' pagado</small></span>';

        var acciones = [];
        var hola = waLink(c.phone, 'Hola ' + firstName(c) + ', soy de Relevo. ¿Cómo va todo?');
        if (hola) {
          acciones.push('<a class="btn btn--wa btn--sm" href="' + hola + '" target="_blank" rel="noopener">WhatsApp</a>');
        }
        acciones.push('<button type="button" class="btn btn--quiet btn--sm" data-act="open-client" data-id="' + esc(c.id) + '">Abrir</button>');

        html.push('<li class="row" data-id="' + esc(c.id) + '">' +
          '<div class="row__main"><p class="row__title">' + esc(c.name) + '</p>' +
          '<div class="row__meta">' + meta.join('') + '</div></div>' +
          '<div class="row__amount">' + amount + '</div>' +
          '<div class="row__actions">' + acciones.join('') + '</div></li>');
      });
      html.push('</ul>');
    }
    return html.join('');
  }

  /* --------------------------------------------------------------- COTIZAR */

  var quote = { kind: 'ensayo', extent: MODEL.ensayo.def, rush: 'normal' };

  function viewCotizar() {
    var m = MODEL[quote.kind];
    var range = P.computeRange(quote);
    var sugerido = P.suggestedPrice(quote.kind, quote.extent, quote.rush);

    var mensaje = [
      'Hola, quiero cotizar un trabajo.',
      'Tipo: ' + m.label,
      'Extensión: ' + quote.extent + ' ' + m.unit,
      'Entrega: ' + P.RUSH[quote.rush].text,
      'Rango: ' + money(range.lo) + ' a ' + money(range.hi) + ' MXN',
      '¿Me confirmas el precio exacto?'
    ].join('\n');

    var html = [];
    html.push(head('Cotizar', 'precio en segundos', 'Mismo motor que la calculadora del sitio. El rango es lo que se dice, el precio sugerido es lo que se cierra.'));

    html.push('<div class="quote">');

    html.push('<div class="panel-box">');
    html.push('<div class="field"><label>Tipo de trabajo</label><div class="seg" role="radiogroup">');
    Object.keys(MODEL).forEach(function (key) {
      var id = 'q-' + key;
      html.push('<input type="radio" name="qkind" id="' + id + '" value="' + key + '"' + (quote.kind === key ? ' checked' : '') + '>');
      html.push('<label for="' + id + '">' + esc(MODEL[key].label) + '</label>');
    });
    html.push('</div></div>');

    html.push('<div class="field"><label for="qext">Cuántas ' + esc(m.unit) + '</label>');
    html.push('<div class="stepper">');
    html.push('<button type="button" data-act="step" data-step="-1" aria-label="Quitar uno">−</button>');
    html.push('<input id="qext" type="number" min="1" max="40" value="' + quote.extent + '" inputmode="numeric">');
    html.push('<button type="button" data-act="step" data-step="1" aria-label="Agregar uno">+</button>');
    html.push('</div></div>');

    html.push('<div class="field"><label>Cuándo lo necesita</label><div class="seg" role="radiogroup">');
    ['normal', 'week', 'rush'].forEach(function (key) {
      var id = 'qr-' + key;
      html.push('<input type="radio" name="qrush" id="' + id + '" value="' + key + '"' + (quote.rush === key ? ' checked' : '') + '>');
      html.push('<label for="' + id + '">' + esc(P.RUSH[key].text) + '</label>');
    });
    html.push('</div></div>');

    html.push('<div class="range"><span class="range__num">' + money(range.lo) + '</span>' +
      '<span class="range__sep">a</span><span class="range__num">' + money(range.hi) + (range.capped ? '+' : '') + '</span></div>');
    html.push('<p class="range__note">' + (range.capped
      ? 'Toca el techo de ' + money(P.CEIL) + '. Si es más grande, se cotiza aparte con el alcance desglosado.'
      : 'Precio sugerido para cerrar: ' + money(sugerido) + '.') + '</p>');
    html.push('</div>');

    html.push('<div class="panel-box">');
    html.push('<p class="eyebrow" style="margin-bottom:8px">Mensaje listo para WhatsApp</p>');
    html.push('<pre class="msg-out" id="msgOut">' + esc(mensaje) + '</pre>');
    html.push('<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">');
    html.push('<a class="btn btn--wa" id="quoteWa" href="' + waLink(CFG.whatsapp, mensaje) + '" target="_blank" rel="noopener">Abrir WhatsApp</a>');
    html.push('<button type="button" class="btn btn--ghost" data-act="quote-copy">Copiar mensaje</button>');
    html.push('<button type="button" class="btn btn--solid" data-act="quote-save">Guardar como pedido</button>');
    html.push('</div>');
    html.push('<p class="field__hint">Al guardarlo se abre el formulario con el precio sugerido ya puesto.</p>');
    html.push('</div>');

    html.push('</div>');
    return html.join('');
  }

  function syncQuote() {
    var m = MODEL[quote.kind];
    var range = P.computeRange(quote);
    var sugerido = P.suggestedPrice(quote.kind, quote.extent, quote.rush);

    var nums = $$('.range .range__num');
    if (nums[0]) nums[0].textContent = money(range.lo);
    if (nums[1]) nums[1].textContent = money(range.hi) + (range.capped ? '+' : '');

    var note = $('.range__note');
    if (note) {
      note.textContent = range.capped
        ? 'Toca el techo de ' + money(P.CEIL) + '. Si es más grande, se cotiza aparte con el alcance desglosado.'
        : 'Precio sugerido para cerrar: ' + money(sugerido) + '.';
    }

    var mensaje = [
      'Hola, quiero cotizar un trabajo.',
      'Tipo: ' + m.label,
      'Extensión: ' + quote.extent + ' ' + m.unit,
      'Entrega: ' + P.RUSH[quote.rush].text,
      'Rango: ' + money(range.lo) + ' a ' + money(range.hi) + ' MXN',
      '¿Me confirmas el precio exacto?'
    ].join('\n');

    var out = $('#msgOut');
    if (out) out.textContent = mensaje;

    var link = $('#quoteWa');
    if (link) link.href = waLink(CFG.whatsapp, mensaje);
  }

  /* --------------------------------------------------------------- TRÁFICO */

  function viewTrafico() {
    var events = S.data.events || [];
    var html = [];
    html.push(head('Tráfico', 'quién llega y quién escribe', 'Visitas a la página y clics al botón de WhatsApp, por día y por origen.'));

    if (!events.length) {
      html.push('<div class="empty"><strong>Todavía no hay datos.</strong>' +
        'Esto se llena cuando el sitio reporta cada visita. Mientras tanto puedes importar un archivo o cargar los datos de ejemplo desde el menú.</div>');
      html.push('<div style="margin-top:16px"><button type="button" class="btn btn--ghost" data-act="import">Importar datos</button></div>');
      return html.join('');
    }

    var dias = [];
    var today = new Date();
    for (var i = 13; i >= 0; i -= 1) {
      var d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      dias.push(localDay(d));
    }

    var porDia = {};
    var porFuente = {};
    var totalVisitas = 0;
    var totalWa = 0;

    events.forEach(function (e) {
      var day = localDay(e.at);
      if (!porDia[day]) porDia[day] = { page: 0, wa: 0 };
      if (e.type === 'wa') {
        porDia[day].wa += 1;
        totalWa += 1;
      } else {
        porDia[day].page += 1;
        totalVisitas += 1;
      }
      var src = e.src || 'directo';
      if (!porFuente[src]) porFuente[src] = { page: 0, wa: 0 };
      porFuente[src][e.type === 'wa' ? 'wa' : 'page'] += 1;
    });

    var max = 1;
    dias.forEach(function (day) {
      var v = porDia[day] || { page: 0, wa: 0 };
      max = Math.max(max, v.page, v.wa);
    });

    var conv = totalVisitas ? ((totalWa / totalVisitas) * 100).toFixed(1) : '0.0';

    html.push('<div class="stats">');
    html.push(stat('Visitas 14 días', String(totalVisitas), '', 'páginas vistas'));
    html.push(stat('Clics a WhatsApp', String(totalWa), 'hot', 'intención de compra'));
    html.push(stat('Conversión', conv + '%', Number(conv) >= 10 ? 'ok' : '', 'clics sobre visitas'));
    html.push('</div>');

    html.push('<div class="section"><div class="section__head"><h2>Últimos 14 días</h2></div>');
    html.push('<div class="bars" role="img" aria-label="Visitas y clics a WhatsApp por día">');
    dias.forEach(function (day) {
      var v = porDia[day] || { page: 0, wa: 0 };
      html.push('<div class="bars__col">');
      html.push('<div class="bars__fill" style="height:' + Math.max(2, (v.page / max) * 100) + '%" title="' + v.page + ' visitas"></div>');
      html.push('<div class="bars__fill bars__fill--wa" style="height:' + Math.max(2, (v.wa / max) * 100) + '%" title="' + v.wa + ' clics"></div>');
      html.push('<span class="bars__label">' + esc(day.slice(8)) + '</span>');
      html.push('</div>');
    });
    html.push('</div>');
    html.push('<div class="legend"><span><i class="swatch"></i>Visitas</span><span><i class="swatch swatch--wa"></i>Clics a WhatsApp</span></div>');
    html.push('</div>');

    html.push('<div class="section"><div class="section__head"><h2>De dónde llegan</h2></div><ul class="srcs">');
    Object.keys(porFuente).sort(function (a, b) { return porFuente[b].page - porFuente[a].page; }).forEach(function (src) {
      var f = porFuente[src];
      html.push('<li><span>' + esc(src) + '</span><span class="srcs__n">' + f.page + ' visitas · ' + f.wa + ' clics</span></li>');
    });
    html.push('</ul></div>');

    if (S.data.settings.demo) {
      html.push('<p class="field__hint">Estos son datos de ejemplo. Bórralos desde el menú antes de usar el panel en serio.</p>');
    }

    return html.join('');
  }

  /* ------------------------------------------------------------------ router */

  /* Vistas que viven del servidor (analítica del negocio y bandeja de WhatsApp) */
  function viewServidor(name) {
    return function () {
      if (!S.server) {
        return head(name === 'analisis' ? 'Análisis' : name === 'sistema' ? 'Sistema' : 'WhatsApp', 'solo desde el servidor', '') +
          '<div class="empty"><strong>Esta sección necesita el servidor de Relevo.</strong>' +
          'Ábrela desde la dirección privada del servidor (Tailscale) para ver los datos reales de WhatsApp y de la página.</div>';
      }
      return '<div id="anaRoot" data-view-name="' + name + '"><p class="muted" style="padding:24px 0">Cargando…</p></div>';
    };
  }

  var VIEWS = {
    hoy: viewHoy,
    pedidos: viewPedidos,
    clientes: viewClientes,
    cursos: viewServidor('cursos'),
    cotizar: viewCotizar,
    trafico: viewTrafico,
    analisis: viewServidor('analisis'),
    whatsapp: viewServidor('whatsapp'),
    cms: viewServidor('cms'),
    sistema: viewServidor('sistema')
  };

  function render() {
    if (window.PanelAnalisis) window.PanelAnalisis.unmount();
    var fn = VIEWS[state.view] || VIEWS.hoy;
    viewEl.innerHTML = fn();
    var anaRoot = $('#anaRoot');
    if (anaRoot && window.PanelAnalisis) window.PanelAnalisis.mount(anaRoot.getAttribute('data-view-name'), anaRoot, { esc: esc, openSheet: openSheet });

    $$('[data-view]').forEach(function (btn) {
      if (btn.getAttribute('data-view') === state.view) {
        btn.setAttribute('aria-current', 'page');
      } else {
        btn.removeAttribute('aria-current');
      }
    });

    /* Actualizar badges y estado en la barra lateral izquierda */
    var activeOrders = S.data.orders.filter(function (o) { return o.status !== 'pagado' && o.status !== 'cancelado'; }).length;
    var bp = $('#badgePedidos');
    if (bp) { bp.textContent = String(activeOrders); bp.hidden = activeOrders === 0; }
    var meta = S.data.meta || {};
    var bw = $('#badgeWa');
    if (bw) { var pend = Number(meta.pendientes) || 0; bw.textContent = String(pend); bw.hidden = pend === 0; }
    var dot = $('#waDot'), lbl = $('#waStatusLabel');
    if (dot && lbl && S.server) {
      dot.className = 'status-dot' + (meta.paused ? ' is-warn' : (meta.wa === 'ready' ? '' : ' is-bad'));
      lbl.textContent = meta.paused ? 'Agente pausado' : (meta.wa === 'ready' ? 'WhatsApp conectado' : ('WhatsApp: ' + (meta.wa || 'cargando')));
    }

    if (S.data.settings.demo) {
      var banner = document.createElement('p');
      banner.className = 'field__hint';
      banner.style.cssText = 'margin:-12px 0 20px;color:var(--amber)';
      banner.textContent = 'Estás viendo datos de ejemplo. Bórralos desde el menú (⋯) cuando empieces a cargar los tuyos.';
      viewEl.insertBefore(banner, viewEl.firstChild);
    }
  }

  function closeDrawer() {
    document.body.classList.remove('is-nav-open');
    var bd = $('#navBackdrop'); if (bd) bd.hidden = true;
    var tg = $('#navToggle'); if (tg) tg.setAttribute('aria-expanded', 'false');
  }

  function openDrawer() {
    document.body.classList.add('is-nav-open');
    var bd = $('#navBackdrop'); if (bd) bd.hidden = false;
    var tg = $('#navToggle'); if (tg) tg.setAttribute('aria-expanded', 'true');
  }

  function go(viewName) {
    state.view = viewName;
    state.q = '';
    closeDrawer();
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* --------------------------------------------------------------- diálogos */

  function openSheet(html) {
    sheet.innerHTML = html;
    if (typeof sheet.showModal === 'function') {
      sheet.showModal();
    } else {
      sheet.setAttribute('open', '');
    }
    var candidates = sheet.querySelectorAll('input, select, textarea');
    var first = null;
    for (var i = 0; i < candidates.length; i += 1) {
      if (candidates[i].offsetParent !== null) { first = candidates[i]; break; }
    }
    if (!first) first = sheet.querySelector('.sheet__head button') || sheet.querySelector('button');
    if (first) first.focus();
  }

  function closeSheet() {
    if (typeof sheet.close === 'function') sheet.close();
    else sheet.removeAttribute('open');
  }

  function clientOptions(selectedId) {
    return S.data.clients.slice()
      .sort(function (a, b) { return (a.name || '').localeCompare(b.name || '', 'es'); })
      .map(function (c) {
        return '<option value="' + esc(c.name) + '"' + (c.id === selectedId ? ' selected' : '') + '></option>';
      }).join('');
  }

  function openOrderForm(orderId) {
    var order = orderId ? S.orderById(orderId) : null;
    var client = order ? clientOf(order) : { name: '', phone: '', notes: '' };
    var editing = Boolean(order);

    var html = [];
    html.push('<form method="dialog" id="orderForm">');
    html.push('<div class="sheet__head"><h2 id="sheetTitle">' + (editing ? 'Editar pedido' : 'Nuevo pedido') + '</h2>' +
      '<button type="button" class="btn btn--quiet btn--sm" data-act="close" style="margin-left:auto" aria-label="Cerrar">Cerrar</button></div>');
    html.push('<div class="sheet__body">');

    if (!editing) {
      html.push('<details class="paste">' +
        '<summary>Pegar el mensaje de WhatsApp</summary>' +
        '<p class="field__hint">Copia el mensaje que manda el cliente desde la página y pégalo aquí. Se llenan nombre, servicio, tema, fecha y extensión.</p>' +
        '<textarea id="oPaste" placeholder="Hola, quiero cotizar este trabajo:&#10;&#10;Nombre: ...&#10;Servicio: ..."></textarea>' +
        '<button type="button" class="btn btn--ghost btn--sm" data-act="parse" style="margin-top:8px">Rellenar campos</button>' +
        '</details>');
    }

    html.push('<div class="field"><label for="oClient">Cliente</label>' +
      '<input id="oClient" name="client" list="clientList" autocomplete="off" value="' + esc(client.name) + '" placeholder="Nombre" required>' +
      '<datalist id="clientList">' + clientOptions(order ? order.clientId : null) + '</datalist>' +
      '<p class="field__hint">Si el nombre ya existe, se usa ese cliente. Si no, se crea.</p></div>');

    html.push('<div class="field"><label for="oPhone">WhatsApp</label>' +
      '<input id="oPhone" name="phone" type="tel" inputmode="tel" autocomplete="off" value="' + esc(client.phone) + '" placeholder="961 123 4567">' +
      '<p class="field__hint">Con lada de país. Si escribes 10 dígitos se le pone 52.</p></div>');

    html.push('<div class="grid2">');
    html.push('<div class="field"><label for="oService">Servicio</label><select id="oService" name="service">');
    Object.keys(MODEL).forEach(function (key) {
      html.push('<option value="' + key + '"' + (order && order.service === key ? ' selected' : '') + '>' + esc(MODEL[key].label) + '</option>');
    });
    html.push('</select></div>');
    html.push('<div class="field"><label for="oQty">Cantidad</label>' +
      '<input id="oQty" name="qty" type="number" min="0" max="200" inputmode="numeric" value="' + (order ? order.qty : MODEL.ensayo.def) + '">' +
      '<p class="field__hint" id="oUnit">' + esc(MODEL[(order && MODEL[order.service]) ? order.service : 'ensayo'].unit) + '</p></div>');
    html.push('</div>');

    html.push('<div class="field"><label for="oSubject">Qué es</label>' +
      '<input id="oSubject" name="subject" value="' + esc(order ? order.subject : '') + '" placeholder="Tema o título del trabajo"></div>');

    html.push('<div class="grid2">');
    html.push('<div class="field"><label for="oDue">Entrega</label>' +
      '<input id="oDue" name="due" type="date" value="' + esc(order ? order.due : '') + '"></div>');
    html.push('<div class="field"><label for="oPrice">Precio acordado</label>' +
      '<input id="oPrice" name="price" type="number" min="0" step="any" inputmode="decimal" value="' + (order ? order.price : '') + '" placeholder="0">' +
      '<p class="field__hint">En blanco si todavía no se cerró.</p></div>');
    html.push('</div>');

    if (!editing) {
      html.push('<div class="grid2">');
      html.push('<div class="field"><label for="oAnticipo">Anticipo recibido</label>' +
        '<input id="oAnticipo" name="anticipo" type="number" min="0" step="any" inputmode="decimal" placeholder="0"></div>');
      html.push('<div class="field"><label for="oMethod">Cómo pagó</label><select id="oMethod" name="method">' +
        '<option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option>' +
        '</select></div>');
      html.push('</div>');
    } else {
      html.push('<div class="field"><label for="oStatus">Estado</label><select id="oStatus" name="status">');
      STATUS_ORDER.forEach(function (s) {
        html.push('<option value="' + s + '"' + (order.status === s ? ' selected' : '') + '>' + STATUS_LABEL[s] + '</option>');
      });
      html.push('</select></div>');
    }

    html.push('<div class="field"><label for="oNotes">Notas</label>' +
      '<textarea id="oNotes" name="notes" placeholder="Rúbrica, links y requisitos del cliente.">' + esc(order ? order.notes : '') + '</textarea></div>');

    html.push('</div>');
    html.push('<div class="sheet__foot">');
    if (editing) {
      html.push('<button type="button" class="btn btn--quiet" data-act="delete-order" data-id="' + esc(order.id) + '" style="margin-right:auto;color:var(--bad)">Eliminar</button>');
    }
    html.push('<button type="button" class="btn btn--ghost" data-act="close">Cancelar</button>');
    html.push('<button type="submit" class="btn btn--solid">' + (editing ? 'Guardar' : 'Crear pedido') + '</button>');
    html.push('</div>');
    html.push('</form>');

    openSheet(html.join(''));

    var form = $('#orderForm');
    var serviceEl = $('#oService');
    var qtyEl = $('#oQty');
    var clientEl = $('#oClient');
    var phoneEl = $('#oPhone');
    var unitEl = $('#oUnit');

    serviceEl.addEventListener('change', function () {
      unitEl.textContent = MODEL[serviceEl.value].unit;
      if (!qtyEl.value) qtyEl.value = MODEL[serviceEl.value].def;
    });

    clientEl.addEventListener('change', function () {
      var c = S.data.clients.filter(function (x) { return x.name === clientEl.value; })[0];
      if (c && !phoneEl.value) phoneEl.value = c.phone;
    });

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var name = clientEl.value.trim();
      if (!name) { clientEl.focus(); return; }

      var phone = phoneEl.value.replace(/\D/g, '');
      var existing = S.findClientByPhone(phone) ||
        S.data.clients.filter(function (c) { return c.name.toLowerCase() === name.toLowerCase(); })[0];

      var clientId = existing ? existing.id : (S.addClient({ name: name, phone: phone }) || {}).id;
      if (!clientId) { toast('No se pudo crear el cliente.'); return; }

      if (phone && existing && existing.phone !== phone) {
        S.updateClient(existing.id, { phone: phone });
      }

      var data = {
        clientId: clientId,
        service: serviceEl.value,
        qty: Number(qtyEl.value) || 0,
        subject: $('#oSubject').value,
        due: $('#oDue').value,
        price: Number($('#oPrice').value) || 0,
        notes: $('#oNotes').value
      };

      if (editing) {
        data.status = $('#oStatus').value;
        S.updateOrder(order.id, data);
        toast('Pedido actualizado.');
      } else {
        data.anticipo = Number($('#oAnticipo').value) || 0;
        data.method = $('#oMethod').value;
        S.addOrder(data);
        toast('Pedido creado.');
      }

      closeSheet();
      render();
    });
  }

  function openClient(clientId) {
    var client = S.clientById(clientId);
    if (!client) return;
    var stats = clientStats(client);
    var orders = S.ordersOf(clientId).slice().sort(function (a, b) {
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });

    var html = [];
    html.push('<div class="sheet__head"><h2 id="sheetTitle">' + esc(client.name) + '</h2>' +
      '<button type="button" class="btn btn--quiet btn--sm" data-act="close" style="margin-left:auto" aria-label="Cerrar">Cerrar</button></div>');
    html.push('<div class="sheet__body">');

    html.push('<dl class="kv">');
    html.push('<dt>WhatsApp</dt><dd class="mono">' + esc(client.phone || 'sin número') + '</dd>');
    if (client.institucion) html.push('<dt>Institución</dt><dd>' + esc(client.institucion) + '</dd>');
    if (client.nivel) html.push('<dt>Nivel</dt><dd>' + esc(client.nivel) + '</dd>');
    if (client.origen) html.push('<dt>Llegó por</dt><dd>' + esc(client.origen) + '</dd>');
    html.push('<dt>Pedidos</dt><dd>' + stats.orders + ' en total, ' + stats.activos + ' activos</dd>');
    html.push('<dt>Pagado</dt><dd>' + money(stats.pagado) + '</dd>');
    html.push('<dt>Debe</dt><dd' + (stats.deuda ? ' style="color:var(--bad)"' : '') + '>' + money(stats.deuda) + '</dd>');
    html.push('<dt>Desde</dt><dd>' + fmtDate(String(client.createdAt).slice(0, 10)) + '</dd>');
    html.push('</dl>');

    if (client.notes) {
      html.push('<p class="eyebrow" style="margin:18px 0 6px">Notas</p><p style="margin:0;color:var(--dim);font-size:0.87rem">' + esc(client.notes) + '</p>');
    }

    html.push('<p class="eyebrow" style="margin:20px 0 6px">Historial</p>');
    if (!orders.length) {
      html.push('<p class="muted" style="font-size:0.85rem">Sin pedidos todavía.</p>');
    } else {
      html.push('<ul class="rows">');
      orders.forEach(function (o) {
        var bal = S.balanceOf(o);
        html.push('<li class="row"><div class="row__main"><p class="row__title">' + esc(o.subject || servicioTexto(o)) + '</p>' +
          '<div class="row__meta">' + statusChip(o.status) + '<span class="dot">·</span>' + fmtDate(o.due) +
          '<span class="dot">·</span>' + money(o.price) + (bal > 0 ? ' · debe ' + money(bal) : '') + '</div></div>' +
          '<div class="row__actions"><button type="button" class="btn btn--quiet btn--sm" data-act="open-order" data-id="' + esc(o.id) + '">Abrir</button></div></li>');
      });
      html.push('</ul>');
    }

    html.push('</div>');
    html.push('<div class="sheet__foot">');
    html.push('<button type="button" class="btn btn--ghost" data-act="edit-client" data-id="' + esc(client.id) + '">Editar datos</button>');
    if (S.server && client.wa) {
      html.push('<button type="button" class="btn btn--ghost" data-act="conversation" data-id="' + esc(client.id) + '">Ver conversación</button>');
    }
    if (client.phone) {
      html.push('<a class="btn btn--wa" href="' + waLink(client.phone, 'Hola ' + firstName(client) + ', soy de Relevo.') + '" target="_blank" rel="noopener">Abrir WhatsApp</a>');
    }
    html.push('<button type="button" class="btn btn--solid" data-act="new-order-for" data-id="' + esc(client.id) + '">Nuevo pedido</button>');
    html.push('</div>');

    openSheet(html.join(''));
  }

  function openClientForm(clientId) {
    var client = clientId ? S.clientById(clientId) : null;
    var html = [];
    html.push('<form method="dialog" id="clientForm">');
    html.push('<div class="sheet__head"><h2 id="sheetTitle">Datos del cliente</h2>' +
      '<button type="button" class="btn btn--quiet btn--sm" data-act="close" style="margin-left:auto" aria-label="Cerrar">Cerrar</button></div>');
    html.push('<div class="sheet__body">');
    html.push('<div class="field"><label for="cName">Nombre</label><input id="cName" name="name" value="' + esc(client ? client.name : '') + '" required></div>');
    html.push('<div class="field"><label for="cPhone">WhatsApp</label><input id="cPhone" name="phone" type="tel" inputmode="tel" value="' + esc(client ? client.phone : '') + '"><p class="field__hint">10 dígitos o con 52 adelante.</p></div>');
    html.push('<div class="field"><label for="cInst">Institución</label><input id="cInst" name="institucion" value="' + esc(client ? client.institucion || '' : '') + '" placeholder="UNACH, COBACH 13, empresa…"></div>');
    html.push('<div class="field"><label for="cNivel">Nivel</label><select id="cNivel" name="nivel">' +
      ['', 'secundaria', 'preparatoria', 'licenciatura', 'posgrado', 'profesional', 'curso-en-linea', 'otro'].map(function (n) {
        return '<option value="' + n + '"' + ((client && client.nivel === n) ? ' selected' : '') + '>' + (n || 'Sin dato') + '</option>';
      }).join('') + '</select></div>');
    html.push('<div class="field"><label for="cTags">Etiquetas</label><input id="cTags" name="tags" value="' + esc(client ? (client.tags || []).join(', ') : '') + '" placeholder="recurrente, curso, debe"><p class="field__hint">Sepáralas con coma.</p></div>');
    html.push('<div class="field"><label for="cNotes">Notas</label><textarea id="cNotes" name="notes">' + esc(client ? client.notes : '') + '</textarea></div>');
    html.push('</div>');
    html.push('<div class="sheet__foot"><button type="button" class="btn btn--ghost" data-act="close">Cancelar</button>' +
      '<button type="submit" class="btn btn--solid">Guardar</button></div>');
    html.push('</form>');
    openSheet(html.join(''));

    $('#clientForm').addEventListener('submit', function (event) {
      event.preventDefault();
      var name = $('#cName').value.trim();
      if (!name) { $('#cName').focus(); return; }
      var payload = {
        name: name,
        phone: $('#cPhone').value.replace(/\D/g, ''),
        institucion: $('#cInst').value.trim(),
        nivel: $('#cNivel').value,
        tags: $('#cTags').value.split(',').map(function (t) { return t.trim(); }).filter(Boolean),
        notes: $('#cNotes').value
      };
      if (client) {
        S.updateClient(client.id, payload);
        toast('Cliente actualizado.');
        closeSheet();
        render();
        openClient(client.id);
      } else {
        var created = S.addClient(payload);
        closeSheet();
        render();
        if (created) openClient(created.id);
      }
    });
  }

  function openPayment(orderId) {
    var order = S.orderById(orderId);
    if (!order) return;
    var balance = S.balanceOf(order);

    var html = [];
    html.push('<form method="dialog" id="payForm">');
    html.push('<div class="sheet__head"><h2 id="sheetTitle">Registrar pago</h2>' +
      '<button type="button" class="btn btn--quiet btn--sm" data-act="close" style="margin-left:auto" aria-label="Cerrar">Cerrar</button></div>');
    html.push('<div class="sheet__body">');
    html.push('<p class="muted" style="margin-top:0;font-size:0.87rem">' + esc(order.subject || servicioTexto(order)) + ' · saldo ' + money(balance) + '</p>');
    html.push('<div class="grid2">');
    html.push('<div class="field"><label for="pAmount">Monto</label><input id="pAmount" name="amount" type="number" min="0.01" step="any" inputmode="decimal" value="' + (balance || '') + '"></div>');
    html.push('<div class="field"><label for="pMethod">Cómo pagó</label><select id="pMethod" name="method"><option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option></select></div>');
    html.push('</div>');
    html.push('<div class="field"><label for="pNote">Nota</label><input id="pNote" name="note" placeholder="Opcional"></div>');
    html.push('</div>');
    html.push('<div class="sheet__foot"><button type="button" class="btn btn--ghost" data-act="close">Cancelar</button>' +
      '<button type="submit" class="btn btn--solid">Guardar pago</button></div>');
    html.push('</form>');
    openSheet(html.join(''));

    $('#payForm').addEventListener('submit', function (event) {
      event.preventDefault();
      var amount = Number($('#pAmount').value) || 0;
      if (amount <= 0) { $('#pAmount').focus(); return; }
      S.addPayment({ orderId: order.id, amount: amount, method: $('#pMethod').value, note: $('#pNote').value });
      closeSheet();
      toast('Pago registrado. Saldo ' + money(S.balanceOf(order)));
      render();
    });
  }

  function openSettings() {
    var s = S.data.settings;
    var html = [];
    html.push('<form method="dialog" id="setForm">');
    html.push('<div class="sheet__head"><h2 id="sheetTitle">Ajustes y respaldo</h2>' +
      '<button type="button" class="btn btn--quiet btn--sm" data-act="close" style="margin-left:auto" aria-label="Cerrar">Cerrar</button></div>');
    html.push('<div class="sheet__body">');
    html.push('<div class="field"><label for="sNegocio">Nombre del negocio</label><input id="sNegocio" value="' + esc(s.negocio) + '"></div>');
    html.push('<div class="field"><label for="sNota">Datos para pagar</label><input id="sNota" value="' + esc(s.notaPago) + '" placeholder="CLABE, banco o sin datos"><p class="field__hint">Aparece en los recordatorios de cobro.</p></div>');
    html.push('<p class="eyebrow" style="margin:22px 0 8px">Respaldo</p>');
    html.push('<p class="muted" style="font-size:0.85rem;margin-top:0">Todo vive en este navegador. Exporta seguido y guarda el archivo.</p>');
    html.push('<div style="display:flex;gap:8px;flex-wrap:wrap">');
    html.push('<button type="button" class="btn btn--ghost" data-act="export">Exportar JSON</button>');
    html.push('<button type="button" class="btn btn--ghost" data-act="import">Importar JSON</button>');
    html.push('</div>');
    html.push('<p class="eyebrow" style="margin:22px 0 8px">Datos</p>');
    html.push('<div style="display:flex;gap:8px;flex-wrap:wrap">');
    html.push('<button type="button" class="btn btn--ghost" data-act="seed">Cargar ejemplo</button>');
    html.push('<button type="button" class="btn btn--ghost" data-act="reset" style="color:var(--bad);border-color:rgba(240,154,134,0.4)">Borrar todo</button>');
    html.push('</div>');
    html.push('</div>');
    html.push('<div class="sheet__foot"><button type="button" class="btn btn--ghost" data-act="close">Cerrar</button>' +
      '<button type="submit" class="btn btn--solid">Guardar</button></div>');
    html.push('</form>');
    openSheet(html.join(''));

    $('#setForm').addEventListener('submit', function (event) {
      event.preventDefault();
      S.data.settings.negocio = $('#sNegocio').value.trim() || 'Relevo';
      S.data.settings.notaPago = $('#sNota').value.trim();
      S.save();
      closeSheet();
      toast('Ajustes guardados.');
    });
  }

  /* ---------------------------------------------------------------- eventos */

  function download(filename, text) {
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function importFile() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          S.importJSON(String(reader.result));
          closeSheet();
          render();
          toast('Datos importados.');
        } catch (err) {
          window.alert('No se pudo leer el archivo: ' + err.message);
        }
      };
      reader.readAsText(file);
    });
    input.click();
  }

  function runAction(act, id, el) {

    if (act === 'close') { closeSheet(); return; }

    if (act === 'export-csv') {
      var csvEsc = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
      var lines = [['ID', 'Cliente', 'Teléfono', 'Servicio', 'Asunto', 'Estado', 'Entrega', 'Precio', 'Pagado', 'Saldo', 'Origen'].map(csvEsc).join(',')];
      S.data.orders.forEach(function (o) {
        var c = clientOf(o);
        var paid = S.paidOf(o.id);
        var bal = S.balanceOf(o);
        lines.push([o.id, c.name || '', c.phone || '', o.service || '', o.subject || '', o.status || '', o.due || '', o.price || 0, paid, bal, o.source || ''].map(csvEsc).join(','));
      });
      var blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'relevo-pedidos-' + todayISO() + '.csv';
      a.click();
      toast('CSV descargado.');
      return;
    }

    if (act === 'open-order') { openOrderForm(id); return; }

    if (act === 'parse') { applyPaste(); return; }

    if (act === 'open-client') { openClient(id); return; }

    if (act === 'conversation') {
      if (window.PanelAnalisis) window.PanelAnalisis.conversation(id, { esc: esc, openSheet: openSheet });
      return;
    }

    if (act === 'edit-client') { openClientForm(id); return; }

    if (act === 'new-order-for') {
      closeSheet();
      openOrderForm(null);
      var nameEl = $('#oClient');
      var c = S.clientById(id);
      if (nameEl && c) {
        nameEl.value = c.name;
        $('#oPhone').value = c.phone;
      }
      return;
    }

    if (act === 'pay') { openPayment(id); return; }

    if (act === 'status') {
      var to = el ? el.getAttribute('data-to') : null;
      if (!to) return;
      S.updateOrder(id, { status: to });
      toast(to === 'entregado' ? 'Marcado como entregado.' : 'Pedido en proceso.');
      render();
      return;
    }

    if (act === 'delete-order') {
      if (window.confirm('¿Eliminar este pedido y sus pagos? No se puede deshacer.')) {
        S.removeOrder(id);
        closeSheet();
        render();
        toast('Pedido eliminado.');
      }
      return;
    }

    if (act === 'sin-telefono') {
      toast('Ese cliente no tiene WhatsApp guardado.');
      return;
    }

    if (act === 'step') {
      var step = el ? (Number(el.getAttribute('data-step')) || 0) : 0;
      quote.extent = P.clamp(quote.extent + step, 1, 40);
      var input = $('#qext');
      if (input) input.value = String(quote.extent);
      syncQuote();
      return;
    }

    if (act === 'quote-copy') {
      var out = $('#msgOut');
      if (!out) return;
      navigator.clipboard.writeText(out.textContent).then(function () {
        toast('Mensaje copiado.');
      }, function () {
        toast('No se pudo copiar. Selecciónalo a mano.');
      });
      return;
    }

    if (act === 'quote-save') {
      openOrderForm(null);
      var svc = $('#oService');
      var qty = $('#oQty');
      var price = $('#oPrice');
      if (svc) svc.value = quote.kind;
      if (qty) qty.value = String(quote.extent);
      if (price) price.value = String(P.suggestedPrice(quote.kind, quote.extent, quote.rush));
      return;
    }

    if (act === 'export') {
      download('relevo-panel-' + todayISO() + '.json', S.exportJSON());
      toast('Respaldo descargado.');
      return;
    }

    if (act === 'import') { importFile(); return; }

    if (act === 'seed') {
      if (window.confirm('Esto reemplaza lo que tengas con datos de ejemplo. ¿Seguir?')) {
        S.seed();
        closeSheet();
        render();
        toast('Datos de ejemplo cargados.');
      }
      return;
    }

    if (act === 'reset') {
      if (window.confirm('Se borran todos los clientes, pedidos y pagos. ¿Seguro?')) {
        S.reset();
        closeSheet();
        render();
        toast('Todo borrado.');
      }
    }
  }

  document.addEventListener('click', function (event) {
    var nav = event.target.closest('[data-view]');
    if (nav) {
      event.preventDefault();
      go(nav.getAttribute('data-view'));
      return;
    }
    var el = event.target.closest('[data-act]');
    if (!el) return;
    runAction(el.getAttribute('data-act'), el.getAttribute('data-id'), el);
  });

  viewEl.addEventListener('change', function (event) {
    var t = event.target;

    if (t.name === 'filtro') {
      state.status = t.value;
      render();
      return;
    }

    if (t.name === 'qkind') {
      quote.kind = t.value;
      quote.extent = MODEL[quote.kind].def;
      render();
      return;
    }

    if (t.name === 'qrush') {
      quote.rush = t.value;
      syncQuote();
    }
  });

  viewEl.addEventListener('input', function (event) {
    var t = event.target;

    if (t.id === 'buscar' || t.id === 'buscarC') {
      state.q = t.value;
      var pos = t.selectionStart;
      render();
      var again = document.getElementById(t.id);
      if (again) { again.focus(); again.setSelectionRange(pos, pos); }
      return;
    }

    if (t.id === 'qext') {
      quote.extent = P.clamp(Number(t.value) || 1, 1, 40);
      syncQuote();
    }
  });

  $('#newOrder').addEventListener('click', function () { closeDrawer(); openOrderForm(null); });
  var mobNew = $('#newOrderMob');
  if (mobNew) mobNew.addEventListener('click', function () { openOrderForm(null); });

  var navToggle = $('#navToggle'), navClose = $('#navClose'), navBackdrop = $('#navBackdrop');
  if (navToggle) navToggle.addEventListener('click', function () {
    if (document.body.classList.contains('is-nav-open')) closeDrawer(); else openDrawer();
  });
  if (navClose) navClose.addEventListener('click', closeDrawer);
  if (navBackdrop) navBackdrop.addEventListener('click', closeDrawer);

  $$('[data-side-act]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var act = btn.getAttribute('data-side-act');
      closeDrawer();
      if (act === 'settings') { openSettings(); return; }
      if (act === 'logout') { S.logout(); return; }
      runAction(act, null, null);
    });
  });

  var menu = null;
  $('#menuBtn').addEventListener('click', function (event) {
    event.stopPropagation();
    if (menu) { menu.remove(); menu = null; this.setAttribute('aria-expanded', 'false'); return; }

    menu = document.createElement('div');
    menu.className = 'menu';
    menu.innerHTML = (S.server ? [
      '<button type="button" data-act="export">Exportar respaldo</button>',
      '<button type="button" data-act="settings">Ajustes</button>',
      '<hr>',
      '<button type="button" data-act="logout" style="color:var(--bad)">Cerrar sesión</button>'
    ] : [
      '<button type="button" data-act="export">Exportar respaldo</button>',
      '<button type="button" data-act="import">Importar respaldo</button>',
      '<hr>',
      '<button type="button" data-act="seed">Cargar datos de ejemplo</button>',
      '<button type="button" data-act="settings">Ajustes</button>',
      '<hr>',
      '<button type="button" data-act="reset" style="color:var(--bad)">Borrar todo</button>'
    ]).join('');
    document.body.appendChild(menu);
    this.setAttribute('aria-expanded', 'true');

    menu.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      menu.remove();
      menu = null;
      $('#menuBtn').setAttribute('aria-expanded', 'false');
      if (act === 'settings') { openSettings(); return; }
      if (act === 'logout') { S.logout(); return; }
      runAction(act, null, null);
    });
  });

  document.addEventListener('click', function () {
    if (menu) { menu.remove(); menu = null; $('#menuBtn').setAttribute('aria-expanded', 'false'); }
  });

  sheet.addEventListener('click', function (event) {
    if (event.target === sheet) closeSheet();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      if (menu) { menu.remove(); menu = null; }
      closeDrawer();
    }
  });

  /* ----------------------------------------------------------------- arranque */

  function renderAuthGate() {
    document.body.classList.add('is-locked');
    viewEl.innerHTML = [
      '<section class="auth-gate">',
      '  <div class="auth-gate__card">',
      '    <h1 class="auth-gate__title">Panel de Relevo</h1>',
      '    <p class="auth-gate__sub">Ingresa tu contraseña para continuar.</p>',
      '    <form id="authForm" class="auth-gate__form">',
      '      <div class="field">',
      '        <label for="authPass">Contraseña</label>',
      '        <input id="authPass" name="password" type="password" autocomplete="current-password" required autofocus placeholder="••••••••">',
      '      </div>',
      '      <p class="auth-gate__err" id="authErr" hidden></p>',
      '      <button type="submit" class="btn btn--solid" id="authBtn">Entrar</button>',
      '    </form>',
      '  </div>',
      '</section>'
    ].join('');
    var form = $('#authForm');
    var input = $('#authPass');
    var errEl = $('#authErr');
    var btn = $('#authBtn');
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      errEl.hidden = true;
      btn.disabled = true;
      btn.textContent = 'Verificando…';
      S.login(input.value).then(function () {
        window.location.reload();
      }).catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Entrar al panel';
        errEl.textContent = err.message || 'No se pudo iniciar sesión.';
        errEl.hidden = false;
        input.focus();
        input.select();
      });
    });
  }

  if (S.authRequired) {
    renderAuthGate();
  } else {
    render();
    /* En modo servidor, los datos cambian solos (mensajes, pagos, pedidos del agente): se refrescan sin molestar. */
    if (S.server) {
      window.setInterval(function () {
        if (document.hidden || sheet.open || ['analisis', 'whatsapp', 'sistema', 'cursos', 'cms'].indexOf(state.view) >= 0) return;
        S.refresh(function () { render(); });
      }, 20000);
    }
  }
})();
