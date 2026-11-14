'use strict';
// Server-wide switches the admin panel flips, kept in the meta table so they survive a restart:
//   maintenance   players cannot sign in or act (the message is shown on the sign-in page); the clock keeps running unless paused
//   notice        a banner every player sees in the game
//   clock         paused: no ticks run, none are caught up when it resumes, and players' actions are refused meanwhile
//                 (the engine also holds the world by itself when no player is active: see engine.js checkHold)
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

// The support link on the sign-in page: set in the admin panel (meta `support_url`), else the web page of the code repository
// the server updates from (update_repo, else package.json's repository), else none.
function repoPage(repo) {
  const r = String(repo || '').trim().replace(/^git\+/, '').replace(/\.git$/, '');
  let m = /^git@([A-Za-z0-9.-]+):(.+)$/.exec(r);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = /^ssh:\/\/(?:[^@/]+@)?([A-Za-z0-9.-]+)(?::\d+)?\/(.+)$/.exec(r);
  if (m) return `https://${m[1]}/${m[2]}`;
  return /^https:\/\//.test(r) ? r : null;
}
function supportUrl() {
  const set = store.getMeta('support_url');
  if (set) return set;
  let pkg = '';
  try { pkg = (require('../package.json').repository || {}).url || ''; } catch (e) { pkg = ''; }
  return repoPage(store.getMeta('update_repo') || pkg);
}
// '' or null goes back to the default. Only http(s) addresses.
function setSupportUrl(url) {
  const u = String(url || '').trim();
  if (u && (!/^https?:\/\/[^\s"'<>]+$/.test(u) || u.length > 300)) return false;
  store.setMeta('support_url', u);
  return true;
}

const clockPaused = () => store.getMeta('clock_paused') === '1';
// What holds the simulation now, as the engine last judged it: { reason: 'admin' | 'idle', since } or null (src/engine.js).
const pauseState = () => parse(store.getMeta('sim_hold'), null);

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
module.exports = { supportUrl, setSupportUrl, repoPage, maintenance, setMaintenance, notice, setNotice, clockPaused, pauseState, onShutdown, onStats, onKick, restart, stats, kick, supervised, started, RESTART_CODE };
