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

function sortBuildings(config, infos) {
  const rank = (def) => (def.type === 'generator' ? -1 : config.tierOrder.indexOf(def.type));
  return infos.slice().sort((a, b) => rank(a.def) - rank(b.def) || a.b.id - b.b.id);
}

// state: { hubLevel, population, morale, age, goalTicks, won, inventory, buildings:[{id,ring,slot,type,status}] }
function step(config, state, neighborMap) {
  const g = config.global;
  const lvl = config.hubLevels[state.hubLevel];
  const grid = new Map(state.buildings.map((b) => [key(b.ring, b.slot), b]));

  const infos = [];
  for (const b of state.buildings) {
    const def = config.buildings[b.type];
    if (!def) continue;
    const nTypes = (neighborMap.get(key(b.ring, b.slot)) || [])
      .map(([r, s]) => grid.get(key(r, s)))
      .filter(Boolean)
      .map((n) => n.type);
    infos.push({ b, def, mult: adjacencyMultiplier(config, b.type, nTypes) });
  }
  const running = sortBuildings(config, infos.filter((i) => i.b.status === 'active'));

  const materialEff = (def, inv) => {
    let eff = 1;
    let limiting = null;
    for (const [res, amt] of Object.entries(def.inputsPerTick)) {
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
      const made = amt * eff * info.mult;
      inv[res] = (inv[res] || 0) + made;
      if (flows) flows[res].produced += made;
    }
  };

  // Energy is a grid, not a stockpile: supply this tick vs. demand this tick.
  let supply = lvl.baseEnergy;
  for (const i of running) {
    if (i.def.type === 'generator') supply += (i.def.outputsPerTick.energy || 0) * i.mult;
  }
  // Pass 1 (dry): how much power would everything want if power were unlimited?
  const probe = { ...state.inventory };
  let demand = 0;
  for (const i of running) {
    const { eff } = materialEff(i.def, probe);
    demand += (i.def.inputsPerTick.energy || 0) * eff;
    apply(i, eff, probe, null);
  }
  const sat = demand <= supply + EPS || demand === 0 ? 1 : supply / demand;

  // Pass 2: the real thing.
  const inv = { ...state.inventory };
  for (const res of Object.keys(config.resources)) inv[res] = inv[res] || 0;
  const flows = {};
  for (const res of Object.keys(config.resources)) flows[res] = { produced: 0, consumed: 0 };
  const bstate = new Map();
  for (const i of infos) {
    if (i.b.status !== 'active') {
      bstate.set(i.b.id, { eff: 0, mult: i.mult, status: 'paused', limiting: null });
    }
  }
  for (const i of running) {
    const hasPower = (i.def.inputsPerTick.energy || 0) > 0;
    const { eff: mEff, limiting } = materialEff(i.def, inv);
    const pEff = hasPower ? sat : 1;
    const eff = Math.min(mEff, pEff);
    apply(i, eff, inv, flows);
    let status = 'running';
    let why = null;
    if (eff < 0.999) {
      if (pEff < mEff - EPS) { status = pEff < 0.01 ? 'no_power' : 'low_power'; }
      else { status = mEff < 0.01 ? 'starved' : 'low_input'; why = limiting; }
    }
    bstate.set(i.b.id, { eff, mult: i.mult, status, limiting: why });
  }

  // Population draws on the stockpile.
  const starving = [];
  for (const [res, rate] of Object.entries(g.populationConsumptionPerTick)) {
    const need = rate * state.population;
    const take = Math.min(inv[res], need);
    inv[res] -= take;
    flows[res].consumed += take;
    if (need - take > 1e-6) starving.push(res);
  }
  for (const res of Object.keys(inv)) {
    inv[res] = Math.min(lvl.maxStorage, Math.max(0, inv[res]));
  }

  // Morale, growth, goal.
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

  const goalMet = state.hubLevel >= maxLevel(config) && sat >= 1 - EPS && !starving.length
    && net('clean_water') > 0 && net('rations') > 0;
  const goalTicks = goalMet ? state.goalTicks + 1 : 0;
  const won = state.won || goalTicks >= g.goalSustainTicks;

  return {
    inventory: inv, flows, population, morale, grew, starving,
    energy: { supply, demand, satisfaction: sat },
    buildings: bstate, goalTicks, goalMet, won, failed: morale <= 0,
  };
}

// Convoy: standing export/import contracts executed on arrival.
function runConvoy(config, state, contracts) {
  const lvl = config.hubLevels[state.hubLevel];
  const inv = { ...state.inventory };
  let credits = state.credits;
  const log = [];
  const max = config.global.convoyMaxPerResource;
  for (const [res, amount] of Object.entries(contracts.export || {})) {
    const def = config.resources[res];
    if (!def || amount <= 0) continue;
    const qty = Math.floor(Math.min(amount, max, inv[res] || 0));
    if (qty <= 0) { log.push({ kind: 'warn', msg: `Convoy: no ${def.name} in stock to export.` }); continue; }
    const pay = Math.round(qty * def.sell);
    inv[res] -= qty;
    credits += pay;
    log.push({ kind: 'good', msg: `Convoy bought ${qty} ${def.name} for ${pay} cr.` });
  }
  for (const [res, amount] of Object.entries(contracts.import || {})) {
    const def = config.resources[res];
    if (!def || amount <= 0) continue;
    const room = Math.floor(lvl.maxStorage - (inv[res] || 0));
    const afford = Math.floor(credits / def.buy);
    const qty = Math.max(0, Math.min(amount, max, room, afford));
    if (qty <= 0) {
      log.push({ kind: 'warn', msg: `Convoy could not deliver ${def.name}: ${afford <= 0 ? 'no credits' : 'storage full'}.` });
      continue;
    }
    const cost = Math.round(qty * def.buy);
    inv[res] = (inv[res] || 0) + qty;
    credits -= cost;
    log.push({ kind: 'good', msg: `Convoy delivered ${qty} ${def.name} for ${cost} cr.` });
  }
  return { inventory: inv, credits, log };
}

function slotUnlocked(config, hubLevel, ring, slot) {
  const cap = config.hubLevels[hubLevel].ringCapacities[ring];
  return Number.isInteger(slot) && !!cap && slot >= 0 && slot < cap;
}

module.exports = {
  key, maxLevel, ringCapacities, buildNeighborMap, adjacencyMultiplier,
  step, runConvoy, slotUnlocked,
};
