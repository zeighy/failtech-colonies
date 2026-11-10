'use strict';
// Alternative recipes (the stand-in for research), district tiers, the scrap sink and standby power.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-recipes-'));
process.env.DB_PATH = path.join(dir, 'recipes.db');
process.env.SESSION_SECRET = 'x';
process.env.THEME = 'basic';
process.env.HAZARDS = 'off';
const store = require('../src/db');
const engine = require('../src/engine');
const actions = require('../src/actions');
const sim = require('../src/sim');
const { viewFor, clientConfig } = require('../src/state');
const { db, config } = store;
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const B = config.buildings;
const R = config.resources;
const tick = (k = 1) => { for (let i = 0; i < k; i++) engine.processTick(); };
let n = 0;
function colony(level = 5, amount = 5000) {
  const uid = Number(db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(`r${++n}`, 'x').lastInsertRowid);
  const id = store.ensureColony(uid);
  const core = store.coreId(id);
  db.prepare('UPDATE colonies SET hub_level = ?, credits = 100000, population = 300 WHERE id = ?').run(level, id);
  const inv = {}; for (const r of Object.keys(R)) inv[r] = amount;
  store.saveInventory(id, inv, core);
  return { uid, id, core };
}
function district(c, type, level = 2, amount = 5000) {
  const d = Number(db.prepare('INSERT INTO districts (colony_id, type, level, name, created_tick) VALUES (?, ?, ?, ?, 0)').run(c.id, type, level, type).lastInsertRowid);
  const inv = {}; for (const r of Object.keys(R)) inv[r] = amount;
  store.saveInventory(c.id, inv, d);
  return d;
}
const put = (c, ring, slot, type, d) => db.prepare('INSERT INTO colony_buildings (colony_id, district_id, ring_index, slot_index, building_type) VALUES (?, ?, ?, ?, ?)').run(c.id, d || c.core, ring, slot, type);
const row = (c, ring, slot, d) => db.prepare('SELECT * FROM colony_buildings WHERE district_id = ? AND ring_index = ? AND slot_index = ?').get(d || c.core, ring, slot);
const stock = (c, r, d) => store.loadInventory(c.id, d || c.core)[r] || 0;
const setStock = (c, r, a, d) => db.prepare('UPDATE colony_inventory SET amount = ? WHERE district_id = ? AND resource_id = ?').run(a, d || c.core, r);
const T = config.production.switchTicks;
// One district on its own, as the simulation sees it.
const run = (type, buildings, inventory, level = 5) => sim.stepDistrict(config,
  { type, level, inventory: { ...inventory }, buildings: buildings.map((b, i) => ({ id: i + 1, status: 'active', ...b })) },
  { staff: 1, morOut: 1 }, sim.buildNeighborMap(config, type));
const plenty = () => Object.fromEntries(Object.keys(R).map((r) => [r, 1000]));
const solars = [0, 1, 2, 3, 4, 5].map((s) => ({ ring: 1, slot: s, type: 'solar_array' }));

