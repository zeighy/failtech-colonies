'use strict';
// The work queue: one build slot per place, strict order, paid for when an order starts. Replacing a building in place.
// Route targets.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-queue-'));
process.env.DB_PATH = path.join(dir, 'queue.db');
process.env.SESSION_SECRET = 'x';
process.env.THEME = 'basic';
process.env.HAZARDS = 'off';
const store = require('../src/db');
const engine = require('../src/engine');
const actions = require('../src/actions');
const queue = require('../src/queue');
const sim = require('../src/sim');
const { viewFor } = require('../src/state');
const { db, config } = store;
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const B = config.buildings;
const tick = (k = 1) => { for (let i = 0; i < k; i++) engine.processTick(); };
let n = 0;
// A colony at a given hub level with plenty of everything (and enough power and people not to matter).
function colony(level = 3, amount = 5000) {
  const uid = Number(db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(`q${++n}`, 'x').lastInsertRowid);
  const id = store.ensureColony(uid);
  const core = store.coreId(id);
  db.prepare('UPDATE colonies SET hub_level = ?, credits = 100000 WHERE id = ?').run(level, id);
  const inv = {}; for (const r of Object.keys(config.resources)) inv[r] = amount;
  store.saveInventory(id, inv, core);
  return { uid, id, core };
}
function district(c, type, level = 2, amount = 5000) {
  const d = Number(db.prepare('INSERT INTO districts (colony_id, type, level, name, created_tick) VALUES (?, ?, ?, ?, 0)').run(c.id, type, level, type).lastInsertRowid);
  const inv = {}; for (const r of Object.keys(config.resources)) inv[r] = amount;
  store.saveInventory(c.id, inv, d);
  return d;
}
const stock = (c, r, d) => store.loadInventory(c.id, d || c.core)[r] || 0;
const setStock = (c, r, a, d) => db.prepare('UPDATE colony_inventory SET amount = ? WHERE district_id = ? AND resource_id = ?').run(a, d || c.core, r);
const orders = (c, d) => store.loadOrders(c.id, d || c.core);
const built = (c, d) => store.loadBuildings(c.id, d || c.core);
const put = (c, ring, slot, type, d) => db.prepare('INSERT INTO colony_buildings (colony_id, district_id, ring_index, slot_index, building_type) VALUES (?, ?, ?, ?, ?)').run(c.id, d || c.core, ring, slot, type);
const QUEUED = { ok: true, queued: true };

test('one build slot per place: the first order starts and is paid for, the rest wait their turn and cost nothing yet', () => {
  const c = colony();
  const scrap = stock(c, 'scrap');
  assert.deepEqual(actions.build(c.uid, { ring: 1, slot: 0, type: 'solar_array' }), { ok: true });
  assert.deepEqual(actions.build(c.uid, { ring: 1, slot: 1, type: 'water_pump' }), QUEUED);
  assert.deepEqual(actions.build(c.uid, { ring: 1, slot: 2, type: 'scrap_extractor' }), QUEUED);
  assert.deepEqual(orders(c).map((o) => [o.data.type, o.state]), [['solar_array', 'active'], ['water_pump', 'queued'], ['scrap_extractor', 'queued']]);
  assert.equal(stock(c, 'scrap'), scrap - B.solar_array.cost.scrap, 'only the order under way has been paid for');
  // they are built one after another: the whole lot takes the sum of the three build times
  const times = [B.solar_array, B.water_pump, B.scrap_extractor].map((b) => b.constructionTicks);
  tick(times[0]);
  assert.deepEqual(built(c).map((b) => b.type), ['solar_array']);
  assert.deepEqual(orders(c).map((o) => [o.data.type, o.state]), [['water_pump', 'active'], ['scrap_extractor', 'queued']], 'the next starts on the tick the slot comes free');
  tick(times[1]);
  assert.deepEqual(built(c).map((b) => b.type).sort(), ['solar_array', 'water_pump']);
  tick(times[2] - 1);
  assert.equal(built(c).length, 2);
  tick(1);
  assert.equal(built(c).length, 3);
  assert.equal(orders(c).length, 0);
});

