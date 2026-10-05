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

function sortBuildings(config, infos) {
  const rank = (def) => {
    if (def.type === 'generator') return -1;
    const i = config.tierOrder.indexOf(def.type);
    return i < 0 ? 99 : i;
  };
  return infos.slice().sort((a, b) => rank(a.def) - rank(b.def) || a.b.id - b.b.id);
}

// state: { hubLevel, population, morale, age, progress, won, inventory, buildings:[{id,ring,slot,type,status}] }
// mods (from active hazards): { outputMult: {buildingType: m}, disabled: Set<buildingId> }
function step(config, state, neighborMap, mods = {}) {
  const g = config.global;
  const lvl = config.hubLevels[state.hubLevel];
  const grid = new Map(state.buildings.map((b) => [key(b.ring, b.slot), b]));
  const disabled = mods.disabled || new Set();
  const outMult = mods.outputMult || {};

  const infos = [];
  for (const b of state.buildings) {
    const def = config.buildings[b.type];
    if (!def) continue;
    const nTypes = (neighborMap.get(key(b.ring, b.slot)) || [])
      .map(([r, s]) => grid.get(key(r, s)))
      .filter(Boolean)
      .map((n) => n.type);
    const adj = adjacencyMultiplier(config, b.type, nTypes);
    const plot = plotMultiplier(config, def, b.ring);
    const haz = outMult[b.type] === undefined ? 1 : outMult[b.type];
    infos.push({ b, def, adj, plot, haz, mult: adj * plot });
  }
  const offline = (i) => i.b.status !== 'active' || disabled.has(i.b.id);
  const running = sortBuildings(config, infos.filter((i) => !offline(i)));

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
      const made = amt * eff * info.mult * info.haz;
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
    const { eff } = materialEff(i.def.inputsPerTick, probe);
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
    const eff = Math.min(mEff, pEff);
    apply(i, eff, inv, flows);
    if (i.def.transmit) progressGain += eff * i.mult;
    if (i.def.defense) defense += i.def.defense * eff * i.mult;
    if (i.def.storageBonus) storageBonus += i.def.storageBonus * i.mult;
    let status = 'running';
    let why = null;
    if (eff < 0.999) {
      if (pEff < mEff - EPS) { status = pEff < 0.01 ? 'no_power' : 'low_power'; }
      else { status = mEff < 0.01 ? 'starved' : 'low_input'; why = limiting; }
    }
    bstate.set(i.b.id, { eff, mult: i.mult, adj: i.adj, plot: i.plot, haz: i.haz, status, limiting: why });
  }

  // Population draws on the stockpile.
  const cap = lvl.maxStorage + storageBonus;
  const starving = [];
  for (const [res, rate] of Object.entries(g.populationConsumptionPerTick)) {
    const need = rate * state.population;
    const take = Math.min(inv[res], need);
    inv[res] -= take;
    flows[res].consumed += take;
    if (need - take > 1e-6) starving.push(res);
  }
  for (const res of Object.keys(inv)) {
    inv[res] = Math.min(cap, Math.max(0, inv[res]));
  }

  // Morale, growth, beacon progress.
  const net = (res) => flows[res].produced - flows[res].consumed;
  let morale = state.morale;
  if (starving.length) morale -= 100 / g.moraleFailureThresholdTicks;
  else morale += g.moraleRecoveryPerTick;
  morale = Math.min(g.startingMorale, Math.max(0, morale));

  let population = state.population;
  let grew = false;
  const pg = g.populationGrowth;
  if (!starving.length && morale >= pg.minMorale && population < lvl.maxPopulation
      && (state.age + 1) % pg.everyTicks === 0 && net('clean_water') > 0 && net('rations') > 0) {
    population += 1;
    grew = true;
  }

  const progress = (state.progress || 0) + progressGain;
  const won = state.won || progress >= g.beacon.transmitTicks;

  return {
    inventory: inv, flows, population, morale, grew, starving, cap, defense,
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
  key, maxLevel, ringCapacities, buildNeighborMap, adjacencyMultiplier, plotSize, plotMultiplier,
  marketMult, marketPrices, convoyLimit, step, runConvoy, slotUnlocked,
};