test('an alternative recipe changes what a building takes and makes; its base recipe is untouched', () => {
  const base = run('core', [...solars, { ring: 3, slot: 0, type: 'foundry' }], plenty());
  assert.equal(base.flows.alloys.produced, B.foundry.outputsPerTick.alloys);
  assert.equal(base.flows.ingots.consumed, 0);
  const alt = B.foundry.alternatives.ingot_charge;
  const r = run('core', [...solars, { ring: 3, slot: 0, type: 'foundry', recipe: 'ingot_charge' }], plenty());
  assert.equal(r.flows.alloys.produced, alt.outputsPerTick.alloys);
  assert.equal(r.flows.ingots.consumed, alt.inputsPerTick.ingots);
  assert.equal(r.flows.scrap.consumed, alt.inputsPerTick.scrap);
  const upkeep = run('core', solars, plenty()).flows.machined_parts.consumed; // the hub's own upkeep uses a few parts
  assert.equal(r.flows.machined_parts.consumed, upkeep, 'the alternative does not take what the base recipe took');
  assert.equal(base.flows.machined_parts.consumed, upkeep + B.foundry.inputsPerTick.machined_parts);
  assert.ok(alt.outputsPerTick.alloys > B.foundry.outputsPerTick.alloys, 'and it makes more');
  // an unknown recipe id falls back to the base recipe, and a line being retooled makes nothing
  assert.equal(run('core', [...solars, { ring: 3, slot: 0, type: 'foundry', recipe: 'nope' }], plenty()).flows.alloys.produced, B.foundry.outputsPerTick.alloys);
  const idle = run('core', [...solars, { ring: 3, slot: 0, type: 'foundry', recipe: 'ingot_charge', resetting: true }], plenty());
  assert.equal(idle.flows.alloys.produced, 0);
  assert.equal(idle.buildings.get(7).status, 'resetting');
  // short of the alternative's own input it slows like any other building
  const short = run('core', [...solars, { ring: 3, slot: 0, type: 'foundry', recipe: 'ingot_charge' }], { ...plenty(), ingots: 0 });
  assert.equal(short.flows.alloys.produced, 0);
  assert.equal(short.buildings.get(7).limiting, 'ingots');
  // expansion scales the alternative as it scales the base
  const big = run('core', [...solars, { ring: 3, slot: 0, type: 'foundry', recipe: 'ingot_charge', level: 3 }], plenty());
  assert.ok(Math.abs(big.flows.ingots.consumed - alt.inputsPerTick.ingots * config.expansion.scale[3]) < 1e-9);
  // a generator's alternative changes its fuel and its power
  const gen = run('core', [{ ring: 3, slot: 0, type: 'scrap_generator', recipe: 'fuel_assisted' }], plenty());
  assert.equal(gen.flows.fuel.consumed, B.scrap_generator.alternatives.fuel_assisted.inputsPerTick.fuel);
  assert.ok(gen.energy.supply > run('core', [{ ring: 3, slot: 0, type: 'scrap_generator' }], plenty()).energy.supply);
});

test('switching recipes: opens with the level of the place, costs no stock, and idles the line while it is retooled', () => {
  const c = colony(3);
  put(c, 3, 0, 'foundry'); put(c, 1, 0, 'water_purifier'); put(c, 1, 1, 'solar_array');
  // the foundry's ingot charge opens at hub level 4; the purifier's scrap bed at 3
  assert.match(actions.setRecipe(c.uid, { ring: 3, slot: 0, recipe: 'ingot_charge' }).error, /needs hub level 4/);
  assert.match(actions.setRecipe(c.uid, { ring: 3, slot: 0, recipe: 'nope' }).error, /Unknown recipe/);
  assert.match(actions.setRecipe(c.uid, { ring: 1, slot: 1, recipe: 'anything' }).error, /does not take recipes/);
  const before = store.loadInventory(c.id, c.core);
  const credits = db.prepare('SELECT credits FROM colonies WHERE id = ?').get(c.id).credits;
  assert.deepEqual(actions.setRecipe(c.uid, { ring: 1, slot: 0, recipe: 'scrap_bed' }), { ok: true });
  assert.deepEqual(store.loadInventory(c.id, c.core), before, 'switching takes no stock');
  assert.equal(db.prepare('SELECT credits FROM colonies WHERE id = ?').get(c.id).credits, credits, 'and no credits');
  assert.equal(row(c, 1, 0).recipe, 'scrap_bed');
  let v = viewFor(c.uid).buildings.find((b) => b.type === 'water_purifier');
  assert.equal(v.recipe, 'scrap_bed');
  assert.equal(v.resetting, T);
  assert.equal(v.status, 'resetting');
  assert.match(actions.setRecipe(c.uid, { ring: 1, slot: 0, recipe: null }).error, /still being retooled/);
  assert.deepEqual(actions.setRecipe(c.uid, { ring: 1, slot: 0, recipe: 'scrap_bed' }), { ok: true }, 'asking for what it already has changes nothing');
  tick(T - 1);
  assert.equal(viewFor(c.uid).buildings.find((b) => b.type === 'water_purifier').status, 'resetting');
  tick(1);
  v = viewFor(c.uid);
  assert.equal(v.buildings.find((b) => b.type === 'water_purifier').resetting, 0);
  assert.ok(v.resources.scrap.consumed >= B.water_purifier.alternatives.scrap_bed.inputsPerTick.scrap - 1e-9, 'the new recipe is running');
  // back to the base recipe: the same idle spell
  assert.deepEqual(actions.setRecipe(c.uid, { ring: 1, slot: 0, recipe: null }), { ok: true });
  assert.equal(row(c, 1, 0).recipe, null);
  assert.equal(viewFor(c.uid).buildings.find((b) => b.type === 'water_purifier').resetting, T);
  // the hub reaches level 4 and the foundry's alternative opens
  db.prepare('UPDATE colonies SET hub_level = 4 WHERE id = ?').run(c.id);
  assert.deepEqual(actions.setRecipe(c.uid, { ring: 3, slot: 0, recipe: 'ingot_charge' }), { ok: true });
  // another player's building is not this player's to retool
  const other = colony(5);
  assert.match(actions.setRecipe(other.uid, { ring: 3, slot: 0, recipe: 'ingot_charge', district: c.core }).error, /Unknown district/);
});

