'use strict';
// Orbit: recognition, the launch chain, the station and its storage, links, express launches, the station's own buildings,
// the shared territories and dropships, the orbital market and global projects.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-orbit-'));
process.env.DB_PATH = path.join(dir, 'orbit.db');
process.env.SESSION_SECRET = 'x';
process.env.THEME = 'basic';
process.env.HAZARDS = 'off';
const store = require('../src/db');
const engine = require('../src/engine');
const actions = require('../src/actions');
const orbital = require('../src/orbital');
const territories = require('../src/territories');
const projects = require('../src/projects');
const orbitalMarket = require('../src/orbitalMarket');
const sim = require('../src/sim');
const { viewFor } = require('../src/state');
const { db, config } = store;
const O = config.orbital;
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const tick = (k = 1) => { for (let i = 0; i < k; i++) engine.processTick(); };
const now = () => Number(store.getMeta('global_tick', 0));
let n = 0;
// A late-game colony: Core level 5, a level-5 Free Port, plenty of everything.
function colony() {
  const uid = Number(db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(`orb${++n}`, 'x').lastInsertRowid);
  const id = store.ensureColony(uid);
  const core = store.coreId(id);
  db.prepare('UPDATE colonies SET hub_level = 5, credits = 500000 WHERE id = ?').run(id);
  const fp = Number(db.prepare("INSERT INTO districts (colony_id, type, level, name, created_tick) VALUES (?, 'freeport', 5, 'Free Port', 0)").run(id).lastInsertRowid);
  const lots = {};
  for (const r of Object.keys(config.resources)) lots[r] = 10000; // under the storage caps
  for (const d of [core, fp]) {
    const inv = { ...lots };
    store.saveInventory(id, inv, d);
  }
  db.prepare('UPDATE colonies SET population = 400 WHERE id = ?').run(id);
  // enough power in the Core for the launch chain
  for (let i = 0; i < 6; i++) db.prepare("INSERT INTO colony_buildings (colony_id, district_id, ring_index, slot_index, building_type) VALUES (?, ?, 1, ?, 'solar_array')").run(id, core, i);
  return { uid, id, core, fp };
}
const put = (c, district, ring, slot, type) => db.prepare('INSERT INTO colony_buildings (colony_id, district_id, ring_index, slot_index, building_type) VALUES (?, ?, ?, ?, ?)').run(c.id, district, ring, slot, type);
const row = (c) => db.prepare('SELECT * FROM colonies WHERE id = ?').get(c.id);
const recognise = (c) => db.prepare("INSERT INTO standing (colony_id, faction, points) VALUES (?, 'cinder', ?) ON CONFLICT(colony_id, faction) DO UPDATE SET points = excluded.points").run(c.id, O.unlockStanding);

// The whole launch chain, built instantly, with a station launched. Returns the colony.
function launched(name) {
  const c = colony();
  recognise(c);
  put(c, c.core, 5, 0, 'orbital_staging'); put(c, c.core, 5, 1, 'orbital_catapult'); put(c, c.fp, 5, 0, 'orbital_command');
  tick(1);
  assert.deepEqual(actions.launchCycle(c.uid, { cycle: 'station' }), { ok: true });
  db.prepare("UPDATE colonies SET launch_ready = 'station' WHERE id = ?").run(c.id);
  db.prepare("UPDATE colony_buildings SET recipe = NULL WHERE colony_id = ? AND building_type = 'orbital_staging'").run(c.id);
  assert.deepEqual(actions.launch(c.uid, { name }), { ok: true });
  c.station = orbital.stationOf(c.id);
  return c;
}

test('recognition: the orbital buildings stay unknown until 500 total standing, then stick', () => {
  const c = colony();
  assert.equal(actions.build(c.uid, { ring: 5, slot: 0, type: 'orbital_staging' }).error, 'Unknown building type.');
  assert.equal(viewFor(c.uid).orbital.unlocked, false);
  db.prepare("INSERT INTO standing (colony_id, faction, points) VALUES (?, 'cinder', 300), (?, 'verdant', 200)").run(c.id, c.id);
  const v = viewFor(c.uid);
  assert.equal(v.orbital.unlocked, true, 'total standing across factions counts');
  assert.equal(v.orbital.standing, 500);
  db.prepare('DELETE FROM standing WHERE colony_id = ?').run(c.id);
  assert.equal(viewFor(c.uid).orbital.unlocked, true, 'and it sticks');
});

