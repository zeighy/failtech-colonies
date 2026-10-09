'use strict';
// Pure game simulation. No database, no clocks: given a colony snapshot it
// returns the next one. The engine applies it for real; the API runs it as a
// dry run to show players their current production rates.

const EPS = 1e-9;
const key = (ring, slot) => `${ring}:${slot}`;

function maxLevel(config, type = 'core') {
  return Math.max(...Object.keys(districtType(config, type).levels).map(Number));
}

// Ring sizes never change between hub levels (higher levels only unlock more
// rings), so one neighbour map built from the top level serves every colony.
function ringCapacities(config, type = 'core') {
  return levelDef(config, type, maxLevel(config, type)).ringCapacities;
}

// Rings may be turned by a few degrees (config.ringRotation for the Core, districtTypes.<type>.ringRotation
// for the others) so that slots in neighbouring rings straddle each other's seams. Returns a fraction of a turn.
function ringRotation(config, type, ring) {
  const rot = type === 'core' ? config.ringRotation : (config.districtTypes[type] || {}).ringRotation;
  return (((rot || {})[ring] || 0) / 360) % 1;
}

function buildNeighborMap(config, type = 'core') {
  const caps = ringCapacities(config, type);
  const map = new Map();
  for (const [r, cap] of Object.entries(caps)) {
    const ring = Number(r);
    for (let i = 0; i < cap; i++) {
      const out = [];
      if (cap > 1) {
        out.push([ring, (i - 1 + cap) % cap]);
        if (cap > 2) out.push([ring, (i + 1) % cap]);
      }
      const lo = i / cap + ringRotation(config, type, ring);
      const hi = lo + 1 / cap;
      for (const other of [ring - 1, ring + 1]) {
        const oc = caps[other];
        if (!oc) continue;
        const shift = ringRotation(config, type, other);
        for (let j = 0; j < oc; j++) {
          const a = j / oc + shift;
          let overlap = 0;
          for (const k of [-1, 0, 1]) overlap += Math.max(0, Math.min(hi, a + k + 1 / oc) - Math.max(lo, a + k));
          if (overlap > EPS) out.push([other, j]);
        }
      }
      map.set(key(ring, i), out);
    }
  }
  return map;
}

function adjacencyMultiplier(config, buildingType, neighborTypes) {
  let m = 1;
  for (const rule of config.adjacencyModifiers.rules) {
    if (rule.targetBuilding !== buildingType) continue;
    for (const t of neighborTypes) if (t === rule.adjacentBuilding) m *= rule.outputMultiplier;
  }
  return Math.min(1.6, Math.max(0.5, m));
}

// ---- plots ------------------------------------------------------------------
// Outer rings have bigger plots. A building may be placed on a plot smaller than
// it wants, but its output is multiplied by `plotPenaltyPerStep` for every size
// step it falls short (inputs are still consumed in full).
const plotSize = (config, ring, type = 'core') => districtType(config, type).ringPlotSize[ring] || 1;
function plotMultiplier(config, def, ring, type = 'core') {
  const deficit = Math.max(0, (def.minPlotSize || 1) - plotSize(config, ring, type));
  return Math.pow(config.global.plotPenaltyPerStep, deficit);
}

// ---- market -----------------------------------------------------------------
// Convoy prices drift per convoy. Deterministic in (resource, convoy number), so
// the next convoy's prices are knowable in advance.
function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 15; h = Math.imul(h, 2246822507); h ^= h >>> 13;
  return ((h >>> 0) % 100000) / 100000;
}
function marketMult(config, res, k) {
  const m = config.market;
  const phase = hash01('phase:' + res) * Math.PI * 2;
  const wave = Math.sin((k / m.period) * Math.PI * 2 + phase) * m.amplitude;
  const noise = (hash01(`noise:${res}:${k}`) - 0.5) * 2 * m.noise;
  return Math.min(m.max, Math.max(m.min, 1 + wave + noise));
}
const round1 = (n) => Math.round(n * 10) / 10;
function marketPrices(config, k) {
  const out = {};
  for (const [res, def] of Object.entries(config.resources)) {
    const m = marketMult(config, res, k);
    out[res] = { mult: m, buy: Math.max(0.1, round1(def.buy * m)), sell: Math.max(0.1, round1(def.sell * m)) };
  }
  return out;
}

