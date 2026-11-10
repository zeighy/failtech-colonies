'use strict';
// Database and engine behaviour with districts: the migration from the pre-district schema, the Core default, and
// real multi-district ticks through actions and the engine. A synthetic "outpost" district type is registered at
// runtime so this suite does not depend on any shipped district content.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-dist-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// ---- the pre-district (schema v5) database, written by hand ---------------------------------
const V5 = `
  CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE colonies (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
    hub_level INTEGER NOT NULL DEFAULT 1, credits INTEGER NOT NULL, morale REAL NOT NULL, population INTEGER NOT NULL,
    age INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', won INTEGER NOT NULL DEFAULT 0,
    progress REAL NOT NULL DEFAULT 0, starving INTEGER NOT NULL DEFAULT 0, brownout INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0, milestones TEXT NOT NULL DEFAULT '[]', last_seen_at INTEGER NOT NULL DEFAULT 0,
    next_hazard_age INTEGER NOT NULL DEFAULT 0, hazard_count INTEGER NOT NULL DEFAULT 0, hazards_survived INTEGER NOT NULL DEFAULT 0,
    report_cursor INTEGER NOT NULL DEFAULT 0, express_ready_tick INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE colony_inventory (colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE, resource_id TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0, PRIMARY KEY (colony_id, resource_id));
  CREATE TABLE colony_buildings (id INTEGER PRIMARY KEY AUTOINCREMENT, colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
    ring_index INTEGER NOT NULL, slot_index INTEGER NOT NULL, building_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    UNIQUE (colony_id, ring_index, slot_index));
  CREATE TABLE colony_work_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
    action_type TEXT NOT NULL, target_data TEXT NOT NULL, ticks_remaining INTEGER NOT NULL, ticks_total INTEGER NOT NULL);
  CREATE TABLE colony_contracts (colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE, resource_id TEXT NOT NULL,
    side TEXT NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY (colony_id, resource_id, side));
  CREATE TABLE colony_events (id INTEGER PRIMARY KEY AUTOINCREMENT, colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
    tick INTEGER NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, tag TEXT);
  CREATE TABLE colony_express (id INTEGER PRIMARY KEY AUTOINCREMENT, colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
    dispatched_tick INTEGER NOT NULL, arrives_tick INTEGER NOT NULL, sell TEXT NOT NULL DEFAULT '{}', buy TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE colony_hazards (id INTEGER PRIMARY KEY AUTOINCREMENT, colony_id INTEGER NOT NULL REFERENCES colonies(id) ON DELETE CASCADE,
    type TEXT NOT NULL, state TEXT NOT NULL, strikes_tick INTEGER NOT NULL, ends_tick INTEGER NOT NULL DEFAULT 0,
    severity REAL NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}');
`;