test('every place has its own queue: a district builds while the Core builds', () => {
  const c = colony(4);
  const pits = district(c, 'pits');
  assert.deepEqual(actions.build(c.uid, { ring: 1, slot: 0, type: 'solar_array' }), { ok: true });
  assert.deepEqual(actions.build(c.uid, { ring: 1, slot: 0, type: 'ore_drill', district: pits }), { ok: true }, 'the Core being busy does not hold the district up');
  assert.deepEqual(actions.build(c.uid, { ring: 1, slot: 1, type: 'ore_drill', district: pits }), QUEUED);
  assert.equal(orders(c, pits).length, 2);
  assert.equal(orders(c).length, 1);
  tick(B.ore_drill.constructionTicks);
  assert.equal(built(c, pits).length, 1);
  assert.equal(orders(c, pits)[0].state, 'active');
});

test('strict order: the front of the queue waits for its materials, and nothing behind it starts even if it could be paid for', () => {
  const c = colony(2, 3000); // (a hub with no upkeep, and stock under its storage cap, so nothing but the queue moves it)
  setStock(c, 'machined_parts', 0);
  // the front order needs parts the colony does not have; the one behind it needs only scrap, which it has
  assert.deepEqual(actions.build(c.uid, { ring: 1, slot: 0, type: 'water_purifier' }), QUEUED);
  assert.deepEqual(actions.build(c.uid, { ring: 1, slot: 1, type: 'solar_array' }), QUEUED);
  const scrap = stock(c, 'scrap');
  tick(5);
  assert.deepEqual(orders(c).map((o) => o.state), ['queued', 'queued'], 'the affordable order does not jump the queue');
  assert.equal(built(c).length, 0);
  assert.equal(stock(c, 'scrap'), scrap, 'and nothing has been spent');
  const v = viewFor(c.uid).orders;
  assert.deepEqual(v[0].waiting.short, { machined_parts: B.water_purifier.cost.machined_parts }, 'the view says what the front order is waiting for');
  assert.equal(v[1].waiting, undefined);
  assert.deepEqual(v.map((o) => o.pos), [1, 2]);
  // the parts arrive: the front order starts on the next tick and is charged then
  setStock(c, 'machined_parts', 50);
  tick(1);
  assert.deepEqual(orders(c).map((o) => o.state), ['active', 'queued']);
  assert.equal(stock(c, 'machined_parts'), 50 - B.water_purifier.cost.machined_parts);
  tick(B.water_purifier.constructionTicks + B.solar_array.constructionTicks);
  assert.deepEqual(built(c).map((b) => b.type).sort(), ['solar_array', 'water_purifier']);
});

test('cancelling: an order under way is refunded in full and the next starts; one still waiting cost nothing', () => {
  const c = colony();
  const scrap = stock(c, 'scrap');
  actions.build(c.uid, { ring: 1, slot: 0, type: 'solar_array' });
  actions.build(c.uid, { ring: 1, slot: 1, type: 'water_pump' });
  actions.build(c.uid, { ring: 1, slot: 2, type: 'scrap_extractor' });
  const [a, b] = orders(c);
  assert.deepEqual(actions.cancelOrder(c.uid, { orderId: b.id }), { ok: true });
  assert.equal(stock(c, 'scrap'), scrap - B.solar_array.cost.scrap, 'cancelling a waiting order moves no stock');
  assert.deepEqual(actions.cancelOrder(c.uid, { orderId: a.id }), { ok: true });
  assert.deepEqual(orders(c).map((o) => [o.data.type, o.state]), [['scrap_extractor', 'active']], 'the slot came free, so the next order started at once');
  assert.equal(stock(c, 'scrap'), scrap - B.scrap_extractor.cost.scrap, 'the cancelled order was refunded in full, and the new one paid for');
  assert.deepEqual(actions.build(c.uid, { ring: 1, slot: 0, type: 'solar_array' }), QUEUED, 'the cancelled plots are free again');
});

