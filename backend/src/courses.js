'use strict';
// Adaptador enchufable para trabajos de cursos en plataformas externas.
// Permite desacoplar la automatización específica de cada plataforma del núcleo de Relevo.
const db = require('./db');
const cfg = require('./config');

let io = { notify: async () => {} };
const setIO = (x) => { io = { ...io, ...x }; };

const vncUrl = () => cfg.PUBLIC_URL || 'http://127.0.0.1:7907/vnc.html';
const vncPass = () => process.env.RELEVO_VNC_PASS || '';
const vncFooter = () => `Escritorio remoto: ${vncUrl()}`;
const courseButtons = () => [];

async function onClientMessage() {
  return { handled: false };
}

function resumeInBackground(orderId) {
  db.upsertCourseJob(orderId, { status: 'revisando', step: 'Revisión solicitada desde el panel (adaptador local)' });
}

function runModulesInBackground(orderId) {
  db.upsertCourseJob(orderId, { status: 'en_proceso', step: 'Ejecución solicitada desde el panel (adaptador local)' });
}

function stop(orderId) {
  db.upsertCourseJob(orderId, { status: 'pausado', step: 'Pausado manualmente' });
  return true;
}

async function captureScreen(orderId) {
  throw new Error('Captura de navegador no configurada en modo standalone (pedido #' + orderId + ')');
}

function statusText(orderId) {
  const job = orderId ? db.getCourseJobByOrder(orderId) : db.listCourseJobs()[0];
  if (!job) return 'No hay trabajos de cursos registrados.';
  return `Curso PEDIDO #${job.order_id} | estado=${job.status} | paso=${job.step || '-'}`;
}

module.exports = {
  setIO, onClientMessage, resume: resumeInBackground, resumeInBackground,
  runModules: runModulesInBackground, runModulesInBackground,
  stop, captureScreen, statusText, courseButtons, vncFooter, vncUrl, vncPass,
};