test('migration: a pre-district database keeps every colony, stockpile, building and order', () => {
  const file = path.join(dir, 'old.db');
  const old = new Database(file);
  old.exec(V5);
  old.prepare("INSERT INTO users (username, password) VALUES ('alice','x'), ('bob','x')").run();
  const col = old.prepare('INSERT INTO colonies (user_id, hub_level, credits, morale, population) VALUES (?, ?, 777, 80, 40)');
  col.run(1, 3); col.run(2, 1);
  const inv = old.prepare('INSERT INTO colony_inventory (colony_id, resource_id, amount) VALUES (?, ?, ?)');
  inv.run(1, 'scrap', 1234); inv.run(1, 'machined_parts', 55); inv.run(2, 'scrap', 9);
  const bld = old.prepare('INSERT INTO colony_buildings (colony_id, ring_index, slot_index, building_type, status) VALUES (?, ?, ?, ?, ?)');
  bld.run(1, 1, 0, 'solar_array', 'active'); bld.run(1, 2, 3, 'foundry', 'paused'); bld.run(2, 1, 0, 'solar_array', 'active');
  old.prepare("INSERT INTO colony_work_orders (colony_id, action_type, target_data, ticks_remaining, ticks_total) VALUES (1, 'build', '{\"ring\":1,\"slot\":2,\"type\":\"water_pump\"}', 2, 3)").run();
  old.pragma('user_version = 5');
  old.close();

  const out = execFileSync(process.execPath, ['-e', `
    const s = require(${JSON.stringify(path.join(root, 'src', 'db.js'))});
    const q = (sql, ...a) => s.db.prepare(sql).all(...a);
    console.log(JSON.stringify({
      version: s.db.pragma('user_version', { simple: true }),
      districts: q('SELECT colony_id, type, level, name FROM districts ORDER BY colony_id'),
      inv1: s.loadInventory(1), inv2: s.loadInventory(2),
      invDistrict: q('SELECT DISTINCT district_id FROM colony_inventory WHERE colony_id = 1').length,
      b1: s.loadBuildings(1).map((b) => [b.ring, b.slot, b.type, b.status]),
      b2: s.loadBuildings(2).map((b) => [b.ring, b.slot, b.type]),
      orders: s.loadOrders(1, s.coreId(1)).map((o) => [o.action_type, o.ticks_remaining]),
      core1: s.coreId(1), core2: s.coreId(2),
      // the slot is unique per district now, and a raw insert with no district still lands in the Core
      dup: (() => { try { s.db.prepare("INSERT INTO colony_buildings (colony_id, ring_index, slot_index, building_type) VALUES (1, 1, 0, 'solar_array')").run(); return 'allowed'; } catch (e) { return 'blocked'; } })(),
      defaulted: (() => { s.db.prepare("INSERT INTO colony_buildings (colony_id, ring_index, slot_index, building_type) VALUES (1, 1, 5, 'water_pump')").run(); return s.loadBuildings(1).length; })(),
    }));
  `], { env: { ...process.env, DB_PATH: file }, encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.version, 18);
  assert.deepEqual(r.districts, [
    { colony_id: 1, type: 'core', level: 3, name: 'The Core' },
    { colony_id: 2, type: 'core', level: 1, name: 'The Core' },
  ]);
  assert.equal(r.inv1.scrap, 1234); assert.equal(r.inv1.machined_parts, 55); assert.equal(r.inv2.scrap, 9);
  assert.equal(r.invDistrict, 1);
  assert.deepEqual(r.b1, [[1, 0, 'solar_array', 'active'], [2, 3, 'foundry', 'paused']]);
  assert.deepEqual(r.b2, [[1, 0, 'solar_array']]);
  assert.deepEqual(r.orders, [['build', 2]]);
  assert.equal(r.dup, 'blocked');
  assert.equal(r.defaulted, 3);
});

test('migration is idempotent: opening an up-to-date database again changes nothing', () => {
  const file = path.join(dir, 'twice.db');
  const script = `const s = require(${JSON.stringify(path.join(root, 'src', 'db.js'))});
    const id = s.db.prepare("INSERT INTO users (username, password) VALUES ('c','x')").run().lastInsertRowid;
    s.ensureColony(Number(id));
    console.log(JSON.stringify({ n: s.db.prepare('SELECT COUNT(*) AS n FROM districts').get().n, v: s.db.pragma('user_version', { simple: true }) }));`;
  const run = () => JSON.parse(execFileSync(process.execPath, ['-e', script.replace("'c','x'", `'c${Math.random()}','x'`)], { env: { ...process.env, DB_PATH: file }, encoding: 'utf8' }).trim().split('\n').pop());
  const first = run();
  const second = run();
  assert.equal(first.v, 18);
  assert.equal(second.n, first.n + 1, 'only the new colony gets a district');
});

// ---- multi-district behaviour through actions and the engine ----------------------------------
process.env.DB_PATH = path.join(dir, 'live.db');
process.env.SESSION_SECRET = 'x';
process.env.THEME = 'basic'; // assertions use the neutral wording, whatever the default theme is
process.env.HAZARDS = 'off';
const store = require('../src/db');
const sim = require('../src/sim');
const engine = require('../src/engine');
const actions = require('../src/actions');
const { viewFor } = require('../src/state');
const { db, config } = store;
test.after(() => db.close());

// An outpost type defined at runtime (shipped district types arrive in a later step).
config.districtTypes = {
  outpost: {
    ringPlotSize: { 1: 1, 2: 1, 3: 2 },
    levels: {
      1: { maxStorage: 1000, baseHousing: 0, baseEnergy: 30, ringCapacities: { 1: 3 }, upgradeCost: null, upgradeTicks: 0 },
      2: { maxStorage: 1500, baseHousing: 0, baseEnergy: 30, ringCapacities: { 1: 3, 2: 5 }, upgradeCost: { scrap: 100 }, upgradeTicks: 2 },
    },
  },
};
engine.neighborMaps.outpost = sim.buildNeighborMap(config, 'outpost');
// A five-level type with free upgrades, for testing the progression gates.
config.districtTypes.deep = {
  ringPlotSize: { 1: 1, 2: 1, 3: 2, 4: 3, 5: 4 },
  levels: Object.fromEntries([1, 2, 3, 4, 5].map((l) => [l, { maxStorage: 1000, baseHousing: 0, baseEnergy: 10, ringCapacities: { 1: 3 }, upgradeCost: l === 1 ? null : {}, upgradeTicks: 1 }])),
};
engine.neighborMaps.deep = sim.buildNeighborMap(config, 'deep');

let n = 0;
function colonyWithOutpost(type = 'outpost', coreLevel = 4) {
  const uid = Number(db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(`d${++n}`, 'x').lastInsertRowid);
  const id = store.ensureColony(uid);
  db.prepare('UPDATE colony_inventory SET amount = 1500 WHERE colony_id = ? AND resource_id IN (?, ?)').run(id, 'clean_water', 'rations');
  db.prepare('UPDATE colonies SET hub_level = ? WHERE id = ?').run(coreLevel, id); // districts open at Core level 4
  const od = Number(db.prepare("INSERT INTO districts (colony_id, type, level, name, created_tick) VALUES (?, ?, 1, 'Test Outpost', 0)").run(id, type).lastInsertRowid);
  const ins = db.prepare('INSERT INTO colony_inventory (colony_id, district_id, resource_id, amount) VALUES (?, ?, ?, 0)');
  for (const r of Object.keys(config.resources)) ins.run(id, od, r);
  db.prepare("UPDATE colony_inventory SET amount = 500 WHERE district_id = ? AND resource_id = 'scrap'").run(od);
  return { uid, id, core: store.coreId(id), od };
}
const tick = (k = 1) => { for (let i = 0; i < k; i++) engine.processTick(); };
const stock = (id, r, d) => store.loadInventory(id, d)[r];

test('a raw building insert with no district lands in the Core; loaders are per district', () => {
  const { id, core, od } = colonyWithOutpost();
  db.prepare("INSERT INTO colony_buildings (colony_id, ring_index, slot_index, building_type) VALUES (?, 1, 0, 'solar_array')").run(id);
  assert.equal(store.loadBuildings(id).length, 1);
  assert.equal(store.loadBuildings(id, core).length, 1);
  assert.equal(store.loadBuildings(id, od).length, 0);
  assert.equal(store.loadBuildings(id)[0].districtId, core);
});

test('building in a district: paid from that stockpile, built in that district, other stockpiles untouched', () => {
  const { uid, id, core, od } = colonyWithOutpost();
  const coreScrap = stock(id, 'scrap', core);
  const r = actions.build(uid, { ring: 1, slot: 0, type: 'scrap_extractor', district: od });
  assert.deepEqual(r, { ok: true });
  assert.equal(stock(id, 'scrap', od), 500 - config.buildings.scrap_extractor.cost.scrap);
  assert.equal(stock(id, 'scrap', core), coreScrap, 'the core pays nothing');
  assert.equal(store.loadOrders(id, od).length, 1);
  assert.equal(store.loadOrders(id, core).length, 0);
  tick(config.buildings.scrap_extractor.constructionTicks);
  assert.equal(store.loadBuildings(id, od).length, 1);
  assert.equal(store.loadBuildings(id, core).length, 0);
  // the same slot in the core is a different slot
  assert.deepEqual(actions.build(uid, { ring: 1, slot: 0, type: 'solar_array' }), { ok: true });
  // not enough in the outpost's own stockpile, even though the core is rich: the order waits in the outpost's queue
  db.prepare("UPDATE colony_inventory SET amount = 0 WHERE district_id = ? AND resource_id = 'scrap'").run(od);
  const coreNow = stock(id, 'scrap', core);
  assert.deepEqual(actions.build(uid, { ring: 1, slot: 1, type: 'solar_array', district: od }), { ok: true, queued: true });
  assert.equal(store.loadOrders(id, od)[0].state, 'queued');
  assert.equal(stock(id, 'scrap', core), coreNow, 'the core does not pay for it');
  // plot sizes and slots follow the district type
  assert.match(actions.build(uid, { ring: 2, slot: 0, type: 'solar_array', district: od }).error, /locked/);
});

test('districts produce into their own stockpile and run on their own grid; the population eats from the core', () => {
  const { uid, id, core, od } = colonyWithOutpost();
  db.prepare("UPDATE colony_inventory SET amount = 0 WHERE district_id = ? AND resource_id = 'scrap'").run(od);
  for (const [slot, type] of [[0, 'scrap_extractor']]) {
    db.prepare("INSERT INTO colony_buildings (colony_id, district_id, ring_index, slot_index, building_type) VALUES (?, ?, 1, ?, ?)").run(id, od, slot, type);
  }
  const rationsBefore = stock(id, 'rations', core);
  const coreScrap = stock(id, 'scrap', core);
  tick(5);
  const perTick = config.buildings.scrap_extractor.outputsPerTick.scrap;
  assert.ok(stock(id, 'scrap', od) >= perTick * 5 * 0.9, `outpost made ${stock(id, 'scrap', od)} scrap`);
  assert.equal(stock(id, 'scrap', core), coreScrap, 'nothing leaks into the core');
  assert.ok(stock(id, 'rations', core) < rationsBefore, 'the core pays for food');
  assert.equal(stock(id, 'rations', od), 0, 'the outpost holds no food and loses none');
  const v = viewFor(uid);
  assert.equal(v.districts.length, 2);
  assert.deepEqual(v.districts.map((d) => [d.type, d.core, d.buildings]), [['core', true, 0], ['outpost', false, 1]]);
  assert.equal(v.buildings.length, 0, 'the top-level view is still the core');
});

test('upgrading a district: paid from it, takes its own time, raises its own level; the hub is unaffected', () => {
  const { uid, id, core, od } = colonyWithOutpost();
  const r = actions.upgradeHub(uid, { district: od });
  assert.deepEqual(r, { ok: true });
  assert.equal(stock(id, 'scrap', od), 500 - 100);
  assert.match(actions.upgradeHub(uid, { district: od }).error, /already underway/);
  tick(2);
  assert.equal(db.prepare('SELECT level FROM districts WHERE id = ?').get(od).level, 2);
  assert.equal(db.prepare('SELECT hub_level FROM colonies WHERE id = ?').get(id).hub_level, 4, 'the hub level is untouched');
  assert.match(actions.upgradeHub(uid, { district: od }).error, /maximum level/);
  // ring 2 of the outpost is now open
  assert.deepEqual(actions.build(uid, { ring: 2, slot: 4, type: 'solar_array', district: od }), { ok: true });
});

test('cancelling and demolishing refund into the district they belong to', () => {
  const { uid, id, core, od } = colonyWithOutpost();
  actions.build(uid, { ring: 1, slot: 2, type: 'scrap_extractor', district: od });
  const orderId = store.loadOrders(id, od)[0].id;
  assert.deepEqual(actions.cancelOrder(uid, { orderId }), { ok: true });
  assert.equal(stock(id, 'scrap', od), 500, 'full refund to the outpost');
  db.prepare("INSERT INTO colony_buildings (colony_id, district_id, ring_index, slot_index, building_type) VALUES (?, ?, 1, 1, 'solar_array')").run(id, od);
  const coreBefore = stock(id, 'scrap', core);
  assert.deepEqual(actions.demolish(uid, { ring: 1, slot: 1, district: od }), { ok: true });
  assert.equal(stock(id, 'scrap', od), 500 + Math.floor(config.buildings.solar_array.cost.scrap * config.global.demolishRefund));
  assert.equal(stock(id, 'scrap', core), coreBefore);
  assert.match(actions.demolish(uid, { ring: 1, slot: 1, district: od }).error, /Nothing to demolish/);
});

test('toggle works per district; a district from another colony is rejected', () => {
  const a = colonyWithOutpost(), b = colonyWithOutpost();
  db.prepare("INSERT INTO colony_buildings (colony_id, district_id, ring_index, slot_index, building_type) VALUES (?, ?, 1, 0, 'solar_array')").run(a.id, a.od);
  assert.deepEqual(actions.toggle(a.uid, { ring: 1, slot: 0, district: a.od, paused: true }), { ok: true });
  assert.equal(store.loadBuildings(a.id, a.od)[0].status, 'paused');
  assert.equal(actions.toggle(b.uid, { ring: 1, slot: 0, district: a.od }).error, 'Unknown district.', 'cannot touch someone else\'s district');
  assert.equal(actions.build(b.uid, { ring: 1, slot: 0, type: 'solar_array', district: a.od }).error, 'Unknown district.');
  assert.equal(actions.demolish(b.uid, { ring: 1, slot: 0, district: 999999 }).error, 'Unknown district.');
});

test('one-per-colony limits count every district', () => {
  const { uid, id, core, od } = colonyWithOutpost();
  db.prepare("UPDATE colony_inventory SET amount = 100000 WHERE colony_id = ?").run(id);
  db.prepare("INSERT INTO colony_buildings (colony_id, district_id, ring_index, slot_index, building_type) VALUES (?, ?, 1, 0, 'beacon_array')").run(id, od);
  assert.match(actions.build(uid, { ring: 1, slot: 1, type: 'beacon_array' }).error, /Only 1 Beacon Array/);
});

test('wiping a colony removes its districts, stockpiles and buildings', () => {
  const { id, od } = colonyWithOutpost();
  db.prepare("INSERT INTO colony_buildings (colony_id, district_id, ring_index, slot_index, building_type) VALUES (?, ?, 1, 0, 'solar_array')").run(id, od);
  store.wipeColony(id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM districts WHERE colony_id = ?').get(id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM colony_inventory WHERE colony_id = ?').get(id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM colony_buildings WHERE colony_id = ?').get(id).n, 0);
});

test('district levels unlock with the Core: level 2 at Core 4, 3-4 at Core 5, 5 once the Beacon is built', () => {
  const up = (uid, od) => actions.upgradeHub(uid, { district: od });
  const level = (od) => db.prepare('SELECT level FROM districts WHERE id = ?').get(od).level;

  // Core level 3: districts are not open yet
  const early = colonyWithOutpost('deep', 3);
  assert.match(up(early.uid, early.od).error, /unlocks when the Core reaches level 4/);
  assert.equal(viewFor(early.uid).districtsUnlocked, false);
  assert.equal(viewFor(early.uid).districtLevelCap, 0);

  // Core level 4: one upgrade, to level 2
  const a = colonyWithOutpost('deep', 4);
  assert.equal(viewFor(a.uid).districtsUnlocked, true);
  assert.equal(viewFor(a.uid).districtLevelCap, 2);
  assert.deepEqual(up(a.uid, a.od), { ok: true });
  tick(1);
  assert.equal(level(a.od), 2);
  assert.match(up(a.uid, a.od).error, /District level 3 unlocks when the Core reaches level 5/);

  // Core level 5: levels 3 and 4, but not 5
  db.prepare('UPDATE colonies SET hub_level = 5 WHERE id = ?').run(a.id);
  assert.equal(viewFor(a.uid).districtLevelCap, 4);
  for (const want of [3, 4]) { assert.deepEqual(up(a.uid, a.od), { ok: true }); tick(1); assert.equal(level(a.od), want); }
  assert.match(up(a.uid, a.od).error, /District level 5 unlocks when the Core reaches level 5 and the Beacon is built/);

  // Building the Beacon (not finishing its transmission) unlocks level 5
  db.prepare("INSERT INTO colony_buildings (colony_id, district_id, ring_index, slot_index, building_type) VALUES (?, ?, 5, 0, 'beacon_array')").run(a.id, a.core);
  assert.equal(viewFor(a.uid).districtLevelCap, 5);
  assert.deepEqual(up(a.uid, a.od), { ok: true });
  tick(1);
  assert.equal(level(a.od), 5);
  assert.match(up(a.uid, a.od).error, /maximum level/);
});

test('a Beacon alone does not skip the Core: level 5 needs Core level 5 too', () => {
  const b = colonyWithOutpost('deep', 4);
  db.prepare("INSERT INTO colony_buildings (colony_id, district_id, ring_index, slot_index, building_type) VALUES (?, ?, 4, 0, 'beacon_array')").run(b.id, b.core);
  assert.equal(viewFor(b.uid).districtLevelCap, 2);
});

test('the Core itself is not gated by district progression', () => {
  const c = colonyWithOutpost('outpost', 1);
  db.prepare("UPDATE colony_inventory SET amount = 100000 WHERE district_id = ?").run(c.core);
  assert.deepEqual(actions.upgradeHub(c.uid, {}), { ok: true });
});