test('switching recipes: a district building goes by its own district level, and milestone recipes by what the colony has done', () => {
  const c = colony(5);
  const pits = district(c, 'pits', 2);
  put(c, 2, 0, 'smelter', pits); put(c, 3, 0, 'foundry'); put(c, 3, 1, 'cell_forge');
  assert.match(actions.setRecipe(c.uid, { ring: 2, slot: 0, recipe: 'fuel_fired', district: pits }).error, /needs district level 3/, 'the hub being level 5 does not count for a district building');
  db.prepare('UPDATE districts SET level = 3 WHERE id = ?').run(pits);
  assert.deepEqual(actions.setRecipe(c.uid, { ring: 2, slot: 0, recipe: 'fuel_fired', district: pits }), { ok: true });
  // milestones
  assert.deepEqual(viewFor(c.uid).milestones, { beacon: false, freeport: false, station: false });
  assert.match(actions.setRecipe(c.uid, { ring: 3, slot: 0, recipe: 'flux_refined' }).error, /needs the Free Port/);
  district(c, 'freeport', 1);
  assert.equal(viewFor(c.uid).milestones.freeport, true);
  assert.deepEqual(actions.setRecipe(c.uid, { ring: 3, slot: 0, recipe: 'flux_refined' }), { ok: true });
  put(c, 5, 0, 'beacon_array');
  assert.equal(viewFor(c.uid).milestones.beacon, true);
  // the pure rule
  assert.equal(sim.altUnlocked({ unlock: { level: 3 } }, { level: 2 }), false);
  assert.equal(sim.altUnlocked({ unlock: { level: 3 } }, { level: 3 }), true);
  assert.equal(sim.altUnlocked({ unlock: { milestone: 'station' } }, { level: 5, milestones: { beacon: true } }), false);
  assert.equal(sim.altUnlocked({ unlock: { milestone: 'station' } }, { level: 1, milestones: { station: true } }), true);
  assert.equal(sim.altUnlocked({}, {}), true);
});

test('the recipe book: most production has an alternative, each needs something the base recipe does not, and none is a money machine', () => {
  const production = Object.entries(B).filter(([, b]) => ['refinery', 'producer', 'assembler'].includes(b.type) && !b.recipeBuilding);
  const withAlt = production.filter(([, b]) => b.alternatives);
  assert.ok(withAlt.length >= production.length - 1, `${withAlt.length} of ${production.length} production buildings have an alternative`);
  const worth = (o, side) => Object.entries(o).filter(([r]) => r !== 'energy').reduce((s, [r, q]) => s + q * R[r][side], 0);
  let count = 0;
  for (const [id, b] of Object.entries(B)) {
    for (const [aid, a] of Object.entries(b.alternatives || {})) {
      count++;
      const where = `${id}.${aid}`;
      assert.ok(a.name && a.desc, `${where} has a name and a description`);
      assert.ok(a.unlock && (a.unlock.level || a.unlock.milestone), `${where} says when it opens`);
      if (a.unlock.milestone) assert.ok(['beacon', 'freeport', 'station'].includes(a.unlock.milestone), `${where}: unknown milestone`);
      if (a.unlock.level) {
        const places = b.districts && !b.districts.includes('core') ? b.districts.filter((d) => config.districtTypes[d]) : ['core'];
        for (const p of places) assert.ok(a.unlock.level <= sim.maxLevel(config, p), `${where} can be reached in ${p}`);
      }
      for (const r of [...Object.keys(a.inputsPerTick), ...Object.keys(a.outputsPerTick)]) assert.ok(r === 'energy' || R[r], `${where}: ${r} is a resource`);
      assert.ok(JSON.stringify([a.inputsPerTick, a.outputsPerTick]) !== JSON.stringify([b.inputsPerTick, b.outputsPerTick]), `${where} differs from the base recipe`);
      // bought at the convoy's price and sold at the convoy's price, an alternative never turns a profit by itself
      // (extractors and generators have nothing priced going in, and are bounded by their plots and power instead)
      const cost = worth(a.inputsPerTick, 'buy'); const revenue = worth(a.outputsPerTick, 'sell');
      if (b.type !== 'extractor' && b.type !== 'generator' && id !== 'bio_dome') assert.ok(revenue < cost, `${where}: makes ${revenue.toFixed(0)} from ${cost.toFixed(0)}`);
    }
  }
  assert.ok(count >= 25, `${count} alternatives`);
  // the client is told about them, and how long retooling takes
  const cc = clientConfig();
  assert.equal(cc.production.switchTicks, T);
  assert.ok(cc.buildings.foundry.alternatives.ingot_charge);
});

