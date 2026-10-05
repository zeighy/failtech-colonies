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
    progress: 0, won: false, credits: 500,
    inventory: { ...config.global.startingState.resources }, buildings: [], ...overrides,
  };
}
let nextId = 1;
const b = (ring, slot, type, status = 'active') => ({ id: nextId++, ring, slot, type, status });
const advance = (s, r) => ({ ...s, inventory: r.inventory, population: r.population, morale: r.morale,
  age: s.age + 1, progress: r.progress, won: r.won });

test('neighbour map: rings wrap and touch the rings above and below', () => {
  assert.deepEqual(nm.get('1:0').filter(([r]) => r === 1).map(([, s]) => s).sort(), [1, 5]);
  // ring 1 has 6 slots and ring 2 has 8, so slot 0 of ring 1 touches the first two of ring 2
  assert.deepEqual(nm.get('1:0').filter(([r]) => r === 2).map(([, s]) => s).sort(), [0, 1]);
  assert.deepEqual(nm.get('2:3').filter(([r]) => r === 1).map(([, s]) => s), [2]);
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

const basePrices = Object.fromEntries(Object.entries(config.resources).map(([k, d]) => [k, { buy: d.buy, sell: d.sell }]));

test('convoy sells exports, buys imports, respects credits and storage', () => {
  const s = { hubLevel: 1, credits: 100, inventory: { scrap: 100, rations: 100, machined_parts: 0 } };
  const out = sim.runConvoy(config, s, { export: { rations: 40 }, import: { machined_parts: 100 } }, basePrices);
  assert.equal(out.inventory.rations, 60);
  const bought = Math.floor((100 + 40 * config.resources.rations.sell) / config.resources.machined_parts.buy);
  assert.equal(out.inventory.machined_parts, bought);
  assert.equal(out.credits, Math.round(100 + 40 * config.resources.rations.sell - bought * config.resources.machined_parts.buy));
  const full = sim.runConvoy(config, { hubLevel: 1, credits: 1e6, inventory: { scrap: 1990 } }, { import: { scrap: 500 } }, basePrices);
  assert.equal(full.inventory.scrap, 2000);
  // per-resource convoy limits apply, and scale with hub level
  const rich = sim.runConvoy(config, { hubLevel: 5, credits: 1e6, inventory: {} }, { import: { power_cells: 500 } }, basePrices);
  assert.equal(rich.inventory.power_cells, sim.convoyLimit(config, 5, 'power_cells'));
  const poor = sim.runConvoy(config, { hubLevel: 1, credits: 1e6, inventory: {} }, { import: { power_cells: 500 } }, basePrices);
  assert.equal(poor.inventory.power_cells, config.resources.power_cells.convoyMax);
});

test('convoy trade limits grow with hub level and never shrink', () => {
  for (const res of Object.keys(config.resources)) {
    let prev = 0;
    for (const lvl of Object.keys(config.hubLevels)) {
      const lim = sim.convoyLimit(config, Number(lvl), res);
      assert.ok(lim >= prev, `${res} limit fell at hub ${lvl}`);
      prev = lim;
    }
    assert.ok(sim.convoyLimit(config, 5, res) > sim.convoyLimit(config, 1, res), `${res} should grow`);
  }
  assert.equal(sim.convoyLimit(config, 1, 'scrap'), config.global.convoyMaxPerResource);
  assert.equal(sim.convoyLimit(config, 3, 'scrap'), Math.floor(config.global.convoyMaxPerResource * config.hubLevels['3'].convoyCapMult));
  // exports are limited the same way
  const sold = sim.runConvoy(config, { hubLevel: 2, credits: 0, inventory: { scrap: 5000 } }, { export: { scrap: 5000 } }, basePrices);
  assert.equal(5000 - sold.inventory.scrap, sim.convoyLimit(config, 2, 'scrap'));
});

test('market prices drift per convoy, are deterministic, and stay in range', () => {
  const a = sim.marketPrices(config, 5), b = sim.marketPrices(config, 5), c = sim.marketPrices(config, 6);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  const seen = new Set();
  for (let k = 0; k < 40; k++) for (const [res, p] of Object.entries(sim.marketPrices(config, k))) {
    assert.ok(p.mult >= config.market.min - 1e-9 && p.mult <= config.market.max + 1e-9);
    assert.ok(p.buy > p.sell, `${res} buy should exceed sell`);
    seen.add(p.buy);
  }
  assert.ok(seen.size > 30, 'prices actually move');
});

test('plots: output is penalised per missing size step; inputs are not', () => {
  const big = fresh({ buildings: [b(3, 0, 'foundry')] });  // ring 3 is a Large plot: fits
  const small = fresh({ buildings: [b(1, 0, 'foundry')] }); // ring 1 is Small: two steps short
  for (const s of [big, small]) Object.assign(s.inventory, { scrap: 500, machined_parts: 50 });
  const rb = sim.step(config, big, nm), rs = sim.step(config, small, nm);
  const pen = config.global.plotPenaltyPerStep ** 2;
  assert.ok(Math.abs(rs.flows.alloys.produced - rb.flows.alloys.produced * pen) < 1e-9);
  assert.equal(rs.flows.scrap.consumed, rb.flows.scrap.consumed);
  assert.equal(sim.plotMultiplier(config, config.buildings.foundry, 3), 1);
  assert.ok(Math.abs(sim.plotMultiplier(config, config.buildings.foundry, 1) - pen) < 1e-9);
});

test('plots get bigger outward, and every ring slot is genuinely larger than the one inside it', () => {
  const sizes = Object.keys(config.ringPlotSize).map((r) => config.ringPlotSize[r]);
  assert.deepEqual(sizes, [...sizes].sort((x, y) => x - y));
  assert.equal(new Set(sizes).size, sizes.length);
});

test('hub upkeep (level 3+) drains stock; unmet upkeep cuts the hub\'s own power', () => {
  const s = fresh({ hubLevel: 3 });
  s.inventory.machined_parts = 100;
  const ok = sim.step(config, s, nm);
  const up = config.hubLevels['3'].upkeepPerTick;
  assert.equal(ok.flows.machined_parts.consumed, up.machined_parts);
  assert.ok(Math.abs(ok.energy.supply - (config.hubLevels['3'].baseEnergy - up.energy)) < 1e-9);
  s.inventory.machined_parts = 0;
  const bad = sim.step(config, s, nm);
  assert.equal(bad.hub.eff, 0);
  assert.equal(bad.hub.limiting, 'machined_parts');
  assert.equal(bad.energy.supply, 0);
  assert.equal(sim.step(config, fresh({ hubLevel: 2 }), nm).hub.eff, 1); // no upkeep below level 3
});

test('fuel generators burn their input; without it they stop supplying power', () => {
  const s = fresh({ buildings: [b(3, 0, 'scrap_generator')] });
  const on = sim.step(config, s, nm);
  assert.equal(on.energy.supply, 20 + config.buildings.scrap_generator.outputsPerTick.energy);
  assert.equal(on.flows.scrap.consumed, config.buildings.scrap_generator.inputsPerTick.scrap);
  s.inventory.scrap = 0;
  assert.equal(sim.step(config, s, nm).energy.supply, 20);
});

test('warehouses raise the storage cap; watch posts add defence', () => {
  const s = fresh({ buildings: [b(2, 0, 'warehouse'), b(1, 0, 'watch_post')] });
  s.inventory.scrap = 1990;
  const r = sim.step(config, s, nm);
  assert.equal(r.cap, 2000 + config.buildings.warehouse.storageBonus);
  assert.ok(r.defense > 0 && r.defense <= config.buildings.watch_post.defense);
});

test('hazard modifiers: per-building degradation, consumption multiplier, maintenance drain', () => {
  const s = fresh({ buildings: [b(1, 0, 'solar_array'), b(1, 1, 'solar_array')] });
  const base = sim.step(config, s, nm);
  const deg = sim.step(config, s, nm, { degraded: { [s.buildings[0].id]: 0.5 } });
  const each = 25 * sim.adjacencyMultiplier(config, 'solar_array', ['solar_array']); // adjacent solars shade each other
  assert.ok(Math.abs(base.energy.supply - deg.energy.supply - each * 0.5) < 1e-9, 'only the degraded building loses output');
  const cold = sim.step(config, fresh(), nm, { popConsumptionMult: 2 });
  assert.ok(Math.abs(cold.flows.rations.consumed - 2 * sim.step(config, fresh(), nm).flows.rations.consumed) < 1e-9);
  const drained = sim.step(config, fresh({ inventory: { ...config.global.startingState.resources, machined_parts: 10 } }), nm, { drain: { machined_parts: 4 } });
  assert.equal(drained.flows.machined_parts.consumed, 4);
  assert.equal(drained.inventory.machined_parts, 6);
  const short = sim.step(config, fresh({ inventory: { ...config.global.startingState.resources, machined_parts: 1 } }), nm, { drain: { machined_parts: 4 } });
  assert.equal(short.inventory.machined_parts, 0, 'drain takes what there is, never goes negative');
});

test('a hazard output cut applies to the beacon\'s signal too', () => {
  const s = fresh({ hubLevel: 5, buildings: [b(1, 0, 'solar_array'), b(1, 1, 'solar_array'), b(1, 2, 'solar_array'),
    b(2, 0, 'scrap_generator'), b(2, 1, 'scrap_generator'), b(5, 0, 'beacon_array')] });
  Object.assign(s.inventory, { power_cells: 100, scrap: 1000 });
  const full = sim.step(config, s, nm).progressGain;
  const hit = sim.step(config, s, nm, { outputMult: { beacon_array: 0.25 } }).progressGain;
  assert.ok(Math.abs(hit - full * 0.25) < 1e-9, `${hit} vs ${full}`);
});

test('damaged (hazard-disabled) buildings stop; hazard output multipliers apply', () => {
  const s = fresh({ buildings: [b(1, 0, 'solar_array'), b(1, 1, 'scrap_extractor')] });
  const base = sim.step(config, s, nm);
  const hit = sim.step(config, s, nm, { outputMult: { solar_array: 0.3 }, disabled: new Set([s.buildings[1].id]) });
  assert.ok(hit.energy.supply < base.energy.supply);
  const st = hit.buildings.get(s.buildings[1].id);
  assert.equal(st.status, 'damaged');
  assert.equal(hit.flows.scrap.produced, 0);
});

test('beacon: transmits only while running; a full-size plot is faster than a cramped one; completing it wins', () => {
  const mk = (ring) => {
    const s = fresh({ hubLevel: 5, buildings: [b(1, 0, 'solar_array'), b(1, 1, 'solar_array'), b(1, 2, 'solar_array'),
      b(2, 0, 'scrap_generator'), b(2, 1, 'scrap_generator'), b(ring, 0, 'beacon_array')] });
    Object.assign(s.inventory, { power_cells: 100, scrap: 1000, machined_parts: 100, alloys: 100, circuits: 100 });
    return s;
  };
  const gain = (ring) => sim.step(config, mk(ring), nm).progressGain;
  assert.ok(gain(5) > 0.99 && gain(5) <= 1.0001, `ring 5 gain ${gain(5)}`);
  assert.ok(Math.abs(gain(4) - config.global.plotPenaltyPerStep) < 0.02);
  const dead = mk(5); dead.inventory.power_cells = 0;
  assert.equal(sim.step(config, dead, nm).progressGain, 0);
  let s = mk(5); let t = 0;
  while (!s.won && t < 200) { s = advance(s, sim.step(config, s, nm)); t++; s.inventory.power_cells = 100; s.inventory.scrap = 1000; s.inventory.machined_parts = 100; s.inventory.alloys = 100; s.inventory.circuits = 100; }
  assert.ok(s.won);
  assert.ok(t >= config.global.beacon.transmitTicks && t < config.global.beacon.transmitTicks + 3, `won after ${t} ticks`);
});
