'use strict';
// Building expansions, people leaving instead of collapsing, and what the Free Port can build.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-exp-'));
process.env.DB_PATH = path.join(dir, 'exp.db');
process.env.SESSION_SECRET = 'x';
process.env.THEME = 'basic'; // assertions use the neutral wording, whatever the default theme is
process.env.HAZARDS = 'off';
const store = require('../src/db');
const sim = require('../src/sim');
const engine = require('../src/engine');
const actions = require('../src/actions');
const { viewFor, clientConfig } = require('../src/state');
const { db, config } = store;
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let n = 0;
function colony(level = 5) {
  const uid = Number(db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(`x${++n}`, 'x').lastInsertRowid);
  const id = store.ensureColony(uid);
  const core = store.coreId(id);
  db.prepare('UPDATE colonies SET hub_level = ?, credits = 100000 WHERE id = ?').run(level, id);
  db.prepare("UPDATE colony_inventory SET amount = 3000 WHERE district_id = ? AND resource_id IN ('clean_water','rations','scrap','machined_parts','building_materials','alloys','frames','fittings','modules')").run(core);
  return { uid, id, core };
}
const put = (c, ring, slot, type, extra = '') => db.prepare('INSERT INTO colony_buildings (colony_id, district_id, ring_index, slot_index, building_type) VALUES (?, ?, ?, ?, ?)').run(c.id, c.core, ring, slot, type);
const tick = (k = 1) => { for (let i = 0; i < k; i++) engine.processTick(); };
const stock = (c, r) => store.loadInventory(c.id, c.core)[r] || 0;
const lvl = (c, ring, slot) => db.prepare('SELECT level FROM colony_buildings WHERE district_id = ? AND ring_index = ? AND slot_index = ?').get(c.core, ring, slot).level;

const nmap = sim.buildNeighborMap(config);
function run(buildings, inv = {}, pop = 40) {
  return sim.step(config, { hubLevel: 5, population: pop, morale: 100, age: 10, progress: 0, won: false,
    inventory: { ...config.global.startingState.resources, clean_water: 900, rations: 900, machined_parts: 500, ...inv }, buildings }, nmap);
}
let id = 1;
const bld = (ring, slot, type, level = 1) => ({ id: id++, ring, slot, type, status: 'active', level });
const solars = () => [bld(1, 0, 'solar_array'), bld(1, 1, 'solar_array'), bld(1, 2, 'solar_array')];

test('an expanded building produces more, consumes proportionally more, and needs more crew (a little less than proportionally)', () => {
  const base = run([...solars(), bld(2, 0, 'hydroponics_bay')]);
  const big = run([...solars(), bld(2, 0, 'hydroponics_bay', 3)]);
  const k = config.expansion.scale[3];
  const ratio = (r, res, field) => r.flows[res][field];
  assert.ok(Math.abs(ratio(big, 'rations', 'produced') / ratio(base, 'rations', 'produced') - k) < 1e-9, 'output scales');
  assert.ok(Math.abs(ratio(big, 'clean_water', 'consumed') - ratio(base, 'clean_water', 'consumed') * k) < 0.5 + 40 * 0.1, 'input scales (population also drinks)');
  assert.ok(big.staffing.posts > base.staffing.posts && big.staffing.posts < base.staffing.posts + config.buildings.hydroponics_bay.workers * k, 'crew grows, but less than proportionally');
  const ratioRI = (r) => r.flows.rations.produced / (r.flows.clean_water.consumed - 40 * 0.1);
  assert.ok(Math.abs(ratioRI(big) - ratioRI(base)) < 1e-6, 'the in/out ratio is unchanged: this is size, not efficiency');
  assert.ok(sim.rates(config, config.buildings.hydroponics_bay, { level: 3 }, 2, 'core').inputs.energy > config.buildings.hydroponics_bay.inputsPerTick.energy, 'power scales too');
});

test('an expanded Habitat Block houses more people; a Solar Array makes more power; a Warehouse stores more; a Watch Post defends more', () => {
  const homes = (l) => run([...solars(), bld(2, 0, 'habitat', l)]).housing.built;
  assert.ok(Math.abs(homes(4) / homes(1) - config.expansion.scale[4]) < 1e-9);
  const sup = (l) => run([bld(1, 0, 'solar_array', l)]).energy.supply;
  assert.ok(sup(3) > sup(1));
  const cap = (l) => run([...solars(), bld(2, 0, 'warehouse', l)]).cap;
  assert.ok(cap(3) > cap(1));
  const def = (l) => run([...solars(), bld(2, 0, 'watch_post', l)]).defense;
  assert.ok(Math.abs(def(2) / def(1) - config.expansion.scale[2]) < 1e-9);
  assert.equal(run([...solars(), bld(2, 0, 'hydroponics_bay', 99)]).flows.rations.produced, run([...solars(), bld(2, 0, 'hydroponics_bay', sim.expansionTop(config))]).flows.rations.produced, 'levels are capped');
});

