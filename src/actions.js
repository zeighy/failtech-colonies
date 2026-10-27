'use strict';
const sim = require('./sim');
const market = require('./market');
const story = require('./story');
const shutdown = require('./shutdown');
const missions = require('./missions');
const { own, isPlain, toInt, toNum, body } = require('./validate');
const store = require('./db');
const { db, config } = store;

const fail = (error) => ({ ok: false, error });
const OK = { ok: true };

function colonyOf(userId) {
  return db.prepare('SELECT * FROM colonies WHERE user_id = ?').get(userId);
}
const NaNish = (...v) => v.some((x) => Number.isNaN(x));

function canAfford(inv, cost) {
  return Object.entries(cost).every(([r, a]) => (inv[r] || 0) >= a);
}

// Which district is an action about? The Core unless one is named; a named one must belong to this colony.
// The Core's level lives on the colony (colonies.hub_level); other districts carry their own.
function districtFor(c, id) {
  const n = id === undefined || id === null ? null : toInt(id);
  const d = n === null
    ? db.prepare("SELECT * FROM districts WHERE colony_id = ? AND type = 'core'").get(c.id)
    : Number.isNaN(n) ? null : db.prepare('SELECT * FROM districts WHERE id = ? AND colony_id = ?').get(n, c.id);
  return d ? { ...d, level: d.type === 'core' ? c.hub_level : d.level } : null;
}
const NO_DISTRICT = 'Unknown district.';

function pay(districtId, cost) {
  const up = db.prepare('UPDATE colony_inventory SET amount = amount - ? WHERE district_id = ? AND resource_id = ?');
  for (const [r, a] of Object.entries(cost)) up.run(a, districtId, r);
}

// Refunds add straight to stock; the next tick trims anything above the storage cap.
function refund(districtId, cost, fraction) {
  const up = db.prepare('UPDATE colony_inventory SET amount = amount + ? WHERE district_id = ? AND resource_id = ?');
  for (const [r, a] of Object.entries(cost)) up.run(Math.floor(a * fraction), districtId, r);
}

// Wraps an action: loads the colony, rejects failed colonies, runs inside a transaction.
function guarded(fn, { allowFailed = false } = {}) {
  // The colony is read inside the transaction, and the transaction takes the write lock up front (BEGIN IMMEDIATE),
  // so two requests (or two processes) can never both act on the same stale balance.
  const run = db.transaction((userId, args) => {
    const c = colonyOf(userId);
    if (!c) return fail('No colony found.');
    if (c.status !== 'active' && !allowFailed) return fail('This colony has been abandoned.');
    return fn(c, args);
  });
  return (userId, args) => run.immediate(userId, body(args));
}

const slotBusy = (c, d, ring, slot) => {
  if (db.prepare('SELECT 1 FROM colony_buildings WHERE district_id = ? AND ring_index = ? AND slot_index = ?').get(d.id, ring, slot)) return true;
  return store.loadOrders(c.id, d.id).some((o) => o.action_type === 'build' && o.data.ring === ring && o.data.slot === slot);
};

