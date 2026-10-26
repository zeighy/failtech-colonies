'use strict';
// The simulation with more than one district. Uses a synthetic "outpost" type so this suite does not depend
// on any real district content.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sim = require('../src/sim');

const base = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'game_config.json'), 'utf8'));
const config = {
  ...base,
  districtTypes: {
    outpost: {
      ringPlotSize: { 1: 1, 2: 1, 3: 2, 4: 3, 5: 4 },
      levels: {
        1: { maxStorage: 1000, baseHousing: 0, baseEnergy: 10, ringCapacities: { 1: 3 }, upgradeCost: null },
        2: { maxStorage: 1500, baseHousing: 0, baseEnergy: 10, ringCapacities: { 1: 3, 2: 5 }, upgradeCost: {} },
      },
    },
  },
};
const maps = { core: sim.buildNeighborMap(config, 'core'), outpost: sim.buildNeighborMap(config, 'outpost') };
let nid = 1;
const b = (ring, slot, type, status = 'active') => ({ id: nid++, ring, slot, type, status });
const stock = (o = {}) => ({ ...base.global.startingState.resources, ...o });
const colony = (o = {}) => ({ population: 20, morale: 80, age: 0, progress: 0, won: false, ...o });
const coreD = (o = {}) => ({ id: 1, type: 'core', level: 1, inventory: stock(), buildings: [], ...o });
const outD = (o = {}) => ({ id: 2, type: 'outpost', level: 1, inventory: stock({ scrap: 0, clean_water: 0, rations: 0 }), buildings: [], ...o });
const run = (c, ds, opts = {}) => sim.stepColony(config, c, ds, { neighborMaps: maps, ...opts });
const dist = (res, id) => res.districts.find((d) => d.id === id);

test('district types: plot sizes and neighbour maps follow the type', () => {
  assert.equal(sim.plotSize(config, 1, 'core'), 1);
  assert.equal(sim.plotSize(config, 5, 'core'), 5, 'the core has a Colossal ring');
  assert.equal(sim.plotSize(config, 5, 'outpost'), 4, 'districts top out at Heavy');
  assert.equal(sim.plotSize(config, 3, 'outpost'), 2);
  assert.deepEqual(Object.keys(sim.ringCapacities(config, 'outpost')), ['1', '2']);
  assert.ok(maps.outpost.has('2:4') && !maps.outpost.has('3:0'));
  // a Foundry wants a Large plot: fine in core ring 3, cramped in an outpost ring 2
  assert.equal(sim.plotMultiplier(config, config.buildings.foundry, 3, 'core'), 1);
  assert.ok(sim.plotMultiplier(config, config.buildings.foundry, 2, 'outpost') < 1);
  assert.throws(() => sim.districtType(config, 'nope'), /Unknown district type/);
});

test('each district has its own stockpile and its own power grid', () => {
  const core = coreD({ buildings: [b(1, 0, 'solar_array')] });
  const out = outD({ buildings: [b(1, 0, 'scrap_extractor')], inventory: stock({ scrap: 0 }) });
  const r = run(colony(), [core, out]);
  const rc = dist(r, 1), ro = dist(r, 2);
  assert.equal(rc.flows.scrap.produced, 0, 'the core makes no scrap');
  assert.ok(ro.flows.scrap.produced > 0, 'the outpost extractor works on its own grid (base power 10 >= 5 needed)');
  assert.ok(ro.inventory.scrap > 0 && rc.inventory.scrap === base.global.startingState.resources.scrap);
  assert.equal(ro.energy.supply, 10);
  assert.ok(rc.energy.supply > ro.energy.supply, 'the core solar array does not feed the outpost');
  // an outpost consumer with too little local power browns out although the core has plenty
  const hungry = outD({ buildings: [b(1, 0, 'parts_assembler'), b(1, 1, 'scrap_extractor'), b(1, 2, 'water_pump')], inventory: stock({ scrap: 500 }) });
  const rr = run(colony(), [coreD({ buildings: [b(1, 0, 'solar_array'), b(1, 1, 'solar_array')] }), hungry]);
  assert.ok(dist(rr, 2).energy.satisfaction < 1);
  assert.equal(dist(rr, 1).energy.satisfaction, 1);
});

test('crew is one pool across districts: posts anywhere compete for the same hands', () => {
  const core = coreD({ buildings: [b(1, 0, 'scrap_extractor')] });
  const out = outD({ buildings: [b(1, 0, 'parts_assembler')], inventory: stock({ scrap: 500 }) });
  const posts = config.buildings.scrap_extractor.workers + config.buildings.parts_assembler.workers;
  const pop = 4;
  const r = run(colony({ population: pop }), [core, out]);
  const ratio = (pop * config.global.workforceShare) / posts;
  assert.ok(ratio < 1);
  assert.ok(Math.abs(r.staffing.ratio - ratio) < 1e-9);
  assert.equal(r.staffing.posts, posts);
  // both districts are slowed by the same ratio
  assert.ok(Math.abs(dist(r, 1).buildings.get(core.buildings[0].id).eff - ratio) < 1e-9);
  assert.ok(Math.abs(dist(r, 2).buildings.get(out.buildings[0].id).eff - ratio) < 1e-9);
  // plenty of hands: nobody is slowed
  assert.equal(run(colony({ population: 100 }), [core, out]).staffing.ratio, 1);
});

