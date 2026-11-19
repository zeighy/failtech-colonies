'use strict';
// Headquarters: found by reading a data packet, activated by a huge bill from the Core, rebuilt on a timer, then the
// charter and its unlocks: one escalating counter, hidden amounts until committed, switching and abandoning, free unlocks,
// and what every option does to the game.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-hq-'));
process.env.DB_PATH = path.join(dir, 'hq.db');
process.env.SESSION_SECRET = 'x';
process.env.THEME = 'basic';
process.env.HAZARDS = 'off';
const store = require('../src/db');
const engine = require('../src/engine');
const actions = require('../src/actions');
const orbital = require('../src/orbital');
const territories = require('../src/territories');
const hq = require('../src/hq');
const perks = require('../src/perks');
const { viewFor } = require('../src/state');
const { db, config } = store;
const O = config.orbital;
const H = config.hq;
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const tick = (k = 1) => { for (let i = 0; i < k; i++) engine.processTick(); };
const now = () => Number(store.getMeta('global_tick', 0));
let n = 0;
function colony() {
  const uid = Number(db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(`hq${++n}`, 'x').lastInsertRowid);
  const id = store.ensureColony(uid);
  const core = store.coreId(id);
  db.prepare('UPDATE colonies SET hub_level = 5, credits = 5000000, population = 400 WHERE id = ?').run(id);
  const fp = Number(db.prepare("INSERT INTO districts (colony_id, type, level, name, created_tick) VALUES (?, 'freeport', 5, 'Free Port', 0)").run(id).lastInsertRowid);
  const lots = {};
  for (const r of Object.keys(config.resources)) lots[r] = 10000;
  store.saveInventory(id, { ...lots }, core);
  store.saveInventory(id, { ...lots }, fp);
  for (let i = 0; i < 6; i++) db.prepare("INSERT INTO colony_buildings (colony_id, district_id, ring_index, slot_index, building_type) VALUES (?, ?, 1, ?, 'solar_array')").run(id, core, i);
  // the Beacon stands (a charter holder has always built it), so a Free Port copy can be founded
  const beacon = Object.keys(config.buildings).find((k) => config.buildings[k].transmit);
  db.prepare('INSERT INTO colony_buildings (colony_id, district_id, ring_index, slot_index, building_type) VALUES (?, ?, 5, 3, ?)').run(id, core, beacon);
  return { uid, id, core, fp };
}
const put = (c, district, ring, slot, type) => db.prepare('INSERT INTO colony_buildings (colony_id, district_id, ring_index, slot_index, building_type) VALUES (?, ?, ?, ?, ?)').run(c.id, district, ring, slot, type);
function launched(name) {
  const c = colony();
  db.prepare("INSERT INTO standing (colony_id, faction, points) VALUES (?, 'cinder', ?)").run(c.id, O.unlockStanding);
  put(c, c.core, 5, 0, 'orbital_staging'); put(c, c.core, 5, 1, 'orbital_catapult'); put(c, c.fp, 5, 0, 'orbital_command');
  tick(1);
  assert.deepEqual(actions.launchCycle(c.uid, { cycle: 'station' }), { ok: true });
  db.prepare("UPDATE colonies SET launch_ready = 'station' WHERE id = ?").run(c.id);
  db.prepare("UPDATE colony_buildings SET recipe = NULL WHERE colony_id = ? AND building_type = 'orbital_staging'").run(c.id);
  assert.deepEqual(actions.launch(c.uid, { name }), { ok: true });
  c.station = orbital.stationOf(c.id);
  return c;
}
const readPacket = (c) => db.prepare("INSERT INTO colony_data_packets (colony_id, packet_id, level) VALUES (?, 'p01', 1)").run(c.id);
const hqRow = (c) => db.prepare('SELECT * FROM colony_hq WHERE colony_id = ?').get(c.id);
const credits = (c) => db.prepare('SELECT credits FROM colonies WHERE id = ?').get(c.id).credits;
const stock = (c, d, r) => store.loadInventory(c.id, d)[r] || 0;
const setStock = (c, d, r, q) => db.prepare('UPDATE colony_inventory SET amount = ? WHERE district_id = ? AND resource_id = ?').run(q, d, r);
// A station that has read a packet and holds the charter, without paying for it (the activation has its own test).
function chartered(name) {
  const c = launched(name);
  readPacket(c);
  hq.rowOf(c, now());
  db.prepare("UPDATE colony_hq SET stage = 'chartered', free = 0, chartered_tick = ? WHERE colony_id = ?").run(now(), c.id);
  db.prepare('UPDATE colonies SET data_fragments = 50 WHERE id = ?').run(c.id); // committing takes fragments
  return c;
}
// Take an unlock all the way: commit, pay the whole bill (topped up in the Core and the treasury), wait out the work.
function unlock(c, category, option, extra = {}) {
  assert.deepEqual(actions.hqStart(c.uid, { category, option, ...extra }), { ok: true });
  const need = JSON.parse(hqRow(c).cur).need;
  for (const [r, q] of Object.entries(need)) if (r === 'credits') db.prepare('UPDATE colonies SET credits = credits + ? WHERE id = ?').run(q, c.id); else setStock(c, c.core, r, q + 10);
  assert.equal(actions.hqGive(c.uid, {}).ok, true);
  assert.equal(actions.hqGive(c.uid, { resource: 'credits' }).completed, true);
  const cur = JSON.parse(hqRow(c).cur);
  assert.equal(cur.state, 'building');
  db.prepare('UPDATE colony_hq SET cur = ? WHERE colony_id = ?').run(JSON.stringify({ ...cur, readyTick: now() + 1 }), c.id);
  tick(1);
  assert.equal(hqRow(c).cur, null, 'the unlock finished');
}

