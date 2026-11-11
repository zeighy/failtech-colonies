#!/usr/bin/env node
'use strict';
// A simulated playtest. A scripted player drives the real actions and the real engine on a throwaway database and
// reports how the game paces: when each milestone lands, how long every place's build slot spent building, waiting for
// materials (and which ones) or standing idle, which goods piled up against the storage cap, and where the credits came from.
//
//   node scripts/playtest.js [--persona builder|engineer|trader] [--until beacon|station] [--cadence N]
//                            [--hazards on|off] [--max TICKS] [--json FILE] [--trace FILE] [--quiet]
//                            [--alts on|off] [--reqs on|off] [--exports on|off] [--slots on|off] [--dump]
//
// Personas:
//   builder   base recipes only, no trade, no requisitions (the player the balance test plays)
//   engineer  also switches to alternative recipes as they open, fills requisitions and exports what overflows
//   trader    never founds a district: exports Core goods and imports what the districts would have made
// --cadence N: the player only looks in every N ticks (1 = always there; 20 = every five minutes at 15 s a tick) and
//   leaves a deeper queue behind when N is large.
// --until station carries on past the Beacon: the Free Port, faction missions for standing, the launch buildings and the
//   launch cycle. --dump prints every place's buildings, queue and stock at the end, which is how to see why a run stalled.
// It is a tool for tuning, not a test: nothing here asserts. test/balance.test.js is the guard.
// How far to trust it: up to the Beacon the player is competent and the timings are a floor for a real one. Past the
// Beacon it is a cruder player than a person would be (fixed route rates, no expansions, no rebalancing of fuel, ingots
// and polymers between districts), so it reaches the orbital plans but has not yet carried a launch through; read its
// late-game output for what piles up and what runs short, not for how long the endgame takes.
const os = require('os');
const path = require('path');
const fs = require('fs');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : (argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[i + 1]); };
const PERSONA = arg('persona', 'engineer');
const UNTIL = arg('until', 'beacon');
const CADENCE = Math.max(1, Number(arg('cadence', 1)));
const MAX = Number(arg('max', UNTIL === 'station' ? 14000 : 3000));
const QUIET = !!arg('quiet', false);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-playtest-'));
process.env.DB_PATH = path.join(dir, 'play.db');
process.env.SESSION_SECRET = 'x';
process.env.THEME = arg('theme', 'basic');
process.env.HAZARDS = arg('hazards', 'off') === 'on' ? 'on' : 'off';
const store = require('../src/db');
const engine = require('../src/engine');
const actions = require('../src/actions');
const queue = require('../src/queue');
const { viewFor } = require('../src/state');
const sim = require('../src/sim');
const { db, config } = store;

const P = {
  builder: { alts: false, reqs: false, exports: false, imports: false, districts: true },
  engineer: { alts: true, reqs: true, exports: true, imports: false, districts: true },
  trader: { alts: true, reqs: true, exports: true, imports: true, districts: false },
}[PERSONA];
if (!P) { console.error(`Unknown persona "${PERSONA}".`); process.exit(2); }
// --alts / --reqs / --exports on|off override one habit of the persona, to measure it on its own
for (const k of ['alts', 'reqs', 'exports']) { const v = arg(k); if (v === 'on' || v === 'off') P[k] = v === 'on'; }
const SLOTS = arg('slots', 'on') !== 'off'; // buy extra build slots when a place can pay for one and has work waiting

