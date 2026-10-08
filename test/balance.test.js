'use strict';
// Balance guard: a scripted, reasonable player (no convoy trading, no hazards) drives the real actions and
// engine, founds the three districts, ships goods between them and finishes the beacon. If you retune costs,
// rates or the chain and this fails, the game has become too slow (or impossible) to finish.
// BOT_LOG=1 prints a timeline when tuning.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-bot-'));
process.env.DB_PATH = path.join(dir, 'bot.db');
process.env.SESSION_SECRET = 'x';
process.env.HAZARDS = 'off';
const store = require('../src/db');
const engine = require('../src/engine');
const actions = require('../src/actions');
const { viewFor } = require('../src/state');
const sim = require('../src/sim');
const { db, config } = store;
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const CORE_PLAN = [
  'scrap_extractor', 'parts_assembler', 'water_pump', 'solar_array', 'water_purifier', 'hydroponics_bay',
  'wait:2', 'solar_array', 'scrap_extractor', 'scrap_extractor', 'parts_assembler', 'solar_array', 'fabrication_works', 'warehouse',
  'wait:3', 'kitchen', 'scrap_extractor', 'scrap_generator', 'foundry', 'parts_assembler', 'scrap_extractor', 'foundry', 'water_pump', 'water_purifier', 'watch_post', 'watch_post',
  'wait:4', 'fabrication_works', 'scrap_generator', 'scrap_extractor', 'scrap_extractor', 'hydroponics_bay', 'warehouse', 'parts_assembler', 'foundry', 'fabrication_works',
  'wait:5', 'beacon_array',
];
const PLANS = {
  pits: ['solar_array', 'solar_array', 'scrap_extractor', 'ore_drill', 'ore_drill', 'smelter', 'scrap_extractor', 'wait:3', 'alloy_works', 'ore_drill', 'smelter'],
  stacks: ['solar_array', 'solar_array', 'scrap_extractor', 'crude_pump', 'crude_pump', 'polymer_plant', 'synth_reclaimer', 'circuit_fab',
    'wait:3', 'fuel_generator', 'cracking_tower', 'cell_forge', 'circuit_fab', 'crude_pump', 'polymer_plant', 'synth_reclaimer'],
  greenbelt: ['solar_array', 'solar_array', 'water_pump', 'water_purifier', 'bio_dome', 'bio_dome', 'wait:3', 'pharma_lab', 'bio_dome', 'solar_array'],
};
// Standing routes the player sets up as soon as both ends exist: [from, to, resource, rate, reserve]
const ROUTES = [
  ['pits', 'stacks', 'ingots', 3, 0],
  ['stacks', 'core', 'circuits', 2, 25],
  ['stacks', 'core', 'power_cells', 1, 0],
  ['core', 'stacks', 'alloys', 3, 150],
  ['core', 'stacks', 'machined_parts', 2, 200],
  ['stacks', 'greenbelt', 'reagents', 3, 0],
  ['stacks', 'greenbelt', 'polymers', 2, 0],
  ['greenbelt', 'core', 'medicine', 1, 0],
  ['core', 'pits', 'machined_parts', 1, 200],
];
const ORDER = ['pits', 'stacks', 'greenbelt'];

