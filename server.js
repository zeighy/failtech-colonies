'use strict';
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const store = require('./src/db');
const engine = require('./src/engine');
const actions = require('./src/actions');
const security = require('./src/security');
const story = require('./src/story');
const theme = require('./src/theme');
const backup = require('./src/backup');
const config = store.config;
const { body: plainBody } = require('./src/validate');
const { viewFor, clientConfig } = require('./src/state');
const { db } = store;

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS) || 12;

// Session secret: env var, else a generated one kept in the database.
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  let s = store.getMeta('session_secret');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); store.setMeta('session_secret', s); }
  return s;
}

// TRUST_PROXY: how many reverse proxies sit in front ("1"), a trusted address or range ("loopback", "10.0.0.0/8"), or
// "false" when the app is exposed directly. Default "loopback": X-Forwarded-For is only believed from a proxy on this
// machine, so a client cannot choose its own IP (which the rate limits and logs depend on).
function trustProxy() {
  const v = process.env.TRUST_PROXY;
  if (v === undefined || v === '') return 'loopback';
  if (v === 'false' || v === '0') return false;
  return /^\d+$/.test(v) ? Number(v) : v;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', trustProxy());
app.use(security.headers);
app.use('/api', security.sameOrigin((process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)));
app.use('/api', security.jsonOnly);
app.use(express.json({ limit: '10kb', strict: true }));
app.use(session({
  name: 'failtech.sid',
  secret: sessionSecret(),
  store: new store.SqliteStore(),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 14 * 86400000, secure: 'auto' },
}));

// ---- rate limits ------------------------------------------------------------
// Auth: per IP per minute, plus a failed-login throttle per callsign. Everything else under /api: per player (or
// per IP when signed out). Generous for a human clicking fast, hopeless for a script hammering the simulation.
const MAX_ATTEMPTS = Number(process.env.AUTH_RATE_LIMIT) || 20;
const authLimit = security.limiter({ windowMs: 60000, max: MAX_ATTEMPTS, key: (req) => req.ip, message: 'Too many attempts. Wait a minute.' });
const apiLimit = security.limiter({ windowMs: 10000, max: Number(process.env.API_RATE_LIMIT) || 120, key: (req) => (req.session && req.session.userId ? `u${req.session.userId}` : `ip${req.ip}`) });
const ipLimit = security.limiter({ windowMs: 10000, max: 600, key: (req) => req.ip });
const loginFails = security.failureTracker({ windowMs: 15 * 60000, max: 8 });
setInterval(() => loginFails.sweep(), 60000).unref();
app.use('/api', ipLimit, apiLimit);

// "Active" players are those who have recently talked to the server (any request, or an
// open live stream that refreshes every tick). New hazards only start for active players.
const lastTouch = new Map();
function touch(userId) {
  const now = Date.now();
  if (now - (lastTouch.get(userId) || 0) < 5000) return;
  lastTouch.set(userId, now);
  db.prepare('UPDATE colonies SET last_seen_at = ? WHERE user_id = ?').run(now, userId);
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  touch(req.session.userId);
  next();
}

// ---- auth -------------------------------------------------------------------
// bcrypt only looks at the first 72 bytes, so longer passcodes are refused rather than silently truncated.
const MAX_PASS_BYTES = 72;
function credentials(b, { registering = false } = {}) {
  b = plainBody(b);
  if (typeof b.username !== 'string' || typeof b.password !== 'string') return { error: 'Callsign and passcode are required.' };
  const username = b.username.trim();
  const password = b.password;
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return { error: 'Callsign must be 3-20 letters, numbers or underscores.' };
  if (Buffer.byteLength(password) > MAX_PASS_BYTES) return { error: `Passcode must be at most ${MAX_PASS_BYTES} bytes.` };
  if (registering && password.length < 8) return { error: 'Passcode must be at least 8 characters.' };
  if (!registering && password.length < 1) return { error: 'Passcode is required.' };
  return { username, password };
}

function signIn(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => { // a fresh session id on every sign-in (no session fixation)
      if (err) return reject(err);
      req.session.userId = userId;
      store.ensureColony(userId);
      req.session.save((e) => (e ? reject(e) : resolve()));
    });
  });
}

const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(8).toString('hex'), BCRYPT_ROUNDS); // same cost as real hashes, for timing

