'use strict';
// Un solo punto de entrada a los modelos con cascada automática de respaldo y cooldown por cuota:
//   Si el modelo principal (ej. agy:gemini-4-argon-medium) agota cuota o falla,
//   cambia automáticamente a agy:gemini-4-neon-xhigh -> agy:gemini-3.8-flash-medium ->
//   modelos gratuitos en OpenCode (deepseek-v4.1-flash-free, nemotron-3.5-super-vl-free,
//   mimo-v2.6-flash-free) -> Ollama local vía omniroute.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cfg = require('./config');
const S = require('./settings');
const db = require('./db');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const TMP = (n) => { const d = path.join(cfg.HOME, '.relevo', n); fs.mkdirSync(d, { recursive: true }); return d; };

const QUOTA_RE = /quota|rate.?limit|429|resource.?exhausted|exhausted|capacity|limit exceeded|too many requests|credit|insufficient|overloaded|503|billing|usage limit|token limit/i;
const QUOTA_COOLDOWN_MS = 30 * 60000;
const ERR_COOLDOWN_MS = 3 * 60000;

const FREE_OPENCODE_CHAIN = [
  'opencode/deepseek-v4.1-flash-free',
  'opencode/nemotron-3.5-super-vl-free',
  'opencode/mimo-v2.6-flash-free',
  'omniroute/ollama-local/qwen3.5-32k',
];

let notifyHook = null;
const setNotify = (fn) => { notifyHook = fn; };
const lastNoticeAt = new Map();

function loadCooldowns() {
  try { return JSON.parse(db.kvGet('llm_cooldowns', '{}') || '{}'); } catch { return {}; }
}
function saveCooldowns(map) {
  try {
    const now = Date.now();
    const clean = {};
    for (const [k, v] of Object.entries(map)) if (v && v.until > now) clean[k] = v;
    db.kvSet('llm_cooldowns', JSON.stringify(clean));
  } catch {}
}
function isOnCooldown(key) {
  const c = loadCooldowns()[key];
  return !!(c && c.until > Date.now());
}
function markCooldown(key, ms, reason) {
  const map = loadCooldowns();
  map[key] = { until: Date.now() + ms, reason: String(reason || '').slice(0, 140) };
  saveCooldowns(map);
}
function maybeNotifyFallback(fromKey, toKey, reason) {
  if (!notifyHook) return;
  const k = `${fromKey}->${toKey}`;
  const prev = lastNoticeAt.get(k) || 0;
  if (Date.now() - prev < 45 * 60000) return;
  lastNoticeAt.set(k, Date.now());
  const msg = `⚡ Cambio automático de modelo: ${fromKey} → ${toKey}\nMotivo: ${String(reason || 'cuota/fallo').slice(0, 160)}`;
  Promise.resolve(notifyHook(msg)).catch(() => {});
}

// ---------------------------------------------------------------- ejecución de programas
let running = 0; const waiters = [];
const slot = async () => { if (running >= 2) await new Promise((r) => waiters.push(r)); running++; };
const free = () => { running--; const w = waiters.shift(); if (w) w(); };

