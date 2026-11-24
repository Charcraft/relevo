'use strict';
const path = require('path');
const os = require('os');
const HOME = os.homedir();
const env = process.env;

module.exports = {
  HOME,
  VAULT: env.RELEVO_VAULT || path.join(HOME, 'relevo-vault'),
  DATA: env.RELEVO_DATA || path.join(HOME, 'relevo-agent', 'data'),
  TZ: env.RELEVO_TZ || 'America/Mexico_City',
  CHROME: env.CHROME_PATH || '/usr/bin/google-chrome',
  PUBLIC_URL: env.RELEVO_NOVNC_URL || 'http://127.0.0.1:7907/vnc.html',
  PANEL_URL: env.RELEVO_PANEL_URL || 'http://127.0.0.1:8787/panel/',
  PUBLIC_BASE_URL: env.RELEVO_PUBLIC_BASE_URL || 'http://127.0.0.1:8789',
  BACKUP_BASE_URL: env.RELEVO_BACKUP_BASE_URL || '',
  WEB_DIR: env.RELEVO_WEB_DIR || path.resolve(__dirname, '../../web'),
  PANEL_DIR: env.RELEVO_PANEL_DIR || path.resolve(__dirname, '../../panel'),
  AUTH_FILE: env.RELEVO_AUTH_FILE || path.join(env.RELEVO_DATA || path.join(HOME, '.relevo'), 'panel-auth.json'),
  OWNER_WA_ID: env.OWNER_WA_ID || '',

  TELEGRAM_TOKEN: env.TELEGRAM_BOT_TOKEN || '',
  OWNER_PAIR_CODE: env.OWNER_PAIR_CODE || '',

  // Modelo mixto: rutina barata y rápida, casos delicados con el modelo fuerte
  ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY || '',
  MODEL_ROUTINE: env.MODEL_ROUTINE || 'claude-haiku-5-5',
  MODEL_DELICATE: env.MODEL_DELICATE || 'claude-sonnet-5-5',
  // Plan Pro/Max de Claude: token largo de `claude setup-token` usado por Claude Code en modo no interactivo
  CLAUDE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN || '',
  CLAUDE_BIN: env.CLAUDE_BIN || path.join(HOME, '.local', 'bin', 'claude'),
  CLAUDE_HOME: env.RELEVO_CLAUDE_HOME || path.join(HOME, '.relevo', 'claude-home'),   // config aislada: no usa el gateway del servidor
  CLAUDE_MODEL_ROUTINE: env.CLAUDE_MODEL_ROUTINE || 'haiku',
  CLAUDE_MODEL_DELICATE: env.CLAUDE_MODEL_DELICATE || 'sonnet',
  CLAUDE_MODEL_WORK: env.CLAUDE_MODEL_WORK || 'sonnet',
  WORK_DIR: env.RELEVO_WORK || path.join(HOME, 'relevo-work'),
  WORK_TIMEOUT_MIN: Number(env.WORK_TIMEOUT_MIN || 45),
  // Respaldo SOLO para pruebas (proxy gratuito, no apto para datos reales de clientes)
  OMNIROUTE_URL: env.OMNIROUTE_URL || 'http://localhost:20128/v1',
  OMNIROUTE_KEY: env.OMNIROUTE_KEY || '',
  OMNIROUTE_MODEL: env.OMNIROUTE_MODEL || 'ddgw/claude-haiku-4-5',
  ALLOW_OMNIROUTE_FALLBACK: env.ALLOW_OMNIROUTE_FALLBACK === '1',

  // Ritmo humano / límites anti-bloqueo
  DEBOUNCE_MS: Number(env.DEBOUNCE_MS || 7000),
  MAX_OUT_PER_MIN: Number(env.MAX_OUT_PER_MIN || 6),
  MAX_OUT_PER_HOUR: Number(env.MAX_OUT_PER_HOUR || 80),
  MAX_MEDIA_MB: Number(env.MAX_MEDIA_MB || 25),
};