function play(maxTicks) {
  const uid = Number(db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('bot', 'x').lastInsertRowid);
  const id = store.ensureColony(uid);
  const log = [];
  const districts = () => store.loadDistricts(id).map((d) => ({ ...d, level: d.type === 'core' ? db.prepare('SELECT hub_level FROM colonies WHERE id = ?').get(id).hub_level : d.level }));
  const byType = (t) => districts().find((d) => d.type === t);
  const inv = (d) => store.loadInventory(id, d.id);
  const can = (d, cost) => Object.entries(cost).every(([r, a]) => (inv(d)[r] || 0) >= a);
  const level = (t) => (byType(t) ? byType(t).level : 0);

  const used = (d) => {
    const taken = new Set(store.loadBuildings(id, d.id).map((b) => `${b.ring}:${b.slot}`));
    for (const o of store.loadOrders(id, d.id)) if (o.action_type === 'build') taken.add(`${o.data.ring}:${o.data.slot}`);
    return taken;
  };
  const count = (d, type) => store.loadBuildings(id, d.id).filter((b) => b.type === type).length
    + store.loadOrders(id, d.id).filter((o) => o.action_type === 'build' && o.data.type === type).length;
  const place = (d, type) => {
    const def = config.buildings[type];
    const caps = sim.levelDef(config, d.type, d.level).ringCapacities;
    const plots = sim.districtType(config, d.type).ringPlotSize;
    const rings = Object.keys(caps).map(Number);
    const fits = rings.filter((r) => plots[r] >= def.minPlotSize).sort((a, b) => a - b);
    const taken = used(d);
    for (const r of [...fits, ...rings.filter((r) => !fits.includes(r)).sort((a, b) => b - a)]) {
      for (let sl = 0; sl < caps[r]; sl++) if (!taken.has(`${r}:${sl}`)) return { ring: r, slot: sl };
    }
    return null;
  };
  const build = (d, type) => {
    const def = config.buildings[type];
    if (!sim.buildableIn(def, d.type) || !can(d, def.cost)) return false;
    const pos = place(d, type);
    return !!pos && actions.build(uid, { ...pos, type, district: d.id }).ok;
  };

  // Move what a district is short of from whichever other district can spare it.
  const topUp = (d, cost) => {
    for (const [r, a] of Object.entries(cost)) {
      const short = Math.ceil(a - (inv(d)[r] || 0));
      if (short <= 0) continue;
      if (store.loadShipments(id).some((s) => s.toDistrict === d.id && s.resource === r)) continue;
      for (const from of districts()) {
        if (from.id === d.id) continue;
        const keep = from.type === 'core' ? (r === 'building_materials' ? 40 : 150) : 40;
        const spare = Math.floor((inv(from)[r] || 0) - keep);
        const qty = Math.min(short, spare, config.logistics.shipmentMax);
        if (qty >= 1 && actions.shipment(uid, { from: from.id, to: d.id, resource: r, qty }).ok) break;
      }
    }
  };

  const planStep = (d, plan, wantLevel) => {
    const seen = {};
    for (const item of plan) {
      if (item.startsWith('wait:')) { if (wantLevel() < Number(item.split(':')[1])) return; continue; }
      seen[item] = (seen[item] || 0) + 1;
      if (count(d, item) >= seen[item]) continue;
      if (build(d, item)) continue;
      const def = config.buildings[item];
      if (d.type !== 'core' && place(d, item)) topUp(d, def.cost);
      if (place(d, item)) return; // keep the order: wait until this one can be afforded
    }
  };

  let beaconBuilt = false;
  for (let t = 1; t <= maxTicks; t++) {
    engine.processTick();
    const c = db.prepare('SELECT * FROM colonies WHERE id = ?').get(id);
    if (c.status === 'failed') return { failed: true, t, log };
    if (c.won) return { won: true, t, log };
    const core = byType('core');

    // upgrades: the Core when it can afford it, districts from their own stock (shipping in what is missing)
    const nx = config.hubLevels[core.level + 1];
    if (nx && actions.upgradeHub(uid, {}).ok) log.push(`core L${core.level + 1} @${t}`);
    for (const t2 of ORDER) {
      const d = byType(t2);
      if (!d) continue;
      const next = sim.levelDef(config, t2, d.level + 1);
      const cap = sim.districtLevelCap(config, { coreLevel: core.level, beaconBuilt: store.hasBeacon(id) });
      if (!next || d.level + 1 > cap || store.loadOrders(id, d.id).some((o) => o.action_type === 'upgrade')) continue;
      if (actions.upgradeHub(uid, { district: d.id }).ok) log.push(`${t2} L${d.level + 1} @${t}`);
      else if (d.level + 1 <= cap && t % 3 === 0) topUp(d, next.upgradeCost);
    }
    // found districts: the Pits and Stacks at Core 4, the Greenbelt at Core 5
    for (const t2 of ORDER) {
      if (byType(t2) || (t2 === 'greenbelt' && core.level < 5)) continue;
      if (actions.foundDistrict(uid, { type: t2 }).ok) log.push(`found ${t2} @${t}`);
    }
    // standing routes
    if (t % 5 === 0) {
      for (const [a, b, res, rate, reserve] of ROUTES) {
        const da = byType(a); const db2 = byType(b);
        if (!da || !db2 || store.loadRoutes(id).some((r) => r.fromDistrict === da.id && r.toDistrict === db2.id && r.resource === res)) continue;
        actions.setRoute(uid, { from: da.id, to: db2.id, resource: res, rate, reserve });
      }
    }
    // the Core's own plan and homes/food/water as the population grows
    planStep(core, CORE_PLAN, () => core.level);
    for (const t2 of ORDER) if (byType(t2)) planStep(byType(t2), PLANS[t2], () => byType(t2).level);
    if (t % 2 === 0) {
      const v = viewFor(uid);
      const net = (r) => v.resources[r].net;
      const pending = (ty) => store.loadOrders(id, core.id).some((o) => o.action_type === 'build' && o.data.type === ty);
      if (net('clean_water') < 1 && !pending('water_purifier')) { build(core, 'water_purifier'); if (net('unpurified_water') < 8 && !pending('water_pump')) build(core, 'water_pump'); }
      if (net('rations') < 1 && !pending('hydroponics_bay')) build(core, 'hydroponics_bay');
      const housingBusy = store.loadOrders(id, core.id).some((o) => o.action_type === 'build' && config.buildings[o.data.type].housing);
      if (c.population >= v.colony.maxPopulation - 2 && !housingBusy) build(core, core.level >= 3 && can(core, config.buildings.habitat.cost) ? 'habitat' : 'dormitory');
    }
    for (const b of store.loadBuildings(id, core.id)) {
      if (b.type !== 'parts_assembler') continue;
      const want = (inv(core).machined_parts || 0) > 400 ? 'paused' : 'active';
      if (b.status !== want) actions.toggle(uid, { ring: b.ring, slot: b.slot, paused: want === 'paused' });
    }
    if (process.env.BOT_DEBUG && t === Number(process.env.BOT_DEBUG)) {
      const v = viewFor(uid);
      for (const d of districts().filter((x) => x.type !== 'core')) {
        const view = v.views[d.id];
        console.log(d.type, 'stock', JSON.stringify(Object.fromEntries(Object.entries(inv(d)).filter(([, a]) => a >= 1).map(([k, a]) => [k, Math.floor(a)]))),
          'energy', JSON.stringify(view.energy), view.buildings.map((b) => `${b.type}:${b.status}:${b.eff && b.eff.toFixed(2)}:${b.limiting || ''}`).join(' '));
      }
      console.log('routes', JSON.stringify(store.loadRoutes(id)), 'ships', store.loadShipments(id).length);
    }
    if (process.env.BOT_LOG && t % 50 === 0) {
      const v = viewFor(uid);
      console.log(`t${t} core L${core.level} pop ${c.population}/${v.colony.maxPopulation} morale ${Math.round(c.morale)} crew ${Math.round(v.colony.staffing.ratio * 100)}%`,
        districts().map((d) => `${d.type}:L${d.level}/${store.loadBuildings(id, d.id).length}b`).join(' '),
        `circ ${Math.floor(inv(core).circuits)} cells ${Math.floor(inv(core).power_cells)} med ${Math.floor(inv(core).medicine || 0)} alloys ${Math.floor(inv(core).alloys)}`);
    }
  }
  return { t: maxTicks, log };
}

test('a scripted player founds all three districts and finishes the beacon, in a playable number of ticks', () => {
  const r = play(1400);
  if (process.env.BOT_LOG) console.log('WON at', r.t, r.log.join(' | '));
  assert.ok(!r.failed, `collapsed at tick ${r.t} (${r.log.join(' ')})`);
  assert.ok(r.won, `did not finish within 1400 ticks (${r.log.join(' ')})`);
  // 15 s ticks: 1,000 ticks is roughly 4 hours for a slow, error-free, trade-free run.
  assert.ok(r.t <= 1000, `took ${r.t} ticks (${r.log.join(' ')}); retune if this is intentional`);
  assert.ok(r.t >= 450, `finished suspiciously fast (${r.t} ticks)`);
});
