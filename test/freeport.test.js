'use strict';
// The Free Port: workshops with locked recipes and plot-sized batches, trade goods, shields against hazards, missions.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-fp-'));
process.env.DB_PATH = path.join(dir, 'fp.db');
process.env.SESSION_SECRET = 'x';
process.env.THEME = 'basic'; // assertions use the neutral wording, whatever the default theme is
process.env.HAZARDS = 'off';
const store = require('../src/db');
const sim = require('../src/sim');
const ms = require('../src/marketsim');
const missions = require('../src/missions');
const engine = require('../src/engine');
const actions = require('../src/actions');
const { viewFor } = require('../src/state');
const { db, config } = store;
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let n = 0;
function colony({ beacon = true, level = 5 } = {}) {
  const uid = Number(db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(`f${++n}`, 'x').lastInsertRowid);
  const id = store.ensureColony(uid);
  const core = store.coreId(id);
  db.prepare('UPDATE colonies SET hub_level = ?, credits = 100000 WHERE id = ?').run(level, id);
  db.prepare("UPDATE colony_inventory SET amount = 5000 WHERE district_id = ? AND resource_id IN ('clean_water','rations','scrap','building_materials','machined_parts','alloys')").run(core);
  if (beacon) db.prepare("INSERT INTO colony_buildings (colony_id, district_id, ring_index, slot_index, building_type) VALUES (?, ?, 5, 0, 'beacon_array')").run(id, core);
  return { uid, id, core };
}
const tick = (k = 1) => { for (let i = 0; i < k; i++) engine.processTick(); };
const tickNow = () => Number(store.getMeta('global_tick', 0));
function freeport(c) {
  assert.deepEqual(actions.foundDistrict(c.uid, { type: 'freeport' }), { ok: true });
  tick(config.districtTypes.freeport.foundTicks);
  return store.loadDistricts(c.id).find((d) => d.type === 'freeport');
}
const put = (c, d, ring, slot, type, extra = {}) => db.prepare('INSERT INTO colony_buildings (colony_id, district_id, ring_index, slot_index, building_type, recipe) VALUES (?, ?, ?, ?, ?, ?)').run(c.id, d.id, ring, slot, type, extra.recipe || null);
const stock = (c, d, r) => store.loadInventory(c.id, d.id)[r] || 0;

test('the Free Port builds anything except other districts\' base extractors and Core-only buildings; the workshop is Free Port only', () => {
  const ok = (type, d) => sim.buildableIn(config.buildings[type], d);
  for (const t of ['solar_array', 'foundry', 'smelter', 'polymer_plant', 'bio_dome', 'habitat', 'warehouse', 'trade_workshop']) assert.ok(ok(t, 'freeport'), t);
  for (const t of ['ore_drill', 'crude_pump', 'beacon_array']) assert.ok(!ok(t, 'freeport'), t);
  assert.ok(!ok('trade_workshop', 'core') && !ok('trade_workshop', 'pits'));
  assert.ok(!ok('smelter', 'core'), 'other districts keep their restrictions');
});

test('founding needs the Beacon to be built', () => {
  const c = colony({ beacon: false });
  assert.match(actions.foundDistrict(c.uid, { type: 'freeport' }).error, /once the Beacon is built/);
  assert.equal(viewFor(c.uid).foundable.freeport, false);
  const d = colony();
  assert.equal(viewFor(d.uid).foundable.freeport, true);
  const fp = freeport(d);
  assert.equal(fp.type, 'freeport');
});