// ---- what the player builds, in order --------------------------------------------------------------------------
// 'wait:N' holds the list until the place is level N (and asks for the upgrade).
const CORE_PLAN = [
  'scrap_extractor', 'parts_assembler', 'water_pump', 'solar_array', 'water_purifier', 'hydroponics_bay',
  'wait:2', 'solar_array', 'scrap_extractor', 'scrap_extractor', 'parts_assembler', 'solar_array', 'fabrication_works', 'warehouse',
  'wait:3', 'kitchen', 'scrap_extractor', 'scrap_generator', 'foundry', 'parts_assembler', 'scrap_extractor', 'foundry', 'water_pump', 'water_purifier', 'watch_post', 'watch_post',
  'wait:4', 'fabrication_works', 'scrap_generator', 'scrap_extractor', 'scrap_extractor', 'hydroponics_bay', 'warehouse', 'parts_assembler', 'foundry', 'fabrication_works',
  'wait:5', 'beacon_array',
];
// The trader makes more of what sells and buys the rest.
const TRADER_PLAN = [
  'scrap_extractor', 'parts_assembler', 'water_pump', 'solar_array', 'water_purifier', 'hydroponics_bay',
  'wait:2', 'solar_array', 'scrap_extractor', 'scrap_extractor', 'parts_assembler', 'solar_array', 'fabrication_works', 'warehouse', 'fabrication_works',
  'wait:3', 'kitchen', 'scrap_extractor', 'scrap_generator', 'foundry', 'parts_assembler', 'scrap_extractor', 'fabrication_works', 'foundry', 'water_pump', 'water_purifier', 'watch_post', 'watch_post', 'warehouse',
  'wait:4', 'fabrication_works', 'scrap_generator', 'scrap_extractor', 'scrap_extractor', 'hydroponics_bay', 'warehouse', 'parts_assembler', 'foundry', 'fabrication_works', 'kitchen',
  'wait:5', 'beacon_array',
];
const PLANS = {
  pits: ['solar_array', 'scrap_extractor', 'ore_drill', 'smelter', 'scrap_extractor', 'ore_drill', 'wait:3', 'alloy_works', 'smelter', 'alloy_works'],
  stacks: ['solar_array', 'scrap_extractor', 'crude_pump', 'polymer_plant', 'circuit_fab', 'circuit_fab', 'solar_array',
    'wait:3', 'fuel_generator', 'cracking_tower', 'crude_pump', 'cell_forge', 'crude_pump', 'polymer_plant', 'circuit_fab', 'cracking_tower'],
  greenbelt: ['solar_array', 'water_pump', 'bio_dome', 'bio_dome', 'wait:3', 'pharma_lab', 'bio_dome', 'solar_array'],
};
// Standing routes, set up as soon as both ends exist: [from, to, resource, rate, reserve, needs]
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
// What the engineer adds to feed alternative recipes: [from, to, resource, rate, reserve, when]
const ALT_ROUTES = [
  ['pits', 'core', 'ingots', 9, 40, (L) => L.pits >= 3],
  ['stacks', 'pits', 'fuel', 5, 30, (L) => L.pits >= 3 && L.stacks >= 3],
  ['stacks', 'pits', 'reagents', 2, 40, (L) => L.pits >= 4 && L.stacks >= 3],
  ['stacks', 'core', 'polymers', 2, 60, (L) => L.stacks >= 3],
  ['stacks', 'core', 'fuel', 2, 40, (L) => L.stacks >= 3],
  ['greenbelt', 'core', 'biomass', 6, 60, (L) => L.greenbelt >= 2],
];
const ORDER = ['pits', 'stacks', 'greenbelt'];
// After the Beacon: the districts grow to feed the Free Port.
const LATE = {
  core: ['parts_assembler', 'parts_assembler', 'warehouse', 'kitchen', 'fabrication_works'],
  pits: ['wait:4', 'ore_drill', 'smelter', 'ore_drill', 'smelter', 'wait:5', 'ore_drill', 'smelter', 'ore_drill', 'smelter', 'alloy_works'],
  stacks: ['wait:4', 'crude_pump', 'polymer_plant', 'synth_reclaimer', 'cracking_tower', 'crude_pump', 'wait:5', 'polymer_plant', 'synth_reclaimer', 'crude_pump', 'cracking_tower', 'crude_pump', 'cracking_tower', 'circuit_fab', 'cell_forge'],
  greenbelt: ['wait:4', 'agri_lab', 'bio_dome', 'pharma_lab', 'wait:5'],
};
// The Free Port: [building, workshop recipe, plot size]. It grows its own scrap, water and biomass, and is sent the rest.
// 'orbit' holds the list until the orbital plans arrive (nothing before that needs frames, fittings or modules).
const FP_PLAN = [
  ['scrap_extractor'], ['scrap_extractor'], ['water_pump'],
  'wait:2', ['bio_dome'], ['bio_dome'], ['water_purifier'], ['bio_dome'], ['scrap_extractor'],
  'wait:3', ['trade_workshop', 'tool_steel', 2], ['trade_workshop', 'plastics', 2], ['fuel_generator', null, 2], ['trade_workshop', 'curios', 2], ['trade_workshop', 'preserves', 2], ['trade_workshop', 'tinctures', 2], ['fuel_generator', null, 2],
  'wait:4', ['trade_workshop', 'tool_steel', 3], ['trade_workshop', 'precision_tools', 3], ['trade_workshop', 'luxuries', 3], ['trade_workshop', 'plastics', 3], ['fuel_generator', null, 3], ['trade_workshop', 'tool_steel', 3], ['trade_workshop', 'plastics', 3],
  'wait:5', 'orbit', ['trade_workshop', 'frames', 4], ['trade_workshop', 'fittings', 4], ['trade_workshop', 'modules', 4], ['fuel_generator', null, 4], ['trade_workshop', 'frames', 4], ['trade_workshop', 'tool_steel', 4], ['fuel_generator', null, 4],
];
const fpLevel = (L, n) => (L.freeport || 0) >= n;
// What the Free Port is sent, as shares of its link: 36 a tick of the link is kept for the launch goods going out.
const fpShare = (w) => (L, K) => Math.max(1, Math.floor(w * Math.min(1, (K.freeport - 36) / 186) * (fpLevel(L, 5) ? 1 : fpLevel(L, 4) ? 0.7 : 0.3)));
const LATE_ROUTES = [
  ['pits', 'freeport', 'ingots', fpShare(70), 40, (L) => fpLevel(L, 3)],
  ['stacks', 'freeport', 'polymers', fpShare(55), 40, (L) => fpLevel(L, 3)],
  ['stacks', 'freeport', 'fuel', fpShare(30), 40, (L) => fpLevel(L, 3)],
  ['stacks', 'freeport', 'reagents', fpShare(5), 40, (L) => fpLevel(L, 3)],
  ['core', 'freeport', 'machined_parts', fpShare(10), 150, (L) => fpLevel(L, 3)],
  ['stacks', 'freeport', 'circuits', fpShare(6), 30, (L) => fpLevel(L, 4)],
  ['core', 'freeport', 'alloys', fpShare(10), 150, (L) => fpLevel(L, 5)],
  ['pits', 'core', 'alloys', 12, 60, (L) => L.pits >= 4],
  ['stacks', 'core', 'fuel', 6, 40, (L) => L.stacks >= 4],
  ['stacks', 'core', 'power_cells', 3, 0, (L) => L.stacks >= 5],
];
// Which alternatives the engineer prefers, best last. One is switched on once it is open and the place holds its inputs.
const ALT_PREF = {
  water_purifier: ['scrap_bed'], parts_assembler: ['ingot_stamping'], hydroponics_bay: ['biomass_feed'], fabrication_works: ['polymer_bound'],
  scrap_generator: ['fuel_assisted'], foundry: ['ingot_charge'], kitchen: ['preserved_stores'], ore_drill: ['fuel_drill'], smelter: ['fuel_fired'],
  alloy_works: ['reagent_quench'], polymer_plant: ['scrap_fed'], fuel_generator: ['afterburn'], circuit_fab: ['alloy_traces'],
  cell_forge: ['reagent_electrolyte', 'polymer_cased'], bio_dome: ['fertilised_beds'], pharma_lab: ['polymer_capsule'], synth_reclaimer: ['reagent_wash'],
};

// ---- the colony ------------------------------------------------------------------------------------------------
const uid = Number(db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('playtest', 'x').lastInsertRowid);
const id = store.ensureColony(uid);
const colony = () => db.prepare('SELECT * FROM colonies WHERE id = ?').get(id);
const ground = (d) => d.type === 'core' || !!config.districtTypes[d.type];
const districts = () => { const hub = colony().hub_level; return store.loadDistricts(id).filter(ground).map((d) => ({ ...d, level: d.type === 'core' ? hub : d.level })); };
const byType = (t) => districts().find((d) => d.type === t);
const inv = (d) => store.loadInventory(id, d.id);
const can = (d, cost) => Object.entries(cost).every(([r, a]) => (inv(d)[r] || 0) >= a);
const orders = (d) => store.loadOrders(id, d.id);
const waiting = (d) => orders(d).filter((o) => o.state === 'queued');
const DEPTH = CADENCE <= 2 ? 1 : Math.min(5, 1 + Math.floor(CADENCE / 10)); // how many orders the player leaves waiting

const used = (d) => {
  const taken = new Set(store.loadBuildings(id, d.id).map((b) => `${b.ring}:${b.slot}`));
  for (const o of orders(d)) if (o.action_type === 'build') taken.add(`${o.data.ring}:${o.data.slot}`);
  return taken;
};
const count = (d, type) => store.loadBuildings(id, d.id).filter((b) => b.type === type).length
  + orders(d).filter((o) => (o.action_type === 'build' || o.action_type === 'replace') && o.data.type === type).length;