test('reordering: a waiting order can move up, down or to the front, but never ahead of the order under way', () => {
  const c = colony();
  for (const [slot, type] of [[0, 'solar_array'], [1, 'water_pump'], [2, 'scrap_extractor'], [3, 'dormitory']]) actions.build(c.uid, { ring: 1, slot, type });
  const names = () => orders(c).map((o) => o.data.type);
  const id = (type) => orders(c).find((o) => o.data.type === type).id;
  assert.deepEqual(names(), ['solar_array', 'water_pump', 'scrap_extractor', 'dormitory']);
  assert.deepEqual(actions.queueMove(c.uid, { orderId: id('dormitory'), to: 'top' }), { ok: true });
  assert.deepEqual(names(), ['solar_array', 'dormitory', 'water_pump', 'scrap_extractor']);
  assert.deepEqual(actions.queueMove(c.uid, { orderId: id('dormitory'), to: 'down' }), { ok: true });
  assert.deepEqual(names(), ['solar_array', 'water_pump', 'dormitory', 'scrap_extractor']);
  assert.deepEqual(actions.queueMove(c.uid, { orderId: id('scrap_extractor'), to: 'up' }), { ok: true });
  assert.deepEqual(names(), ['solar_array', 'water_pump', 'scrap_extractor', 'dormitory']);
  assert.deepEqual(actions.queueMove(c.uid, { orderId: id('water_pump'), to: 'up' }), { ok: true });
  assert.deepEqual(names(), ['solar_array', 'water_pump', 'scrap_extractor', 'dormitory'], 'the front of the queue has nowhere to go');
  assert.match(actions.queueMove(c.uid, { orderId: id('solar_array'), to: 'down' }).error, /already under way/);
  assert.match(actions.queueMove(c.uid, { orderId: 999999, to: 'up' }).error, /no longer exists/);
  assert.match(actions.queueMove(c.uid, { orderId: id('dormitory'), to: 'sideways' }).error, /Bad move/);
  // and the new order is the order they are built in
  tick(B.solar_array.constructionTicks + 1);
  assert.equal(orders(c)[0].data.type, 'water_pump');
  // another colony cannot move this one's orders
  const other = colony();
  assert.match(actions.queueMove(other.uid, { orderId: id('dormitory'), to: 'top' }).error, /no longer exists/);
});

test('a place holds only so many orders, and each plot only one', () => {
  const c = colony(3);
  const caps = sim.levelDef(config, 'core', 3).ringCapacities;
  const plots = [];
  for (const r of Object.keys(caps)) for (let s = 0; s < caps[r]; s++) plots.push([Number(r), s]);
  for (let i = 0; i < queue.max; i++) assert.equal(actions.build(c.uid, { ring: plots[i][0], slot: plots[i][1], type: 'solar_array' }).ok, true);
  const more = plots[queue.max];
  assert.match(actions.build(c.uid, { ring: more[0], slot: more[1], type: 'solar_array' }).error, /queue in the Core is full/);
  assert.match(actions.upgradeHub(c.uid, {}).error, /queue in the Core is full/);
  assert.match(actions.build(c.uid, { ring: plots[1][0], slot: plots[1][1], type: 'water_pump' }).error, /already in use/, 'a queued order reserves its plot');
  assert.equal(viewFor(c.uid).views[c.core].queueMax, queue.max);
});

test('an order that can no longer be carried out when its turn comes is dropped with a note, and the next one starts', () => {
  const c = colony();
  actions.build(c.uid, { ring: 1, slot: 0, type: 'solar_array' });
  actions.build(c.uid, { ring: 1, slot: 1, type: 'water_pump' });
  actions.build(c.uid, { ring: 1, slot: 2, type: 'scrap_extractor' });
  put(c, 1, 1, 'dormitory'); // something else ends up on the queued plot
  tick(B.solar_array.constructionTicks);
  assert.deepEqual(orders(c).map((o) => [o.data.type, o.state]), [['scrap_extractor', 'active']]);
  const note = db.prepare("SELECT message FROM colony_events WHERE colony_id = ? AND kind = 'warn' ORDER BY id DESC LIMIT 1").get(c.id).message;
  assert.match(note, /taken off the work queue: the plot is no longer free/);
});

