#!/usr/bin/env node
'use strict';
// A simulated playtest of the orbital stage. It starts where scripts/playtest.js cannot yet reach: a station freshly
// launched over a mature colony, with the starter kit and one dropship. A scripted player then runs the orbital loop on
// the real actions and engine: reactor and foundry, expeditions to the anomalous territories, the rare resources home,
// orbital goods out of the foundry, storage slots and links juggled as they have to be. It reports how fast rare
// resources and orbital goods accumulate, what the ground has to send up for them, and what gets in the way.
//
//   node scripts/playtest-orbit.js [--ticks 8000] [--upgrades none|storage|all] [--credits 500000] [--income 150]
//                                  [--quiet] [--json FILE]
//
// What is assumed, because this stage is played on top of a ground economy the script does not simulate:
//   * the Core always holds plenty of every ground good (it is topped up every tick, and what the links draw is counted);
//   * the treasury starts at --credits and earns --income credits a tick from the ground (convoy and missions);
//   * one station, alone: nobody else takes territories, trades on the orbital market or shares a project.
// --upgrades: none = play on what the launch gives; storage = buy the storage upgrade only; all = storage, the ship
// upgrade, the link upgrade and a second ship, in that order, as credits and goods allow.
const os = require('os');
const path = require('path');
const fs = require('fs');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : (argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[i + 1]); };
const TICKS = Number(arg('ticks', 8000));
const UPGRADES = arg('upgrades', 'all');
const INCOME = Number(arg('income', 150));
const QUIET = !!arg('quiet', false);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-orbit-play-'));
process.env.DB_PATH = path.join(dir, 'play.db');
process.env.SESSION_SECRET = 'x';
process.env.THEME = arg('theme', 'basic');
process.env.HAZARDS = 'off';
const store = require('../src/db');
const engine = require('../src/engine');
const actions = require('../src/actions');
const orbital = require('../src/orbital');
const territories = require('../src/territories');
const sim = require('../src/sim');
const { db, config } = store;
const O = config.orbital;
const R = config.resources;
const STOCK = 10000;
const FIXED = ['power_cells', 'frames', 'fittings']; // what the station always keeps a slot for: power, and the goods slots are rebuilt with

// ---- a station over a mature colony -------------------------------------------------------------------------------
const uid = Number(db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('orbitplay', 'x').lastInsertRowid);
const id = store.ensureColony(uid);
const core = store.coreId(id);
db.prepare('UPDATE colonies SET hub_level = 5, credits = ?, population = 60 WHERE id = ?').run(Number(arg('credits', 500000)), id);
const fp = Number(db.prepare("INSERT INTO districts (colony_id, type, level, name, created_tick) VALUES (?, 'freeport', 5, 'Free Port', 0)").run(id).lastInsertRowid);
const ground = Object.keys(R).filter((r) => !R[r].orbitalOnly);
const fill = (d) => { const inv = store.loadInventory(id, d); for (const r of ground) inv[r] = STOCK; store.saveInventory(id, inv, d); };
fill(core); fill(fp);
const put = (d, ring, slot, type) => db.prepare('INSERT INTO colony_buildings (colony_id, district_id, ring_index, slot_index, building_type) VALUES (?, ?, ?, ?, ?)').run(id, d, ring, slot, type);
for (let i = 0; i < 6; i++) put(core, 1, i, 'solar_array');
put(core, 5, 0, 'orbital_staging'); put(core, 5, 1, 'orbital_catapult'); put(fp, 5, 0, 'orbital_command');
db.prepare("INSERT INTO standing (colony_id, faction, points) VALUES (?, 'cinder', ?)").run(id, O.unlockStanding);
engine.processTick();
actions.launchCycle(uid, { cycle: 'station' });
db.prepare("UPDATE colonies SET launch_ready = 'station' WHERE id = ?").run(id);
db.prepare("UPDATE colony_buildings SET recipe = NULL WHERE colony_id = ? AND building_type = 'orbital_staging'").run(id);
const launched = actions.launch(uid, { name: 'Playtest Station' });
if (!launched.ok) { console.error('launch failed:', launched.error); process.exit(1); }
const ST = orbital.stationOf(id).district_id;

const colony = () => db.prepare('SELECT * FROM colonies WHERE id = ?').get(id);
const station = () => orbital.stationOf(id);
const sinv = () => store.loadInventory(id, ST);
const cinv = () => store.loadInventory(id, core);
const orders = (d) => store.loadOrders(id, d);
const buildings = (d) => store.loadBuildings(id, d);
const routes = () => store.loadRoutes(id);
const slots = () => db.prepare('SELECT idx, resource_id AS resource, state FROM orbital_slots WHERE colony_id = ? ORDER BY idx').all(id);
const linksLv = () => O.links.levels[station().links_level];
const storeLv = () => O.storage.levels[station().storage_level];
const view = () => territories.view(colony(), T);
const isRare = (r) => !!(R[r] && R[r].rare);