test('a workshop with no recipe does nothing; the first recipe is free; it then runs and makes a trade good', () => {
  const c = colony(); const fp = freeport(c);
  db.prepare('UPDATE districts SET level = 2 WHERE id = ?').run(fp.id);
  db.prepare("UPDATE colony_inventory SET amount = 1000 WHERE district_id = ? AND resource_id IN ('ingots','scrap')").run(fp.id);
  put(c, fp, 1, 0, 'solar_array'); put(c, fp, 1, 1, 'trade_workshop');
  tick(3);
  assert.equal(stock(c, fp, 'tool_steel'), 0);
  assert.equal(viewFor(c.uid).views[fp.id].buildings.find((b) => b.type === 'trade_workshop').status, 'no_recipe');
  const cr = db.prepare('SELECT credits FROM colonies WHERE id = ?').get(c.id).credits;
  assert.deepEqual(actions.setRecipe(c.uid, { ring: 1, slot: 1, recipe: 'tool_steel', district: fp.id }), { ok: true });
  assert.equal(db.prepare('SELECT credits FROM colonies WHERE id = ?').get(c.id).credits, cr, 'the first choice is free');
  tick(4);
  assert.ok(stock(c, fp, 'tool_steel') > 0);
  assert.ok(stock(c, fp, 'ingots') < 1000);
  assert.match(actions.setRecipe(c.uid, { ring: 1, slot: 1, recipe: 'nope', district: fp.id }).error, /Unknown recipe/);
});

test('a bigger plot runs a bigger batch: inputs, outputs, power and crew all scale, the ratio does not', () => {
  const dist = (ring) => ({ id: 1, type: 'freeport', level: 4, inventory: { ...Object.fromEntries(Object.keys(config.resources).map((r) => [r, 10000])) },
    buildings: [{ id: 1, ring: 1, slot: 0, type: 'solar_array', status: 'active' }, { id: 2, ring, slot: 0, type: 'trade_workshop', status: 'active', recipe: 'tool_steel' }, { id: 3, ring, slot: 1, type: 'solar_array', status: 'active' }, { id: 4, ring, slot: 2, type: 'solar_array', status: 'active' }] });
  const nmap = sim.buildNeighborMap(config, 'freeport');
  const run = (ring) => sim.stepDistrict(config, dist(ring), { staff: 1, morOut: 1 }, nmap, {});
  const small = run(1); const big = run(4); // ring 1 is a Small plot (batch 1), ring 4 a Large plot
  const batch = config.tradeWorks.batchByPlot[sim.plotSize(config, 4, 'freeport')];
  assert.ok(batch > 1);
  const made = (r) => r.flows.tool_steel.produced; const used = (r) => r.flows.ingots.consumed;
  assert.ok(Math.abs(made(big) / made(small) - batch) < 1e-9, `output ×${made(big) / made(small)}`);
  assert.ok(Math.abs(used(big) / used(small) - batch) < 1e-9, 'input scales with it');
  assert.ok(Math.abs(made(big) / used(big) - made(small) / used(small)) < 1e-9, 'same ratio: no efficiency gain');
  assert.ok(Math.abs(sim.rates(config, config.buildings.trade_workshop, { recipe: 'tool_steel' }, 4, 'freeport').workers - 3 * batch) < 1e-9, 'crew scales too');
  assert.ok(sim.rates(config, config.buildings.trade_workshop, { recipe: 'tool_steel' }, 4, 'freeport').inputs.energy > sim.rates(config, config.buildings.trade_workshop, { recipe: 'tool_steel' }, 1, 'freeport').inputs.energy);
});

test('a recipe runs better beside a workshop that makes its ingredient', () => {
  const mk = (neighbour) => ({ id: 1, type: 'freeport', level: 4, inventory: Object.fromEntries(Object.keys(config.resources).map((r) => [r, 10000])),
    buildings: [{ id: 1, ring: 2, slot: 0, type: 'trade_workshop', status: 'active', recipe: 'precision_tools' }, { id: 2, ring: 2, slot: 1, type: neighbour ? 'trade_workshop' : 'solar_array', status: 'active', recipe: neighbour ? 'tool_steel' : null },
      { id: 3, ring: 1, slot: 0, type: 'solar_array', status: 'active' }, { id: 4, ring: 1, slot: 1, type: 'solar_array', status: 'active' }, { id: 5, ring: 1, slot: 2, type: 'solar_array', status: 'active' }] });
  const nmap = sim.buildNeighborMap(config, 'freeport');
  const out = (nb) => sim.stepDistrict(config, mk(nb), { staff: 1, morOut: 1 }, nmap, {}).flows.precision_tools.produced;
  const gain = out(true) / out(false);
  assert.ok(Math.abs(gain - config.recipes.precision_tools.adjacent.tool_steel) < 1e-9, `×${gain}`);
});

