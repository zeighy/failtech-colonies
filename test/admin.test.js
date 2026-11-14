'use strict';
// The admin panel (src/admin/): admin sign-in with an authenticator code, roles, the audit log, user management, rolling a
// colony back to a backup, parked colonies, market intervention, bot control through the bot API, backups and full
// restores, the clock, and the server log.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-admin-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.BACKUP_DIR = path.join(dir, 'backups');
process.env.SESSION_SECRET = 'test-secret';
process.env.THEME = 'basic';
process.env.EMAIL_VERIFICATION = 'off';
process.env.MAIL_TRANSPORT = 'log';
process.env.MAIL_LOG = 'quiet';
process.env.AUTH_RATE_LIMIT = '1000';
process.env.ADMIN_RATE_LIMIT = '1000';
process.env.BCRYPT_ROUNDS = '4';
process.env.API_RATE_LIMIT = '100000';
process.env.HAZARDS = 'off';
const KEY = 'bot-key-for-the-admin-tests';
process.env.BOT_API_KEY = KEY;
process.env.BOT_API_KEY_FILE = path.join(dir, 'bot.key');

const gameApp = require('../server');
const admin = require('../src/admin');
const store = require('../src/db');
const engine = require('../src/engine');
const totp = require('../src/totp');
const market = require('../src/market');
const ms = require('../src/marketsim');
const accounts = require('../src/accounts');
const { db, config } = store;