test('Headquarters opens once any data packet is read, and the story hears of it', () => {
  const c = launched('Quiet Desk');
  assert.equal(viewFor(c.uid).hq.unlocked, false);
  assert.match(actions.hqGive(c.uid, {}).error, /not been found/);
  readPacket(c);
  const v = viewFor(c.uid);
  assert.equal(v.hq.unlocked, true);
  assert.equal(v.hq.stage, 'activation');
  assert.deepEqual(v.hq.activation.need, H.activation.cost, 'the activation bill is shown in full');
  assert.ok(orbital.flagsOf(db.prepare('SELECT * FROM colonies WHERE id = ?').get(c.id)).hqOpened !== undefined);
});

test('activation: paid from the Core in instalments, then rebuilt on a timer, then the charter: credits, free unlocks, the badge', () => {
  const c = launched('Long Haul');
  readPacket(c);
  hq.rowOf(c, now());
  // a named delivery takes what is asked for; the bill never takes more than it needs
  const bm0 = stock(c, c.core, 'building_materials');
  assert.deepEqual(actions.hqGive(c.uid, { resource: 'building_materials', qty: 250 }), { ok: true, given: { building_materials: 250 } });
  assert.equal(stock(c, c.core, 'building_materials'), bm0 - 250);
  assert.match(actions.hqGive(c.uid, { resource: 'rations', qty: 5 }).error, /does not need/);
  // everything the Core holds that the bill still needs
  const alloys = Math.floor(stock(c, c.core, 'alloys'));
  const out = actions.hqGive(c.uid, {});
  assert.equal(out.ok, true);
  assert.equal(out.given.alloys, alloys);
  assert.ok(stock(c, c.core, 'alloys') < 1);
  assert.match(actions.hqGive(c.uid, {}).error, /nothing the bill still needs/);
  // nearly there: one delivery completes it, and the rebuild starts
  const almost = Object.fromEntries(Object.entries(H.activation.cost).map(([r, q]) => [r, q - (r === 'ingots' ? 5 : 0)]));
  db.prepare('UPDATE colony_hq SET got = ? WHERE colony_id = ?').run(JSON.stringify(almost), c.id);
  setStock(c, c.core, 'ingots', 100);
  const fin = actions.hqGive(c.uid, { resource: 'ingots' });
  assert.equal(fin.completed, true);
  assert.equal(fin.given.ingots, 5, 'only what was still needed');
  assert.equal(hqRow(c).stage, 'rebuilding');
  assert.equal(viewFor(c.uid).hq.activation.readyIn, H.activation.ticks);
  assert.match(actions.hqGive(c.uid, {}).error, /being rebuilt/);
  // the rebuild finishes: the charter pays out and opens the unlocks
  db.prepare('UPDATE colony_hq SET ready_tick = ? WHERE colony_id = ?').run(now() + 1, c.id);
  const cr0 = credits(c);
  tick(1);
  assert.equal(hqRow(c).stage, 'chartered');
  assert.equal(hqRow(c).free, H.charter.freeUnlocks);
  assert.ok(credits(c) >= cr0 + H.charter.credits - 1000, 'the charter grant reached the treasury');
  assert.ok(orbital.flagsOf(db.prepare('SELECT * FROM colonies WHERE id = ?').get(c.id)).chartered !== undefined);
  const v = viewFor(c.uid);
  assert.equal(v.orbital.station.badge, H.charter.badge);
  // the badge follows the station's name on the orbital market
  assert.deepEqual(actions.orbitPost(c.uid, { resource: 'frames', side: 'buy', price: v.orbital.market.goods.find((g) => g.resource === 'frames').reference, qty: 1, ttl: 100 }).ok, true);
  const bids = viewFor(c.uid).orbital.market.goods.find((g) => g.resource === 'frames').bids;
  assert.ok(bids.some((b) => b.station === `Long Haul ${H.charter.badge}`));
});

