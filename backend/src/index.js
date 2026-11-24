'use strict';
const cfg = require('./config');
const agent = require('./agent');
const tg = require('./telegram');
const wa = require('./whatsapp');
const reports = require('./reports');
const llm = require('./llm');
const work = require('./work');
const courses = require('./courses');
const server = require('./server');

process.on('unhandledRejection', (e) => console.error('[unhandled]', e));

(async () => {
  console.log('[relevo] iniciando. Vault:', cfg.VAULT, '| datos:', cfg.DATA);
  if (!llm.configured()) console.warn('[relevo] AVISO: sin modelo (ni ANTHROPIC_API_KEY ni CLAUDE_CODE_OAUTH_TOKEN). Los clientes recibirán solo "dame un momento".');
  else console.log('[relevo] modelo:', cfg.ANTHROPIC_API_KEY ? 'API de Anthropic' : cfg.CLAUDE_OAUTH_TOKEN ? 'Claude Code con tu plan' : 'harness externo (agy/opencode con respaldo automático)');
  const io = {
    send: (id, t) => wa.send(id, t),
    sendFile: (id, f, c, o) => wa.sendFile(id, f, c, o),
    findChats: (q) => wa.findChats(q),
    getMessages: (id, l) => wa.getMessages(id, l),
    acceptInvite: (c) => wa.acceptInvite(c),
    listGroups: () => wa.listGroups(),
    notify: (t, o) => tg.notify(t, o),
    notifyFile: (f, c) => tg.notifyFile(f, c),
    notifyPhoto: (f, c, o) => tg.notifyPhoto(f, c, o),
  };
  agent.setIO(io); work.setIO(io); courses.setIO(io); llm.setNotify((m) => tg.notify(m));
  server.startPanel({ waState: wa.state, wa, agent, courses });
  server.startTracker();
  await tg.start();
  reports.start({ notify: (t, o) => tg.notify(t, o), waState: wa.state });
  await wa.start((id, name, items) => agent.handleInbound(id, name, items), (t, o) => tg.notify(t, o));
  console.log('[relevo] listo');
})().catch((e) => { console.error('[relevo] fallo al iniciar', e); process.exit(1); });

for (const s of ['SIGINT', 'SIGTERM']) process.on(s, async () => { tg.stop(); await wa.stop(); process.exit(0); });