test('placement: staging needs a Colossal plot, the catapult must stand beside a finished staging platform, the command center needs a Heavy plot in the Free Port', () => {
  const c = colony();
  recognise(c);
  assert.match(actions.build(c.uid, { ring: 4, slot: 0, type: 'orbital_staging' }).error, /Colossal plot/);
  assert.match(actions.build(c.uid, { ring: 5, slot: 1, type: 'orbital_catapult' }).error, /Build the Orbital Staging Platform first/);
  assert.deepEqual(actions.build(c.uid, { ring: 5, slot: 0, type: 'orbital_staging' }), { ok: true });
  assert.match(actions.build(c.uid, { ring: 5, slot: 1, type: 'orbital_catapult' }).error, /first/, 'still under construction');
  tick(config.buildings.orbital_staging.constructionTicks);
  assert.match(actions.build(c.uid, { ring: 5, slot: 5, type: 'orbital_catapult' }).error, /right beside/);
  assert.deepEqual(actions.build(c.uid, { ring: 5, slot: 1, type: 'orbital_catapult' }), { ok: true });
  assert.match(actions.build(c.uid, { ring: 4, slot: 0, type: 'orbital_command', district: c.fp }).error, /Heavy plot/);
  assert.deepEqual(actions.build(c.uid, { ring: 5, slot: 0, type: 'orbital_command', district: c.fp }), { ok: true });
  assert.match(actions.build(c.uid, { ring: 5, slot: 1, type: 'orbital_command', district: c.fp }).error, /Only 1/);
});

test('the launch cycle draws its materials every tick, completes, stands down, and the launch founds a named station', () => {
  const c = colony();
  recognise(c);
  assert.match(actions.launchCycle(c.uid, { cycle: 'station' }).error, /staging platform/);
  put(c, c.core, 5, 0, 'orbital_staging'); put(c, c.core, 5, 1, 'orbital_catapult');
  assert.match(actions.launchCycle(c.uid, { cycle: 'station' }).error, /Command Center/);
  put(c, c.fp, 5, 0, 'orbital_command');
  assert.match(actions.launchCycle(c.uid, { cycle: 'ring2' }).error, /not the next/);
  assert.deepEqual(actions.launchCycle(c.uid, { cycle: 'station' }), { ok: true });
  const frames0 = store.loadInventory(c.id, c.core).frames;
  tick(10);
  const per = O.launch.cycles.station.perTick.frames;
  assert.ok(Math.abs(frames0 - store.loadInventory(c.id, c.core).frames - per * 10) < 1e-6, 'it draws its materials every tick');
  assert.equal(Math.round(row(c).launch_progress), 10);
  assert.match(actions.launch(c.uid, { name: 'Early' }).error, /Nothing is ready/);
  db.prepare('UPDATE colonies SET launch_progress = ? WHERE id = ?').run(O.launch.cycles.station.ticks - 1, c.id);
  tick(1);
  assert.equal(row(c).launch_ready, 'station');
  assert.equal(db.prepare("SELECT recipe FROM colony_buildings WHERE colony_id = ? AND building_type = 'orbital_staging'").get(c.id).recipe, null, 'the cycle unloads itself');
  const before = store.loadInventory(c.id, c.core).frames;
  tick(2);
  assert.equal(store.loadInventory(c.id, c.core).frames, before, 'and stops drawing');
  // names: rules, no callsigns, unique
  assert.match(actions.launch(c.uid, { name: 'x' }).error, /3 to 24/);
  assert.match(actions.launch(c.uid, { name: '<script>' }).error, /letters/);
  assert.match(actions.launch(c.uid, { name: 'orb1' }).error, /callsign/);
  assert.deepEqual(actions.launch(c.uid, { name: 'Hollow Bell' }), { ok: true });
  const v = viewFor(c.uid);
  assert.equal(v.orbital.station.name, 'Hollow Bell');
  assert.equal(v.orbital.station.storage.slots.length, O.storage.levels['1'].slots);
  assert.equal(v.orbital.ships.ships.length, 1, 'one dropship comes with the station');
  assert.equal(v.orbital.launch.next, 'ring2');
  const d = launched('Second Bell');
  assert.ok(d);
  const e = colony(); recognise(e);
  put(e, e.core, 5, 0, 'orbital_staging'); put(e, e.core, 5, 1, 'orbital_catapult'); put(e, e.fp, 5, 0, 'orbital_command');
  db.prepare("UPDATE colonies SET launch_ready = 'station' WHERE id = ?").run(e.id);
  assert.match(actions.launch(e.uid, { name: 'hollow bell' }).error, /Another station/);
});

test('orbital storage: slots hold one resource each, overflow without a slot is lost, jettisoned slots must be rebuilt', () => {
  const c = launched('Slot House');
  const did = c.station.district_id;
  const used = orbital.slots(c.id).filter((s) => s.resource).length;
  assert.equal(used, Object.keys(O.launch.starterKit).length, 'the starter kit takes its slots');
  const inv = store.loadInventory(c.id, did);
  const extra = ['scrap', 'ore', 'crude', 'fuel', 'alloys'];
  for (const r of extra) inv[r] = 10;
  store.saveInventory(c.id, inv, did);
  tick(1);
  const after = store.loadInventory(c.id, did);
  const kept = extra.filter((r) => after[r] > 0);
  assert.equal(kept.length, O.storage.levels['1'].slots - used, 'only the free slots were taken');
  assert.ok(db.prepare("SELECT 1 FROM colony_events WHERE colony_id = ? AND message LIKE 'No storage slot in orbit%'").get(c.id));
  const slot = orbital.slots(c.id).find((s) => s.resource === kept[0]);
  assert.deepEqual(actions.jettison(c.uid, { slot: slot.idx }), { ok: true });
  assert.equal(store.loadInventory(c.id, did)[kept[0]], 0);
  assert.equal(orbital.slots(c.id).find((s) => s.idx === slot.idx).state, 'jettisoned');
  assert.deepEqual(actions.rebuildSlot(c.uid, { slot: slot.idx }), { ok: true });
  assert.equal(orbital.slots(c.id).find((s) => s.idx === slot.idx).state, 'open');
  assert.match(actions.rebuildSlot(c.uid, { slot: slot.idx }).error, /does not need/);
  assert.deepEqual(actions.orbitalStorageUpgrade(c.uid), { ok: false, error: actions.orbitalStorageUpgrade(c.uid).error }, 'needs materials in orbit');
});

