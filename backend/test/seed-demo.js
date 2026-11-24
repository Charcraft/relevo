'use strict';
// Genera una base de datos SQLite y bóveda CMS con datos 100% ficticios para probar
// todo el flujo de Relevo localmente (landing -> tracker -> SQLite -> dashboard -> CMS API).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataDir = path.resolve(__dirname, '../data');
const vaultDir = path.resolve(__dirname, '../vault-demo');
process.env.RELEVO_DATA = dataDir;
process.env.RELEVO_VAULT = vaultDir;
process.env.RELEVO_AUTH_FILE = path.join(dataDir, 'panel-auth.json');

// Reiniciar DB demo limpia
fs.mkdirSync(dataDir, { recursive: true });
for (const ext of ['', '-wal', '-shm']) {
  const f = path.join(dataDir, 'relevo.db' + ext);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

const db = require('../src/db');

const isoOffset = (days) => {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
};

// 1) Clientes ficticios
const c1 = db.createClient({ name: 'Sofía Mendoza', phone: '5215550101001', wa_id: '5215550101001@c.us', institucion: 'Universidad Demo Norte', nivel: 'licenciatura', origen: 'instagram', notes: 'Prefiere entregas en Word con APA 7.' });
const c2 = db.createClient({ name: 'Diego Morales', phone: '5215550101002', wa_id: '5215550101002@c.us', institucion: 'Instituto Tecnológico Sur', nivel: 'ingenieria', origen: 'flyer', notes: 'Solicita presentaciones técnicas.' });
const c3 = db.createClient({ name: 'Valeria Cruz', phone: '5215550101003', wa_id: '5215550101003@c.us', institucion: 'Facultad de Salud Demo', nivel: 'posgrado', origen: 'recomendacion', notes: 'Cursos de actualización en línea.' });
const c4 = db.createClient({ name: 'Andrés Herrera', phone: '5215550101004', wa_id: '5215550101004@c.us', institucion: 'Universidad Demo Norte', nivel: 'licenciatura', origen: 'web', notes: 'Llegó por el cotizador del sitio.' });

// 2) Pedidos y pagos ficticios
const o1 = db.createOrder(c1.id, { servicio: 'ensayo', tamano: '6 cuartillas', asunto: 'Impacto de la automatización en PyMEs', entrega: isoOffset(-9), precio: 180, estado: 'entregado', etapa: 'confirmado', source: 'instagram' });
db.addPayment(o1.id, 180, { method: 'transferencia', note: 'Liquidado contra borrador' });

const o2 = db.createOrder(c2.id, { servicio: 'presentacion', tamano: '14 diapositivas', asunto: 'Arquitectura de microservicios', entrega: isoOffset(-4), precio: 160, estado: 'entregado', etapa: 'confirmado', source: 'flyer' });
db.addPayment(o2.id, 160, { method: 'transferencia', note: 'Pago completo' });

const o3 = db.createOrder(c1.id, { servicio: 'formato', tamano: '25 páginas', asunto: 'Formato APA 7 para capítulo 2 de tesis', entrega: isoOffset(0), precio: 120, estado: 'en_proceso', etapa: 'confirmado', source: 'instagram' });
db.addPayment(o3.id, 60, { method: 'transferencia', note: 'Anticipo 50%' });

const o4 = db.createOrder(c4.id, { servicio: 'tarea', tamano: '4 ejercicios', asunto: 'Análisis de complejidad algorítmica', entrega: isoOffset(-1), precio: 110, estado: 'entregado', etapa: 'confirmado', source: 'web' });

const o5 = db.createOrder(c3.id, { servicio: 'curso', tamano: '3 módulos', asunto: 'Curso en línea de gestión hospitalaria (demo)', entrega: isoOffset(4), precio: 250, estado: 'nuevo', etapa: 'cotizado', source: 'recomendacion' });

// 3) Historial de conversación demo + 1 pendiente
db.addMessage(c1.id, 'in', 'Hola, necesito ajustar las citas APA de mi capítulo 2 para hoy.', { by: 'cliente' });
db.addMessage(c1.id, 'out', 'Hola Sofía. Claro, queda listo hoy mismo y te comparto el borrador antes del pago final.', { by: 'agente' });
db.markClientAttended(c1.id);

db.addMessage(c4.id, 'in', 'Hola, ya revisé el borrador y quedó muy bien. Me pasas los datos para transferir.', { by: 'cliente' });
db.addPending(c4.id, 'Claro Andrés, te comparto los datos de transferencia para cerrar el pedido #' + o4.id + ' por $110.', 'Confirmación de datos de pago');

// 4) Trabajo de curso demo
db.upsertCourseJob(o5.id, {
  client_id: c3.id,
  email: 'demo.student@example.com',
  status: 'en_espera',
  step: 'Esperando confirmación de acceso para iniciar módulo 1 (demo)',
  targets: JSON.stringify([{ platform: 'lms-demo', name: 'Módulo 1 · Gestión y normativa', url: 'https://lms.example.com/course/101' }]),
});

// 5) Telemetría sintética de 14 días (simula POST /t desde web/)
const sources = ['instagram', 'flyer', 'directo', 'recomendacion', 'web'];
const stmtEv = db.raw.prepare('INSERT INTO events(type, path, src, at) VALUES (?, ?, ?, ?)');
for (let d = 13; d >= 0; d--) {
  const visits = 8 + ((d * 5) % 14);
  for (let i = 0; i < visits; i++) {
    const ts = Date.now() - d * 86400000 - (i * 1800000);
    const src = sources[(d + i) % sources.length];
    stmtEv.run('page', '/', src, ts);
    if (i % 4 === 0) stmtEv.run('wa', '/', src, ts + 45000);
  }
}

// 6) Bóveda CMS demo (60-CMS/) + conocimiento base
const cmsDir = path.join(vaultDir, '60-CMS');
fs.mkdirSync(cmsDir, { recursive: true });
fs.writeFileSync(path.join(cmsDir, '_site.json'), JSON.stringify({
  negocio: 'Relevo (Demo)',
  tagline: 'Plataforma operativa, dashboard y CMS personal.',
  promo_activa: true,
  codigo_promo: 'DEMO20',
  descuento_pct: 20,
  aviso_banner: '20% de descuento en tu primer pedido con el código DEMO20',
  whatsapp: '+52 000 000 0000',
  instagram: '@relevo.demo',
  web: 'http://127.0.0.1:8787',
  precios_resumen: 'Trabajos $50 a $250 MXN · Cursos desde $100 MXN',
  updatedAt: new Date().toISOString(),
}, null, 2));

fs.writeFileSync(path.join(cmsDir, 'como-funciona-relevo.md'), [
  '---',
  'title: Cómo funciona la arquitectura de datos de Relevo',
  'category: arquitectura',
  'status: publicado',
  'tags: demo, cms, api',
  'updated: ' + new Date().toISOString(),
  '---',
  '',
  'Esta entrada tiene visibilidad **publicado**, por lo que aparece automáticamente en `GET /api/cms/public` sin exponer datos privados de clientes.',
].join('\n'));

fs.writeFileSync(path.join(cmsDir, 'notas-internas-demo.md'), [
  '---',
  'title: Checklist de campaña semanal',
  'category: operacion',
  'status: privado',
  'tags: interno, marketing',
  'updated: ' + new Date().toISOString(),
  '---',
  '',
  '- Revisar embudo de conversión en **Análisis**.',
  '- Exportar reporte CSV de pedidos activos.',
].join('\n'));

// 7) Credenciales demo para el listener público (:8789)
const demoPass = 'demo1234';
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(demoPass, salt, 64).toString('hex');
const secret = crypto.randomBytes(32).toString('hex');
const demoApiKey = 'rl_demo_' + crypto.randomBytes(16).toString('hex');
const apiTokenHash = crypto.createHash('sha256').update(demoApiKey).digest('hex');

fs.writeFileSync(path.join(dataDir, 'panel-auth.json'), JSON.stringify({
  v: 1, salt, hash, secret, apiTokenHash,
  apiTokenPrefix: demoApiKey.slice(0, 12) + '…',
  apiTokenUpdatedAt: new Date().toISOString(),
}, null, 2), { mode: 0o600 });

console.log('Demo seed completado en:', dataDir);
console.log('  Contraseña panel público (:8789):', demoPass);
console.log('  API Key CMS demo:', demoApiKey);