test('the population eats from the core stockpile only; storage caps are per district', () => {
  const core = coreD({ inventory: stock({ rations: 100, clean_water: 100 }) });
  const out = outD({ inventory: stock({ rations: 5000, clean_water: 5000, scrap: 2500 }) });
  const r = run(colony(), [core, out]);
  const rc = dist(r, 1), ro = dist(r, 2);
  assert.ok(Math.abs(rc.inventory.rations - (100 - 2)) < 1e-9, 'core pays the 2 rations');
  assert.equal(ro.inventory.rations, 1000, 'outpost stock is untouched by hunger but trimmed to its own cap (1000)');
  assert.equal(ro.inventory.scrap, 1000);
  assert.equal(rc.inventory.scrap, base.global.startingState.resources.scrap);
  // running out in the core starves the colony even if an outpost is stuffed
  const poor = run(colony(), [coreD({ inventory: stock({ rations: 0, clean_water: 100 }) }), outD({ inventory: stock({ rations: 900 }) })]);
  assert.deepEqual(poor.starving, ['rations']);
});

test('housing and comfort are colony-wide: homes in any district add to the cap and the comfort average', () => {
  const core = coreD();
  const baseCore = base.hubLevels['1'].baseHousing;
  const noHomes = run(colony(), [core, outD()]);
  assert.equal(noHomes.housing.cap, baseCore, 'an outpost has no quarters of its own');
  const homes = outD({ buildings: [b(1, 0, 'dormitory'), b(1, 1, 'foundry')] }); // foundry beside a dormitory: noisy
  const r = run(colony(), [coreD(), homes]);
  const cap = config.buildings.dormitory.housing * sim.plotMultiplier(config, config.buildings.dormitory, 1, 'outpost');
  assert.equal(r.housing.built, cap);
  assert.equal(r.housing.cap, Math.floor(baseCore + cap));
  assert.ok(r.moraleInfo.comfort < 0, 'the foundry makes the outpost homes uncomfortable');
  assert.equal(dist(r, 2).buildings.get(homes.buildings[0].id).comfort, config.buildings.foundry.comfort);
  // the hub's quarters dilute it, exactly as in a single-district colony
  const expect = (cap * config.buildings.foundry.comfort) / (baseCore + cap);
  assert.ok(Math.abs(r.moraleInfo.comfort - expect) < 1e-9);
});

test('hazard modifiers are per district', () => {
  const c1 = coreD({ buildings: [b(1, 0, 'solar_array')] });
  const o1 = outD({ buildings: [b(1, 0, 'solar_array')] });
  const clear = run(colony(), [c1, o1]);
  const hit = run(colony(), [c1, o1], { mods: { 2: { outputMult: { solar_array: 0 } } } });
  assert.equal(dist(hit, 1).energy.supply, dist(clear, 1).energy.supply, 'the core is untouched');
  assert.equal(dist(hit, 2).energy.supply, 10, 'the outpost loses its solar output, keeps its base power');
});

test('beacon signal and defence add up across districts; a colony needs exactly one core', () => {
  const o = outD({ buildings: [b(1, 0, 'watch_post'), b(1, 1, 'watch_post')] });
  const r = run(colony(), [coreD({ buildings: [b(1, 0, 'watch_post')] }), o]);
  assert.ok(r.defense > 2.5 && r.defense <= 3.3, `defence ${r.defense}`);
  assert.throws(() => run(colony(), [outD()]), /core district/);
});

test('with only the core, stepColony equals the single-base step()', () => {
  const buildings = [b(1, 0, 'solar_array'), b(1, 1, 'scrap_extractor'), b(1, 2, 'parts_assembler'), b(1, 3, 'dormitory')];
  const state = { hubLevel: 3, population: 30, morale: 77, age: 11, progress: 0, won: false, inventory: stock({ machined_parts: 40 }), buildings };
  const old = sim.step(config, state, maps.core, { popConsumptionMult: 1.2, drain: { machined_parts: 0.5 } });
  const res = sim.coreView(sim.stepColony(config, { population: 30, morale: 77, age: 11, progress: 0, won: false },
    [{ id: 9, type: 'core', level: 3, inventory: state.inventory, buildings }],
    { neighborMaps: maps, mods: { 9: { drain: { machined_parts: 0.5 } } }, popConsumptionMult: 1.2 }));
  assert.deepEqual(res.inventory, old.inventory);
  assert.equal(res.morale, old.morale);
  assert.equal(res.population, old.population);
  assert.deepEqual(res.energy, old.energy);
  assert.deepEqual([...res.buildings], [...old.buildings]);
});

test('district progression: the level cap follows the Core and the Beacon', () => {
  const cap = (coreLevel, beaconBuilt = false) => sim.districtLevelCap(config, { coreLevel, beaconBuilt });
  assert.deepEqual([1, 2, 3].map((l) => cap(l)), [0, 0, 0], 'locked until Core level 4');
  assert.equal(cap(4), 2);
  assert.equal(cap(5), 4);
  assert.equal(cap(5, true), 5, 'the Beacon unlocks the top level');
  assert.equal(cap(4, true), 2, 'a Beacon alone is not enough');
  assert.equal(sim.districtsUnlocked(config, { coreLevel: 3 }), false);
  assert.equal(sim.districtsUnlocked(config, { coreLevel: 4 }), true);
  // the cap never goes down as the Core advances
  let prev = 0;
  for (let l = 1; l <= 5; l++) { assert.ok(cap(l) >= prev); prev = cap(l); }
  assert.equal(sim.districtLevelNeeds(config, 2), 'the Core reaches level 4');
  assert.equal(sim.districtLevelNeeds(config, 3), 'the Core reaches level 5');
  assert.equal(sim.districtLevelNeeds(config, 5), 'the Core reaches level 5 and the Beacon is built');
  assert.equal(sim.districtLevelNeeds(config, 6), null);
});