test('district tiers: tier-1 buildings run on what the Core and their own district make; tier 2 needs at most one kind of goods from elsewhere', () => {
  const made = (types) => new Set(Object.values(B).filter((b) => types.some((t) => sim.buildableIn(b, t) && (!b.districts || b.districts.includes(t)))).flatMap((b) => Object.keys(b.outputsPerTick)));
  const coreMade = made(['core']);
  for (const dtype of ['pits', 'stacks', 'greenbelt']) {
    const own = Object.entries(B).filter(([, b]) => b.districts && b.districts.includes(dtype) && b.districtTier);
    assert.ok(own.some(([, b]) => b.districtTier === 1), `${dtype} has tier-1 buildings`);
    const ownT1 = new Set(own.filter(([, b]) => b.districtTier === 1).flatMap(([, b]) => Object.keys(b.outputsPerTick)));
    const ownAll = new Set(own.flatMap(([, b]) => Object.keys(b.outputsPerTick)));
    for (const [id, b] of own) {
      const inputs = Object.keys(b.inputsPerTick).filter((r) => r !== 'energy');
      if (b.districtTier === 1) {
        for (const r of inputs) assert.ok(coreMade.has(r) || ownT1.has(r), `${id} (tier 1 in ${dtype}) needs ${r}, which neither the Core nor ${dtype}'s tier 1 makes`);
      } else {
        const foreign = inputs.filter((r) => !coreMade.has(r) && !ownAll.has(r));
        assert.ok(foreign.length <= 1, `${id} (tier ${b.districtTier} in ${dtype}) needs ${foreign.join(' and ')} from other districts`);
      }
    }
    // every district makes a little scrap to build with (the rig itself only stands in the Core and the Free Port)
    assert.ok(own.some(([, b]) => b.districtTier === 1 && b.outputsPerTick.scrap > 0), `${dtype} leaves some scrap`);
  }
  // every district production building has a tier
  for (const [id, b] of Object.entries(B)) {
    if (b.districts && b.districts.some((d) => ['pits', 'stacks', 'greenbelt'].includes(d)) && !b.districts.includes('core')) assert.ok(b.districtTier, `${id} has a district tier`);
  }
  // in the field (a territory) the old outputs stand: no scrap from a field smelter
  assert.deepEqual(sim.territoryDef(B.smelter, 'territory').outputsPerTick, { ingots: 8 });
});

test('the Reclamation Plant eats scrap in bulk, and its later recipes turn scrap and building stock into late-game goods', () => {
  const c = colony(3);
  assert.match(actions.build(c.uid, { ring: 3, slot: 0, type: 'reclamation_plant' }).error, /requires hub level 4/);
  db.prepare('UPDATE colonies SET hub_level = 4 WHERE id = ?').run(c.id);
  assert.deepEqual(actions.build(c.uid, { ring: 3, slot: 0, type: 'reclamation_plant' }), { ok: true });
  const def = B.reclamation_plant;
  assert.ok(def.inputsPerTick.scrap >= 100, 'it is a real sink for scrap');
  const base = run('core', [...solars, { ring: 3, slot: 0, type: 'reclamation_plant' }], plenty());
  assert.equal(base.flows.scrap.consumed, def.inputsPerTick.scrap);
  assert.equal(base.flows.ingots.produced, def.outputsPerTick.ingots);
  const frames = run('core', [...solars, { ring: 3, slot: 0, type: 'reclamation_plant', recipe: 'frame_blanks' }], plenty());
  assert.equal(frames.flows.frames.produced, def.alternatives.frame_blanks.outputsPerTick.frames);
  assert.ok(frames.flows.building_materials.consumed > 0 && frames.flows.scrap.consumed >= 200, 'base goods go into a late-game one');
  assert.equal(def.alternatives.frame_blanks.unlock.milestone, 'freeport');
  assert.equal(def.alternatives.fitting_blanks.unlock.milestone, 'station');
});