test('unlocks: amounts hidden until committed, one escalating counter, a timer that grows, switching carries a share, abandoning refunds nothing', () => {
  const c = chartered('Ledger Point');
  let v = viewFor(c.uid).hq;
  const district = v.categories.find((k) => k.key === 'district');
  assert.deepEqual(district.goods, Object.keys(H.categories.district.cost), 'which goods it takes');
  assert.equal(JSON.stringify(v.categories).includes(String(H.categories.district.cost.building_materials)), false, 'but not how many');
  assert.match(actions.hqStart(c.uid, { category: 'district', option: 'nope' }).error, /Unknown/);
  assert.match(actions.hqStart(c.uid, { category: 'district', option: 'discover', free: true }).error, /no free unlock/);
  // committing takes a data fragment; without one nothing happens
  const frags = () => db.prepare('SELECT data_fragments FROM colonies WHERE id = ?').get(c.id).data_fragments;
  db.prepare('UPDATE colonies SET data_fragments = 0 WHERE id = ?').run(c.id);
  assert.match(actions.hqStart(c.uid, { category: 'surface', option: 'route' }).error, /data fragment/);
  assert.equal(hqRow(c).cur, null);
  db.prepare('UPDATE colonies SET data_fragments = 3 WHERE id = ?').run(c.id);
  // the first paid unlock is at the base bill and the base time
  assert.deepEqual(actions.hqStart(c.uid, { category: 'surface', option: 'route' }), { ok: true });
  assert.equal(frags(), 3 - H.fragmentCost);
  v = viewFor(c.uid).hq;
  assert.deepEqual(v.cur.need, H.categories.surface.cost);
  assert.equal(v.cur.ticks, H.baseTicks);
  // deliver part of it, then switch: a quarter of what both bills share carries over
  assert.equal(actions.hqGive(c.uid, { resource: 'building_materials', qty: 4000 }).ok, true);
  assert.equal(actions.hqGive(c.uid, { resource: 'machined_parts', qty: 8000 }).ok, true);
  assert.deepEqual(actions.hqStart(c.uid, { category: 'district', option: 'discover' }), { ok: true });
  assert.equal(frags(), 3 - 2 * H.fragmentCost, 'a switch is a commitment too');
  v = viewFor(c.uid).hq;
  assert.equal(v.cur.option, 'discover');
  assert.deepEqual(v.cur.got, { building_materials: 1000 }, 'machined parts are not on the new bill, so they are gone');
  // abandon: nothing comes back
  const bm = stock(c, c.core, 'building_materials');
  assert.deepEqual(actions.hqAbort(c.uid, {}), { ok: true });
  assert.equal(stock(c, c.core, 'building_materials'), bm);
  assert.equal(viewFor(c.uid).hq.cur, null);
  // every paid unlock raises the next bill and the next wait, whatever the category
  db.prepare('UPDATE colonies SET data_fragments = 10 WHERE id = ?').run(c.id);
  unlock(c, 'surface', 'route');
  assert.equal(hqRow(c).unlocks, 1);
  assert.deepEqual(actions.hqStart(c.uid, { category: 'station', option: 'orbitalLink' }), { ok: true });
  v = viewFor(c.uid).hq;
  assert.equal(v.cur.need.circuits, Math.round(H.categories.station.cost.circuits * H.costMult));
  assert.equal(v.cur.ticks, Math.round(H.baseTicks * H.timeMult));
  assert.deepEqual(hq.billFor('surface', 3).machined_parts, Math.round(H.categories.surface.cost.machined_parts * H.costMult ** 3));
  // a free unlock applies at once, without a bill, and does not move the counter
  db.prepare('UPDATE colony_hq SET free = 1 WHERE colony_id = ?').run(c.id);
  const f0 = frags();
  assert.deepEqual(actions.hqStart(c.uid, { category: 'surface', option: 'linkBoost', free: true }), { ok: true });
  assert.equal(frags(), f0, 'a free unlock takes no fragment');
  assert.equal(hqRow(c).free, 0);
  assert.equal(hqRow(c).unlocks, 1);
  assert.equal(perks.linkBonus(c.id), H.categories.surface.options.linkBoost.amount);
  assert.equal(JSON.parse(hqRow(c).cur).opt, 'orbitalLink', 'the unlock under way is untouched');
});

