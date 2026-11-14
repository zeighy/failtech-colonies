'use strict';
// Server-wide switches the admin panel flips, kept in the meta table so they survive a restart:
//   maintenance   players cannot sign in or act (the message is shown on the sign-in page); the clock keeps running unless paused
//   notice        a banner every player sees in the game
//   clock         paused: no ticks run, and none are caught up when it resumes
// and the hooks server.js registers so the panel can restart the process and see who is connected.
const store = require('./db');

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } };

function maintenance() { return parse(store.getMeta('maintenance'), null); } // { on: true, message } or null
function setMaintenance(on, message = '') {
  store.setMeta('maintenance', on ? JSON.stringify({ on: true, message: String(message || '').slice(0, 300), since: Date.now() }) : '');
}

function notice() {
  const n = parse(store.getMeta('notice'), null);
  if (!n || !n.text) return null;
  if (n.until && n.until <= Date.now()) return null;
  return { text: n.text, level: n.level || 'info' };
}
function setNotice(text, { level = 'info', until = null } = {}) {
  store.setMeta('notice', text ? JSON.stringify({ text: String(text).slice(0, 300), level: ['info', 'warn', 'bad'].includes(level) ? level : 'info', until: until || null, at: Date.now() }) : '');
}

const clockPaused = () => store.getMeta('clock_paused') === '1';

// ---- hooks --------------------------------------------------------------------------------------------------------------
// The exit code a restart uses: non-zero, so a supervisor restarts it whether it is set to restart always or on failure.
const RESTART_CODE = Number(process.env.RESTART_EXIT_CODE) || 75;
let shutdownHook = null;
let statsHook = () => ({});
let kickHook = () => 0;
const onShutdown = (fn) => { shutdownHook = fn; };
const onStats = (fn) => { statsHook = fn; };
const onKick = (fn) => { kickHook = fn; };
const supervised = () => !!(process.env.INVOCATION_ID || process.env.pm_id || process.env.SUPERVISOR_ENABLED || process.env.RESTART_SUPERVISED === '1');

function restart(reason = 'restart requested') {
  if (!shutdownHook) return false;
  setTimeout(() => shutdownHook(reason, RESTART_CODE), 300); // let the answer go out first
  return true;
}
const stats = () => statsHook();
const kick = (userId) => kickHook(userId); // close a player's live connections

const started = Date.now();
module.exports = { maintenance, setMaintenance, notice, setNotice, clockPaused, onShutdown, onStats, onKick, restart, stats, kick, supervised, started, RESTART_CODE };