test('expanding: paid from the district stock, a work order, level goes up one step at a time, cost grows in a straight line', () => {
  const c = colony();
  put(c, 1, 0, 'hydroponics_bay');
  const cost = (l) => sim.expansionCost(config, config.buildings.hydroponics_bay, l);
  assert.deepEqual(cost(3), Object.fromEntries(Object.entries(cost(2)).map(([r, q]) => [r, q * 2])));
  const before = stock(c, 'frames');
  assert.deepEqual(actions.expand(c.uid, { ring: 1, slot: 0 }), { ok: true });
  assert.equal(stock(c, 'frames'), before - cost(2).frames);
  assert.equal(lvl(c, 1, 0), 1, 'not done yet');
  assert.match(actions.expand(c.uid, { ring: 1, slot: 0 }).error, /already underway/);
  tick(config.expansion.ticks[2]);
  assert.equal(lvl(c, 1, 0), 2);
  const v = viewFor(c.uid).buildings.find((b) => b.type === 'hydroponics_bay');
  assert.equal(v.level, 2);
  assert.equal(v.xnext.level, 3);
  assert.deepEqual(v.xnext.cost, cost(3));
  for (let l = 3; l <= config.expansion.maxLevel; l++) { assert.deepEqual(actions.expand(c.uid, { ring: 1, slot: 0 }), { ok: true }); tick(config.expansion.ticks[l]); }
  assert.equal(lvl(c, 1, 0), config.expansion.maxLevel);
  assert.match(actions.expand(c.uid, { ring: 1, slot: 0 }).error, /fully expanded/);
  assert.equal(viewFor(c.uid).buildings.find((b) => b.type === 'hydroponics_bay').xnext, null);
});

test('expanding waits for its materials, and needs a real expandable building in the colony\'s own district', () => {
  const c = colony();
  put(c, 1, 0, 'hydroponics_bay'); put(c, 1, 1, 'beacon_array');
  db.prepare("UPDATE colony_inventory SET amount = 1 WHERE district_id = ? AND resource_id = 'frames'").run(c.core);
  assert.deepEqual(actions.expand(c.uid, { ring: 1, slot: 0 }), { ok: true, queued: true }, 'without the materials it waits in the queue');
  assert.equal(lvl(c, 1, 0), 1);
  assert.match(actions.expand(c.uid, { ring: 1, slot: 1 }).error, /cannot be expanded/);
  assert.match(actions.expand(c.uid, { ring: 4, slot: 4 }).error, /Nothing there/);
  assert.match(actions.expand(c.uid, { ring: -1, slot: 0 }).error, /Nothing there/);
  const other = colony();
  assert.match(actions.expand(c.uid, { ring: 1, slot: 0, district: other.core }).error, /Unknown district/);
});

test('cancelling an expansion, or demolishing the building, refunds the materials in full', () => {
  const c = colony();
  put(c, 1, 0, 'dormitory'); put(c, 1, 1, 'dormitory');
  const f0 = stock(c, 'frames'); const m0 = stock(c, 'modules');
  actions.expand(c.uid, { ring: 1, slot: 0 });
  const order = store.loadOrders(c.id).find((o) => o.action_type === 'expand');
  assert.deepEqual(actions.cancelOrder(c.uid, { orderId: order.id }), { ok: true });
  assert.equal(stock(c, 'frames'), f0); assert.equal(stock(c, 'modules'), m0);
  actions.expand(c.uid, { ring: 1, slot: 1 });
  assert.deepEqual(actions.demolish(c.uid, { ring: 1, slot: 1 }), { ok: true });
  assert.equal(store.loadOrders(c.id).filter((o) => o.action_type === 'expand').length, 0);
  assert.ok(stock(c, 'frames') >= f0 && stock(c, 'modules') >= m0, 'the materials came back');
});