test('surface unlocks: one more standing route, and +50 on every district link whatever its level', () => {
  const c = chartered('Road Works');
  const pits = Number(db.prepare("INSERT INTO districts (colony_id, type, level, name, created_tick) VALUES (?, 'pits', 4, 'The Pits', 0)").run(c.id).lastInsertRowid);
  store.saveInventory(c.id, Object.fromEntries(Object.keys(config.resources).map((r) => [r, 100])), pits);
  const cap = (id) => viewFor(c.uid).districts.find((d) => d.id === id).link.capacity;
  const base = cap(pits);
  unlock(c, 'surface', 'linkBoost');
  assert.equal(cap(pits), base + 50);
  assert.equal(cap(c.fp), Math.floor(config.logistics.link.levels[1].capacity) + 50, 'every link, at any level');
  assert.deepEqual(actions.setRoute(c.uid, { from: c.core, to: pits, resource: 'scrap', rate: base + 50, reserve: 0 }), { ok: true });
  // the route limit: fill it, then one more fits after the unlock
  const L = config.logistics.maxRoutes;
  const ins = db.prepare('INSERT INTO colony_routes (colony_id, from_district, to_district, resource_id, rate, reserve) VALUES (?, ?, ?, ?, 0, 0)');
  const res = Object.keys(config.resources);
  for (let i = 1; i < L; i++) ins.run(c.id, i % 2 ? c.fp : pits, i % 2 ? pits : c.fp, res[i]);
  assert.match(actions.setRoute(c.uid, { from: c.core, to: c.fp, resource: 'ore', rate: 1, reserve: 0 }).error, /At most/);
  unlock(c, 'surface', 'route');
  assert.deepEqual(actions.setRoute(c.uid, { from: c.core, to: c.fp, resource: 'ore', rate: 1, reserve: 0 }), { ok: true });
  assert.equal(viewFor(c.uid).maxRoutes, L + 1);
});

