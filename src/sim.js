'use strict';
// Pure game simulation. No database, no clocks: given a colony snapshot it
// returns the next one. The engine applies it for real; the API runs it as a
// dry run to show players their current production rates.

const EPS = 1e-9;
const key = (ring, slot) => `${ring}:${slot}`;

function maxLevel(config) {
  return Math.max(...Object.keys(config.hubLevels).map(Number));
}

// Ring sizes never change between hub levels (higher levels only unlock more
// rings), so one neighbour map built from the top level serves every colony.
function ringCapacities(config) {
  return config.hubLevels[maxLevel(config)].ringCapacities;
}

function buildNeighborMap(config) {
  const caps = ringCapacities(config);
  const map = new Map();
  for (const [r, cap] of Object.entries(caps)) {
    const ring = Number(r);
    for (let i = 0; i < cap; i++) {
      const out = [];
      if (cap > 1) {
        out.push([ring, (i - 1 + cap) % cap]);
        if (cap > 2) out.push([ring, (i + 1) % cap]);
      }
      const lo = i / cap;
      const hi = (i + 1) / cap;
      for (const other of [ring - 1, ring + 1]) {
        const oc = caps[other];
        if (!oc) continue;
        for (let j = 0; j < oc; j++) {
          const overlap = Math.min(hi, (j + 1) / oc) - Math.max(lo, j / oc);
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
const plotSize = (config, ring) => config.ringPlotSize[ring] || 1;
function plotMultiplier(config, def, ring) {
  const deficit = Math.max(0, (def.minPlotSize || 1) - plotSize(config, ring));
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

// state: { hubLevel, population, morale, age, progress, won, inventory, buildings:[{id,ring,slot,type,status}] }
// mods (from active hazards):
//   outputMult: {buildingType: m}   output multiplier by type
//   degraded:   {buildingId: m}     output multiplier for specific buildings
//   disabled:   Set<buildingId>     buildings knocked fully offline
//   popConsumptionMult: number      multiplies what the population eats and drinks
//   drain:      {resource: perTick} extra maintenance consumption
function step(config, state, neighborMap, mods = {}) {
  const g = config.global;
  const lvl = config.hubLevels[state.hubLevel];
  const grid = new Map(state.buildings.map((b) => [key(b.ring, b.slot), b]));
  const disabled = mods.disabled || new Set();
  const outMult = mods.outputMult || {};
  const degraded = mods.degraded || {};

  const infos = [];
  for (const b of state.buildings) {
    const def = config.buildings[b.type];
    if (!def) continue;
    const nbs = (neighborMap.get(key(b.ring, b.slot)) || [])
      .map(([r, s]) => grid.get(key(r, s)))
      .filter(Boolean);
    const adj = adjacencyMultiplier(config, b.type, nbs.map((n) => n.type));
    const plot = plotMultiplier(config, def, b.ring);
    const haz = (outMult[b.type] === undefined ? 1 : outMult[b.type]) * (degraded[b.id] === undefined ? 1 : degraded[b.id]);
    infos.push({ b, def, adj, plot, haz, nbs, mult: adj * plot });
  }
  const offline = (i) => i.b.status !== 'active' || disabled.has(i.b.id);
  const running = sortBuildings(config, infos.filter((i) => !offline(i)));

  // Manpower: every post that needs workers draws on the same workforce. With fewer people
  // than posts, all staffed buildings slow down in proportion.
  const workforce = state.population * g.workforceShare;
  const posts = running.reduce((s, i) => s + (i.def.workers || 0), 0);
  const staff = posts <= workforce + EPS || posts === 0 ? 1 : workforce / posts;
  const staffOf = (i) => ((i.def.workers || 0) > 0 ? staff : 1);
  const morOut = moraleMultiplier(config, state.morale);

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
      const made = amt * eff * info.mult * info.haz * morOut;
      inv[res] = (inv[res] || 0) + made;
      if (flows) flows[res].produced += made;
    }
  };

  // Hub upkeep (level 3+): paid from stock at the start of the tick. If the hub
  // can't be fully maintained, its own power output drops with it.
  const upkeep = lvl.upkeepPerTick || {};
  const hubMat = materialEff(upkeep, state.inventory);
  const hubEff = hubMat.eff;
  const hubPower = (lvl.baseEnergy - (upkeep.energy || 0)) * hubEff;

  // Energy is a grid, not a stockpile: supply this tick vs. demand this tick.
  // Pass 1 (dry): how much power would everything want if power were unlimited?
  const probe = { ...state.inventory };
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
  const inv = { ...state.inventory };
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
    bstate.set(i.b.id, { eff, mult: i.mult, adj: i.adj, plot: i.plot, haz: i.haz, status, limiting: why });
  }

  // Housing and neighbourhood comfort. Homes next to noisy, smoky buildings are miserable.
  let housingBuilt = 0;
  let comfortWeighted = 0;
  const comfortOf = new Map();
  for (const i of running) {
    if (!i.def.housing) continue;
    const cap = i.def.housing * i.plot;
    const raw = i.nbs.reduce((s, n) => s + (n.status === 'active' ? (config.buildings[n.type].comfort || 0) : 0), 0);
    const comfort = Math.max(g.morale.comfortMin, Math.min(g.morale.comfortMax, raw));
    housingBuilt += cap;
    comfortWeighted += cap * comfort;
    comfortOf.set(i.b.id, comfort);
  }
  const housingCap = Math.floor(lvl.baseHousing + housingBuilt);
  // The hub's own quarters count at neutral comfort, so one bad dormitory doesn't sink the colony.
  const comfortAvg = comfortWeighted / (lvl.baseHousing + housingBuilt);
  for (const [id, comfort] of comfortOf) { const s = bstate.get(id); if (s) s.comfort = comfort; }

  // Hazard maintenance: extra consumption while a hazard is being weathered.
  for (const [res, amt] of Object.entries(mods.drain || {})) {
    if (!flows[res]) continue;
    const take = Math.min(inv[res] || 0, amt);
    inv[res] = (inv[res] || 0) - take;
    flows[res].consumed += take;
  }

  // Population draws on the stockpile.
  const cap = lvl.maxStorage + storageBonus;
  const starving = [];
  const popMult = mods.popConsumptionMult || 1;
  for (const [res, rate] of Object.entries(g.populationConsumptionPerTick)) {
    const need = rate * state.population * popMult;
    const take = Math.min(inv[res], need);
    inv[res] -= take;
    flows[res].consumed += take;
    if (need - take > 1e-6) starving.push(res);
  }
  // Prepared meals are optional: nobody starves without them, but eating well lifts morale.
  let mealCoverage = 0;
  if (config.resources.meals) {
    const need = g.mealsPerPopPerTick * state.population;
    const take = Math.min(inv.meals || 0, need);
    inv.meals = (inv.meals || 0) - take;
    flows.meals.consumed += take;
    mealCoverage = need > 0 ? take / need : 0;
  }
  for (const res of Object.keys(inv)) {
    inv[res] = Math.min(cap, Math.max(0, inv[res]));
  }

  // Morale drifts toward a target set by food variety and where people live.
  const net = (res) => flows[res].produced - flows[res].consumed;
  const mc = g.morale;
  const target = Math.max(0, Math.min(g.moraleMax, mc.base + comfortAvg + mealCoverage * mc.mealBonus));
  let morale = state.morale;
  if (starving.length) morale -= 100 / g.moraleFailureThresholdTicks;
  else if (morale < target) morale = Math.min(target, morale + g.moraleRecoveryPerTick);
  else morale = Math.max(target, morale - mc.fallPerTick);
  morale = Math.min(g.moraleMax, Math.max(0, morale));

  // Population grows while there is room, food and hope; it drains away if homes are lost.
  let population = state.population;
  let grew = false;
  const pg = g.populationGrowth;
  if (!starving.length && morale >= pg.minMorale && population < housingCap
      && (state.age + 1) % pg.everyTicks === 0 && net('clean_water') > 0 && net('rations') > 0) {
    population = Math.min(housingCap, population + (morale >= pg.fastMorale ? 2 : 1));
    grew = true;
  } else if (population > housingCap && (state.age + 1) % g.emigrationEveryTicks === 0) {
    population -= 1;
  }

  const progress = (state.progress || 0) + progressGain;
  const won = state.won || progress >= g.beacon.transmitTicks;

  return {
    inventory: inv, flows, population, morale, grew, starving, cap, defense,
    staffing: { posts, workforce, ratio: staff },
    housing: { base: lvl.baseHousing, built: housingBuilt, cap: housingCap },
    moraleInfo: { target, base: mc.base, comfort: comfortAvg, meals: mealCoverage * mc.mealBonus, mealCoverage, productivity: morOut },
    energy: { supply, demand, satisfaction: sat },
    hub: { eff: hubEff, limiting: hubMat.limiting, power: hubPower },
    buildings: bstate, progress, progressGain, won, failed: morale <= 0,
  };
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

function slotUnlocked(config, hubLevel, ring, slot) {
  const cap = config.hubLevels[hubLevel].ringCapacities[ring];
  return Number.isInteger(slot) && !!cap && slot >= 0 && slot < cap;
}

module.exports = {
  key, maxLevel, moraleMultiplier, ringCapacities, buildNeighborMap, adjacencyMultiplier, plotSize, plotMultiplier,
  marketMult, marketPrices, nextConvoyK, expressPrices, expressFee, convoyLimit, step, runConvoy, slotUnlocked,
};