// The smallest free plot the building fits; failing that, the biggest free one.
function place(d, type, wantPlot) {
  const def = config.buildings[type];
  const caps = sim.levelDef(config, d.type, d.level).ringCapacities;
  const plots = sim.districtType(config, d.type).ringPlotSize;
  const rings = Object.keys(caps).map(Number);
  const fits = rings.filter((r) => (wantPlot ? plots[r] === wantPlot : plots[r] >= def.minPlotSize)).sort((a, b) => a - b);
  const rest = wantPlot || def.strictPlot ? [] : rings.filter((r) => !fits.includes(r)).sort((a, b) => b - a);
  const taken = used(d);
  const held = RESERVED[d.type] || [];
  for (const r of [...fits, ...rest]) for (let sl = 0; sl < caps[r]; sl++) if (!taken.has(`${r}:${sl}`) && !held.includes(`${r}:${sl}`)) return { ring: r, slot: sl };
  return null;
}
// Plots the player keeps clear from the start: two Colossal plots side by side in the Core for the staging platform and
// the catapult, and a Heavy plot in the Free Port for the command center.
const RESERVED = { core: ['5:12', '5:13'], freeport: ['5:10'] };
// Queue a building. It is paid for when it starts, so the player queues the next thing on the list whether or not the
// place can pay yet; `urgent` (food, water, homes) goes to the front.
function build(d, type, { urgent = false, plot, pos: at } = {}) {
  const def = config.buildings[type];
  if (!sim.buildableIn(def, d.type)) return false;
  if (urgent && !can(d, def.cost)) return false; // nothing that cannot be paid for goes to the front: it would hold up everything
  if (waiting(d).length >= DEPTH + (urgent ? 1 : 0)) return false;
  const pos = at || place(d, type, plot);
  if (!pos) return false;
  const r = actions.build(uid, { ...pos, type, district: d.id });
  if (!r.ok) return false;
  if (urgent) { const mine = waiting(d).find((o) => o.data.type === type); if (mine) actions.queueMove(uid, { orderId: mine.id, to: 'top' }); }
  return true;
}
// Move what a district is short of from whichever other district can spare it.
function topUp(d, cost) {
  for (const [r, a] of Object.entries(cost)) {
    // (a little over: a place whose lines eat the same goods can sit one unit short for ever, because it is paid for after they have run)
    const short = Math.ceil(a * 1.25 + 5 - (inv(d)[r] || 0));
    if ((inv(d)[r] || 0) >= a * 1.1 + 2) continue;
    if (store.loadShipments(id).some((s) => s.toDistrict === d.id && s.resource === r)) continue;
    for (const from of districts()) {
      if (from.id === d.id) continue;
      const keep = from.type === 'core' ? (r === 'building_materials' ? 40 : r === 'scrap' ? 700 : 150) : 15;
      const spare = Math.floor((inv(from)[r] || 0) - keep);
      const qty = Math.min(short, spare, config.logistics.shipmentMax);
      if (qty >= 1 && actions.shipment(uid, { from: from.id, to: d.id, resource: r, qty }).ok) break;
    }
  }
}
const levelCap = () => sim.districtLevelCap(config, { coreLevel: colony().hub_level, beaconBuilt: store.hasBeacon(id) });
function askUpgrade(d) {
  const next = sim.levelDef(config, d.type, d.level + 1);
  if (!next || orders(d).some((o) => o.action_type === 'upgrade')) return;
  if (d.type !== 'core' && d.level + 1 > levelCap()) return;
  if (waiting(d).length >= DEPTH + 1) return;
  if (actions.upgradeHub(uid, d.type === 'core' ? {} : { district: d.id }).ok) note(`${d.type} L${d.level + 1} ordered`);
}
function planStep(d, plan) {
  const seen = {};
  for (const item of plan) {
    if (item.startsWith('wait:')) {
      if (d.level < Number(item.split(':')[1])) { askUpgrade(d); break; }
      continue;
    }
    seen[item] = (seen[item] || 0) + 1;
    if (count(d, item) >= seen[item]) continue;
    if (!place(d, item)) continue; // no room for this one: carry on down the list
    if (shortHanded(item)) { M.crewHold++; break; } // no new workplaces while the ones there are short of hands
    if (!build(d, item)) break; // the queue is as deep as the player lets it get
  }
  // whatever is at the front and cannot be paid for: a district is sent what it lacks
  const front = orders(d).find((o) => o.state === 'queued');
  const stalled = front && !orders(d).some((o) => o.state !== 'queued');
  if (stalled && d.type !== 'core') topUp(d, queue.costOf(d, front));
  // ... and a player who keeps waiting on the same basic thing builds another of what makes it, if there is room
  const key = `${d.id}`;
  stall[key] = stalled ? (stall[key] || 0) + CADENCE : 0;
  if (stalled && stall[key] >= 12) {
    const stock = inv(d);
    for (const [r, a] of Object.entries(queue.costOf(d, front))) {
      if ((stock[r] || 0) >= a) continue;
      // lines here that were switched to a recipe eating what the order is waiting for go back to their base recipe
      for (const b of store.loadBuildings(id, d.id)) {
        const def = config.buildings[b.type];
        const alt = sim.alternativeOf(def, b.recipe);
        if (alt && alt.inputsPerTick[r] && !(def.inputsPerTick || {})[r] && !b.resetting && actions.setRecipe(uid, { ring: b.ring, slot: b.slot, recipe: null, district: d.id }).ok) { bump(M.altsOff, `${b.type}>${b.recipe}`); altBan.add(b.id); }
      }
      // and if it is made in another district, that district gets another line (and what feeds it)
      const far = REMOTE[r];
      const home = far && far[0] !== d.type && stall[key] >= 30 ? byType(far[0]) : null;
      if (home && (extras[`${home.id}:${far[1]}`] || 0) < 3 && !orders(home).some((o) => o.data.type === far[1]) && roomFor(home, far[1])) {
        if (!can(home, config.buildings[far[1]].cost)) topUp(home, config.buildings[far[1]].cost);
        else if (build(home, far[1], { urgent: true })) {
          extras[`${home.id}:${far[1]}`] = (extras[`${home.id}:${far[1]}`] || 0) + 1; bump(M.extras, `${home.type}:${far[1]}`);
          if (FEED[far[1]] && roomFor(home, FEED[far[1]])) build(home, FEED[far[1]]);
        }
      }
      const maker = MAKER[r];
      if (!maker || (stock[r] || 0) >= a || !sim.buildableIn(config.buildings[maker], d.type)) continue;
      const extra = (extras[`${key}:${maker}`] || 0);
      if (extra >= 4 || !can(d, config.buildings[maker].cost) || orders(d).some((o) => o.data.type === maker)) continue;
      const pos = place(d, maker);
      if (!pos || sim.plotSize(config, pos.ring, d.type) < config.buildings[maker].minPlotSize) continue;
      if (build(d, maker, { urgent: true })) { extras[`${key}:${maker}`] = extra + 1; bump(M.extras, `${d.type}:${maker}`); stall[key] = 0; }
    }
  }
}
const stall = {}; const extras = {};
const altBan = new Set(); // lines that were switched back once stay on their base recipe: every retooling idles the line
// A careful player stops adding workplaces when crews run thin, and builds homes instead.
let CREW = 1;
let HOMELESS = false; // nowhere left to build a home: holding work back would only stall the colony
let held = 0; // turns in a row that work was held back; past a point the player builds anyway
function shortHanded(type) {
  const hold = CREW < 0.85 && !HOMELESS && (config.buildings[type].workers || 0) > 0;
  if (!hold) { held = 0; return false; }
  if (++held > 120) { held = 0; return false; }
  return true;
}
const MAKER = { scrap: 'scrap_extractor', machined_parts: 'parts_assembler', building_materials: 'fabrication_works' };
const REMOTE = { machined_parts: ['core', 'parts_assembler'], building_materials: ['core', 'fabrication_works'], reagents: ['stacks', 'cracking_tower'], fuel: ['stacks', 'cracking_tower'], polymers: ['stacks', 'polymer_plant'], circuits: ['stacks', 'circuit_fab'], power_cells: ['stacks', 'cell_forge'],
  ingots: ['pits', 'smelter'], alloys: ['pits', 'alloy_works'], medicine: ['greenbelt', 'pharma_lab'], biomass: ['greenbelt', 'bio_dome'] };
const FEED = { smelter: 'ore_drill', cracking_tower: 'crude_pump', polymer_plant: 'crude_pump' };