test('station unlocks: an orbital link, a dropship bay, and a level-4 refit that cannot be destroyed', () => {
  const c = chartered('Dock Nine');
  const did = c.station.district_id;
  const route = (resource) => actions.setRoute(c.uid, { from: c.core, to: did, resource, rate: 5, reserve: 0 });
  for (const r of ['frames', 'fittings', 'power_cells', 'modules']) assert.equal(route(r).ok, true, r);
  assert.match(route('alloys').error, /all in use/);
  unlock(c, 'station', 'orbitalLink');
  assert.equal(viewFor(c.uid).orbital.station.links.count, O.links.levels['1'].count + 1);
  // (a fifth slot is free in storage for it)
  assert.deepEqual(route('alloys'), { ok: true });
  // a dropship bay: one more can be built than the station would otherwise hold
  const inv = store.loadInventory(c.id, did);
  for (const r of Object.keys(O.dropships.buildCost)) if (r !== 'credits') inv[r] = O.dropships.buildCost[r] * 4;
  store.saveInventory(c.id, inv, did);
  for (let i = 1; i < O.dropships.max; i++) db.prepare("INSERT INTO dropships (colony_id, num, level, integrity, state) VALUES (?, ?, 1, 100, 'docked')").run(c.id, i + 1);
  assert.match(actions.shipBuild(c.uid).error, /at most/);
  unlock(c, 'station', 'dropship');
  assert.equal(viewFor(c.uid).orbital.ships.max, O.dropships.max + 1);
  assert.deepEqual(actions.shipBuild(c.uid), { ok: true });
  // level 4: no ship at level 3 yet, so the option is closed
  assert.match(actions.hqStart(c.uid, { category: 'station', option: 'shipL4', ship: territories.shipsOf(c.id)[0].id }).error, /level 3/);
  assert.ok(viewFor(c.uid).hq.categories.find((k) => k.key === 'station').options.find((o) => o.key === 'shipL4').blocked);
  const ship = territories.shipsOf(c.id)[0];
  db.prepare('UPDATE dropships SET level = 3 WHERE id = ?').run(ship.id);
  assert.match(actions.shipUpgrade(c.uid, { ship: ship.id }).error, /fully upgraded/, 'level 4 is never bought the ordinary way');
  unlock(c, 'station', 'shipL4', { ship: ship.id });
  const s4 = db.prepare('SELECT * FROM dropships WHERE id = ?').get(ship.id);
  assert.equal(s4.level, 4);
  const sv = viewFor(c.uid).orbital.ships.ships.find((x) => x.id === ship.id);
  assert.equal(sv.power, O.dropships.levels['4'].power);
  assert.equal(sv.hold, O.dropships.levels['4'].hold);
  assert.equal(sv.unbreakable, true);
  // it has already been saved once and is nearly gone, and still comes home (without its cargo)
  db.prepare('UPDATE dropships SET saved_once = 1, integrity = 1 WHERE id = ?').run(ship.id);
  const t = db.prepare('SELECT * FROM territories WHERE taken_by IS NULL AND stabilized = 0 AND owner_colony IS NULL AND closes_tick > ? ORDER BY closes_tick DESC LIMIT 1').get(now() + 100);
  assert.deepEqual(actions.shipDeploy(c.uid, { ship: ship.id, territory: t.id }), { ok: true });
  tick(O.dropships.deployTicks);
  db.prepare('UPDATE territories SET closes_tick = ? WHERE id = ?').run(now() + 1, t.id);
  tick(1);
  const back = db.prepare('SELECT * FROM dropships WHERE id = ?').get(ship.id);
  assert.ok(back, 'never destroyed');
  assert.equal(back.integrity, O.dropships.savedIntegrity);
  assert.deepEqual(JSON.parse(back.cargo), {});
});