// ---- the record -----------------------------------------------------------------------------------------------------
let T = 1;
const M = {
  upgrades: UPGRADES, ticks: TICKS, log: [], trips: [], runs: [], made: {}, rareHome: {}, draw: {}, lost: {}, bought: [],
  slotRebuilds: 0, recipeFees: 0, cellsBurned: 0, shipTicks: { docked: 0, travel: 0, setup: 0, tapping: 0, building: 0 }, noRun: 0, workable: { seen: 0, field: 0, link: 0 }, trace: [],
};
const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
const say = (s) => { M.log.push(`${String(T).padStart(5)}  ${s}`); if (!QUIET) console.log(`${String(T).padStart(5)}  ${s}`); };

// ---- what an orbital good takes --------------------------------------------------------------------------------------
const GOODS = Object.keys(config.orbitalRecipes);
function needsOf(good) {
  const inp = config.orbitalRecipes[good].inputsPerTick;
  const rares = Object.keys(inp).filter(isRare).sort((a, b) => inp[b] - inp[a]);
  const x = Object.keys(inp).find((r) => r !== 'energy' && !isRare(r));
  return { good, rares, per: inp, x, out: config.orbitalRecipes[good].outputsPerTick[good] };
}

// ---- planning a tap: how a territory's rare can be drawn with this ship ------------------------------------------------
// Each tap recipe wants two ordinary goods. Each can come out of the ground (an extractor), be refined on the spot from what
// the ground gives, or come down a link from the station (which has it from the Core). The ship's power is what limits it.
const fdef = (b) => sim.territoryDef(config.buildings[b], 'territory');
const RAW = { scrap: 'scrap_extractor', unpurified_water: 'water_pump', raw_synthetics: 'synth_reclaimer', ore: 'ore_drill', crude: 'crude_pump' };
const REFINE = { clean_water: 'water_purifier', machined_parts: 'parts_assembler', ingots: 'smelter', fuel: 'cracking_tower', reagents: 'cracking_tower', polymers: 'polymer_plant' };
function sources(r, want, have, linkRate, allowLink) {
  const out = [];
  if (RAW[r] && have.includes(r)) {
    const d = fdef(RAW[r]);
    for (let n = 1; n <= 3; n++) out.push({ supply: Math.min(want, n * d.outputsPerTick[r]), power: n * d.inputsPerTick.energy, builds: Array(n).fill(RAW[r]), how: 'ground' });
  }
  if (REFINE[r]) {
    const d = fdef(REFINE[r]);
    const from = Object.keys(d.inputsPerTick).find((k) => k !== 'energy');
    if (from && RAW[from] && have.includes(from)) {
      const e = fdef(RAW[from]);
      for (let k = 1; k <= 3; k++) {
        const m = Math.ceil((k * d.inputsPerTick[from]) / e.outputsPerTick[from]);
        out.push({ supply: Math.min(want, k * d.outputsPerTick[r]), power: k * d.inputsPerTick.energy + m * e.inputsPerTick.energy, builds: [...Array(m).fill(RAW[from]), ...Array(k).fill(REFINE[r])], how: 'refined' });
      }
    }
  }
  if (allowLink) out.push({ supply: Math.min(want, linkRate), power: 0, builds: [], link: r, how: 'link' });
  return out;
}
function planTap(t, ship, allowLinks) {
  const an = t.anomaly;
  const power = Math.round(ship.power * (an.powerMult || 1));
  const have = [t.resources.common1, t.resources.common2, t.resources.district];
  const kit = O.dropships.starterKit;
  let best = null;
  for (const [rid, rec] of Object.entries(config.tapRecipes)) {
    if (rec.rare !== t.resources.rare) continue;
    const ins = Object.keys(rec.inputsPerTick).filter((k) => k !== 'energy');
    for (const plot of [3, 2]) {
      const batch = config.tradeWorks.batchByPlot[plot];
      const o1 = sources(ins[0], rec.inputsPerTick[ins[0]] * batch, have, ship.linkRate, allowLinks > 0);
      const o2 = sources(ins[1], rec.inputsPerTick[ins[1]] * batch, have, ship.linkRate, allowLinks > 0);
      for (const a of o1) for (const b of o2) {
        const links = [a.link, b.link].filter(Boolean);
        if (links.length > Math.min(allowLinks, O.dropships.maxLinks)) continue;
        const builds = [...a.builds, ...b.builds];
        const parts = builds.reduce((n, x) => n + fdef(x).cost.machined_parts, 0) + config.buildings.t_tap.cost.machined_parts;
        const mats = builds.reduce((n, x) => n + fdef(x).cost.building_materials, 0) + config.buildings.t_tap.cost.building_materials;
        if (parts > kit.machined_parts || mats > kit.building_materials || builds.length > 7) continue;
        const eff = Math.min(a.supply / (rec.inputsPerTick[ins[0]] * batch), b.supply / (rec.inputsPerTick[ins[1]] * batch));
        const demand = rec.inputsPerTick.energy * batch * eff + a.power + b.power;
        const sat = Math.min(1, power / demand);
        const rate = rec.outputsPerTick[rec.rare] * batch * eff * sat * (an.rareMult || 1);
        const cand = { recipe: rid, plot, builds, links, rate, eff: eff * sat, how: `${ins[0]}: ${a.how}, ${ins[1]}: ${b.how}`, inputs: ins };
        if (!best || rate > best.rate + 1e-9 || (Math.abs(rate - best.rate) < 1e-9 && links.length < best.links.length)) best = cand;
      }
    }
  }
  return best;
}

