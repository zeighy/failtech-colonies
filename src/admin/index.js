'use strict';
// The admin panel: a separate web app on its own port, bound to an internal address (ADMIN_HOST, default 127.0.0.1;
// ADMIN_PORT, default 3001, "off" for none). It runs in the game server's process, so it sees the same database and clock,
// but nothing of it is reachable through the game's port.
//
// Admins are their own accounts (table `admins`), made with `npm run admin -- create <name>` and then from the panel. Each
// signs in with a passcode and, once they have set it up, a code from an authenticator app (TOTP). Role "viewer" can look
// but not change anything. Every change is written to the audit log (admin_audit) with who made it and from where.
// ADMIN_ALLOW (comma-separated addresses or IPv4 ranges like 10.0.0.0/8) refuses everyone else, on top of the bind address.
//
// The routes are split by area: users.js (accounts and colonies), world.js (parked colonies, the markets, the clock),
// bots.js (the bot runner), ops.js (backups, logs, maintenance and updates).
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const path = require('path');
const store = require('../db');
const security = require('../security');
const totp = require('../totp');
const { body: plainBody, toInt } = require('../validate');
const { db } = store;

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS) || 12;
const NAME = /^[A-Za-z0-9_.-]{3,32}$/;
const ROLES = new Set(['admin', 'viewer']);

function listenSettings() {
  const p = process.env.ADMIN_PORT;
  if (p === 'off' || p === '0' || p === 'false') return null;
  return { port: Number(p) || 3001, host: process.env.ADMIN_HOST || '127.0.0.1' };
}

// ---- addresses ----------------------------------------------------------------------------------------------------------
const v4 = (ip) => { const m = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip || ''); return m ? m.slice(1).map(Number).reduce((a, b) => a * 256 + b, 0) : null; };
function allowed(ip, list = (process.env.ADMIN_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean)) {
  if (!list.length) return true;
  const n = v4(ip);
  return list.some((rule) => {
    if (rule.includes('/')) {
      const [base, bits] = rule.split('/');
      const b = v4(base); const k = Number(bits);
      if (n === null || b === null || !(k >= 0 && k <= 32)) return false;
      const mask = k === 0 ? 0 : (0xffffffff << (32 - k)) >>> 0;
      return ((n & mask) >>> 0) === ((b & mask) >>> 0);
    }
    return rule === ip || (n !== null && v4(rule) === n);
  });
}
const ipOf = (req) => req.socket.remoteAddress || '';

// ---- admin accounts -------------------------------------------------------------------------------------------------------
const adminById = (id) => db.prepare('SELECT * FROM admins WHERE id = ?').get(id);
const publicAdmin = (a) => (a ? { id: a.id, username: a.username, role: a.role, totp: !!a.totp_on, disabled: !!a.disabled, createdAt: a.created_at, lastLoginAt: a.last_login_at } : null);
function checkPass(p) {
  if (typeof p !== 'string' || p.length < 10) return 'Admin passcodes are at least 10 characters.';
  if (Buffer.byteLength(p) > 72) return 'At most 72 bytes.';
  return null;
}
async function createAdmin(username, password, role = 'admin') {
  if (!NAME.test(String(username || ''))) return { ok: false, error: 'Name: 3-32 letters, numbers, dots, dashes or underscores.' };
  const bad = checkPass(password);
  if (bad) return { ok: false, error: bad };
  if (!ROLES.has(role)) return { ok: false, error: 'Bad role.' };
  if (db.prepare('SELECT 1 FROM admins WHERE username = ? COLLATE NOCASE').get(username)) return { ok: false, error: 'That name is taken.' };
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const id = Number(db.prepare('INSERT INTO admins (username, password, role, created_at) VALUES (?, ?, ?, ?)').run(username, hash, role, Date.now()).lastInsertRowid);
  return { ok: true, id };
}
const endAdminSessions = (adminId) => db.prepare("DELETE FROM admin_sessions WHERE json_extract(sess, '$.adminId') = ?").run(adminId).changes;

function audit(req, action, target = null, detail = null) {
  const who = req.admin ? req.admin.username : '?';
  db.prepare('INSERT INTO admin_audit (at, admin, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?)')
    .run(Date.now(), who, action, target === null ? null : String(target).slice(0, 200), detail === null ? null : JSON.stringify(detail).slice(0, 4000), ipOf(req));
}

const DUMMY = bcrypt.hashSync(crypto.randomBytes(8).toString('hex'), BCRYPT_ROUNDS);
const usedSteps = new Map(); // adminId -> the last TOTP step accepted (no replays)

