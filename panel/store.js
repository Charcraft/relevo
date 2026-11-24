/* ==========================================================================
   Relevo · panel · almacenamiento
   Capa de datos con una sola interfaz. Hoy guarda en localStorage.
   Cuando conectemos Supabase, se cambia este archivo y nada más.
   ========================================================================== */

(function () {
  'use strict';

  var KEY = 'relevo.panel.v1';
  var VERSION = 1;

  function uid(prefix) {
    return prefix + Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 7);
  }

  function blank() {
    return {
      v: VERSION,
      clients: [],
      orders: [],
      payments: [],
      events: [],
      settings: { negocio: 'Relevo', recordatorioPagoDias: 3, notaPago: '', demo: false },
      savedAt: null
    };
  }

  /* ---------------------------------------------------------- modo servidor
     Si el panel se abre desde el servidor de Relevo (http://…:8787/panel/), los datos viven en la
     base del agente: clientes de WhatsApp, pedidos, pagos y visitas. Si no hay API (Vercel, archivo
     local), todo sigue funcionando con localStorage como antes. */
  var SERVER = false;
  var AUTH_REQUIRED = false;
  var snap = { clients: {}, orders: {}, payments: {} };
  var lastRev = null;
  var queue = Promise.resolve();

  function loadServer() {
    if (!/^https?:$/.test(window.location.protocol)) return null;
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/api/state', false);
      x.send();
      var ct = String(x.getResponseHeader('content-type') || '');
      if (x.status === 401 && ct.indexOf('json') >= 0) {
        var errBody = JSON.parse(x.responseText);
        if (errBody && errBody.authRequired) {
          SERVER = true;
          AUTH_REQUIRED = true;
          return blank();
        }
      }
      if (x.status !== 200 || ct.indexOf('json') < 0) return null;
      var d = JSON.parse(x.responseText);
      if (!d || !Array.isArray(d.clients)) return null;
      SERVER = true;
      AUTH_REQUIRED = false;
      lastRev = d.meta && d.meta.rev;
      return d;
    } catch (err) { return null; }
  }

  function login(password) {
    return fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: String(password || '') })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
        return d;
      });
    });
  }

  function logout() {
    return fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
      .catch(function () {})
      .then(function () { window.location.reload(); });
  }

  function takeSnap(d) {
    ['clients', 'orders', 'payments'].forEach(function (k) {
      snap[k] = {};
      d[k].forEach(function (e) { snap[k][e.id] = JSON.stringify(e); });
    });
  }

  function send(method, url, body) {
    queue = queue.then(function () {
      return fetch(url, { method: method, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
        .then(function (r) {
          if (r.status === 401) { window.location.reload(); throw new Error('Sesión expirada'); }
          if (!r.ok) throw new Error('HTTP ' + r.status);
        });
    }).catch(function (err) {
      window.console.error('[panel] no se pudo guardar en el servidor:', err);
      window.alert('No se pudo guardar en el servidor. Recarga la página.');
    });
  }

  function syncServer() {
    var map = { clients: 'client', orders: 'order', payments: 'payment' };
    ['clients', 'orders', 'payments'].forEach(function (k) {
      var seen = {};
      db[k].forEach(function (e) {
        seen[e.id] = true;
        var s = JSON.stringify(e);
        if (snap[k][e.id] !== s) { snap[k][e.id] = s; send('PUT', '/api/entity/' + map[k], e); }
      });
      Object.keys(snap[k]).forEach(function (id) {
        if (!seen[id]) {
          delete snap[k][id];
          if (k === 'orders') send('DELETE', '/api/entity/order/' + encodeURIComponent(id));
        }
      });
    });
  }

  function refreshServer(done) {
    if (!SERVER || AUTH_REQUIRED) return;
    fetch('/api/rev', { credentials: 'same-origin' }).then(function (r) {
      if (r.status === 401) { window.location.reload(); return null; }
      return r.json();
    }).then(function (r) {
      if (!r || r.rev === lastRev) return null;
      return fetch('/api/state', { credentials: 'same-origin' }).then(function (x) { return x.json(); });
    }).then(function (d) {
      if (!d) return;
      lastRev = d.meta && d.meta.rev;
      db = d; takeSnap(d);
      if (done) done();
    }).catch(function () {});
  }

  function read() {
    var fromServer = loadServer();
    if (fromServer) { takeSnap(fromServer); return fromServer; }
    try {
      var raw = window.localStorage.getItem(KEY);
      if (!raw) return blank();
      var data = JSON.parse(raw);
      if (!data || data.v !== VERSION) return blank();
      ['clients', 'orders', 'payments', 'events'].forEach(function (k) {
        if (!Array.isArray(data[k])) data[k] = [];
      });
      if (!data.settings) data.settings = blank().settings;
      return data;
    } catch (err) {
      return blank();
    }
  }

  var db = read();

  function persist() {
    db.savedAt = new Date().toISOString();
    if (SERVER) { syncServer(); return; }
    try {
      window.localStorage.setItem(KEY, JSON.stringify(db));
    } catch (err) {
      window.alert('No se pudo guardar. El almacenamiento del navegador está lleno o bloqueado.');
    }
  }

  /* ------------------------------------------------------------- consultas */

  function clientById(id) {
    for (var i = 0; i < db.clients.length; i += 1) {
      if (db.clients[i].id === id) return db.clients[i];
    }
    return null;
  }

  function orderById(id) {
    for (var i = 0; i < db.orders.length; i += 1) {
      if (db.orders[i].id === id) return db.orders[i];
    }
    return null;
  }

  function ordersOf(clientId) {
    return db.orders.filter(function (o) { return o.clientId === clientId; });
  }

  function paidOf(orderId) {
    return db.payments.reduce(function (sum, p) {
      return p.orderId === orderId ? sum + (Number(p.amount) || 0) : sum;
    }, 0);
  }

  function balanceOf(order) {
    return Math.max(0, (Number(order.price) || 0) - paidOf(order.id));
  }

  function totalPaidOf(clientId) {
    return ordersOf(clientId).reduce(function (sum, o) {
      return sum + paidOf(o.id);
    }, 0);
  }

  function debtOf(clientId) {
    return ordersOf(clientId).reduce(function (sum, o) {
      if (o.status === 'cancelado') return sum;
      return sum + balanceOf(o);
    }, 0);
  }

  /* ------------------------------------------------------------- escritura */

  function addClient(data) {
    var client = {
      id: uid('c'),
      name: (data.name || '').trim(),
      phone: (data.phone || '').replace(/\D/g, ''),
      tags: data.tags || [],
      notes: data.notes || '',
      createdAt: new Date().toISOString()
    };
    if (!client.name) return null;
    db.clients.push(client);
    persist();
    return client;
  }

  function updateClient(id, patch) {
    var client = clientById(id);
    if (!client) return null;
    Object.keys(patch).forEach(function (k) { client[k] = patch[k]; });
    persist();
    return client;
  }

  function findClientByPhone(phone) {
    var digits = String(phone || '').replace(/\D/g, '');
    if (digits.length < 7) return null;
    for (var i = 0; i < db.clients.length; i += 1) {
      if (db.clients[i].phone === digits) return db.clients[i];
    }
    return null;
  }

  function addOrder(data) {
    var order = {
      id: uid('o'),
      clientId: data.clientId,
      service: data.service || 'ensayo',
      qty: Number(data.qty) || 0,
      subject: (data.subject || '').trim(),
      due: data.due || '',
      price: Number(data.price) || 0,
      status: data.status || 'nuevo',
      source: data.source || 'manual',
      notes: data.notes || '',
      createdAt: new Date().toISOString(),
      deliveredAt: null
    };
    db.orders.push(order);
    if (Number(data.anticipo) > 0) {
      db.payments.push({
        id: uid('p'),
        orderId: order.id,
        amount: Number(data.anticipo),
        method: data.method || 'efectivo',
        at: new Date().toISOString(),
        note: 'Anticipo'
      });
    }
    persist();
    return order;
  }

  function updateOrder(id, patch) {
    var order = orderById(id);
    if (!order) return null;
    Object.keys(patch).forEach(function (k) { order[k] = patch[k]; });
    if (patch.status === 'entregado' && !order.deliveredAt) {
      order.deliveredAt = new Date().toISOString();
    }
    persist();
    return order;
  }

  function removeOrder(id) {
    db.orders = db.orders.filter(function (o) { return o.id !== id; });
    db.payments = db.payments.filter(function (p) { return p.orderId !== id; });
    persist();
  }

  function addPayment(data) {
    var amount = Number(data.amount) || 0;
    if (amount <= 0) return null;
    var payment = {
      id: uid('p'),
      orderId: data.orderId,
      amount: amount,
      method: data.method || 'efectivo',
      at: new Date().toISOString(),
      note: data.note || ''
    };
    db.payments.push(payment);
    var order = orderById(data.orderId);
    if (order && balanceOf(order) === 0 && order.status !== 'cancelado') {
      order.status = 'pagado';
    }
    persist();
    return payment;
  }

  /* ------------------------------------------------------------- respaldo */

  function exportJSON() {
    return JSON.stringify(db, null, 2);
  }

  function guardServer(what) {
    if (!SERVER) return false;
    window.alert('Con el panel conectado al servidor no se puede ' + what + ': borraría los clientes y pedidos reales de WhatsApp.');
    return true;
  }

  function importJSON(text) {
    if (guardServer('importar un respaldo')) return db;
    var data = JSON.parse(text);
    if (!data || !Array.isArray(data.clients) || !Array.isArray(data.orders)) {
      throw new Error('El archivo no tiene la forma del panel.');
    }
    db = {
      v: VERSION,
      clients: data.clients,
      orders: data.orders,
      payments: Array.isArray(data.payments) ? data.payments : [],
      events: Array.isArray(data.events) ? data.events : [],
      settings: data.settings || blank().settings,
      savedAt: data.savedAt || null
    };
    persist();
    return db;
  }

  function reset() {
    if (guardServer('borrar todo')) return;
    db = blank();
    persist();
  }

  /* --------------------------------------------------------- datos de ejemplo */

  function seed() {
    if (guardServer('cargar datos de ejemplo')) return db;
    db = blank();
    db.settings.demo = true;
    var hoy = new Date();
    var iso = function (offsetDays) {
      var d = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + offsetDays);
      return d.toISOString().slice(0, 10);
    };

    var ana = addClient({ name: 'Ana Ruiz', phone: '5215550001001', tags: ['recurrente'], notes: 'Maestría en educación. Pide APA.' });
    var luis = addClient({ name: 'Luis Mena', phone: '5215550001002', tags: [], notes: 'Trabaja de noche, contesta después de las 9.' });
    var paola = addClient({ name: 'Paola Cerdán', phone: '5215550001003', tags: ['curso'], notes: 'Cambridge One, nivel B1.' });
    var jorge = addClient({ name: 'Jorge Aguilar', phone: '5215550001004', tags: [], notes: '' });

    addOrder({ clientId: ana.id, service: 'ensayo', qty: 6, subject: 'Educación inclusiva en secundaria', due: iso(0), price: 200, status: 'en_proceso', source: 'web' });
    addOrder({ clientId: luis.id, service: 'presentacion', qty: 12, subject: 'Modelo de negocio para cafetería', due: iso(-2), price: 170, status: 'en_proceso', source: 'web' });
    addOrder({ clientId: paola.id, service: 'cambridge', qty: 5, subject: 'Unidades 4 a 8', due: iso(3), price: 140, status: 'nuevo', source: 'whatsapp' });
    addOrder({ clientId: jorge.id, service: 'formato', qty: 20, subject: 'Tesis, capítulo 3', due: iso(1), price: 90, status: 'nuevo', source: 'instagram' });

    var entregado = addOrder({ clientId: ana.id, service: 'tarea', qty: 4, subject: 'Foro de investigación educativa', due: iso(-6), price: 110, status: 'entregado', source: 'whatsapp' });
    addPayment({ orderId: entregado.id, amount: 60, method: 'transferencia', note: 'Anticipo' });

    var pagado = addOrder({ clientId: luis.id, service: 'ensayo', qty: 4, subject: 'Reseña de "Pedagogía del oprimido"', due: iso(-12), price: 150, status: 'entregado', source: 'web' });
    addPayment({ orderId: pagado.id, amount: 150, method: 'efectivo' });

    var viejo = addOrder({ clientId: jorge.id, service: 'presentacion', qty: 8, subject: 'Exposición de estadística', due: iso(-20), price: 130, status: 'entregado', source: 'web' });
    addPayment({ orderId: viejo.id, amount: 50, method: 'efectivo', note: 'Anticipo' });

    /* Tráfico de ejemplo: se distingue del real por la bandera settings.demo. */
    var fuentes = ['instagram', 'whatsapp', 'directo', 'flyer', 'instagram', 'directo'];
    for (var d = 13; d >= 0; d -= 1) {
      var visitas = 6 + Math.round(Math.abs(Math.sin(d * 1.7)) * 22);
      for (var v = 0; v < visitas; v += 1) {
        db.events.push({
          id: uid('e'),
          type: 'page',
          path: '/',
          src: fuentes[(d + v) % fuentes.length],
          at: new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - d, 9 + (v % 12), (v * 7) % 60).toISOString()
        });
      }
      var clics = Math.max(0, Math.round(visitas * 0.18) - (d % 5 === 0 ? 1 : 0));
      for (var w = 0; w < clics; w += 1) {
        db.events.push({
          id: uid('e'),
          type: 'wa',
          path: '/',
          src: fuentes[(d + w) % fuentes.length],
          at: new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - d, 11 + (w % 10), (w * 13) % 60).toISOString()
        });
      }
    }

    persist();
    return db;
  }

  window.PanelStore = {
    get data() { return db; },
    get server() { return SERVER; },
    get authRequired() { return AUTH_REQUIRED; },
    login: login,
    logout: logout,
    refresh: refreshServer,
    save: persist,
    clientById: clientById,
    orderById: orderById,
    ordersOf: ordersOf,
    paidOf: paidOf,
    balanceOf: balanceOf,
    totalPaidOf: totalPaidOf,
    debtOf: debtOf,
    addClient: addClient,
    updateClient: updateClient,
    findClientByPhone: findClientByPhone,
    addOrder: addOrder,
    updateOrder: updateOrder,
    removeOrder: removeOrder,
    addPayment: addPayment,
    exportJSON: exportJSON,
    importJSON: importJSON,
    reset: reset,
    seed: seed
  };
})();
