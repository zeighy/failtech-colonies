'use strict';
const sim = require('./sim');
const store = require('./db');
const engine = require('./engine');
const objectives = require('./objectives');
const hazards = require('./hazards');
const ms = require('./marketsim');
const missions = require('./missions');
const market = require('./market');
const story = require('./story');
const shutdown = require('./shutdown');
const orbital = require('./orbital');
const territories = require('./territories');
const credits = require('./credits');
const queue = require('./queue');
const requisitions = require('./requisitions');
const projects = require('./projects');
const orbitalMarket = require('./orbitalMarket');
const { db, config } = store;

// Static data the client needs once: building defs, resource meta, slot geometry.
function clientConfig() {
  const caps = sim.ringCapacities(config);
  const neighbors = {};
  for (const [k, list] of engine.neighborMap) neighbors[k] = list;
  return {
    ui: config.theme.ui,
    themeId: config.theme.id,
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
    ringRotation: config.ringRotation || {},
    neighbors,
    districtTypes: Object.fromEntries(Object.entries(config.districtTypes || {}).map(([type, t]) => [type, {
      requires: t.requires || null, name: t.name, desc: t.desc, color: t.color, distance: t.distance, angle: t.angle, radius: t.radius,
      foundCost: t.foundCost, foundTicks: t.foundTicks, levels: t.levels, ringPlotSize: t.ringPlotSize,
      rings: sim.ringCapacities(config, type), ringRotation: t.ringRotation || {}, neighbors: Object.fromEntries(engine.neighborMaps[type]),
    }])),
    orbitalTypes: Object.fromEntries(Object.entries(config.orbitalTypes || {}).map(([type, t]) => [type, {
      name: t.name, color: t.color, levels: t.levels, ringPlotSize: t.ringPlotSize,
      rings: sim.ringCapacities(config, type), ringRotation: t.ringRotation || {}, neighbors: Object.fromEntries(engine.neighborMaps[type]),
    }])),
    orbitalRecipeBook: sim.recipeBook(config, config.buildings.orbital_foundry),
    tapRecipes: config.tapRecipes,
    orbital: { ...config.orbital, data: undefined }, // (data packets travel in the view, and only what the player has unlocked)
    logistics: config.logistics,
    expansion: config.expansion,
    popConsumption: config.global.populationConsumptionPerTick,
    minPopulation: config.global.minPopulation,
    exodus: config.global.exodus,
    growth: config.global.populationGrowth,
    buildableIn: Object.fromEntries(['core', ...Object.keys(config.districtTypes || {}), ...Object.keys(config.orbitalTypes || {})].map((t) => [t, Object.keys(config.buildings).filter((k) => sim.buildableIn(config.buildings[k], t))])),
    recipes: config.recipes,
    tradeWorks: config.tradeWorks,
    missions: { slots: config.missions.slots, factions: config.missions.factions },
    hazardShield: config.hazards.shield || {},
    exchange: { unlockCoreLevel: config.exchange.unlockCoreLevel, feeRate: config.exchange.feeRate, ttlOptions: config.exchange.ttlOptions, maxOpenOrders: config.exchange.maxOpenOrders, maxQty: config.exchange.maxQty, levels: config.exchange.levels },
    districtProgression: config.districtProgression,
    convoyIntervalTicks: config.global.convoyIntervalTicks,
    demolishRefund: config.global.demolishRefund,
    production: config.production,
    requisitions: config.requisitions ? { unlockHubLevel: config.requisitions.unlockHubLevel, boons: config.requisitions.boons } : null,
    buildQueue: { max: queue.max, replaceTimeMult: queue.replaceTimeMult },
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

// The exchange as the player sees it: reference prices and history, the book per resource, their own orders and trades.
function exchangeView(c, tick) {
  const X = config.exchange;
  const open = db.prepare("SELECT owner, colony_id AS colony, side, resource_id AS res, price, qty FROM market_orders WHERE owner = 'player' AND status = 'open' AND qty > 0").all()
    .concat(market.projectedNpc(tick).filter((o) => o.qty > 0));
  const out = { unlocked: c.hub_level >= X.unlockCoreLevel, resources: {}, orders: [], trades: [], activity: false };
  const by = {};
  for (const o of open) (by[o.res] = by[o.res] || []).push(o);
  const agg = (list, desc) => {
    const m = new Map();
    for (const o of list) { const e = m.get(o.price) || { price: o.price, qty: 0, mine: 0 }; e.qty += o.qty; if (o.colony === c.id) e.mine += o.qty; m.set(o.price, e); }
    return [...m.values()].sort((a, b) => (desc ? b.price - a.price : a.price - b.price)).slice(0, X.levels);
  };
  for (const res of Object.keys(config.resources)) {
    const list = by[res] || [];
    const bids = agg(list.filter((o) => o.side === 'buy'), true);
    const asks = agg(list.filter((o) => o.side === 'sell'), false);
    const hist = ms.history(config, res, tick);
    out.resources[res] = {
      ref: Math.round(ms.refPrice(config, res, tick) * 100) / 100, hist, trend: hist[hist.length - 1] / hist[Math.max(0, hist.length - 9)] - 1,
      event: ms.event(config, res, tick), bids, asks, bid: bids.length ? bids[0].price : null, ask: asks.length ? asks[0].price : null,
    };
  }
  out.orders = db.prepare("SELECT id, side, resource_id AS resource, price, qty, qty_total AS total, escrow, district_id AS district, created_tick AS created, expires_tick AS expires FROM market_orders WHERE colony_id = ? AND owner = 'player' AND status = 'open' ORDER BY id DESC").all(c.id);
  out.trades = db.prepare('SELECT id, tick, resource_id AS resource, price, qty, buy_colony AS buyer, sell_colony AS seller FROM market_trades WHERE buy_colony = ? OR sell_colony = ? ORDER BY id DESC LIMIT 20').all(c.id, c.id)
    .map((t) => ({ id: t.id, tick: t.tick, resource: t.resource, price: t.price, qty: t.qty, side: t.buyer === c.id ? 'buy' : 'sell' }));
  out.activity = out.orders.length > 0 || out.trades.length > 0 || !!db.prepare("SELECT 1 FROM market_orders WHERE colony_id = ? AND owner = 'player' LIMIT 1").get(c.id);
  return out;
}

function viewFor(userId, now = Date.now()) {
  const c = db.prepare('SELECT * FROM colonies WHERE user_id = ?').get(userId);
  if (!c) return null;
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
  const t = engine.timing();
  if (orbital.checkUnlock(c, t.globalTick)) Object.assign(c, db.prepare('SELECT * FROM colonies WHERE id = ?').get(c.id));
  const lvl = config.hubLevels[c.hub_level];
  const districts = store.loadDistricts(c.id).map((d) => ({
    id: d.id, type: d.type, name: d.name,
    level: d.type === 'core' ? c.hub_level : d.level,
    linkLevel: d.linkLevel, inventory: store.loadInventory(c.id, d.id), buildings: store.loadBuildings(c.id, d.id),
    ...orbital.districtExtras(c, d),
  }));
  const routeRows = store.loadRoutes(c.id);
  const shipmentRows = store.loadShipments(c.id);
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
    { neighborMaps: engine.neighborMaps, mods: { [coreD.id]: mods }, popConsumptionMult: mods.popConsumptionMult, routes: routeRows, globalOut: projects.globalOut() },
  );
  const proj = sim.coreView(full);

  // Standing routes act on the next tick's stock, so the rates every district shows already include them.
  const routeBags = new Map(full.districts.map((r, i) => [r.id, { inv: { ...(r.id === coreD.id ? proj.inventory : r.inventory) }, cap: r.id === coreD.id ? proj.cap : r.cap }]));
  const routeFlows = sim.applyRoutes(config, routeRows, routeBags);
  const flowIn = {}; const flowOut = {};
  for (const f of routeFlows) {
    if (f.qty <= 0) continue;
    ((flowIn[f.route.toDistrict] = flowIn[f.route.toDistrict] || {})[f.route.resource] = ((flowIn[f.route.toDistrict] || {})[f.route.resource] || 0) + f.qty);
    ((flowOut[f.route.fromDistrict] = flowOut[f.route.fromDistrict] || {})[f.route.resource] = ((flowOut[f.route.fromDistrict] || {})[f.route.resource] || 0) + f.qty);
  }

  // A view of one district: stock with rates, grid, hub, buildings and orders.
  const allOrders = store.loadOrders(c.id);
  const xmax = sim.expansionMax(config, orbital.flagsOf(c));
  const districtView = (d, r) => {
    const isCore = d.type === 'core';
    const flows = isCore ? proj.flows : r.flows;
    const cap = isCore ? proj.cap : r.cap;
    const resources = {};
    for (const res of Object.keys(config.resources)) {
      const f = flows[res];
      const rin = ((flowIn[d.id] || {})[res]) || 0; const rout = ((flowOut[d.id] || {})[res]) || 0;
      const net = f.produced - f.consumed + rin - rout;
      const amount = d.inventory[res] || 0;
      resources[res] = { amount, cap, produced: f.produced, consumed: f.consumed, routeIn: rin, routeOut: rout, net, ticksLeft: net < -1e-6 ? amount / -net : null };
    }
    const lvl = sim.levelDef(config, d.type, d.level);
    const dOrders = allOrders.filter((o) => o.district_id === d.id || (isCore && !o.district_id));
    const bs = isCore ? proj.buildings : r.buildings;
    const hub = isCore ? proj.hub : r.hub;
    return {
      id: d.id, type: d.type, name: d.name, level: d.level, core: isCore, orbital: !!(config.orbitalTypes || {})[d.type],
      territory: d.territory || null,
      locks: store.loadSlotLocks(d.id, t.globalTick).map((l) => ({ ring: l.ring, slot: l.slot, ticksLeft: l.untilTick - t.globalTick })),
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
          boost: b.boost ? (st.boost || 'starved') : null,
          level: b.level || 1, xscale: st.xscale || 1,
          xnext: config.buildings[b.type].expand && (b.level || 1) < xmax ? { level: (b.level || 1) + 1, cost: sim.expansionCost(config, config.buildings[b.type], (b.level || 1) + 1), ticks: config.expansion.ticks[(b.level || 1) + 1], scale: config.expansion.scale[(b.level || 1) + 1], crew: config.expansion.crew[(b.level || 1) + 1] } : null,
          dataProgress: b.type === 't_data' ? Math.round((b.dataProgress || 0) * 10) / 10 : undefined, recipe: b.recipe || null, resetting: b.resetting ? Math.max(0, b.readyTick - t.globalTick) : 0, batch: st.batch || 1,
          resetFee: b.recipe && config.buildings[b.type].recipeBuilding ? sim.recipeResetFee(config, b.recipe, b.ring, d.type, config.buildings[b.type]) : 0, comfort: st.comfort === undefined ? null : st.comfort, mark: isCore ? hazardMark(hazard, b, st, d.buildings) : null };
      }),
      // Orders in the order they run. `state` is 'active' (being carried out) or 'queued'; `pos` counts the queue from 1.
      // The order at the front of an idle queue says what it is `waiting` for: stock the place is short of, or a reason.
      orders: (() => {
        const busy = dOrders.some((o) => o.state !== 'queued');
        let pos = 0;
        return dOrders.map((o) => {
          const queued = o.state === 'queued';
          const cost = queue.costOf(d, o);
          const out = { id: o.id, kind: o.action_type, data: o.data, state: queued ? 'queued' : 'active', remaining: o.ticks_remaining, total: o.ticks_total, cost,
            rush: !queued && o.ticks_remaining > 1 ? credits.rushCost(c.id, o.action_type, o.ticks_remaining, t.globalTick) : 0 };
          if (queued) {
            out.pos = ++pos;
            if (!busy && pos === 1) {
              const held = queue.check(c, d, d.level, o, t.globalTick);
              out.waiting = { short: queue.shortfall(d.inventory, cost, queue.refundOf(d, o)) || {}, why: held ? (held.wait || held.drop) : null };
            }
          }
          return out;
        });
      })(),
      queueMax: queue.max,
    };
  };
  const views = {};
  districts.forEach((d, i) => { views[d.id] = districtView(d, full.districts[i]); });
  const coreV = views[coreD.id];
  const resources = coreV.resources;
  // Where the population is heading and why: the answer to "why is nobody moving in" and "why are they leaving".
  const gcfg = config.global;
  const per = gcfg.populationConsumptionPerTick;
  const pmult = mods.popConsumptionMult || 1;
  const housingCap = proj.housing.cap;
  const roomFor = (r) => ({ net: resources[r].net, stock: resources[r].amount, cap: resources[r].cap });
  const feedable = Object.keys(per).every((r) => sim.canFeed(config, roomFor(r), per[r] * pmult));
  const onBuffer = feedable && !Object.keys(per).every((r) => resources[r].net > per[r] * pmult); // growing on the stockpile, not on surplus
  const outlook = proj.left ? { state: 'shrinking', why: proj.leftWhy }
    : proj.grew ? { state: 'growing', why: onBuffer ? 'buffer' : null }
      : c.population >= housingCap ? { state: 'steady', why: 'housing' }
        : c.morale < gcfg.populationGrowth.minMorale ? { state: 'steady', why: 'morale' }
          : !feedable ? { state: 'steady', why: 'food' }
            : { state: 'growing', why: onBuffer ? 'buffer' : null };
  const people = {
    perPerson: per, multiplier: pmult, mealsPerPerson: gcfg.mealsPerPopPerTick,
    use: Object.fromEntries(Object.keys(per).map((r) => [r, per[r] * c.population * pmult])),
    meals: gcfg.mealsPerPopPerTick * c.population, minPopulation: gcfg.minPopulation, housingCap, outlook, shortage: proj.shortage || 0,
    // how many more people the current surplus could feed
    headroom: Object.fromEntries(Object.keys(per).map((r) => [r, Math.floor(Math.max(0, resources[r].net) / (per[r] * pmult))])),
  };

  const ticksToConvoy = config.global.convoyIntervalTicks - (t.globalTick % config.global.convoyIntervalTicks);
  const nextTickAt = t.lastTickAt + t.tickMs;

  const view = {
    user: user.username,
    tick: t.globalTick, tickMs: t.tickMs, nextTickAt, serverNow: now,
    districtsUnlocked: sim.districtsUnlocked(config, { coreLevel: c.hub_level }),
    districtLevelCap: sim.districtLevelCap(config, { coreLevel: c.hub_level, beaconBuilt: store.hasBeacon(c.id) }),
    districtNeeds: Object.fromEntries([2, 3, 4, 5].map((l) => [l, sim.districtLevelNeeds(config, l)])),
    districts: districts.map((d) => ({ id: d.id, type: d.type, name: d.name, level: d.level, core: d.type === 'core', buildings: d.buildings.length,
      orbital: !!(config.orbitalTypes || {})[d.type],
      link: d.type === 'core' || (config.orbitalTypes || {})[d.type] ? null : {
        level: d.linkLevel, capacity: config.logistics.link.levels[d.linkLevel].capacity,
        load: routeRows.filter((r) => r.fromDistrict === d.id || r.toDistrict === d.id).reduce((n, r) => n + r.rate, 0),
        next: config.logistics.link.levels[d.linkLevel + 1] || null,
      } })),
    foundable: Object.fromEntries(Object.keys(config.districtTypes || {}).map((k) => [k, sim.districtFoundable(config, k, { coreLevel: c.hub_level, beaconBuilt: store.hasBeacon(c.id) })])),
    freeport: districts.some((d) => d.type === 'freeport'),
    // what the colony has done, for alternative recipes that open at a milestone
    milestones: { beacon: store.hasBeacon(c.id), freeport: districts.some((d) => d.type === 'freeport'), station: districts.some((d) => d.type === 'station') },
    founding: allOrders.filter((o) => o.action_type === 'found').map((o) => ({ id: o.id, type: o.data.type, remaining: o.ticks_remaining, total: o.ticks_total, queued: o.state === 'queued' })),
    convoy: { ticksLeft: ticksToConvoy, arrivesAt: nextTickAt + (ticksToConvoy - 1) * t.tickMs },
    colony: {
      status: c.status, won: !!c.won, progress: proj.progress, hazardsSurvived: c.hazards_survived,
      restartCredits: Math.max(config.global.startingState.credits, Math.floor(c.credits * config.global.failureCreditKeep)),
      hubLevel: c.hub_level, credits: c.credits, population: c.population,
      maxPopulation: proj.housing.cap, housing: proj.housing, staffing: proj.staffing, moraleInfo: proj.moraleInfo,
      morale: c.morale, failures: c.failures, shutdowns: c.shutdowns,
      shutdown: c.shutdown_tick === null || c.shutdown_tick === undefined ? null : { since: c.shutdown_tick, ticks: t.globalTick - c.shutdown_tick, parked: shutdown.parkedCount(c.id) },
      parked: shutdown.parkedCount(c.id),
      starving: proj.starving,
      expandMax: xmax,
    },
    hub: coreV.hub,
    defense: proj.defense,
    energy: proj.energy,
    resources,
    buildings: coreV.buildings,
    orders: coreV.orders,
    views,
    people,
    routes: routeFlows.map((f) => ({ ...f.route, flow: f.qty, limit: f.limit })),
    shipments: shipmentRows.map((sh) => ({ ...sh, ticksLeft: Math.max(0, sh.arrivesTick - t.globalTick) })),
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
  const cmult = requisitions.convoyMult(c, t.globalTick);
  for (const res of Object.keys(config.resources)) limits[res] = Math.floor(sim.convoyLimit(config, c.hub_level, res) * cmult);
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
      shield: !view.freeport || hazard.state !== 'forecast' || !hazards.shieldNeed(config, hazard.type, c.hub_level) ? null
        : { ...hazards.shieldNeed(config, hazard.type, c.hub_level), have: Math.floor(inventory[hazards.shieldNeed(config, hazard.type, c.hub_level).resource] || 0), enabled: !!(hazard.data && hazard.data.shield) },
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
  view.exchange = exchangeView(c, t.globalTick);
  view.missions = missions.view(c, t.globalTick);
  view.requisitions = requisitions.view(c, t.globalTick);
  view.data = territories.dataView(c);
  view.economy = credits.view(c.id, c.hub_level, t.globalTick);
  view.orbital = orbital.view(c, t.globalTick, { flows: Object.fromEntries(routeFlows.map((f) => [f.route.id, f.qty])) });
  if (view.orbital.station) {
    view.orbital.ships = territories.view(c, t.globalTick);
    view.orbital.market = orbitalMarket.view(c, t.globalTick);
    view.orbital.project = projects.view(c, t.globalTick);
  }
  view.report = db.prepare("SELECT id, tick, kind, message FROM colony_events WHERE colony_id = ? AND tag = 'hazard' AND id > ? ORDER BY id").all(c.id, c.report_cursor);

  // Directives are sticky: newly earned milestones are saved as the view is
  // built (idempotent progress tracking, only writes when something changed).
  const known = JSON.parse(c.milestones);
  const brief = objectives.evaluate(config, view, known);
  if (brief.doneIds.length !== known.length) {
    db.prepare('UPDATE colonies SET milestones = ? WHERE id = ?').run(JSON.stringify(brief.doneIds), c.id);
  }
  view.brief = { directives: brief.list, remaining: brief.remaining };
  story.evaluate(c.id, view, brief.list.filter((d) => d.done).map((d) => d.id), brief.remainingMain === 0, t.globalTick);
  view.story = story.view(c.id);
  view.doom = view.colony.shutdown ? { phase: 'shutdown', ticks: 0 } : brief.doom;
  return view;
}

module.exports = { clientConfig, viewFor };