// Convoy number of the next scheduled convoy after `tick`; its prices are the ones shown to players.
const nextConvoyK = (config, tick) => Math.floor(tick / config.global.convoyIntervalTicks) + 1;

// Express (player-dispatched) convoy terms for a given set of scheduled-convoy prices.
function expressPrices(config, prices) {
  const x = config.global.express;
  const out = {};
  for (const [res, p] of Object.entries(prices)) {
    out[res] = { buy: Math.max(0.1, round1(p.buy * x.buyMult)), sell: Math.max(0.1, round1(p.sell * x.sellMult)) };
  }
  return out;
}
const expressFee = (config, hubLevel) => config.global.express.baseFee + config.global.express.feePerHubLevel * hubLevel;

function sortBuildings(config, infos) {
  const rank = (def) => {
    if (def.type === 'generator') return -1;
    const i = config.tierOrder.indexOf(def.type);
    return i < 0 ? 99 : i;
  };
  return infos.slice().sort((a, b) => rank(a.def) - rank(b.def) || a.b.id - b.b.id);
}

// Output multiplier from morale: neutral across the comfortable middle, a slowdown when
// people are unhappy, and a modest bonus when they are doing well.
function moraleMultiplier(config, morale) {
  const m = config.global.morale;
  if (morale >= m.bonusFrom) return 1 + m.bonusMax * Math.min(1, (morale - m.bonusFrom) / (100 - m.bonusFrom));
  if (morale >= m.penaltyBelow) return 1;
  return Math.max(m.floor, 1 - (m.penaltyBelow - morale) * m.penaltyPerPoint);
}

// ---- districts ----------------------------------------------------------------
// A district is a base: a district core with rings around it, its own stockpile, buildings and power grid.
// 'core' is the original colony (config.hubLevels / config.ringPlotSize); other district types come from
// config.districtTypes[type] = { levels, ringPlotSize }.
function districtType(config, type) {
  if (type === 'core') return { levels: config.hubLevels, ringPlotSize: config.ringPlotSize };
  const d = config.districtTypes && config.districtTypes[type];
  if (!d) throw new Error(`Unknown district type "${type}"`);
  return d;
}
const levelDef = (config, type, level) => districtType(config, type).levels[level];
// May this building be built in this kind of district? Buildings without a `districts` list go anywhere.
const buildableIn = (def, type) => !def.districts || def.districts.includes(type);
// Ticks a shipment takes between two districts (the Core is at distance 0; travel goes via the Core).
const shipDistance = (config, a, b) => {
  const d = (t) => (t === 'core' ? 0 : config.districtTypes[t].distance);
  return Math.max(1, a === b ? 0 : d(a) + d(b));
};