test('the materials are made by recipes at the Free Port, and priced like every other trade good', () => {
  for (const k of ['frames', 'fittings', 'modules']) {
    assert.ok(config.resources[k].trade);
    assert.ok(config.recipes[k] && config.recipes[k].outputsPerTick[k] > 0);
  }
  for (const cls of Object.values(config.expansion.classes)) for (const r of Object.keys(cls.baseCost)) assert.ok(config.resources[r].trade, `${r} is a trade good`);
  assert.ok(Object.entries(config.buildings).filter(([, b]) => b.expand).length >= 25, 'most buildings can be expanded');
  for (const k of ['beacon_array', 'trade_workshop']) assert.ok(!config.buildings[k].expand);
});

test('the Free Port offers every district building except the other districts\' raw extractors and Core-only ones', () => {
  const list = clientConfig().buildableIn;
  for (const k of ['smelter', 'alloy_works', 'polymer_plant', 'cracking_tower', 'circuit_fab', 'cell_forge', 'bio_dome', 'agri_lab', 'pharma_lab', 'synth_reclaimer', 'fuel_generator', 'trade_workshop', 'foundry', 'solar_array', 'habitat']) {
    assert.ok(list.freeport.includes(k), `${k} should be buildable at the Free Port`);
  }
  for (const k of ['ore_drill', 'crude_pump', 'beacon_array']) assert.ok(!list.freeport.includes(k), k);
  assert.ok(!list.core.includes('smelter') && !list.pits.includes('polymer_plant'), 'other districts keep their own lists');
  assert.ok(list.pits.includes('ore_drill') && list.stacks.includes('crude_pump'));
});

// ---- people ------------------------------------------------------------------------------
const g = config.global;
function pop(inv, pop0, morale0, buildings, extra = {}) {
  return sim.step(config, { hubLevel: 3, population: pop0, morale: morale0, age: 10, progress: 0, won: false, inventory: { ...config.global.startingState.resources, ...inv }, buildings }, nmap);
}

test('a colony that cannot feed its people shrinks instead of collapsing, and settles at what it can feed', () => {
  // a home for 70 people, but food for far fewer
  // homes for 190 people, but food and water for about 100
  const homes = [bld(1, 0, 'solar_array'), bld(1, 1, 'solar_array'), bld(2, 0, 'hydroponics_bay'), bld(2, 1, 'water_purifier'), bld(2, 2, 'water_pump'),
    ...[0, 1, 2, 3, 4].map((i) => bld(3, i, 'habitat'))];
  let s = { hubLevel: 3, population: 150, morale: 80, age: 0, progress: 0, won: false, inventory: { ...config.global.startingState.resources, clean_water: 0, rations: 0, machined_parts: 500 }, buildings: homes };
  let failed = false;
  const trail = [];
  for (let t = 0; t < 400 && !failed; t++) {
    const r = sim.step(config, s, nmap);
    s = { ...s, inventory: r.inventory, population: r.population, morale: r.morale, age: s.age + 1 };
    failed = r.failed; trail.push(r.population);
  }
  assert.ok(!failed, 'the colony survived');
  assert.ok(s.population < 150 && s.population >= 60 && s.population <= 125, `population ${s.population}`);
  assert.ok(s.morale > 30, `morale recovered to ${Math.round(s.morale)}`);
  const last = trail.slice(-40);
  assert.ok(Math.max(...last) - Math.min(...last) <= 4, 'and it stopped shrinking: an equilibrium');
});

test('hunger costs morale in proportion to the shortage, so a small shortfall is slow and a total one is fast', () => {
  const small = pop({ rations: 0.95, clean_water: 500 }, 20, 80, []);      // need 2.0, have 0.95
  const total = pop({ rations: 0, clean_water: 0 }, 20, 80, []);
  assert.ok(small.starving.includes('rations'));
  const lossSmall = 80 - small.morale; const lossTotal = 80 - total.morale;
  assert.ok(lossSmall < lossTotal * 0.8 && lossSmall >= 100 / g.moraleFailureThresholdTicks * g.exodus.minShortageLoss - 1e-9, `${lossSmall} vs ${lossTotal}`);
  assert.equal(total.left, Math.max(1, Math.ceil(20 * g.exodus.starvingFraction)));
  assert.equal(total.leftWhy, 'hunger');
});

