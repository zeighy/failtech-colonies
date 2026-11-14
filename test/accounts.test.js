'use strict';
// Accounts (src/accounts.js and the auth routes in server.js): sign-up with an email address, verification by code or link,
// Turnstile, sign-in by callsign or email, older accounts without an address, passcode resets, suspensions, maintenance.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-acc-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.THEME = 'basic';
process.env.EMAIL_VERIFICATION = 'required';
process.env.MAIL_TRANSPORT = 'log';
process.env.MAIL_LOG = 'quiet';
process.env.PUBLIC_URL = 'https://game.example';
process.env.TURNSTILE_SITE_KEY = 'site-key';
process.env.TURNSTILE_SECRET_KEY = 'secret-key';
process.env.AUTH_RATE_LIMIT = '1000';
process.env.BCRYPT_ROUNDS = '4';
process.env.API_RATE_LIMIT = '100000';
process.env.HAZARDS = 'off';

const turnstile = require('../src/turnstile');
turnstile.setVerifier(async (token) => ({ ok: token === 'pass', codes: token === 'down' ? ['unreachable'] : [] }));
const app = require('../server');
const store = require('../src/db');
const mail = require('../src/mail');
const accounts = require('../src/accounts');
const lifecycle = require('../src/lifecycle');
const { db } = store;

let server, base;
test.before(async () => { await new Promise((r) => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b || {}) };
}
const lastMail = (to) => [...mail.outbox].reverse().find((m) => m.to === to);
const codeOf = (m) => /Code: (\d{6})/.exec(m.text)[1];
const linkOf = (m, kind) => new RegExp(`\\?${kind}=([A-Za-z0-9_-]+)`).exec(m.text)[1];
// the cooldown between codes is a minute: tests move the last token back in time instead of waiting
const age = (userId) => db.prepare('UPDATE email_tokens SET created_at = created_at - 120000 WHERE user_id = ?').run(userId);
const idOf = (name) => db.prepare('SELECT id FROM users WHERE username = ?').get(name).id;

test('the sign-in page is told about Turnstile and email; the CSP lets the widget load', async () => {
  const c = client();
  const r = await c.get('/api/theme');
  assert.equal(r.body.auth.turnstile, 'site-key');
  assert.equal(r.body.auth.email, true);
  const page = await c.get('/');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self' https:\/\/challenges\.cloudflare\.com/);
  assert.match(page.headers.get('content-security-policy'), /frame-src https:\/\/challenges\.cloudflare\.com/);
});

