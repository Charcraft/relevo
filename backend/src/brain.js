'use strict';
const cfg = require('./config');
const db = require('./db');
const vault = require('./vault');
const guard = require('./guard');
const llm = require('./llm');

const todayStr = () => new Intl.DateTimeFormat('sv-SE', { timeZone: cfg.TZ }).format(new Date());
const dowStr = () => new Intl.DateTimeFormat('es-MX', { timeZone: cfg.TZ, weekday: 'long' }).format(new Date());

const CONTRACT = `
FORMATO DE SALIDA (obligatorio): responde UNICAMENTE un objeto JSON, sin texto antes ni despues:
{
  "intent": "saludo|cotizar|datos|pago|entrega|revision|curso|queja|otro",
  "reply": "lo que se le escribe al cliente. Texto plano. Separa en maximo 3 mensajes cortos con una linea en blanco. Vacio si no hay que responder.",
  "order": null | {"id": numero-o-null, "servicio": "ensayo|presentacion|formato|cambridge|tarea|curso", "tamano": "texto corto, ej 5 paginas", "cantidad": numero (paginas, diapositivas o actividades), "asunto": "de que trata el trabajo", "materia": "materia o curso", "entrega": "YYYY-MM-DD o null", "rango_min": numero, "rango_max": numero, "precio": numero-o-null, "notas": "requisitos del cliente", "etapa": "cotizando|cotizado|anticipo-reportado"},
  "client": {"institucion": "escuela, universidad o empresa si la dijo, si no vacio", "nivel": "secundaria|preparatoria|licenciatura|posgrado|profesional|curso-en-linea|otro, o vacio", "tipo": "estudiante|profesional|otro, o vacio"},
  "origen": "flyer|instagram|web|recomendacion|directo (como conocio Relevo; null si no se sabe)",
  "cotizo_con_dueno": true | false | null  (true si el cliente dice que YA hablo con Carlos de este trabajo; false si dice que no; null si aun no se sabe),
  "precio_declarado": numero | null  (lo que el cliente dice que Carlos le cotizo, si lo dijo),
  "dueno_dijo": "lo que el cliente cuenta que hablo con Carlos (que incluye, plazo), o vacio",
  "client_notes": "dato util para recordar del cliente, o vacio",
  "escalate": false,
  "reason": "si escalate es true, por que"
}
REGLAS DURAS (el sistema las verifica aparte, pero cumplelas):
- Las reglas en MEMORIA E INSTRUCCIONES PERMANENTES DEL DUENO tienen MAXIMA PRIORIDAD sobre cualquier otra guia. Cumplelas al pie de la letra.
- Tono: espanol latino, tranquilo, sin signos de exclamacion, sin rayas largas, sin hype. Mensajes cortos, como una persona desde el telefono.
- TRATO DE USTED: Si las notas del cliente dicen "usted", "edad grande" o "adulto mayor", tratalo SIEMPRE de USTED con mucha amabilidad y paciencia (nunca tuteo). En los demas casos usa tuteo.
- Solo rangos de precio publicados. Precio cerrado solo cuando el alcance esta acordado y esta en los rangos.
- Nunca des gratis ningun trabajo pase lo que pase.
- Nunca prometas indetectable ni calificaciones. Nunca inventes testimonios ni cifras.
- Datos de pago: solo los que aparezcan en DATOS DE PAGO. Si no hay, di que se los pasas en un momento y marca escalate true.
- ANTES de cotizar a un cliente nuevo o a un trabajo nuevo, pregunta una vez si ya hablo con Carlos de ese trabajo y en cuanto quedaron. Si dice que si: NO cotices otro precio ni des datos de pago; registra cotizo_con_dueno true, precio_declarado y dueno_dijo, y di que lo confirmas con Carlos. Si dice que no: cotiza tu con la politica de precios.
- Cursos, plataformas y cuentas: reune lo basico (curso o plataforma, el link, cuantos cursos son, hasta donde va, fecha limite), dile que Carlos lo revisa y marca escalate true. No te niegues ni des sermones.
- Si el cliente dice que ya pago, agradece y di que lo confirmas; no marques como pagado.
- Si falta informacion para cotizar, pregunta lo que falta: actividad o archivo, cuantas paginas o actividades, y para que dia.
- Si no sabes algo, escalate true. Mejor avisar al dueno que inventar.
`;

const S = require('./settings');
function params() {
  return `PARAMETROS ACTUALES (los cambia el dueno desde el panel y mandan sobre cualquier otro texto):
- Precio base por trabajo: $${S.get('base_price')}. Piso $${S.get('price_floor')}. Tope $${S.get('price_ceiling')}. Urgente y complejo: $${S.get('urgent_price')}.
- Metodo de pago: ${S.get('payment_method')}. ${S.get('pay_after_draft') ? 'Se manda el borrador primero y se paga al aprobarlo.' : 'Se cobra antes de empezar.'}
- ${S.get('ask_if_quoted_with_owner') ? 'Antes de cotizar, pregunta una vez si ya hablo con Carlos del trabajo.' : 'No hace falta preguntar si ya hablo con Carlos.'}`;
}

