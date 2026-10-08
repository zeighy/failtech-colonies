'use strict';
// Standing routes, link capacity and the restructured chain (Stacks and Greenbelt).
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-logi-'));
process.env.DB_PATH = path.join(dir, 'logi.db');
process.env.SESSION_SECRET = 'x';
process.env.HAZARDS = 'off';
const store = require('../src/db');
const engine = require('../src/engine');
const actions = require('../src/actions');
const { viewFor } = require('../src/state');
const { db, config } = store;
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let n = 0;
function colony() {
  const uid = Number(db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(`l${++n}`, 'x').lastInsertRowid);
  const id = store.ensureColony(uid);
  const core = store.coreId(id);
  db.prepare("UPDATE colony_inventory SET amount = 5000 WHERE district_id = ? AND resource_id IN ('clean_water','rations','scrap','building_materials','machined_parts','alloys')").run(core);
  db.prepare('UPDATE colonies SET hub_level = 4 WHERE id = ?').run(id);
  const found = (type) => {
    assert.deepEqual(actions.foundDistrict(uid, { type }), { ok: true });
    for (let i = 0; i < config.districtTypes[type].foundTicks; i++) engine.processTick();
    return store.loadDistricts(id).find((d) => d.type === type);
  };
  return { uid, id, core, found };
}
const tick = (k = 1) => { for (let i = 0; i < k; i++) engine.processTick(); };
const stock = (id, d, r) => store.loadInventory(id, d)[r] || 0;

test('routes: validated, capacity-limited, removable', () => {
  const c = colony();
  assert.match(actions.setRoute(c.uid, { from: c.core, to: 999, resource: 'scrap', rate: 5 }).error, /Unknown district/);
  const p = c.found('pits');
  assert.match(actions.setRoute(c.uid, { from: c.core, to: c.core, resource: 'scrap', rate: 5 }).error, /different/);
  assert.deepEqual(actions.setRoute(c.uid, { from: p.id, to: c.core, resource: 'ore', rate: 12 }), { ok: true });
  const cap = config.logistics.link.levels[1].capacity;
  assert.match(actions.setRoute(c.uid, { from: c.core, to: p.id, resource: 'scrap', rate: cap }).error, /carries \d+ per tick/);
  assert.deepEqual(actions.setRoute(c.uid, { from: c.core, to: p.id, resource: 'scrap', rate: cap - 12 }), { ok: true });
  // changing an existing route does not double count it
  assert.deepEqual(actions.setRoute(c.uid, { from: p.id, to: c.core, resource: 'ore', rate: 12, reserve: 50 }), { ok: true });
  assert.equal(store.loadRoutes(c.id).length, 2);
  assert.equal(viewFor(c.uid).districts.find((d) => d.id === p.id).link.load, cap);
  assert.deepEqual(actions.setRoute(c.uid, { from: p.id, to: c.core, resource: 'ore', rate: 0 }), { ok: true });
  assert.equal(store.loadRoutes(c.id).length, 1);
});

test('a route moves goods every tick, keeps the reserve, and the goods arrive after the trip', () => {
  const c = colony();
  const p = c.found('pits');
  db.prepare("UPDATE colony_inventory SET amount = 100 WHERE district_id = ? AND resource_id = 'ingots'").run(p.id);
  actions.setRoute(c.uid, { from: p.id, to: c.core, resource: 'ingots', rate: 20, reserve: 70 });
  const before = stock(c.id, c.core, 'ingots');
  tick(1);
  assert.equal(stock(c.id, p.id, 'ingots'), 80, 'at most the rate leaves each tick');
  assert.equal(stock(c.id, c.core, 'ingots'), before, 'and it is on the road');
  assert.equal(store.loadShipments(c.id).filter((s) => s.routeId).length, 1);
  tick(1);
  assert.equal(stock(c.id, p.id, 'ingots'), 70, 'only what is above the reserve leaves');
  tick(config.districtTypes.pits.distance);
  assert.equal(stock(c.id, c.core, 'ingots'), before + 30);
  tick(2);
  assert.equal(stock(c.id, p.id, 'ingots'), 70, 'nothing more moves while stock sits at the reserve');
});