const build = guarded((c, { ring, slot, type, district }) => {
  const d = districtFor(c, district);
  if (!d) return fail(NO_DISTRICT);
  ring = toInt(ring); slot = toInt(slot);
  const def = own(config.buildings, type);
  if (!def) return fail('Unknown building type.');
  if (NaNish(ring, slot)) return fail('Bad slot.');
  if (!sim.buildableIn(def, d.type)) return fail(`${def.name} can't be built ${d.type === 'core' ? 'in the Core' : `in ${d.name}`}.`);
  if (!sim.slotUnlocked(config, d.level, ring, slot, d.type)) return fail(`That slot is locked. Upgrade the ${d.type === 'core' ? 'hub' : 'district'}.`);
  if (def.minHubLevel && c.hub_level < def.minHubLevel) return fail(`${def.name} requires hub level ${def.minHubLevel}.`);
  if (slotBusy(c, d, ring, slot)) return fail('That slot is already in use.');
  if (def.maxCount) {
    // limits such as "only one Beacon" count the whole colony, not one district
    const have = store.loadDistricts(c.id).reduce((n, x) => n + store.loadBuildings(c.id, x.id).filter((b) => b.type === type).length, 0)
      + store.loadOrders(c.id).filter((o) => o.action_type === 'build' && o.data.type === type).length;
    if (have >= def.maxCount) return fail(`Only ${def.maxCount} ${def.name} can be built.`);
  }
  if (!canAfford(store.loadInventory(c.id, d.id), def.cost)) return fail(`Not enough resources for ${def.name}.`);
  pay(d.id, def.cost);
  db.prepare('INSERT INTO colony_work_orders (colony_id, district_id, action_type, target_data, ticks_remaining, ticks_total) VALUES (?, ?, ?, ?, ?, ?)')
    .run(c.id, d.id, 'build', JSON.stringify({ ring, slot, type }), def.constructionTicks, def.constructionTicks);
  return OK;
});

const buildingAt = (d, ring, slot) => {
  const r = toInt(ring); const sl = toInt(slot);
  if (Number.isNaN(r) || Number.isNaN(sl)) return undefined;
  return db.prepare('SELECT * FROM colony_buildings WHERE district_id = ? AND ring_index = ? AND slot_index = ?').get(d.id, r, sl);
};

const demolish = guarded((c, { ring, slot, district }) => {
  const d = districtFor(c, district);
  if (!d) return fail(NO_DISTRICT);
  const b = buildingAt(d, ring, slot);
  if (!b) return fail('Nothing to demolish there.');
  // Scrapping a configured workshop costs what changing its recipe would, or demolishing and rebuilding would be a free reset.
  if (config.buildings[b.building_type].recipeBuilding && b.recipe) {
    const fee = sim.recipeResetFee(config, b.recipe, b.ring_index, d.type);
    if (c.credits < fee) return fail(`Scrapping a configured workshop costs ${fee} cr.`);
    db.prepare('UPDATE colonies SET credits = credits - ? WHERE id = ?').run(fee, c.id);
  }
  // an expansion still under way is called off and refunded in full
  for (const o of store.loadOrders(c.id, d.id)) {
    if (o.action_type === 'expand' && o.data.ring === b.ring_index && o.data.slot === b.slot_index) {
      refund(d.id, sim.expansionCost(config, config.buildings[o.data.type], o.data.level), 1);
      db.prepare('DELETE FROM colony_work_orders WHERE id = ?').run(o.id);
    }
  }
  db.prepare('DELETE FROM colony_buildings WHERE id = ?').run(b.id);
  refund(d.id, config.buildings[b.building_type].cost, config.global.demolishRefund);
  return OK;
});

const toggle = guarded((c, { ring, slot, paused, district }) => {
  const d = districtFor(c, district);
  if (!d) return fail(NO_DISTRICT);
  const b = buildingAt(d, ring, slot);
  if (!b) return fail('Nothing there.');
  // Clients send the state they want (so a re-sent request after a dropped connection can't flip it back);
  // with no explicit state the building simply flips.
  const next = typeof paused === 'boolean' ? (paused ? 'paused' : 'active') : (b.status === 'active' ? 'paused' : 'active');
  db.prepare('UPDATE colony_buildings SET status = ?, parked = 0 WHERE id = ?').run(next, b.id);
  return OK;
});

