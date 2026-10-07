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
    morale: config.global.morale,
    workforceShare: config.global.workforceShare,
    mealsPerPop: config.global.mealsPerPopPerTick,
    rings: caps,
    neighbors,
    districtTypes: Object.fromEntries(Object.entries(config.districtTypes || {}).map(([type, t]) => [type, {
      name: t.name, desc: t.desc, color: t.color, distance: t.distance, angle: t.angle, radius: t.radius,
      foundCost: t.foundCost, foundTicks: t.foundTicks, levels: t.levels, ringPlotSize: t.ringPlotSize,
      rings: sim.ringCapacities(config, type), neighbors: Object.fromEntries(engine.neighborMaps[type]),
    }])),
    logistics: config.logistics,
    convoyIntervalTicks: config.global.convoyIntervalTicks,
    demolishRefund: config.global.demolishRefund,
    failureThresholdTicks: config.global.moraleFailureThresholdTicks,
  };
}

// Which buildings is the current hazard touching? 'hit' = being hurt now, 'upkeep' = paying the
// maintenance cost, 'risk' = in the forecast's firing line.
function hazardMark(hazard, b, s, buildings) {
  if (!hazard) return null;
  const def = config.hazards.types[hazard.type];
  if (!def) return null;
  const m = def.mitigated;
  const paysUpkeep = m && m.kind === 'drain' && ((m.perBuilding || {})[b.type] || (m.perRunning && b.status === 'active'));
  if (hazard.state === 'forecast') {
    const e = def.effect;
    return (e.kind === 'output_mult' && e.buildings.includes(b.type)) || paysUpkeep ? 'risk' : null;
  }
  if (s.haz !== undefined && s.haz < 0.999) return 'hit';
  const prep = hazard.data && hazard.data.prep !== undefined ? hazard.data.prep : 1 - hazard.severity;
  return paysUpkeep && prep > 0.02 ? 'upkeep' : null;
}