const saving = {}; // goods the station is collecting for the next purchase, on top of its working stock
// ---- storage slots and links ---------------------------------------------------------------------------------------------
// A slot belongs to the first resource that lands in it, for good: to hold something else it has to be jettisoned and rebuilt.
const expected = new Set(); // resources on their way to the station that will need a slot when they land
function keepSet() {
  const k = new Set([...FIXED, ...expected, ...Object.keys(saving)]);
  for (const run of queue) { run.need.rares.forEach((r) => k.add(r)); if (run.need.x) k.add(run.need.x); k.add(run.need.good); }
  for (const tr of M.trips) if (!tr.homeAt) tr.plan.links.forEach((r) => k.add(r));
  return k;
}
function room(res) {
  const all = slots();
  if (all.some((s) => s.resource === res)) return true;
  const waiting = [...expected].filter((r) => r !== res && !all.some((s) => s.resource === r)).length;
  if (all.filter((s) => !s.resource && s.state === 'open').length > waiting) return true;
  // make room: give up the slot of something no longer wanted (what is in it is lost), and rebuild it
  const inv = sinv();
  const keep = keepSet();
  const victim = all.filter((s) => s.resource && s.state === 'open' && !keep.has(s.resource)).sort((a, b) => (inv[a.resource] || 0) - (inv[b.resource] || 0))[0];
  const c = O.storage.rebuildCost;
  if (!victim || Object.entries(c).some(([r, q]) => (inv[r] || 0) < q)) return false;
  if ((inv[victim.resource] || 0) >= 1) bump(M.lost, victim.resource, Math.floor(inv[victim.resource]));
  if (!actions.jettison(uid, { slot: victim.idx }).ok || !actions.rebuildSlot(uid, { slot: victim.idx }).ok) return false;
  M.slotRebuilds++;
  return true;
}
// Links between the Core and the station are few, so they are handed to whatever is running low, most urgent first.
function links() {
  const inv = sinv();
  for (const r of [...expected]) if (!isRare(r) && slots().some((x) => x.resource === r)) expected.delete(r);
  const want = []; // [resource, 'up' | 'down', target]
  const up = (r, low, target) => { if ((inv[r] || 0) < low || routes().some((x) => x.resource === r && x.toDistrict === ST && (inv[r] || 0) < target)) want.push([r, 'up', target]); };
  up('power_cells', 150, 400 + (saving.power_cells || 0));
  for (const tr of M.trips) if (!tr.recallAt) for (const r of tr.plan.links) up(r, 250, 600);
  const run = queue[0];
  if (run && run.need.x && !FIXED.includes(run.need.x) && run.need.rares.every((r) => (inv[r] || 0) >= 1 || expected.has(r))) up(run.need.x, 80, 300);
  up('frames', 80 + (saving.frames || 0), 200 + (saving.frames || 0));
  up('fittings', 50 + (saving.fittings || 0), 120 + (saving.fittings || 0));
  if (saving.modules) up('modules', saving.modules, saving.modules + 20);
  for (const g of GOODS) if ((inv[g] || 0) >= 10 && !(saving[g] > 0)) want.push([g, 'down', 0]);
  const lv = linksLv();
  const chosen = want.slice(0, lv.count);
  for (const x of routes()) {
    const orbitLink = (x.fromDistrict === ST && x.toDistrict === core) || (x.toDistrict === ST && x.fromDistrict === core);
    if (!orbitLink) continue;
    const dirn = x.toDistrict === ST ? 'up' : 'down';
    if (!chosen.some(([r, d]) => r === x.resource && d === dirn)) actions.setRoute(uid, { from: x.fromDistrict, to: x.toDistrict, resource: x.resource, rate: 0 });
  }
  for (const [r, d, target] of chosen) {
    const from = d === 'up' ? core : ST; const to = d === 'up' ? ST : core;
    if (routes().some((x) => x.fromDistrict === from && x.toDistrict === to && x.resource === r)) continue;
    if (d === 'up' && !room(r)) continue;
    if (actions.setRoute(uid, { from, to, resource: r, rate: lv.rate, reserve: 0, target }).ok && d === 'up') expected.add(r); // its slot is spoken for until it lands
  }
}

