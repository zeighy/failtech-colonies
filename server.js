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
const absence = require('./src/absence');
const security = require('./src/security');
const story = require('./src/story');
const theme = require('./src/theme');
const backup = require('./src/backup');
const ACTION_ROUTES = require('./src/routes');
const botApi = require('./src/botApi');
const admin = require('./src/admin');
const config = store.config;
const { body: plainBody } = require('./src/validate');
const { viewFor, clientConfig } = require('./src/state');
const { db } = store;

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS) || 12;
const accounts = require('./src/accounts');
const turnstile = require('./src/turnstile');
const serverlog = require('./src/serverlog');
const lifecycle = require('./src/lifecycle');

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
// The bot runner's API (off unless BOT_API_KEY is set). Ahead of the session and the player rate limits: bots authenticate
// with the key, not a cookie, and have a limiter of their own; it parses its own bodies, after the key is checked.
app.use('/api/bot', botApi.router());
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

// Signed in, and nothing in the way: an unverified address or a ban is a 403 the client takes back to the sign-in page,
// and maintenance is a 503 for everyone.
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  if (closedForMaintenance(res)) return;
  const g = accounts.gate(req.session.userId);
  if (g === 'banned' || g === 'gone') {
    const u = accounts.byId(req.session.userId);
    return req.session.destroy(() => res.status(g === 'gone' ? 401 : 403).json({ ok: false, error: u ? accounts.banMessage(u) : 'Not signed in.', banned: g === 'banned' }));
  }
  if (g) return res.status(403).json({ ok: false, error: 'Confirm your email address first.', next: g });
  touch(req.session.userId);
  next();
}

// ---- auth -------------------------------------------------------------------
// Sign-up takes a callsign, a passcode and (when EMAIL_VERIFICATION is on, the default) an email address, which is verified
// with a code or a link before the colony is founded (src/accounts.js). Sign-in takes the callsign or the email address.
// Cloudflare Turnstile guards sign-up, sign-in and reset requests when it is configured (src/turnstile.js).
function signIn(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => { // a fresh session id on every sign-in (no session fixation)
      if (err) return reject(err);
      req.session.userId = userId;
      enterGame(userId);
      req.session.save((e) => (e ? reject(e) : resolve()));
    });
  });
}
// A commander whose parked colony was claimed by someone else chooses what comes next; everyone else has a colony, once
// nothing stands in the way (an unverified address, a ban).
function enterGame(userId) {
  if (accounts.gate(userId)) return;
  if (!absence.lostView(userId)) store.ensureColony(userId);
  absence.markActive(userId);
  wake();
}
// The first player back wakes a world that was held for want of anyone to simulate (engine.js checkHold).
function wake() {
  const h = lifecycle.pauseState();
  if (h && h.reason === 'idle') engine.checkHold();
}

const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(8).toString('hex'), BCRYPT_ROUNDS); // same cost as real hashes, for timing
const closedForMaintenance = (res) => {
  const m = lifecycle.maintenance();
  if (!m) return false;
  res.status(503).json({ ok: false, error: m.message || 'The server is down for maintenance.', maintenance: true });
  return true;
};
async function challenge(req, res) {
  const t = await turnstile.check(plainBody(req.body).turnstile, req.ip);
  if (!t.ok) { res.status(400).json({ ok: false, error: t.error, challenge: true }); return false; }
  return true;
}

