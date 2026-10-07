'use strict';
// The first shipped district type (The Pits): founding, building restrictions, shipments and the ore chain.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-pits-'));
process.env.DB_PATH = path.join(dir, 'pits.db');
process.env.SESSION_SECRET = 'x';
process.env.HAZARDS = 'off';
const store = require('../src/db');
const engine = require('../src/engine');
const actions = require('../src/actions');
const { viewFor } = require('../src/state');
const { db, config } = store;
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let n = 0;
function colony(coreLevel = 4) {
  const uid = Number(db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(`p${++n}`, 'x').lastInsertRowid);
  const id = store.ensureColony(uid);
  const core = store.coreId(id);
  db.prepare("UPDATE colony_inventory SET amount = 3000 WHERE district_id = ? AND resource_id IN ('clean_water','rations','scrap','building_materials','machined_parts')").run(core);
  db.prepare('UPDATE colonies SET hub_level = ? WHERE id = ?').run(coreLevel, id);
  return { uid, id, core };
}
const tick = (k = 1) => { for (let i = 0; i < k; i++) engine.processTick(); };
const pits = (id) => store.loadDistricts(id).find((d) => d.type === 'pits');
const T = config.districtTypes.pits;

test('founding needs Core level 4, pays from the Core and appears after the build time', () => {
  const early = colony(3);
  assert.match(actions.foundDistrict(early.uid, { type: 'pits' }).error, /open at hub level 4/);

  const c = colony();
  assert.equal(actions.foundDistrict(c.uid, { type: 'nope' }).error, 'Unknown district type.');
  const before = store.loadInventory(c.id, c.core).scrap;
  assert.deepEqual(actions.foundDistrict(c.uid, { type: 'pits' }), { ok: true });
  assert.equal(store.loadInventory(c.id, c.core).scrap, before - T.foundCost.scrap);
  assert.match(actions.foundDistrict(c.uid, { type: 'pits' }).error, /already founded/, 'one per type, even while building');
  assert.equal(pits(c.id), undefined);
  tick(T.foundTicks);
  const p = pits(c.id);
  assert.ok(p, 'the district exists once the order completes');
  assert.equal(p.level, 1);
  assert.equal(store.loadInventory(c.id, p.id).scrap, T.startingStock.scrap + 0);
  assert.match(actions.foundDistrict(c.uid, { type: 'pits' }).error, /already founded/);
});

test('cancelling a founding order refunds the Core in full', () => {
  const c = colony();
  const before = store.loadInventory(c.id, c.core).scrap;
  actions.foundDistrict(c.uid, { type: 'pits' });
  const o = store.loadOrders(c.id).find((x) => x.action_type === 'found');
  assert.deepEqual(actions.cancelOrder(c.uid, { orderId: o.id }), { ok: true });
  assert.equal(store.loadInventory(c.id, c.core).scrap, before);
});