// Expand a building "upward": it stays in its plot but its whole line scales up. Paid from the district's own stockpile
// (so the materials have to be routed or shipped in), takes a few ticks as a work order, and the cost grows linearly with the level.
const expand = guarded((c, { ring, slot, district }) => {
  const d = districtFor(c, district);
  if (!d) return fail(NO_DISTRICT);
  const b = buildingAt(d, ring, slot);
  if (!b) return fail('Nothing there.');
  const def = config.buildings[b.building_type];
  if (!def.expand) return fail(`${def.name} cannot be expanded.`);
  const level = b.level || 1;
  if (level >= config.expansion.maxLevel) return fail(`${def.name} is fully expanded.`);
  if (store.loadOrders(c.id, d.id).some((o) => o.action_type === 'expand' && o.data.ring === b.ring_index && o.data.slot === b.slot_index)) return fail('An expansion is already underway there.');
  const next = level + 1;
  const cost = sim.expansionCost(config, def, next);
  if (!canAfford(store.loadInventory(c.id, d.id), cost)) return fail(`Not enough materials in ${d.name} to expand ${def.name}.`);
  pay(d.id, cost);
  const ticks = config.expansion.ticks[next];
  db.prepare('INSERT INTO colony_work_orders (colony_id, district_id, action_type, target_data, ticks_remaining, ticks_total) VALUES (?, ?, ?, ?, ?, ?)')
    .run(c.id, d.id, 'expand', JSON.stringify({ ring: b.ring_index, slot: b.slot_index, type: b.building_type, level: next }), ticks, ticks);
  return OK;
});

// Switch a building's optional input on or off (off by default). Clients send the state they want.
const setBoost = guarded((c, { ring, slot, enabled, district }) => {
  const d = districtFor(c, district);
  if (!d) return fail(NO_DISTRICT);
  const b = buildingAt(d, ring, slot);
  if (!b) return fail('Nothing there.');
  if (!config.buildings[b.building_type].optional) return fail('This building has no optional input.');
  db.prepare('UPDATE colony_buildings SET boost = ? WHERE id = ?').run(enabled ? 1 : 0, b.id);
  return OK;
});

const cancelOrder = guarded((c, { orderId }) => {
  const oid = toInt(orderId);
  const o = Number.isNaN(oid) ? undefined : store.loadOrders(c.id).find((x) => x.id === oid);
  if (!o) return fail('That order no longer exists.');
  const d = districtFor(c, o.district_id);
  const cost = o.action_type === 'build' ? config.buildings[o.data.type].cost
    : o.action_type === 'found' ? config.districtTypes[o.data.type].foundCost
      : o.action_type === 'expand' ? sim.expansionCost(config, config.buildings[o.data.type], o.data.level)
        : sim.levelDef(config, d.type, o.data.level).upgradeCost;
  refund(d.id, cost, 1);
  db.prepare('DELETE FROM colony_work_orders WHERE id = ?').run(o.id);
  return OK;
});

const upgradeHub = guarded((c, { district } = {}) => {
  const d = districtFor(c, district);
  if (!d) return fail(NO_DISTRICT);
  const next = sim.levelDef(config, d.type, d.level + 1);
  if (!next) return fail(`The ${d.type === 'core' ? 'hub' : 'district'} is already at maximum level.`);
  if (d.type !== 'core') {
    // Districts level up as the Core advances (see config.districtProgression).
    const cap = sim.districtLevelCap(config, { coreLevel: c.hub_level, beaconBuilt: store.hasBeacon(c.id) });
    if (d.level + 1 > cap) return fail(`District level ${d.level + 1} unlocks when ${sim.districtLevelNeeds(config, d.level + 1)}.`);
  }
  if (store.loadOrders(c.id, d.id).some((o) => o.action_type === 'upgrade')) return fail('An upgrade is already underway.');
  if (!canAfford(store.loadInventory(c.id, d.id), next.upgradeCost)) return fail('Not enough resources for the upgrade.');
  pay(d.id, next.upgradeCost);
  db.prepare('INSERT INTO colony_work_orders (colony_id, district_id, action_type, target_data, ticks_remaining, ticks_total) VALUES (?, ?, ?, ?, ?, ?)')
    .run(c.id, d.id, 'upgrade', JSON.stringify({ level: d.level + 1 }), next.upgradeTicks, next.upgradeTicks);
  return OK;
});