test('upgrades, expansions and founding a district wait in the same line as buildings', () => {
  const c = colony(4, 7000);
  put(c, 1, 5, 'hydroponics_bay');
  assert.deepEqual(actions.build(c.uid, { ring: 1, slot: 0, type: 'solar_array' }), { ok: true });
  assert.deepEqual(actions.upgradeHub(c.uid, {}), QUEUED);
  assert.deepEqual(actions.expand(c.uid, { ring: 1, slot: 5 }), QUEUED);
  assert.deepEqual(actions.foundDistrict(c.uid, { type: 'pits' }), QUEUED);
  assert.deepEqual(orders(c).map((o) => [o.action_type, o.state]), [['build', 'active'], ['upgrade', 'queued'], ['expand', 'queued'], ['found', 'queued']]);
  assert.match(actions.upgradeHub(c.uid, {}).error, /already underway/);
  assert.match(actions.expand(c.uid, { ring: 1, slot: 5 }).error, /already underway/);
  assert.match(actions.foundDistrict(c.uid, { type: 'pits' }).error, /already founded/);
  assert.equal(viewFor(c.uid).founding[0].queued, true);
  const alloys = stock(c, 'alloys');
  tick(B.solar_array.constructionTicks);
  assert.equal(orders(c)[0].action_type, 'upgrade');
  assert.equal(orders(c)[0].state, 'active');
  const paid = alloys - stock(c, 'alloys') - (config.hubLevels['4'].upkeepPerTick.alloys || 0) * B.solar_array.constructionTicks;
  assert.ok(Math.abs(paid - config.hubLevels['5'].upgradeCost.alloys) <= 1, `the upgrade is paid for when it starts (${paid})`);
  tick(config.hubLevels['5'].upgradeTicks + config.expansion.ticks[2] + config.districtTypes.pits.foundTicks);
  assert.equal(db.prepare('SELECT hub_level FROM colonies WHERE id = ?').get(c.id).hub_level, 5);
  assert.equal(db.prepare('SELECT level FROM colony_buildings WHERE district_id = ? AND ring_index = 1 AND slot_index = 5').get(c.core).level, 2);
  assert.ok(store.loadDistricts(c.id).some((d) => d.type === 'pits'), 'the district was founded last, in its turn');
  assert.equal(orders(c).length, 0);
});

test('orders from before the queue keep running side by side, and hold the build slot until they are done', () => {
  const c = colony();
  // two orders as an older server left them: no state, no position
  const ins = db.prepare('INSERT INTO colony_work_orders (colony_id, district_id, action_type, target_data, ticks_remaining, ticks_total) VALUES (?, ?, ?, ?, ?, ?)');
  ins.run(c.id, c.core, 'build', JSON.stringify({ ring: 1, slot: 0, type: 'solar_array' }), 2, 2);
  ins.run(c.id, c.core, 'build', JSON.stringify({ ring: 1, slot: 1, type: 'water_pump' }), 3, 3);
  assert.deepEqual(orders(c).map((o) => o.state), ['active', 'active']);
  assert.deepEqual(actions.build(c.uid, { ring: 1, slot: 2, type: 'scrap_extractor' }), QUEUED);
  tick(2);
  assert.deepEqual(built(c).map((b) => b.type), ['solar_array']);
  assert.equal(orders(c).find((o) => o.data.type === 'scrap_extractor').state, 'queued', 'one of them is still under way');
  tick(1);
  assert.deepEqual(built(c).map((b) => b.type).sort(), ['solar_array', 'water_pump']);
  assert.equal(orders(c)[0].state, 'active');
});