// ---- the station's own buildings --------------------------------------------------------------------------------------------
function stationBuild() {
  const b = buildings(ST); const o = orders(ST);
  const has = (t) => b.some((x) => x.type === t) || o.some((x) => x.data.type === t);
  if (!has('klein_reactor')) actions.build(uid, { ring: 1, slot: 0, type: 'klein_reactor', district: ST });
  if (!has('orbital_foundry')) actions.build(uid, { ring: 1, slot: 1, type: 'orbital_foundry', district: ST });
}
const foundry = () => buildings(ST).find((x) => x.type === 'orbital_foundry');
const reactor = () => buildings(ST).find((x) => x.type === 'klein_reactor');
function power(on) {
  const r = reactor();
  if (r && (r.status === 'active') !== on) actions.toggle(uid, { ring: r.ring, slot: r.slot, paused: !on, district: ST });
}

// ---- runs: one orbital good at a time, its two rare resources fetched by the ships --------------------------------------------
const queue = []; // runs in the order the foundry will make them
function flexSlots() { return storeLv().slots - FIXED.length; }
function tripFor(rare, ship, allowLinks) {
  let best = null;
  for (const t of view().territories) {
    if (t.taken || t.resources.rare !== rare || t.anomaly.damagePerTick > 0) continue;
    const plan = planTap(t, ship, allowLinks);
    if (!plan || plan.rate < 0.2) continue;
    const usable = t.ticksLeft - O.dropships.deployTicks - 30;
    if (usable < 120) continue;
    if (!best || plan.rate > best.plan.rate) best = { t, plan, usable };
  }
  return best;
}
function chooseRun(ship) {
  // what the slots allow: a run needs a slot for each rare and for the good, one for its ground input unless that is
  // something the station keeps anyway, and one more if a tap input has to pass through on its way down
  const cands = [];
  for (const g of GOODS) {
    if (queue.some((q) => q.need.good === g)) continue;
    const need = needsOf(g);
    const base = need.rares.length + 1 + (need.x && !FIXED.includes(need.x) ? 1 : 0) + queue.reduce((n, q) => n + q.need.rares.length + 1, 0);
    if (base > flexSlots()) continue;
    const allowLinks = Math.min(O.dropships.maxLinks, flexSlots() - base);
    const plans = need.rares.map((r) => ((sinv()[r] || 0) >= 100 ? { home: true, plan: { rate: 9 } } : tripFor(r, ship, allowLinks)));
    if (plans.some((p) => !p)) continue;
    cands.push({ need, allowLinks, score: Math.min(...plans.map((p) => p.plan.rate)), made: M.made[g] || 0 });
  }
  cands.sort((a, b) => a.made - b.made || b.score - a.score);
  return cands[0] || null;
}
const hold = (ship) => ship.hold;
function targetFor(run, rare, ship) {
  const most = Math.max(...run.need.rares.map((r) => run.need.per[r]));
  return Math.floor(hold(ship) * run.need.per[rare] / most);
}
function dispatch() {
  const v = view();
  for (const ship of v.ships) {
    if (ship.state !== 'docked' || ship.integrity < 60) continue;
    // survey: how many of the territories open right now could this ship work at all?
    if (T % 200 === 0) {
      for (const t of v.territories) {
        if (t.taken) continue;
        M.workable.seen++;
        const f = planTap(t, ship, 0); const l = planTap(t, ship, 2);
        if (f && f.rate >= 0.2) M.workable.field++;
        if (l && l.rate >= 0.2) M.workable.link++;
      }
    }
    // the first run in the queue that still lacks a rare nobody has gone for
    let job = null;
    for (const run of queue) {
      const r = run.need.rares.find((x) => !run.fetch[x]);
      if (r) { job = { run, rare: r }; break; }
    }
    if (!job && queue.length < 2) {
      const c = chooseRun(ship);
      if (c) {
        const run = { need: c.need, allowLinks: c.allowLinks, fetch: {}, startedAt: T, made0: (M.made[c.need.good] || 0) };
        for (const r of c.need.rares) if ((sinv()[r] || 0) >= 100) run.fetch[r] = 'home';
        queue.push(run);
        say(`plan: ${c.need.good} (${c.need.rares.map((r) => `${c.need.per[r]} ${r}`).join(' + ')} + ${c.need.per[c.need.x]} ${c.need.x})`);
        const r = run.need.rares.find((x) => !run.fetch[x]);
        if (r) job = { run, rare: r };
      } else if (!queue.length) M.noRun++;
    }
    if (!job) continue;
    const pick = tripFor(job.rare, ship, job.run.allowLinks);
    if (!pick) continue;
    for (const r of pick.plan.links) if (!room(r)) { pick.blocked = true; }
    if (pick.blocked) continue;
    const res = actions.shipDeploy(uid, { ship: ship.id, territory: pick.t.id, preload: {} });
    if (!res.ok) continue;
    const want = Math.min(targetFor(job.run, job.rare, ship), Math.floor(pick.usable * pick.plan.rate));
    job.run.fetch[job.rare] = 'out';
    M.trips.push({ ship: ship.num, rare: job.rare, good: job.run.need.good, territory: pick.t.name, anomaly: pick.t.anomaly.key, plan: pick.plan, want, deployAt: T, closesAt: T + pick.t.ticksLeft, run: job.run });
    say(`ship ${ship.num} → ${pick.t.name} (${pick.t.anomaly.key}) for ${want} ${job.rare}: ${pick.plan.recipe} on a ${config.plotSizes[pick.plan.plot].name} plot, ${pick.plan.how}; planned ${pick.plan.rate.toFixed(2)}/tick`);
  }
}
// The free plot of a territory that suits a building: the smallest that fits it, or the wanted size for the tap.
function fieldPlot(d, type, wantPlot) {
  const caps = config.orbitalTypes.territory.levels['1'].ringCapacities; const plots = config.orbitalTypes.territory.ringPlotSize;
  const taken = new Set([...buildings(d).map((b) => `${b.ring}:${b.slot}`), ...orders(d).map((o) => `${o.data.ring}:${o.data.slot}`)]);
  const rings = Object.keys(caps).map(Number).filter((r) => (wantPlot ? plots[r] === wantPlot : plots[r] >= (config.buildings[type].minPlotSize || 1))).sort((a, b) => a - b);
  for (const r of rings) for (let s = 0; s < caps[r]; s++) if (!taken.has(`${r}:${s}`)) return { ring: r, slot: s };
  return null;
}
function expeditions() {
  const v = view();
  for (const tr of M.trips) {
    if (tr.homeAt) continue;
    const ship = v.ships.find((s) => s.num === tr.ship);
    if (!ship) { tr.homeAt = T; tr.lostShip = true; continue; }
    if (ship.state === 'deployed' && !tr.recallAt) {
      const d = ship.districtId;
      if (!tr.landAt) {
        tr.landAt = T;
        for (const b of tr.plan.builds) { const pos = fieldPlot(d, b); if (pos) actions.build(uid, { ...pos, type: b, district: d }); }
        const pos = fieldPlot(d, 't_tap', tr.plan.plot);
        if (pos) { actions.build(uid, { ...pos, type: 't_tap', district: d }); tr.tapAt0 = pos; }
      }
      const tap = buildings(d).find((b) => b.type === 't_tap');
      if (tap && !tap.recipe) {
        actions.setRecipe(uid, { ring: tap.ring, slot: tap.slot, recipe: tr.plan.recipe, district: d });
        for (const r of tr.plan.links) actions.setRoute(uid, { from: ST, to: d, resource: r, rate: ship.linkRate, reserve: 0 });
        tr.builtAt = T;
      }
      const got = Math.floor(store.loadInventory(id, d)[tr.rare] || 0);
      if (got > 0 && !tr.firstAt) tr.firstAt = T;
      const left = tr.closesAt - T;
      if (got >= tr.want || left <= 4 || (tr.builtAt && T - tr.builtAt > 150 && got < 5)) {
        expected.add(tr.rare);
        if (!room(tr.rare)) say(`no slot will be free for ${tr.rare}: it will be lost on arrival`);
        actions.shipPlan(uid, { ship: ship.id, plan: { [tr.rare]: true } });
        actions.shipReturn(uid, { ship: ship.id });
        tr.recallAt = T; tr.brought = Math.min(got, ship.hold);
        say(`ship ${ship.num} recalled with ${tr.brought} ${tr.rare} after ${T - tr.landAt} ticks down (${(tr.brought / Math.max(1, T - (tr.firstAt || T))).toFixed(2)}/tick once running)`);
      }
    } else if (ship.state === 'docked' && tr.recallAt) {
      tr.homeAt = T;
      expected.delete(tr.rare);
      bump(M.rareHome, tr.rare, tr.brought);
      tr.run.fetch[tr.rare] = 'home';
    } else if (ship.state === 'docked' && !tr.recallAt && T - tr.deployAt > 400) { tr.homeAt = T; tr.run.fetch[tr.rare] = null; } // the world sent it home
  }
}
function foundryStep() {
  const f = foundry();
  if (!f) return;
  const inv = sinv();
  const run = queue[0];
  if (!run || !run.running) power(false); // the reactor burns a cell a tick whether or not anything needs the power
  if (!run) return;
  const { need } = run;
  const batch = config.tradeWorks.batchByPlot[sim.plotSize(config, f.ring, 'station')];
  const enough = need.rares.every((r) => (inv[r] || 0) >= need.per[r] * batch) && (inv[need.x] || 0) >= need.per[need.x] * batch;
  const allHome = need.rares.every((r) => run.fetch[r] === 'home');
  if (!run.running && allHome && enough) {
    if (!room(need.good)) return;
    if (f.recipe !== need.good) {
      const before = colony().credits;
      const r = actions.setRecipe(uid, { ring: f.ring, slot: f.slot, recipe: need.good, district: ST });
      if (!r.ok) return;
      M.recipeFees += before - colony().credits;
    }
    run.running = T; power(true);
    expected.add(need.good); // the foundry's trickle needs a slot of its own: without one it is lost, a fraction at a time
    say(`foundry starts ${need.good}`);
  }
  if (run.running && allHome && !need.rares.every((r) => (inv[r] || 0) >= need.per[r] * batch)) {
    const made = (M.made[need.good] || 0) - run.made0;
    M.runs.push({ good: need.good, plannedAt: run.startedAt, foundryFrom: run.running, doneAt: T, made: Math.round(made * 10) / 10 });
    say(`run done: ${made.toFixed(1)} ${need.good} in ${T - run.startedAt} ticks from planning (foundry ${T - run.running})`);
    queue.shift(); power(false);
  }
  if (run.running && !enough && allHome === false) power(false);
}