test('widening a link: paid from the Core, raises the capacity, stops at the top', () => {
  const c = colony();
  const p = c.found('pits');
  assert.match(actions.upgradeLink(c.uid, { district: c.core }).error, /no link/);
  const bm = stock(c.id, c.core, 'building_materials');
  assert.deepEqual(actions.upgradeLink(c.uid, { district: p.id }), { ok: true });
  assert.equal(stock(c.id, c.core, 'building_materials'), bm - config.logistics.link.levels[2].upgradeCost.building_materials);
  assert.equal(viewFor(c.uid).districts.find((d) => d.id === p.id).link.capacity, config.logistics.link.levels[2].capacity);
  db.prepare('UPDATE colony_inventory SET amount = 99999 WHERE district_id = ?').run(c.core);
  assert.deepEqual(actions.upgradeLink(c.uid, { district: p.id }), { ok: true });
  assert.deepEqual(actions.upgradeLink(c.uid, { district: p.id }), { ok: true });
  assert.match(actions.upgradeLink(c.uid, { district: p.id }).error, /maximum/);
});

test('manual shipments are limited separately from the shipments routes send', () => {
  const c = colony();
  const p = c.found('pits');
  actions.setRoute(c.uid, { from: c.core, to: p.id, resource: 'scrap', rate: 10 });
  tick(3);
  assert.ok(store.loadShipments(c.id).filter((s) => s.routeId).length >= 3);
  assert.deepEqual(actions.shipment(c.uid, { from: c.core, to: p.id, resource: 'scrap', qty: 5 }), { ok: true });
});

test('the restructured chain: synthetics, circuits and cells only in the Stacks; the Beacon needs medicine from the Greenbelt', () => {
  for (const k of ['synth_reclaimer', 'circuit_fab', 'cell_forge']) assert.deepEqual(config.buildings[k].districts, ['stacks']);
  assert.ok(config.buildings.beacon_array.cost.medicine > 0);
  const c = colony();
  assert.match(actions.build(c.uid, { ring: 1, slot: 0, type: 'circuit_fab' }).error, /can't be built in the Core/);
  const s = c.found('stacks');
  assert.deepEqual(actions.build(c.uid, { ring: 1, slot: 0, type: 'crude_pump', district: s.id }), { ok: true });
  assert.match(actions.build(c.uid, { ring: 1, slot: 1, type: 'bio_dome', district: s.id }).error, /can't be built/);
  const g = c.found('greenbelt');
  assert.deepEqual(actions.build(c.uid, { ring: 1, slot: 0, type: 'bio_dome', district: g.id }), { ok: true });
  assert.match(actions.build(c.uid, { ring: 1, slot: 1, type: 'crude_pump', district: g.id }).error, /can't be built/);
});

test('the Stacks turn crude into reagents, fuel and polymers on their own grid', () => {
  const c = colony();
  const s = c.found('stacks');
  const put = (ring, slot, type) => db.prepare('INSERT INTO colony_buildings (colony_id, district_id, ring_index, slot_index, building_type) VALUES (?, ?, ?, ?, ?)').run(c.id, s.id, ring, slot, type);
  put(1, 0, 'solar_array'); put(1, 1, 'crude_pump'); put(1, 2, 'cracking_tower');
  db.prepare('UPDATE districts SET level = 2 WHERE id = ?').run(s.id);
  tick(8);
  assert.ok(stock(c.id, s.id, 'crude') > 0 || stock(c.id, s.id, 'reagents') > 0);
  assert.ok(stock(c.id, s.id, 'reagents') > 0, 'reagents appear');
  assert.ok(stock(c.id, s.id, 'fuel') > 0, 'and fuel');
  assert.equal(stock(c.id, c.core, 'reagents'), 0, 'in the Stacks, not the Core');
});