let game, panel, gameBase, adminBase;
test.before(async () => {
  await new Promise((r) => { game = gameApp.listen(0, r); });
  await new Promise((r) => { panel = admin.app().listen(0, '127.0.0.1', r); });
  gameBase = `http://127.0.0.1:${game.address().port}`;
  adminBase = `http://127.0.0.1:${panel.address().port}`;
});
test.after(() => { game.close(); panel.close(); store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function client(base) {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: type.includes('application/json') ? await res.json() : await res.text() };
  };
  return { get: (u, h) => call('GET', u, undefined, h), post: (u, b, h) => call('POST', u, b || {}, h) };
}
const bot = (method, url, body, key = KEY) => fetch(`${gameBase}/api/bot${url}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
const tick = (k = 1) => { for (let i = 0; i < k; i++) engine.processTick(); };

let a; // the signed-in admin
async function player(name) {
  const c = client(gameBase);
  const r = await c.post('/api/register', { username: name, password: 'hunter22' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { c, id: db.prepare('SELECT id FROM users WHERE username = ?').get(name).id };
}

test('TOTP matches the RFC 6238 test vector and refuses a bad code', () => {
  const secret = totp.base32(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(totp.code(secret, 1), '287082');
  assert.equal(totp.check(secret, '287082', 59000), 1);
  assert.equal(totp.check(secret, '287083', 59000), null);
});

test('the IP allowlist takes addresses and IPv4 ranges', () => {
  assert.equal(admin.allowed('10.1.2.3', []), true);
  assert.equal(admin.allowed('10.1.2.3', ['10.0.0.0/8']), true);
  assert.equal(admin.allowed('::ffff:10.1.2.3', ['10.0.0.0/8']), true);
  assert.equal(admin.allowed('192.168.1.5', ['10.0.0.0/8', '127.0.0.1']), false);
  assert.equal(admin.allowed('127.0.0.1', ['10.0.0.0/8', '127.0.0.1']), true);
});

test('admins sign in with a passcode, then with an authenticator code once set up; codes are not replayed', async () => {
  assert.equal((await admin.createAdmin('root', 'short')).ok, false);
  assert.equal((await admin.createAdmin('root', 'a-long-admin-pass')).ok, true);
  a = client(adminBase);
  assert.equal((await a.get('/api/me')).status, 401);
  assert.equal((await a.post('/api/login', { username: 'root', password: 'wrong-pass-here' })).status, 401);
  const r = await a.post('/api/login', { username: 'root', password: 'a-long-admin-pass' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.totpMissing, true);
  const setup = await a.post('/api/me/totp/setup');
  assert.match(setup.body.uri, /^otpauth:\/\/totp\//);
  assert.equal((await a.post('/api/me/totp/enable', { code: '000000' === totp.code(setup.body.secret, Math.floor(Date.now() / 30000)) ? '111111' : '000000' })).status, 400);
  assert.equal((await a.post('/api/me/totp/enable', { code: totp.code(setup.body.secret, Math.floor(Date.now() / 30000)) })).status, 200);
  await a.post('/api/logout');
  const need = await a.post('/api/login', { username: 'root', password: 'a-long-admin-pass' });
  assert.equal(need.status, 401);
  assert.equal(need.body.totp, true);
  const code = totp.code(setup.body.secret, Math.floor(Date.now() / 30000));
  assert.equal((await a.post('/api/login', { username: 'root', password: 'a-long-admin-pass', totp: code })).status, 200);
  const again = client(adminBase);
  assert.equal((await again.post('/api/login', { username: 'root', password: 'a-long-admin-pass', totp: code })).status, 401, 'a used code is refused');
  assert.ok(db.prepare("SELECT 1 FROM admin_audit WHERE action = 'login.failed'").get());
});

test('the panel is separate: the game server does not serve it, and writes must be same-origin JSON', async () => {
  assert.equal((await client(gameBase).get('/admin.js')).status, 404);
  assert.equal((await client(gameBase).get('/api/overview')).status, 404);
  assert.equal((await a.post('/api/users', { username: 'x' }, { origin: 'https://evil.example' })).status, 403);
  const page = await client(adminBase).get('/');
  assert.equal(page.status, 200);
  assert.match(page.body, /admin\.js/);
});

test('a viewer can look but not change anything', async () => {
  assert.equal((await a.post('/api/admins', { username: 'watcher', password: 'watcher-pass-1', role: 'viewer' })).status, 200);
  const v = client(adminBase);
  await v.post('/api/login', { username: 'watcher', password: 'watcher-pass-1' });
  assert.equal((await v.get('/api/overview')).status, 200);
  assert.equal((await v.post('/api/maintenance/sessions')).status, 403);
  assert.equal((await a.post('/api/admins/1', { disabled: true })).body.error, 'You cannot lock yourself out.');
});

test('users: list, detail, edit, verify, suspend and lift, set a passcode, sign out, delete with the colony parked', async () => {
  const p = await player('pilot_one');
  const list = await a.get('/api/users?q=pilot');
  assert.equal(list.body.users[0].username, 'pilot_one');
  assert.equal(list.body.users[0].colony.hub, 1);
  const d = await a.get(`/api/users/${p.id}`);
  assert.equal(d.body.user.username, 'pilot_one');
  assert.ok(d.body.log.some((l) => /Registered/.test(l.message)));

  assert.equal((await a.post(`/api/users/${p.id}/update`, { email: 'pilot@example.com' })).status, 200);
  assert.equal(accounts.byId(p.id).email_verified, 1, 'an address an admin sets counts as verified');
  assert.equal((await a.post(`/api/users/${p.id}/update`, { username: 'Pilot_Renamed' })).status, 200);

  assert.equal((await p.c.get('/api/state')).status, 200);
  assert.equal((await a.post(`/api/users/${p.id}/ban`, { reason: 'testing', hours: 2 })).status, 200);
  assert.equal((await p.c.get('/api/state')).status, 401);
  const refused = await client(gameBase).post('/api/login', { login: 'Pilot_Renamed', password: 'hunter22' });
  assert.equal(refused.status, 403);
  await a.post(`/api/users/${p.id}/unban`);
  assert.equal((await a.post(`/api/users/${p.id}/password`, { password: 'set-by-admin' })).status, 200);
  const c2 = client(gameBase);
  assert.equal((await c2.post('/api/login', { login: 'pilot@example.com', password: 'set-by-admin' })).status, 200);
  assert.equal((await a.post(`/api/users/${p.id}/logout`)).body.sessionsEnded, 1);
  db.prepare("UPDATE users SET totp_on = 1, totp_secret = 'AAAA' WHERE id = ?").run(p.id);
  assert.equal((await a.get(`/api/users/${p.id}`)).body.user.totp, true);
  assert.equal((await a.post(`/api/users/${p.id}/totp-off`)).status, 200);
  assert.equal(accounts.byId(p.id).totp_on, 0);

  const colony = db.prepare('SELECT id FROM colonies WHERE user_id = ?').get(p.id).id;
  assert.equal((await a.post(`/api/users/${p.id}/delete`, { confirm: 'nope', colony: 'park' })).status, 400);
  assert.equal((await a.post(`/api/users/${p.id}/delete`, { confirm: 'Pilot_Renamed', colony: 'park' })).status, 200);
  assert.equal(accounts.byId(p.id), undefined);
  const c = db.prepare('SELECT c.parked_at, u.generated FROM colonies c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(colony);
  assert.ok(c.parked_at && c.generated, 'the colony waits under a generated account');
  assert.ok(db.prepare("SELECT 1 FROM admin_audit WHERE action = 'user.delete'").get());
});

test('game-master tools: credits and stock, with a line in the colony log', async () => {
  const p = await player('gm_target');
  const colony = db.prepare('SELECT id, credits FROM colonies WHERE user_id = ?').get(p.id);
  assert.equal((await a.post(`/api/colonies/${colony.id}/credits`, { delta: 500, reason: 'outage' })).body.credits, colony.credits + 500);
  const core = store.coreId(colony.id);
  assert.equal((await a.post(`/api/colonies/${colony.id}/stock`, { district: core, resource: 'scrap', amount: 777 })).status, 200);
  assert.equal(store.loadInventory(colony.id, core).scrap, 777);
  assert.ok(db.prepare("SELECT 1 FROM colony_events WHERE colony_id = ? AND message LIKE 'Received 500 cr: outage%'").get(colony.id));
});

test('a colony rolls back to a backup: its rows replaced, its old open orders refunded, everything else untouched', async () => {
  const p = await player('rollback_me');
  const other = await player('bystander');
  const cid = db.prepare('SELECT id FROM colonies WHERE user_id = ?').get(p.id).id;
  const otherId = db.prepare('SELECT id FROM colonies WHERE user_id = ?').get(other.id).id;
  db.prepare('UPDATE colonies SET credits = 1234, hub_level = 2 WHERE id = ?').run(cid);
  // an open buy order in the backup holds 300 cr of escrow
  db.prepare("INSERT INTO market_orders (owner, colony_id, district_id, side, resource_id, price, qty, qty_total, escrow, created_tick, expires_tick) VALUES ('player', ?, ?, 'buy', 'scrap', 1, 300, 300, 300, 0, 99999)").run(cid, store.coreId(cid));
  const snap = await a.post('/api/backups', { kind: 'snapshot', label: 'Before Test!' });
  assert.match(snap.body.name, /^snapshot-\d{8}-\d{6}-before-test\.db$/);
  db.prepare("DELETE FROM market_orders WHERE colony_id = ?").run(cid);
  db.prepare('UPDATE colonies SET credits = 5, hub_level = 3 WHERE id = ?').run(cid);
  db.prepare('UPDATE colonies SET credits = 4321 WHERE id = ?').run(otherId);
  db.prepare('INSERT INTO colony_buildings (colony_id, district_id, ring_index, slot_index, building_type) VALUES (?, ?, 1, 0, ?)').run(cid, store.coreId(cid), 'solar_array');
  tick(2);

  const found = await a.get(`/api/users/${p.id}/backups`);
  assert.ok(found.body.backups.some((b) => b.backup === snap.body.name && b.colonies[0].credits === 1234));
  const r = await a.post(`/api/colonies/${cid}/restore`, { backup: snap.body.name });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.refundCredits, 300);
  const now = db.prepare('SELECT credits, hub_level, user_id, parked_at FROM colonies WHERE id = ?').get(cid);
  assert.equal(now.credits, 1534, 'the backup balance plus the escrow its open order held');
  assert.equal(now.hub_level, 2);
  assert.equal(now.user_id, p.id);
  assert.equal(now.parked_at, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM colony_buildings WHERE colony_id = ?').get(cid).n, 0, 'built since: gone');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM market_orders WHERE colony_id = ? AND status = 'open'").get(cid).n, 0);
  assert.equal(db.prepare('SELECT credits FROM colonies WHERE id = ?').get(otherId).credits, 4321, 'other colonies are untouched');
  assert.equal((await p.c.get('/api/state')).status, 200, 'and the commander plays on');

  // to an account that started over since: its new colony must be parked or wiped first
  const s = await player('started_over');
  const old = db.prepare('SELECT id FROM colonies WHERE user_id = ?').get(s.id).id;
  const snap2 = await a.post('/api/backups', { kind: 'snapshot', label: 'two' });
  store.wipeColony(old);
  store.ensureColony(s.id);
  const refused = await a.post(`/api/colonies/${old}/restore`, { backup: snap2.body.name, toUserId: s.id });
  assert.equal(refused.status, 409);
  assert.ok(refused.body.otherColony);
  const ok = await a.post(`/api/colonies/${old}/restore`, { backup: snap2.body.name, toUserId: s.id, current: 'park' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(db.prepare('SELECT id FROM colonies WHERE user_id = ?').get(s.id).id, old);
  assert.ok(db.prepare('SELECT parked_at FROM colonies WHERE id = ?').get(refused.body.otherColony).parked_at, 'the newer one was parked');
});

test('parked colonies: unpark, hand to the bots, keep from the bots (the bot listing leaves it out), wipe', async () => {
  const p = await player('parker');
  const cid = db.prepare('SELECT id FROM colonies WHERE user_id = ?').get(p.id).id;
  await a.post(`/api/colonies/${cid}/park`);
  assert.ok((await a.get('/api/colonies?phase=parked')).body.colonies.some((c) => c.id === cid));
  assert.ok((await bot('GET', '/parked')).body.parked.some((c) => c.colonyId === cid));
  await a.post(`/api/colonies/${cid}/nobots`, { on: true });
  assert.ok(!(await bot('GET', '/parked')).body.parked.some((c) => c.colonyId === cid), 'kept from the bots');
  await a.post(`/api/colonies/${cid}/unpark`);
  assert.equal(db.prepare('SELECT parked_at FROM colonies WHERE id = ?').get(cid).parked_at, null);
  await a.post(`/api/colonies/${cid}/handover`);
  assert.equal(db.prepare('SELECT u.generated FROM colonies c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(cid).generated, 1);
  assert.equal((await a.post(`/api/colonies/${cid}/wipe`, { confirm: cid })).status, 200);
  assert.equal(db.prepare('SELECT 1 FROM colonies WHERE id = ?').get(cid), undefined);
});

test('market: freeze stops new orders and matching, a price adjustment moves the reference, orders can be cancelled with a refund', async () => {
  const p = await player('trader_x');
  const cid = db.prepare('SELECT id FROM colonies WHERE user_id = ?').get(p.id).id;
  db.prepare('UPDATE colonies SET hub_level = ? WHERE id = ?').run(config.exchange.unlockCoreLevel, cid);
  const tickNow = Number(store.getMeta('global_tick', 0));
  const ref = ms.refPrice(config, 'scrap', tickNow);
  await a.post('/api/market/freeze', { kind: 'ground', on: true });
  const r = await p.c.post('/api/market', { side: 'buy', resource: 'scrap', price: Math.round(ref * 100) / 100, qty: 5, ttl: config.exchange.ttlOptions[0] });
  assert.match(r.body.error, /closed/);
  await a.post('/api/market/freeze', { kind: 'ground', on: false });
  const before = db.prepare('SELECT credits FROM colonies WHERE id = ?').get(cid).credits;
  const posted = await p.c.post('/api/market', { side: 'buy', resource: 'scrap', price: Math.round(ref * 0.5 * 100) / 100, qty: 5, ttl: config.exchange.ttlOptions[0] });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const orders = (await a.get(`/api/market/orders?kind=ground&colony=${cid}`)).body.orders;
  assert.equal(orders.length, 1);
  assert.equal((await a.post('/api/market/orders/cancel', { kind: 'ground', ids: [orders[0].id] })).body.cancelled, 1);
  assert.equal(db.prepare('SELECT credits FROM colonies WHERE id = ?').get(cid).credits, before, 'the escrow came back');

  assert.equal((await a.post('/api/market/adjust', { resource: 'scrap', mult: 50 })).status, 400);
  await a.post('/api/market/adjust', { resource: 'scrap', mult: 2 });
  assert.ok(Math.abs(ms.refPrice(config, 'scrap', tickNow) - ref * 2) < 1e-9);
  await a.post('/api/market/adjust', { resource: 'scrap', mult: null });
  assert.ok(Math.abs(ms.refPrice(config, 'scrap', tickNow) - ref) < 1e-9);
  const m = await a.get('/api/market');
  assert.ok(m.body.goods.find((g) => g.resource === 'scrap'));
  assert.equal((await a.get('/api/market/flags')).status, 200);
  void market;
});

test('bots: pause refuses claims and actions, overrides and the heartbeat reach the runner, telemetry is stored and exported, the key rotates', async () => {
  await a.post('/api/bots/pause', { on: true });
  assert.equal((await bot('GET', '/parked')).body.paused, true);
  assert.equal((await bot('POST', '/claim', { colonyId: 1, profile: 'broker' })).status, 503);
  assert.equal((await bot('GET', '/control')).body.control.paused, true);
  await a.post('/api/bots/pause', { on: false });
  assert.equal((await a.post('/api/bots/overrides', { limit: 3, profiles: ['steward'], claim: 'given_up' })).status, 200);
  assert.equal((await a.post('/api/bots/overrides', { profiles: ['nobody'] })).status, 400);
  const hb = await bot('POST', '/heartbeat', {
    status: { limit: 3, active: 1, waiting: 2, bots: [], settings: { limit: 5, parkedDays: 7 } },
    telemetry: [{ at: new Date().toISOString(), ev: 'issue', bot: 'Cmdr_X', profile: 'steward', colony: 9, code: 'starving' }, { at: new Date().toISOString(), ev: 'give_up', bot: 'Cmdr_X', reason: 'shutdown_too_long' }],
  });
  assert.equal(hb.body.stored, 2);
  assert.deepEqual({ limit: hb.body.control.limit, profiles: hb.body.control.profiles, claim: hb.body.control.claim }, { limit: 3, profiles: ['steward'], claim: 'given_up' });
  const view = await a.get('/api/bots');
  assert.equal(view.body.runner.waiting, 2);
  assert.equal(view.body.api.key, 'env');
  const t = await a.get('/api/bots/telemetry?days=1');
  assert.deepEqual(t.body.issues, [['starving', 1]]);
  assert.deepEqual(t.body.giveUps, [['shutdown_too_long', 1]]);
  const exp = await a.get('/api/bots/telemetry/export?days=1');
  assert.equal(exp.body.trim().split('\n').length, 2);
  assert.equal(JSON.parse(exp.body.split('\n')[0]).ev, 'issue');

  const k = await a.post('/api/bots/key');
  assert.equal(k.body.wrote, true);
  assert.equal(fs.readFileSync(process.env.BOT_API_KEY_FILE, 'utf8').trim(), k.body.key);
  assert.equal((await bot('GET', '/info')).status, 401, 'the old key is refused');
  assert.equal((await bot('GET', '/info', undefined, k.body.key)).status, 200);
  await a.post('/api/bots/api', { on: false });
  assert.equal((await bot('GET', '/info', undefined, k.body.key)).status, 404);
  await a.post('/api/bots/api', { on: true });
});

test('a bot can be given a new profile, or made to give its colony back and kept from the bots', async () => {
  const p = await player('to_be_botted');
  const cid = db.prepare('SELECT id FROM colonies WHERE user_id = ?').get(p.id).id;
  db.prepare('UPDATE colonies SET parked_at = ? WHERE id = ?').run(Date.now(), cid);
  const key = fs.readFileSync(process.env.BOT_API_KEY_FILE, 'utf8').trim();
  const claim = await bot('POST', '/claim', { colonyId: cid, profile: 'broker' }, key);
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  assert.equal((await a.post(`/api/bots/${claim.body.userId}/profile`, { profile: 'porter' })).status, 200);
  assert.equal((await bot('GET', '/colonies', undefined, key)).body.colonies.find((c) => c.userId === claim.body.userId).profile, 'porter');
  assert.equal((await a.post(`/api/bots/${claim.body.userId}/release`, { noBots: true })).status, 200);
  const c = db.prepare('SELECT c.parked_at, c.no_bots, u.generated FROM colonies c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(cid);
  assert.ok(c.parked_at && c.no_bots && c.generated);
});

test('the clock pauses without catching up afterwards', async () => {
  const t0 = Number(store.getMeta('global_tick', 0));
  await a.post('/api/clock', { paused: true });
  store.setMeta('last_tick_at', Date.now() - engine.TICK_MS * 5);
  assert.equal(engine.runDueTicks(), 0);
  await a.post('/api/clock', { paused: false });
  assert.equal(engine.runDueTicks(), 0, 'nothing is due: the paused time is not caught up');
  assert.equal(Number(store.getMeta('global_tick', 0)), t0);
});

test('maintenance view, logs with filters and CSV export, the banner, update settings validation', async () => {
  const m = await a.get('/api/maintenance');
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.mail.transport, 'log');
  assert.equal(m.body.env.BOT_API_KEY, '(set)', 'secrets are not shown');
  assert.equal((await a.post('/api/update/settings', { repo: '--upload-pack=evil' })).status, 400);
  assert.equal((await a.post('/api/update/settings', { repo: 'https://github.com/someone/fork.git', branch: 'release/1.2' })).status, 200);
  assert.equal((await a.post('/api/update/settings', { branch: '../x' })).status, 400);
  assert.equal(store.getMeta('update_repo'), 'https://github.com/someone/fork.git');

  const logs = await a.get('/api/logs?category=auth');
  assert.ok(logs.body.logs.length > 0 && logs.body.logs.every((l) => l.category === 'auth'));
  const csv = await a.get('/api/logs/export?format=csv&category=auth');
  assert.match(csv.body.split('\n')[0], /^id,at,level,category,message/);
  assert.ok((await a.get('/api/audit?q=market')).body.audit.some((x) => x.action.startsWith('market.')));

  await a.post('/api/maintenance/notice', { text: 'Patch tonight', level: 'warn', hours: 2 });
  assert.equal(JSON.parse(store.getMeta('notice')).text, 'Patch tonight');
  await a.post('/api/maintenance/notice', { text: '' });
  assert.equal((await a.post('/api/maintenance/db/check')).body.result[0], 'ok');
  assert.equal((await a.post('/api/maintenance/test-email', { to: 'ops@example.com' })).body.transport, 'log');
});

test('backups: list, keep an automatic one, look inside, delete with confirmation, and a full restore swaps the file at the next start', async () => {
  const backup = require('../src/backup');
  const f = await backup.backupNow();
  const name = path.basename(f);
  const list = (await a.get('/api/backups')).body.backups;
  assert.ok(list.some((b) => b.name === name && b.kind === 'auto'));
  const kept = await a.post(`/api/backups/${name}/keep`, { label: 'keeper' });
  assert.match(kept.body.name, /^snapshot-.*-keeper\.db$/);
  const inside = await a.get(`/api/backups/${name}/colonies`);
  assert.ok(inside.body.colonies.length > 0);
  assert.equal((await a.get('/api/backups/..%2Ftest.db/colonies')).status, 404, 'only our own files, by bare name');
  const dl = await a.get(`/api/backups/${name}/download`);
  assert.equal(dl.status, 200);
  assert.equal((await a.post(`/api/backups/${kept.body.name}/delete`, { confirm: 'x' })).status, 400);
  assert.equal((await a.post(`/api/backups/${kept.body.name}/delete`, { confirm: kept.body.name })).status, 200);

  // the swap itself, in a separate process on a scratch database
  const scratch = path.join(dir, 'scratch.db');
  const Database = require('better-sqlite3');
  const s = new Database(scratch);
  s.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('who', 'now'), ('bot_key_sha256', 'rotated');
    CREATE TABLE admins (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin', created_at INTEGER NOT NULL);
    INSERT INTO admins (username, password, created_at) VALUES ('made_later', 'h', 1)`);
  s.close();
  const from = path.join(dir, 'older.db');
  const o = new Database(from); o.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('who', 'then')"); o.close();
  const keep = path.join(dir, 'kept', 'pre-restore-x.db');
  fs.writeFileSync(`${scratch}.restore`, JSON.stringify({ from, keep }));
  const out = execFileSync(process.execPath, ['-e', "const s = require('./src/db'); console.log(JSON.stringify([s.getMeta('who'), s.getMeta('bot_key_sha256'), s.db.prepare('SELECT username FROM admins').all().map((x) => x.username)]))"],
    { cwd: path.join(__dirname, '..'), env: { ...process.env, DB_PATH: scratch }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), ['then', 'rotated', ['made_later']], 'the game is the backup\'s; the admins and the bot key are carried over');
  assert.ok(!fs.existsSync(`${scratch}.restore`));
  const k = new Database(keep, { readonly: true });
  assert.equal(k.prepare("SELECT value FROM meta WHERE key = 'who'").get().value, 'now', 'the replaced database is kept');
  k.close();
});