// ---- upgrades ---------------------------------------------------------------------------------------------------------------
// goods the station is collecting for the next purchase, on top of its working stock
const PLAN = UPGRADES === 'none' ? [] : UPGRADES === 'storage' ? ['storage'] : ['storage', 'ship', 'links', 'ship2'];
function upgrades() {
  for (const k of Object.keys(saving)) delete saving[k];
  if (queue.some((q) => q.running)) return; // one thing at a time: slots are too few to save up for a purchase while the foundry runs
  const next = PLAN.find((k) => !M.bought.some((b) => b.what === k));
  if (!next) return;
  const st = station(); const v = view();
  const cost = next === 'storage' ? (O.storage.levels[st.storage_level + 1] || {}).cost : next === 'links' ? (O.links.levels[st.links_level + 1] || {}).cost
    : next === 'ship' ? (O.dropships.levels[2] || {}).cost : O.dropships.buildCost;
  if (!cost) { M.bought.push({ what: next, at: T, skipped: true }); return; }
  for (const [r, q] of Object.entries(cost)) if (r !== 'credits') saving[r] = q;
  const inv = sinv();
  if (colony().credits < (cost.credits || 0) || Object.entries(cost).some(([r, q]) => r !== 'credits' && (inv[r] || 0) < q)) return;
  let res;
  if (next === 'storage') res = actions.orbitalStorageUpgrade(uid);
  else if (next === 'links') res = actions.orbitalLinksUpgrade(uid);
  else if (next === 'ship2') res = actions.shipBuild(uid);
  else { const s = v.ships.find((x) => x.state === 'docked' && x.level === 1); if (!s) return; res = actions.shipUpgrade(uid, { ship: s.id }); }
  if (res && res.ok) { M.bought.push({ what: next, at: T, cost }); say(`bought: ${next} (${Object.entries(cost).map(([r, q]) => `${q} ${r}`).join(', ')})`); }
}