test('sign-up needs an email address and the challenge, and the colony waits for the address to be confirmed', async () => {
  const c = client();
  assert.equal((await c.post('/api/register', { username: 'nomail', password: 'hunter22', turnstile: 'pass' })).status, 400);
  assert.equal((await c.post('/api/register', { username: 'bademail', password: 'hunter22', email: 'not an email', turnstile: 'pass' })).status, 400);
  const noTs = await c.post('/api/register', { username: 'alpha', password: 'hunter22', email: 'alpha@example.com' });
  assert.equal(noTs.status, 400);
  assert.equal(noTs.body.challenge, true);
  assert.equal((await c.post('/api/register', { username: 'alpha', password: 'hunter22', email: 'alpha@example.com', turnstile: 'nope' })).status, 400);
  const down = await c.post('/api/register', { username: 'alpha', password: 'hunter22', email: 'alpha@example.com', turnstile: 'down' });
  assert.match(down.body.error, /could not be checked/);

  const r = await c.post('/api/register', { username: 'alpha', password: 'hunter22', email: 'Alpha@Example.com', turnstile: 'pass' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.next, 'verify');
  assert.equal(r.body.sentTo, 'a****@example.com');
  const m = lastMail('alpha@example.com');
  assert.ok(m, 'a verification email went out (addresses are kept in lower case)');
  assert.match(m.text, /https:\/\/game\.example\/\?verify=/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM colonies WHERE user_id = ?').get(idOf('alpha')).n, 0, 'no colony yet');

  const st = await c.get('/api/state');
  assert.equal(st.status, 403);
  assert.equal(st.body.next, 'verify');
  assert.equal((await c.get('/game')).status, 302);
  assert.equal((await c.get('/api/account')).body.next, 'verify');

  assert.equal((await c.post('/api/verify', { code: '000000' === codeOf(m) ? '111111' : '000000' })).status, 400);
  const ok = await c.post('/api/verify', { code: codeOf(m) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.next, 'game');
  const s2 = await c.get('/api/state');
  assert.equal(s2.status, 200);
  assert.equal(s2.body.user, 'alpha');
  assert.equal(accounts.byId(idOf('alpha')).email_verified, 1);

  const dup = await client().post('/api/register', { username: 'alpha2', password: 'hunter22', email: 'ALPHA@example.com', turnstile: 'pass' });
  assert.equal(dup.status, 409, 'one address, one account');
});

test('the link verifies from any browser and signs it in; a used link is dead', async () => {
  const a = client();
  await a.post('/api/register', { username: 'bravo', password: 'hunter22', email: 'bravo@example.com', turnstile: 'pass' });
  const token = linkOf(lastMail('bravo@example.com'), 'verify');
  const phone = client();
  const r = await phone.post('/api/verify', { token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await phone.get('/api/state')).status, 200);
  assert.equal((await client().post('/api/verify', { token })).status, 400, 'used once');
  assert.equal((await a.get('/api/state')).status, 200, 'the first browser is through too');
});

test('codes: a resend waits a minute, a new code retires the old, and five wrong guesses kill it', async () => {
  const c = client();
  await c.post('/api/register', { username: 'charlie', password: 'hunter22', email: 'charlie@example.com', turnstile: 'pass' });
  const first = codeOf(lastMail('charlie@example.com'));
  assert.equal((await c.post('/api/verify/resend')).status, 429);
  age(idOf('charlie'));
  assert.equal((await c.post('/api/verify/resend')).status, 200);
  const second = codeOf(lastMail('charlie@example.com'));
  if (first !== second) assert.equal((await c.post('/api/verify', { code: first })).status, 400, 'the old code is retired');
  const wrong = second === '123456' ? '654321' : '123456';
  for (let i = 0; i < 5; i++) await c.post('/api/verify', { code: wrong });
  const r = await c.post('/api/verify', { code: second });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Too many wrong codes/);
});

test('sign-in by callsign or email, behind the challenge; a wrong address before verification can be corrected', async () => {
  const c = client();
  await c.post('/api/register', { username: 'delta', password: 'hunter22', email: 'typo@exmaple.com', turnstile: 'pass' });
  const fix = await c.post('/api/account/email', { email: 'delta@example.com' });
  assert.equal(fix.status, 200, JSON.stringify(fix.body));
  assert.equal(accounts.byId(idOf('delta')).email, 'delta@example.com');
  await c.post('/api/verify', { code: codeOf(lastMail('delta@example.com')) });

  const d = client();
  assert.equal((await d.post('/api/login', { login: 'delta@example.com', password: 'hunter22' })).body.challenge, true);
  const r = await d.post('/api/login', { login: 'DELTA@example.com', password: 'hunter22', turnstile: 'pass' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.next, 'game');
  assert.equal((await client().post('/api/login', { username: 'delta', password: 'hunter22', turnstile: 'pass' })).status, 200, 'the old field name still works');
  assert.equal((await client().post('/api/login', { login: 'delta', password: 'wrong-one', turnstile: 'pass' })).status, 401);
  assert.ok(db.prepare("SELECT 1 FROM server_log WHERE category = 'auth' AND message LIKE 'Failed sign-in%'").get(), 'failed sign-ins are logged');
  assert.ok(accounts.byId(idOf('delta')).last_login_at > 0);
});

test('an older account without an address is asked for one, and keeps its colony', async () => {
  const hash = await accounts.hashPassword('hunter22');
  const id = Number(db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('oldtimer', hash).lastInsertRowid);
  const colony = store.ensureColony(id);
  const c = client();
  const r = await c.post('/api/login', { login: 'oldtimer', password: 'hunter22', turnstile: 'pass' });
  assert.equal(r.body.next, 'email');
  assert.equal((await c.get('/api/state')).body.next, 'email');
  await c.post('/api/account/email', { email: 'old@example.com' });
  const v = await c.post('/api/verify', { code: codeOf(lastMail('old@example.com')) });
  assert.equal(v.body.next, 'game');
  assert.equal(db.prepare('SELECT id FROM colonies WHERE user_id = ?').get(id).id, colony);
});

test('a verified account changing its address gives its passcode, and keeps the old one until the new is confirmed', async () => {
  const c = client();
  await c.post('/api/login', { login: 'bravo', password: 'hunter22', turnstile: 'pass' });
  assert.equal((await c.post('/api/account/email', { email: 'bravo2@example.com' })).status, 400, 'a passcode is required');
  assert.equal((await c.post('/api/account/email', { email: 'bravo2@example.com', password: 'hunter22' })).status, 200);
  assert.equal(accounts.byId(idOf('bravo')).email, 'bravo@example.com');
  await c.post('/api/verify', { code: codeOf(lastMail('bravo2@example.com')) });
  assert.equal(accounts.byId(idOf('bravo')).email, 'bravo2@example.com');
});

test('passcode reset by email: the same answer for any account, then a code or the link sets a new passcode and signs out everywhere', async () => {
  const anyone = client();
  assert.equal((await anyone.post('/api/password-reset/request', { login: 'nobody_here', turnstile: 'pass' })).status, 200);
  assert.equal((await anyone.post('/api/password-reset/request', { login: 'alpha' })).status, 400, 'the challenge is required');
  const session = client();
  await session.post('/api/login', { login: 'alpha', password: 'hunter22', turnstile: 'pass' });
  assert.equal((await anyone.post('/api/password-reset/request', { login: 'alpha@example.com', turnstile: 'pass' })).status, 200);
  const m = lastMail('alpha@example.com');
  assert.match(m.subject, /reset/);
  assert.equal((await anyone.post('/api/password-reset', { login: 'alpha', code: codeOf(m), password: 'short' })).status, 400);
  const r = await anyone.post('/api/password-reset', { login: 'alpha', code: codeOf(m), password: 'brand-new-pass' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await session.get('/api/state')).status, 401, 'signed out everywhere');
  assert.equal((await client().post('/api/login', { login: 'alpha', password: 'hunter22', turnstile: 'pass' })).status, 401);
  assert.equal((await client().post('/api/login', { login: 'alpha', password: 'brand-new-pass', turnstile: 'pass' })).status, 200);

  age(idOf('alpha'));
  await anyone.post('/api/password-reset/request', { login: 'alpha', turnstile: 'pass' });
  const token = linkOf(lastMail('alpha@example.com'), 'reset');
  assert.equal((await anyone.post('/api/password-reset', { token, password: 'another-pass' })).status, 200);
  assert.equal((await anyone.post('/api/password-reset', { token, password: 'third-pass!' })).status, 400, 'a link works once');
  assert.equal((await client().post('/api/login', { login: 'alpha', password: 'another-pass', turnstile: 'pass' })).status, 200);
});

test('a suspension ends the sessions, refuses sign-in with the reason, and a timed one lifts itself', async () => {
  const c = client();
  await c.post('/api/login', { login: 'delta', password: 'hunter22', turnstile: 'pass' });
  assert.equal((await c.get('/api/state')).status, 200);
  accounts.ban(idOf('delta'), { reason: 'market abuse' });
  assert.equal((await c.get('/api/state')).status, 401, 'the session is gone');
  const r = await client().post('/api/login', { login: 'delta', password: 'hunter22', turnstile: 'pass' });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /suspended.*market abuse/);
  db.prepare('UPDATE users SET ban_until = ? WHERE id = ?').run(Date.now() - 1, idOf('delta'));
  assert.equal((await client().post('/api/login', { login: 'delta', password: 'hunter22', turnstile: 'pass' })).status, 200, 'expired');
  assert.equal(accounts.byId(idOf('delta')).banned_at, null);
});

test('maintenance mode closes sign-in and the game, and says so on the sign-in page', async () => {
  const c = client();
  await c.post('/api/login', { login: 'bravo', password: 'hunter22', turnstile: 'pass' });
  lifecycle.setMaintenance(true, 'Back at noon.');
  try {
    assert.equal((await c.get('/api/state')).status, 503);
    const r = await client().post('/api/login', { login: 'bravo', password: 'hunter22', turnstile: 'pass' });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'Back at noon.');
    assert.equal((await client().get('/api/theme')).body.auth.maintenance, 'Back at noon.');
  } finally { lifecycle.setMaintenance(false); }
  assert.equal((await c.get('/api/state')).status, 200);
});

test('the banner from the admin panel is in every player view', async () => {
  const c = client();
  await c.post('/api/login', { login: 'bravo', password: 'hunter22', turnstile: 'pass' });
  lifecycle.setNotice('Server restart at 18:00.', { level: 'warn' });
  assert.deepEqual((await c.get('/api/state')).body.notice, { text: 'Server restart at 18:00.', level: 'warn' });
  lifecycle.setNotice('Gone already.', { until: Date.now() - 1 });
  assert.equal((await c.get('/api/state')).body.notice, null);
});

test('the account routes take no name a game action uses', () => {
  const actions = new Set(require('../src/routes').map(([r]) => r));
  for (const r of ['register', 'login', 'logout', 'account', 'account/email', 'verify', 'verify/resend', 'password-reset', 'password-reset/request']) assert.ok(!actions.has(r), r);
});

test('the commander changes their passcode from the game: the current one is required, other sessions end, this one stays', async () => {
  const here = client(); const elsewhere = client();
  await here.post('/api/login', { login: 'charlie', password: 'hunter22', turnstile: 'pass' });
  await accounts.setPassword(idOf('charlie'), 'hunter22'); // (charlie never confirmed an address: confirm it so the game is open)
  db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(idOf('charlie'));
  await here.post('/api/login', { login: 'charlie', password: 'hunter22', turnstile: 'pass' });
  await elsewhere.post('/api/login', { login: 'charlie', password: 'hunter22', turnstile: 'pass' });
  assert.equal((await here.post('/api/account/password', { password: 'wrong-one', newPassword: 'charlie-new-1' })).status, 400);
  assert.equal((await here.post('/api/account/password', { password: 'hunter22', newPassword: 'short' })).status, 400);
  assert.equal((await here.post('/api/account/password', { password: 'hunter22', newPassword: 'charlie-new-1' })).status, 200);
  assert.equal((await here.get('/api/state')).status, 200, 'still signed in here');
  assert.equal((await elsewhere.get('/api/state')).status, 401, 'signed out elsewhere');
  assert.equal((await client().post('/api/login', { login: 'charlie', password: 'charlie-new-1', turnstile: 'pass' })).status, 200);
});

test('an authenticator code: opt in from the game, then sign-in asks for it (once per code), links do not stand in for it, and it can be turned off', async () => {
  const totp = require('../src/totp');
  const step = () => Math.floor(Date.now() / 30000);
  const c = client();
  await c.post('/api/login', { login: 'charlie', password: 'charlie-new-1', turnstile: 'pass' });
  assert.equal((await c.post('/api/account/totp/setup', { password: 'nope-nope' })).status, 400);
  const setup = await c.post('/api/account/totp/setup', { password: 'charlie-new-1' });
  assert.match(setup.body.uri, /^otpauth:/);
  assert.equal((await c.post('/api/account/totp/enable', { code: '000000' === totp.code(setup.body.secret, step()) ? '111111' : '000000' })).status, 400);
  assert.equal((await c.post('/api/account/totp/enable', { code: totp.code(setup.body.secret, step()) })).status, 200);
  assert.equal((await c.get('/api/account')).body.totp, true);

  const d = client();
  const first = await d.post('/api/login', { login: 'charlie', password: 'charlie-new-1', turnstile: 'pass' });
  assert.equal(first.body.next, 'totp');
  assert.equal((await d.get('/api/state')).status, 401, 'not signed in on the passcode alone');
  const used = totp.code(setup.body.secret, step());
  assert.equal((await d.post('/api/login/totp', { code: used })).status, 400, 'the code used to turn it on is spent');
  // the next step's code
  const next = totp.code(setup.body.secret, step() + 1);
  const ok = await d.post('/api/login/totp', { code: next });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await d.get('/api/state')).status, 200);
  const e = client();
  await e.post('/api/login', { login: 'charlie', password: 'charlie-new-1', turnstile: 'pass' });
  assert.equal((await e.post('/api/login/totp', { code: next })).status, 400, 'no replay');

  // an email link confirms the address but does not sign a stranger's browser in
  const u = accounts.byId(idOf('charlie'));
  db.prepare('DELETE FROM email_tokens WHERE user_id = ?').run(u.id); // (clear of the hourly sending limit)
  const t = accounts.issue(u.id, 'verify', 'charlie@example.com', Date.now());
  const r = await client().post('/api/verify', { token: t.link });
  assert.equal(r.body.next, 'login');

  assert.equal((await d.post('/api/account/totp/disable', { password: 'charlie-new-1', code: '123456' })).status, 400);
  db.prepare('UPDATE users SET totp_step = 0 WHERE id = ?').run(u.id);
  assert.equal((await d.post('/api/account/totp/disable', { password: 'charlie-new-1', code: totp.code(setup.body.secret, step()) })).status, 200);
  assert.equal((await client().post('/api/login', { login: 'charlie', password: 'charlie-new-1', turnstile: 'pass' })).body.next, 'game');
});