// ---- one district ----------------------------------------------------------------
// d: { type, level, inventory, buildings:[{id,ring,slot,type,status}] }
// ctx: { staff, morOut }  (colony-wide crew ratio and morale output multiplier, decided before any district runs)
// mods (from active hazards):
//   outputMult: {buildingType: m}   output multiplier by type
//   degraded:   {buildingId: m}     output multiplier for specific buildings
//   disabled:   Set<buildingId>     buildings knocked fully offline
//   drain:      {resource: perTick} extra maintenance consumption
// Returns the district's stockpile *before* storage caps and population draws; stepColony finishes those.
function stepDistrict(config, d, ctx, neighborMap, mods = {}) {
  const lvl = levelDef(config, d.type, d.level);
  const grid = new Map(d.buildings.map((b) => [key(b.ring, b.slot), b]));
  const disabled = mods.disabled || new Set();
  const outMult = mods.outputMult || {};
  const degraded = mods.degraded || {};
  const { staff, morOut } = ctx;

  const infos = [];
  for (const b of d.buildings) {
    const def = config.buildings[b.type];
    if (!def) continue;
    const nbs = (neighborMap.get(key(b.ring, b.slot)) || [])
      .map(([r, s]) => grid.get(key(r, s)))
      .filter(Boolean);
    const adj = adjacencyMultiplier(config, b.type, nbs.map((n) => n.type));
    const plot = plotMultiplier(config, def, b.ring, d.type);
    const haz = (outMult[b.type] === undefined ? 1 : outMult[b.type]) * (degraded[b.id] === undefined ? 1 : degraded[b.id]);
    infos.push({ b, def, adj, plot, haz, nbs, mult: adj * plot, opt: def.optional && b.boost ? def.optional : null, optMult: 1, optOn: false });
  }
  const offline = (i) => i.b.status !== 'active' || disabled.has(i.b.id);
  const running = sortBuildings(config, infos.filter((i) => !offline(i)));
  const staffOf = (i) => ((i.def.workers || 0) > 0 ? staff : 1);

  const materialEff = (needs, inv) => {
    let eff = 1;
    let limiting = null;
    for (const [res, amt] of Object.entries(needs)) {
      if (res === 'energy') continue;
      const e = Math.min(1, (inv[res] || 0) / amt);
      if (e < eff) { eff = e; limiting = res; }
    }
    return { eff, limiting };
  };
  const apply = (info, eff, inv, flows) => {
    for (const [res, amt] of Object.entries(info.def.inputsPerTick)) {
      if (res === 'energy') continue;
      const used = amt * eff;
      inv[res] = (inv[res] || 0) - used;
      if (flows) flows[res].consumed += used;
    }
    for (const [res, amt] of Object.entries(info.def.outputsPerTick)) {
      if (res === 'energy') continue;
      const made = amt * eff * info.mult * info.haz * info.optMult * morOut;
      inv[res] = (inv[res] || 0) + made;
      if (flows) flows[res].produced += made;
    }
  };

  // District-core upkeep (hub level 3+ in the Core): paid from stock at the start of the tick. If it
  // can't be fully maintained, the core's own power output drops with it.
  const upkeep = lvl.upkeepPerTick || {};
  const hubMat = materialEff(upkeep, d.inventory);
  const hubEff = hubMat.eff;
  const hubPower = (lvl.baseEnergy - (upkeep.energy || 0)) * hubEff;

  // Energy is a grid, not a stockpile: supply this tick vs. demand this tick.
  // Pass 1 (dry): how much power would everything want if power were unlimited?
  const probe = { ...d.inventory };
  for (const [res, amt] of Object.entries(upkeep)) if (res !== 'energy') probe[res] = (probe[res] || 0) - amt * hubEff;
  let supply = hubPower;
  let demand = 0;
  for (const i of running) {
    const eff = Math.min(materialEff(i.def.inputsPerTick, probe).eff, staffOf(i));
    if (i.def.type === 'generator') supply += (i.def.outputsPerTick.energy || 0) * eff * i.mult * i.haz;
    else demand += (i.def.inputsPerTick.energy || 0) * eff;
    apply(i, eff, probe, null);
  }
  supply = Math.max(0, supply);
  const sat = demand <= supply + EPS || demand === 0 ? 1 : supply / demand;

  // Pass 2: the real thing.
  const inv = { ...d.inventory };
  for (const res of Object.keys(config.resources)) inv[res] = inv[res] || 0;
  const flows = {};
  for (const res of Object.keys(config.resources)) flows[res] = { produced: 0, consumed: 0 };
  for (const [res, amt] of Object.entries(upkeep)) {
    if (res === 'energy') continue;
    const used = amt * hubEff;
    inv[res] -= used;
    flows[res].consumed += used;
  }
  const bstate = new Map();
  for (const i of infos) {
    if (offline(i)) {
      bstate.set(i.b.id, {
        eff: 0, mult: i.mult, adj: i.adj, plot: i.plot, haz: i.haz, limiting: null,
        status: i.b.status !== 'active' ? 'paused' : 'damaged',
      });
    }
  }
  let progressGain = 0;
  let defense = 0;
  let storageBonus = 0;
  for (const i of running) {
    const hasPower = (i.def.inputsPerTick.energy || 0) > 0;
    const { eff: mEff, limiting } = materialEff(i.def.inputsPerTick, inv);
    const pEff = hasPower ? sat : 1;
    const sEff = staffOf(i);
    const eff = Math.min(mEff, pEff, sEff);
    // Optional input: switched on by the player, a fixed amount per tick while the building is working, and only
    // if the whole amount is in stock (otherwise it sits idle and nothing is spent).
    if (i.opt && eff > 0.01 && Object.entries(i.opt.inputsPerTick).every(([r, a]) => (inv[r] || 0) >= a)) {
      for (const [r, a] of Object.entries(i.opt.inputsPerTick)) { inv[r] -= a; flows[r].consumed += a; }
      i.optOn = true;
      if (i.opt.outputMult) i.optMult = i.opt.outputMult;
    }
    apply(i, eff, inv, flows);
    if (i.def.transmit) progressGain += eff * i.mult * i.haz;
    if (i.def.defense) defense += i.def.defense * eff * i.mult;
    if (i.def.storageBonus) storageBonus += i.def.storageBonus * i.mult;
    let status = 'running';
    let why = null;
    if (eff < 0.999) {
      if (sEff < Math.min(mEff, pEff) - EPS) { status = 'understaffed'; }
      else if (pEff < mEff - EPS) { status = pEff < 0.01 ? 'no_power' : 'low_power'; }
      else { status = mEff < 0.01 ? 'starved' : 'low_input'; why = limiting; }
    }
    bstate.set(i.b.id, { eff, mult: i.mult, adj: i.adj, plot: i.plot, haz: i.haz, status, limiting: why, boost: i.opt ? (i.optOn ? 'on' : 'starved') : null });
  }

  // Housing and neighbourhood comfort. Homes next to noisy, smoky buildings are miserable.
  const g = config.global;
  let housingBuilt = 0;
  let comfortWeighted = 0;
  for (const i of running) {
    if (!i.def.housing) continue;
    const cap = i.def.housing * i.plot;
    const raw = i.nbs.reduce((s, n) => s + (n.status === 'active' ? (config.buildings[n.type].comfort || 0) : 0), 0)
      + (i.optOn && i.opt.comfort ? i.opt.comfort : 0);
    const comfort = Math.max(g.morale.comfortMin, Math.min(g.morale.comfortMax, raw));
    housingBuilt += cap;
    comfortWeighted += cap * comfort;
    const s = bstate.get(i.b.id);
    if (s) s.comfort = comfort;
  }

  // Hazard maintenance: extra consumption while a hazard is being weathered.
  for (const [res, amt] of Object.entries(mods.drain || {})) {
    if (!flows[res]) continue;
    const take = Math.min(inv[res] || 0, amt);
    inv[res] = (inv[res] || 0) - take;
    flows[res].consumed += take;
  }

  return {
    inventory: inv, flows, buildings: bstate,
    cap: lvl.maxStorage + storageBonus, defense, progressGain,
    energy: { supply, demand, satisfaction: sat },
    hub: { eff: hubEff, limiting: hubMat.limiting, power: hubPower },
    baseHousing: lvl.baseHousing || 0, housingBuilt, comfortWeighted,
  };
}