// ---- the loop -----------------------------------------------------------------------------------------------------------------
let baseline = null; // what the Core uses by itself every tick (people, hub upkeep, the catapult), measured before any link exists
const lastGood = {};
function account() {
  const inv = cinv();
  const used = {};
  for (const r of ground) { used[r] = STOCK - (inv[r] || 0); inv[r] = STOCK; }
  if (T <= 6) { if (T === 6) baseline = used; } else for (const r of ground) { const d = used[r] - ((baseline || {})[r] || 0); if (Math.abs(d) > 0.01) bump(M.draw, r, d); }
  store.saveInventory(id, inv, core);
  fill(fp);
  if (INCOME) db.prepare('UPDATE colonies SET credits = credits + ? WHERE id = ?').run(INCOME, id);
  // orbital goods made: whatever appeared in the station or came down to the Core since last tick
  const s = sinv();
  for (const g of GOODS) {
    const now = (s[g] || 0) + (inv[g] || 0);
    if (lastGood[g] !== undefined && now > lastGood[g] + 1e-9) bump(M.made, g, now - lastGood[g]);
    lastGood[g] = now;
  }
  const r = reactor();
  if (r && r.status === 'active' && (s.power_cells || 0) >= 1) M.cellsBurned += config.buildings.klein_reactor.inputsPerTick.power_cells;
  for (const sh of view().ships) {
    const tr = M.trips.find((x) => x.ship === sh.num && !x.homeAt);
    const k = sh.state === 'docked' ? 'docked' : sh.state === 'building' ? 'building' : sh.state === 'deployed' ? (tr && tr.firstAt ? 'tapping' : 'setup') : 'travel';
    M.shipTicks[k]++;
  }
  for (const e of db.prepare("SELECT message FROM colony_events WHERE colony_id = ? AND tick = ? AND message LIKE 'No storage slot%'").all(id, T - 1)) { const m = /for (.+): (\d+) lost/.exec(e.message); if (m) bump(M.lost, Object.keys(R).find((k) => R[k].name === m[1]) || m[1], Number(m[2])); }
  if (T % 250 === 0) M.trace.push({ t: T, credits: colony().credits, station: Object.fromEntries(Object.entries(s).filter(([, a]) => a >= 1).map(([k, a]) => [k, Math.floor(a)])), goodsHome: Object.fromEntries(GOODS.map((g) => [g, Math.floor(inv[g] || 0)]).filter(([, a]) => a > 0)), slots: slots().map((x) => x.resource || (x.state === 'open' ? '-' : 'x')).join(',') });
}
const t0 = Date.now();
for (T = 2; T <= TICKS; T++) {
  db.prepare('UPDATE colonies SET last_seen_at = ? WHERE id = ?').run(Date.now(), id);
  engine.processTick();
  account();
  if (T < 7) continue; // (the Core's own use is being measured)
  stationBuild();
  expeditions();
  if (T % 5 === 0) { upgrades(); dispatch(); links(); }
  foundryStep();
}

