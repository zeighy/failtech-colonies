'use strict';
const sim = require('./sim');
const store = require('./db');
const engine = require('./engine');
const objectives = require('./objectives');
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
    rings: caps,
    neighbors,
    convoyIntervalTicks: config.global.convoyIntervalTicks,
    convoyMax: config.global.convoyMaxPerResource,
    demolishRefund: config.global.demolishRefund,
    goalSustainTicks: config.global.goalSustainTicks,
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
  const proj = sim.step(config, {
    hubLevel: c.hub_level, population: c.population, morale: c.morale, age: c.age,
    goalTicks: c.goal_ticks, won: !!c.won, inventory, buildings,
  }, engine.neighborMap);

  const resources = {};
  for (const res of Object.keys(config.resources)) {
    const f = proj.flows[res];
    const net = f.produced - f.consumed;
    const amount = inventory[res] || 0;
    resources[res] = {
      amount, cap: lvl.maxStorage, produced: f.produced, consumed: f.consumed, net,
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
      status: c.status, won: !!c.won, goalTicks: c.goal_ticks, goalMet: proj.goalMet,
      restartCredits: Math.max(config.global.startingState.credits, Math.floor(c.credits * config.global.failureCreditKeep)),
      hubLevel: c.hub_level, credits: c.credits, population: c.population,
      maxPopulation: lvl.maxPopulation, morale: c.morale, failures: c.failures,
      starving: proj.starving,
    },
    hub: {
      maxStorage: lvl.maxStorage, baseEnergy: lvl.baseEnergy, rings: lvl.ringCapacities,
      upgrading: orders.some((o) => o.action_type === 'upgrade'),
    },
    energy: proj.energy,
    resources,
    buildings: buildings.map((b) => {
      const s = proj.buildings.get(b.id) || {};
      return { id: b.id, ring: b.ring, slot: b.slot, type: b.type, paused: b.status !== 'active',
        status: s.status, eff: s.eff, mult: s.mult, limiting: s.limiting };
    }),
    orders: orders.map((o) => ({ id: o.id, kind: o.action_type, data: o.data, remaining: o.ticks_remaining, total: o.ticks_total })),
    contracts: store.loadContracts(c.id),
    events: db.prepare('SELECT id, tick, kind, message FROM colony_events WHERE colony_id = ? ORDER BY id DESC LIMIT 40').all(c.id),
  };

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