test('high-capacity storage slots: ten times the cap, goods move in and out, an empty one takes anything, never jettisoned', () => {
  const c = chartered('Deep Hold');
  const did = c.station.district_id;
  unlock(c, 'station', 'hcSlot');
  const cap = O.storage.levels['1'].cap;
  const hc = () => orbital.slots(c.id).find((s) => s.kind === 'hc');
  assert.ok(hc(), 'the slot exists');
  assert.equal(viewFor(c.uid).orbital.station.storage.hcCap, cap * 10);
  // frames are in an ordinary slot from the starter kit: move them over and they can grow past the ordinary cap
  assert.deepEqual(actions.slotMove(c.uid, { resource: 'frames', to: 'hc' }), { ok: true });
  assert.equal(hc().resource, 'frames');
  setStock(c, did, 'frames', cap * 3);
  tick(1);
  assert.equal(stock(c, did, 'frames'), cap * 3, 'kept above the ordinary cap');
  setStock(c, did, 'frames', cap * 20);
  tick(1);
  assert.equal(stock(c, did, 'frames'), cap * 10, 'but not above its own');
  // a link fills it past the ordinary cap too
  assert.deepEqual(actions.setRoute(c.uid, { from: c.core, to: did, resource: 'frames', rate: 10, reserve: 0 }), { ok: true });
  setStock(c, did, 'frames', cap * 2);
  tick(1);
  assert.ok(stock(c, did, 'frames') > cap * 2, 'the link keeps delivering into it');
  assert.match(actions.slotMove(c.uid, { resource: 'frames', to: 'normal' }).error, /would be lost/, 'too much for an ordinary slot, until confirmed');
  const before = stock(c, did, 'frames');
  assert.ok(before > cap);
  assert.deepEqual(actions.slotMove(c.uid, { resource: 'frames', to: 'normal', confirm: true }), { ok: true });
  assert.equal(stock(c, did, 'frames'), cap, 'the surplus is forfeited');
  assert.equal(hc().resource, null);
  assert.deepEqual(actions.slotMove(c.uid, { resource: 'frames', to: 'hc' }), { ok: true });
  assert.match(actions.jettison(c.uid, { slot: hc().idx }).error, /never jettisoned/);
  assert.match(actions.slotRelease(c.uid, { slot: hc().idx }).error, /Empty/);
  actions.setRoute(c.uid, { from: c.core, to: did, resource: 'frames', rate: 0 });
  setStock(c, did, 'frames', 0);
  assert.deepEqual(actions.slotRelease(c.uid, { slot: hc().idx }), { ok: true });
  assert.equal(hc().resource, null, 'free for anything');
});