// ---- the report -----------------------------------------------------------------------------------------------------------------
const hrs = (t) => `${(t * config.global.tickRateMs / 3600000).toFixed(1)}h`;
const per1k = (n) => (n / (TICKS / 1000)).toFixed(1);
const out = [];
const totalGoods = Object.values(M.made).reduce((a, b) => a + b, 0);
const totalRare = Object.values(M.rareHome).reduce((a, b) => a + b, 0);
out.push(`\n== orbital stage, upgrades: ${UPGRADES}, ${TICKS} ticks (${hrs(TICKS)}), started with ${arg('credits', 500000)} cr and ${INCOME} cr/tick from the ground`);
out.push(`orbital goods made: ${totalGoods.toFixed(0)} in all (${per1k(totalGoods)} per 1,000 ticks, one every ${totalGoods ? (TICKS / totalGoods).toFixed(0) : '-'} ticks): ${GOODS.map((g) => `${g} ${(M.made[g] || 0).toFixed(0)}`).join(', ')}`);
out.push(`rare resources brought home: ${totalRare} (${per1k(totalRare)} per 1,000 ticks) in ${M.trips.filter((t) => t.brought).length} expeditions: ${Object.entries(M.rareHome).map(([r, n]) => `${r} ${n}`).join(', ') || 'none'}`);
const done = M.trips.filter((t) => t.homeAt && t.brought);
if (done.length) {
  const avg = (f) => (done.reduce((n, t) => n + f(t), 0) / done.length);
  out.push(`an expedition, on average: ${avg((t) => t.homeAt - t.deployAt).toFixed(0)} ticks door to door for ${avg((t) => t.brought).toFixed(0)} rare; ${avg((t) => (t.firstAt || t.recallAt) - t.landAt).toFixed(0)} ticks setting up, ${avg((t) => t.recallAt - (t.firstAt || t.recallAt)).toFixed(0)} drawing at ${avg((t) => t.brought / Math.max(1, t.recallAt - (t.firstAt || t.recallAt))).toFixed(2)}/tick (planned ${avg((t) => t.plan.rate).toFixed(2)}); links used on ${done.filter((t) => t.plan.links.length).length} of ${done.length}`);
}
const st = Object.values(M.shipTicks).reduce((a, b) => a + b, 0) || 1;
out.push(`ship time: ${Object.entries(M.shipTicks).filter(([, n]) => n).map(([k, n]) => `${k} ${Math.round((n / st) * 100)}%`).join(', ')}`);
if (M.runs.length) out.push(`foundry runs: ${M.runs.map((r) => `${r.good} ${r.made} (${r.doneAt - r.plannedAt}t)`).join(', ')}`);
out.push(`territories open at survey time that the ship could work: ${M.workable.seen ? Math.round((M.workable.field / M.workable.seen) * 100) : 0}% from what the ground gives alone, ${M.workable.seen ? Math.round((M.workable.link / M.workable.seen) * 100) : 0}% with goods linked down${M.noRun ? `; ticks with no run the slots and territories allowed: ${M.noRun * 5}` : ''}`);
const draw = Object.entries(M.draw).filter(([, n]) => n >= 20).sort((a, b) => b[1] - a[1]);
out.push(`sent up from the ground: ${draw.map(([r, n]) => `${Math.round(n)} ${r}`).join(', ') || 'nothing'}${totalGoods ? ` (per orbital good: ${draw.slice(0, 6).map(([r, n]) => `${(n / totalGoods).toFixed(1)} ${r}`).join(', ')})` : ''}`);
out.push(`power cells burned by the reactor: ${M.cellsBurned}; storage slots rebuilt to hold something else: ${M.slotRebuilds} (${M.slotRebuilds * O.storage.rebuildCost.frames} frames, ${M.slotRebuilds * O.storage.rebuildCost.fittings} fittings); recipe changes at the foundry cost ${M.recipeFees} cr`);
if (Object.keys(M.lost).length) out.push(`lost for want of a storage slot, or jettisoned: ${Object.entries(M.lost).map(([r, n]) => `${n} ${r}`).join(', ')}`);
out.push(`bought: ${M.bought.filter((b) => !b.skipped).map((b) => `${b.what} at tick ${b.at} (${hrs(b.at)})`).join(', ') || 'nothing'}; credits at the end: ${colony().credits}`);
// what the goods are for, at the rate measured
const rate = totalGoods / TICKS;
if (rate > 0) {
  const sinks = [];
  const E = config.expansion;
  const perBuilding = Object.values(E.orbitalCostMult).reduce((a, b) => a + b, 0) * 2 * 2;
  sinks.push([`one building from expansion level ${E.maxLevel} to ${E.orbitalMaxLevel}`, perBuilding]);
  sinks.push(['the ring 3 launch', Object.values(O.launch.cycles.ring3.orbitalCost).reduce((a, b) => a + b, 0)]);
  sinks.push(['one share of a global project', Math.max(...O.projects.list.map((p) => Object.entries(p.needs).filter(([r]) => R[r].orbitalTrade).reduce((n, [, q]) => n + q, 0)))]);
  sinks.push(['every data packet part', Object.values(O.data.packets).reduce((n, p) => n + p.costs.reduce((m, c) => m + Object.values(c.goods || {}).reduce((a, b) => a + b, 0), 0), 0)]);
  out.push('what that rate buys: ' + sinks.map(([k, q]) => `${k}: ${q} goods, ${Math.round(q / rate)} ticks (${hrs(q / rate)})`).join('; '));
}
{
  const mk = O.market; const ref = Math.sqrt(R[GOODS[0]].buy * R[GOODS[0]].sell);
  const taken = (TICKS / mk.makerRefreshTicks) * (mk.makerQtyByTier[R[GOODS[0]].tier] || 0) * GOODS.length;
  out.push(`the market makers would buy at most ${taken.toFixed(0)} of these goods in that time (${(mk.makerQtyByTier[R[GOODS[0]].tier] || 0)} of each every ${mk.makerRefreshTicks} ticks) for about ${Math.round(taken * ref * (1 - mk.makerSpread) * (1 - mk.feeRate))} cr; everything past that needs another player to buy it`);
}
console.log(out.join('\n'));
M.seconds = (Date.now() - t0) / 1000;
if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify({ ...M, trips: M.trips.map((t) => ({ ...t, run: undefined })) }, null, 1));
db.close();
fs.rmSync(dir, { recursive: true, force: true });
