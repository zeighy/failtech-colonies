'use strict';
// Optional inputs (off by default, a fixed amount per tick while switched on and in stock) and the chain rebalance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
// The database must be a throwaway one before anything that touches it is loaded.
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-opt-')), 'o.db');
process.env.SESSION_SECRET = 'x';
process.env.THEME = 'basic'; // assertions use the neutral wording, whatever the default theme is
process.env.HAZARDS = 'off';
const sim = require('../src/sim');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'game_config.json'), 'utf8'));
const nm = sim.buildNeighborMap(config);
let id = 1;
const bld = (ring, slot, type, extra = {}) => ({ id: id++, ring, slot, type, status: 'active', ...extra });
function run(buildings, inv = {}, hubLevel = 3) {
  return sim.step(config, {
    hubLevel, population: 40, morale: 100, age: 10, progress: 0, won: false,
    inventory: { ...config.global.startingState.resources, clean_water: 500, rations: 500, machined_parts: 100, ...inv }, buildings,
  }, nm);
}
const power = () => [bld(1, 0, 'solar_array'), bld(1, 1, 'solar_array')];

test('an optional input is off by default and does nothing', () => {
  const r = run([...power(), bld(2, 0, 'hydroponics_bay')], { fertiliser: 100 });
  assert.equal(r.inventory.fertiliser, 100);
});

test('switched on: a fixed amount is spent each tick and the output goes up', () => {
  const plain = run([...power(), bld(2, 0, 'hydroponics_bay')], { fertiliser: 100 });
  const boosted = run([...power(), bld(2, 0, 'hydroponics_bay', { boost: 1 })], { fertiliser: 100 });
  const o = config.buildings.hydroponics_bay.optional;
  assert.equal(100 - boosted.inventory.fertiliser, o.inputsPerTick.fertiliser);
  const gain = (boosted.flows.rations.produced) / plain.flows.rations.produced;
  assert.ok(Math.abs(gain - o.outputMult) < 1e-6, `×${gain}`);
  assert.equal([...boosted.buildings.values()].find((s) => s.boost).boost, 'on');
});

test('switched on but out of stock: nothing is spent, no bonus, and it says so', () => {
  const plain = run([...power(), bld(2, 0, 'hydroponics_bay')]);
  const r = run([...power(), bld(2, 0, 'hydroponics_bay', { boost: 1 })], { fertiliser: 0.2 });
  assert.equal(r.inventory.fertiliser, 0.2);
  assert.equal(r.flows.rations.produced, plain.flows.rations.produced);
  assert.equal([...r.buildings.values()].find((s) => s.boost).boost, 'starved');
});

test('a paused or stalled building does not burn its optional input', () => {
  const r = run([...power(), { ...bld(2, 0, 'hydroponics_bay', { boost: 1 }), status: 'paused' }], { fertiliser: 100 });
  assert.equal(r.inventory.fertiliser, 100);
});

test('medicine in the homes raises comfort and so the morale target', () => {
  const homes = (boost) => [...power(), bld(2, 0, 'foundry'), bld(2, 1, 'habitat', boost ? { boost: 1 } : {})];
  const a = run(homes(false), { medicine: 50 });
  const b = run(homes(true), { medicine: 50 });
  const home = (r) => [...r.buildings.values()].find((s) => s.comfort !== undefined);
  assert.ok(home(b).comfort > home(a).comfort, `${home(a).comfort} -> ${home(b).comfort}`);
  assert.ok(b.moraleInfo.target > a.moraleInfo.target);
  assert.equal(50 - b.inventory.medicine, config.buildings.habitat.optional.inputsPerTick.medicine);
});