test('an admin pause: players see it in their view and every action is refused; the bots pause with it', async () => {
  const p = await player('pause_watcher');
  await a.post('/api/clock', { paused: true });
  try {
    const st = await p.c.get('/api/state');
    assert.equal(st.body.paused.reason, 'admin');
    const r = await p.c.post('/api/build', { ring: 1, slot: 0, type: 'solar_array' });
    assert.equal(r.status, 409);
    assert.equal(r.body.paused, true);
    assert.equal((await p.c.post('/api/start-over')).status, 409);
    const key = fs.readFileSync(process.env.BOT_API_KEY_FILE, 'utf8').trim();
    const ctl = (await bot('GET', '/control', undefined, key)).body.control;
    assert.deepEqual([ctl.paused, ctl.why], [true, 'simulation-paused']);
  } finally { await a.post('/api/clock', { paused: false }); }
  assert.equal((await p.c.get('/api/state')).body.paused, null);
  assert.equal((await p.c.post('/api/build', { ring: 1, slot: 0, type: 'solar_array' })).status, 200);
});

test('with no player active the world holds by itself (bots too), catches nothing up, and the first player back wakes it', async () => {
  const key = fs.readFileSync(process.env.BOT_API_KEY_FILE, 'utf8').trim();
  const p = await player('comes_back');
  const away = Date.now() - (store.config.global.absence.simulateHours + 1) * 3600000;
  db.prepare('UPDATE colonies SET last_active_at = ?').run(away); // every commander (and every bot) long gone
  const t0 = Number(store.getMeta('global_tick', 0));
  store.setMeta('last_tick_at', Date.now() - engine.TICK_MS * 4);
  assert.equal(engine.runDueTicks(), 0);
  assert.equal(Number(store.getMeta('global_tick', 0)), t0, 'no ticks while nobody is around');
  assert.equal(require('../src/lifecycle').pauseState().reason, 'idle');
  const ctl = (await bot('GET', '/control', undefined, key)).body.control;
  assert.deepEqual([ctl.paused, ctl.why], [true, 'no-active-players']);
  assert.equal((await p.c.get('/api/state')).body.paused, null, 'players are not shown an idle hold (they end it)');

  // a bot colony being played does not count as anyone around
  const botColony = db.prepare("SELECT c.id FROM colonies c JOIN users u ON u.id = c.user_id WHERE u.generated = 1 LIMIT 1").get();
  if (botColony) db.prepare('UPDATE colonies SET last_active_at = ? WHERE id = ?').run(Date.now(), botColony.id);
  assert.equal(engine.checkHold(), 'idle');

  await p.c.post('/api/here');
  assert.equal(require('../src/lifecycle').pauseState(), null, 'awake');
  assert.equal((await bot('GET', '/control', undefined, key)).body.control.paused, false);
  store.setMeta('last_tick_at', Date.now() - engine.TICK_MS * 2 - 10);
  assert.equal(engine.runDueTicks(), 2);
});