// ---- the record ------------------------------------------------------------------------------------------------
const M = {
  persona: PERSONA, cadence: CADENCE, hazards: process.env.HAZARDS, until: UNTIL,
  milestones: {}, phases: [], notes: [], credits: { convoy: 0, requisitions: 0, missions: 0, spentImports: 0 },
  shutLog: [], reqs: { filled: 0, seen: 0, waits: [], goods: {} }, extras: {}, links: {}, crewHold: 0, spill: {}, altsOff: {}, slots: {}, missions: { filled: 0, standing: 0, goods: {} }, alts: {}, shutdowns: 0, trace: [],
};
let T = 0;
function note(s) { M.notes.push(`${s} @${T}`); }
function mark(name) { if (M.milestones[name] === undefined) { M.milestones[name] = T; if (!QUIET) console.log(`  ${String(T).padStart(5)}  ${name}`); newPhase(name); } }
let phase = null;
function newPhase(name) {
  phase = { from: name, start: T, ticks: 0, slot: {}, short: {}, capped: {}, pop: 0, morale: 0, moraleMin: 100, staff: 0, staffMin: 1, staffN: 0, brown: 0, starving: 0, hazardTicks: 0, creditsEnd: 0 };
  M.phases.push(phase);
}
newPhase('start');
const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
function sample() {
  const c = colony();
  phase.ticks++;
  phase.pop += c.population; phase.morale += c.morale; phase.moraleMin = Math.min(phase.moraleMin, c.morale);
  if (c.brownout) phase.brown++;
  if (c.starving) phase.starving++;
  phase.creditsEnd = c.credits;
  for (const d of districts()) {
    const os_ = orders(d);
    const s = (phase.slot[d.type] = phase.slot[d.type] || { build: 0, wait: 0, idle: 0 });
    if (os_.some((o) => o.state !== 'queued')) s.build++;
    else if (os_.length) {
      s.wait++;
      const stock = inv(d);
      const sh = (phase.short[d.type] = phase.short[d.type] || {});
      for (const [r, a] of Object.entries(queue.costOf(d, os_[0]))) if ((stock[r] || 0) < a) bump(sh, r);
    } else s.idle++;
  }
  if (T % 5 === 0) {
    const core = byType('core');
    const stock = inv(core);
    const cap = sim.storageCap(config, { type: 'core', level: core.level, buildings: store.loadBuildings(id, core.id) });
    for (const [r, a] of Object.entries(stock)) if (a >= cap * 0.97) bump(phase.capped, r, 5);
  }
  if (T % 10 === 0) {
    const v = viewFor(uid);
    const ratio = v.colony.staffing.ratio;
    phase.staff += ratio; phase.staffN++; phase.staffMin = Math.min(phase.staffMin, ratio);
    if (v.hazard && v.hazard.state === 'active') phase.hazardTicks += 10;
    if (T % 50 === 0) {
      const core = byType('core');
      const stock = inv(core);
      M.trace.push({ t: T, hub: c.hub_level, pop: c.population, cap: v.colony.maxPopulation, morale: Math.round(c.morale), staff: +ratio.toFixed(2), credits: c.credits,
        stock: Object.fromEntries(Object.entries(stock).filter(([, a]) => a >= 1).map(([k, a]) => [k, Math.floor(a)])),
        places: districts().map((d) => `${d.type}:L${d.level}/${store.loadBuildings(id, d.id).length}`).join(' '),
        coreFree: (() => { const caps = sim.levelDef(config, 'core', c.hub_level).ringCapacities; return Object.values(caps).reduce((a, b) => a + b, 0) - used(byType('core')).size; })(),
        pits: byType('pits') ? ['ingots', 'reagents', 'fuel', 'alloys', 'scrap'].map((k) => `${k}=${Math.floor(inv(byType('pits'))[k] || 0)}`).join(' ') : undefined,
        stacks: byType('stacks') ? ['polymers', 'reagents', 'fuel', 'circuits', 'crude', 'scrap'].map((k) => `${k}=${Math.floor(inv(byType('stacks'))[k] || 0)}`).join(' ') : undefined,
        standing: c.won ? standing() : undefined, launch: c.launch_progress || undefined,
        fp: byType('freeport') ? Object.fromEntries(Object.entries(inv(byType('freeport'))).filter(([, a]) => a >= 1).map(([k, a]) => [k, Math.floor(a)])) : undefined });
    }
  }
}

