'use strict';
// Balance guard: a scripted, reasonable player (no convoy trading, no hazards) must be able to
// reach and finish the beacon in a sane number of ticks. If you retune costs or rates and this
// fails, the game has become too slow (or impossible) to finish.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sim = require('../src/sim');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'game_config.json'), 'utf8'));
const nm = sim.buildNeighborMap(config);

const PLAN = [
  'scrap_extractor', 'parts_assembler', 'water_pump', 'solar_array', 'water_purifier', 'hydroponics_bay',
  'wait:2', 'solar_array', 'scrap_extractor', 'scrap_extractor', 'parts_assembler', 'solar_array', 'fabrication_works', 'synth_reclaimer', 'warehouse',
  'wait:3', 'scrap_extractor', 'scrap_generator', 'foundry', 'circuit_fab', 'parts_assembler', 'scrap_extractor', 'foundry', 'circuit_fab', 'water_pump', 'water_purifier', 'watch_post', 'watch_post',
  'wait:4', 'cell_forge', 'scrap_generator', 'scrap_extractor', 'scrap_extractor', 'hydroponics_bay', 'warehouse', 'synth_reclaimer',
  'wait:5', 'cell_forge', 'scrap_generator', 'beacon_array',
];

function play(maxTicks) {
  let s = { hubLevel: 1, population: config.global.startingState.population, morale: 100, age: 0, progress: 0, won: false,
    inventory: { ...config.global.startingState.resources }, buildings: [] };
  let id = 1; let next = 0; let pending = []; let upgrade = null;
  const log = [];
  const free = (r, sl) => !s.buildings.some((b) => b.ring === r && b.slot === sl) && !pending.some((p) => p.ring === r && p.slot === sl);
  const place = (type) => {
    const d = config.buildings[type];
    const caps = config.hubLevels[s.hubLevel].ringCapacities;
    const rings = Object.keys(caps).map(Number);
    const fits = rings.filter((r) => sim.plotSize(config, r) >= d.minPlotSize).sort((a, b) => a - b);
    for (const r of [...fits, ...rings.filter((r) => !fits.includes(r)).sort((a, b) => b - a)]) {
      for (let sl = 0; sl < caps[r]; sl++) if (free(r, sl)) return { ring: r, slot: sl };
    }
    return null;
  };
  const can = (cost) => Object.entries(cost).every(([r, a]) => s.inventory[r] >= a);
  const pay = (cost) => { for (const [r, a] of Object.entries(cost)) s.inventory[r] -= a; };
  for (let t = 1; t <= maxTicks; t++) {
    const nx = config.hubLevels[s.hubLevel + 1];
    if (!upgrade && nx && can(nx.upgradeCost)) { pay(nx.upgradeCost); upgrade = { at: t + nx.upgradeTicks, level: s.hubLevel + 1 }; }
    for (let guard = 0; next < PLAN.length && guard < 5; guard++) {
      const it = PLAN[next];
      if (it.startsWith('wait:')) { if (s.hubLevel >= Number(it.split(':')[1])) { next++; continue; } break; }
      const d = config.buildings[it]; const pos = place(it);
      if (!pos) { next++; continue; }
      if (!can(d.cost)) break;
      pay(d.cost); pending.push({ at: t + d.constructionTicks, type: it, ...pos }); next++;
    }
    for (const b of s.buildings) if (b.type === 'parts_assembler') b.status = s.inventory.machined_parts > 400 ? 'paused' : 'active';
    const r = sim.step(config, s, nm);
    s = { ...s, inventory: r.inventory, population: r.population, morale: r.morale, age: t, progress: r.progress, won: r.won };
    for (const p of pending) if (p.at <= t) s.buildings.push({ id: id++, ring: p.ring, slot: p.slot, type: p.type, status: 'active' });
    pending = pending.filter((p) => p.at > t);
    if (upgrade && upgrade.at <= t) { s.hubLevel = upgrade.level; log.push(`L${s.hubLevel}@${t}`); upgrade = null; }
    if (r.failed) return { failed: true, t, log };
    if (s.won) return { won: true, t, log };
  }
  return { t: maxTicks, log };
}

test('a scripted player finishes the beacon without collapsing, in a playable number of ticks', () => {
  const r = play(700);
  assert.ok(!r.failed, `collapsed at tick ${r.t}`);
  assert.ok(r.won, `did not finish within 700 ticks (${r.log.join(' ')})`);
  // 15 s ticks: 450 ticks is roughly 110 minutes for a slow, error-free, trade-free run.
  assert.ok(r.t <= 450, `took ${r.t} ticks (${r.log.join(' ')}); retune if this is intentional`);
  assert.ok(r.t >= 200, `finished suspiciously fast (${r.t} ticks)`);
});