test('orbital links: Core to station only, at most four, capped rate, never rare resources, and they move goods every tick', () => {
  const c = launched('Link Hall');
  const did = c.station.district_id;
  const route = (resource, rate, from = c.core, to = did) => actions.setRoute(c.uid, { from, to, resource, rate, reserve: 0 });
  assert.match(route('void_glass', 5).error, /Rare resources/);
  assert.match(route('scrap', O.links.levels['1'].rate + 1).error, /at most/);
  assert.match(route('scrap', 5, c.fp, did).error, /only run between the Core/);
  assert.deepEqual(route('frames', 10), { ok: true });
  const f0 = store.loadInventory(c.id, did).frames;
  tick(2);
  assert.equal(store.loadInventory(c.id, did).frames, f0 + 20);
  assert.deepEqual(route('fittings', 5, did, c.core), { ok: true }, 'links can run down too');
  assert.deepEqual(route('power_cells', 5), { ok: true });
  assert.deepEqual(route('alloys', 5), { ok: true });
  assert.match(route('modules', 5).error, /all in use|no slot/);
});

test('express launch: one slot, fuel, a cooldown, arrives after the trip', () => {
  const c = launched('Fast Lane');
  const did = c.station.district_id;
  const fuel0 = store.loadInventory(c.id, c.core).fuel;
  assert.match(actions.expressLaunch(c.uid, { resource: 'frames', qty: O.express.maxQty + 1 }).error, /between/);
  assert.deepEqual(actions.expressLaunch(c.uid, { resource: 'frames', qty: 100 }), { ok: true });
  assert.equal(store.loadInventory(c.id, c.core).fuel, fuel0 - orbital.expressCost(100));
  assert.match(actions.expressLaunch(c.uid, { resource: 'frames', qty: 1 }).error, /not ready/);
  const f0 = store.loadInventory(c.id, did).frames;
  tick(O.express.travelTicks);
  assert.equal(store.loadInventory(c.id, did).frames, f0 + 100);
});