app.post('/api/register', authLimit, async (req, res, next) => {
  try {
    const c = credentials(req.body, { registering: true });
    if (c.error) return res.status(400).json({ ok: false, error: c.error });
    const hash = await bcrypt.hash(c.password, BCRYPT_ROUNDS);
    // The existence check and the insert happen together, after the slow hash, with nothing awaited in between, and
    // the database enforces uniqueness (case-insensitively) too: two simultaneous sign-ups cannot take the same name.
    let id;
    try {
      if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(c.username)) throw new Error('taken');
      id = Number(db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(c.username, hash).lastInsertRowid);
    } catch (e) {
      if (e.message === 'taken' || /UNIQUE/.test(String(e.code || e.message))) return res.status(409).json({ ok: false, error: 'That callsign is taken.' });
      throw e;
    }
    await signIn(req, id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/login', authLimit, async (req, res, next) => {
  try {
    const c = credentials(req.body);
    const key = c.error ? null : c.username.toLowerCase();
    if (key && loginFails.blocked(key)) return res.status(429).json({ ok: false, error: 'Too many failed attempts for that callsign. Try again later.' });
    const user = c.error ? null : db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(c.username);
    // Always run a compare, at the real cost, so response time doesn't reveal which callsigns exist.
    const ok = await bcrypt.compare(c.password || '', user ? user.password : DUMMY_HASH);
    if (!user || !ok) { if (key) loginFails.fail(key); return res.status(401).json({ ok: false, error: 'Invalid callsign or passcode.' }); }
    loginFails.clear(key);
    await signIn(req, user.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('failtech.sid'); res.json({ ok: true }); });
});

// ---- game api -----------------------------------------------------------------
const cfgJson = JSON.stringify(clientConfig());
app.get('/api/config', requireAuth, (req, res) => res.type('json').send(cfgJson));
// Public: just the wording the login page needs. Nothing about any colony.
app.get('/api/theme', (req, res) => res.json({ ok: true, id: config.theme.id, ui: config.theme.ui }));
// The text of every message this colony has been sent so far (never the rest of the script).
app.get('/api/story', requireAuth, (req, res) => {
  const c = actions.colonyOf(req.session.userId);
  res.json(c ? story.content(c.id) : { characters: {}, beats: {}, scenes: {} });
});
app.get('/api/state', requireAuth, (req, res) => res.json(viewFor(req.session.userId)));

// Live updates: the server pushes a fresh view to each connected player every tick.
// A player may hold a few streams (tabs); the total is capped so open connections cannot be used to exhaust the server.
const MAX_STREAMS_PER_USER = 4;
const MAX_STREAMS_TOTAL = Number(process.env.MAX_STREAMS) || 1000;
const streams = new Map(); // userId -> Set<res>
let streamCount = 0;
function push(userId) {
  const set = streams.get(userId);
  if (!set || !set.size) return;
  touch(userId);
  const payload = `data: ${JSON.stringify(viewFor(userId))}\n\n`;
  for (const r of set) r.write(payload);
}
app.get('/api/stream', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const mine = streams.get(userId);
  if ((mine && mine.size >= MAX_STREAMS_PER_USER) || streamCount >= MAX_STREAMS_TOTAL) {
    return res.status(429).json({ ok: false, error: 'Too many open live connections.' });
  }
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 2000\n\n');
  if (!streams.has(userId)) streams.set(userId, new Set());
  streams.get(userId).add(res);
  streamCount++;
  res.write(`data: ${JSON.stringify(viewFor(userId))}\n\n`);
  const hb = setInterval(() => res.write(': keepalive\n\n'), 20000);
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(hb);
    streamCount--;
    const set = streams.get(userId);
    if (set) { set.delete(res); if (!set.size) streams.delete(userId); }
  };
  req.on('close', cleanup);
  res.on('error', cleanup);
});
engine.events.on('tick', () => { for (const uid of [...streams.keys()]) { try { push(uid); } catch (e) { console.error('push failed', e); } } });

const act = (name) => (req, res) => {
  const result = actions[name](req.session.userId, plainBody(req.body));
  if (result.ok) push(req.session.userId);
  res.status(result.ok ? 200 : 400).json({ ...result, state: result.ok ? viewFor(req.session.userId) : undefined });
};
for (const [route, name] of [
  ['build', 'build'], ['demolish', 'demolish'], ['toggle', 'toggle'], ['boost', 'setBoost'], ['expand', 'expand'], ['cancel', 'cancelOrder'],
  ['upgrade', 'upgradeHub'], ['contract', 'setContract'], ['reset', 'reset'], ['restart', 'restart'], ['ack', 'ack'], ['express', 'expressTrip'], ['found', 'foundDistrict'], ['shipment', 'shipment'], ['market', 'marketPost'], ['recipe', 'setRecipe'], ['shield', 'shieldHazard'], ['mission', 'missionFill'], ['market-cancel', 'marketCancel'], ['route', 'setRoute'], ['link', 'upgradeLink'], ['story-seen', 'storySeen'], ['resume', 'resumeOps'], ['launch-cycle', 'launchCycle'], ['launch', 'launch'], ['express-launch', 'expressLaunch'], ['orbit-storage', 'orbitalStorageUpgrade'], ['orbit-links', 'orbitalLinksUpgrade'], ['jettison', 'jettison'], ['rebuild-slot', 'rebuildSlot'], ['ship-deploy', 'shipDeploy'], ['ship-plan', 'shipPlan'], ['ship-return', 'shipReturn'], ['data-unlock', 'dataUnlock'], ['rush', 'rushOrder'], ['ship-build', 'shipBuild'], ['ship-upgrade', 'shipUpgrade'], ['ship-repair', 'shipRepair'], ['project-contribute', 'projectContribute'], ['orbit-market', 'orbitPost'], ['orbit-market-cancel', 'orbitCancel'],
]) app.post(`/api/${route}`, requireAuth, act(name));