// ---- the player's turn -----------------------------------------------------------------------------------------
// Where food, water and homes can go when the Core has no plot left for them.
const SPILL = ['core', 'greenbelt', 'pits', 'stacks'];
const FOOD = ['water_pump', 'water_purifier', 'hydroponics_bay'];
function roomFor(d, type) { const pos = place(d, type); return pos && sim.plotSize(config, pos.ring, d.type) >= config.buildings[type].minPlotSize ? pos : null; }
// The free plot with the best neighbours for a home (homes beside smoky buildings are miserable), within a plot-size range.
function homePlot(d, minPlot, maxPlot = 9) {
  const caps = sim.levelDef(config, d.type, d.level).ringCapacities;
  const plots = sim.districtType(config, d.type).ringPlotSize;
  const taken = used(d);
  const held = RESERVED[d.type] || [];
  const here = new Map(store.loadBuildings(id, d.id).map((b) => [`${b.ring}:${b.slot}`, b.type]));
  let best = null;
  for (const r of Object.keys(caps).map(Number)) {
    if (plots[r] < minPlot || plots[r] > maxPlot) continue;
    for (let sl = 0; sl < caps[r]; sl++) {
      const k = `${r}:${sl}`;
      if (taken.has(k) || held.includes(k)) continue;
      const score = (engine.neighborMaps[d.type].get(k) || []).reduce((n, [nr, ns]) => n + (here.has(`${nr}:${ns}`) ? config.buildings[here.get(`${nr}:${ns}`)].comfort || 0 : 0), 0);
      if (!best || score > best.score) best = { ring: r, slot: sl, score };
    }
  }
  return best;
}
function survival(core, c) {
  const v = viewFor(uid);
  CREW = v.colony.staffing.ratio;
  const net = (r) => v.resources[r].net;
  const netIn = (d, r) => (d.type === 'core' ? net(r) : (((v.views[d.id] || {}).resources || {})[r] || {}).net || 0);
  const all = store.loadOrders(id);
  const pendingAny = (types) => all.some((o) => o.action_type === 'build' && types.includes(o.data.type));
  // Food and water: in the Core while it has room, then in a district, which sends what it grows home by route.
  const margin = c.won ? 3 : 1;
  const grow = (type) => {
    if (pendingAny(FOOD)) return;
    for (const t of SPILL.slice(0, 2)) { // the Core, then the farm district
      const d = byType(t);
      if (!d || (t !== 'core' && d.level < 2)) continue;
      // away from the Core a bay needs its own water, and a filtration plant its own pump
      let what = type;
      if (t !== 'core' && what === 'hydroponics_bay' && netIn(d, 'clean_water') < 5) what = 'water_purifier';
      if (what === 'water_purifier' && netIn(d, 'unpurified_water') < (t === 'core' ? 8 : 15)) what = 'water_pump';
      const pos = roomFor(d, what);
      if (!pos) continue;
      if (!can(d, config.buildings[what].cost)) { if (t !== 'core') topUp(d, config.buildings[what].cost); return; }
      if (build(d, what, { urgent: true, pos })) { if (t !== 'core') bump(M.spill, `${t}:${what}`); return; }
    }
  };
  // (a full tank needs no new plant: a route cannot deliver into a full store, so the rate alone would mislead)
  const low = (r) => net(r) < margin && v.resources[r].amount < v.resources[r].cap * 0.8;
  if (low('clean_water')) grow('water_purifier');
  else if (low('rations')) grow('hydroponics_bay');
  if (core.level >= 3 && v.colony.moraleInfo.mealCoverage < 0.95 && !pendingAny(['kitchen']) && net('rations') > 6 && can(core, config.buildings.kitchen.cost)) {
    const pos = roomFor(core, 'kitchen');
    if (pos) build(core, 'kitchen', { urgent: true, pos }); // eating well is what keeps the colony growing fast
  }
  // Homes: when the colony is full, and ahead of time when there are more posts than people could ever fill.
  const cap = v.colony.maxPopulation;
  const wanted = Math.ceil(v.colony.staffing.posts / config.global.workforceShare) + 8;
  if (!pendingAny(['habitat', 'dormitory']) && (c.population >= cap - 2 || (cap < wanted && c.population >= cap - 15))) {
    let done = false;
    for (const t of SPILL) {
      const d = byType(t);
      const pos = d && (t === 'core' || d.level >= 4) && homePlot(d, 3);
      if (!pos) continue;
      if (can(d, config.buildings.habitat.cost)) { done = build(d, 'habitat', { urgent: true, pos }); if (done && t !== 'core') bump(M.spill, `${t}:habitat`); } else if (t !== 'core') { topUp(d, config.buildings.habitat.cost); done = true; }
      break;
    }
    if (!done) { const pos = homePlot(core, 1, 2); if (pos) done = build(core, 'dormitory', { urgent: true, pos }); }
    // nowhere big enough and the Core is full: dormitories on a district's small plots, leaving it room to work
    for (const t of SPILL.slice(1)) {
      const d = byType(t);
      if (done || !d) continue;
      const caps = sim.levelDef(config, d.type, d.level).ringCapacities;
      if (Object.values(caps).reduce((a, b) => a + b, 0) - used(d).size < 2) continue;
      const pos = homePlot(d, 1, 2);
      if (!pos) continue;
      if (can(d, config.buildings.dormitory.cost)) { done = build(d, 'dormitory', { urgent: true, pos }); if (done) bump(M.spill, `${t}:dormitory`); } else { topUp(d, config.buildings.dormitory.cost); done = true; }
    }
    HOMELESS = !done;
  }
  // a grid that is short gets another generator: the best the place can build and pay for
  for (const d of districts()) {
    const e = d.type === 'core' ? v.energy : (v.views[d.id] || {}).energy;
    if (!e || e.satisfaction >= 0.97) continue;
    if (orders(d).some((o) => o.action_type === 'build' && config.buildings[o.data.type].type === 'generator')) continue;
    const choice = (d.type === 'freeport' || d.type === 'stacks' ? ['fuel_generator', 'scrap_generator', 'solar_array'] : ['scrap_generator', 'fuel_generator', 'solar_array']).find((g) => {
      const def = config.buildings[g];
      if (!sim.buildableIn(def, d.type) || !can(d, def.cost)) return false;
      if (g === 'fuel_generator' && (inv(d).fuel || 0) < 100) return false;
      if (g === 'scrap_generator' && d.type !== 'core' && (inv(d).scrap || 0) < 600) return false;
      return !!roomFor(d, g);
    });
    if (choice) build(d, choice, { urgent: true });
  }
  // what a district grows for the colony goes home
  if (T % 5 === 0) {
    const has = (t, type) => { const d = byType(t); return !!d && store.loadBuildings(id, d.id).some((b) => b.type === type); };
    routes(SPILL.slice(1).flatMap((t) => [[t, 'core', 'rations', 30, 20, () => has(t, 'hydroponics_bay')], [t, 'core', 'clean_water', 30, 60, () => has(t, 'water_purifier')]]));
  }
  return v;
}
const linkCap = (d) => config.logistics.link.levels[d.linkLevel || 1].capacity;
const linkLoad = (d, skip) => store.loadRoutes(id).filter((r) => r.id !== skip && (r.fromDistrict === d.id || r.toDistrict === d.id)).reduce((n, r) => n + r.rate, 0);
function routes(list) {
  const L = Object.fromEntries(districts().map((d) => [d.type, d.level]));
  const K = Object.fromEntries(districts().filter((d) => d.type !== 'core').map((d) => [d.type, linkCap(d)]));
  for (const [a, b, res, rate, reserve, when] of list) {
    const da = byType(a); const db2 = byType(b);
    if (!da || !db2 || (when && !when(L))) continue;
    const want = typeof rate === 'function' ? rate(L, K) : rate;
    const keep = typeof reserve === 'function' ? reserve(L) : reserve;
    const cur = store.loadRoutes(id).find((r) => r.fromDistrict === da.id && r.toDistrict === db2.id && r.resource === res);
    if (cur && cur.rate >= want && cur.reserve === keep) continue;
    if (actions.setRoute(uid, { from: da.id, to: db2.id, resource: res, rate: want, reserve: keep }).ok) continue;
    // the link is full: raise whichever end is (paid from the Core), and meanwhile run the route at what room there is
    let room = want;
    for (const d of [da, db2]) {
      if (d.type === 'core') continue;
      const free = linkCap(d) - linkLoad(d, cur && cur.id);
      if (free < want) {
        if (actions.upgradeLink(uid, { district: d.id }).ok) { note(`${d.type} link raised to ${(d.linkLevel || 1) + 1}`); bump(M.links, d.type); } else {
          // the higher link levels are paid partly in frames and fittings, which have to be shipped home to the Core
          const cost = (config.logistics.link.levels[(d.linkLevel || 1) + 1] || {}).upgradeCost;
          if (cost) topUp(byType('core'), Object.fromEntries(Object.entries(cost).filter(([r]) => config.resources[r].trade)));
        }
      }
      room = Math.min(room, linkCap(byType(d.type)) - linkLoad(d, cur && cur.id));
    }
    if (room >= 1 && (!cur || room > cur.rate)) actions.setRoute(uid, { from: da.id, to: db2.id, resource: res, rate: room, reserve: keep });
  }
}
function alternatives() {
  const ms = { level: 0 };
  for (const d of districts()) {
    const stock = inv(d);
    for (const b of store.loadBuildings(id, d.id)) {
      const def = config.buildings[b.type];
      const prefs = ALT_PREF[b.type];
      if (!prefs || !def.alternatives || b.resetting || altBan.has(b.id)) continue;
      let pick = null;
      for (const a of prefs) {
        const alt = def.alternatives[a];
        if (!alt || !sim.altUnlocked(alt, { level: d.level, milestones: { beacon: store.hasBeacon(id), freeport: !!byType('freeport'), station: false } })) continue;
        if (Object.entries(alt.inputsPerTick).every(([r, q]) => r === 'energy' || (stock[r] || 0) >= q * 15)) pick = a;
      }
      if (pick && b.recipe !== pick && prefs.indexOf(pick) > prefs.indexOf(b.recipe)) {
        if (actions.setRecipe(uid, { ring: b.ring, slot: b.slot, recipe: pick, district: d.id }).ok) { bump(M.alts, `${b.type}>${pick}`); ms.level++; }
      }
    }
  }
}
function requisitions() {
  const v = viewFor(uid).requisitions;
  if (!v || !v.open) return;
  const core = byType('core');
  const stock = inv(core);
  const saving = {};
  const add = (cost) => { for (const [r, a] of Object.entries(cost || {})) saving[r] = (saving[r] || 0) + a; };
  for (const o of orders(core).filter((x) => x.state === 'queued')) add(queue.costOf(core, o));
  add((config.hubLevels[core.level + 1] || {}).upgradeCost);
  for (const t of ORDER) if (P.districts && !byType(t) && core.level >= config.districtProgression.unlockCoreLevel) { add(config.districtTypes[t].foundCost); break; }
  for (const q of v.open) {
    if (!seenReq.has(q.id)) { seenReq.set(q.id, T); M.reqs.seen++; }
    // deliver only what the colony will not miss: a working stock, plus whatever the Core is saving up for
    const base = ['clean_water', 'rations'].includes(q.good) ? (process.env.HAZARDS === 'on' ? 700 : 250) : q.good === 'machined_parts' ? 120 : q.good === 'building_materials' ? 80 : 40;
    if ((stock[q.good] || 0) - q.qty < base + (saving[q.good] || 0)) continue;
    const r = actions.requisitionFill(uid, { id: q.id });
    if (r.ok) { M.reqs.filled++; M.credits.requisitions += r.reward; stock[q.good] -= q.qty; M.reqs.waits.push(T - seenReq.get(q.id)); bump(M.reqs.goods, q.good); }
  }
}
const seenReq = new Map();
// Export whatever is pressing against the storage cap. The trader also keeps a floor of what it sells in production.
function contracts(c) {
  const core = byType('core');
  const stock = inv(core);
  const cap = sim.storageCap(config, { type: 'core', level: core.level, buildings: store.loadBuildings(id, core.id) });
  // what the hub is saving for: the next upgrade, and at level 5 the Beacon
  const need = {};
  const add = (cost) => { for (const [r, a] of Object.entries(cost)) need[r] = Math.max(need[r] || 0, a); };
  const nx = config.hubLevels[c.hub_level + 1];
  if (nx) add(nx.upgradeCost);
  if (c.hub_level >= 5 && !store.hasBeacon(id)) { add(config.buildings.beacon_array.cost); need.power_cells = (need.power_cells || 0) + config.global.beacon.transmitTicks + 10; need.circuits = (need.circuits || 0) + 30; }
  for (const r of ['machined_parts', 'building_materials', 'alloys', 'clean_water', 'rations', 'meals', 'scrap']) {
    const have = stock[r] || 0;
    // the engineer sells only what presses against the cap; the trader sells everything it is not saving (never its scrap)
    let spare = have >= cap * 0.9 ? Math.floor(have - cap * 0.75) : 0;
    if (P.imports && r !== 'scrap') spare = Math.floor(have - Math.max((need[r] || 0) * 1.2, ['clean_water', 'rations'].includes(r) ? 400 : 250));
    actions.setContract(uid, { resource: r, side: 'export', amount: Math.max(0, spare) });
  }
  if (!P.imports) return;
  // The trader buys what the districts would have made.
  for (const r of ['circuits', 'power_cells', 'medicine']) {
    const short = Math.ceil((need[r] || 0) - (stock[r] || 0));
    actions.setContract(uid, { resource: r, side: 'import', amount: Math.max(0, short) });
  }
}