// How much of each resource a district can hold: its level plus warehouse bonuses (plot-adjusted).
function storageCap(config, d) {
  let cap = levelDef(config, d.type, d.level).maxStorage;
  for (const b of d.buildings) {
    const def = config.buildings[b.type];
    if (def && def.storageBonus && b.status === 'active') cap += def.storageBonus * plotMultiplier(config, def, b.ring, d.type);
  }
  return cap;
}

// ---- standing routes ---------------------------------------------------------------
// A route moves up to `rate` of a resource every tick straight from one district's stockpile into another's:
// no trucks, no delay. It never takes the source below `reserve` and never overfills the destination.
// bags: Map districtId -> { inv, cap } (mutated). Returns [{ route, qty, limit }] where limit says what held it
// back: null (full rate), 'stock' (source at its reserve) or 'room' (destination full).
function applyRoutes(config, routes, bags) {
  const out = [];
  for (const route of routes) {
    const a = bags.get(route.fromDistrict); const b = bags.get(route.toDistrict);
    if (!a || !b) continue;
    const avail = Math.max(0, Math.floor((a.inv[route.resource] || 0) - route.reserve));
    const room = Math.max(0, Math.floor(b.cap - (b.inv[route.resource] || 0)));
    const qty = Math.min(route.rate, avail, room);
    if (qty > 0) {
      a.inv[route.resource] -= qty;
      b.inv[route.resource] = (b.inv[route.resource] || 0) + qty;
    }
    out.push({ route, qty, limit: qty >= route.rate ? null : avail <= room ? 'stock' : 'room' });
  }
  return out;
}