test('housing past level 5 can take larger families and tighter spaces: a fixed cost each, homes multiplied', () => {
  const H = config.expansion.classes.housing.options;
  const homes = (extra, inv = {}) => run([...power(), bld(2, 1, 'habitat', { level: 5, ...extra })], { meals: 100, clean_water: 500, scrap: 1500, biomass: 100, ...inv });
  const plain = homes({});
  const fam = homes({ boost: H.larger_families.bit });
  const both = homes({ boost: H.larger_families.bit | H.tighter_spaces.bit });
  const built = (r) => r.housing.built;
  assert.ok(Math.abs(built(fam) / built(plain) - H.larger_families.housingMult) < 1e-9, `${built(plain)} -> ${built(fam)}`);
  assert.ok(Math.abs(built(both) / built(plain) - H.larger_families.housingMult * H.tighter_spaces.housingMult) < 1e-9);
  assert.ok(Math.abs(plain.inventory.meals - fam.inventory.meals - H.larger_families.inputsPerTick.meals) < 1e-9, 'a flat amount, whatever the level (people eat meals too)');
  assert.ok(Math.abs(plain.inventory.biomass - both.inventory.biomass - H.tighter_spaces.inputsPerTick.biomass) < 1e-9);
  const st = (r) => [...r.buildings.values()].find((x) => x.comfort !== undefined);
  assert.deepEqual(st(both).boosts, { larger_families: 'on', tighter_spaces: 'on' });
  assert.equal(st(both).boost, null, 'the clinic supplies are a separate switch, still off');
  // with the clinic supplies on as well: all three run together
  const all = homes({ boost: 1 | H.larger_families.bit | H.tighter_spaces.bit }, { medicine: 50 });
  assert.equal(st(all).boost, 'on');
  assert.ok(Math.abs(built(all) - built(both)) < 1e-9);
  // out of stock: nothing spent, no extra homes
  const dry = homes({ boost: H.larger_families.bit }, { meals: 1 });
  assert.ok(dry.inventory.meals >= 0 && built(dry) === built(plain));
  assert.equal(built(dry), built(plain));
  assert.equal(st(dry).boosts.larger_families, 'starved');
  // below level 5 the bit does nothing
  const low = run([...power(), bld(2, 1, 'habitat', { level: 4, boost: H.larger_families.bit })], { meals: 100 });
  assert.equal(low.housing.built, run([...power(), bld(2, 1, 'habitat', { level: 4 })], { meals: 100 }).housing.built);
});

test('hazard requirements for fertiliser and medicine only count once districts are open', () => {
  const hz = require('../src/hazards');
  const lowInv = { clean_water: 500, fertiliser: 0, medicine: 0, building_materials: 500, scrap: 500, machined_parts: 100 };
  assert.ok(!hz.assess(config, 'blight', 3, lowInv, 0).reqs.some((r) => r.resource === 'fertiliser'));
  const late = hz.assess(config, 'blight', 4, lowInv, 0);
  assert.ok(late.reqs.some((r) => r.resource === 'fertiliser'));
  assert.ok(late.prep < 1, 'no fertiliser lowers preparedness');
  assert.ok(hz.assess(config, 'toxic_spill', 4, lowInv, 0).reqs.some((r) => r.resource === 'medicine'));
  assert.ok(hz.assess(config, 'raid', 4, lowInv, 5).reqs.some((r) => r.resource === 'medicine'));
});

test('the Stacks chain is shallow: pump, plant and fab make circuits, and the plant feeds two fabs', () => {
  const pp = config.buildings.polymer_plant; const cf = config.buildings.circuit_fab;
  assert.ok(pp.outputsPerTick.raw_synthetics >= 2 * cf.inputsPerTick.raw_synthetics);
  assert.ok(pp.outputsPerTick.polymers >= 2 * cf.inputsPerTick.polymers);
  for (const k of ['polymer_plant', 'circuit_fab', 'cracking_tower', 'crude_pump']) assert.equal(config.buildings[k].minPlotSize, 1, `${k} fits a Small plot`);
  // two fabs plus the support chain fit in the 8 slots of a level 2 district, with room to spare
  const chain = ['crude_pump', 'polymer_plant', 'circuit_fab', 'circuit_fab', 'solar_array'];
  const slots = Object.values(config.districtTypes.stacks.levels[2].ringCapacities).reduce((a, b) => a + b, 0);
  assert.ok(chain.length + 2 <= slots);
  // and the district's own power covers most of it
  assert.ok(config.districtTypes.stacks.levels[2].baseEnergy >= 45);
});