test('changing a recipe costs credits and idles the workshop; not while it is resetting; not without the money', () => {
  const c = colony(); const fp = freeport(c);
  put(c, fp, 1, 0, 'solar_array'); put(c, fp, 1, 1, 'trade_workshop', { recipe: 'plastics' });
  const credits = () => db.prepare('SELECT credits FROM colonies WHERE id = ?').get(c.id).credits;
  const fee = sim.recipeResetFee(config, 'plastics', 1, 'freeport');
  assert.ok(fee > 0);
  db.prepare('UPDATE colonies SET credits = ? WHERE id = ?').run(fee - 1, c.id);
  assert.match(actions.setRecipe(c.uid, { ring: 1, slot: 1, recipe: 'curios', district: fp.id }).error, new RegExp(`costs ${fee} cr`));
  db.prepare('UPDATE colonies SET credits = ? WHERE id = ?').run(fee + 5, c.id);
  assert.deepEqual(actions.setRecipe(c.uid, { ring: 1, slot: 1, recipe: 'curios', district: fp.id }), { ok: true });
  assert.equal(credits(), 5);
  assert.match(actions.setRecipe(c.uid, { ring: 1, slot: 1, recipe: 'tinctures', district: fp.id }).error, /still resetting/);
  const b = () => viewFor(c.uid).views[fp.id].buildings.find((x) => x.type === 'trade_workshop');
  assert.equal(b().status, 'resetting');
  assert.ok(b().resetting > 0);
  tick(config.tradeWorks.reset.delayTicks + 1);
  assert.notEqual(b().status, 'resetting');
  assert.equal(b().recipe, 'curios');
  assert.deepEqual(actions.setRecipe(c.uid, { ring: 1, slot: 1, recipe: 'curios', district: fp.id }), { ok: true }, 'choosing the same recipe is free');
});

test('trade goods cannot be bought or sold through the convoy', () => {
  const c = colony();
  assert.match(actions.setContract(c.uid, { resource: 'tool_steel', side: 'export', amount: 5 }).error, /trade goods/);
  assert.match(actions.expressTrip(c.uid, { sell: { tool_steel: 1 } }).error, /trade goods/);
  assert.match(actions.expressTrip(c.uid, { buy: { tool_steel: 1 } }).error, /trade goods/);
});

test('making a trade good from goods bought on the exchange never beats selling it (no money machine)', () => {
  const fee = config.exchange.feeRate;
  for (const [id, rec] of Object.entries(config.recipes)) {
    const out = Object.keys(rec.outputsPerTick)[0];
    let tested = 0;
    for (let t = 0; t < 1500; t += 11) {
      const goods = [...Object.keys(rec.inputsPerTick).filter((r) => r !== 'energy'), out];
      if (goods.some((g) => ms.event(config, g, t))) continue; // shortages and gluts can bend any price
      const l = (g) => ms.ladder(config, g, t);
      const cost = Object.entries(rec.inputsPerTick).filter(([r]) => r !== 'energy').reduce((s, [r, q]) => s + q * l(r).asks[0].price, 0);
      const revenue = rec.outputsPerTick[out] * l(out).bids[0].price * (1 - fee);
      assert.ok(revenue < cost, `${id}@${t}: revenue ${revenue.toFixed(1)} vs cost ${cost.toFixed(1)}`);
      tested++;
    }
    assert.ok(tested > 20, `${id} tested ${tested}`);
  }
});