// ---- after the Beacon ------------------------------------------------------------------------------------------
const fpSlots = [];
function freePortStep(fp, c) {
  for (let i = 0; i < FP_PLAN.length; i++) {
    const item = FP_PLAN[i];
    if (item === 'orbit') { if (!c.orbital_unlocked) break; continue; }
    if (typeof item === 'string') { if (fp.level < Number(item.split(':')[1])) { askUpgrade(fp); break; } continue; }
    const [type, recipe, plot] = item;
    if (fpSlots[i]) {
      // a finished workshop is given its recipe (the first one is free)
      if (recipe) {
        const [ring, slot] = fpSlots[i].split(':').map(Number);
        const b = store.loadBuildings(id, fp.id).find((x) => x.ring === ring && x.slot === slot);
        if (b && !b.recipe) actions.setRecipe(uid, { ring, slot, recipe, district: fp.id });
      }
      continue;
    }
    const pos = place(fp, type, plot) || (plot ? place(fp, type) : null);
    if (!pos) continue;
    if (shortHanded(type)) { M.crewHold++; break; }
    if (waiting(fp).length >= DEPTH) break;
    if (!actions.build(uid, { ...pos, type, district: fp.id }).ok) break;
    fpSlots[i] = `${pos.ring}:${pos.slot}`;
  }
  const front = orders(fp).find((o) => o.state === 'queued');
  if (front && !orders(fp).some((o) => o.state !== 'queued')) topUp(fp, queue.costOf(fp, front));
}
const standing = () => db.prepare('SELECT COALESCE(SUM(points), 0) AS n FROM standing WHERE colony_id = ?').get(id).n;
function missionsStep(fp, c) {
  if (c.orbital_unlocked) return; // standing has done its job: the goods go into the launch from here on
  const stock = inv(fp);
  for (const q of viewFor(uid).missions.open) {
    const best = q.offers.filter((o) => (stock[o.good] || 0) >= o.qty).sort((a, b) => b.standing - a.standing)[0];
    if (!best) continue;
    const r = actions.missionFill(uid, { id: q.id, faction: best.faction, district: fp.id });
    if (r.ok) { M.missions.filled++; M.missions.standing += r.standing; M.credits.missions += r.reward; bump(M.missions.goods, best.good); stock[best.good] -= best.qty; }
  }
}
const built = (type) => db.prepare('SELECT 1 FROM colony_buildings WHERE colony_id = ? AND building_type = ?').get(id, type);
const ordered = (type) => store.loadOrders(id).some((o) => o.data.type === type);
function orbitStep(core, fp, c) {
  const B = config.buildings;
  // finished launch goods go to the Core, except what the command center still has to be paid with
  const hold = built('orbital_command') || ordered('orbital_command') ? {} : B.orbital_command.cost;
  for (const r of ['frames', 'fittings', 'modules']) {
    const keep = (hold[r] || 0) + 10;
    const cur = store.loadRoutes(id).find((x) => x.fromDistrict === fp.id && x.toDistrict === core.id && x.resource === r);
    if (!cur || cur.reserve !== keep) routes([['freeport', 'core', r, 12, keep]]);
  }
  if (!built('orbital_command') && !ordered('orbital_command') && fp.level >= 5 && can(fp, B.orbital_command.cost)) {
    if (actions.build(uid, { ring: 5, slot: 10, type: 'orbital_command', district: fp.id }).ok) note('command center ordered');
  } else if (!built('orbital_command') && !ordered('orbital_command') && fp.level >= 5) topUp(fp, { circuits: B.orbital_command.cost.circuits });
  if (!built('orbital_staging') && !ordered('orbital_staging') && can(core, B.orbital_staging.cost)) {
    if (actions.build(uid, { ring: 5, slot: 12, type: 'orbital_staging' }).ok) note('staging platform ordered');
  }
  if (built('orbital_staging') && !built('orbital_catapult') && !ordered('orbital_catapult') && can(core, B.orbital_catapult.cost)) {
    if (actions.build(uid, { ring: 5, slot: 13, type: 'orbital_catapult' }).ok) note('catapult ordered');
  }
  for (const t of ['orbital_staging', 'orbital_catapult', 'orbital_command']) {
    const o = store.loadOrders(id).find((x) => x.data.type === t && x.state === 'queued');
    if (o) actions.queueMove(uid, { orderId: o.id, to: 'top' });
  }
  if (built('orbital_staging') && built('orbital_catapult') && built('orbital_command') && !c.launch_ready && !M.milestones['Station launched']) {
    const staging = db.prepare("SELECT recipe FROM colony_buildings WHERE colony_id = ? AND building_type = 'orbital_staging'").get(id);
    if (!staging.recipe && actions.launchCycle(uid, { cycle: 'station' }).ok) mark('Launch cycle started');
  }
  if (c.launch_ready) {
    mark('Payload complete');
    const r = actions.launch(uid, { name: 'Playtest One' });
    if (r.ok) mark('Station launched'); else if (T % 50 === 0) note(`launch refused: ${r.error}`);
  }
}
function endgame(c) {
  const core = byType('core');
  let fp = byType('freeport');
  if (!fp) {
    if (can(core, config.districtTypes.freeport.foundCost) && !store.loadOrders(id).some((o) => o.action_type === 'found') && actions.foundDistrict(uid, { type: 'freeport' }).ok) {
      const mine = waiting(core).find((o) => o.action_type === 'found');
      if (mine) actions.queueMove(uid, { orderId: mine.id, to: 'top' });
    }
    return;
  }
  // the Beacon has done its work; switched off it frees the power it still draws
  const beacon = store.loadBuildings(id, core.id).find((b) => b.type === 'beacon_array');
  if (beacon && beacon.status === 'active') actions.toggle(uid, { ring: beacon.ring, slot: beacon.slot, paused: true });
  freePortStep(fp, c);
  if (T % 5 === 0) {
    routes(LATE_ROUTES);
    // a Free Port whose link is the limit asks for the next link level
    if (fp.level >= 5 && linkCap(fp) < 222 && T % 20 === 0) {
      const cost = (config.logistics.link.levels[(fp.linkLevel || 1) + 1] || {}).upgradeCost;
      if (cost && can(byType('core'), cost)) { if (actions.upgradeLink(uid, { district: fp.id }).ok) { note(`freeport link raised to ${(fp.linkLevel || 1) + 1}`); bump(M.links, 'freeport'); } } else if (cost) topUp(byType('core'), Object.fromEntries(Object.entries(cost).filter(([r]) => config.resources[r].trade)));
    }
  }
  missionsStep(fp, c);
  if (c.orbital_unlocked) { fp = byType('freeport'); orbitStep(core, fp, c); }
}