function runCmd(bin, args, { input, cwd, timeoutMs = 120000, env } = {}) {
  return new Promise((ok, no) => {
    const p = spawn(bin, args, { env: env || process.env, cwd: cwd || cfg.HOME, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const to = setTimeout(() => { p.kill('SIGKILL'); no(new Error(path.basename(bin) + ': tiempo agotado')); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(to); no(e); });
    p.on('close', (code) => { clearTimeout(to); code === 0 || out ? ok({ out, err, code }) : no(new Error(path.basename(bin) + ' salió con ' + code + ': ' + err.replace(ANSI, '').slice(0, 300))); });
    p.stdin.end(input || '');
  });
}

const PATHS = `${path.join(cfg.HOME, '.local', 'bin')}:${path.join(cfg.HOME, '.opencode', 'bin')}:${process.env.PATH || ''}`;
const bin = (name) => { for (const d of PATHS.split(':')) { const f = path.join(d, name); try { fs.accessSync(f, fs.constants.X_OK); return f; } catch {} } return name; };
const baseEnv = () => ({ ...process.env, PATH: PATHS });

// ---------------------------------------------------------------- Claude Code (plan)
function claudeEnv() {
  const e = { ...baseEnv(), CLAUDE_CODE_OAUTH_TOKEN: cfg.CLAUDE_OAUTH_TOKEN, CLAUDE_CONFIG_DIR: cfg.CLAUDE_HOME, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1' };
  for (const k of Object.keys(e)) if (/^ANTHROPIC_/.test(k)) delete e[k];
  fs.mkdirSync(cfg.CLAUDE_HOME, { recursive: true });
  return e;
}
const runClaude = (args, o = {}) => runCmd(cfg.CLAUDE_BIN, args, { ...o, env: claudeEnv(), cwd: o.cwd || cfg.CLAUDE_HOME });

async function viaClaude(tier, system, messages, maxTokens, modelOverride) {
  if (!cfg.CLAUDE_OAUTH_TOKEN) throw new Error('Claude Code: falta CLAUDE_CODE_OAUTH_TOKEN (claude setup-token)');
  const model = modelOverride || S.get(tier === 'delicate' ? 'claude_model_delicate' : 'claude_model_routine');
  const { out } = await runClaude(['-p', '--output-format', 'json', '--model', model, '--no-session-persistence', '--tools', '', '--system-prompt', system], { input: messages.map((m) => m.content).join('\n\n') });
  let j; try { j = JSON.parse(out); } catch { throw new Error('claude: salida no es JSON: ' + out.slice(0, 160)); }
  if (j.is_error) throw new Error('claude: ' + String(j.result).slice(0, 200));
  return { text: j.result || '', model: 'claude-cli:' + model };
}

// ---------------------------------------------------------------- Antigravity (agy)
async function viaAgy(tier, system, messages, maxTokens, modelOverride) {
  const model = modelOverride || S.get(tier === 'delicate' ? 'agy_model_delicate' : 'agy_model_routine');
  const prompt = `INSTRUCCION DE EJECUCION: NO uses herramientas ni crees archivos. Responde directamente.\n\n${system}\n\n---\n${messages.map((m) => m.content).join('\n\n')}`;
  const args = ['-p', prompt, '--output-format', 'json', '--disable-slash-commands', '--print-timeout', '120s'];
  if (model) args.push('--model', model);
  const { out, err } = await runCmd(bin('agy'), args, { cwd: TMP('agy-chat'), timeoutMs: 130000, env: baseEnv() });
  const cleaned = out.replace(ANSI, '').trim();
  const jsonLine = cleaned.split('\n').filter((l) => l.trim().startsWith('{')).pop();
  let j;
  try { j = JSON.parse(jsonLine || cleaned); }
  catch { throw new Error('agy: ' + (err.replace(ANSI, '').trim() || cleaned || 'salida no es JSON').slice(0, 240)); }
  if (j.status && j.status !== 'SUCCESS') throw new Error('agy: ' + (j.error || j.message || j.status));
  const text = String(j.response || '').trim();
  if (!text) throw new Error('agy: respuesta vacía' + (err ? ' (' + err.replace(ANSI, '').slice(0, 140) + ')' : ''));
  return { text, model: 'agy:' + (model || 'default') };
}

// ---------------------------------------------------------------- OpenCode
function opencodeText(out) {
  const parts = [];
  for (const line of out.replace(ANSI, '').split('\n')) {
    if (!line.startsWith('{')) continue;
    try { const e = JSON.parse(line); if (e.type === 'text' && e.part?.text) parts.push(e.part.text); if (e.type === 'error') throw new Error('opencode: ' + (e.error?.data?.message || e.error?.name || 'error')); }
    catch (er) { if (/^opencode:/.test(er.message)) throw er; }
  }
  return parts.join('');
}
async function viaOpencode(tier, system, messages, maxTokens, modelOverride) {
  const model = modelOverride || S.get(tier === 'delicate' ? 'opencode_model_delicate' : 'opencode_model_routine');
  const prompt = `${system}\n\n---\n${messages.map((m) => m.content).join('\n\n')}`;
  const { out, err } = await runCmd(bin('opencode'), ['run', prompt, '-m', model, '--format', 'json', '--pure', '--dir', TMP('oc-chat')], { timeoutMs: 130000, env: baseEnv() });
  const text = opencodeText(out);
  if (!text) throw new Error('opencode: ' + (err.replace(ANSI, '').trim() || 'sin texto en la respuesta').slice(0, 220));
  return { text, model: 'opencode:' + model };
}

// ---------------------------------------------------------------- API de Anthropic
async function viaApi(tier, system, messages, maxTokens, modelOverride) {
  if (!cfg.ANTHROPIC_API_KEY) throw new Error('API: falta ANTHROPIC_API_KEY');
  const model = modelOverride || S.get(tier === 'delicate' ? 'api_model_delicate' : 'api_model_routine');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'x-api-key': cfg.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }), signal: AbortSignal.timeout(60000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${j.error?.message || JSON.stringify(j).slice(0, 200)}`);
  return { text: (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''), model };
}

// ---------------------------------------------------------------- omniroute (respaldo directo si se habilita)
async function viaOmniroute(system, messages, maxTokens) {
  const r = await fetch(cfg.OMNIROUTE_URL + '/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + cfg.OMNIROUTE_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ model: cfg.OMNIROUTE_MODEL, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, ...messages] }), signal: AbortSignal.timeout(60000),
  });
  const j = await r.json(); const t = j.choices?.[0]?.message?.content;
  if (!t) throw new Error('omniroute sin contenido: ' + JSON.stringify(j.error || j).slice(0, 200));
  return { text: t, model: 'omniroute:' + cfg.OMNIROUTE_MODEL };
}

const ADAPTERS = { api: viaApi, claude: viaClaude, agy: viaAgy, opencode: viaOpencode };

function buildCandidates(harness, tier, strictSingle = false) {
  const list = [];
  const add = (adapter, model) => {
    if (!adapter || !model) return;
    if (!list.some((x) => x.adapter === adapter && x.model === model)) list.push({ adapter, model, key: `${adapter}:${model}` });
  };
  if (strictSingle) {
    if (harness === 'agy') add('agy', S.get(tier === 'delicate' ? 'agy_model_delicate' : 'agy_model_routine'));
    else if (harness === 'opencode') add('opencode', S.get(tier === 'delicate' ? 'opencode_model_delicate' : 'opencode_model_routine'));
    else if (harness === 'api') add('api', S.get(tier === 'delicate' ? 'api_model_delicate' : 'api_model_routine'));
    else if (harness === 'claude') add('claude', S.get(tier === 'delicate' ? 'claude_model_delicate' : 'claude_model_routine'));
    return list;
  }
  if (harness === 'agy') {
    if (tier === 'delicate') {
      add('agy', S.get('agy_model_delicate'));            // 1) gemini-4-argon-medium
      add('agy', 'gemini-4-neon-xhigh');                  // 2) neon xhigh si se acaba argon
      add('agy', S.get('agy_model_routine'));             // 3) gemini-3.8-flash-medium (ultra ligero)
    } else {
      add('agy', S.get('agy_model_routine'));             // 1) gemini-3.8-flash-medium (ahorra cuota de argon)
      add('agy', 'gemini-4-neon-xhigh');                  // 2) neon xhigh si falla flash
    }
    add('opencode', S.get(tier === 'delicate' ? 'opencode_model_delicate' : 'opencode_model_routine'));
    for (const fm of FREE_OPENCODE_CHAIN) add('opencode', fm);
    return list;
  }
  if (harness === 'opencode') {
    add('opencode', S.get(tier === 'delicate' ? 'opencode_model_delicate' : 'opencode_model_routine'));
    for (const fm of FREE_OPENCODE_CHAIN) add('opencode', fm);
    return list;
  }
  if (harness === 'auto') {
    if (cfg.ANTHROPIC_API_KEY) add('api', S.get(tier === 'delicate' ? 'api_model_delicate' : 'api_model_routine'));
    if (cfg.CLAUDE_OAUTH_TOKEN) add('claude', S.get(tier === 'delicate' ? 'claude_model_delicate' : 'claude_model_routine'));
    add('agy', 'gemini-4-neon-xhigh');
    for (const fm of FREE_OPENCODE_CHAIN) add('opencode', fm);
    return list;
  }
  if (harness === 'api' && cfg.ANTHROPIC_API_KEY) add('api', S.get(tier === 'delicate' ? 'api_model_delicate' : 'api_model_routine'));
  if (harness === 'claude' && cfg.CLAUDE_OAUTH_TOKEN) add('claude', S.get(tier === 'delicate' ? 'claude_model_delicate' : 'claude_model_routine'));
  for (const fm of FREE_OPENCODE_CHAIN) add('opencode', fm);
  return list;
}

// harness: fuerza uno sin cascada cuando viene del botón "Probar" del panel (strict=true).
async function chat({ tier = 'routine', system, messages, maxTokens = 900, harness, strict = false }) {
  const h = harness || S.get('harness_chat');
  const allCandidates = buildCandidates(h, tier, strict);
  if (!allCandidates.length) throw new Error('Sin harness/modelo disponible en Ajustes');

  const ready = allCandidates.filter((c) => !isOnCooldown(c.key));
  const queue = ready.length ? ready : allCandidates; // si todos están en cooldown, intenta igual como último recurso
  const primaryKey = allCandidates[0].key;
  let lastErr = new Error('Sin respuesta de modelos');
  let primaryFailReason = '';

  await slot();
  try {
    for (const cand of queue) {
      const tries = QUOTA_RE.test(lastErr.message) ? 1 : 2;
      for (let i = 0; i < tries; i++) {
        try {
          const res = await ADAPTERS[cand.adapter](tier, system, messages, maxTokens, cand.model);
          try { db.kvSet('llm_last_model', res.model); } catch {}
          if (!strict && cand.key !== primaryKey) {
            console.warn(`[llm] usando respaldo ${cand.key} (principal ${primaryKey}: ${primaryFailReason || 'en cooldown'})`);
            maybeNotifyFallback(primaryKey, cand.key, primaryFailReason || 'en cooldown por cuota');
          }
          return res;
        } catch (e) {
          lastErr = e;
          const isQuota = QUOTA_RE.test(e.message || '');
          if (cand.key === primaryKey) primaryFailReason = e.message;
          if (isQuota) {
            console.warn(`[llm] cuota/limite en ${cand.key}, cooldown 30 min:`, e.message.slice(0, 160));
            markCooldown(cand.key, QUOTA_COOLDOWN_MS, e.message);
            break; // no reintentar inmediatamente el mismo modelo agotado: pasar al siguiente!
          }
          if (i === 0 && tries > 1) await sleep(1200);
          else markCooldown(cand.key, ERR_COOLDOWN_MS, e.message);
        }
      }
    }
    if (!harness && cfg.ALLOW_OMNIROUTE_FALLBACK && cfg.OMNIROUTE_KEY) {
      try { return await viaOmniroute(system, messages, maxTokens); } catch (e) { lastErr = e; }
    }
  } finally { free(); }
  throw lastErr;
}

// Extrae el primer objeto JSON de la respuesta del modelo.
function parseJson(text) {
  const s = String(text);
  const a = s.indexOf('{');
  if (a < 0) throw new Error('sin JSON');
  let depth = 0, inStr = false, esc = false;
  for (let i = a; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(s.slice(a, i + 1));
  }
  throw new Error('JSON incompleto');
}

function configured() {
  const h = S.get('harness_chat');
  if (h === 'opencode' || h === 'agy') return true;
  if (h === 'api') return !!cfg.ANTHROPIC_API_KEY;
  if (h === 'claude') return !!cfg.CLAUDE_OAUTH_TOKEN;
  return !!cfg.ANTHROPIC_API_KEY || !!cfg.CLAUDE_OAUTH_TOKEN || (cfg.ALLOW_OMNIROUTE_FALLBACK && !!cfg.OMNIROUTE_KEY);
}

// Prueba rápida de un harness (botón "Probar" del panel).
async function test(harness, tier = 'routine') {
  const t0 = Date.now();
  try {
    const r = await chat({ tier, harness, strict: true, system: 'Responde en una sola línea.', messages: [{ role: 'user', content: 'Di exactamente: listo' }], maxTokens: 30 });
    return { ok: true, ms: Date.now() - t0, model: r.model, text: String(r.text).trim().slice(0, 120) };
  } catch (e) { return { ok: false, ms: Date.now() - t0, error: e.message.slice(0, 300) }; }
}

module.exports = {
  chat, parseJson, runClaude, runCmd, bin, baseEnv, test, configured, ANSI, opencodeText,
  setNotify, buildCandidates, loadCooldowns, markCooldown, isOnCooldown, QUOTA_RE, FREE_OPENCODE_CHAIN,
  claudeReady: () => !!cfg.CLAUDE_OAUTH_TOKEN,
};