test('people leave when morale stays low, but never below the minimum population', () => {
  const fed = { clean_water: 900, rations: 900 };
  const low = pop(fed, 30, g.exodus.lowMoraleBelow - 5, [], {});
  // age 10 -> (10 + 1) % lowMoraleEveryTicks decides which ticks it happens on
  let left = 0;
  let s = { hubLevel: 3, population: 30, morale: 10, age: 0, progress: 0, won: false, inventory: { ...config.global.startingState.resources, ...fed }, buildings: [] };
  for (let t = 0; t < 60; t++) { const r = sim.step(config, s, nmap); left += r.left || 0; s = { ...s, inventory: { ...r.inventory, ...fed }, population: r.population, morale: Math.min(r.morale, 10), age: s.age + 1 }; }
  assert.ok(left > 0 && s.population < 30);
  assert.ok(s.population >= g.minPopulation, 'never below the minimum');
  assert.ok(low.left === 0 || low.leftWhy === 'despair');
  const tiny = pop({ rations: 0, clean_water: 0 }, g.minPopulation, 50, []);
  assert.equal(tiny.population, g.minPopulation);
});

test('a colony does not grow itself into a shortage: growth needs a surplus big enough for the new people', () => {
  const buildings = [bld(1, 0, 'solar_array'), bld(1, 1, 'solar_array'), bld(2, 0, 'habitat'), bld(2, 1, 'habitat'), bld(2, 2, 'hydroponics_bay'), bld(3, 0, 'water_purifier'), bld(3, 1, 'water_pump')];
  let s = { hubLevel: 3, population: 20, morale: 100, age: 0, progress: 0, won: false, inventory: { ...config.global.startingState.resources, clean_water: 300, rations: 300, machined_parts: 300 }, buildings };
  let everStarved = false;
  for (let t = 0; t < 300; t++) { const r = sim.step(config, s, nmap); everStarved = everStarved || r.starving.length > 0; s = { ...s, inventory: r.inventory, population: r.population, morale: r.morale, age: s.age + 1 }; }
  const surplus = s.population;
  assert.ok(surplus > 20, 'it did grow');
  assert.ok(!everStarved, 'and never into a shortage');
});

test('the view explains the people: consumption, headroom, outlook and why growth stopped', () => {
  const c = colony(3);
  const v = viewFor(c.uid).people;
  const pop0 = db.prepare('SELECT population FROM colonies WHERE id = ?').get(c.id).population;
  assert.ok(Math.abs(v.use.rations - config.global.populationConsumptionPerTick.rations * pop0) < 1e-9);
  assert.ok(Math.abs(v.use.clean_water - config.global.populationConsumptionPerTick.clean_water * pop0) < 1e-9);
  assert.equal(v.minPopulation, config.global.minPopulation);
  assert.ok(['growing', 'steady', 'shrinking'].includes(v.outlook.state));
  db.prepare('UPDATE colonies SET population = ? WHERE id = ?').run(viewFor(c.uid).colony.maxPopulation, c.id);
  assert.deepEqual(viewFor(c.uid).people.outlook, { state: 'steady', why: 'housing' });
});

test('the engine reports people leaving in the log', () => {
  const c = colony(1);
  db.prepare("UPDATE colony_inventory SET amount = 0 WHERE district_id = ? AND resource_id IN ('rations','clean_water')").run(c.core);
  db.prepare('UPDATE colonies SET population = 25 WHERE id = ?').run(c.id);
  tick(3);
  const msgs = db.prepare('SELECT message FROM colony_events WHERE colony_id = ?').all(c.id).map((e) => e.message);
  assert.ok(msgs.some((m) => /people are leaving/.test(m)), msgs.join(' | '));
  assert.ok(db.prepare('SELECT population FROM colonies WHERE id = ?').get(c.id).population < 25);
});

// ---- the reclaimer and growth on a full stockpile -------------------------------------------------
const ms = require('../src/marketsim');

test('the Synthetics Reclaimer turns raw synthetics into polymers, two to one', () => {
  const dist = (eff) => ({ id: 1, type: 'stacks', level: 2, inventory: { ...Object.fromEntries(Object.keys(config.resources).map((r) => [r, 1000])), raw_synthetics: eff, polymers: 0 },
    buildings: [{ id: 1, ring: 1, slot: 0, type: 'solar_array', status: 'active' }, { id: 2, ring: 1, slot: 1, type: 'synth_reclaimer', status: 'active' }] });
  const nmap2 = sim.buildNeighborMap(config, 'stacks');
  const r = sim.stepDistrict(config, dist(1000), { staff: 1, morOut: 1 }, nmap2, {});
  assert.ok(Math.abs(r.flows.raw_synthetics.consumed / r.flows.polymers.produced - 2) < 1e-9, 'exactly 2 in for 1 out');
  assert.ok(r.flows.polymers.produced > 0 && r.flows.raw_synthetics.produced === 0, 'it makes polymers and no synthetics');
  const starved = sim.stepDistrict(config, dist(3), { staff: 1, morOut: 1 }, nmap2, {});
  assert.ok(starved.flows.polymers.produced > 0 && starved.flows.polymers.produced < r.flows.polymers.produced, 'with little to convert it slows, and never makes polymers from nothing');
  assert.deepEqual(config.buildings.synth_reclaimer.districts, ['stacks']);
});