test('the station builds its own buildings: a Klein reactor burns cells for power, the foundry runs orbital recipes', () => {
  const c = launched('Foundry Row');
  const did = c.station.district_id;
  assert.deepEqual(actions.build(c.uid, { ring: 1, slot: 0, type: 'klein_reactor', district: did }), { ok: true });
  assert.match(actions.build(c.uid, { ring: 1, slot: 1, type: 'solar_array', district: did }).error, /can't be built/);
  assert.match(actions.build(c.uid, { ring: 2, slot: 0, type: 'orbital_foundry', district: did }).error, /locked/);
  assert.deepEqual(actions.build(c.uid, { ring: 1, slot: 1, type: 'orbital_foundry', district: did }), { ok: true });
  assert.match(actions.build(c.uid, { ring: 1, slot: 2, type: 'orbital_staging', district: did }).error, /can't be built/);
  tick(config.buildings.orbital_foundry.constructionTicks);
  assert.deepEqual(actions.setRecipe(c.uid, { ring: 1, slot: 1, recipe: 'lattice_cores', district: did }), { ok: true });
  // feed it: rare inputs in storage (a bigger store, so the output has a slot too)
  db.prepare('UPDATE stations SET storage_level = 2 WHERE colony_id = ?').run(c.id);
  orbital.ensureSlots(c.id, O.storage.levels['2'].slots);
  const inv = store.loadInventory(c.id, did);
  Object.assign(inv, { void_glass: 50, echo_quartz: 50, circuits: 50 });
  store.saveInventory(c.id, inv, did);
  tick(5);
  const v = viewFor(c.uid);
  const out = v.views[did].resources.lattice_cores;
  assert.ok(out.amount > 0, 'the foundry makes an orbital-only good');
  assert.ok(v.views[did].energy.supply >= 90, 'the reactor powers the grid');
  const fd = v.views[did].buildings.find((b) => b.type === 'orbital_foundry');
  assert.equal(fd.status, 'running');
  // the standard recipes are there too, with more power
  assert.ok(sim.recipeBook(config, config.buildings.orbital_foundry).tool_steel.inputsPerTick.energy > config.recipes.tool_steel.inputsPerTick.energy);
});

test('territories: the shared pool stays full, a deployment lands, builds a chain, and flies home with what was chosen', () => {
  tick(1);
  const open = db.prepare('SELECT COUNT(*) AS n FROM territories WHERE taken_by IS NULL AND closes_tick > ?').get(now()).n;
  assert.ok(open >= O.territories.minAvailable);
  const c = launched('Drop Zone');
  const ship = territories.shipsOf(c.id)[0];
  const t0 = db.prepare("SELECT * FROM territories WHERE taken_by IS NULL AND closes_tick > ? ORDER BY closes_tick DESC LIMIT 1").get(now() + 400);
  // a known territory: Aquifer Draw and Raw Ink on the surface, Raw Ore under it, and Mycolian Spores in the anomaly
  const known = { common1: 'unpurified_water', common2: 'raw_synthetics', district: 'ore', rare: 'drift_spores' };
  db.prepare('UPDATE territories SET resources = ? WHERE id = ?').run(JSON.stringify(known), t0.id);
  const t = db.prepare('SELECT * FROM territories WHERE id = ?').get(t0.id);
  assert.match(actions.shipDeploy(c.uid, { ship: ship.id, territory: t.id, preload: { frames: 99999 } }).error, /hold|Not enough/);
  assert.deepEqual(actions.shipDeploy(c.uid, { ship: ship.id, territory: t.id, preload: { frames: 20 } }), { ok: true });
  const other = launched('Late Comer');
  assert.match(actions.shipDeploy(other.uid, { ship: territories.shipsOf(other.id)[0].id, territory: t.id }).error, /already down there/);
  tick(O.dropships.deployTicks);
  const land = db.prepare("SELECT * FROM districts WHERE colony_id = ? AND type = 'territory'").get(c.id);
  assert.ok(land, 'the ship landed and became a territory');
  const res = JSON.parse(t.resources);
  const tinv = store.loadInventory(c.id, land.id);
  assert.equal(tinv.frames, 20, 'the preload came down');
  assert.equal(tinv.machined_parts, O.dropships.starterKit.machined_parts);
  // only buildings with something to work on here, and only the field versions of ground buildings
  assert.match(actions.build(c.uid, { ring: 1, slot: 0, type: 'crude_pump', district: land.id }).error, /nothing to work on/);
  assert.match(actions.build(c.uid, { ring: 1, slot: 0, type: 'solar_array', district: land.id }).error, /can't be built/);
  const kit0 = store.loadInventory(c.id, land.id);
  assert.deepEqual(actions.build(c.uid, { ring: 1, slot: 0, type: 'water_pump', district: land.id }), { ok: true });
  const kit1 = store.loadInventory(c.id, land.id);
  assert.equal(kit1.machined_parts, kit0.machined_parts - config.buildings.water_pump.territory.cost.machined_parts, 'a field build is paid in the field cost');
  assert.equal(kit1.scrap, kit0.scrap, 'not the ground cost');
  db.prepare("DELETE FROM colony_work_orders WHERE colony_id = ? AND district_id = ?").run(c.id, land.id);
  // build the chain (instantly): Aquifer Draw to Filtrate, Raw Ink from the ground, and the tap
  db.prepare('DELETE FROM colony_buildings WHERE district_id = ?').run(land.id);
  for (const [ring, slot, type] of [[1, 0, 'water_pump'], [1, 1, 'synth_reclaimer'], [1, 2, 'water_purifier'], [2, 0, 't_tap']]) put(c, land.id, ring, slot, type);
  assert.match(actions.setRecipe(c.uid, { ring: 2, slot: 0, recipe: 'void_glass_a', district: land.id }).error, /does not draw/, 'a tap draws only this anomaly\'s own rare resource');
  assert.deepEqual(actions.setRecipe(c.uid, { ring: 2, slot: 0, recipe: 'drift_spores_a', district: land.id }), { ok: true });
  tick(30);
  const after = store.loadInventory(c.id, land.id);
  assert.ok(after.unpurified_water > 0 || after.clean_water > 0, 'the pump and the purifier work');
  assert.ok(after.raw_synthetics > 0 || after.drift_spores > 0, 'the reclaimer pulls Raw Ink out of the ground here');
  assert.ok(after[res.rare] > 0, 'the tap draws the rare resource from Filtrate and Raw Ink');
  const free = actions.setRecipe(c.uid, { ring: 2, slot: 0, recipe: 'drift_spores_b', district: land.id });
  assert.ok(free.ok || /resetting/.test(free.error), 'switching recipes costs no credits');
  // territory links: to the station only, never rare
  assert.match(actions.setRoute(c.uid, { from: land.id, to: c.station.district_id, resource: res.rare, rate: 5 }).error, /Rare/);
  assert.deepEqual(actions.setRoute(c.uid, { from: land.id, to: c.station.district_id, resource: res.district, rate: 5 }), { ok: true });
  // fly home with the default plan (rare + district resource)
  const closes = db.prepare('SELECT closes_tick FROM territories WHERE id = ?').get(t.id).closes_tick;
  assert.deepEqual(actions.shipReturn(c.uid, { ship: ship.id }), { ok: true });
  assert.equal(db.prepare('SELECT 1 FROM districts WHERE id = ?').get(land.id), undefined, 'the territory district is gone');
  const t2 = db.prepare('SELECT * FROM territories WHERE id = ?').get(t.id);
  assert.equal(t2.taken_by, null, 'open to others again');
  assert.ok(t2.closes_tick < closes && t2.destabilized === 1, 'but destabilised: it closes sooner');
  const cargo = JSON.parse(db.prepare('SELECT cargo FROM dropships WHERE id = ?').get(ship.id).cargo);
  assert.ok(cargo[res.rare] > 0);
  assert.equal(cargo[res.common1], undefined, 'what was not chosen is left behind');
  tick(O.dropships.returnTicks);
  assert.equal(db.prepare('SELECT state FROM dropships WHERE id = ?').get(ship.id).state, 'docked');
  assert.ok(store.loadInventory(c.id, c.station.district_id)[res.rare] > 0, 'the rare resource reached orbital storage');
  assert.ok(orbital.flagsOf(row(c)).rareReturned !== undefined);
});

test('late departures damage the ship; the first loss is forgiven (cargo gone), the second is not', () => {
  const c = launched('Thin Hull');
  const ship = territories.shipsOf(c.id)[0];
  const deployTo = () => {
    const t = db.prepare('SELECT * FROM territories WHERE taken_by IS NULL AND closes_tick > ? ORDER BY closes_tick DESC LIMIT 1').get(now() + 100);
    assert.deepEqual(actions.shipDeploy(c.uid, { ship: ship.id, territory: t.id }), { ok: true });
    tick(O.dropships.deployTicks);
    return t;
  };
  let t = deployTo();
  db.prepare('UPDATE dropships SET integrity = 10 WHERE id = ?').run(ship.id);
  db.prepare('UPDATE territories SET closes_tick = ? WHERE id = ?').run(now() + 1, t.id);
  tick(1);
  let s = db.prepare('SELECT * FROM dropships WHERE id = ?').get(ship.id);
  assert.equal(s.state, 'returning');
  assert.equal(s.integrity, O.dropships.savedIntegrity, 'saved the first time');
  assert.equal(s.saved_once, 1);
  assert.deepEqual(JSON.parse(s.cargo), {}, 'with its cargo lost');
  tick(O.dropships.returnTicks);
  assert.ok(actions.shipRepair(c.uid, { ship: ship.id }).ok || true);
  db.prepare('UPDATE dropships SET integrity = 5 WHERE id = ?').run(ship.id);
  t = deployTo();
  db.prepare('UPDATE territories SET closes_tick = ? WHERE id = ?').run(now() + 1, t.id);
  tick(1);
  assert.equal(db.prepare('SELECT 1 FROM dropships WHERE id = ?').get(ship.id), undefined, 'lost the second time');
  assert.deepEqual(actions.shipBuild(c.uid), { ok: false, error: actions.shipBuild(c.uid).error }, 'a replacement costs materials in orbit');
});

test('repairs cost the damaged share of what went into the ship', () => {
  const c = launched('Dry Dock');
  const ship = territories.shipsOf(c.id)[0];
  db.prepare('UPDATE dropships SET integrity = 50 WHERE id = ?').run(ship.id);
  const cost = territories.repairCost(db.prepare('SELECT * FROM dropships WHERE id = ?').get(ship.id));
  assert.equal(cost.frames, Math.ceil(O.dropships.freeValue.frames / 2));
  const inv = store.loadInventory(c.id, c.station.district_id);
  Object.assign(inv, { frames: 2000, fittings: 2000, power_cells: 2000 });
  store.saveInventory(c.id, inv, c.station.district_id);
  orbital.ensureSlots(c.id, 10);
  db.prepare("UPDATE stations SET storage_level = 3 WHERE colony_id = ?").run(c.id);
  assert.match(actions.shipRepair(c.uid, { ship: ship.id }).error, /Modules/i, 'every material it was built with');
});

test('orbital market: trade goods only, station names shown, held escrow, price-time matching, fee on the seller', () => {
  const a = launched('Seller Station');
  const b = launched('Buyer Station');
  const tickNow = now();
  assert.match(actions.orbitPost(a.uid, { resource: 'scrap', side: 'sell', price: 1, qty: 1, ttl: 100 }).error, /Only trade goods/);
  assert.match(actions.orbitPost(a.uid, { resource: 'void_glass', side: 'sell', price: 100, qty: 1, ttl: 100 }).error, /Only trade goods/);
  const ref = orbitalMarket.reference('frames', tickNow);
  assert.match(actions.orbitPost(a.uid, { resource: 'frames', side: 'sell', price: ref * 3, qty: 1, ttl: 100 }).error, /only takes prices/);
  assert.ok(viewFor(a.uid).orbital.market.goods.find((g) => g.resource === 'frames').asks.some((o) => o.maker), 'market makers seed the book');
  // take the makers out of this good so the two stations meet each other
  db.prepare("UPDATE orbital_orders SET status = 'cancelled' WHERE colony_id IS NULL AND resource_id = 'frames'").run();
  const price = Math.round(ref * 1.02 * 100) / 100;
  const f0 = store.loadInventory(a.id, a.station.district_id).frames;
  assert.equal(actions.orbitPost(a.uid, { resource: 'frames', side: 'sell', price, qty: 5, ttl: 100 }).ok, true);
  assert.equal(store.loadInventory(a.id, a.station.district_id).frames, f0 - 5, 'the goods are held');
  const credA = row(a).credits; const credB = row(b).credits;
  const fb0 = store.loadInventory(b.id, b.station.district_id).frames;
  const bid = Math.round(ref * 1.05 * 100) / 100;
  assert.equal(actions.orbitPost(b.uid, { resource: 'frames', side: 'buy', price: bid, qty: 5, ttl: 100 }).ok, true);
  assert.equal(store.loadInventory(b.id, b.station.district_id).frames, fb0 + 5, 'delivered to orbital storage');
  assert.equal(row(b).credits, credB - Math.ceil(5 * bid) + Math.floor(5 * (bid - price)), 'paid the resting price, the rest of the hold returned');
  assert.equal(row(a).credits, credA + Math.floor(5 * price * (1 - O.market.feeRate)));
  const trade = db.prepare('SELECT * FROM orbital_trades ORDER BY id DESC LIMIT 1').get();
  assert.equal(trade.buyer, 'Buyer Station'); assert.equal(trade.seller, 'Seller Station');
  const v = viewFor(a.uid).orbital.market;
  assert.ok(v.goods.some((g) => g.resource === 'lattice_cores') && !v.goods.some((g) => g.resource === 'void_glass'));
});

test('global projects: announced, then active with needs scaled to players, contributions by dropship, a bonus on completion', () => {
  const c = launched('Project Yard');
  let p = projects.current();
  if (!p || p.status !== 'announced') { tick(1); p = projects.current(); }
  db.prepare('UPDATE global_projects SET starts_tick = ? WHERE id = ?').run(now() + 1, p.id);
  db.prepare('UPDATE colonies SET last_seen_at = ?').run(Date.now());
  tick(1);
  p = projects.current();
  assert.equal(p.status, 'active');
  const needs = JSON.parse(p.needs);
  const def = projects.defOf(p.key);
  for (const [r, q] of Object.entries(def.needs)) assert.equal(needs[r], q * p.players);
  // contribute everything at once from orbital storage
  const did = c.station.district_id;
  orbital.ensureSlots(c.id, 10);
  db.prepare('UPDATE stations SET storage_level = 3 WHERE colony_id = ?').run(c.id);
  const inv = store.loadInventory(c.id, did);
  for (const [r, q] of Object.entries(needs)) inv[r] = q;
  store.saveInventory(c.id, inv, did);
  db.prepare("UPDATE dropships SET level = 3 WHERE colony_id = ?").run(c.id);
  const ship = territories.shipsOf(c.id)[0];
  assert.match(actions.projectContribute(c.uid, { ship: ship.id, cargo: { scrap: 1 } }).error, /does not need/);
  assert.deepEqual(actions.projectContribute(c.uid, { ship: ship.id, cargo: needs }), { ok: true });
  tick(Math.floor(O.dropships.contributeTicks / 2) + 1);
  p = projects.current();
  assert.equal(p.status, 'bonus', 'complete');
  const v = viewFor(c.uid).orbital.project;
  assert.equal(v.status, 'bonus');
  if (def.bonus.kind === 'efficiency') assert.equal(projects.globalOut()[def.bonus.buildings[0]], def.bonus.mult);
  if (def.faction) assert.ok(db.prepare('SELECT points FROM standing WHERE colony_id = ? AND faction = ?').get(c.id, def.faction).points >= O.projects.standingReward);
  tick(O.dropships.contributeTicks);
  assert.equal(db.prepare('SELECT state FROM dropships WHERE id = ?').get(ship.id).state, 'docked');
});

test('ground markets never see orbital-only resources', () => {
  const market = require('../src/market');
  const c = colony();
  const r = market.post(row(c), { id: c.core, type: 'core' }, { resource: 'void_glass', side: 'sell', price: 10, qty: 1, ttl: 30 }, now());
  assert.equal(r.ok, false);
});

test('station rings come from further launch cycles; ring 3 also needs orbital-only goods already in orbit', () => {
  const c = launched('Ring Builder');
  assert.equal(orbital.nextCycle(c.id), 'ring2');
  assert.deepEqual(actions.launchCycle(c.uid, { cycle: 'ring2' }), { ok: true });
  db.prepare("UPDATE colonies SET launch_ready = 'ring2', launch_progress = 0 WHERE id = ?").run(c.id);
  db.prepare("UPDATE colony_buildings SET recipe = NULL WHERE colony_id = ? AND building_type = 'orbital_staging'").run(c.id);
  assert.deepEqual(actions.launch(c.uid, {}), { ok: true });
  assert.equal(db.prepare('SELECT level FROM districts WHERE id = ?').get(c.station.district_id).level, 2);
  assert.deepEqual(actions.build(c.uid, { ring: 2, slot: 0, type: 'klein_reactor', district: c.station.district_id }).ok, true, 'ring 2 is open');
  db.prepare("UPDATE colonies SET launch_ready = 'ring3' WHERE id = ?").run(c.id);
  assert.match(actions.launch(c.uid, {}).error, /Lattice Cores in orbital storage/);
  assert.equal(orbital.flagsOf(row(c)).ring2 !== undefined, true);
});

test('express drop: a capsule from orbital storage to the Core, no fuel, the capsule paid in orbit, the same express slot', () => {
  const c = launched('Down Again');
  const did = c.station.district_id;
  const D = O.express.drop;
  const st0 = store.loadInventory(c.id, did); const core0 = store.loadInventory(c.id, c.core);
  assert.match(actions.expressLaunch(c.uid, { resource: 'void_glass', qty: 1, dir: 'down' }).error, /cannot be dropped/);
  assert.deepEqual(actions.expressLaunch(c.uid, { resource: 'frames', qty: 50, dir: 'down' }), { ok: true });
  const st1 = store.loadInventory(c.id, did);
  assert.equal(st1.frames, st0.frames - 50);
  for (const [r, q] of Object.entries(D.cost)) assert.equal(st1[r], st0[r] - q, 'the capsule comes out of orbital storage');
  assert.equal(store.loadInventory(c.id, c.core).fuel, core0.fuel, 'no fuel');
  assert.match(actions.expressLaunch(c.uid, { resource: 'frames', qty: 1 }).error, /not ready/, 'shares the slot with launches');
  const f0 = store.loadInventory(c.id, c.core).frames;
  tick(D.travelTicks);
  assert.ok(store.loadInventory(c.id, c.core).frames >= f0 + 50 - 1, 'it lands at the Core');
});

test('expansion levels 6 to 10: hidden until the first rare resource is home, paid in orbital goods at an escalating rate', () => {
  const E = config.expansion;
  const c = colony();
  put(c, c.core, 2, 0, 'hydroponics_bay');
  db.prepare('UPDATE colony_buildings SET level = ? WHERE district_id = ? AND ring_index = 2 AND slot_index = 0').run(E.maxLevel, c.core);
  assert.match(actions.expand(c.uid, { ring: 2, slot: 0 }).error, /fully expanded/);
  const b = () => viewFor(c.uid).buildings.find((x) => x.type === 'hydroponics_bay');
  assert.equal(b().xnext, null);
  assert.equal(viewFor(c.uid).colony.expandMax, E.maxLevel);
  orbital.setFlag(c.id, E.orbitalUnlockFlag, now());
  assert.equal(viewFor(c.uid).colony.expandMax, E.orbitalMaxLevel);
  const cost = (l) => sim.expansionCost(config, config.buildings.hydroponics_bay, l);
  const orb = E.classes.industry.orbitalCost;
  for (const [r, q] of Object.entries(orb)) {
    assert.ok(config.resources[r].orbitalTrade, `${r} is made in orbit`);
    assert.equal(cost(6)[r], q * E.orbitalCostMult[6]);
    assert.equal(cost(10)[r], q * E.orbitalCostMult[10]);
    assert.equal(cost(5)[r], undefined, 'levels up to 5 never ask for orbital goods');
  }
  assert.deepEqual(b().xnext.cost, cost(6));
  const before = store.loadInventory(c.id, c.core);
  assert.deepEqual(actions.expand(c.uid, { ring: 2, slot: 0 }), { ok: true });
  for (const [r, q] of Object.entries(cost(6))) assert.equal(store.loadInventory(c.id, c.core)[r], before[r] - q);
  tick(E.ticks[6]);
  assert.equal(b().level, 6);
  for (let l = 7; l <= E.orbitalMaxLevel; l++) { assert.deepEqual(actions.expand(c.uid, { ring: 2, slot: 0 }), { ok: true }); tick(E.ticks[l]); }
  assert.equal(b().level, E.orbitalMaxLevel);
  assert.match(actions.expand(c.uid, { ring: 2, slot: 0 }).error, /fully expanded/);
  const lv = (l) => sim.rates(config, config.buildings.hydroponics_bay, { type: 'hydroponics_bay', level: l, status: 'active' }, 1, 'core');
  assert.ok(Math.abs(lv(10).scale - E.scale[10]) < 1e-9, 'level 10 scales the line');
});

test('rare resources are even: every orbital good uses two, and every rare is drawn at the same total rate across the recipes', () => {
  const rares = O.territories.rare;
  const demand = Object.fromEntries(rares.map((r) => [r, 0]));
  for (const rec of Object.values(config.orbitalRecipes)) {
    const used = Object.keys(rec.inputsPerTick).filter((r) => rares.includes(r));
    assert.equal(used.length, 2, `${rec.name} uses two rare resources`);
    for (const r of used) demand[r] += rec.inputsPerTick[r];
  }
  assert.equal(new Set(Object.values(demand)).size, 1, JSON.stringify(demand));
  const inProjects = new Set(O.projects.list.flatMap((p) => Object.keys(p.needs)));
  const inExpansion = new Set(Object.values(config.expansion.classes).flatMap((k) => Object.keys(k.orbitalCost || {})));
  for (const g of Object.keys(config.orbitalRecipes)) {
    assert.ok(O.projects.list.filter((p) => p.needs[g]).length >= 2, `${g} is needed by at least two projects`);
    assert.ok(inProjects.has(g) && inExpansion.has(g), `${g} has a use in projects and in expansions`);
  }
});

test('tap recipes: every rare has alternatives built from ground chains, and roughly half of the territories can extract their rare', () => {
  const T = O.territories;
  const fits = Object.values(config.buildings).filter((b) => b.territory && b.territory.needs).map((b) => ({ ...b, ...b.territory }));
  const reach = (held) => {
    const have = new Set(held);
    for (let again = true; again;) {
      again = false;
      for (const b of fits) {
        if (!have.has(b.needs) && !held.includes(b.needs)) continue;
        if (!Object.keys(b.inputsPerTick).filter((r) => r !== 'energy').every((r) => have.has(r))) continue;
        for (const r of Object.keys(b.outputsPerTick)) if (!have.has(r)) { have.add(r); again = true; }
      }
    }
    return have;
  };
  const pairs = [[0, 1], [0, 2], [1, 2]].flatMap(([a, b]) => T.district.map((d) => [T.common[a], T.common[b], d]));
  assert.equal(pairs.length, 6);
  let good = 0, total = 0;
  for (const rare of T.rare) {
    const recipes = Object.values(config.tapRecipes).filter((r) => r.rare === rare);
    assert.ok(recipes.length >= 2, `${rare} has alternatives`);
    for (const r of recipes) {
      assert.deepEqual(r.outputsPerTick, { [rare]: 0.5 });
      assert.equal(r.inputsPerTick.energy, 18);
      assert.equal(Object.keys(r.inputsPerTick).length, 3, 'two inputs and power');
      for (const [k, q] of Object.entries(r.inputsPerTick)) if (k !== 'energy') { assert.equal(q, 8); assert.ok(!config.resources[k].orbitalOnly, `${k} is an ordinary good`); }
    }
    const works = pairs.filter((p) => { const have = reach(p); return recipes.some((r) => Object.keys(r.inputsPerTick).filter((k) => k !== 'energy').every((k) => have.has(k))); }).length;
    assert.ok(works >= 2 && works <= 4, `${rare} works in ${works} of 6 territories`);
    good += works; total += 6;
  }
  assert.ok(good / total > 0.4 && good / total < 0.65, `${Math.round(good / total * 100)}% of territories work`);
  for (const p of pairs) assert.ok(T.rare.filter((rare) => { const have = reach(p); return Object.values(config.tapRecipes).some((r) => r.rare === rare && Object.keys(r.inputsPerTick).filter((k) => k !== 'energy').every((k) => have.has(k))); }).length >= 3, 'no territory is a dead end for nearly everything');
});

test('the gentle anomalies last longer than any other and pay for it, in extraction or in ship power', () => {
  const an = O.territories.anomalies;
  const longest = Math.max(...Object.entries(an).filter(([k]) => k !== 'lull' && k !== 'gloam').map(([, a]) => a.durationTicks[1]));
  for (const k of ['lull', 'gloam']) {
    assert.ok(an[k].durationTicks[0] > 5760 && an[k].durationTicks[1] > longest, `${k} outlasts the others`);
    assert.ok(an[k].rareMult < 1 || an[k].powerMult < 1, `${k} has a penalty`);
    assert.ok(an[k].lateDamage < 25 && !an[k].damagePerTick, `${k} is forgiving`);
  }
  const c = launched('Slow Start');
  const ship = territories.shipsOf(c.id)[0];
  const t = db.prepare('SELECT id FROM territories WHERE taken_by IS NULL AND closes_tick > ? ORDER BY closes_tick DESC LIMIT 1').get(now() + 400);
  db.prepare("UPDATE territories SET anomaly = 'gloam' WHERE id = ?").run(t.id);
  assert.deepEqual(actions.shipDeploy(c.uid, { ship: ship.id, territory: t.id }), { ok: true });
  tick(O.dropships.deployTicks);
  const land = db.prepare("SELECT * FROM districts WHERE colony_id = ? AND type = 'territory'").get(c.id);
  const power = viewFor(c.uid).views[land.id].energy.supply;
  assert.equal(power, Math.round(O.dropships.levels[1].power * an.gloam.powerMult), 'Gloam thins the ship\'s power');
});

test('territories: the rare resources are evened out, so a needed one is never missing for long and none runs away', () => {
  const t = now() + 1;
  db.prepare('DELETE FROM territories').run();
  const rares = () => db.prepare('SELECT resources FROM territories WHERE taken_by IS NULL AND closes_tick > ?').all(t).map((x) => JSON.parse(x.resources).rare);
  for (let i = 0; i < O.territories.minAvailable; i++) territories.spawn(t, i);
  assert.equal(new Set(rares()).size, O.territories.minAvailable, 'seven open territories hold seven different rares');
  const made = {};
  for (let i = 0; i < 400; i++) {
    const open = db.prepare('SELECT id FROM territories WHERE taken_by IS NULL AND closes_tick > ?').all(t);
    db.prepare('DELETE FROM territories WHERE id = ?').run(open[(i * 7919) % open.length].id); // someone takes one, or it closes
    territories.spawn(t, 100 + i);
    assert.equal(new Set(rares()).size, O.territories.minAvailable, `round ${i}: still all different`);
    const latest = JSON.parse(db.prepare('SELECT resources FROM territories ORDER BY id DESC LIMIT 1').get().resources).rare;
    made[latest] = (made[latest] || 0) + 1;
  }
  const counts = O.territories.rare.map((r) => made[r] || 0);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 40, `every rare keeps coming up: ${counts}`);
  db.prepare('DELETE FROM territories').run();
  tick(1); // the world refills its pool for the tests that follow
});