function app() {
  const a = express();
  a.disable('x-powered-by');
  a.use((req, res, next) => (allowed(ipOf(req)) ? next() : res.status(403).type('text').send('Forbidden')));
  a.use(security.headers);
  a.use((req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); next(); });
  a.use('/api', security.sameOrigin([]));
  a.use('/api', security.jsonOnly);
  a.use(express.json({ limit: '64kb', strict: true }));
  let secret = store.getMeta('admin_session_secret');
  if (!secret) { secret = crypto.randomBytes(32).toString('hex'); store.setMeta('admin_session_secret', secret); }
  a.use(session({
    name: 'failtech.admin', secret, store: new store.SqliteStore('admin_sessions'), resave: false, saveUninitialized: false, rolling: true,
    cookie: { httpOnly: true, sameSite: 'strict', maxAge: 12 * 3600000, secure: 'auto' },
  }));

  const loginLimit = security.limiter({ windowMs: 60000, max: Number(process.env.ADMIN_RATE_LIMIT) || 10, key: (req) => ipOf(req), message: 'Too many attempts. Wait a minute.' });
  const fails = security.failureTracker({ windowMs: 15 * 60000, max: 5 });
  const apiLimit = security.limiter({ windowMs: 10000, max: 400, key: (req) => ipOf(req) });
  a.use('/api', apiLimit);

  const r = express.Router();
  // Signed in as an admin that still exists and is not disabled. Writes need the "admin" role.
  const need = (req, res, next) => {
    const ad = req.session.adminId ? adminById(req.session.adminId) : null;
    if (!ad || ad.disabled) return req.session.destroy(() => res.status(401).json({ ok: false, error: 'Not signed in.' }));
    req.admin = ad;
    if (req.method !== 'GET' && ad.role !== 'admin' && !req.path.startsWith('/me')) return res.status(403).json({ ok: false, error: 'Read-only account.' });
    next();
  };
  const h = { audit, need, body: plainBody, toInt, ok: (res, data = {}) => res.json({ ok: true, ...data }), bad: (res, error, status = 400) => res.status(status).json({ ok: false, error }) };

  r.post('/login', loginLimit, async (req, res, next) => {
    try {
      const b = plainBody(req.body);
      const name = typeof b.username === 'string' ? b.username.trim() : '';
      const key = name.toLowerCase();
      if (key && fails.blocked(key)) return h.bad(res, 'Too many failed attempts. Try again later.', 429);
      const ad = NAME.test(name) ? db.prepare('SELECT * FROM admins WHERE username = ? COLLATE NOCASE').get(name) : null;
      const good = await bcrypt.compare(typeof b.password === 'string' ? b.password : '', ad ? ad.password : DUMMY);
      if (!ad || !good || ad.disabled) {
        if (key) fails.fail(key);
        db.prepare('INSERT INTO admin_audit (at, admin, action, target, ip) VALUES (?, ?, ?, ?, ?)').run(Date.now(), name.slice(0, 32) || '?', 'login.failed', null, ipOf(req));
        return h.bad(res, 'Invalid name or passcode.', 401);
      }
      if (ad.totp_on) {
        if (typeof b.totp !== 'string' || !b.totp.trim()) return res.status(401).json({ ok: false, error: 'Enter the code from your authenticator.', totp: true });
        const step = totp.check(ad.totp_secret, b.totp);
        if (step === null || step <= (usedSteps.get(ad.id) || 0)) { fails.fail(key); return res.status(401).json({ ok: false, error: 'That code is not right.', totp: true }); }
        usedSteps.set(ad.id, step);
      }
      fails.clear(key);
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.adminId = ad.id;
        db.prepare('UPDATE admins SET last_login_at = ? WHERE id = ?').run(Date.now(), ad.id);
        req.admin = ad;
        audit(req, 'login');
        req.session.save((e) => (e ? next(e) : h.ok(res, { me: publicAdmin(ad), totpMissing: !ad.totp_on })));
      });
    } catch (e) { next(e); }
  });
  r.post('/logout', (req, res) => req.session.destroy(() => { res.clearCookie('failtech.admin'); h.ok(res); }));
  r.get('/me', need, (req, res) => h.ok(res, { me: publicAdmin(req.admin) }));
  r.post('/me/password', need, async (req, res, next) => {
    try {
      const b = plainBody(req.body);
      if (!(await bcrypt.compare(typeof b.current === 'string' ? b.current : '', req.admin.password))) return h.bad(res, 'Wrong current passcode.', 401);
      const bad = checkPass(b.password);
      if (bad) return h.bad(res, bad);
      db.prepare('UPDATE admins SET password = ? WHERE id = ?').run(await bcrypt.hash(b.password, BCRYPT_ROUNDS), req.admin.id);
      audit(req, 'me.password');
      h.ok(res);
    } catch (e) { next(e); }
  });
  // Two-factor: a new secret is held in the session until a code from it is entered.
  r.post('/me/totp/setup', need, (req, res) => {
    const secretKey = totp.newSecret();
    req.session.totpPending = secretKey;
    h.ok(res, { secret: secretKey, uri: totp.uri(secretKey, req.admin.username, `${(store.config.theme.ui && store.config.theme.ui.brand) || 'FAILTECH'} admin`) });
  });
  r.post('/me/totp/enable', need, (req, res) => {
    const pending = req.session.totpPending;
    if (!pending) return h.bad(res, 'Start the setup first.');
    if (totp.check(pending, plainBody(req.body).code) === null) return h.bad(res, 'That code is not right.');
    db.prepare('UPDATE admins SET totp_secret = ?, totp_on = 1 WHERE id = ?').run(pending, req.admin.id);
    delete req.session.totpPending;
    audit(req, 'me.totp.enable');
    h.ok(res);
  });
  r.post('/me/totp/disable', need, (req, res) => {
    if (!req.admin.totp_on) return h.ok(res);
    if (totp.check(req.admin.totp_secret, plainBody(req.body).code) === null) return h.bad(res, 'That code is not right.');
    db.prepare('UPDATE admins SET totp_secret = NULL, totp_on = 0 WHERE id = ?').run(req.admin.id);
    audit(req, 'me.totp.disable');
    h.ok(res);
  });

  // ---- other admins ----
  r.get('/admins', need, (req, res) => h.ok(res, { admins: db.prepare('SELECT * FROM admins ORDER BY id').all().map(publicAdmin) }));
  r.post('/admins', need, async (req, res, next) => {
    try {
      const b = plainBody(req.body);
      const out = await createAdmin(typeof b.username === 'string' ? b.username.trim() : '', b.password, b.role || 'admin');
      if (!out.ok) return h.bad(res, out.error);
      audit(req, 'admin.create', b.username, { role: b.role || 'admin' });
      h.ok(res, { id: out.id });
    } catch (e) { next(e); }
  });
  r.post('/admins/:id', need, async (req, res, next) => {
    try {
      const target = adminById(toInt(req.params.id));
      if (!target) return h.bad(res, 'No such admin.', 404);
      const b = plainBody(req.body);
      const changes = {};
      if (b.role !== undefined) { if (!ROLES.has(b.role)) return h.bad(res, 'Bad role.'); changes.role = b.role; }
      if (b.disabled !== undefined) changes.disabled = b.disabled ? 1 : 0;
      if ((changes.disabled || (changes.role && changes.role !== 'admin')) && target.id === req.admin.id) return h.bad(res, 'You cannot lock yourself out.');
      const activeAdmins = db.prepare("SELECT COUNT(*) AS n FROM admins WHERE role = 'admin' AND disabled = 0").get().n;
      if (target.role === 'admin' && !target.disabled && (changes.disabled || (changes.role && changes.role !== 'admin')) && activeAdmins <= 1) return h.bad(res, 'At least one admin must remain.');
      if (b.password !== undefined) { const bad = checkPass(b.password); if (bad) return h.bad(res, bad); changes.password = await bcrypt.hash(b.password, BCRYPT_ROUNDS); }
      if (b.totpOff) { changes.totp_on = 0; changes.totp_secret = null; }
      const keys = Object.keys(changes);
      if (!keys.length) return h.ok(res);
      db.prepare(`UPDATE admins SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => changes[k]), target.id);
      if (changes.disabled || changes.password || b.totpOff) endAdminSessions(target.id);
      audit(req, 'admin.update', target.username, { role: changes.role, disabled: changes.disabled, password: !!changes.password, totpOff: !!b.totpOff });
      h.ok(res);
    } catch (e) { next(e); }
  });
  r.get('/audit', need, (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
    const before = toInt(req.query.before);
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const rows = db.prepare(`SELECT * FROM admin_audit WHERE (? = '' OR admin LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')
      AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT 300`).all(q, like, like, like, like, Number.isNaN(before) ? null : before, Number.isNaN(before) ? null : before);
    h.ok(res, { audit: rows.map((x) => ({ ...x, detail: x.detail ? JSON.parse(x.detail) : null })) });
  });

  require('./users')(r, h);
  require('./world')(r, h);
  require('./bots')(r, h);
  require('./ops')(r, h);

  a.use('/api', r);
  a.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Not found.' }));
  const ui = path.join(__dirname, 'public');
  a.get('/', (req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(ui, 'index.html')); });
  a.use(express.static(ui, { index: false, maxAge: 0, dotfiles: 'deny', redirect: false }));
  a.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = Number(err.status || err.statusCode);
    if (status >= 400 && status < 500) return res.status(status).json({ ok: false, error: status === 413 ? 'Request too large.' : 'Bad request.' });
    console.error('admin:', err);
    try { require('../serverlog').error('admin', `${req.method} ${req.path}: ${err.message}`, { ip: ipOf(req) }); } catch (e) { /* best effort */ }
    res.status(500).json({ ok: false, error: `Server error: ${err.message}` });
  });
  return a;
}

module.exports = { app, listenSettings, createAdmin, checkPass, allowed, endAdminSessions, publicAdmin };
