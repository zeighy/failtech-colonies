'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sim = require('../src/sim');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'game_config.json'), 'utf8'));
const nm = sim.buildNeighborMap(config);

function fresh(overrides = {}) {
  return {
    hubLevel: 1, population: config.global.startingState.population, morale: 100, age: 0,
    goalTicks: 0, won: false, credits: 500,
    inventory: { ...config.global.startingState.resources }, buildings: [], ...overrides,
  };
}
let nextId = 1;
const b = (ring, slot, type, status = 'active') => ({ id: nextId++, ring, slot, type, status });
const advance = (s, r) => ({ ...s, inventory: r.inventory, population: r.population, morale: r.morale,
  age: s.age + 1, goalTicks: r.goalTicks, won: r.won });

test('neighbour map: rings wrap and touch the rings above and below', () => {
  assert.deepEqual(nm.get('1:0').filter(([r]) => r === 1).map(([, s]) => s).sort(), [1, 5]);
  assert.deepEqual(nm.get('1:0').filter(([r]) => r === 2).map(([, s]) => s).sort(), [0, 1]);
  assert.deepEqual(nm.get('2:3').filter(([r]) => r === 1).map(([, s]) => s), [1]);
  // symmetric: if A neighbours B then B neighbours A
  for (const [k, list] of nm) for (const [r, s] of list) {
    assert.ok(nm.get(`${r}:${s}`).some(([r2, s2]) => `${r2}:${s2}` === k), `${k} <-> ${r}:${s}`);
  }
});

test('adjacency multiplier applies per neighbour and is clamped', () => {
  assert.equal(sim.adjacencyMultiplier(config, 'water_purifier', ['water_pump']), 1.15);
  assert.equal(sim.adjacencyMultiplier(config, 'water_purifier', ['solar_array']), 1);
  assert.equal(sim.adjacencyMultiplier(config, 'hydroponics_bay', Array(6).fill('scrap_extractor')), 0.5);
});

test('energy is a grid: shortage throttles every consumer proportionally', () => {
  const s = fresh({ buildings: [b(1, 0, 'scrap_extractor'), b(1, 1, 'water_pump'), b(1, 2, 'parts_assembler'),
    b(1, 3, 'water_purifier'), b(1, 4, 'hydroponics_bay')] });
  s.inventory.machined_parts = 0;
  const r = sim.step(config, s, nm);
  assert.equal(r.energy.supply, 20); // hub only
  assert.ok(r.energy.demand > 20);
  assert.ok(Math.abs(r.energy.satisfaction - r.energy.supply / r.energy.demand) < 1e-9);
  for (const st of r.buildings.values()) assert.ok(st.eff <= r.energy.satisfaction + 1e-9);
});

test('missing inputs stall a building and name the limiting resource', () => {
  const s = fresh({ buildings: [b(1, 0, 'water_purifier')] });
  s.inventory.unpurified_water = 0;
  const r = sim.step(config, s, nm);
  const st = [...r.buildings.values()][0];
  assert.equal(st.status, 'starved');
  assert.equal(st.limiting, 'unpurified_water');
  assert.equal(r.flows.clean_water.produced, 0);
});

test('paused buildings neither produce nor draw power', () => {
  const s = fresh({ buildings: [b(1, 0, 'parts_assembler', 'paused')] });
  const r = sim.step(config, s, nm);
  assert.equal(r.energy.demand, 0);
  assert.equal(r.flows.machined_parts.produced, 0);
});

test('storage is capped and excess is lost', () => {
  const s = fresh({ buildings: [b(1, 0, 'scrap_extractor')] });
  s.inventory.scrap = 1990;
  assert.equal(sim.step(config, s, nm).inventory.scrap, 2000);
});

test('doing nothing: starvation drains morale and the colony fails', () => {
  let s = fresh(); let ticks = 0; let r;
  do { r = sim.step(config, s, nm); s = advance(s, r); ticks++; } while (!r.failed && ticks < 500);
  assert.ok(r.failed);
  assert.ok(ticks > 35 && ticks < 80, `failed after ${ticks} ticks`);
});

test('a greedy but sensible opening (paying real costs) survives and stabilises', () => {
  const plan = [['scrap_extractor', 1], ['parts_assembler', 0], ['water_pump', 2], ['solar_array', 5],
    ['water_purifier', 3], ['hydroponics_bay', 4]];
  let s = fresh(); let r; let next = 0; let pending = [];
  for (let t = 1; t <= 150; t++) {
    while (next < plan.length) {
      const def = config.buildings[plan[next][0]];
      if (!Object.entries(def.cost).every(([res, a]) => s.inventory[res] >= a)) break;
      for (const [res, a] of Object.entries(def.cost)) s.inventory[res] -= a;
      pending.push({ at: t + def.constructionTicks, type: plan[next][0], slot: plan[next][1] });
      next++;
    }
    r = sim.step(config, s, nm);
    s = advance(s, r);
    for (const p of pending) if (p.at <= t) s.buildings.push(b(1, p.slot, p.type));
    pending = pending.filter((p) => p.at > t);
    assert.ok(!r.failed, `colony failed at tick ${t}`);
  }
  assert.equal(next, plan.length, 'every building got built');
  assert.ok(s.morale >= 90);
  assert.ok(r.flows.clean_water.produced - r.flows.clean_water.consumed > 0);
  assert.ok(r.flows.rations.produced - r.flows.rations.consumed > 0);
});

test('convoy sells exports, buys imports, respects credits and storage', () => {
  const s = { hubLevel: 1, credits: 100, inventory: { scrap: 100, rations: 100, machined_parts: 0 } };
  const out = sim.runConvoy(config, s, { export: { rations: 40 }, import: { machined_parts: 100 } });
  assert.equal(out.inventory.rations, 60);
  assert.equal(out.credits, 100 + 40 * config.resources.rations.sell - Math.floor((100 + 100) / config.resources.machined_parts.buy) * config.resources.machined_parts.buy);
  assert.equal(out.inventory.machined_parts, Math.floor(200 / config.resources.machined_parts.buy));
  // storage cap
  const full = sim.runConvoy(config, { hubLevel: 1, credits: 1e6, inventory: { scrap: 1990 } }, { import: { scrap: 500 } });
  assert.equal(full.inventory.scrap, 2000);
});

test('hub level 3 + stable loop for N ticks wins the game', () => {
  let s = fresh({ hubLevel: 3, buildings: [b(1, 0, 'solar_array'), b(1, 1, 'water_pump'), b(1, 2, 'water_purifier'),
    b(1, 3, 'hydroponics_bay'), b(1, 4, 'scrap_extractor')] });
  s.inventory.machined_parts = 0;
  for (let t = 0; t < config.global.goalSustainTicks + 2 && !s.won; t++) s = advance(s, sim.step(config, s, nm));
  assert.ok(s.won);
});
