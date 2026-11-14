'use strict';
// Player accounts beyond the callsign and passcode: the email address and its verification, passcode resets, bans.
//
// Verification (EMAIL_VERIFICATION, default "required"; "off" turns it off): a new commander gives an email address; one
// email carries a 6-digit code and, when PUBLIC_URL is set, a link (/?verify=<token>), and either one verifies it. The
// colony is founded once the address is verified. An older account without an address is asked for one at its next sign-in.
// Generated accounts (parked colonies) and bot accounts have no address and need none: nobody signs in to them.
//
// A token is stored as hashes only. A code takes at most 5 guesses, every token lasts EMAIL_CODE_MINUTES (default 30) and
// is used once, and asking for a new one retires the old. Sending is limited per account and per address.
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const store = require('./db');
const mail = require('./mail');
const log = require('./serverlog');
const { db, config } = store;

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS) || 12;
const MAX_PASS_BYTES = 72;
const CODE_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60000;
const SENDS_PER_HOUR = 6;
const tokenMinutes = () => Math.max(5, Number(process.env.EMAIL_CODE_MINUTES) || 30);
const verificationRequired = () => (process.env.EMAIL_VERIFICATION || 'required') !== 'off';
const publicUrl = () => (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const brand = () => (config.theme && config.theme.ui && config.theme.ui.brand) || 'FAILTECH';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sameHash = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

// ---- validation ------------------------------------------------------------------------------------------------------
const CALLSIGN = /^[A-Za-z0-9_]{3,20}$/;
// Deliberately plain: one @, no spaces, quotes, angle brackets or control characters, a dot in the domain.
const EMAIL = /^[^\s@<>()",;:\\[\]\x00-\x1f\x7f]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;
function normEmail(e) {
  if (typeof e !== 'string') return null;
  const v = e.trim().toLowerCase();
  return v.length <= 254 && EMAIL.test(v) ? v : null;
}
function checkPassword(p, { registering = true } = {}) {
  if (typeof p !== 'string') return 'Passcode is required.';
  if (Buffer.byteLength(p) > MAX_PASS_BYTES) return `Passcode must be at most ${MAX_PASS_BYTES} bytes.`;
  if (registering && p.length < 8) return 'Passcode must be at least 8 characters.';
  if (!registering && p.length < 1) return 'Passcode is required.';
  return null;
}
const hashPassword = (p) => bcrypt.hash(p, BCRYPT_ROUNDS);

// "a***@example.com": enough to recognise an address without showing it.
function mask(email) {
  if (!email) return null;
  const [u, d] = email.split('@');
  return `${u.slice(0, 1)}${'*'.repeat(Math.max(1, Math.min(6, u.length - 1)))}@${d}`;
}

// ---- lookups ---------------------------------------------------------------------------------------------------------
const byId = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
// Sign in with the callsign or the email address.
function byLogin(login) {
  if (typeof login !== 'string') return null;
  const v = login.trim();
  if (v.includes('@')) { const e = normEmail(v); return e ? db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(e) : null; }
  return CALLSIGN.test(v) ? db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(v) : null;
}
const emailTaken = (email, exceptId = 0) => !!db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND id != ?').get(email, exceptId);

// ---- bans ------------------------------------------------------------------------------------------------------------
function banned(u, now = Date.now()) {
  if (!u || !u.banned_at) return false;
  if (u.ban_until && u.ban_until <= now) { // a temporary ban that has run out lifts itself
    db.prepare('UPDATE users SET banned_at = NULL, ban_until = NULL, ban_reason = NULL WHERE id = ?').run(u.id);
    return false;
  }
  return true;
}
function ban(userId, { reason = null, until = null } = {}) {
  db.prepare('UPDATE users SET banned_at = ?, ban_until = ?, ban_reason = ? WHERE id = ?').run(Date.now(), until || null, reason ? String(reason).slice(0, 300) : null, userId);
  return store.endSessions(userId);
}
const unban = (userId) => db.prepare('UPDATE users SET banned_at = NULL, ban_until = NULL, ban_reason = NULL WHERE id = ?').run(userId).changes;
function banMessage(u) {
  const when = u.ban_until ? ` until ${new Date(u.ban_until).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
  return `This account is suspended${when}.${u.ban_reason ? ` Reason: ${u.ban_reason}` : ''}`;
}

// What stands between a signed-in account and the game: null (nothing), 'banned', 'email' (no address yet) or 'verify'.
function gate(userId) {
  const u = byId(userId);
  if (!u) return 'gone';
  if (banned(u)) return 'banned';
  if (!verificationRequired() || u.generated || u.bot_profile || u.email_verified) return null;
  return u.email ? 'verify' : 'email';
}

// ---- tokens ----------------------------------------------------------------------------------------------------------
// A new code and link for `purpose`, retiring any earlier ones. Refused (with `wait`) when asked for too often.
function issue(userId, purpose, email, now = Date.now()) {
  // (a corrected address need not wait: the cooldown is per address; the hourly cap counts them all)
  const last = db.prepare('SELECT created_at, email FROM email_tokens WHERE user_id = ? AND purpose = ? ORDER BY id DESC LIMIT 1').get(userId, purpose);
  if (last && last.email === email && now - last.created_at < RESEND_COOLDOWN_MS) return fail('A code was sent a moment ago. Wait a minute.', { wait: Math.ceil((RESEND_COOLDOWN_MS - (now - last.created_at)) / 1000) });
  const hour = now - 3600000;
  const n = db.prepare('SELECT COUNT(*) AS n FROM email_tokens WHERE (user_id = ? OR email = ?) AND created_at >= ?').get(userId, email, hour).n;
  if (n >= SENDS_PER_HOUR) return fail('Too many codes sent. Try again later.');
  db.prepare('UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL').run(now, userId, purpose);
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const link = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO email_tokens (user_id, purpose, email, code_hash, link_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, purpose, email, sha(`${userId}:${code}`), sha(link), now, now + tokenMinutes() * 60000);
  return { ok: true, code, link };
}

async function deliver(u, purpose, email, ip) {
  const t = issue(u.id, purpose, email);
  if (!t.ok) return t;
  const base = publicUrl();
  const verifying = purpose === 'verify';
  const msg = mail.compose({
    brand: brand(), to: email,
    subject: verifying ? `${brand()}: confirm your email` : `${brand()}: passcode reset`,
    intro: verifying ? `Confirmation code for commander ${u.username}.` : `Passcode reset for commander ${u.username}.`,
    code: t.code,
    link: base ? `${base}/?${verifying ? 'verify' : 'reset'}=${t.link}` : null,
    linkLabel: verifying ? 'Confirm email' : 'Choose a new passcode',
    outro: `Valid for ${tokenMinutes()} minutes. If this was not you, ignore this message.`,
  });
  try {
    await mail.send(msg);
  } catch (e) {
    log.error('account', `Email to ${mask(email)} failed: ${e.message}`, { userId: u.id, ip });
    db.prepare('DELETE FROM email_tokens WHERE user_id = ? AND purpose = ? AND used_at IS NULL').run(u.id, purpose); // so a retry is not held back by the cooldown
    return fail('The email could not be sent. Try again later.');
  }
  log.info('account', `${verifying ? 'Verification' : 'Reset'} email sent to ${mask(email)}`, { userId: u.id, ip });
  return { ok: true, sentTo: mask(email) };
}
const sendVerification = (u, email, ip) => deliver(u, 'verify', email, ip);
const sendReset = (u, ip) => deliver(u, 'reset', u.email, ip);

// The account's current token for `purpose`, if `code` is right. A wrong guess counts against it.
function byCode(userId, purpose, code, now = Date.now()) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return fail('Enter the 6-digit code.');
  const t = db.prepare('SELECT * FROM email_tokens WHERE user_id = ? AND purpose = ? AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1').get(userId, purpose, now);
  if (!t) return fail('That code has expired. Ask for a new one.');
  if (t.attempts >= CODE_ATTEMPTS) return fail('Too many wrong codes. Ask for a new one.');
  if (!sameHash(t.code_hash, sha(`${userId}:${code.trim()}`))) {
    db.prepare('UPDATE email_tokens SET attempts = attempts + 1 WHERE id = ?').run(t.id);
    return fail('That code is not right.');
  }
  return { ok: true, token: t };
}
function byLink(purpose, link, now = Date.now()) {
  if (typeof link !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(link)) return fail('That link is not valid.');
  const row = db.prepare('SELECT * FROM email_tokens WHERE link_hash = ? AND purpose = ?').get(sha(link), purpose);
  if (!row || row.used_at || row.expires_at <= now) return fail('That link has expired or was already used.');
  return { ok: true, token: row };
}

// The address in the token becomes the account's, verified. (It may have been taken by someone else meanwhile.)
const applyVerify = db.transaction((t, now = Date.now()) => {
  if (emailTaken(t.email, t.user_id)) return fail('That email address is already in use.');
  db.prepare('UPDATE email_tokens SET used_at = ? WHERE id = ?').run(now, t.id);
  db.prepare('UPDATE users SET email = ?, email_verified = 1 WHERE id = ?').run(t.email, t.user_id);
  return { ok: true, userId: t.user_id };
});

// A new passcode; every session of the account ends. A reset by email also proves the address.
async function setPassword(userId, password) {
  const hash = await hashPassword(password);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, userId);
  return store.endSessions(userId);
}

function noteLogin(userId, ip, now = Date.now()) {
  db.prepare('UPDATE users SET last_login_at = ?, last_ip = ? WHERE id = ?').run(now, ip || null, userId);
}

// What the sign-in page needs to know about the signed-in account.
function accountView(userId) {
  const u = byId(userId);
  if (!u) return null;
  return { username: u.username, email: mask(u.email), verified: !!u.email_verified, totp: !!u.totp_on, next: gate(userId) || 'game' };
}

// A player's authenticator code (optional, see server.js). A code is accepted once: the step it matched is kept.
function checkTotp(u, code) {
  if (!u || !u.totp_on || !u.totp_secret) return false;
  const step = require('./totp').check(u.totp_secret, code);
  if (step === null || step <= (u.totp_step || 0)) return false;
  db.prepare('UPDATE users SET totp_step = ? WHERE id = ?').run(step, u.id);
  return true;
}

function pruneTokens(now = Date.now()) {
  return db.prepare('DELETE FROM email_tokens WHERE expires_at < ?').run(now - 7 * 86400000).changes;
}

module.exports = {
  CALLSIGN, MAX_PASS_BYTES, verificationRequired, normEmail, checkPassword, hashPassword, mask, byId, byLogin, emailTaken,
  banned, ban, unban, banMessage, gate, checkTotp, issue, sendVerification, sendReset, byCode, byLink, applyVerify, setPassword, noteLogin, accountView, pruneTokens,
};
