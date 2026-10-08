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
const { viewFor, clientConfig } = require('./src/state');
const { db } = store;

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

// Session secret: env var, else a generated one kept next to the database.
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  let s = store.getMeta('session_secret');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); store.setMeta('session_secret', s); }
  return s;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
  });
  next();
});
app.use(express.json({ limit: '10kb' }));
app.use(session({
  name: 'failtech.sid',
  secret: sessionSecret(),
  store: new store.SqliteStore(),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 14 * 86400000, secure: 'auto' },
}));

// ---- auth -------------------------------------------------------------------
const attempts = new Map();
const MAX_ATTEMPTS = Number(process.env.AUTH_RATE_LIMIT) || 20; // per IP per minute
function rateLimit(req, res, next) {
  const now = Date.now();
  const rec = (attempts.get(req.ip) || []).filter((t) => now - t < 60000);
  if (rec.length >= MAX_ATTEMPTS) return res.status(429).json({ ok: false, error: 'Too many attempts. Wait a minute.' });
  rec.push(now);
  attempts.set(req.ip, rec);
  next();
}
setInterval(() => { const now = Date.now(); for (const [k, v] of attempts) if (!v.some((t) => now - t < 60000)) attempts.delete(k); }, 60000).unref();

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

function credentials(body) {
  const username = String((body && body.username) || '').trim();
  const password = String((body && body.password) || '');
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return { error: 'Callsign must be 3-20 letters, numbers or underscores.' };
  if (password.length < 6 || password.length > 100) return { error: 'Passcode must be at least 6 characters.' };
  return { username, password };
}

function signIn(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = userId;
      store.ensureColony(userId);
      req.session.save((e) => (e ? reject(e) : resolve()));
    });
  });
}

app.post('/api/register', rateLimit, async (req, res, next) => {
  try {
    const c = credentials(req.body);
    if (c.error) return res.status(400).json({ ok: false, error: c.error });
    if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(c.username)) {
      return res.status(409).json({ ok: false, error: 'That callsign is taken.' });
    }
    const hash = await bcrypt.hash(c.password, 10);
    const id = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(c.username, hash).lastInsertRowid;
    await signIn(req, Number(id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/login', rateLimit, async (req, res, next) => {
  try {
    const c = credentials(req.body);
    const user = c.error ? null : db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(c.username);
    // Always run a compare so response time doesn't reveal which usernames exist.
    const ok = await bcrypt.compare(c.password || '', user ? user.password : '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali');
    if (!user || !ok) return res.status(401).json({ ok: false, error: 'Invalid callsign or passcode.' });
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
app.get('/api/state', requireAuth, (req, res) => res.json(viewFor(req.session.userId)));

// Live updates: the server pushes a fresh view to each connected player every tick.
const streams = new Map(); // userId -> Set<res>
function push(userId) {
  const set = streams.get(userId);
  if (!set || !set.size) return;
  touch(userId);
  const payload = `data: ${JSON.stringify(viewFor(userId))}\n\n`;
  for (const r of set) r.write(payload);
}
app.get('/api/stream', requireAuth, (req, res) => {
  const userId = req.session.userId;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 2000\n\n');
  if (!streams.has(userId)) streams.set(userId, new Set());
  streams.get(userId).add(res);
  res.write(`data: ${JSON.stringify(viewFor(userId))}\n\n`);
  const hb = setInterval(() => res.write(': keepalive\n\n'), 20000);
  req.on('close', () => { clearInterval(hb); streams.get(userId).delete(res); });
});
engine.events.on('tick', () => { for (const uid of streams.keys()) push(uid); });

const act = (name) => (req, res) => {
  const result = actions[name](req.session.userId, req.body);
  if (result.ok) push(req.session.userId);
  res.status(result.ok ? 200 : 400).json({ ...result, state: result.ok ? viewFor(req.session.userId) : undefined });
};
for (const [route, name] of [
  ['build', 'build'], ['demolish', 'demolish'], ['toggle', 'toggle'], ['boost', 'setBoost'], ['cancel', 'cancelOrder'],
  ['upgrade', 'upgradeHub'], ['contract', 'setContract'], ['reset', 'reset'], ['restart', 'restart'], ['ack', 'ack'], ['express', 'expressTrip'], ['found', 'foundDistrict'], ['shipment', 'shipment'], ['route', 'setRoute'], ['link', 'upgradeLink'],
]) app.post(`/api/${route}`, requireAuth, act(name));

// ---- pages ----------------------------------------------------------------------
app.get('/', (req, res) => (req.session.userId ? res.redirect('/game') : res.sendFile(path.join(PUBLIC, 'index.html'))));
app.get('/game', (req, res) => (req.session.userId ? res.sendFile(path.join(PUBLIC, 'game.html')) : res.redirect('/')));
app.use(express.static(PUBLIC, { index: false, maxAge: 0 }));

app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Not found.' }));
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: 'Server error.' });
});

if (require.main === module) {
  engine.start();
  app.listen(PORT, () => console.log(`FAILTECH command running at http://localhost:${PORT}`));
}
module.exports = app;