// ---- the whole colony ---------------------------------------------------------------
// colony: { population, morale, age, progress, won }
// districts: [{ id, type, level, inventory, buildings }]   (exactly one has type 'core')
// opts: { neighborMaps: {type: Map}, mods: {districtId: hazardMods}, popConsumptionMult }
// Order of play: crew and morale are decided first (they depend on every district's posts), then each
// district runs, then the population eats from the Core stockpile, storage caps apply, and morale and
// growth are settled using housing and comfort from all districts.
function stepColony(config, colony, districts, opts = {}) {
  const g = config.global;
  const maps = opts.neighborMaps || {};
  const modsOf = (d) => (opts.mods && opts.mods[d.id]) || {};
  const coreIdx = districts.findIndex((d) => d.type === 'core');
  if (coreIdx < 0) throw new Error('A colony needs a core district');

  // Manpower: every post that needs workers draws on one workforce. With fewer people than posts,
  // all staffed buildings slow down in proportion.
  const workforce = colony.population * g.workforceShare;
  let posts = 0;
  for (const d of districts) {
    const disabled = modsOf(d).disabled || new Set();
    for (const b of d.buildings) {
      const def = config.buildings[b.type];
      if (def && b.status === 'active' && !disabled.has(b.id)) posts += def.workers || 0;
    }
  }
  const staff = posts <= workforce + EPS || posts === 0 ? 1 : workforce / posts;
  const morOut = moraleMultiplier(config, colony.morale);

  const results = districts.map((d) => stepDistrict(config, d, { staff, morOut }, maps[d.type], modsOf(d)));
  const core = results[coreIdx];
  const inv = core.inventory;
  const flows = core.flows;

  // The population eats from the Core stockpile.
  const starving = [];
  const popMult = opts.popConsumptionMult || 1;
  for (const [res, rate] of Object.entries(g.populationConsumptionPerTick)) {
    const need = rate * colony.population * popMult;
    const take = Math.min(inv[res], need);
    inv[res] -= take;
    flows[res].consumed += take;
    if (need - take > 1e-6) starving.push(res);
  }
  // Prepared meals are optional: nobody starves without them, but eating well lifts morale.
  let mealCoverage = 0;
  if (config.resources.meals) {
    const need = g.mealsPerPopPerTick * colony.population;
    const take = Math.min(inv.meals || 0, need);
    inv.meals = (inv.meals || 0) - take;
    flows.meals.consumed += take;
    mealCoverage = need > 0 ? take / need : 0;
  }
  for (const r of results) {
    for (const res of Object.keys(r.inventory)) r.inventory[res] = Math.min(r.cap, Math.max(0, r.inventory[res]));
  }

  // Housing and comfort come from every district; the hub's own quarters count at neutral comfort,
  // so one bad dormitory doesn't sink the colony.
  const baseHousing = results.reduce((s, r) => s + r.baseHousing, 0);
  const housingBuilt = results.reduce((s, r) => s + r.housingBuilt, 0);
  const comfortWeighted = results.reduce((s, r) => s + r.comfortWeighted, 0);
  const housingCap = Math.floor(baseHousing + housingBuilt);
  const comfortAvg = comfortWeighted / (baseHousing + housingBuilt);

  // Morale drifts toward a target set by food variety and where people live.
  const net = (res) => flows[res].produced - flows[res].consumed;
  const mc = g.morale;
  const target = Math.max(0, Math.min(g.moraleMax, mc.base + comfortAvg + mealCoverage * mc.mealBonus));
  let morale = colony.morale;
  if (starving.length) morale -= 100 / g.moraleFailureThresholdTicks;
  else if (morale < target) morale = Math.min(target, morale + g.moraleRecoveryPerTick);
  else morale = Math.max(target, morale - mc.fallPerTick);
  morale = Math.min(g.moraleMax, Math.max(0, morale));

  // Population grows while there is room, food and hope; it drains away if homes are lost.
  let population = colony.population;
  let grew = false;
  const pg = g.populationGrowth;
  if (!starving.length && morale >= pg.minMorale && population < housingCap
      && (colony.age + 1) % pg.everyTicks === 0 && net('clean_water') > 0 && net('rations') > 0) {
    population = Math.min(housingCap, population + (morale >= pg.fastMorale ? 2 : 1));
    grew = true;
  } else if (population > housingCap && (colony.age + 1) % g.emigrationEveryTicks === 0) {
    population -= 1;
  }

  const progressGain = results.reduce((s, r) => s + r.progressGain, 0);
  const progress = (colony.progress || 0) + progressGain;
  const won = colony.won || progress >= g.beacon.transmitTicks;

  return {
    population, morale, grew, starving, progress, progressGain, won, failed: morale <= 0,
    defense: results.reduce((s, r) => s + r.defense, 0),
    staffing: { posts, workforce, ratio: staff },
    housing: { base: baseHousing, built: housingBuilt, cap: housingCap },
    moraleInfo: { target, base: mc.base, comfort: comfortAvg, meals: mealCoverage * mc.mealBonus, mealCoverage, productivity: morOut },
    districts: results.map((r, i) => ({ id: districts[i].id, type: districts[i].type, ...r })),
    coreIndex: coreIdx,
  };
}