// Found a satellite district: paid from the Core stockpile, built over a few ticks by a work order.
const foundDistrict = guarded((c, { type }) => {
  const t = own(config.districtTypes, type);
  if (!t) return fail('Unknown district type.');
  if (!sim.districtsUnlocked(config, { coreLevel: c.hub_level })) {
    return fail(`Districts open at hub level ${config.districtProgression.unlockCoreLevel}.`);
  }
  if (!sim.districtFoundable(config, type, { coreLevel: c.hub_level, beaconBuilt: store.hasBeacon(c.id) })) return fail(`${t.name} opens once the Beacon is built.`);
  if (store.loadDistricts(c.id).some((d) => d.type === type)
    || store.loadOrders(c.id).some((o) => o.action_type === 'found' && o.data.type === type)) return fail(`${t.name} is already founded.`);
  const core = store.coreId(c.id);
  if (!canAfford(store.loadInventory(c.id, core), t.foundCost)) return fail(`Not enough resources to found ${t.name}.`);
  pay(core, t.foundCost);
  db.prepare('INSERT INTO colony_work_orders (colony_id, district_id, action_type, target_data, ticks_remaining, ticks_total) VALUES (?, ?, ?, ?, ?, ?)')
    .run(c.id, core, 'found', JSON.stringify({ type }), t.foundTicks, t.foundTicks);
  return OK;
});

