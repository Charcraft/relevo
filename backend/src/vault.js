'use strict';
// Obsidian es el panel de control: el agente lee sus instrucciones desde la bóveda
// y escribe en ella clientes, pedidos y conversaciones.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const V = (...p) => path.join(cfg.VAULT, ...p);
const safe = (s) => String(s || '').replace(/[\\/:*?"<>|#^\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
const ymd = (d = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: cfg.TZ }).format(d);
const hm = (d = new Date()) => new Intl.DateTimeFormat('es-MX', { timeZone: cfg.TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

function read(rel) {
  try { return fs.readFileSync(V(rel), 'utf8'); } catch { return ''; }
}
function write(rel, text) {
  fs.mkdirSync(path.dirname(V(rel)), { recursive: true });
  fs.writeFileSync(V(rel), text);
}

// Conocimiento del negocio, recargado cuando cambia un archivo (editar en Obsidian = cambiar al agente)
const cache = { sig: '', text: '' };
const OWNER_MEM_FILE = '10-Agente/Memoria-del-dueno.md';
const KNOWLEDGE = [
  ['00-Negocio/Producto.md', 'PRODUCTO Y POSICIONAMIENTO'],
  ['00-Negocio/Precios-y-promos.md', 'PRECIOS Y PROMOCIONES'],
  ['00-Negocio/Operacion-WhatsApp.md', 'OPERACION EN WHATSAPP'],
  ['00-Negocio/Politica-de-precios.md', 'COMO COBRA CARLOS (politica de precios real)'],
  ['00-Negocio/Casos-reales.md', 'CASOS REALES Y LECCIONES'],
  ['10-Agente/Checklist-por-tipo.md', 'QUE DATOS PEDIR SEGUN EL TRABAJO'],
  ['10-Agente/Datos-de-pago.md', 'DATOS DE PAGO (solo dar si aparecen aqui)'],
  ['10-Agente/Respuestas-rapidas.md', 'RESPUESTAS RAPIDAS APROBADAS'],
  ['10-Agente/INSTRUCCIONES.md', 'INSTRUCCIONES DEL AGENTE'],
  [OWNER_MEM_FILE, 'MEMORIA E INSTRUCCIONES PERMANENTES DEL DUENO (MAXIMA PRIORIDAD)'],
];
function knowledge() {
  const sig = KNOWLEDGE.map(([f]) => { try { const st = fs.statSync(V(f)); return `${st.mtimeMs}:${st.size}`; } catch { return 0; } }).join('|');
  if (sig === cache.sig) return cache.text;
  cache.sig = sig;
  cache.text = KNOWLEDGE.map(([f, t]) => {
    const body = read(f).trim();
    return body ? `=== ${t} ===\n${body}` : '';
  }).filter(Boolean).join('\n\n');
  return cache.text;
}

function addOwnerRule(rule) {
  const clean = String(rule || '').replace(/\s+/g, ' ').trim();
  if (!clean) return false;
  const header = '# Memoria e instrucciones permanentes del dueño\n\nReglas y órdenes dadas por Carlos por Telegram. Tienen **máxima prioridad** sobre cualquier instrucción anterior.\n\n';
  const cur = read(OWNER_MEM_FILE).trim();
  const base = cur ? cur + '\n' : header;
  if (cur.toLowerCase().includes(clean.toLowerCase())) return false;
  write(OWNER_MEM_FILE, `${base}- [${ymd()}] ${clean}\n`);
  cache.sig = '';
  return true;
}

function removeOwnerRule(match) {
  const needle = String(match || '').trim().toLowerCase();
  if (!needle) return 0;
  const cur = read(OWNER_MEM_FILE);
  if (!cur) return 0;
  const lines = cur.split('\n');
  let removed = 0;
  const kept = lines.filter((l) => {
    if (l.startsWith('- ') && l.toLowerCase().includes(needle)) { removed++; return false; }
    return true;
  });
  if (removed > 0) {
    write(OWNER_MEM_FILE, kept.join('\n').replace(/\n{3,}/g, '\n\n'));
    cache.sig = '';
  }
  return removed;
}

function frontmatter(obj) {
  return '---\n' + Object.entries(obj).map(([k, v]) => `${k}: ${v === null || v === undefined ? '' : JSON.stringify(v)}`).join('\n') + '\n---\n';
}
function upsertNote(rel, fm, bodyIfNew) {
  const cur = read(rel);
  if (!cur) return write(rel, frontmatter(fm) + bodyIfNew);
  // conserva el cuerpo que el dueño haya editado; solo refresca el frontmatter
  const body = cur.replace(/^---\n[\s\S]*?\n---\n?/, '');
  write(rel, frontmatter(fm) + body);
}

module.exports = {
  ymd, hm, knowledge, read, write, OWNER_MEM_FILE, addOwnerRule, removeOwnerRule,
  readOwnerRules: () => read(OWNER_MEM_FILE),
  clientFile: (c) => `20-Clientes/${safe(c.name) || c.phone} (${String(c.phone || '').slice(-4)}).md`,
  syncClient(c) {
    upsertNote(this.clientFile(c), {
      tipo: 'cliente', nombre: c.name || '', whatsapp: c.phone || '', institucion: c.institucion || '', nivel: c.nivel || '', origen: c.origen || '', etiquetas: (c.tags || '').split(',').filter(Boolean),
      primer_contacto: ymd(new Date(c.first_seen || Date.now())), id: c.id,
    }, `## Notas\n${c.notes || ''}\n\n## Pedidos\n(ver 30-Pedidos)\n`);
  },
  syncOrder(o, c) {
    const rel = `30-Pedidos/P-${String(o.id).padStart(4, '0')} ${safe(c.name) || c.phone}.md`;
    upsertNote(rel, {
      tipo: 'pedido', id: o.id, cliente: `[[${path.basename(this.clientFile(c), '.md')}]]`, servicio: o.servicio, tamano: o.tamano,
      entrega: o.entrega, rango: o.rango_min != null ? `${o.rango_min}-${o.rango_max}` : '', precio: o.precio,
      pagado: o.pagado || 0, estado: o.estado, etapa: o.etapa, origen: o.origen || '', materia: o.materia || '', cantidad: o.cantidad || '',
    }, `## Requisitos del cliente\n${o.notas || ''}\n\n## Avances\n`);
  },
  logMessage(c, dir, text, by) {
    const rel = `40-Conversaciones/${ymd()}.md`;
    const who = dir === 'in' ? (c.name || c.phone) : (by === 'dueno' ? 'Dueño→' + (c.name || c.phone) : 'Agente→' + (c.name || c.phone));
    const line = `- ${hm()} **${who}**: ${String(text).replace(/\n+/g, ' ⏎ ')}\n`;
    const cur = read(rel);
    write(rel, (cur || `# Conversaciones ${ymd()}\n\n`) + line);
  },
  writeStatus(lines) {
    write('10-Agente/Estado.md', `# Estado del sistema\n_actualizado ${ymd()} ${hm()}_\n\n${lines.map((l) => '- ' + l).join('\n')}\n`);
  },
  writeReport(name, md) { write(`50-Reportes/${name}.md`, md); },
};