app.post('/api/register', authLimit, async (req, res, next) => {
  try {
    if (closedForMaintenance(res)) return;
    const b = plainBody(req.body);
    if (typeof b.username !== 'string' || typeof b.password !== 'string') return res.status(400).json({ ok: false, error: 'Callsign and passcode are required.' });
    const username = b.username.trim();
    if (!accounts.CALLSIGN.test(username)) return res.status(400).json({ ok: false, error: 'Callsign must be 3-20 letters, numbers or underscores.' });
    const bad = accounts.checkPassword(b.password);
    if (bad) return res.status(400).json({ ok: false, error: bad });
    const wantEmail = accounts.verificationRequired() || (typeof b.email === 'string' && b.email.trim() !== '');
    const email = wantEmail ? accounts.normEmail(b.email) : null;
    if (wantEmail && !email) return res.status(400).json({ ok: false, error: 'A valid email address is required.' });
    if (!(await challenge(req, res))) return;
    const hash = await accounts.hashPassword(b.password);
    // The existence check and the insert happen together, after the slow hash, with nothing awaited in between, and
    // the database enforces uniqueness (case-insensitively) too: two simultaneous sign-ups cannot take the same name.
    let id;
    try {
      if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username)) throw new Error('taken');
      if (email && accounts.emailTaken(email)) throw new Error('email');
      id = Number(db.prepare('INSERT INTO users (username, password, email, created_at, created_ip) VALUES (?, ?, ?, ?, ?)').run(username, hash, email, Date.now(), req.ip).lastInsertRowid);
    } catch (e) {
      if (e.message === 'email' || /users_email/.test(String(e.message))) return res.status(409).json({ ok: false, error: 'That email address is already in use.' });
      if (e.message === 'taken' || /UNIQUE/.test(String(e.code || e.message))) return res.status(409).json({ ok: false, error: 'That callsign is taken.' });
      throw e;
    }
    serverlog.info('auth', `Registered ${username}`, { userId: id, ip: req.ip });
    accounts.noteLogin(id, req.ip);
    await signIn(req, id);
    let sent = null;
    if (email) sent = await accounts.sendVerification(accounts.byId(id), email, req.ip);
    res.json({ ok: true, next: accounts.gate(id) || 'game', sentTo: sent && sent.ok ? sent.sentTo : undefined, mailError: sent && !sent.ok ? sent.error : undefined });
  } catch (e) { next(e); }
});

app.post('/api/login', authLimit, async (req, res, next) => {
  try {
    if (closedForMaintenance(res)) return;
    const b = plainBody(req.body);
    const login = typeof b.login === 'string' ? b.login : b.username;
    const password = typeof b.password === 'string' ? b.password : '';
    const okShape = typeof login === 'string' && login.trim() && !accounts.checkPassword(password, { registering: false });
    const key = okShape ? login.trim().toLowerCase() : null;
    if (key && loginFails.blocked(key)) return res.status(429).json({ ok: false, error: 'Too many failed attempts for that account. Try again later.' });
    if (!(await challenge(req, res))) return;
    const user = okShape ? accounts.byLogin(login) : null;
    // Always run a compare, at the real cost, so response time doesn't reveal which accounts exist.
    const ok = await bcrypt.compare(password, user ? user.password : DUMMY_HASH);
    if (!user || !ok || user.generated || user.bot_profile) {
      if (key) loginFails.fail(key);
      serverlog.warn('auth', `Failed sign-in for "${String(login || '').slice(0, 64)}"`, { userId: user ? user.id : null, ip: req.ip });
      return res.status(401).json({ ok: false, error: 'Invalid callsign or passcode.' });
    }
    loginFails.clear(key);
    if (accounts.banned(user)) {
      serverlog.warn('auth', `Suspended account ${user.username} tried to sign in`, { userId: user.id, ip: req.ip });
      return res.status(403).json({ ok: false, error: accounts.banMessage(user), banned: true });
    }
    accounts.noteLogin(user.id, req.ip);
    serverlog.info('auth', `Signed in ${user.username}`, { userId: user.id, ip: req.ip });
    await signIn(req, user.id);
    res.json({ ok: true, next: accounts.gate(user.id) || 'game' });
  } catch (e) { next(e); }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('failtech.sid'); res.json({ ok: true }); });
});