// Manual shipment: stock leaves the source now and lands in the destination after the trip.
const shipment = guarded((c, { from, to, resource, qty }) => {
  const a = districtFor(c, from); const b = districtFor(c, to);
  if (!a || !b) return fail(NO_DISTRICT);
  if (a.id === b.id) return fail('Pick two different districts.');
  if (!own(config.resources, resource)) return fail('Unknown resource.');
  qty = Math.floor(toNum(qty));
  const L = config.logistics;
  if (!Number.isFinite(qty) || qty < 1) return fail('Bad quantity.');
  if (qty > L.shipmentMax) return fail(`A shipment carries at most ${L.shipmentMax}.`);
  if (store.loadShipments(c.id).filter((x) => !x.routeId).length >= L.maxInFlight) return fail(`Only ${L.maxInFlight} shipments can be on the road at once.`);
  if ((store.loadInventory(c.id, a.id)[resource] || 0) < qty) return fail(`Not enough ${config.resources[resource].name} in ${a.name}.`);
  const tick = Number(store.getMeta('global_tick', 0));
  const trip = sim.shipDistance(config, a.type, b.type);
  pay(a.id, { [resource]: qty });
  db.prepare('INSERT INTO colony_shipments (colony_id, from_district, to_district, resource_id, qty, dispatched_tick, arrives_tick) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(c.id, a.id, b.id, resource, qty, tick, tick + trip);
  return OK;
});

// ---- the Free Port: recipes, shields and missions ------------------------------------------
// The first recipe is free. Changing it costs credits (so many ticks of the old output at market value) and idles the
// workshop for a while.
const setRecipe = guarded((c, { ring, slot, recipe, district }) => {
  const d = districtFor(c, district);
  if (!d) return fail(NO_DISTRICT);
  const b = buildingAt(d, ring, slot);
  if (!b) return fail('Nothing there.');
  if (!config.buildings[b.building_type].recipeBuilding) return fail('This building does not take recipes.');
  if (!own(config.recipes, recipe)) return fail('Unknown recipe.');
  if (b.recipe === recipe) return OK;
  const tick = Number(store.getMeta('global_tick', 0));
  if (!b.recipe) {
    db.prepare('UPDATE colony_buildings SET recipe = ?, recipe_ready_tick = ? WHERE id = ?').run(recipe, tick, b.id);
    return OK;
  }
  if (b.recipe_ready_tick > tick) return fail('The workshop is still resetting.');
  const fee = sim.recipeResetFee(config, b.recipe, b.ring_index, d.type);
  if (c.credits < fee) return fail(`Changing the recipe costs ${fee} cr.`);
  db.prepare('UPDATE colonies SET credits = credits - ? WHERE id = ?').run(fee, c.id);
  db.prepare('UPDATE colony_buildings SET recipe = ?, recipe_ready_tick = ? WHERE id = ?').run(recipe, tick + config.tradeWorks.reset.delayTicks, b.id);
  return OK;
});

// Deploy (or stand down) the trade-good shield against the forecast hazard.
const shieldHazard = guarded((c, { enabled }) => {
  if (!missions.hasFreePort(c.id)) return fail('You have no trade goods to deploy yet.');
  const h = store.loadHazard(c.id);
  if (!h || h.state !== 'forecast') return fail('No hazard is on its way.');
  if (!(config.hazards.shield || {})[h.type]) return fail('Nothing can shield against this.');
  const data = { ...h.data, shield: !!enabled };
  db.prepare('UPDATE colony_hazards SET data = ? WHERE id = ?').run(JSON.stringify(data), h.id);
  return OK;
});

const missionFill = guarded((c, { id, faction, district }) => {
  const d = districtFor(c, district);
  if (!d) return fail(NO_DISTRICT);
  return missions.fill(c, { id: toInt(id), faction, district: d }, Number(store.getMeta('global_tick', 0)));
});

// ---- the exchange -------------------------------------------------------------------------
const marketPost = guarded((c, args) => {
  const d = districtFor(c, args.district);
  if (!d) return fail(NO_DISTRICT);
  const r = market.post(c, d, args, Number(store.getMeta('global_tick', 0)));
  return r.ok ? { ok: true, id: r.id, filled: r.filled } : r;
});
const marketCancel = guarded((c, { orderId }) => market.cancel(c, toInt(orderId), Number(store.getMeta('global_tick', 0))));

// ---- standing routes ------------------------------------------------------------
// A route moves up to `rate` units per tick from one district to another, never taking the source below
// `reserve`. Every satellite has a link to the Core with a capacity; a route counts against the link of each
// satellite it touches (a route to or from the Core touches one).
const linkCapacity = (config_, d) => config_.logistics.link.levels[d.link_level || d.linkLevel || 1].capacity; // d is a districts row
function linkLoad(c, districtId, ignoreRouteId) {
  return store.loadRoutes(c.id)
    .filter((r) => r.id !== ignoreRouteId && (r.fromDistrict === districtId || r.toDistrict === districtId))
    .reduce((n, r) => n + r.rate, 0);
}
const setRoute = guarded((c, { from, to, resource, rate, reserve }) => {
  const a = districtFor(c, from); const b = districtFor(c, to);
  if (!a || !b) return fail(NO_DISTRICT);
  if (a.id === b.id) return fail('Pick two different districts.');
  if (!own(config.resources, resource)) return fail('Unknown resource.');
  rate = Math.floor(toNum(rate)); reserve = reserve === undefined ? 0 : Math.floor(toNum(reserve));
  if (!Number.isFinite(rate) || rate < 0 || rate > 1e6) return fail('Bad rate.');
  if (!Number.isFinite(reserve) || reserve < 0 || reserve > 1e9) return fail('Bad reserve.');
  const existing = store.loadRoutes(c.id).find((r) => r.fromDistrict === a.id && r.toDistrict === b.id && r.resource === resource);
  if (rate === 0) {
    if (existing) db.prepare('DELETE FROM colony_routes WHERE id = ?').run(existing.id);
    return OK;
  }
  if (!sim.districtsUnlocked(config, { coreLevel: c.hub_level })) return fail('Districts are not open yet.');
  if (!existing && store.loadRoutes(c.id).length >= config.logistics.maxRoutes) return fail(`At most ${config.logistics.maxRoutes} routes.`);
  for (const d of [a, b]) {
    if (d.type === 'core') continue;
    const cap = linkCapacity(config, d);
    const load = linkLoad(c, d.id, existing && existing.id);
    if (load + rate > cap) return fail(`The link to ${d.name} carries ${cap} per tick and ${load} is already committed. Upgrade the link or lower the rate.`);
  }
  db.prepare(`INSERT INTO colony_routes (colony_id, from_district, to_district, resource_id, rate, reserve) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(from_district, to_district, resource_id) DO UPDATE SET rate = excluded.rate, reserve = excluded.reserve`)
    .run(c.id, a.id, b.id, resource, rate, reserve);
  return OK;
});

// Raise a district's link capacity. Paid from the Core stockpile, effective at once.
const upgradeLink = guarded((c, { district }) => {
  const d = districtFor(c, district);
  if (!d) return fail(NO_DISTRICT);
  if (d.type === 'core') return fail('The Core has no link to upgrade.');
  const next = config.logistics.link.levels[(d.link_level || 1) + 1];
  if (!next) return fail('The link is already at maximum capacity.');
  const core = store.coreId(c.id);
  if (!canAfford(store.loadInventory(c.id, core), next.upgradeCost)) return fail('Not enough resources in the Core for the link upgrade.');
  pay(core, next.upgradeCost);
  db.prepare('UPDATE districts SET link_level = link_level + 1 WHERE id = ?').run(d.id);
  return OK;
});

const setContract = guarded((c, { resource, side, amount }) => {
  if (!own(config.resources, resource)) return fail('Unknown resource.');
  if (config.resources[resource].trade) return fail('The convoy does not carry trade goods. Use the exchange.');
  if (side !== 'export' && side !== 'import') return fail('Bad contract side.');
  amount = Math.floor(toNum(amount));
  if (!Number.isFinite(amount) || amount < 0) return fail('Bad amount.');
  amount = Math.min(amount, sim.convoyLimit(config, c.hub_level, resource));
  if (amount === 0) db.prepare('DELETE FROM colony_contracts WHERE colony_id = ? AND resource_id = ? AND side = ?').run(c.id, resource, side);
  else db.prepare('INSERT INTO colony_contracts (colony_id, resource_id, side, amount) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET amount = excluded.amount').run(c.id, resource, side, amount);
  return OK;
});

// Express convoy: a one-off, player-dispatched trip. Goods and credits are held on dispatch
// (so nothing can be spent twice) and delivered a few ticks later at worse-than-scheduled rates.
const expressTrip = guarded((c, { sell = {}, buy = {} }) => {
  if (!isPlain(sell) || !isPlain(buy)) return fail('Bad express order.');
  if (Object.keys(sell).length > 40 || Object.keys(buy).length > 40) return fail('Bad express order.');
  const x = config.global.express;
  const tick = Number(store.getMeta('global_tick', 0));
  if (store.loadExpress(c.id)) return fail('An express convoy is already on its way.');
  if (tick < c.express_ready_tick) return fail(`The express convoy needs ${c.express_ready_tick - tick} more ticks before it can run again.`);
  const prices = sim.expressPrices(config, sim.marketPrices(config, sim.nextConvoyK(config, tick)));
  const inv = store.loadInventory(c.id);
  const sellOut = {}; const buyOut = {};
  let income = 0; let spend = 0;
  const clean = (o) => Object.entries(o).map(([r, q]) => [r, Math.floor(toNum(q))]).filter(([, q]) => q > 0);
  for (const [res, qty] of clean(sell)) {
    if (!own(config.resources, res)) return fail('Unknown resource.');
    if (config.resources[res].trade) return fail('The convoy does not carry trade goods. Use the exchange.');
    const lim = Math.max(1, Math.floor(sim.convoyLimit(config, c.hub_level, res) * x.limitFraction));
    if (qty > lim) return fail(`Express convoys carry at most ${lim} ${config.resources[res].name}.`);
    if ((inv[res] || 0) < qty) return fail(`Not enough ${config.resources[res].name} in stock to send.`);
    const pay = Math.round(qty * prices[res].sell);
    sellOut[res] = { qty, pay }; income += pay;
  }
  for (const [res, qty] of clean(buy)) {
    if (!own(config.resources, res)) return fail('Unknown resource.');
    if (config.resources[res].trade) return fail('The convoy does not carry trade goods. Use the exchange.');
    const lim = Math.max(1, Math.floor(sim.convoyLimit(config, c.hub_level, res) * x.limitFraction));
    if (qty > lim) return fail(`Express convoys carry at most ${lim} ${config.resources[res].name}.`);
    const cost = Math.round(qty * prices[res].buy);
    buyOut[res] = { qty, cost }; spend += cost;
  }
  if (!Object.keys(sellOut).length && !Object.keys(buyOut).length) return fail('Nothing to send or fetch.');
  const fee = sim.expressFee(config, c.hub_level);
  if (c.credits + 0 < spend + fee) return fail(`Not enough credits: the trip costs ${fee} cr plus ${spend} cr of goods.`);
  // Hold the goods and the money now.
  const up = db.prepare('UPDATE colony_inventory SET amount = amount - ? WHERE district_id = ? AND resource_id = ?');
  const coreDistrict = store.coreId(c.id);
  for (const [res, s] of Object.entries(sellOut)) up.run(s.qty, coreDistrict, res);
  db.prepare('UPDATE colonies SET credits = credits - ? WHERE id = ?').run(spend + fee, c.id);
  db.prepare('INSERT INTO colony_express (colony_id, dispatched_tick, arrives_tick, sell, buy) VALUES (?, ?, ?, ?, ?)')
    .run(c.id, tick, tick + x.travelTicks, JSON.stringify(sellOut), JSON.stringify(buyOut));
  store.addEvent(c.id, tick, 'info', `Express convoy dispatched (fee ${fee} cr). Arrives in ${x.travelTicks} ticks.`);
  return OK;
});

// Switch every building a shutdown parked back on.
const resumeOps = guarded((c) => (shutdown.resume(c.id) ? OK : fail('No buildings are parked.')));

// Acknowledge the "while you were away" report.
const ack = guarded((c) => {
  const row = db.prepare('SELECT MAX(id) AS id FROM colony_events WHERE colony_id = ?').get(c.id);
  db.prepare('UPDATE colonies SET report_cursor = ? WHERE id = ?').run(row.id || 0, c.id);
  return OK;
}, { allowFailed: true });

// Full wipe back to the starting state (manual reset).
const reset = guarded((c) => {
  const old = store.wipeColony(c.id);
  store.foundColony(old.user_id, { failures: old.failures });
  return OK;
}, { allowFailed: true });

// After a collapse: lose everything but keep part of the credits.
const restart = guarded((c) => {
  if (c.status !== 'failed') return fail('The colony is still alive.');
  const old = store.wipeColony(c.id);
  const credits = Math.max(config.global.startingState.credits, Math.floor(old.credits * config.global.failureCreditKeep));
  store.foundColony(old.user_id, { credits, failures: old.failures + 1 });
  return OK;
}, { allowFailed: true });

// Story: the player has played a dialogue or read a mail. Cosmetic: nothing in the simulation depends on it.
const storySeen = guarded((c, { beat, all }) => {
  if (all === true) { story.markSeen(c.id, null, true); return OK; }
  if (typeof beat !== 'string' || !story.beatOf.has(beat)) return fail('Unknown message.');
  return story.markSeen(c.id, beat, false) ? OK : fail('Unknown message.');
}, { allowFailed: true });

module.exports = { resumeOps, storySeen, build, demolish, toggle, setBoost, cancelOrder, upgradeHub, foundDistrict, expand, setRecipe, shieldHazard, missionFill, shipment, marketPost, marketCancel, setRoute, upgradeLink, setContract, expressTrip, reset, restart, ack, colonyOf };