test('replace in place: the old building works until its turn, is scrapped for the usual refund, and the plot stands empty for 1.5x the build time', () => {
  const c = colony();
  put(c, 1, 0, 'solar_array'); put(c, 1, 1, 'solar_array');
  // behind another order, so the replacement has to wait
  assert.deepEqual(actions.build(c.uid, { ring: 1, slot: 2, type: 'water_pump' }), { ok: true });
  assert.deepEqual(actions.replace(c.uid, { ring: 1, slot: 0, type: 'scrap_extractor' }), QUEUED);
  const o = orders(c)[1];
  assert.equal(o.action_type, 'replace');
  assert.deepEqual(o.data, { ring: 1, slot: 0, type: 'scrap_extractor', from: 'solar_array' });
  assert.equal(o.ticks_total, Math.ceil(B.scrap_extractor.constructionTicks * queue.replaceTimeMult));
  assert.ok(o.ticks_total > B.scrap_extractor.constructionTicks, 'replacing takes longer than building on a free plot');
  // what it may and may not replace
  assert.match(actions.replace(c.uid, { ring: 1, slot: 1, type: 'solar_array' }).error, /stands there already/);
  assert.match(actions.replace(c.uid, { ring: 1, slot: 4, type: 'solar_array' }).error, /Nothing to replace/);
  assert.match(actions.replace(c.uid, { ring: 1, slot: 1, type: 'ore_drill' }).error, /can't be built/);
  assert.match(actions.replace(c.uid, { ring: 1, slot: 1, type: 'nope' }).error, /Unknown building/);
  assert.match(actions.replace(c.uid, { ring: 1, slot: 0, type: 'water_pump' }).error, /already queued/);
  assert.match(actions.expand(c.uid, { ring: 1, slot: 0 }).error, /queued to be replaced/);
  // until its turn the old building stands and works
  tick(B.water_pump.constructionTicks - 1);
  assert.ok(built(c).some((b) => b.ring === 1 && b.slot === 0 && b.type === 'solar_array'));
  const scrap = stock(c, 'scrap');
  tick(1); // the pump finishes; the replacement starts: the array is scrapped and the new building paid for
  assert.equal(orders(c)[0].state, 'active');
  assert.ok(!built(c).some((b) => b.ring === 1 && b.slot === 0), 'the plot stands empty while it is converted');
  const expected = scrap + Math.floor(B.solar_array.cost.scrap * config.global.demolishRefund) - B.scrap_extractor.cost.scrap;
  assert.ok(Math.abs(stock(c, 'scrap') - expected) < 1, `half the old building back, the new one paid in full (${stock(c, 'scrap')} against ${expected})`);
  assert.match(actions.build(c.uid, { ring: 1, slot: 0, type: 'dormitory' }).error, /already in use/);
  const v = viewFor(c.uid).orders[0];
  assert.equal(v.kind, 'replace');
  assert.ok(v.rush > 0, 'a replacement under way can be rushed like any other order');
  tick(o.ticks_total - 1);
  assert.ok(!built(c).some((b) => b.ring === 1 && b.slot === 0));
  tick(1);
  assert.ok(built(c).some((b) => b.ring === 1 && b.slot === 0 && b.type === 'scrap_extractor'));
});

test('replace in place: cancelling, demolishing, expansion levels and configured workshops', () => {
  const c = colony(5);
  put(c, 1, 0, 'solar_array'); put(c, 1, 1, 'solar_array');
  db.prepare('UPDATE colony_buildings SET level = 3 WHERE district_id = ? AND ring_index = 1 AND slot_index = 0').run(c.core);
  // a replacement that starts at once: cancelling it refunds the new building, but the old one is gone
  const scrap = stock(c, 'scrap');
  assert.deepEqual(actions.replace(c.uid, { ring: 1, slot: 0, type: 'scrap_extractor' }), { ok: true });
  assert.deepEqual(actions.cancelOrder(c.uid, { orderId: orders(c)[0].id }), { ok: true });
  assert.equal(stock(c, 'scrap'), scrap + Math.floor(B.solar_array.cost.scrap * config.global.demolishRefund));
  assert.ok(!built(c).some((b) => b.slot === 0), 'the scrapped building does not come back');
  // the new building starts at level 1, whatever the old one was expanded to
  assert.deepEqual(actions.build(c.uid, { ring: 1, slot: 0, type: 'solar_array' }), { ok: true });
  tick(B.solar_array.constructionTicks);
  assert.equal(db.prepare('SELECT level FROM colony_buildings WHERE district_id = ? AND ring_index = 1 AND slot_index = 0').get(c.core).level, 1);
  // demolishing a building takes its queued replacement with it
  actions.build(c.uid, { ring: 1, slot: 3, type: 'water_pump' });
  assert.deepEqual(actions.replace(c.uid, { ring: 1, slot: 1, type: 'dormitory' }), QUEUED);
  assert.deepEqual(actions.demolish(c.uid, { ring: 1, slot: 1 }), { ok: true });
  assert.ok(!orders(c).some((o) => o.action_type === 'replace'));
  // a workshop with a recipe set is scrapped the usual way, not replaced
  const fp = district(c, 'freeport', 3);
  put(c, 1, 0, 'trade_workshop', fp);
  db.prepare("UPDATE colony_buildings SET recipe = 'curios' WHERE district_id = ?").run(fp);
  assert.match(actions.replace(c.uid, { ring: 1, slot: 0, type: 'solar_array', district: fp }).error, /has a recipe set/);
  // another player's district is not this player's to replace in
  const other = colony();
  assert.match(actions.replace(other.uid, { ring: 1, slot: 0, type: 'solar_array', district: fp }).error, /Unknown district/);
});

test('routes: a target stops the flow once the destination holds that much; without one the destination is filled', () => {
  const c = colony(4);
  const pits = district(c, 'pits');
  setStock(c, 'alloys', 0, pits);
  assert.deepEqual(actions.setRoute(c.uid, { from: c.core, to: pits, resource: 'alloys', rate: 10, reserve: 0, target: 25 }), { ok: true });
  assert.equal(store.loadRoutes(c.id)[0].target, 25);
  tick(2);
  assert.equal(stock(c, 'alloys', pits), 20);
  tick(1);
  assert.equal(stock(c, 'alloys', pits), 25, 'the last tick only tops it up to the target');
  tick(3);
  assert.equal(stock(c, 'alloys', pits), 25, 'and then it stops');
  const r = viewFor(c.uid).routes[0];
  assert.equal(r.flow, 0);
  assert.equal(r.limit, 'target');
  assert.equal(r.target, 25);
  // changing the rate alone keeps the target; 0 removes it
  assert.deepEqual(actions.setRoute(c.uid, { from: c.core, to: pits, resource: 'alloys', rate: 5, reserve: 0 }), { ok: true });
  assert.equal(store.loadRoutes(c.id)[0].target, 25);
  assert.deepEqual(actions.setRoute(c.uid, { from: c.core, to: pits, resource: 'alloys', rate: 5, reserve: 0, target: 0 }), { ok: true });
  tick(2);
  assert.equal(stock(c, 'alloys', pits), 35, 'without a target it flows again');
  assert.match(actions.setRoute(c.uid, { from: c.core, to: pits, resource: 'alloys', rate: 5, target: -1 }).error, /Bad target/);
  // the pure function: a target above the storage cap is just the cap
  const bags = new Map([[1, { inv: { scrap: 500 }, cap: 1000 }], [2, { inv: { scrap: 90 }, cap: 100 }]]);
  const out = sim.applyRoutes(config, [{ fromDistrict: 1, toDistrict: 2, resource: 'scrap', rate: 50, reserve: 0, target: 400 }], bags);
  assert.equal(out[0].qty, 10);
  assert.equal(out[0].limit, 'room');
});