test('districts have enough base power to start, the Alloy Works outproduces the Foundry, the Greenbelt drinks raw water', () => {
  for (const t of Object.keys(config.districtTypes)) assert.ok(config.districtTypes[t].levels[1].baseEnergy >= 30 && config.districtTypes[t].levels[2].baseEnergy >= 45);
  assert.ok(config.buildings.alloy_works.outputsPerTick.alloys >= 3 * config.buildings.foundry.outputsPerTick.alloys);
  assert.ok(config.buildings.bio_dome.inputsPerTick.unpurified_water > 0 && !config.buildings.bio_dome.inputsPerTick.clean_water);
  assert.ok(config.buildings.pharma_lab.minPlotSize <= 2);
  assert.ok(config.hubLevels[5].upkeepPerTick.circuits <= 0.5);
});

test('the boost action switches a building, explicitly and idempotently, and only where it exists', () => {
  const store = require('../src/db');
  const actions = require('../src/actions');
  const { viewFor } = require('../src/state');
  const uid = Number(store.db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('o1', 'x').lastInsertRowid);
  const cid = store.ensureColony(uid);
  const ins = store.db.prepare('INSERT INTO colony_buildings (colony_id, ring_index, slot_index, building_type) VALUES (?, ?, ?, ?)');
  ins.run(cid, 1, 0, 'hydroponics_bay'); ins.run(cid, 1, 1, 'solar_array');
  assert.match(actions.setBoost(uid, { ring: 1, slot: 1, enabled: true }).error, /no optional input/);
  assert.match(actions.setBoost(uid, { ring: 5, slot: 5, enabled: true }).error, /Nothing there/);
  assert.deepEqual(actions.setBoost(uid, { ring: 1, slot: 0, enabled: true }), { ok: true });
  assert.deepEqual(actions.setBoost(uid, { ring: 1, slot: 0, enabled: true }), { ok: true });
  assert.ok(viewFor(uid).buildings.find((b) => b.type === 'hydroponics_bay').boost);
  assert.deepEqual(actions.setBoost(uid, { ring: 1, slot: 0, enabled: false }), { ok: true });
  assert.equal(viewFor(uid).buildings.find((b) => b.type === 'hydroponics_bay').boost, null);
  // housing: its own clinic supplies, and the housing options once it is level 5, each on its own bit
  ins.run(cid, 2, 0, 'habitat');
  const home = () => viewFor(uid).buildings.find((b) => b.type === 'habitat');
  assert.match(actions.setBoost(uid, { ring: 2, slot: 0, enabled: true, option: 'larger_families' }).error, /level 5/);
  assert.match(actions.setBoost(uid, { ring: 2, slot: 0, enabled: true, option: 'bogus' }).error, /no such optional input/);
  store.db.prepare('UPDATE colony_buildings SET level = 5 WHERE colony_id = ? AND building_type = ?').run(cid, 'habitat');
  assert.deepEqual(actions.setBoost(uid, { ring: 2, slot: 0, enabled: true, option: 'larger_families' }), { ok: true });
  assert.deepEqual(actions.setBoost(uid, { ring: 2, slot: 0, enabled: true }), { ok: true });
  assert.ok(home().boost);
  assert.deepEqual(Object.keys(home().boosts), ['larger_families']);
  assert.deepEqual(actions.setBoost(uid, { ring: 2, slot: 0, enabled: false, option: 'larger_families' }), { ok: true });
  assert.equal(home().boosts, null);
  assert.ok(home().boost, 'switching one option off leaves the others as they were');
  store.db.close();
});