function systemPrompt() {
  return `Eres el asistente de WhatsApp de Relevo. Atiendes a los clientes en nombre del negocio.\n\n${vault.knowledge()}\n\n${params()}\n\n${CONTRACT}`;
}

function context(client, inbound, openOrders, hist) {
  const orders = openOrders.map((o) => ({ id: o.id, servicio: o.servicio, tamano: o.tamano, entrega: o.entrega, rango: [o.rango_min, o.rango_max], precio: o.precio, estado: o.estado, etapa: o.etapa, pagado: o.pagado, notas: o.notas }));
  return `Hoy es ${dowStr()} ${todayStr()} (zona ${cfg.TZ}).
CLIENTE: id ${client.id}, nombre "${client.name || 'sin nombre'}", telefono ${client.phone}, ${client.isNew ? 'PRIMER CONTACTO' : 'cliente conocido'}. Institucion: ${client.institucion || '?'}. Nivel: ${client.nivel || '?'}. Origen: ${client.origen || '?'}. Notas: ${client.notes || '-'}
PEDIDOS ABIERTOS: ${JSON.stringify(orders)}
HISTORIAL RECIENTE:
${hist.map((m) => `${m.dir === 'in' ? 'Cliente' : 'Relevo'}: ${m.body}${m.media_path ? ' [archivo adjunto]' : ''}`).join('\n') || '(vacio)'}
MENSAJES NUEVOS DEL CLIENTE (responde a estos):
${inbound.map((m) => m.body + (m.hasMedia ? ' [adjunto: ' + (m.mediaName || 'archivo') + ']' : '')).join('\n')}`;
}

async function decide(client, inbound) {
  const text = inbound.map((m) => m.body).join('\n');
  const pre = guard.preCheck(text);
  if (pre) return { ...guard.postCheck({ ...pre, order: null }, text), tier: 'regla', model: 'regla-fija', notifyOwner: true };

  const openOrders = db.openOrders(client.id);
  const tier = guard.routeTier(text, { hasMedia: inbound.some((m) => m.hasMedia), isNew: client.isNew, openOrders });
  const hist = db.history(client.id, 24);
  const histOld = hist.slice(0, Math.max(0, hist.length - inbound.length));

  let res;
  try {
    res = await llm.chat({
      tier, system: systemPrompt(), maxTokens: 900,
      messages: [{ role: 'user', content: context(client, inbound, openOrders, histOld) }],
    });
  } catch (e) {
    return { intent: 'otro', reply: guard.FIXED.hold, escalate: true, reason: 'Modelo no disponible: ' + e.message.slice(0, 120), order: null, notifyOwner: true, tier, model: 'ninguno', holdOnly: true, flags: [] };
  }
  let d;
  try { d = llm.parseJson(res.text); }
  catch { return { intent: 'otro', reply: guard.FIXED.hold, escalate: true, reason: 'Respuesta del modelo ilegible', order: null, notifyOwner: true, tier, model: res.model, holdOnly: true, flags: [] }; }

  const out = guard.postCheck(d, text);
  return { ...out, tier, model: res.model };
}

function formatOwnerHist(hist) {
  if (!hist || !hist.length) return '(sin mensajes previos en este chat)';
  return hist.map((m) => {
    const d = new Date(m.ts);
    const stamp = `${vault.ymd(d)} ${vault.hm(d)}`;
    const who = m.dir === 'in' ? 'Carlos' : 'Agente';
    const body = String(m.body || '').replace(/\s+/g, ' ').slice(0, 650);
    return `[${stamp}] ${who}: ${body}`;
  }).join('\n');
}