test('districts: the first discovery is a Free Port copy, then random but never the same twice; founding uses the usual costs, further out', () => {
  const c = chartered('Map Room');
  unlock(c, 'district', 'discover');
  let list = viewFor(c.uid).discoveries;
  assert.equal(list.length, 1);
  assert.equal(list[0].type, 'freeport');
  assert.notEqual(list[0].name, config.districtTypes.freeport.name, 'it has a name of its own');
  assert.equal(list[0].distance, config.districtTypes.freeport.distance + H.categories.district.extraDistance);
  assert.equal(list[0].districtId, null, 'listed, not founded');
  for (let i = 0; i < 6; i++) hq.discover(c, now());
  list = viewFor(c.uid).discoveries;
  for (let i = 1; i < list.length; i++) assert.notEqual(list[i].type, list[i - 1].type, 'never the same type twice in a row');
  assert.equal(new Set(list.map((d) => d.name)).size, list.length, 'every name differs');
  // found the Free Port copy: the Core pays the Free Port's founding cost and a second Free Port appears
  const d = list[0];
  for (const [r, q] of Object.entries(config.districtTypes.freeport.foundCost)) setStock(c, c.core, r, q * 2);
  const before = stock(c, c.core, 'alloys');
  assert.deepEqual(actions.foundDistrict(c.uid, { discovery: d.id }), { ok: true });
  assert.equal(stock(c, c.core, 'alloys'), before - config.districtTypes.freeport.foundCost.alloys, 'the Free Port\'s own founding cost');
  assert.match(actions.foundDistrict(c.uid, { discovery: d.id }).error, /already being founded/);
  tick(config.districtTypes.freeport.foundTicks + 1);
  const ds = viewFor(c.uid).districts.filter((x) => x.type === 'freeport');
  assert.equal(ds.length, 2);
  const copy = ds.find((x) => x.discovery === d.id);
  assert.equal(copy.name, d.name);
  assert.equal(copy.distance, d.distance);
  assert.match(actions.foundDistrict(c.uid, { discovery: d.id }).error, /already founded/);
  // a shipment there takes the longer trip
  assert.deepEqual(actions.shipment(c.uid, { from: c.core, to: copy.id, resource: 'scrap', qty: 10 }), { ok: true });
  const sh = store.loadShipments(c.id).find((x) => x.toDistrict === copy.id);
  assert.equal(sh.arrivesTick - now(), d.distance);
  // the original Free Port is still the original, and founding it again is still refused
  assert.match(actions.foundDistrict(c.uid, { type: 'freeport' }).error, /already founded/);
});

test('territory equipment: a stabilizer stretches a territory, stops its harm, keeps it from destabilising and opens it to everyone', () => {
  const a = chartered('First Down');
  const b = launched('Second Down');
  unlock(a, 'territory', 'stabilizer');
  const t = db.prepare("SELECT * FROM territories WHERE taken_by IS NULL AND stabilized = 0 AND owner_colony IS NULL AND closes_tick > ? ORDER BY closes_tick DESC LIMIT 1").get(now() + 400);
  db.prepare("UPDATE territories SET anomaly = 'shear' WHERE id = ?").run(t.id);
  const shipA = territories.shipsOf(a.id)[0]; const shipB = territories.shipsOf(b.id)[0];
  assert.match(actions.shipDeploy(b.uid, { ship: shipB.id, territory: t.id, stabilize: true }).error, /no territory stabilizer/);
  assert.deepEqual(actions.shipDeploy(a.uid, { ship: shipA.id, territory: t.id, stabilize: true }), { ok: true });
  assert.equal(viewFor(a.uid).orbital.ships.stabilizers[0], H.categories.territory.options.stabilizer.cooldownTicks, 'it cools down from the moment it goes out');
  tick(O.dropships.deployTicks);
  const st = db.prepare('SELECT * FROM territories WHERE id = ?').get(t.id);
  assert.equal(st.stabilized, 1);
  const left0 = t.closes_tick - (now() - 1);
  assert.ok(st.closes_tick - now() > left0 * 90, 'about a hundred times as long');
  // shear's damage has stopped; its rare bonus stays
  const integrity = db.prepare('SELECT integrity FROM dropships WHERE id = ?').get(shipA.id).integrity;
  tick(3);
  assert.equal(db.prepare('SELECT integrity FROM dropships WHERE id = ?').get(shipA.id).integrity, integrity);
  const terr = viewFor(a.uid).orbital.ships.territories.find((x) => x.id === t.id);
  assert.equal(terr.anomaly.rareMult, O.territories.anomalies.shear.rareMult);
  assert.equal(terr.anomaly.damagePerTick, 0);
  // another station can land there too
  const tb = viewFor(b.uid).orbital.ships.territories.find((x) => x.id === t.id);
  assert.equal(tb.open, true);
  assert.equal(tb.stabilized, true);
  assert.deepEqual(actions.shipDeploy(b.uid, { ship: shipB.id, territory: t.id }), { ok: true });
  tick(O.dropships.deployTicks);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM districts WHERE type = 'territory' AND territory_id = ?").get(t.id).n, 2);
  // leaving never destabilises it, and the other station stays down there
  const closes = db.prepare('SELECT closes_tick FROM territories WHERE id = ?').get(t.id).closes_tick;
  assert.deepEqual(actions.shipReturn(a.uid, { ship: shipA.id }), { ok: true });
  const after = db.prepare('SELECT * FROM territories WHERE id = ?').get(t.id);
  assert.equal(after.closes_tick, closes);
  assert.equal(after.destabilized, 0);
  assert.equal(after.taken_by, b.id);
  // the stabilizer is not ready again until its cooldown has passed
  tick(O.dropships.returnTicks);
  const t2 = db.prepare("SELECT * FROM territories WHERE taken_by IS NULL AND stabilized = 0 AND owner_colony IS NULL AND closes_tick > ? ORDER BY closes_tick DESC LIMIT 1").get(now() + 400);
  assert.match(actions.shipDeploy(a.uid, { ship: shipA.id, territory: t2.id, stabilize: true }).error, /cooling down/);
});