function act() {
  const c = colony();
  const core = byType('core');
  // upgrades whenever a place can pay for one, without waiting for the list to ask
  for (const d of districts()) {
    const next = sim.levelDef(config, d.type, d.level + 1);
    // (never the hub before the colony can feed and water itself: the upgrade would take the scrap those need)
    const fed = d.type !== 'core' || ['water_purifier', 'hydroponics_bay'].every((t) => store.loadBuildings(id, d.id).some((b) => b.type === t));
    if (next && fed && can(d, next.upgradeCost)) askUpgrade(d);
    else if (next && d.type !== 'core' && d.level + 1 <= levelCap() && T % 3 === 0) topUp(d, next.upgradeCost);
  }
  if (P.districts) {
    for (const t of ORDER) {
      if (byType(t)) continue;
      if (!can(core, config.districtTypes[t].foundCost) || store.loadOrders(id).some((o) => o.action_type === 'found')) continue;
      if (actions.foundDistrict(uid, { type: t }).ok) {
        note(`found ${t} ordered`);
        // an upgrade that is waiting for what this district will make must not hold its founding up
        const mine = waiting(core).find((o) => o.action_type === 'found');
        if (mine) actions.queueMove(uid, { orderId: mine.id, to: 'top' });
      }
    }
    if (T % 5 === 0) { routes(ROUTES); if (P.alts) routes(ALT_ROUTES); }
  }
  const late = !!c.won && UNTIL === 'station';
  planStep(core, (P.districts ? CORE_PLAN : TRADER_PLAN).concat(late ? LATE.core : []));
  if (P.districts) for (const t of ORDER) { const d = byType(t); if (d) planStep(d, PLANS[t].concat(late ? LATE[t] : [])); }
  if (late) endgame(c);
  if (T % 2 === 0 || CADENCE > 1) survival(core, c);
  for (const b of store.loadBuildings(id, core.id)) {
    if (b.type !== 'parts_assembler') continue;
    const want = (inv(core).machined_parts || 0) > (P.imports ? 1e9 : c.won ? 3000 : P.exports ? 600 : 400) ? 'paused' : 'active';
    if (b.status !== want) actions.toggle(uid, { ring: b.ring, slot: b.slot, paused: want === 'paused' });
  }
  // Another build slot, where there is work waiting for one and paying for it would not take what the front order needs.
  if (SLOTS && T % 5 === 0) {
    for (const d of districts()) {
      const next = queue.nextSlot(d);
      const line = waiting(d);
      if (!next || c.hub_level < next.coreLevel || !line.length || colony().credits < next.credits) continue;
      const stock = inv(d); const front = queue.costOf(d, line[0]);
      if (!Object.entries(next.cost).every(([r, a]) => (stock[r] || 0) >= a + (front[r] || 0))) continue;
      if (actions.buildSlot(uid, d.type === 'core' ? {} : { district: d.id }).ok) { bump(M.slots, d.type); note(`${d.type} build slot ${next.slots}`); }
    }
  }
  if (P.alts && T % 10 === 0) alternatives();
  if (P.reqs) requisitions();
  if (P.exports && (T % 10 === 0 || CADENCE > 1)) contracts(c);
}

function milestones(c) {
  if (c.hub_level >= 2) mark('Core 2');
  if (c.hub_level >= 3) mark('Core 3');
  if (c.hub_level >= 4) mark('Core 4');
  for (const t of ORDER) if (byType(t)) mark(`${t} founded`);
  if (c.hub_level >= 5) mark('Core 5');
  if (store.hasBeacon(id)) mark('Beacon built');
  if (c.won) mark('Beacon transmitted');
  if (UNTIL !== 'station' || !c.won) return;
  const fp = byType('freeport');
  if (fp) { mark('Free Port founded'); for (let n = 2; n <= fp.level; n++) mark(`Free Port ${n}`); }
  if (c.orbital_unlocked) mark('Orbit unlocked');
  for (const [t, name] of [['orbital_command', 'Command center built'], ['orbital_staging', 'Staging platform built'], ['orbital_catapult', 'Catapult built']]) if (built(t)) mark(name);
}

function run() {
  const t0 = Date.now();
  let shut = false;
  for (T = 1; T <= MAX; T++) {
    const before = colony().credits;
    db.prepare('UPDATE colonies SET last_seen_at = ? WHERE id = ?').run(Date.now(), id); // the player is "active": hazards may start
    engine.processTick();
    const c = colony();
    if (T % config.global.convoyIntervalTicks === 0) M.credits.convoy += c.credits - before;
    if (c.shutdown_tick !== null && !shut) {
      shut = true; M.shutdowns++; note('SHUT DOWN');
      // what led up to it
      M.shutLog.push(`shutdown at tick ${T} (hub ${c.hub_level}, population ${c.population}): ` + db.prepare("SELECT tick, message FROM colony_events WHERE colony_id = ? AND kind IN ('bad', 'warn') AND tick > ? ORDER BY id").all(id, T - 80)
        .filter((e) => !/Convoy|people are leaving|Brownout|storage slot/.test(e.message)).slice(-8).map((e) => `[${e.tick}] ${e.message}`).join(' '));
    }
    if (c.shutdown_tick === null && shut) { shut = false; actions.resumeOps(uid); note('recovered'); }
    milestones(c);
    if (T % CADENCE === 0) act();
    sample();
    if (UNTIL === 'beacon' && c.won) break;
    if (M.milestones['Station launched'] !== undefined) break;
  }
  M.ticks = T; M.finished = UNTIL === 'station' ? M.milestones['Station launched'] !== undefined : !!colony().won; M.seconds = (Date.now() - t0) / 1000;
}