test('a deployed shield prevents every consequence of a hazard and spends the trade good; without stock it does nothing', () => {
  process.env.HAZARDS = 'on';
  const c = colony(); const fp = freeport(c);
  const sh = config.hazards.shield.raid;
  const need = Math.ceil(sh.amount * (1 + config.hazards.scalingPerHubLevel * (5 - 1)));
  const force = (type, inTicks) => {
    db.prepare('DELETE FROM colony_hazards WHERE colony_id = ?').run(c.id);
    db.prepare("INSERT INTO colony_hazards (colony_id, type, state, strikes_tick) VALUES (?, 'raid', 'forecast', ?)").run(c.id, tickNow() + inTicks);
  };
  db.prepare('UPDATE colonies SET last_seen_at = ? WHERE id = ?').run(Date.now() + 1e9, c.id);
  const setCore = (r, v) => db.prepare('UPDATE colony_inventory SET amount = ? WHERE district_id = ? AND resource_id = ?').run(v, c.core, r);
  // not deployed: the raid hurts
  force('raid', 2); setCore(sh.resource, need + 10); setCore('scrap', 3000);
  tick(2);
  assert.ok(store.loadHazard(c.id).state === 'active');
  // deployed with stock: harmless
  db.prepare('DELETE FROM colony_hazards WHERE colony_id = ?').run(c.id);
  force('raid', 3); setCore(sh.resource, need + 10); setCore('scrap', 3000);
  assert.deepEqual(actions.shieldHazard(c.uid, { enabled: true }), { ok: true });
  const v = viewFor(c.uid).hazard;
  assert.ok(v.shield.enabled && v.shield.need === need && v.shield.resource === sh.resource);
  tick(3);
  assert.equal(store.loadHazard(c.id), null, 'it passed without a trace');
  assert.equal(store.loadInventory(c.id, c.core)[sh.resource], 10, 'and the shield goods were spent');
  assert.ok(store.loadInventory(c.id, c.core).scrap >= 2990, 'nothing was looted');
  // deployed without stock: falls back to the usual consequences
  force('raid', 2); setCore(sh.resource, need - 1);
  actions.shieldHazard(c.uid, { enabled: true });
  tick(2);
  assert.equal(store.loadHazard(c.id).state, 'active');
  assert.equal(store.loadInventory(c.id, c.core)[sh.resource], need - 1, 'not enough, so nothing is spent');
  process.env.HAZARDS = 'off';
});

test('shields need the Free Port, a forecast hazard, and a hazard that can be shielded', () => {
  const c = colony();
  assert.match(actions.shieldHazard(c.uid, { enabled: true }).error, /no trade goods/);
  freeport(c);
  assert.match(actions.shieldHazard(c.uid, { enabled: true }).error, /No hazard/);
});

test('missions: none before the Free Port; three open after; each offers a different good per faction', () => {
  const c = colony();
  tick(2);
  assert.equal(viewFor(c.uid).missions.open.length, 0);
  freeport(c);
  tick(1);
  const m = viewFor(c.uid).missions;
  assert.equal(m.open.length, config.missions.slots);
  for (const q of m.open) {
    assert.equal(q.offers.length, Object.keys(config.missions.factions).length);
    assert.equal(new Set(q.offers.map((o) => o.good)).size, q.offers.length, 'a different good per faction');
    for (const o of q.offers) {
      assert.ok(config.resources[o.good].trade);
      assert.ok(o.reward > o.qty * ms.midPrice(config, o.good), 'pays above market');
      assert.ok(o.standing >= 1);
    }
  }
  assert.deepEqual(missions.build(c.id, 0, 5).offers, missions.build(c.id, 0, 5).offers, 'deterministic');
});