// ---- pages ----------------------------------------------------------------------
app.get('/', (req, res) => (req.session.userId ? res.redirect('/game') : res.sendFile(path.join(PUBLIC, 'index.html'))));
app.get('/game', (req, res) => (req.session.userId ? res.sendFile(path.join(PUBLIC, 'game.html')) : res.redirect('/')));
// Only the public/ folder is served: dotfiles are never sent, there are no directory listings, and path traversal is
// refused by the static handler. The database, config and source live outside it.
// Theme artwork (portraits, backgrounds): only the active theme's assets/ folder, nothing else under content/.
app.use('/theme-assets', express.static(path.join(theme.dir(), 'assets'), { index: false, maxAge: 0, dotfiles: 'deny', redirect: false, fallthrough: false }));
app.use(express.static(PUBLIC, { index: false, maxAge: 0, dotfiles: 'deny', redirect: false }));

app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Not found.' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  // Client mistakes (malformed or oversized JSON, bad URLs) are 4xx and never logged as server errors;
  // anything else is logged here and answered with a generic message (no stack traces or internals to the client).
  const status = Number(err.status || err.statusCode);
  if (status >= 400 && status < 500) {
    const msg = status === 413 ? 'Request too large.' : status === 400 ? 'Bad request.' : 'Request refused.';
    return res.status(status).json({ ok: false, error: msg });
  }
  console.error(err);
  res.status(500).json({ ok: false, error: 'Server error.' });
});

// ---- single instance ---------------------------------------------------------------
// Two server processes sharing one database would each run the clock (double ticks). A lock file next to the
// database stops that; a stale lock from a crashed process is taken over.
function acquireLock() {
  const lock = `${store.dbPath}.lock`;
  const mine = String(process.pid);
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(lock, mine, { flag: 'wx', mode: 0o600 }); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const other = Number(fs.readFileSync(lock, 'utf8'));
      let alive = false;
      try { process.kill(other, 0); alive = other !== process.pid; } catch (err) { alive = err.code === 'EPERM'; }
      if (alive) throw new Error(`Another FAILTECH server (pid ${other}) is already using ${store.dbPath}.`);
      fs.rmSync(lock, { force: true });
    }
  }
  const release = () => { try { if (fs.readFileSync(lock, 'utf8') === mine) fs.rmSync(lock, { force: true }); } catch (e) { /* already gone */ } };
  process.on('exit', release);
}

// ---- graceful shutdown --------------------------------------------------------
// Stop ticking, end the SSE streams (they would keep the server open forever), let in-flight
// requests finish, then close the database so the WAL is checkpointed. Missed ticks are
// caught up on the next start, so nothing is lost by stopping early.
function installShutdown(server, stopBackups) {
  let closing = false;
  const shutdown = (reason, code = 0) => {
    if (closing) return;
    closing = true;
    console.log(`${reason}: shutting down.`);
    const force = setTimeout(() => { console.error('Shutdown timed out; forcing exit.'); process.exit(1); }, 8000);
    force.unref();
    engine.stop();
    if (stopBackups) stopBackups();
    for (const set of streams.values()) for (const r of set) r.end();
    server.close(() => {
      try { store.db.close(); } catch (e) { console.error('Database close failed:', e); code = code || 1; }
      console.log('Shutdown complete.');
      process.exit(code);
    });
    server.closeIdleConnections();
  };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => shutdown(sig));
  process.on('uncaughtException', (err) => { console.error('Uncaught exception:', err); shutdown('uncaughtException', 1); });
  process.on('unhandledRejection', (err) => { console.error('Unhandled rejection:', err); shutdown('unhandledRejection', 1); });
}

if (require.main === module) {
  acquireLock();
  engine.start();
  setInterval(() => store.purgeSessions(), 3600000).unref();
  store.purgeSessions();
  const stopBackups = backup.start();
  const server = app.listen(PORT, () => console.log(`FAILTECH command running at http://localhost:${PORT}`));
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 15000;
  server.maxHeadersCount = 50;
  installShutdown(server, stopBackups);
}
module.exports = app;
