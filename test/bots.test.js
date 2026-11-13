'use strict';
// The bot API (src/botApi.js), the takeover assessment (bots/assess.js), the runner's claiming (bots/runner.js) and a short
// run of the bot brain (bots/brain) on the real engine.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-bots-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.THEME = 'basic';
process.env.AUTH_RATE_LIMIT = '1000';
process.env.BCRYPT_ROUNDS = '4';
process.env.API_RATE_LIMIT = '100000';
process.env.HAZARDS = 'off';
const KEY = 'test-bot-key-0123456789';
process.env.BOT_API_KEY = KEY;

const app = require('../server');
const engine = require('../src/engine');
const store = require('../src/db');
const absence = require('../src/absence');
const { viewFor } = require('../src/state');
const { BotClient } = require('../bots/client');
const { Runner } = require('../bots/runner');
const { assess } = require('../bots/assess');
const { takeTurn } = require('../bots/brain');
const { localApi } = require('../bots/local');
const profiles = require('../bots/profiles');
const { db, config } = store;

const D = 24 * 3600000;
let server, base, bots;
test.before(async () => {
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  bots = new BotClient(base, KEY);
});
test.after(() => { server.close(); store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let n = 0;
const player = (generated = 0) => {
  const id = Number(db.prepare('INSERT INTO users (username, password, generated) VALUES (?, ?, ?)').run(`cmdr_${++n}`, 'x', generated).lastInsertRowid);
  store.ensureColony(id);
  return id;
};
const colonyOf = (uid) => db.prepare('SELECT * FROM colonies WHERE user_id = ?').get(uid);
// a commander gone for good: their colony parks
const park = (uid) => { db.prepare('UPDATE colonies SET last_active_at = ? WHERE user_id = ?').run(Date.now() - 31 * D, uid); absence.sweep(); return colonyOf(uid); };

test('the bot API is closed without the key, and with the wrong one', async () => {
  let r = await fetch(`${base}/api/bot/colonies`);
  assert.equal(r.status, 401);
  r = await fetch(`${base}/api/bot/colonies`, { headers: { authorization: 'Bearer not-the-key-at-all' } });
  assert.equal(r.status, 401);
  r = await fetch(`${base}/api/bot/colonies`, { headers: { authorization: `Bearer ${KEY}` } });
  assert.equal(r.status, 200);
  // and a player's session is no way in
  const reg = await fetch(`${base}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'curious', password: 'hunter22' }) });
  const cookie = reg.headers.get('set-cookie').split(';')[0];
  r = await fetch(`${base}/api/bot/parked`, { headers: { cookie } });
  assert.equal(r.status, 401);
});

test('parked colonies are listed and can be looked at; live ones cannot', async () => {
  const live = player();
  const gone = player();
  const c = park(gone);
  const list = await bots.parked();
  assert.ok(list.some((p) => p.colonyId === c.id));
  assert.ok(!list.some((p) => p.colonyId === colonyOf(live).id));
  const v = await bots.parkedView(c.id);
  assert.equal(v.colony.hubLevel, 1);
  await assert.rejects(bots.parkedView(colonyOf(live).id), /404/);
});

test('claiming moves a parked colony to a new bot account, live again, and tells its old commander', async () => {
  const uid = player();
  const c = park(uid);
  const r = await bots.claim(c.id, 'broker');
  assert.equal(r.ok, true);
  const after = db.prepare('SELECT * FROM colonies WHERE id = ?').get(c.id);
  assert.equal(after.user_id, r.userId);
  assert.equal(after.parked_at, null);
  assert.equal(absence.phase(after), 'live');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(r.userId);
  assert.equal(u.bot_profile, 'broker');
  assert.equal(u.generated, 0);
  assert.match(u.username, /^Cmdr_/);
  assert.equal(JSON.parse(db.prepare('SELECT notice FROM users WHERE id = ?').get(uid).notice).kind, 'claimed');
  // a colony is claimed once
  const again = await bots.claim(c.id, 'porter');
  assert.equal(again.ok, false);
  const mine = await bots.colonies();
  assert.ok(mine.some((x) => x.userId === r.userId && x.colonyId === c.id && x.profile === 'broker'));
  const bad = await fetch(`${base}/api/bot/claim`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ colonyId: c.id, profile: 'Not A Profile!' }) });
  assert.equal(bad.status, 400);
});

test('a bot acts through the same actions as a player, and only on its own colony', async () => {
  const c = park(player());
  const { userId } = await bots.claim(c.id, 'steward');
  const s = await bots.state(userId);
  assert.equal(s.colony.hubLevel, 1);
  const r = await bots.act(userId, 'build', { ring: 1, slot: 0, type: 'solar_array' });
  assert.equal(r.ok, true);
  assert.ok(r.state.orders.length + r.state.buildings.length > s.orders.length + s.buildings.length);
  const refused = await bots.act(userId, 'build', { ring: 1, slot: 0, type: 'solar_array' });
  assert.equal(refused.ok, false);
  await assert.rejects(bots.act(userId, 'reset', {}), /404/); // wiping a colony is not a bot's call
  await assert.rejects(bots.act(userId, 'no-such-thing', {}), /404/);
  const human = player();
  await assert.rejects(bots.state(human), /404/); // a player's account is not a bot
});

test('a bot taking its turns keeps its colony simulated', async () => {
  const c = park(player());
  const { userId } = await bots.claim(c.id, 'porter');
  db.prepare('UPDATE colonies SET last_active_at = ? WHERE user_id = ?').run(Date.now() - 95 * 3600000, userId);
  await bots.state(userId);
  assert.ok(Date.now() - colonyOf(userId).last_active_at < 60000);
});

test('releasing parks the colony again under a generated account, and removes the bot account', async () => {
  const c = park(player());
  const { userId } = await bots.claim(c.id, 'industrialist');
  const r = await bots.release(userId);
  assert.equal(r.ok, true);
  const after = db.prepare('SELECT * FROM colonies WHERE id = ?').get(c.id);
  assert.ok(after.parked_at);
  assert.equal(db.prepare('SELECT generated FROM users WHERE id = ?').get(after.user_id).generated, 1);
  assert.equal(db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId), undefined);
  assert.ok((await bots.parked()).some((p) => p.colonyId === c.id && p.generated));
});

test('the assessment leaves a colony on its way to collapse alone, and takes a steady one', () => {
  const uid = player();
  for (let i = 0; i < 3; i++) engine.processTick();
  const fresh = viewFor(uid);
  assert.equal(assess(fresh, config).verdict, 'stable', JSON.stringify(assess(fresh, config)));
  // shut down
  db.prepare('UPDATE colonies SET shutdown_tick = 1 WHERE user_id = ?').run(uid);
  assert.equal(assess(viewFor(uid), config).verdict, 'collapsing');
  db.prepare('UPDATE colonies SET shutdown_tick = NULL WHERE user_id = ?').run(uid);
  // no water left, falling, nothing to buy it with
  const core = store.coreId(colonyOf(uid).id);
  db.prepare("UPDATE colony_inventory SET amount = 3 WHERE district_id = ? AND resource_id = 'clean_water'").run(core);
  db.prepare('UPDATE colonies SET credits = 0 WHERE user_id = ?').run(uid);
  const dry = assess(viewFor(uid), config);
  assert.notEqual(dry.verdict, 'stable', JSON.stringify(dry));
  // a failed colony
  assert.equal(assess({ ...fresh, colony: { ...fresh.colony, status: 'failed' } }, config).verdict, 'collapsing');
});

test('the runner claims stable parked colonies up to its limit, one profile each, and skips the rest', async () => {
  // clear the field: everything parked so far goes to a bot of the test's own
  for (const p of await bots.parked()) db.prepare('UPDATE colonies SET parked_at = NULL, last_active_at = ? WHERE id = ?').run(Date.now(), p.colonyId);
  const steady = [park(player(1)), park(player(1)), park(player())];
  const doomed = player(1);
  db.prepare('UPDATE colonies SET shutdown_tick = 1 WHERE user_id = ?').run(doomed);
  const doomedC = park(doomed);
  db.prepare('UPDATE colonies SET parked_at = parked_at + 1000 WHERE id = ?').run(doomedC.id); // parked last: looked at last
  const stateFile = path.join(dir, 'bots-state.json');
  const before = new Set((await bots.colonies()).map((x) => x.userId));
  for (const uid of before) await bots.release(uid); // start the runner with no bots of its own
  for (const p of await bots.parked()) if (![...steady.map((x) => x.id), doomedC.id].includes(p.colonyId)) db.prepare('UPDATE colonies SET parked_at = NULL, last_active_at = ? WHERE id = ?').run(Date.now(), p.colonyId);
  const r = new Runner({ server: base, key: KEY, limit: 2, profiles: ['broker', 'porter'], claim: 'all', turnTicks: 4, pollMs: 1e9, recheckMs: 1e9, stateFile, log: 'quiet' }, bots);
  r.config = config;
  await r.poll();
  const mine = await bots.colonies();
  assert.equal(mine.length, 2);
  assert.deepEqual(mine.map((x) => x.profile).sort(), ['broker', 'porter']);
  // given-up colonies (generated holders) first
  for (const x of mine) assert.ok(steady.slice(0, 2).some((s) => s.id === x.colonyId));
  assert.ok(r.rejected[doomedC.id] === undefined, 'the limit was reached before it was looked at');
  // a bigger limit: the shut-down one is judged and left alone, the last steady one is taken
  r.s.limit = 5;
  await r.poll();
  assert.equal((await bots.colonies()).length, 3);
  assert.equal(r.rejected[doomedC.id].verdict, 'collapsing');
  // a lower limit: the newest bot gives its colony back
  r.s.limit = 2;
  await r.poll();
  assert.equal((await bots.colonies()).length, 2);
  // each bot takes a turn over HTTP
  for (const b of r.bots.values()) await r.turn(b);
  for (const b of r.bots.values()) assert.ok(b.last && b.last.actions > 0, JSON.stringify(b.last));
  r.save();
  assert.ok(JSON.parse(fs.readFileSync(stateFile, 'utf8')).bots);
});

test('a colony a bot gave up is looked at once more after the wait, then blacklisted until it parks again', async () => {
  for (const uid of (await bots.colonies()).map((x) => x.userId)) await bots.release(uid);
  for (const p of await bots.parked()) db.prepare('UPDATE colonies SET parked_at = NULL, last_active_at = ? WHERE id = ?').run(Date.now(), p.colonyId);
  const c = park(player(1));
  const stateFile = path.join(dir, 'bots-blacklist.json');
  const telemetry = path.join(dir, 'bots-telemetry.jsonl');
  const r = new Runner({ server: base, key: KEY, limit: 1, profiles: ['steward'], claim: 'all', turnTicks: 4, pollMs: 1e9, recheckMs: 1e9, stateFile, log: 'quiet', telemetry, snapshotMs: 1 }, bots);
  r.config = config;
  await r.poll();
  const [b] = [...r.bots.values()];
  assert.equal(b.colonyId, c.id);
  await r.turn(b); // a turn played: a snapshot is written
  // the colony fails under the bot: it is given back and left alone for the wait
  db.prepare("UPDATE colonies SET status = 'failed' WHERE id = ?").run(c.id);
  await r.turn(b);
  assert.equal(r.bots.size, 0);
  assert.ok(r.rejected[c.id] && r.rejected[c.id].abandoned, JSON.stringify(r.rejected));
  const looks = [];
  const view = bots.parkedView.bind(bots);
  bots.parkedView = (id) => { looks.push(id); return view(id); };
  try {
    await r.poll();
    assert.deepEqual(looks, [], 'not looked at during the wait');
    // the wait is over: one more look, still unfit, so it is blacklisted
    r.s.recheckMs = 0;
    await r.poll();
    assert.deepEqual(looks, [c.id]);
    assert.ok(r.blocked[c.id] && !r.rejected[c.id], JSON.stringify({ blocked: r.blocked, rejected: r.rejected }));
    // never looked at again, and not even listed
    await r.poll();
    await r.poll();
    assert.deepEqual(looks, [c.id]);
    const key = `${c.id}:${r.blocked[c.id].parkedAt}`;
    assert.ok(!(await bots.parked([key])).some((p) => p.colonyId === c.id));
    assert.ok((await bots.parked()).some((p) => p.colonyId === c.id), 'the plain listing still has it');
    // only colonies parked since a given time
    const at = r.blocked[c.id].parkedAt;
    assert.ok((await bots.parked([], at)).some((p) => p.colonyId === c.id));
    assert.ok(!(await bots.parked([], at + 1)).some((p) => p.colonyId === c.id));
    // the blacklist survives a restart
    r.save();
    const again = new Runner({ ...r.s }, bots);
    assert.ok(again.blocked[c.id]);
    // taken up and parked again later: a new candidate, judged afresh (and an ordinary rejection this time)
    db.prepare('UPDATE colonies SET parked_at = parked_at + 5000 WHERE id = ?').run(c.id);
    again.config = config;
    await again.poll();
    assert.deepEqual(looks, [c.id, c.id]);
    assert.ok(!again.blocked[c.id]);
    assert.equal(again.rejected[c.id].verdict, 'collapsing');
    assert.ok(!again.rejected[c.id].abandoned);
  } finally { bots.parkedView = view; }
  // the telemetry log tells the story, with the reason it gave up and a look at the colony then
  const log = fs.readFileSync(telemetry, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const evs = log.map((x) => x.ev);
  for (const ev of ['claim', 'snapshot', 'give_up', 'blacklist', 'reject']) assert.ok(evs.includes(ev), `${ev} in ${evs}`);
  const gu = log.find((x) => x.ev === 'give_up');
  assert.equal(gu.colony, c.id);
  assert.equal(gu.reason, 'status_failed');
  assert.equal(gu.assessment.verdict, 'collapsing');
  assert.ok(gu.played && gu.lastSnapshot && Array.isArray(gu.recentEvents), JSON.stringify(gu));
  assert.equal(log.find((x) => x.ev === 'claim').assessment.verdict, 'stable');
  // and the report reads it
  const rep = require('child_process').execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'bots-report.js'), '--file', telemetry], { encoding: 'utf8' });
  assert.match(rep, /GAVE UP/);
  assert.match(rep, /check at give-up: collapsing/);
});

test('bots flag issues once they have lasted, and clear them when they stop', () => {
  const issues = require('../bots/brain/issues');
  const uid = player();
  const v = viewFor(uid);
  const m = { v, config };
  const mem = {};
  let t = issues.track(m, mem, { failures: [] });
  assert.deepEqual(t.raised, []);
  // shut down: raised at once; refused the same way turn after turn: raised after 30 turns
  m.v = { ...v, colony: { ...v.colony, shutdown: { ticks: 10 } } };
  for (let i = 0; i < 30; i++) {
    m.v = { ...m.v, tick: v.tick + i };
    t = issues.track(m, mem, { failures: ['build: Not enough steel (have 3, need 40).'] });
    if (i === 0) assert.ok(t.raised.some((x) => x.code === 'shutdown'), JSON.stringify(t));
  }
  assert.ok(t.raised.some((x) => x.code === 'repeated_refusal'), JSON.stringify(t));
  assert.ok(t.open.some((x) => x.code === 'shutdown'));
  // back to normal: both cleared, with how long they lasted
  m.v = { ...v, tick: v.tick + 31 };
  t = issues.track(m, mem, { failures: [] });
  assert.ok(t.cleared.some((x) => x.code === 'shutdown' && x.ticks === 31), JSON.stringify(t.cleared));
  assert.ok(t.open.some((x) => x.code === 'repeated_refusal'), 'a refusal stays flagged a little while after the last one');
  // a day on: the refusal is long gone, and a day without progress is a stall
  m.v = { ...v, tick: v.tick + 31 + 24 * 240 };
  t = issues.track(m, mem, { failures: [] });
  assert.ok(t.cleared.some((x) => x.code === 'repeated_refusal'), JSON.stringify(t.cleared));
  assert.ok(t.raised.some((x) => x.code === 'stalled'), JSON.stringify(t.raised));
});

test('every profile sells something in orbit and has its own temper', () => {
  for (const id of profiles.ORDER) {
    const p = profiles.get(id);
    assert.ok(p.orbitSell && ['orbital', 'trade', 'any'].includes(p.orbitSell.goods), id);
    assert.ok(p.safety > 0 && p.districts.length === 3, id);
  }
  const broker = profiles.get('broker');
  assert.equal(broker.orbitSell.goods, 'orbital');
  assert.deepEqual(broker.orbitSell.band, [0.8, 1.2]);
  assert.ok(profiles.get('porter').surface, 'the port trader trades on the ground exchange');
});

test('a bot grows a fresh colony from the ground up without letting it go hungry', async () => {
  const uid = Number(db.prepare("INSERT INTO users (username, password, bot_profile) VALUES ('brainy', 'x', 'steward')").run().lastInsertRowid);
  store.ensureColony(uid);
  const mem = { seed: 7 };
  const api = localApi(uid);
  let shutdowns = 0;
  for (let t = 1; t <= 260; t++) {
    db.prepare('UPDATE colonies SET last_active_at = ?, last_seen_at = ?').run(Date.now(), Date.now());
    engine.processTick();
    if (colonyOf(uid).shutdown_tick !== null) shutdowns++;
    if (t % 4 === 0) {
      const out = await takeTurn({ config, api, profile: profiles.get('steward'), mem });
      assert.equal(out.verdict, 'play');
    }
  }
  const c = colonyOf(uid);
  assert.equal(shutdowns, 0);
  assert.ok(c.hub_level >= 3, `hub ${c.hub_level}`);
  assert.equal(c.starving, 0);
  const v = viewFor(uid);
  assert.ok(v.colony.morale > 50, `morale ${v.colony.morale}`);
});

test('a bot lets go of the settlements it inherited', async () => {
  const uid = Number(db.prepare("INSERT INTO users (username, password, bot_profile) VALUES ('settler', 'x', 'porter')").run().lastInsertRowid);
  const id = store.ensureColony(uid);
  db.prepare('UPDATE colonies SET won = 1, hub_level = 5 WHERE id = ?').run(id);
  engine.processTick();
  const offer = db.prepare("SELECT id FROM settlements WHERE colony_id = ? AND status = 'offer'").get(id);
  assert.ok(offer, 'camps answer the Beacon');
  const actions = require('../src/actions');
  assert.equal(actions.settlementSponsor(uid, { id: offer.id }).ok, true);
  const out = await takeTurn({ config, api: localApi(uid), profile: profiles.get('porter'), mem: { seed: 1 } });
  assert.ok(out.events.some((e) => /stopped sponsoring/.test(e)), JSON.stringify(out.events));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM settlements WHERE colony_id = ? AND status = 'active'").get(id).n, 0);
});

test('global projects are sized by the people playing: stations run by bots are not counted', () => {
  const projects = require('../src/projects');
  const station = (botProfile) => {
    const uid = Number(db.prepare('INSERT INTO users (username, password, bot_profile) VALUES (?, ?, ?)').run(`st_${++n}`, 'x', botProfile).lastInsertRowid);
    const id = store.ensureColony(uid);
    const did = Number(db.prepare("INSERT INTO districts (colony_id, type, level, name, created_tick) VALUES (?, 'station', 1, ?, 0)").run(id, `Station ${n}`).lastInsertRowid);
    db.prepare('INSERT INTO stations (colony_id, name, district_id, launched_tick) VALUES (?, ?, ?, 0)').run(id, `Station ${n}`, did);
  };
  station(null); station(null); station('broker'); station('steward');
  db.prepare('DELETE FROM global_projects').run();
  const tick = Number(store.getMeta('global_tick', 0));
  projects.advanceWorld(tick, Date.now());
  const p = projects.current();
  projects.advanceWorld(p.starts_tick, Date.now());
  assert.equal(projects.current().status, 'active');
  assert.equal(projects.current().players, 2);
});

test('a dropship leaves data sites to the players unless no other territory will do', () => {
  const { Orbit } = require('../bots/brain/orbit');
  const config = { orbital: { dropships: { deployTicks: 30 } } };
  const terr = (id, rate, dataSite, rare = 'x') => ({ id, dataSite, ticksLeft: 1000, anomaly: {}, resources: { rare }, rate });
  const list = [terr(1, 5, true), terr(2, 1, false), terr(3, 9, true, 'y')];
  const m = { config, v: { orbital: { ships: { territories: list } } } };
  const o = new Orbit(m, {}, { orbitSell: { goods: 'any' } }, null);
  o.planTap = (t) => ({ rate: t.rate, links: [] });
  assert.equal(o.tripFor('x', {}, 0).t.id, 2, 'the plainer territory wins over a richer data site');
  assert.equal(o.tripFor('y', {}, 0).t.id, 3, 'a data site is still taken when it is the only one');
  list[1].taken = { mine: false };
  assert.equal(o.tripFor('x', {}, 0).t.id, 1);
});