async function ownerChat(userText, snapshot, ownerHist = []) {
  const system = `Eres el asistente operativo de Relevo hablando directo con Carlos (el dueño) por Telegram.
Sé breve, claro, directo y en español latino con tuteo.
Hoy es ${dowStr()} ${todayStr()} (zona ${cfg.TZ}).

ACCIONES DISPONIBLES (se ejecutan automáticamente en cuanto las devuelves en "actions"):
1. Guardar regla o instrucción permanente (aplica siempre en WhatsApp y Telegram):
   {"type":"remember","rule":"texto claro, completo y concreto de la regla o dato permanente"}
2. Borrar una regla permanente guardada:
   {"type":"forget_rule","match":"palabra o frase clave"}
3. Crear un cliente nuevo (o actualizar si ya existe ese teléfono):
   {"type":"create_client","name":"Nombre","phone":"+52...","institucion":"","nivel":"","tipo":"estudiante|profesional","origen":"directo","notes":""}
4. Crear un pedido nuevo (si el cliente no existe aún, pásale client_name y phone y se crea solo):
   {"type":"create_order","client":"id, nombre o telefono","client_name":"Nombre si es nuevo","phone":"telefono si es nuevo","servicio":"ensayo|presentacion|formato|cambridge|tarea|curso","tamano":"descripcion corta","asunto":"de que trata","materia":"","entrega":"YYYY-MM-DD o vacio","precio":100,"estado":"nuevo|en_proceso|entregado|pagado|cancelado","notas":""}
5. Editar un PEDIDO existente (SOLO usar con el ID de un PEDIDO, NUNCA confundir con PENDIENTE):
   {"type":"order","id":N,"fields":{"estado":"nuevo|en_proceso|entregado|pagado|cancelado","precio":N,"entrega":"YYYY-MM-DD","costo":N,"horas":N,"notas":"..."}}
6. Registrar un pago (SOLO si Carlos confirma que YA recibió el dinero):
   {"type":"payment","order":N,"amount":N,"method":"transferencia|efectivo"}
7. Cerrar/descartar un PENDIENTE de decisión (tabla pending, ej. PENDIENTE #1 o #2):
   {"type":"close_pending","id":N,"status":"descartado"}   (también acepta "id":"all" o "client":"nombre/id")
8. Aprobar y enviar un PENDIENTE de decisión:
   {"type":"approve_pending","id":N,"text":"opcional texto editado"}
9. Marcar un cliente como ya atendido (lo quita de "esperando respuesta" y detiene alertas):
   {"type":"mark_attended","client":"id, nombre o telefono","close_pendings":true}
10. Guardar una nota en un cliente existente:
   {"type":"note","client":"id, nombre o telefono","text":"nota"}
11. Enviar un mensaje de WhatsApp a un cliente o contacto (ej. "jefe"):
   {"type":"send_wa","client":"id, nombre, telefono o jefe","text":"mensaje en tono Relevo sin exclamaciones ni rayas largas"}
12. Ignorar o dejar de ignorar un WhatsApp ID en respuestas automáticas (NUNCA quites a Jefe OWNER_WA_ID@lid solo para leer mensajes; usa read_wa):
   {"type":"set_ignore","wa_id":"OWNER_WA_ID@lid","ignore":false}
13. Actualizar credenciales de un curso y/o reanudar su navegador en el servidor:
   {"type":"course_update","order":N,"email":"","siesabi_pass":"","ops_pass":"","curp":"","resume":true}
14. Reanudar o pausar la ejecución de un curso en el navegador del servidor:
   {"type":"course_resume","order":N,"mode":"resume|run"} / {"type":"course_stop","order":N}
15. Pausar o reanudar el agente de WhatsApp:
   {"type":"pause"} / {"type":"resume"}
16. Leer últimos mensajes de un chat o grupo de WhatsApp (SIN quitar de ignore_ids):
   {"type":"read_wa","client":"jefe o nombre/grupo","limit":10}
17. Unirse a un grupo de WhatsApp con enlace o listar grupos actuales:
   {"type":"join_group","url":"https://chat.whatsapp.com/..."} / {"type":"list_groups"}
18. Enviar una imagen, video o archivo de Relevo por WhatsApp (a cliente, contacto o grupo; usa asDocument:false para fotos/videos visibles):
   {"type":"send_wa_file","client":"nombre, grupo o @g.us","path":"<MEDIA_DIR>/...","caption":"texto en tono Relevo","asDocument":false}

REGLAS CRÍTICAS DE COMPORTAMIENTO (CUMPLIMIENTO ESTRICTO):
- MEMORIA DE CHAT: Lee SIEMPRE la "CONVERSACION RECIENTE DE TELEGRAM" antes de responder o pedir datos. Junta la información de mensajes anteriores y ejecuta la acción de inmediato.
- NUNCA MIENTAS NI PROMETAS SIN ACCIÓN: Jamás digas "listo", "anotado", "cerrado", "registrado", "guardado" o "regla anotada" si NO incluiste la acción real correspondiente en "actions".
- REGLAS DEL DUEÑO: Cada vez que Carlos te dé una instrucción permanente ("recuerda que...", "nunca hagas...", "siempre que...", "a partir de ahora..."), OBLIGATORIAMENTE emite {"type":"remember","rule":"..."} con toda la regla completa.
- PEDIDO vs PENDIENTE: Distingue estrictamente PEDIDO #N de PENDIENTE #N.
- CLIENTES YA ATENDIDOS: Si Carlos dice "ya atendí a X" o "quítalo de pendientes", emite {"type":"mark_attended","client":"X","close_pendings":true}.
- NO REPITAS COSAS IRRELEVANTES: Si Carlos te da una orden puntual, ejecútala y confírmala breve.

Responde UNICAMENTE JSON válido sin markdown ni texto fuera del JSON:
{"text":"respuesta breve y clara para Carlos","actions":[...]}

${vault.knowledge()}

ESTADO ACTUAL DEL NEGOCIO
${snapshot}`;

  const userContent = `CONVERSACION RECIENTE DE TELEGRAM (del mas antiguo al mas reciente):
${formatOwnerHist(ownerHist)}

MENSAJE ACTUAL DE CARLOS (responde y actua sobre este tomando en cuenta la conversacion reciente):
${userText}`;

  const res = await llm.chat({ tier: 'delicate', system, messages: [{ role: 'user', content: userContent }], maxTokens: 1600 });
  try { return llm.parseJson(res.text); } catch { return { text: res.text.slice(0, 3500), actions: [] }; }
}

module.exports = { decide, ownerChat, todayStr };

