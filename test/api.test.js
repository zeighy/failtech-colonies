'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.AUTH_RATE_LIMIT = '1000';
process.env.BCRYPT_ROUNDS = '4';
process.env.API_RATE_LIMIT = '100000';
process.env.HAZARDS = 'off'; // hazards have their own suite (test/hazards.test.js)

const app = require('../server');
const engine = require('../src/engine');
const store = require('../src/db');

let server, base;
test.before(async () => {
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method, redirect: 'manual',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b || {}) };
}
let n = 0;
async function newPlayer() {
  const c = client();
  const r = await c.post('/api/register', { username: `player_${++n}`, password: 'hunter22' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}
const tick = (k = 1) => { for (let i = 0; i < k; i++) engine.processTick(); };

test('auth: validation, duplicates, wrong password, protected routes', async () => {
  const c = client();
  assert.equal((await c.get('/api/state')).status, 401);
  assert.equal((await c.post('/api/register', { username: 'x', password: 'hunter22' })).status, 400);
  assert.equal((await c.post('/api/register', { username: 'okname', password: '123' })).status, 400);
  assert.equal((await c.post('/api/register', { username: 'okname', password: 'hunter22' })).status, 200);
  const dup = client();
  assert.equal((await dup.post('/api/register', { username: 'OKNAME', password: 'hunter22' })).status, 409);
  assert.equal((await dup.post('/api/login', { username: 'okname', password: 'wrong-one' })).status, 401);
  assert.equal((await dup.post('/api/login', { username: 'okname', password: 'hunter22' })).status, 200);
  assert.equal((await dup.get('/api/state')).status, 200);
  assert.equal((await dup.post('/api/logout')).status, 200);
  assert.equal((await dup.get('/api/state')).status, 401);
});

test('new colony starts with the configured stockpile and no buildings', async () => {
  const c = await newPlayer();
  const { body: s } = await c.get('/api/state');
  assert.equal(s.colony.population, 20);
  assert.equal(s.resources.scrap.amount, store.config.global.startingState.resources.scrap);
  assert.deepEqual(s.buildings, []);
  assert.deepEqual(s.hub.rings, { 1: 6 });
});

test('build: validates, charges, queues, completes after N ticks', async () => {
  const c = await newPlayer();
  assert.equal((await c.post('/api/build', { ring: 1, slot: 0, type: 'nope' })).status, 400);
  assert.equal((await c.post('/api/build', { ring: 2, slot: 0, type: 'solar_array' })).body.error, 'That slot is locked. Upgrade the hub.');
  assert.equal((await c.post('/api/build', { ring: 1, slot: 6, type: 'solar_array' })).status, 400);
  assert.equal((await c.post('/api/build', { ring: 1, slot: 0, type: 'beacon_array' })).status, 400); // can't afford the beacon
  const r = await c.post('/api/build', { ring: 1, slot: 0, type: 'solar_array' });
  assert.equal(r.status, 200);
  assert.equal(r.body.state.resources.scrap.amount, 1500 - 100);
  assert.equal(r.body.state.orders.length, 1);
  assert.match((await c.post('/api/build', { ring: 1, slot: 0, type: 'solar_array' })).body.error, /in use/);
  tick(1);
  assert.equal((await c.get('/api/state')).body.buildings.length, 0);
  tick(1);
  const s = (await c.get('/api/state')).body;
  assert.equal(s.buildings.length, 1);
  assert.equal(s.orders.length, 0);
  assert.equal(s.energy.supply, 20 + 25);
});

test('build: cannot afford', async () => {
  const c = await newPlayer();
  const r = await c.post('/api/build', { ring: 1, slot: 0, type: 'hydroponics_bay' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Not enough resources/);
});

test('cancel refunds in full; demolish refunds half and frees the slot; toggle pauses', async () => {
  const c = await newPlayer();
  const q = (await c.post('/api/build', { ring: 1, slot: 1, type: 'scrap_extractor' })).body.state;
  const cancel = await c.post('/api/cancel', { orderId: q.orders[0].id });
  assert.equal(cancel.body.state.resources.scrap.amount, 1500);
  await c.post('/api/build', { ring: 1, slot: 1, type: 'scrap_extractor' });
  tick(3);
  let s = (await c.get('/api/state')).body;
  assert.equal(s.buildings[0].paused, false);
  s = (await c.post('/api/toggle', { ring: 1, slot: 1 })).body.state;
  assert.equal(s.buildings[0].paused, true);
  assert.equal(s.buildings[0].status, 'paused');
  const before = s.resources.scrap.amount;
  s = (await c.post('/api/demolish', { ring: 1, slot: 1 })).body.state;
  assert.equal(s.buildings.length, 0);
  assert.equal(Math.floor(s.resources.scrap.amount), Math.floor(before) + 100);
  assert.equal((await c.post('/api/build', { ring: 1, slot: 1, type: 'solar_array' })).status, 200);
});

test('players cannot touch each other\'s colonies', async () => {
  const a = await newPlayer(); const b = await newPlayer();
  await a.post('/api/build', { ring: 1, slot: 0, type: 'solar_array' });
  assert.equal((await b.get('/api/state')).body.orders.length, 0);
  assert.equal((await b.post('/api/cancel', { orderId: (await a.get('/api/state')).body.orders[0].id })).status, 400);
});

test('hub upgrade needs resources, takes time, unlocks ring 2', async () => {
  const c = await newPlayer();
  assert.equal((await c.post('/api/upgrade')).status, 400);
  const colony = store.db.prepare('SELECT id FROM colonies ORDER BY id DESC LIMIT 1').get();
  store.db.prepare("UPDATE colony_inventory SET amount = 5000 WHERE colony_id = ? AND resource_id IN ('scrap','machined_parts')").run(colony.id);
  const r = await c.post('/api/upgrade');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await c.post('/api/upgrade')).body.error, 'An upgrade is already underway.');
  tick(store.config.hubLevels['2'].upgradeTicks);
  const s = (await c.get('/api/state')).body;
  assert.equal(s.colony.hubLevel, 2);
  assert.deepEqual(s.hub.rings, { 1: 6, 2: 8 });
  assert.equal((await c.post('/api/build', { ring: 2, slot: 7, type: 'solar_array' })).status, 200);
  assert.equal((await c.post('/api/build', { ring: 2, slot: 8, type: 'solar_array' })).status, 400); // ring 2 only has 8 slots
});

test('convoy: standing contracts execute when the convoy arrives', async () => {
  const c = await newPlayer();
  const colony = store.db.prepare('SELECT id FROM colonies ORDER BY id DESC LIMIT 1').get();
  store.db.prepare("UPDATE colony_inventory SET amount = 1000 WHERE colony_id = ? AND resource_id = 'rations'").run(colony.id);
  assert.equal((await c.post('/api/contract', { resource: 'rations', side: 'export', amount: 30 })).status, 200);
  assert.equal((await c.post('/api/contract', { resource: 'machined_parts', side: 'import', amount: 10 })).status, 200);
  assert.equal((await c.post('/api/contract', { resource: 'gold', side: 'import', amount: 10 })).status, 400);
  const before = (await c.get('/api/state')).body;
  const interval = store.config.global.convoyIntervalTicks;
  tick(before.convoy.ticksLeft);
  const after = (await c.get('/api/state')).body;
  assert.ok(after.events.some((e) => /Convoy bought 30 Rations/.test(e.message)), JSON.stringify(after.events.map((e) => e.message)));
  assert.equal(after.resources.machined_parts.amount, 10);
  assert.equal(after.convoy.ticksLeft, interval);
  // contract amounts are clamped to this resource's limit at the current hub level
  const big = await c.post('/api/contract', { resource: 'power_cells', side: 'import', amount: 9999 });
  assert.equal(big.body.state.contracts.import.power_cells, store.config.resources.power_cells.convoyMax);
  assert.equal(big.body.state.market.limits.power_cells, store.config.resources.power_cells.convoyMax);
  assert.equal(big.body.state.market.limits.scrap, store.config.global.convoyMaxPerResource);
  store.db.prepare('UPDATE colonies SET hub_level = 3 WHERE id = ?').run(colony.id);
  const grown = (await c.get('/api/state')).body.market.limits;
  assert.equal(grown.power_cells, Math.floor(store.config.resources.power_cells.convoyMax * store.config.hubLevels['3'].convoyCapMult));
  const more = await c.post('/api/contract', { resource: 'power_cells', side: 'import', amount: 9999 });
  assert.equal(more.body.state.contracts.import.power_cells, grown.power_cells);
  // clearing a contract removes it
  const cleared = await c.post('/api/contract', { resource: 'rations', side: 'export', amount: 0 });
  assert.deepEqual(cleared.body.state.contracts.export, {});
});

test('collapse: failed colony stops ticking, restart keeps part of the credits', async () => {
  const c = await newPlayer();
  tick(80);
  let s = (await c.get('/api/state')).body;
  assert.equal(s.colony.status, 'failed');
  assert.equal((await c.post('/api/build', { ring: 1, slot: 0, type: 'solar_array' })).status, 400);
  const r = await c.post('/api/restart');
  assert.equal(r.status, 200);
  s = r.body.state;
  assert.equal(s.colony.status, 'active');
  assert.equal(s.colony.failures, 1);
  assert.equal(s.buildings.length, 0);
  assert.equal((await c.post('/api/restart')).status, 400); // only valid after a collapse
});

test('manual reset wipes everything back to the start', async () => {
  const c = await newPlayer();
  await c.post('/api/build', { ring: 1, slot: 0, type: 'solar_array' });
  const s = (await c.post('/api/reset')).body.state;
  assert.equal(s.orders.length, 0);
  assert.equal(s.resources.scrap.amount, store.config.global.startingState.resources.scrap);
  assert.equal(s.colony.credits, store.config.global.startingState.credits);
});

test('offline progress: runDueTicks catches up missed ticks, capped', () => {
  const t0 = Date.now();
  store.setMeta('last_tick_at', t0);
  const before = engine.timing().globalTick;
  const done = engine.runDueTicks(t0 + engine.TICK_MS * 5 + 10);
  assert.equal(done, 5);
  assert.equal(engine.timing().globalTick, before + 5);
  const huge = engine.runDueTicks(Number(store.getMeta('last_tick_at')) + engine.TICK_MS * 100000);
  assert.equal(huge, store.config.global.maxOfflineTicks);
});

test('pages: game requires login, static assets served', async () => {
  const c = client();
  assert.equal((await c.get('/game')).status, 302);
  assert.equal((await c.get('/')).status, 200);
  assert.equal((await c.get('/js/game.js')).status, 200);
});

// ---- onboarding directives & collapse clock ------------------------------------
const lastColonyId = () => store.db.prepare('SELECT id FROM colonies ORDER BY id DESC LIMIT 1').get().id;
const setStock = (id, res, amt) => store.db.prepare('UPDATE colony_inventory SET amount = ? WHERE colony_id = ? AND resource_id = ?').run(amt, id, res);
const directive = (s, id) => s.brief.directives.find((d) => d.id === id);

test('brief: fresh colony has a full roadmap, a correct collapse clock, and hints that never name a building', async () => {
  const c = await newPlayer();
  const s = (await c.get('/api/state')).body;
  assert.equal(s.brief.directives.length, 31);
  assert.equal(s.brief.remaining, 31);
  assert.equal(s.brief.directives.filter((d) => d.current).length, 1);
  assert.equal(s.brief.directives.find((d) => d.current).id, 'power');
  // 80 water at -2/tick = 40 ticks to shortage, then the morale runway: matches the sim's collapse
  const runway = Math.ceil(store.config.global.startingMorale / (100 / store.config.global.moraleFailureThresholdTicks));
  assert.equal(s.doom.phase, 'depleting');
  assert.equal(s.doom.untilShortage, 40);
  assert.equal(s.doom.ticks, 40 + runway);
  // hints point at what is missing, never at the thing to build
  const banned = Object.values(store.config.buildings).map((b) => b.name.toLowerCase());
  for (const d of s.brief.directives) {
    for (const name of banned) assert.ok(!d.hint.toLowerCase().includes(name) && !d.title.toLowerCase().includes(name), `"${d.id}" names ${name}`);
  }
});

test('brief: milestones tick off and stay ticked; live directives do not stick', async () => {
  const c = await newPlayer();
  await c.post('/api/build', { ring: 1, slot: 0, type: 'solar_array' });
  tick(2);
  let s = (await c.get('/api/state')).body;
  assert.equal(directive(s, 'power').done, true);
  assert.equal(s.brief.directives.find((d) => d.current).id, 'scrap');
  await c.post('/api/demolish', { ring: 1, slot: 0 });
  s = (await c.get('/api/state')).body;
  assert.equal(directive(s, 'power').done, true, 'sticky after the generator is gone');
  assert.equal(directive(s, 'steady').done, false);
});

test('brief: survival deadline reports blocked, then on-track / behind schedule from stock vs. lead time', async () => {
  const c = await newPlayer();
  const id = lastColonyId();
  let s = (await c.get('/api/state')).body;
  assert.equal(directive(s, 'water').timing.status, 'blocked'); // no parts income yet
  assert.deepEqual(directive(s, 'water').timing.blocked, ['machined_parts']);
  setStock(id, 'machined_parts', 50);
  s = (await c.get('/api/state')).body;
  let t = directive(s, 'water').timing;
  assert.equal(t.lead, store.config.buildings.water_purifier.constructionTicks); // affordable now, so only build time remains
  assert.equal(t.status, 'ok');
  setStock(id, 'clean_water', 6); // 3 ticks of stock vs. a 5-tick build
  s = (await c.get('/api/state')).body;
  t = directive(s, 'water').timing;
  assert.equal(t.stockTicks, 3);
  assert.equal(t.status, 'late');
});

test('brief: collapse clock switches to starving and counts the morale runway down', async () => {
  const c = await newPlayer();
  const id = lastColonyId();
  setStock(id, 'clean_water', 0);
  tick(1);
  let s = (await c.get('/api/state')).body;
  assert.equal(s.doom.phase, 'starving');
  const per = 100 / store.config.global.moraleFailureThresholdTicks;
  const start = store.config.global.startingMorale;
  assert.equal(s.doom.ticks, Math.ceil((start - per) / per)); // one starving tick already taken
  tick(3);
  s = (await c.get('/api/state')).body;
  assert.equal(s.doom.ticks, Math.ceil((start - 4 * per) / per));
});

test('toggle with an explicit state is idempotent (safe to re-send after a dropped connection)', async () => {
  const c = await newPlayer();
  await c.post('/api/build', { ring: 1, slot: 1, type: 'scrap_extractor' });
  tick(3);
  const paused = (n) => c.post('/api/toggle', { ring: 1, slot: 1, paused: n });
  assert.equal((await paused(true)).body.state.buildings[0].paused, true);
  assert.equal((await paused(true)).body.state.buildings[0].paused, true, 'sending the same request again changes nothing');
  assert.equal((await paused(false)).body.state.buildings[0].paused, false);
  assert.equal((await paused(false)).body.state.buildings[0].paused, false);
  // without an explicit state it still flips, for older clients
  assert.equal((await c.post('/api/toggle', { ring: 1, slot: 1 })).body.state.buildings[0].paused, true);
});

test('view exposes housing, crew and the morale breakdown', async () => {
  const c = await newPlayer();
  const s = (await c.get('/api/state')).body;
  assert.equal(s.colony.maxPopulation, store.config.hubLevels['1'].baseHousing);
  assert.equal(s.colony.housing.cap, s.colony.maxPopulation);
  assert.equal(s.colony.staffing.ratio, 1);
  assert.equal(s.colony.moraleInfo.base, store.config.global.morale.base);
  assert.equal(s.colony.morale, store.config.global.startingMorale);
  store.db.prepare("UPDATE colony_inventory SET amount = 100 WHERE colony_id = (SELECT MAX(id) FROM colonies) AND resource_id = 'machined_parts'").run();
  assert.equal((await c.post('/api/build', { ring: 1, slot: 0, type: 'dormitory' })).status, 200);
  tick(store.config.buildings.dormitory.constructionTicks);
  const after = (await c.get('/api/state')).body;
  assert.equal(after.colony.maxPopulation, store.config.hubLevels['1'].baseHousing + store.config.buildings.dormitory.housing);
  const dorm = after.buildings.find((b) => b.type === 'dormitory');
  assert.equal(dorm.comfort, 0);
});

test('every building has a map icon', () => {
  global.window = {};
  require('../public/js/icons.js');
  const missing = Object.keys(store.config.buildings).filter((k) => !global.window.ICONS[k]);
  delete global.window;
  assert.deepEqual(missing, []);
});