// The single-base shape callers have always used: the Core's results plus the colony-wide ones.
function coreView(res) {
  const c = res.districts[res.coreIndex];
  return {
    inventory: c.inventory, flows: c.flows, buildings: c.buildings, cap: c.cap, defense: res.defense,
    energy: c.energy, hub: c.hub,
    population: res.population, morale: res.morale, grew: res.grew, starving: res.starving,
    staffing: res.staffing, housing: res.housing, moraleInfo: res.moraleInfo,
    progress: res.progress, progressGain: res.progressGain, won: res.won, failed: res.failed,
  };
}

// state: { hubLevel, population, morale, age, progress, won, inventory, buildings:[{id,ring,slot,type,status}] }
// A colony with only its Core. Same behaviour as before districts existed.
function step(config, state, neighborMap, mods = {}) {
  const res = stepColony(
    config,
    { population: state.population, morale: state.morale, age: state.age, progress: state.progress, won: state.won },
    [{ id: 0, type: 'core', level: state.hubLevel, inventory: state.inventory, buildings: state.buildings }],
    { neighborMaps: { core: neighborMap }, mods: { 0: mods }, popConsumptionMult: mods.popConsumptionMult },
  );
  return coreView(res);
}

// Convoy: standing export/import contracts executed on arrival at that
// convoy's market prices (see marketPrices).
function runConvoy(config, state, contracts, prices) {
  const inv = { ...state.inventory };
  let credits = state.credits;
  const cap = state.cap !== undefined ? state.cap : config.hubLevels[state.hubLevel].maxStorage;
  const log = [];
  const maxFor = (res) => convoyLimit(config, state.hubLevel, res);
  for (const [res, amount] of Object.entries(contracts.export || {})) {
    const def = config.resources[res];
    if (!def || amount <= 0) continue;
    const qty = Math.floor(Math.min(amount, maxFor(res), inv[res] || 0));
    if (qty <= 0) { log.push({ kind: 'warn', msg: `Convoy: no ${def.name} in stock to export.` }); continue; }
    const pay = Math.round(qty * prices[res].sell);
    inv[res] -= qty;
    credits += pay;
    log.push({ kind: 'good', msg: `Convoy bought ${qty} ${def.name} for ${pay} cr.` });
  }
  for (const [res, amount] of Object.entries(contracts.import || {})) {
    const def = config.resources[res];
    if (!def || amount <= 0) continue;
    const price = prices[res].buy;
    const room = Math.floor(cap - (inv[res] || 0));
    const afford = Math.floor(credits / price);
    const qty = Math.max(0, Math.min(amount, maxFor(res), room, afford));
    if (qty <= 0) {
      log.push({ kind: 'warn', msg: `Convoy could not deliver ${def.name}: ${afford <= 0 ? 'no credits' : 'storage full'}.` });
      continue;
    }
    const cost = Math.round(qty * price);
    inv[res] = (inv[res] || 0) + qty;
    credits -= cost;
    log.push({ kind: 'good', msg: `Convoy delivered ${qty} ${def.name} for ${cost} cr.` });
  }
  return { inventory: inv, credits, log };
}