// The signed-in account, for the sign-in page (which shows the verification step until the address is confirmed).
app.get('/api/account', (req, res) => {
  const v = req.session.userId ? accounts.accountView(req.session.userId) : null;
  if (!v) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  res.json({ ok: true, ...v });
});
// Give (or correct) the address to verify. A verified account changing its address must give its passcode; the new
// address only replaces the old one once it is confirmed.
app.post('/api/account/email', authLimit, async (req, res, next) => {
  try {
    const u = req.session.userId ? accounts.byId(req.session.userId) : null;
    if (!u) return res.status(401).json({ ok: false, error: 'Not signed in.' });
    if (accounts.banned(u)) return res.status(403).json({ ok: false, error: accounts.banMessage(u), banned: true });
    const b = plainBody(req.body);
    const email = accounts.normEmail(b.email);
    if (!email) return res.status(400).json({ ok: false, error: 'A valid email address is required.' });
    if (accounts.emailTaken(email, u.id)) return res.status(409).json({ ok: false, error: 'That email address is already in use.' });
    if (u.email_verified) {
      if (typeof b.password !== 'string' || !(await bcrypt.compare(b.password, u.password))) return res.status(401).json({ ok: false, error: 'Wrong passcode.' });
    } else {
      try { db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, u.id); } catch (e) { return res.status(409).json({ ok: false, error: 'That email address is already in use.' }); }
    }
    const sent = await accounts.sendVerification(accounts.byId(u.id), email, req.ip);
    res.status(sent.ok ? 200 : 429).json(sent);
  } catch (e) { next(e); }
});
app.post('/api/verify/resend', authLimit, async (req, res, next) => {
  try {
    const u = req.session.userId ? accounts.byId(req.session.userId) : null;
    if (!u) return res.status(401).json({ ok: false, error: 'Not signed in.' });
    const pending = db.prepare("SELECT email FROM email_tokens WHERE user_id = ? AND purpose = 'verify' ORDER BY id DESC LIMIT 1").get(u.id);
    const email = (pending && pending.email) || u.email;
    if (!email) return res.status(400).json({ ok: false, error: 'No email address on the account.' });
    const sent = await accounts.sendVerification(u, email, req.ip);
    res.status(sent.ok ? 200 : 429).json(sent);
  } catch (e) { next(e); }
});
// Confirm the address: the code from the email (signed in), or the link's token (from any browser, which it signs in).
app.post('/api/verify', authLimit, async (req, res, next) => {
  try {
    const b = plainBody(req.body);
    let found;
    if (typeof b.token === 'string') found = accounts.byLink('verify', b.token);
    else if (req.session.userId) found = accounts.byCode(req.session.userId, 'verify', b.code);
    else return res.status(401).json({ ok: false, error: 'Not signed in.' });
    if (!found.ok) return res.status(400).json(found);
    const done = accounts.applyVerify(found.token);
    if (!done.ok) return res.status(409).json(done);
    const u = accounts.byId(done.userId);
    serverlog.info('account', `Email verified for ${u.username}`, { userId: u.id, ip: req.ip });
    if (accounts.banned(u)) return res.status(403).json({ ok: false, error: accounts.banMessage(u), banned: true });
    if (req.session.userId === u.id) enterGame(u.id);
    else await signIn(req, u.id);
    res.json({ ok: true, next: accounts.gate(u.id) || 'game' });
  } catch (e) { next(e); }
});
// Passcode reset: ask for it by callsign or address (the answer is the same whether or not the account exists), then set a
// new passcode with the link's token or the code. Only a verified address can receive one.
app.post('/api/password-reset/request', authLimit, async (req, res, next) => {
  try {
    if (!(await challenge(req, res))) return;
    const u = accounts.byLogin(plainBody(req.body).login);
    if (u && u.email && u.email_verified && !u.generated && !u.bot_profile) {
      const sent = await accounts.sendReset(u, req.ip);
      if (!sent.ok && sent.wait) return res.status(429).json(sent);
    } else serverlog.info('auth', 'Reset asked for an account without a verified address', { userId: u ? u.id : null, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.post('/api/password-reset', authLimit, async (req, res, next) => {
  try {
    const b = plainBody(req.body);
    const bad = accounts.checkPassword(b.password);
    if (bad) return res.status(400).json({ ok: false, error: bad });
    let found;
    if (typeof b.token === 'string') found = accounts.byLink('reset', b.token);
    else {
      const u = accounts.byLogin(b.login);
      found = u ? accounts.byCode(u.id, 'reset', b.code) : { ok: false, error: 'That code is not right.' };
    }
    if (!found.ok) return res.status(400).json(found);
    const t = found.token;
    db.prepare('UPDATE email_tokens SET used_at = ? WHERE id = ?').run(Date.now(), t.id);
    await accounts.setPassword(t.user_id, b.password);
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ? AND email = ? COLLATE NOCASE').run(t.user_id, t.email);
    serverlog.info('account', 'Passcode reset by email', { userId: t.user_id, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- game api -----------------------------------------------------------------
const cfgJson = JSON.stringify(clientConfig());
app.get('/api/config', requireAuth, (req, res) => res.type('json').send(cfgJson));
// Public: just the wording the login page needs. Nothing about any colony.
app.get('/api/theme', (req, res) => {
  const m = lifecycle.maintenance();
  res.json({ ok: true, id: config.theme.id, ui: config.theme.ui, auth: { turnstile: turnstile.enabled() ? turnstile.siteKey() : null, email: accounts.verificationRequired(), maintenance: m ? m.message || 'Down for maintenance.' : null } });
});
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
// For the admin panel: who is connected, and a way to close a player's connections (a ban).
lifecycle.onStats(() => ({ streams: streamCount, playersConnected: streams.size }));
lifecycle.onKick((userId) => { const set = streams.get(userId); if (!set) return 0; const n = set.size; for (const r of [...set]) r.end(); return n; });
// A colony that is not being simulated does not change from tick to tick, so its open tabs are not sent a view each tick.
const simulated = (uid) => { const c = db.prepare('SELECT last_active_at, parked_at FROM colonies WHERE user_id = ?').get(uid); return !!c && absence.phase(c) === 'live'; };
// The world was held or let go (an admin paused the clock, or nobody is around): every open tab gets a fresh view, which
// says so. While it is held, each tick that does not happen still reaches the tabs, so their watchdog keeps the stream.
engine.events.on('hold', () => { for (const uid of [...streams.keys()]) { try { push(uid); } catch (e) { console.error('push failed', e); } } });
engine.events.on('held', () => { for (const set of streams.values()) for (const r of set) r.write('event: idle\ndata: {}\n\n'); });
engine.events.on('tick', () => { for (const uid of [...streams.keys()]) { if (!simulated(uid)) { for (const r of streams.get(uid)) r.write('event: idle\ndata: {}\n\n'); continue; } try { push(uid); } catch (e) { console.error('push failed', e); } } });

// Real interactions (unlike the live stream and state polls an idle open tab keeps making) keep a colony simulated.
function here(userId) { if (absence.markActive(userId)) push(userId); wake(); }
// While an admin has the clock paused nothing a player does is taken: orders placed then could not move, and anything that
// spends or trades could be played against a world that is not ticking.
// (Marking a story call or a notice as seen changes nothing in the world, so those still go through.)
const PAUSED = { ok: false, error: 'The simulation is paused.', paused: true };
const WHILE_PAUSED = new Set(['storySeen', 'ack']);
const act = (name) => (req, res) => {
  if (lifecycle.clockPaused() && !WHILE_PAUSED.has(name)) return res.status(409).json(PAUSED);
  here(req.session.userId);
  const result = actions[name](req.session.userId, plainBody(req.body));
  if (result.ok) push(req.session.userId);
  res.status(result.ok ? 200 : 400).json({ ...result, state: result.ok ? viewFor(req.session.userId) : undefined });
};
for (const [route, name] of ACTION_ROUTES) app.post(`/api/${route}`, requireAuth, act(name));

// The player is at the screen (the client sends this on input, a few times an hour at most).
app.post('/api/here', requireAuth, (req, res) => { here(req.session.userId); res.json({ ok: true }); });
// Absence: dismiss the notice after a long time away; or, for a parked colony, retake it or start a new one.
const absenceAct = (fn) => (req, res) => {
  if (lifecycle.clockPaused()) return res.status(409).json(PAUSED);
  const result = fn(req.session.userId);
  if (result.ok) push(req.session.userId);
  res.status(result.ok ? 200 : 400).json({ ...result, state: result.ok ? viewFor(req.session.userId) : undefined });
};
app.post('/api/away-ack', requireAuth, absenceAct((uid) => absence.dismiss(uid)));
app.post('/api/retake', requireAuth, absenceAct((uid) => absence.retake(uid)));
app.post('/api/start-over', requireAuth, absenceAct((uid) => absence.startOver(uid)));

// ---- pages ----------------------------------------------------------------------
// The sign-in page; a signed-in commander with nothing left to confirm goes straight to the game. (Links from emails come
// here too: /?verify=<token>, /?reset=<token>.)
app.get('/', (req, res) => (req.session.userId && !accounts.gate(req.session.userId) && !lifecycle.maintenance() && !req.query.verify && !req.query.reset ? res.redirect('/game') : res.sendFile(path.join(PUBLIC, 'index.html'))));
// The game has two shells over the same client code: game.html for a desk and mobile.html for a phone. Which one is sent:
// an explicit ?ui=mobile|desktop, else the player's saved choice (the ft_ui cookie, set from the menu), else the browser's
// own description of itself. The client corrects a wrong guess once, from the real screen size.
function wantsMobile(req) {
  const q = req.query.ui;
  if (q === 'mobile' || q === 'desktop') return q === 'mobile';
  const saved = /(?:^|;\s*)ft_ui=(mobile|desktop)(?:;|$)/.exec(req.headers.cookie || '');
  if (saved) return saved[1] === 'mobile';
  return /Mobi|Android|iPhone|iPod|Windows Phone/i.test(req.get('user-agent') || '');
}
app.get('/game', (req, res) => {
  if (!req.session.userId || accounts.gate(req.session.userId) || lifecycle.maintenance()) return res.redirect('/');
  absence.markActive(req.session.userId); // opening the game is an interaction
  res.set({ Vary: 'User-Agent, Cookie', 'Cache-Control': 'no-store' });
  res.sendFile(path.join(PUBLIC, wantsMobile(req) ? 'mobile.html' : 'game.html'));
});
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
  serverlog.error('server', `${req.method} ${req.path}: ${err.message}`, { userId: req.session && req.session.userId, ip: req.ip, data: { stack: String(err.stack || '').split('\n').slice(0, 6) } });
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
function installShutdown(servers, stopBackups) {
  let closing = false;
  const [server, ...others] = servers;
  const shutdown = (reason, code = 0) => {
    if (closing) return;
    closing = true;
    console.log(`${reason}: shutting down.`);
    const force = setTimeout(() => { console.error('Shutdown timed out; forcing exit.'); process.exit(1); }, 8000);
    force.unref();
    engine.stop();
    if (stopBackups) stopBackups();
    for (const set of streams.values()) for (const r of set) r.end();
    for (const o of others) { o.close(); o.closeIdleConnections(); }
    server.close(() => {
      try { store.db.close(); } catch (e) { console.error('Database close failed:', e); code = code || 1; }
      console.log('Shutdown complete.');
      process.exit(code);
    });
    server.closeIdleConnections();
  };
  lifecycle.onShutdown(shutdown); // the admin panel restarts the server through this (after an update or a full restore)
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => shutdown(sig));
  process.on('uncaughtException', (err) => { console.error('Uncaught exception:', err); shutdown('uncaughtException', 1); });
  process.on('unhandledRejection', (err) => { console.error('Unhandled rejection:', err); shutdown('unhandledRejection', 1); });
}

if (require.main === module) {
  acquireLock();
  engine.start();
  setInterval(() => { store.purgeSessions(); accounts.pruneTokens(); serverlog.prune(); }, 3600000).unref();
  store.purgeSessions();
  const stopBackups = backup.start();
  const server = app.listen(PORT, () => console.log(`FAILTECH command running at http://localhost:${PORT}`));
  const servers = [server];
  // The admin panel: its own port, on an internal address only (127.0.0.1 unless ADMIN_HOST says otherwise). See src/admin/.
  const adminAt = admin.listenSettings();
  if (adminAt) {
    const a = admin.app().listen(adminAt.port, adminAt.host, () => console.log(`Admin panel on http://${adminAt.host}:${adminAt.port}`));
    a.on('error', (e) => console.error(`Admin panel could not start on ${adminAt.host}:${adminAt.port}: ${e.message}`));
    servers.push(a);
  } else console.log('Admin panel is off (ADMIN_PORT=off).');
  for (const x of servers) {
    x.requestTimeout = 30000;
    x.headersTimeout = 15000;
    x.keepAliveTimeout = 15000;
    x.maxHeadersCount = 50;
  }
  for (const w of startupWarnings()) { console.warn(`Warning: ${w}`); serverlog.warn('server', w); }
  serverlog.info('server', `Server started (pid ${process.pid})`);
  installShutdown(servers, stopBackups);
}

// What a production deployment probably wants set.
function startupWarnings() {
  const out = [];
  const mail = require('./src/mail');
  if (accounts.verificationRequired() && mail.transportName() === 'log') out.push('EMAIL_VERIFICATION is on but no mail transport is configured: codes are only written to this log.');
  if (accounts.verificationRequired() && !process.env.PUBLIC_URL) out.push('PUBLIC_URL is not set: emails carry a code but no link.');
  if (!turnstile.enabled()) out.push('Cloudflare Turnstile is off (TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY).');
  return out;
}
module.exports = app;
