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
process.env.THEME = 'basic'; // assertions use the neutral wording, whatever the default theme is
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

test('a route moves goods straight between stockpiles every tick: no trip, keeps the reserve, never overfills', () => {
  const c = colony();
  const p = c.found('pits');
  db.prepare("UPDATE colony_inventory SET amount = 100 WHERE district_id = ? AND resource_id = 'ingots'").run(p.id);
  actions.setRoute(c.uid, { from: p.id, to: c.core, resource: 'ingots', rate: 20, reserve: 70 });
  const before = stock(c.id, c.core, 'ingots');
  tick(1);
  assert.equal(stock(c.id, p.id, 'ingots'), 80, 'at most the rate leaves each tick');
  assert.equal(stock(c.id, c.core, 'ingots'), before + 20, 'and arrives in the same tick');
  tick(1);
  assert.equal(stock(c.id, p.id, 'ingots'), 70, 'only what is above the reserve leaves');
  assert.equal(stock(c.id, c.core, 'ingots'), before + 30);
  tick(2);
  assert.equal(stock(c.id, p.id, 'ingots'), 70, 'nothing more moves while stock sits at the reserve');
  assert.equal(store.loadShipments(c.id).length, 0, 'routes never create shipments');
  // a full destination takes nothing
  db.prepare("UPDATE colony_inventory SET amount = 1e9 WHERE district_id = ? AND resource_id = 'ingots'").run(p.id);
  actions.setRoute(c.uid, { from: p.id, to: c.core, resource: 'ingots', rate: 20, reserve: 0 });
  db.prepare("UPDATE colony_inventory SET amount = ? WHERE district_id = ? AND resource_id = 'ingots'").run(config.hubLevels[4].maxStorage, c.core);
  const full = stock(c.id, c.core, 'ingots');
  tick(1);
  assert.ok(stock(c.id, c.core, 'ingots') <= full + 1);
});

test('the rates a district shows include its routes: source down, destination up', () => {
  const c = colony();
  const p = c.found('pits');
  const put = (ring, slot, type) => db.prepare('INSERT INTO colony_buildings (colony_id, district_id, ring_index, slot_index, building_type) VALUES (?, ?, ?, ?, ?)').run(c.id, p.id, ring, slot, type);
  put(1, 0, 'solar_array'); put(1, 1, 'ore_drill'); put(1, 2, 'solar_array');
  tick(3);
  const before = viewFor(c.uid).views[p.id].resources.ore;
  assert.ok(before.net > 0 && before.routeOut === 0);
  actions.setRoute(c.uid, { from: p.id, to: c.core, resource: 'ore', rate: 10, reserve: 0 });
  const v = viewFor(c.uid);
  const pitsOre = v.views[p.id].resources.ore; const coreOre = v.views[c.core].resources.ore;
  assert.equal(pitsOre.routeOut, 10);
  assert.ok(Math.abs(pitsOre.net - (before.net - 10)) < 1e-6, 'the Pits show their production minus the routed amount');
  assert.equal(coreOre.routeIn, 10);
  assert.equal(coreOre.net, 10, 'and the Core shows +10 a tick');
  assert.equal(v.resources.ore.net, 10, 'the top-level (Core) view agrees');
  const r = v.routes[0];
  assert.equal(r.flow, 10);
  assert.equal(r.limit, null);
  // the next tick really does that
  const coreBefore = stock(c.id, c.core, 'ore');
  tick(1);
  assert.equal(stock(c.id, c.core, 'ore') - coreBefore, 10);
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
  const top = Math.max(...Object.keys(config.logistics.link.levels).map(Number));
  for (let l = 3; l <= top; l++) assert.deepEqual(actions.upgradeLink(c.uid, { district: p.id }), { ok: true }, `level ${l}`);
  assert.match(actions.upgradeLink(c.uid, { district: p.id }).error, /maximum/);
  assert.equal(viewFor(c.uid).districts.find((d) => d.id === p.id).link.capacity, config.logistics.link.levels[top].capacity);
});

test('links keep widening beyond 140 per tick with a straight-line growth in materials, up to a limit', () => {
  const L = config.logistics.link.levels;
  const top = Math.max(...Object.keys(L).map(Number));
  assert.ok(top >= 10 && L[top].capacity > 140);
  const trade = (l) => (L[l].upgradeCost.frames || 0);
  for (let l = 6; l <= top; l++) {
    assert.equal(L[l].capacity - L[l - 1].capacity, L[6].capacity - L[5].capacity, 'capacity grows in equal steps');
    assert.equal(trade(l) - trade(l - 1), trade(6) - trade(5), 'and so does the demand for upgrade materials');
  }
  assert.ok(L[5].upgradeCost.frames > 0 && L[5].upgradeCost.fittings > 0, 'the extra levels need Free Port goods');
  assert.ok(config.logistics.maxRoutes >= 40);
});

test('one-off shipments still work alongside routes, with all their slots free', () => {
  const c = colony();
  const p = c.found('pits');
  actions.setRoute(c.uid, { from: c.core, to: p.id, resource: 'scrap', rate: 10 });
  tick(6);
  assert.equal(store.loadShipments(c.id).length, 0);
  const max = config.logistics.maxInFlight;
  for (let i = 0; i < max; i++) assert.deepEqual(actions.shipment(c.uid, { from: c.core, to: p.id, resource: 'clean_water', qty: 1 }), { ok: true });
  assert.match(actions.shipment(c.uid, { from: c.core, to: p.id, resource: 'clean_water', qty: 1 }).error, /on the road at once/);
  tick(config.districtTypes.pits.distance);
  assert.deepEqual(actions.shipment(c.uid, { from: c.core, to: p.id, resource: 'clean_water', qty: 1 }), { ok: true });
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

test('a widened link really allows bigger routes (the check reads the district\'s current link level)', () => {
  const c = colony();
  const p = c.found('pits');
  const cap1 = config.logistics.link.levels[1].capacity; const cap2 = config.logistics.link.levels[2].capacity;
  assert.match(actions.setRoute(c.uid, { from: p.id, to: c.core, resource: 'ore', rate: cap1 + 1 }).error, /carries 20 per tick/);
  assert.deepEqual(actions.upgradeLink(c.uid, { district: p.id }), { ok: true });
  assert.deepEqual(actions.setRoute(c.uid, { from: p.id, to: c.core, resource: 'ore', rate: cap2 }), { ok: true });
  assert.match(actions.setRoute(c.uid, { from: p.id, to: c.core, resource: 'ingots', rate: 1 }).error, new RegExp(`carries ${cap2} per tick`));
});