test('building restrictions: pits buildings only in the Pits, the Beacon only in the Core', () => {
  const c = colony();
  actions.foundDistrict(c.uid, { type: 'pits' }); tick(T.foundTicks);
  const p = pits(c.id);
  assert.match(actions.build(c.uid, { ring: 1, slot: 0, type: 'ore_drill' }).error, /can't be built in the Core/);
  assert.deepEqual(actions.build(c.uid, { ring: 1, slot: 0, type: 'ore_drill', district: p.id }), { ok: true });
  assert.match(actions.build(c.uid, { ring: 1, slot: 1, type: 'beacon_array', district: p.id }).error, /can't be built/);
  assert.match(actions.build(c.uid, { ring: 2, slot: 0, type: 'ore_drill', district: p.id }).error, /locked/, 'ring 2 needs district level 2');
});

test('the ore chain runs on the Pits own grid and stockpile', () => {
  const c = colony();
  actions.foundDistrict(c.uid, { type: 'pits' }); tick(T.foundTicks);
  const p = pits(c.id);
  const put = (ring, slot, type) => db.prepare('INSERT INTO colony_buildings (colony_id, district_id, ring_index, slot_index, building_type) VALUES (?, ?, ?, ?, ?)').run(c.id, p.id, ring, slot, type);
  put(1, 0, 'solar_array'); put(1, 1, 'ore_drill'); put(1, 2, 'solar_array');
  const scrapCore = store.loadInventory(c.id, c.core).ore;
  tick(5);
  assert.ok(store.loadInventory(c.id, p.id).ore > 0, 'ore appears in the district');
  assert.equal(store.loadInventory(c.id, c.core).ore, scrapCore, 'and not in the Core');
});

test('shipments: stock leaves now, arrives after the trip, over-cap is lost, limits apply', () => {
  const c = colony();
  actions.foundDistrict(c.uid, { type: 'pits' }); tick(T.foundTicks);
  const p = pits(c.id);
  assert.match(actions.shipment(c.uid, { from: c.core, to: c.core, resource: 'scrap', qty: 10 }).error, /two different/);
  assert.match(actions.shipment(c.uid, { from: c.core, to: p.id, resource: 'scrap', qty: 99999 }).error, /at most/);
  assert.match(actions.shipment(c.uid, { from: p.id, to: c.core, resource: 'reagents', qty: 5 }).error, /Not enough/);
  assert.match(actions.shipment(c.uid, { from: c.core, to: 9999, resource: 'scrap', qty: 5 }).error, /Unknown district/);

  const coreBefore = store.loadInventory(c.id, c.core).scrap;
  const pitsBefore = store.loadInventory(c.id, p.id).scrap;
  assert.deepEqual(actions.shipment(c.uid, { from: c.core, to: p.id, resource: 'scrap', qty: 200 }), { ok: true });
  assert.equal(store.loadInventory(c.id, c.core).scrap, coreBefore - 200);
  assert.equal(viewFor(c.uid).shipments.length, 1);
  tick(T.distance - 1);
  assert.equal(store.loadInventory(c.id, p.id).scrap, pitsBefore, 'still on the road');
  tick(1);
  assert.equal(store.loadInventory(c.id, p.id).scrap, pitsBefore + 200);
  assert.equal(store.loadShipments(c.id).length, 0);

  // storage cap in the district
  db.prepare("UPDATE colony_inventory SET amount = ? WHERE district_id = ? AND resource_id = 'scrap'").run(T.levels[1].maxStorage - 50, p.id);
  actions.shipment(c.uid, { from: c.core, to: p.id, resource: 'scrap', qty: 200 });
  tick(T.distance);
  assert.equal(Math.floor(store.loadInventory(c.id, p.id).scrap), T.levels[1].maxStorage);

  // in-flight limit
  for (let i = 0; i < config.logistics.maxInFlight; i++) assert.deepEqual(actions.shipment(c.uid, { from: c.core, to: p.id, resource: 'scrap', qty: 1 }), { ok: true });
  assert.match(actions.shipment(c.uid, { from: c.core, to: p.id, resource: 'scrap', qty: 1 }).error, /on the road at once/);
});

test('level 3 upgrades of the Pits need reagents the district cannot make', () => {
  assert.ok(T.levels[3].upgradeCost.reagents > 0);
  assert.ok(!Object.values(config.buildings).some((b) => (b.outputsPerTick.reagents || 0) > 0), 'no building makes reagents yet: they come from the convoy');
});

test('the view carries every district with its own stock, buildings and rings', () => {
  const c = colony();
  actions.foundDistrict(c.uid, { type: 'pits' }); tick(T.foundTicks);
  const p = pits(c.id);
  const v = viewFor(c.uid);
  const pv = v.views[p.id];
  assert.ok(pv && pv.resources.scrap.amount >= 0);
  assert.equal(pv.level, 1);
  assert.equal(pv.hub.rings[1], 3);
  assert.equal(v.views[c.core].level, 4);
  assert.equal(v.resources.scrap.amount, v.views[c.core].resources.scrap.amount, 'top-level view is still the Core');
});