test('standby power: a Cell Bank burns cells only while the grid is short, only as much as is needed, and only if it has them', () => {
  const bank = B.cell_bank;
  const load = [{ ring: 3, slot: 0, type: 'foundry' }, { ring: 3, slot: 1, type: 'foundry' }, { ring: 3, slot: 2, type: 'foundry' }];
  const demand = 3 * B.foundry.inputsPerTick.energy;
  const base = config.hubLevels['5'].baseEnergy - config.hubLevels['5'].upkeepPerTick.energy;
  assert.ok(demand > base, 'the hub alone cannot carry this load');
  // no bank: a brownout
  const dark = run('core', load, plenty());
  assert.ok(dark.energy.satisfaction < 1);
  // a bank with cells: the gap is covered, and it burns in proportion to what it supplies
  const lit = run('core', [...load, { ring: 2, slot: 0, type: 'cell_bank' }], plenty());
  assert.equal(lit.energy.satisfaction, 1);
  const gap = demand - base;
  assert.ok(Math.abs(lit.energy.buffered - gap) < 1e-6, `it supplies the gap (${lit.energy.buffered} of ${gap})`);
  assert.ok(Math.abs(lit.flows.power_cells.consumed - gap / bank.buffer.power * bank.buffer.perTick.power_cells) < 1e-6);
  assert.equal(lit.buildings.get(4).status, 'running');
  // a healthy grid: it stands by and burns nothing
  const idle = run('core', [...solars, ...load, { ring: 2, slot: 0, type: 'cell_bank' }], plenty());
  assert.equal(idle.flows.power_cells.consumed, 0);
  assert.equal(idle.energy.buffered, 0);
  assert.equal(idle.buildings.get(10).status, 'standby');
  // no cells: nothing
  const empty = run('core', [...load, { ring: 2, slot: 0, type: 'cell_bank' }], { ...plenty(), power_cells: 0 });
  assert.equal(empty.energy.buffered, 0);
  assert.ok(empty.energy.satisfaction < 1);
  // a gap bigger than one bank: it gives all it has, and a second bank takes the rest
  const heavy = [...load, ...[3, 4, 5, 6, 7].map((s) => ({ ring: 3, slot: s, type: 'foundry' }))];
  const one = run('core', [...heavy, { ring: 2, slot: 0, type: 'cell_bank' }], plenty());
  assert.ok(Math.abs(one.energy.buffered - bank.buffer.power) < 1e-6);
  assert.ok(one.energy.satisfaction < 1);
  const two = run('core', [...heavy, { ring: 2, slot: 0, type: 'cell_bank' }, { ring: 2, slot: 1, type: 'cell_bank' }], plenty());
  assert.ok(two.energy.buffered > one.energy.buffered);
  // paused, it does nothing
  const off = run('core', [...load, { ring: 2, slot: 0, type: 'cell_bank', status: 'paused' }], plenty());
  assert.equal(off.energy.buffered, 0);
  // the cell forge's alternatives make the cells this asks for
  assert.ok(B.cell_forge.alternatives.reagent_electrolyte.outputsPerTick.power_cells >= 2 * B.cell_forge.outputsPerTick.power_cells);
});

test('standby power in play: the view shows the bank carrying the load and the cells draining', () => {
  const c = colony(5);
  for (let s = 0; s < 4; s++) put(c, 3, s, 'foundry');
  put(c, 2, 0, 'cell_bank');
  setStock(c, 'power_cells', 50);
  const v = viewFor(c.uid);
  assert.ok(v.energy.buffered > 0);
  assert.equal(v.energy.satisfaction, 1);
  assert.ok(v.resources.power_cells.net < 0);
  tick(3);
  assert.ok(stock(c, 'power_cells') < 50);
  assert.equal(viewFor(c.uid).buildings.find((b) => b.type === 'cell_bank').status, 'running');
});