// Per-convoy trade limit for a resource: its base limit scaled by the hub level.
function convoyLimit(config, hubLevel, res) {
  const base = config.resources[res].convoyMax || config.global.convoyMaxPerResource;
  return Math.floor(base * (config.hubLevels[hubLevel].convoyCapMult || 1));
}

// ---- district progression -----------------------------------------------------------------
// Districts open up as the Core advances: nothing before Core level `unlockCoreLevel`, a first couple of levels
// then, more when the Core is finished, and the top level as a reward for building the Beacon.
// progress: { coreLevel, beaconBuilt }
function districtsUnlocked(config, progress) {
  return progress.coreLevel >= config.districtProgression.unlockCoreLevel;
}
function districtLevelCap(config, progress) {
  if (!districtsUnlocked(config, progress)) return 0;
  let cap = 1; // a freshly founded district is level 1
  for (const u of config.districtProgression.levelUnlocks) {
    const met = (u.coreLevel === undefined || progress.coreLevel >= u.coreLevel) && (!u.beaconBuilt || progress.beaconBuilt);
    if (met) cap = Math.max(cap, u.districtLevel);
  }
  return cap;
}
// What it takes to reach a given district level, for messages.
function districtLevelNeeds(config, level) {
  const u = config.districtProgression.levelUnlocks.filter((x) => x.districtLevel >= level)
    .sort((a, b) => a.districtLevel - b.districtLevel)[0];
  if (!u) return null;
  const parts = [];
  if (u.coreLevel !== undefined) parts.push(`the Core reaches level ${u.coreLevel}`);
  if (u.beaconBuilt) parts.push('the Beacon is built');
  return parts.join(' and ');
}

function slotUnlocked(config, hubLevel, ring, slot, type = 'core') {
  const cap = levelDef(config, type, hubLevel).ringCapacities[ring];
  return Number.isInteger(slot) && !!cap && slot >= 0 && slot < cap;
}

module.exports = {
  key, storageCap, applyRoutes, ringRotation, maxLevel, districtType, levelDef, buildableIn, shipDistance, districtsUnlocked, districtLevelCap, districtLevelNeeds, stepDistrict, stepColony, coreView, moraleMultiplier, ringCapacities, buildNeighborMap, adjacencyMultiplier, plotSize, plotMultiplier,
  marketMult, marketPrices, nextConvoyK, expressPrices, expressFee, convoyLimit, step, runConvoy, slotUnlocked,
};