test('territory equipment: the finder makes a private, very long, always-extractable territory; link kits add links and come home', () => {
  const a = chartered('Lone Find');
  const b = launched('Onlooker');
  unlock(a, 'territory', 'finder');
  const mine = db.prepare('SELECT * FROM territories WHERE owner_colony = ?').get(a.id);
  assert.ok(mine);
  const res = JSON.parse(mine.resources);
  assert.ok(territories.extractable([res.common1, res.common2, res.district]).includes(res.rare), 'its ground can extract its rare');
  assert.equal(mine.data_site, 0);
  assert.equal(mine.anomaly, 'stable');
  assert.ok(mine.closes_tick - now() > territories.meanLifetime() * 400, 'open for a very long time');
  assert.ok(viewFor(a.uid).orbital.ships.territories.some((x) => x.id === mine.id && x.private && x.open));
  assert.equal(viewFor(b.uid).orbital.ships.territories.some((x) => x.id === mine.id), false, 'nobody else sees it');
  assert.match(actions.shipDeploy(b.uid, { ship: territories.shipsOf(b.id)[0].id, territory: mine.id }).error, /closed/);
  // a link kit: one more link to the station for the ship that carries it
  unlock(a, 'territory', 'extraLink');
  const ship = territories.shipsOf(a.id)[0];
  assert.match(actions.shipDeploy(a.uid, { ship: ship.id, territory: mine.id, links: 2 }).error, /link kits/);
  assert.deepEqual(actions.shipDeploy(a.uid, { ship: ship.id, territory: mine.id, links: 1 }), { ok: true });
  assert.equal(perks.freeLinkKits(a.id), 0);
  tick(O.dropships.deployTicks);
  const land = db.prepare("SELECT * FROM districts WHERE colony_id = ? AND type = 'territory'").get(a.id);
  const sid = a.station.district_id;
  for (const r of ['machined_parts', 'building_materials', 'alloys']) {
    assert.deepEqual(actions.setRoute(a.uid, { from: sid, to: land.id, resource: r, rate: 1, reserve: 0 }), { ok: true }, r);
  }
  assert.match(actions.setRoute(a.uid, { from: sid, to: land.id, resource: 'frames', rate: 1, reserve: 0 }).error, /3 links/);
  // leaving a private territory leaves it as it was, to come back to
  const closes = db.prepare('SELECT closes_tick FROM territories WHERE id = ?').get(mine.id).closes_tick;
  assert.deepEqual(actions.shipReturn(a.uid, { ship: ship.id }), { ok: true });
  assert.equal(perks.freeLinkKits(a.id), 1, 'the kit came home');
  const after = db.prepare('SELECT * FROM territories WHERE id = ?').get(mine.id);
  assert.equal(after.closes_tick, closes);
  assert.equal(after.taken_by, null);
  tick(O.dropships.returnTicks);
  assert.deepEqual(actions.shipDeploy(a.uid, { ship: ship.id, territory: mine.id }), { ok: true }, 'back again');
});