function viewFor(userId, now = Date.now()) {
  const c = db.prepare('SELECT * FROM colonies WHERE user_id = ?').get(userId);
  if (!c) return null;
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
  const t = engine.timing();
  const lvl = config.hubLevels[c.hub_level];
  const districts = store.loadDistricts(c.id).map((d) => ({
    id: d.id, type: d.type, name: d.name,
    level: d.type === 'core' ? c.hub_level : d.level,
    inventory: store.loadInventory(c.id, d.id), buildings: store.loadBuildings(c.id, d.id),
  }));
  const coreD = districts.find((d) => d.type === 'core');
  // The top-level view is still the Core's; other districts will get their own views.
  const inventory = coreD.inventory;
  const buildings = coreD.buildings;
  const orders = store.loadOrders(c.id, coreD.id);

  // Dry run of the next tick = the rates the player is living under right now.
  const hazard = store.loadHazard(c.id);
  const mods = hazards.modifiersFor(config, hazard, buildings);
  const full = sim.stepColony(
    config,
    { population: c.population, morale: c.morale, age: c.age, progress: c.progress, won: !!c.won },
    districts,
    { neighborMaps: engine.neighborMaps, mods: { [coreD.id]: mods }, popConsumptionMult: mods.popConsumptionMult },
  );
  const proj = sim.coreView(full);

  // A view of one district: stock with rates, grid, hub, buildings and orders.
  const allOrders = store.loadOrders(c.id);
  const districtView = (d, r) => {
    const isCore = d.type === 'core';
    const flows = isCore ? proj.flows : r.flows;
    const cap = isCore ? proj.cap : r.cap;
    const resources = {};
    for (const res of Object.keys(config.resources)) {
      const f = flows[res];
      const net = f.produced - f.consumed;
      const amount = d.inventory[res] || 0;
      resources[res] = { amount, cap, produced: f.produced, consumed: f.consumed, net, ticksLeft: net < -1e-6 ? amount / -net : null };
    }
    const lvl = sim.levelDef(config, d.type, d.level);
    const dOrders = allOrders.filter((o) => o.district_id === d.id || (isCore && !o.district_id));
    const bs = isCore ? proj.buildings : r.buildings;
    const hub = isCore ? proj.hub : r.hub;
    return {
      id: d.id, type: d.type, name: d.name, level: d.level, core: isCore,
      resources, cap,
      hub: {
        maxStorage: cap, baseStorage: lvl.maxStorage, baseEnergy: lvl.baseEnergy, rings: lvl.ringCapacities,
        upkeep: lvl.upkeepPerTick || {}, eff: hub.eff, limiting: hub.limiting, power: hub.power,
        upgrading: dOrders.some((o) => o.action_type === 'upgrade'),
      },
      defense: isCore ? proj.defense : r.defense,
      energy: isCore ? proj.energy : r.energy,
      buildings: d.buildings.map((b) => {
        const st = bs.get(b.id) || {};
        return { id: b.id, ring: b.ring, slot: b.slot, type: b.type, paused: b.status !== 'active',
          status: st.status, eff: st.eff, mult: st.mult, adj: st.adj, plot: st.plot, haz: st.haz, limiting: st.limiting,
          comfort: st.comfort === undefined ? null : st.comfort, mark: isCore ? hazardMark(hazard, b, st, d.buildings) : null };
      }),
      orders: dOrders.map((o) => ({ id: o.id, kind: o.action_type, data: o.data, remaining: o.ticks_remaining, total: o.ticks_total })),
    };
  };
  const views = {};
  districts.forEach((d, i) => { views[d.id] = districtView(d, full.districts[i]); });
  const coreV = views[coreD.id];
  const resources = coreV.resources;

  const ticksToConvoy = config.global.convoyIntervalTicks - (t.globalTick % config.global.convoyIntervalTicks);
  const nextTickAt = t.lastTickAt + t.tickMs;

  const view = {
    user: user.username,
    tick: t.globalTick, tickMs: t.tickMs, nextTickAt, serverNow: now,
    districtsUnlocked: sim.districtsUnlocked(config, { coreLevel: c.hub_level }),
    districtLevelCap: sim.districtLevelCap(config, { coreLevel: c.hub_level, beaconBuilt: store.hasBeacon(c.id) }),
    districts: districts.map((d) => ({ id: d.id, type: d.type, name: d.name, level: d.level, core: d.type === 'core', buildings: d.buildings.length })),
    founding: allOrders.filter((o) => o.action_type === 'found').map((o) => ({ id: o.id, type: o.data.type, remaining: o.ticks_remaining, total: o.ticks_total })),
    convoy: { ticksLeft: ticksToConvoy, arrivesAt: nextTickAt + (ticksToConvoy - 1) * t.tickMs },
    colony: {
      status: c.status, won: !!c.won, progress: proj.progress, hazardsSurvived: c.hazards_survived,
      restartCredits: Math.max(config.global.startingState.credits, Math.floor(c.credits * config.global.failureCreditKeep)),
      hubLevel: c.hub_level, credits: c.credits, population: c.population,
      maxPopulation: proj.housing.cap, housing: proj.housing, staffing: proj.staffing, moraleInfo: proj.moraleInfo,
      morale: c.morale, failures: c.failures,
      starving: proj.starving,
    },
    hub: coreV.hub,
    defense: proj.defense,
    energy: proj.energy,
    resources,
    buildings: coreV.buildings,
    orders: coreV.orders,
    views,
    shipments: store.loadShipments(c.id).map((sh) => ({ ...sh, ticksLeft: Math.max(0, sh.arrivesTick - t.globalTick) })),
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
  const limits = {};
  for (const res of Object.keys(config.resources)) limits[res] = sim.convoyLimit(config, c.hub_level, res);
  view.market = { prices, limits };

  if (hazard) {
    const def = config.hazards.types[hazard.type];
    const { reqs, prep } = hazards.assess(config, hazard.type, c.hub_level, inventory, proj.defense);
    const active = hazard.state === 'active';
    const strikePrep = prep >= 0.98 ? 1 : prep;
    const sev = active ? hazard.severity : 1 - strikePrep;
    const shownPrep = active ? (hazard.data.prep === undefined ? 1 - hazard.severity : hazard.data.prep) : prep;
    const data = active ? hazard.data : { prep: strikePrep };
    const lines = hazards.effectLines(config, { type: hazard.type, state: 'active', severity: sev, data }, buildings, c.hub_level);
    const strikesIn = hazard.strikes_tick - t.globalTick;
    view.hazard = {
      type: hazard.type, name: def.name, desc: def.desc, state: hazard.state,
      ticksUntil: active ? 0 : strikesIn,
      strikesAt: nextTickAt + (strikesIn - 1) * t.tickMs,
      ticksLeft: active ? hazard.ends_tick - t.globalTick : 0,
      durationTicks: def.durationTicks,
      requirements: reqs, prep: shownPrep, severity: sev,
      penalty: lines.penalty, cost: lines.cost,
    };
  } else view.hazard = null;

  // Express convoy: terms, status and cooldown.
  const x = config.global.express;
  const expressNow = sim.expressPrices(config, now_);
  const trip = store.loadExpress(c.id);
  const xlimits = {};
  for (const res of Object.keys(config.resources)) xlimits[res] = Math.max(1, Math.floor(limits[res] * x.limitFraction));
  view.express = {
    fee: sim.expressFee(config, c.hub_level), travelTicks: x.travelTicks, cooldownTicks: x.cooldownTicks,
    buyMult: x.buyMult, sellMult: x.sellMult,
    prices: Object.fromEntries(Object.entries(expressNow).map(([r, p]) => [r, { buy: p.buy, sell: p.sell }])),
    limits: xlimits,
    readyIn: Math.max(0, c.express_ready_tick - t.globalTick),
    active: trip ? {
      ticksLeft: Math.max(0, trip.arrives_tick - t.globalTick),
      arrivesAt: nextTickAt + (trip.arrives_tick - t.globalTick - 1) * t.tickMs,
      sell: trip.sell, buy: trip.buy,
    } : null,
  };
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