test('converting raw synthetics bought on the exchange into polymers never makes money (the prices keep the conversion honest)', () => {
  const fee = config.exchange.feeRate;
  const inp = config.buildings.synth_reclaimer.inputsPerTick.raw_synthetics; const out = config.buildings.synth_reclaimer.outputsPerTick.polymers;
  let tested = 0;
  for (let t = 0; t < 2000; t += 7) {
    if (ms.event(config, 'raw_synthetics', t) || ms.event(config, 'polymers', t)) continue;
    const cost = inp * ms.ladder(config, 'raw_synthetics', t).asks[0].price;
    const revenue = out * ms.ladder(config, 'polymers', t).bids[0].price * (1 - fee);
    assert.ok(revenue < cost, `@${t}: ${revenue.toFixed(1)} vs ${cost.toFixed(1)}`);
    tested++;
  }
  assert.ok(tested > 100);
});

test('canFeed: a surplus covers new people; a full stockpile can carry a small shortfall; a low one cannot', () => {
  const cap = 6000; const extra = 0.2;
  assert.equal(sim.canFeed(config, { net: 5, stock: 10, cap }, extra), true, 'plain surplus');
  assert.equal(sim.canFeed(config, { net: 0.1, stock: 10, cap }, extra), false, 'a thin surplus and an empty store: no');
  assert.equal(sim.canFeed(config, { net: 0.1, stock: cap, cap }, extra), true, 'the same thin surplus with a full store: yes');
  assert.equal(sim.canFeed(config, { net: 0.1, stock: cap * config.global.populationGrowth.bufferFloor, cap }, extra), false, 'the store has to be above its floor');
  assert.equal(sim.canFeed(config, { net: -50, stock: cap, cap }, extra), false, 'a big shortfall is never carried');
  const limit = (cap - cap * config.global.populationGrowth.bufferFloor) / config.global.populationGrowth.bufferTicks;
  assert.equal(sim.canFeed(config, { net: 0, stock: cap, cap }, limit * 0.99), true);
  assert.equal(sim.canFeed(config, { net: 0, stock: cap, cap }, limit * 1.01), false, 'and the allowance is bounded');
});

test('a colony with a full store and production only just matching use keeps growing, a little, and never starves', () => {
  const build = [bld(1, 0, 'solar_array'), bld(1, 1, 'solar_array'), bld(2, 0, 'hydroponics_bay'), bld(2, 1, 'water_purifier'), bld(2, 2, 'water_pump'), ...[0, 1, 2, 3, 4].map((i) => bld(3, i, 'habitat'))];
  const cap = config.hubLevels[3].maxStorage;
  const start = (rations) => ({ hubLevel: 3, population: 123, morale: 100, age: 0, progress: 0, won: false, inventory: { ...config.global.startingState.resources, clean_water: cap, rations, machined_parts: 500 }, buildings: build });
  const go = (s, ticks) => { let starved = false; let r; for (let t = 0; t < ticks; t++) { r = sim.step(config, s, nmap); starved = starved || r.starving.length > 0; s = { ...s, inventory: r.inventory, population: r.population, morale: r.morale, age: s.age + 1 }; } return { s, starved, r }; };
  const first = sim.step(config, start(cap), nmap);
  const net0 = first.flows.rations.produced - first.flows.rations.consumed;
  assert.ok(net0 > 0 && net0 < 0.5, `production only just matches use (net ${net0.toFixed(2)})`);
  const full = go(start(cap), 400);
  assert.ok(full.s.population > 123, `a full store lets it grow (${full.s.population})`);
  assert.ok(full.s.population < 123 + 40, `but only a little (${full.s.population})`);
  assert.ok(!full.starved, 'and it never ran short');
  const empty = go(start(40), 400);
  assert.ok(empty.s.population <= 125, `an empty store does not (${empty.s.population})`);
});

test('the view says when the colony is growing on its stockpile rather than on surplus', () => {
  const c = colony(3);
  const v = viewFor(c.uid);
  assert.ok(v.people.outlook && typeof v.people.outlook.state === 'string');
  const note = JSON.stringify(v.people.outlook);
  assert.ok(!/buffer/.test(note) || v.people.outlook.state === 'growing');
});
