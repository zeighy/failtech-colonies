'use strict';
const sim = require('./sim');
const store = require('./db');
const engine = require('./engine');
const objectives = require('./objectives');
const hazards = require('./hazards');
const { db, config } = store;

// Static data the client needs once: building defs, resource meta, slot geometry.
function clientConfig() {
  const caps = sim.ringCapacities(config);
  const neighbors = {};
  for (const [k, list] of engine.neighborMap) neighbors[k] = list;
  return {
    resources: config.resources,
    buildings: config.buildings,
    hubLevels: config.hubLevels,
    adjacencyRules: config.adjacencyModifiers.rules,
    ringPlotSize: config.ringPlotSize,
    plotSizes: config.plotSizes,
    plotPenalty: config.global.plotPenaltyPerStep,
    transmitTicks: config.global.beacon.transmitTicks,
    rings: caps,
    neighbors,
    convoyIntervalTicks: config.global.convoyIntervalTicks,
    convoyMax: config.global.convoyMaxPerResource,
    demolishRefund: config.global.demolishRefund,
    failureThresholdTicks: config.global.moraleFailureThresholdTicks,
  };
}

function viewFor(userId, now = Date.now()) {
  const c = db.prepare('SELECT * FROM colonies WHERE user_id = ?').get(userId);
  if (!c) return null;
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
  const t = engine.timing();
  const lvl = config.hubLevels[c.hub_level];
  const inventory = store.loadInventory(c.id);
  const buildings = store.loadBuildings(c.id);
  const orders = store.loadOrders(c.id);

  // Dry run of the next tick = the rates the player is living under right now.
  const hazard = store.loadHazard(c.id);
  const mods = hazards.modifiersFor(config, hazard, buildings);
  const proj = sim.step(config, {
    hubLevel: c.hub_level, population: c.population, morale: c.morale, age: c.age,
    progress: c.progress, won: !!c.won, inventory, buildings,
  }, engine.neighborMap, mods);

  const resources = {};
  for (const res of Object.keys(config.resources)) {
    const f = proj.flows[res];
    const net = f.produced - f.consumed;
    const amount = inventory[res] || 0;
    resources[res] = {
      amount, cap: proj.cap, produced: f.produced, consumed: f.consumed, net,
      ticksLeft: net < -1e-6 ? amount / -net : null,
    };
  }

  const ticksToConvoy = config.global.convoyIntervalTicks - (t.globalTick % config.global.convoyIntervalTicks);
  const nextTickAt = t.lastTickAt + t.tickMs;

  const view = {
    user: user.username,
    tick: t.globalTick, tickMs: t.tickMs, nextTickAt, serverNow: now,
    convoy: { ticksLeft: ticksToConvoy, arrivesAt: nextTickAt + (ticksToConvoy - 1) * t.tickMs },
    colony: {
      status: c.status, won: !!c.won, progress: proj.progress, hazardsSurvived: c.hazards_survived,
      restartCredits: Math.max(config.global.startingState.credits, Math.floor(c.credits * config.global.failureCreditKeep)),
      hubLevel: c.hub_level, credits: c.credits, population: c.population,
      maxPopulation: lvl.maxPopulation, morale: c.morale, failures: c.failures,
      starving: proj.starving,
    },
    hub: {
      maxStorage: proj.cap, baseStorage: lvl.maxStorage, baseEnergy: lvl.baseEnergy, rings: lvl.ringCapacities,
      upkeep: lvl.upkeepPerTick || {}, eff: proj.hub.eff, limiting: proj.hub.limiting, power: proj.hub.power,
      upgrading: orders.some((o) => o.action_type === 'upgrade'),
    },
    defense: proj.defense,
    energy: proj.energy,
    resources,
    buildings: buildings.map((b) => {
      const s = proj.buildings.get(b.id) || {};
      return { id: b.id, ring: b.ring, slot: b.slot, type: b.type, paused: b.status !== 'active',
        status: s.status, eff: s.eff, mult: s.mult, adj: s.adj, plot: s.plot, haz: s.haz, limiting: s.limiting };
    }),
    orders: orders.map((o) => ({ id: o.id, kind: o.action_type, data: o.data, remaining: o.ticks_remaining, total: o.ticks_total })),
    contracts: store.loadContracts(c.id),
    events: db.prepare('SELECT id, tick, kind, message FROM colony_events WHERE colony_id = ? ORDER BY id DESC LIMIT 40').all(c.id),
  };

  // Convoy market: the next convoy's prices (known in advance) and how they moved.
  const arrivalTick = t.globalTick + ticksToConvoy;
  const k = arrivalTick / config.global.convoyIntervalTicks;
  const now_ = sim.marketPrices(config, k);
  const before = sim.marketPrices(config, k - 1);
  const prices = {};
  for (const res of Object.keys(config.resources)) {
    prices[res] = { buy: now_[res].buy, sell: now_[res].sell, trend: now_[res].mult / before[res].mult - 1, mult: now_[res].mult };
  }
  view.market = { prices };

  if (hazard) {
    const def = config.hazards.types[hazard.type];
    const { reqs, prep } = hazards.assess(config, hazard.type, c.hub_level, inventory, proj.defense);
    const sev = hazard.state === 'active' ? hazard.severity : 1 - prep;
    const strikesIn = hazard.strikes_tick - t.globalTick;
    view.hazard = {
      type: hazard.type, name: def.name, desc: def.desc, state: hazard.state,
      ticksUntil: hazard.state === 'forecast' ? strikesIn : 0,
      strikesAt: nextTickAt + (strikesIn - 1) * t.tickMs,
      ticksLeft: hazard.state === 'active' ? hazard.ends_tick - t.globalTick : 0,
      requirements: reqs, prep, effect: hazards.describeEffect(config, { type: hazard.type, severity: sev, data: hazard.data }),
    };
  } else view.hazard = null;
  view.report = db.prepare("SELECT id, tick, kind, message FROM colony_events WHERE colony_id = ? AND tag = 'hazard' AND id > ? ORDER BY id").all(c.id, c.report_cursor);

  // Directives are sticky: newly earned milestones are saved as the view is
  // built (idempotent progress tracking, only writes when something changed).
  const known = JSON.parse(c.milestones);
  const brief = objectives.evaluate(config, view, known);
  if (brief.doneIds.length !== known.length) {
    db.prepare('UPDATE colonies SET milestones = ? WHERE id = ?').run(JSON.stringify(brief.doneIds), c.id);
  }
  view.brief = { directives: brief.list, remaining: brief.remaining };
  view.doom = brief.doom;
  return view;
}

module.exports = { clientConfig, viewFor };