// ---- the report ------------------------------------------------------------------------------------------------
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '-');
const hrs = (t) => `${(t * config.global.tickRateMs / 3600000).toFixed(1)}h`;
function report() {
  const out = [];
  out.push(`\n== ${PERSONA}${['alts', 'reqs', 'exports'].filter((k) => typeof arg(k) === 'string').map((k) => ` ${k}=${arg(k)}`).join('')}, looks in every ${CADENCE} tick${CADENCE > 1 ? 's' : ''}, hazards ${process.env.HAZARDS}: ${M.finished ? `finished at tick ${M.ticks} (${hrs(M.ticks)})` : `NOT finished after ${M.ticks} ticks`}${M.shutdowns ? `, ${M.shutdowns} shutdown(s)` : ''}`);
  out.push('milestones: ' + Object.entries(M.milestones).map(([k, t]) => `${k} ${t} (${hrs(t)})`).join(' · '));
  out.push('phase (from)            ticks   Core slot: build/wait/idle   waiting on (Core)                      pop  morale(min)  crew(min)  brownout  hungry');
  for (const p of M.phases) {
    if (!p.ticks) continue;
    const s = p.slot.core || { build: 0, wait: 0, idle: 0 };
    const sh = Object.entries(p.short.core || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, n]) => `${r} ${pct(n, p.ticks)}`).join(', ');
    out.push(`${p.from.padEnd(22)} ${String(p.ticks).padStart(6)}   ${`${pct(s.build, p.ticks)}/${pct(s.wait, p.ticks)}/${pct(s.idle, p.ticks)}`.padEnd(26)} ${sh.padEnd(38)} ${String(Math.round(p.pop / p.ticks)).padStart(4)}  ${`${Math.round(p.morale / p.ticks)}(${Math.round(p.moraleMin)})`.padEnd(11)}  ${`${pct(p.staff, p.staffN)}(${Math.round(p.staffMin * 100)}%)`.padEnd(9)}  ${pct(p.brown, p.ticks).padStart(7)}  ${pct(p.starving, p.ticks).padStart(6)}`);
  }
  out.push('district build slots (whole run): ' + ORDER.concat(['freeport']).map((t) => {
    const s = { build: 0, wait: 0, idle: 0 }; const sh = {};
    for (const p of M.phases) { const x = p.slot[t]; if (x) for (const k of Object.keys(s)) s[k] += x[k]; for (const [r, n] of Object.entries(p.short[t] || {})) bump(sh, r, n); }
    const n = s.build + s.wait + s.idle;
    return n ? `${t} ${pct(s.build, n)}/${pct(s.wait, n)}/${pct(s.idle, n)}${Object.keys(sh).length ? ` (${Object.entries(sh).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([r, k]) => `${r} ${pct(k, n)}`).join(', ')})` : ''}` : null;
  }).filter(Boolean).join(' | '));
  for (const l of M.shutLog) out.push(l);
  const capped = {};
  for (const p of M.phases) for (const [r, n] of Object.entries(p.capped)) bump(capped, r, n);
  out.push('Core stock at its cap (share of the run): ' + (Object.entries(capped).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([r, n]) => `${r} ${pct(n, M.ticks)}`).join(', ') || 'never'));
  const w = M.reqs.waits.slice().sort((a, b) => a - b);
  out.push(`credits: ${colony().credits} in hand; convoy net ${M.credits.convoy}, requisitions ${M.credits.requisitions} (${M.reqs.filled} of ${M.reqs.seen} filled${w.length ? `; ${pct(w.filter((x) => x <= CADENCE).length, w.length)} from stock on sight, median wait ${w[Math.floor(w.length / 2)]} ticks` : ''})`);
  if (M.missions.filled) out.push(`missions: ${M.missions.filled} filled for ${M.missions.standing} standing and ${M.credits.missions} cr (${Object.entries(M.missions.goods).sort((a, b) => b[1] - a[1]).map(([g, n]) => `${g} ×${n}`).join(', ')})`);
  if (Object.keys(M.spill).length) out.push('built outside the Core for want of room: ' + Object.entries(M.spill).map(([k, n]) => `${k} ×${n}`).join(', '));
  if (M.crewHold) out.push(`new workplaces held back for want of crews on ${M.crewHold} of the player's turns`);
  if (Object.keys(M.slots).length) out.push('build slots bought: ' + Object.entries(M.slots).map(([k, n]) => `${k} +${n}`).join(', ') + ' (' + M.notes.filter((x) => /build slot/.test(x)).join(', ') + ')');
  if (Object.keys(M.links).length) out.push('link upgrades: ' + Object.entries(M.links).map(([k, n]) => `${k} ×${n}`).join(', '));
  if (Object.keys(M.extras).length) out.push('extra producers built while stalled: ' + Object.entries(M.extras).map(([k, n]) => `${k} ×${n}`).join(', '));
  if (Object.keys(M.altsOff).length) out.push('alternative recipes switched back because they ate what an order was waiting for: ' + Object.entries(M.altsOff).map(([k, n]) => `${k}${n > 1 ? ` ×${n}` : ''}`).join(', '));
  if (Object.keys(M.alts).length) out.push('alternative recipes switched on: ' + Object.entries(M.alts).map(([k, n]) => `${k}${n > 1 ? ` ×${n}` : ''}`).join(', '));
  return out.join('\n');
}

run();
console.log(report());
if (arg('dump')) {
  // where every place stands at the end: what is queued and what it holds
  for (const d of districts()) {
    const stock = inv(d);
    console.log(`\n${d.type} L${d.level}: ${store.loadBuildings(id, d.id).map((b) => b.type + (b.recipe ? `>${b.recipe}` : '') + (b.status !== 'active' ? '(off)' : '')).sort().join(' ')}`);
    console.log('  queue: ' + (orders(d).map((o) => `${o.state}:${o.action_type}:${o.data.type || o.data.level}@${o.data.ring || ''}:${o.data.slot === undefined ? '' : o.data.slot} needs ${JSON.stringify(queue.costOf(d, o))}`).join(' | ') || 'empty'));
    console.log('  stock: ' + Object.entries(stock).filter(([, a]) => a >= 1).map(([k, a]) => `${k}=${Math.floor(a)}`).join(' '));
  }
  console.log('\nroutes: ' + store.loadRoutes(id).map((r) => `${districts().find((d) => d.id === r.fromDistrict).type}>${districts().find((d) => d.id === r.toDistrict).type} ${r.resource} ${r.rate}`).join(', '));
}
if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify(M, null, 1));
if (arg('trace')) fs.writeFileSync(arg('trace'), M.trace.map((r) => JSON.stringify(r)).join('\n'));
db.close();
fs.rmSync(dir, { recursive: true, force: true });
