'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-absence-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.THEME = 'basic';
process.env.EMAIL_VERIFICATION = 'off'; // these players sign up without an email address (test/accounts.test.js covers verification)
process.env.AUTH_RATE_LIMIT = '1000';
process.env.BCRYPT_ROUNDS = '4';
process.env.API_RATE_LIMIT = '100000';
process.env.HAZARDS = 'off';

const app = require('../server');
const engine = require('../src/engine');
const store = require('../src/db');
const absence = require('../src/absence');
const actions = require('../src/actions');
const { viewFor } = require('../src/state');
const { db } = store;

const H = 3600000;
const D = 24 * H;
let server, base;
test.before(async () => { await new Promise((r) => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const newUser = (name) => {
  const id = Number(db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(name, 'x').lastInsertRowid);
  store.ensureColony(id);
  return id;
};
const col = (uid) => db.prepare('SELECT * FROM colonies WHERE user_id = ?').get(uid);
const lastActive = (uid, t) => db.prepare('UPDATE colonies SET last_active_at = ? WHERE user_id = ?').run(t, uid);

test('a colony stops being simulated 96 hours after its commander last did anything', () => {
  const a = newUser('here_now');
  const b = newUser('quiet_one');
  lastActive(a, Date.now() - 95 * H);
  lastActive(b, Date.now() - 97 * H);
  engine.processTick();
  assert.equal(col(a).age, 1);
  assert.equal(col(b).age, 0);
  assert.equal(absence.phase(col(b)), 'stewarded');
  assert.equal(viewFor(b).absence, null, 'no notice until they come back');
});

test('coming back within 30 days resumes the colony as it was, with a notice once', () => {
  const b = db.prepare("SELECT id FROM users WHERE username = 'quiet_one'").get().id;
  const before = col(b);
  assert.equal(absence.markActive(b), true);
  const after = col(b);
  assert.equal(absence.phase(after), 'live');
  assert.equal(after.credits, before.credits, 'nothing is taken');
  const v = viewFor(b).absence;
  assert.equal(v.notice.kind, 'stewarded');
  assert.equal(v.notice.lastActive, before.last_active_at);
  assert.ok(absence.dismiss(b).ok);
  assert.equal(viewFor(b).absence, null);
  engine.processTick();
  assert.equal(col(b).age, 1, 'simulated again');
});

test('after 30 days the colony is parked: it waits, and nothing can be done in it until it is retaken', () => {
  const c = newUser('long_gone');
  lastActive(c, Date.now() - 31 * D);
  engine.processTick();
  assert.ok(col(c).parked_at, 'parked by the sweep');
  assert.equal(col(c).age, 0);
  assert.equal(absence.markActive(c), false, 'signing in does not wake a parked colony');
  assert.ok(col(c).parked_at);
  assert.match(actions.ack(c, {}).error, /parked/);
  assert.equal(viewFor(c).absence.phase, 'parked');
  assert.ok(absence.retake(c).ok);
  assert.equal(col(c).parked_at, null);
  assert.equal(absence.phase(col(c)), 'live');
  engine.processTick();
  assert.equal(col(c).age, 1);
});

test('a colony gone past 30 days is parked when its commander signs in, even before the sweep has run', () => {
  const c = newUser('late_return');
  lastActive(c, Date.now() - 40 * D);
  assert.equal(absence.markActive(c), false);
  assert.ok(col(c).parked_at);
});

test('starting over moves the parked colony to a generated account, renames its station, and keeps it parked', () => {
  const u = newUser('moving_on');
  const old = col(u);
  const did = Number(db.prepare("INSERT INTO districts (colony_id, type, level, name, created_tick) VALUES (?, 'station', 1, 'Moving Station', 0)").run(old.id).lastInsertRowid);
  db.prepare('INSERT INTO stations (colony_id, name, district_id) VALUES (?, ?, ?)').run(old.id, 'Moving Station', did);
  assert.equal(absence.startOver(u).ok, false, 'a live colony is not given away');
  lastActive(u, Date.now() - 31 * D);
  assert.ok(absence.startOver(u).ok);
  const fresh = col(u);
  assert.notEqual(fresh.id, old.id);
  assert.equal(fresh.age, 0);
  const moved = db.prepare('SELECT * FROM colonies WHERE id = ?').get(old.id);
  assert.ok(moved.parked_at, 'still parked');
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(moved.user_id);
  assert.equal(owner.generated, 1);
  assert.match(owner.username, /^Cmdr_[0-9A-F]{6}$/);
  const st = db.prepare('SELECT name FROM stations WHERE colony_id = ?').get(old.id).name;
  assert.notEqual(st, 'Moving Station');
  assert.equal(db.prepare('SELECT name FROM districts WHERE id = ?').get(did).name, st);
  assert.equal(absence.retake(u).ok, false, 'the old colony is not theirs any more');
  assert.ok(absence.listParked().some((p) => p.id === old.id && p.generated === 1));
});

test('a parked colony someone else claims is gone for good: its commander may only start over', () => {
  const u = newUser('absentee');
  const id = col(u).id;
  const bot = Number(db.prepare("INSERT INTO users (username, password) VALUES ('bot_one', 'x')").run().lastInsertRowid);
  assert.equal(absence.claim(id, bot).ok, false, 'not parked yet');
  lastActive(u, Date.now() - 31 * D);
  absence.sweep();
  assert.ok(absence.claim(id, bot).ok);
  assert.equal(col(u), undefined);
  assert.equal(col(bot).id, id);
  assert.equal(col(bot).parked_at, null);
  assert.deepEqual(viewFor(u).lost.kind, 'claimed');
  assert.equal(absence.retake(u).ok, false);
  assert.ok(absence.startOver(u).ok);
  assert.ok(col(u));
  assert.equal(viewFor(u).lost, undefined);
});

test('only real interaction counts: polling the state does not keep a colony simulated, a click does', async () => {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  assert.equal((await call('POST', '/api/register', { username: 'clicker', password: 'password123' })).status, 200);
  const uid = db.prepare("SELECT id FROM users WHERE username = 'clicker'").get().id;
  const long = Date.now() - 100 * H;
  lastActive(uid, long);
  await call('GET', '/api/state');
  assert.equal(col(uid).last_active_at, long);
  await call('POST', '/api/here', {});
  assert.ok(col(uid).last_active_at > long);
  const st = (await call('GET', '/api/state')).body;
  assert.equal(st.absence.notice.kind, 'stewarded');
  assert.equal((await call('POST', '/api/away-ack', {})).body.state.absence, null);
});

// Abandoning from the menu (the reset action): a healthy colony is handed on for a bot to claim, anything else is erased.
// A colony with nobody eating has no collapse countdown, which stands in for one with its water and food covered.
const calm = (uid) => db.prepare('UPDATE colonies SET population = 0 WHERE user_id = ?').run(uid);
test('abandoning a healthy colony parks it under a generated account and starts the player over', () => {
  const u = newUser('quitter_ok');
  calm(u);
  db.prepare('UPDATE colonies SET credits = 123456 WHERE user_id = ?').run(u);
  const old = col(u);
  assert.equal(viewFor(u).doom, null);
  const r = actions.reset(u, {});
  assert.equal(r.ok, true);
  assert.equal(r.parked, true);
  const kept = db.prepare('SELECT * FROM colonies WHERE id = ?').get(old.id);
  assert.ok(kept, 'not erased');
  assert.ok(kept.parked_at);
  assert.equal(kept.credits, 123456, 'it waits exactly as it was');
  assert.equal(db.prepare('SELECT generated FROM users WHERE id = ?').get(kept.user_id).generated, 1);
  assert.ok(absence.listParked(200).some((p) => p.id === old.id), 'listed for the bot runner');
  const fresh = col(u);
  assert.notEqual(fresh.id, old.id);
  assert.equal(fresh.credits, store.config.global.startingState.credits);
  assert.equal(absence.phase(fresh), 'live');
});

test('abandoning a colony with a collapse countdown, shut down or collapsed erases it', () => {
  const ticking = newUser('quitter_dry');
  assert.ok(viewFor(ticking).doom, 'a new colony drains water until it can make its own');
  const shut = newUser('quitter_shut');
  calm(shut);
  db.prepare('UPDATE colonies SET shutdown_tick = 1 WHERE user_id = ?').run(shut);
  const failed = newUser('quitter_failed');
  calm(failed);
  db.prepare("UPDATE colonies SET status = 'failed' WHERE user_id = ?").run(failed);
  for (const u of [ticking, shut, failed]) {
    const old = col(u).id;
    const r = actions.reset(u, {});
    assert.equal(r.ok, true);
    assert.equal(r.parked, false);
    assert.equal(db.prepare('SELECT 1 FROM colonies WHERE id = ?').get(old), undefined, 'erased');
    assert.equal(col(u).status, 'active');
  }
});