test('filling a mission takes the goods, pays the reward, adds standing, closes the other offers, and a new one appears later', () => {
  const c = colony(); const fp = freeport(c);
  tick(1);
  const q = viewFor(c.uid).missions.open[0];
  const offer = q.offers[1];
  assert.match(actions.missionFill(c.uid, { id: q.id, faction: offer.faction, district: fp.id }).error, /Not enough/);
  db.prepare('UPDATE colony_inventory SET amount = ? WHERE district_id = ? AND resource_id = ?').run(offer.qty + 3, fp.id, offer.good);
  const cr = db.prepare('SELECT credits FROM colonies WHERE id = ?').get(c.id).credits;
  assert.match(actions.missionFill(c.uid, { id: q.id, faction: 'nobody', district: fp.id }).error, /no such offer/);
  const r = actions.missionFill(c.uid, { id: q.id, faction: offer.faction, district: fp.id });
  assert.equal(r.ok, true);
  assert.equal(stock(c, fp, offer.good), 3);
  assert.equal(db.prepare('SELECT credits FROM colonies WHERE id = ?').get(c.id).credits, cr + offer.reward);
  const m = viewFor(c.uid).missions;
  assert.equal(m.standing[offer.faction], offer.standing);
  assert.equal(m.total, offer.standing);
  assert.equal(m.filled, 1);
  assert.ok(!m.open.some((x) => x.id === q.id));
  assert.match(actions.missionFill(c.uid, { id: q.id, faction: offer.faction, district: fp.id }).error, /no longer open/);
  assert.equal(m.open.length, config.missions.slots - 1);
  tick(config.missions.refreshTicks + 1);
  assert.equal(viewFor(c.uid).missions.open.length, config.missions.slots);
});

test('unfilled missions lapse', () => {
  const c = colony(); freeport(c);
  tick(1);
  const ids = viewFor(c.uid).missions.open.map((q) => q.id);
  tick(config.missions.durationTicks[1] + 2);
  const now = viewFor(c.uid).missions.open.map((q) => q.id);
  assert.ok(ids.every((id) => !now.includes(id)));
  assert.equal(now.length, config.missions.slots);
});

test('scrapping a configured workshop locks the slot for as long as a recipe change takes, so it is not a faster reset', () => {
  const c = colony(); const fp = freeport(c);
  db.prepare('UPDATE districts SET level = 2 WHERE id = ?').run(fp.id);
  db.prepare('UPDATE colony_inventory SET amount = 5000 WHERE district_id = ?').run(fp.id);
  put(c, fp, 1, 0, 'solar_array'); put(c, fp, 1, 1, 'trade_workshop', { recipe: 'plastics' }); put(c, fp, 1, 2, 'trade_workshop');
  db.prepare('UPDATE colonies SET credits = 100000 WHERE id = ?').run(c.id);
  const locks = () => viewFor(c.uid).views[fp.id].locks;
  assert.deepEqual(actions.demolish(c.uid, { ring: 1, slot: 1, district: fp.id }), { ok: true });
  assert.deepEqual(locks().map((l) => [l.ring, l.slot]), [[1, 1]]);
  assert.equal(locks()[0].ticksLeft, config.tradeWorks.reset.delayTicks);
  assert.match(actions.build(c.uid, { ring: 1, slot: 1, type: 'trade_workshop', district: fp.id }).error, /still being cleared/);
  tick(config.tradeWorks.reset.delayTicks - 1);
  assert.match(actions.build(c.uid, { ring: 1, slot: 1, type: 'trade_workshop', district: fp.id }).error, /still being cleared/);
  tick(2);
  assert.deepEqual(locks(), []);
  assert.deepEqual(actions.build(c.uid, { ring: 1, slot: 1, type: 'trade_workshop', district: fp.id }), { ok: true });
  // a workshop that was never given a recipe has nothing to reset
  assert.deepEqual(actions.demolish(c.uid, { ring: 1, slot: 2, district: fp.id }), { ok: true });
  assert.deepEqual(locks(), []);
});
