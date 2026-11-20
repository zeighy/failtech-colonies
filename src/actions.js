'use strict';
const sim = require('./sim');
const market = require('./market');
const story = require('./story');
const shutdown = require('./shutdown');
const orbital = require('./orbital');
const territories = require('./territories');
const projects = require('./projects');
const orbitalMarket = require('./orbitalMarket');
const missions = require('./missions');
const credits = require('./credits');
const queue = require('./queue');
const requisitions = require('./requisitions');
const settlements = require('./settlements');
const minigames = require('./minigames');
const hq = require('./hq');
const absence = require('./absence');
const perks = require('./perks');
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
// Orbital places (the station, territories) only answer to the actions that make sense up there (`orbitalOk`).
function districtFor(c, id, orbitalOk = false) {
  const n = id === undefined || id === null ? null : toInt(id);
  const d = n === null
    ? db.prepare("SELECT * FROM districts WHERE colony_id = ? AND type = 'core'").get(c.id)
    : Number.isNaN(n) ? null : db.prepare('SELECT * FROM districts WHERE id = ? AND colony_id = ?').get(n, c.id);
  if (d && !orbitalOk && (config.orbitalTypes || {})[d.type]) return null;
  return d ? { ...d, level: d.type === 'core' ? c.hub_level : d.level, name: store.nameOfRow(d) } : null;
}
const NO_DISTRICT = 'Unknown district.';
const NEIGHBOURS = {};
const neighbours = (type) => (NEIGHBOURS[type] = NEIGHBOURS[type] || sim.buildNeighborMap(config, type));

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
    if (c.parked_at) return fail('This colony is parked. Retake command first.');
    return fn(c, args);
  });
  return (userId, args) => run.immediate(userId, body(args));
}

// Put an order on a place's queue. If the build slot is free and the place can pay, it starts at once; otherwise it waits
// its turn (see queue.js). `queued: true` tells the client it did not start.
function order(c, d, kind, data) {
  if (queue.count(c, d) >= queue.max) return fail(`The work queue ${d.type === 'core' ? 'in the Core' : `in ${d.name}`} is full (${queue.max} orders). Cancel one, or wait for one to finish.`);
  const tick = tickNow();
  const id = queue.enqueue(c, d, kind, data);
  const started = queue.advance(c, d, c.hub_level, queue.dbBag(c, d), tick, (k, msg) => store.addEvent(c.id, tick, k, msg));
  return started.includes(id) ? OK : { ok: true, queued: true };
}
// Orders already waiting or under way for one plot.
const ordersAt = (c, d, ring, slot) => store.loadOrders(c.id, d.id).filter((o) => o.data.ring === ring && o.data.slot === slot);
const slotBusy = (c, d, ring, slot) => {
  if (db.prepare('SELECT 1 FROM colony_buildings WHERE district_id = ? AND ring_index = ? AND slot_index = ?').get(d.id, ring, slot)) return true;
  return ordersAt(c, d, ring, slot).some((o) => o.action_type === 'build' || o.action_type === 'replace');
};

// Can this kind of building go on this plot of this place? The rules a new building and a replacement share.
function placeable(c, d, def, type, ring, slot) {
  if (def.hidden === 'orbital' && !c.orbital_unlocked && !orbital.checkUnlock(c, tickNow())) return 'Unknown building type.';
  if (!sim.buildableIn(def, d.type)) return `${def.name} can't be built ${d.type === 'core' ? 'in the Core' : `in ${d.name}`}.`;
  if (d.type === 'territory') { const bad = territories.checkBuild(d, def); if (bad) return bad; }
  if (def.strictPlot && sim.plotSize(config, ring, d.type) < def.minPlotSize) return `${def.name} needs a ${config.plotSizes[def.minPlotSize].name} plot.`;
  if (def.requiresAdjacent) {
    const need = config.buildings[def.requiresAdjacent];
    const there = store.loadBuildings(c.id, d.id).filter((x) => x.type === def.requiresAdjacent);
    if (!there.length) return `Build the ${need.name} first, and let it finish.`;
    const nbs = neighbours(d.type).get(sim.key(ring, slot)) || [];
    if (!there.some((x) => nbs.some(([r, sl]) => r === x.ring && sl === x.slot))) return `${def.name} must stand right beside the ${need.name}.`;
  }
  if (!sim.slotUnlocked(config, d.level, ring, slot, d.type)) return `That slot is locked. Upgrade the ${d.type === 'core' ? 'hub' : 'district'}.`;
  if (def.minHubLevel && c.hub_level < def.minHubLevel) return `${def.name} requires hub level ${def.minHubLevel}.`;
  if (def.maxCount) {
    // limits such as "only one Beacon" count the whole colony, not one district, and whatever is queued as well
    const have = store.loadDistricts(c.id).reduce((n, x) => n + store.loadBuildings(c.id, x.id).filter((b) => b.type === type).length, 0)
      + store.loadOrders(c.id).filter((o) => (o.action_type === 'build' || o.action_type === 'replace') && o.data.type === type).length;
    if (have >= def.maxCount) return `Only ${def.maxCount} ${def.name} can be built.`;
  }
  return null;
}

// Build on a free plot. The order joins the place's queue; it is paid for when it starts, so it can be queued before
// the materials are there.
const build = guarded((c, { ring, slot, type, district }) => {
  const d = districtFor(c, district, true);
  if (!d) return fail(NO_DISTRICT);
  ring = toInt(ring); slot = toInt(slot);
  const def = own(config.buildings, type);
  if (!def) return fail('Unknown building type.');
  if (NaNish(ring, slot)) return fail('Bad slot.');
  const bad = placeable(c, d, def, type, ring, slot);
  if (bad) return fail(bad);
  if (slotBusy(c, d, ring, slot)) return fail('That slot is already in use.');
  const lock = db.prepare('SELECT until_tick FROM slot_locks WHERE district_id = ? AND ring_index = ? AND slot_index = ?').get(d.id, ring, slot);
  if (lock && lock.until_tick > tickNow()) return fail(`That slot is still being cleared (${lock.until_tick - tickNow()} ticks).`);
  return order(c, d, 'build', { ring, slot, type });
});

// Replace a building with another on the same plot. It goes through the queue; the old building keeps working until the
// order's turn comes, is then scrapped for the usual refund, and the plot stands empty while the new one is built, which
// takes longer than building on a free plot (config.global.buildQueue.replaceTimeMult).
const replace = guarded((c, { ring, slot, type, district }) => {
  const d = districtFor(c, district, true);
  if (!d) return fail(NO_DISTRICT);
  const b = buildingAt(d, ring, slot);
  if (!b) return fail('Nothing to replace there.');
  const def = own(config.buildings, type);
  if (!def) return fail('Unknown building type.');
  if (b.building_type === type) return fail(`A ${def.name} stands there already.`);
  const old = config.buildings[b.building_type];
  if (old.recipeBuilding && b.recipe) return fail(`${old.name} has a recipe set. Demolish it instead: scrapping a configured workshop has its own cost.`);
  const bad = placeable(c, d, def, type, b.ring_index, b.slot_index);
  if (bad) return fail(bad);
  if (ordersAt(c, d, b.ring_index, b.slot_index).length) return fail('Something is already queued for that building. Cancel it first.');
  return order(c, d, 'replace', { ring: b.ring_index, slot: b.slot_index, type, from: b.building_type });
});

const buildingAt = (d, ring, slot) => {
  const r = toInt(ring); const sl = toInt(slot);
  if (Number.isNaN(r) || Number.isNaN(sl)) return undefined;
  return db.prepare('SELECT * FROM colony_buildings WHERE district_id = ? AND ring_index = ? AND slot_index = ?').get(d.id, r, sl);
};

const demolish = guarded((c, { ring, slot, district }) => {
  const d = districtFor(c, district, true);
  if (!d) return fail(NO_DISTRICT);
  const b = buildingAt(d, ring, slot);
  if (!b) return fail('Nothing to demolish there.');
  // Scrapping a configured workshop costs what changing its recipe would, and the slot stays clear for as long as a recipe
  // change takes to settle, or demolishing and rebuilding would be a quicker, cheaper reset.
  const scrapped = config.buildings[b.building_type].recipeBuilding && b.recipe;
  if (scrapped) {
    const fee = sim.recipeResetFee(config, b.recipe, b.ring_index, d.type, config.buildings[b.building_type]);
    if (c.credits < fee) return fail(`Scrapping a configured workshop costs ${fee} cr.`);
    db.prepare('UPDATE colonies SET credits = credits - ? WHERE id = ?').run(fee, c.id);
  }
  // whatever was queued for the building goes with it; an expansion already under way is refunded in full
  for (const o of ordersAt(c, d, b.ring_index, b.slot_index)) {
    if (o.action_type !== 'expand' && o.action_type !== 'replace') continue;
    if (o.state !== 'queued') refund(d.id, queue.costOf(d, o), 1);
    db.prepare('DELETE FROM colony_work_orders WHERE id = ?').run(o.id);
  }
  db.prepare('DELETE FROM colony_buildings WHERE id = ?').run(b.id);
  if (scrapped) {
    db.prepare('INSERT OR REPLACE INTO slot_locks (district_id, ring_index, slot_index, until_tick) VALUES (?, ?, ?, ?)').run(d.id, b.ring_index, b.slot_index, tickNow() + config.tradeWorks.reset.delayTicks);
  }
  refund(d.id, sim.territoryDef(config.buildings[b.building_type], d.type).cost, config.global.demolishRefund);
  const tick = tickNow();
  queue.advance(c, d, c.hub_level, queue.dbBag(c, d), tick, (k, msg) => store.addEvent(c.id, tick, k, msg)); // the refund may be what the front of the queue was waiting for
  return OK;
});

const toggle = guarded((c, { ring, slot, paused, district }) => {
  const d = districtFor(c, district, true);
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
// (so the materials have to be routed or shipped in) when the order starts, and the cost grows linearly with the level.
const expand = guarded((c, { ring, slot, district }) => {
  const d = districtFor(c, district);
  if (!d) return fail(NO_DISTRICT);
  const b = buildingAt(d, ring, slot);
  if (!b) return fail('Nothing there.');
  const def = config.buildings[b.building_type];
  if (!def.expand) return fail(`${def.name} cannot be expanded.`);
  const level = b.level || 1;
  if (level >= sim.expansionMax(config, orbital.flagsOf(c))) return fail(`${def.name} is fully expanded.`);
  const pending = ordersAt(c, d, b.ring_index, b.slot_index);
  if (pending.some((o) => o.action_type === 'expand')) return fail('An expansion is already underway there.');
  if (pending.some((o) => o.action_type === 'replace')) return fail(`${def.name} is queued to be replaced. Cancel that first.`);
  return order(c, d, 'expand', { ring: b.ring_index, slot: b.slot_index, type: b.building_type, level: level + 1 });
});

// Switch one of a building's optional inputs on or off (off by default). Clients send the state they want, and which
// input (`option`: 'base', the building's own, when left out; housing also has its expansion class's options).
const setBoost = guarded((c, { ring, slot, enabled, district, option }) => {
  const d = districtFor(c, district);
  if (!d) return fail(NO_DISTRICT);
  const b = buildingAt(d, ring, slot);
  if (!b) return fail('Nothing there.');
  const opts = sim.optionsOf(config, config.buildings[b.building_type]);
  if (!opts.length) return fail('This building has no optional input.');
  const o = opts.find((x) => x.key === (option === undefined || option === null ? 'base' : option));
  if (!o) return fail('This building has no such optional input.');
  if (enabled && !sim.optionOpen(o, b.level)) return fail(`${o.label} opens at level ${o.unlock.level}.`);
  const cur = b.boost || 0;
  db.prepare('UPDATE colony_buildings SET boost = ? WHERE id = ?').run(enabled ? cur | o.bit : cur & ~o.bit, b.id);
  return OK;
});

// Pay credits to finish a work order on the next tick. The price rises with every rush in the last day (see credits.js).
const rushOrder = guarded((c, { orderId }) => {
  const oid = toInt(orderId);
  const o = Number.isNaN(oid) ? undefined : store.loadOrders(c.id).find((x) => x.id === oid);
  if (!o) return fail('That order no longer exists.');
  if (o.state === 'queued') return fail('That order has not started yet. Only work under way can be rushed.');
  if (o.ticks_remaining <= 1) return fail('That order is already finishing.');
  const tick = tickNow();
  const cost = credits.rushCost(c.id, o.action_type, o.ticks_remaining, tick);
  if (c.credits < cost) return fail(`Rushing this costs ${cost} cr.`);
  db.prepare('UPDATE colonies SET credits = credits - ? WHERE id = ?').run(cost, c.id);
  db.prepare('UPDATE colony_work_orders SET ticks_remaining = 1 WHERE id = ?').run(o.id);
  credits.record(c.id, 'rush', tick, cost);
  return OK;
});

const cancelOrder = guarded((c, { orderId }) => {
  const oid = toInt(orderId);
  const o = Number.isNaN(oid) ? undefined : store.loadOrders(c.id).find((x) => x.id === oid);
  if (!o) return fail('That order no longer exists.');
  const d = districtFor(c, o.district_id, true);
  if (!d) return fail(NO_DISTRICT);
  // An order that has started was paid for, and is refunded in full; one still waiting cost nothing. (A replacement
  // under way gets its own cost back, but the building it scrapped is gone.)
  if (o.state !== 'queued') refund(d.id, queue.costOf(d, o), 1);
  db.prepare('DELETE FROM colony_work_orders WHERE id = ?').run(o.id);
  const tick = tickNow();
  queue.advance(c, d, c.hub_level, queue.dbBag(c, d), tick, (k, msg) => store.addEvent(c.id, tick, k, msg));
  return OK;
});

// Buy the place's next build slot: one more order from the front of its queue is carried out at the same time. Paid at
// once, in goods from the place's own stockpile and in credits; whatever was waiting for a slot starts straight away.
const buildSlot = guarded((c, { district } = {}) => {
  const d = districtFor(c, district);
  if (!d) return fail(NO_DISTRICT);
  const next = queue.nextSlot(d);
  if (!next) return fail(`${d.type === 'core' ? 'The Core' : d.name} already has every build slot.`);
  if (c.hub_level < next.coreLevel) return fail(`Build slot ${next.slots} opens at hub level ${next.coreLevel}.`);
  if (!canAfford(store.loadInventory(c.id, d.id), next.cost)) return fail(`Not enough resources ${d.type === 'core' ? 'in the Core' : `in ${d.name}`} for another build slot.`);
  if (c.credits < next.credits) return fail(`Another build slot also costs ${next.credits} cr.`);
  pay(d.id, next.cost);
  db.prepare('UPDATE colonies SET credits = credits - ? WHERE id = ?').run(next.credits, c.id);
  db.prepare('UPDATE districts SET build_slots = ? WHERE id = ?').run(next.slots, d.id);
  const tick = tickNow();
  store.addEvent(c.id, tick, 'good', `${d.type === 'core' ? 'The Core' : d.name} now has ${next.slots} build slots.`);
  queue.advance(c, d, c.hub_level, queue.dbBag(c, d), tick, (k, msg) => store.addEvent(c.id, tick, k, msg));
  return { ok: true, slots: next.slots };
});

// ---- settlements the colony sponsors (see settlements.js) ---------------------------------
const settlementSponsor = guarded((c, args) => settlements.sponsor(c, args, tickNow()));
const settlementCommit = guarded((c, args) => settlements.commit(c, args));
const settlementGive = guarded((c, args) => settlements.give(c, args, tickNow()));
const settlementAnswer = guarded((c, args) => settlements.answer(c, args, tickNow()));
const settlementDrop = guarded((c, args) => settlements.drop(c, args, tickNow()));
const settlementReserve = guarded((c, args) => settlements.setReserve(c, args));

// Move a waiting order up, down or to the front of its place's queue.
const queueMove = guarded((c, { orderId, to }) => {
  const oid = toInt(orderId);
  if (Number.isNaN(oid) || !['up', 'down', 'top'].includes(to)) return fail('Bad move.');
  const bad = queue.move(c, oid, to);
  return bad ? fail(bad) : OK;
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
  return order(c, d, 'upgrade', { level: d.level + 1 });
});

// Found a satellite district: an order in the Core's queue, paid from the Core stockpile when it starts.
const foundDistrict = guarded((c, { type, discovery }) => {
  if (discovery !== undefined && discovery !== null) return hq.found(c, { discovery }, (d) => order(c, districtFor(c, null), 'found', d));
  const t = own(config.districtTypes, type);
  if (!t) return fail('Unknown district type.');
  if (!sim.districtsUnlocked(config, { coreLevel: c.hub_level })) {
    return fail(`Districts open at hub level ${config.districtProgression.unlockCoreLevel}.`);
  }
  if (!sim.districtFoundable(config, type, { coreLevel: c.hub_level, beaconBuilt: store.hasBeacon(c.id) })) return fail(`${t.name} opens once the Beacon is built.`);
  if (store.loadDistricts(c.id).some((d) => d.type === type && !d.discoveryId)
    || store.loadOrders(c.id).some((o) => o.action_type === 'found' && o.data.type === type && !o.data.discovery)) return fail(`${t.name} is already founded.`);
  return order(c, districtFor(c, null), 'found', { type });
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
  const trip = sim.shipDistance(config, { type: a.type, extraDistance: a.extra_distance }, { type: b.type, extraDistance: b.extra_distance });
  pay(a.id, { [resource]: qty });
  db.prepare('INSERT INTO colony_shipments (colony_id, from_district, to_district, resource_id, qty, dispatched_tick, arrives_tick) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(c.id, a.id, b.id, resource, qty, tick, tick + trip);
  return OK;
});

// What the whole colony has done, for alternative recipes that open at a milestone.
function milestonesOf(c) {
  return { beacon: store.hasBeacon(c.id), freeport: missions.hasFreePort(c.id), station: !!orbital.stationOf(c.id) };
}
// Set a production building to one of its alternative recipes, or back to its base recipe (recipe: null). There is no
// charge, but the line stands idle while it is retooled (config.production.switchTicks), every time.
function setAlternative(c, d, b, bdef, recipe) {
  if (!bdef.alternatives || (config.orbitalTypes || {})[d.type]) return fail('This building does not take recipes.');
  const id = recipe === null || recipe === undefined || recipe === '' || recipe === 'base' ? null : recipe;
  if (id !== null && !sim.alternativeOf(bdef, id)) return fail('Unknown recipe.');
  if ((b.recipe || null) === id) return OK;
  const tick = tickNow();
  if (b.recipe_ready_tick > tick) return fail(`${bdef.name} is still being retooled (${b.recipe_ready_tick - tick} ticks).`);
  if (id !== null && !sim.altUnlocked(bdef.alternatives[id], { level: d.level, milestones: milestonesOf(c) })) {
    const u = bdef.alternatives[id].unlock || {};
    const need = u.level ? `${d.type === 'core' ? 'hub' : 'district'} level ${u.level}` : { beacon: 'the Beacon', freeport: 'the Free Port', station: 'a station in orbit' }[u.milestone] || 'more progress';
    return fail(`${bdef.alternatives[id].name} needs ${need}.`);
  }
  db.prepare('UPDATE colony_buildings SET recipe = ?, recipe_ready_tick = ? WHERE id = ?').run(id, tick + config.production.switchTicks, b.id);
  return OK;
}

// ---- the Free Port: recipes, shields and missions ------------------------------------------
// The first recipe is free. Changing it costs credits (so many ticks of the old output at market value) and idles the
// workshop for a while.
const setRecipe = guarded((c, { ring, slot, recipe, district }) => {
  const d = districtFor(c, district, true);
  if (!d) return fail(NO_DISTRICT);
  const b = buildingAt(d, ring, slot);
  if (!b) return fail('Nothing there.');
  const bdef = config.buildings[b.building_type];
  if (!bdef.recipeBuilding) return setAlternative(c, d, b, bdef, recipe);
  if (!own(sim.recipeBook(config, bdef), recipe)) return fail('Unknown recipe.');
  if (d.type === 'territory') { const bad = territories.checkRecipe(d, recipe); if (bad) return fail(bad); }
  if (b.recipe === recipe) return OK;
  const tick = Number(store.getMeta('global_tick', 0));
  if (!b.recipe) {
    db.prepare('UPDATE colony_buildings SET recipe = ?, recipe_ready_tick = ? WHERE id = ?').run(recipe, tick, b.id);
    return OK;
  }
  if (b.recipe_ready_tick > tick) return fail('The workshop is still resetting.');
  const fee = sim.recipeResetFee(config, b.recipe, b.ring_index, d.type, bdef);
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

// Deliver a requisition in full from the Core.
const requisitionFill = guarded((c, { id }) => requisitions.fill(c, { id: toInt(id) }, tickNow()));

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
const linkCapacity = (config_, d) => Math.floor(config_.logistics.link.levels[d.link_level || d.linkLevel || 1].capacity * settlements.linkMult(d.colony_id)) + perks.linkBonus(d.colony_id); // d is a districts row
function linkLoad(c, districtId, ignoreRouteId) {
  return store.loadRoutes(c.id)
    .filter((r) => r.id !== ignoreRouteId && (r.fromDistrict === districtId || r.toDistrict === districtId))
    .reduce((n, r) => n + r.rate, 0);
}
const setRoute = guarded((c, { from, to, resource, rate, reserve, target }) => {
  const a = districtFor(c, from, true); const b = districtFor(c, to, true);
  if (!a || !b) return fail(NO_DISTRICT);
  if (a.id === b.id) return fail('Pick two different districts.');
  if (!own(config.resources, resource)) return fail('Unknown resource.');
  rate = Math.floor(toNum(rate)); reserve = reserve === undefined ? 0 : Math.floor(toNum(reserve));
  if (!Number.isFinite(rate) || rate < 0 || rate > 1e6) return fail('Bad rate.');
  if (!Number.isFinite(reserve) || reserve < 0 || reserve > 1e9) return fail('Bad reserve.');
  const existing = store.loadRoutes(c.id).find((r) => r.fromDistrict === a.id && r.toDistrict === b.id && r.resource === resource);
  // the target is the stock at which the destination stops taking more (0 = fill it); left out, an existing route keeps its own
  target = target === undefined ? (existing ? existing.target : 0) : Math.floor(toNum(target));
  if (!Number.isFinite(target) || target < 0 || target > 1e9) return fail('Bad target.');
  if (rate === 0) {
    if (existing) db.prepare('DELETE FROM colony_routes WHERE id = ?').run(existing.id);
    return OK;
  }
  const orb = (x) => !!(config.orbitalTypes || {})[x.type];
  if (orb(a) || orb(b)) {
    const bad = a.type === 'territory' || b.type === 'territory'
      ? territories.checkTerritoryRoute(c, a, b, resource, rate, existing && existing.id)
      : orbital.checkStationRoute(c, a, b, resource, rate, existing && existing.id);
    if (bad) return fail(bad);
    db.prepare(`INSERT INTO colony_routes (colony_id, from_district, to_district, resource_id, rate, reserve, target) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(from_district, to_district, resource_id) DO UPDATE SET rate = excluded.rate, reserve = excluded.reserve, target = excluded.target`)
      .run(c.id, a.id, b.id, resource, rate, reserve, target);
    return OK;
  }
  if (!sim.districtsUnlocked(config, { coreLevel: c.hub_level })) return fail('Districts are not open yet.');
  if (!existing && store.loadRoutes(c.id).length >= perks.maxRoutes(c.id)) return fail(`At most ${perks.maxRoutes(c.id)} routes.`);
  for (const d of [a, b]) {
    if (d.type === 'core') continue;
    const cap = linkCapacity(config, d);
    const load = linkLoad(c, d.id, existing && existing.id);
    if (load + rate > cap) return fail(`The link to ${d.name} carries ${cap} per tick and ${load} is already committed. Upgrade the link or lower the rate.`);
  }
  db.prepare(`INSERT INTO colony_routes (colony_id, from_district, to_district, resource_id, rate, reserve, target) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(from_district, to_district, resource_id) DO UPDATE SET rate = excluded.rate, reserve = excluded.reserve, target = excluded.target`)
    .run(c.id, a.id, b.id, resource, rate, reserve, target);
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
  const cost = settlements.discounted(c.id, next.upgradeCost);
  if (!canAfford(store.loadInventory(c.id, core), cost)) return fail('Not enough resources in the Core for the link upgrade.');
  pay(core, cost);
  db.prepare('UPDATE districts SET link_level = link_level + 1 WHERE id = ?').run(d.id);
  return OK;
});

const setContract = guarded((c, { resource, side, amount }) => {
  if (!own(config.resources, resource) || config.resources[resource].orbitalOnly) return fail('Unknown resource.');
  if (config.resources[resource].trade) return fail('The convoy does not carry trade goods. Use the exchange.');
  if (side !== 'export' && side !== 'import') return fail('Bad contract side.');
  amount = Math.floor(toNum(amount));
  if (!Number.isFinite(amount) || amount < 0) return fail('Bad amount.');
  amount = Math.min(amount, Math.floor(sim.convoyLimit(config, c.hub_level, resource) * requisitions.convoyMult(c, tickNow()) * settlements.convoyMult(c, tickNow())));
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
  const brokerage = Math.round(spend * credits.brokerageRate(c.id, tick)); // the soft limit on heavy buying (credits.js)
  if (c.credits + 0 < spend + fee + brokerage) return fail(`Not enough credits: the trip costs ${fee} cr plus ${spend} cr of goods${brokerage ? ` and ${brokerage} cr brokerage` : ''}.`);
  // Hold the goods and the money now.
  const up = db.prepare('UPDATE colony_inventory SET amount = amount - ? WHERE district_id = ? AND resource_id = ?');
  const coreDistrict = store.coreId(c.id);
  for (const [res, s] of Object.entries(sellOut)) up.run(s.qty, coreDistrict, res);
  db.prepare('UPDATE colonies SET credits = credits - ? WHERE id = ?').run(spend + fee + brokerage, c.id);
  if (spend > 0) credits.record(c.id, 'buy', tick, spend);
  db.prepare('INSERT INTO colony_express (colony_id, dispatched_tick, arrives_tick, sell, buy) VALUES (?, ?, ?, ?, ?)')
    .run(c.id, tick, tick + x.travelTicks, JSON.stringify(sellOut), JSON.stringify(buyOut));
  store.addEvent(c.id, tick, 'info', `Express convoy dispatched (fee ${fee} cr). Arrives in ${x.travelTicks} ticks.`);
  return OK;
});

// ---- orbit ---------------------------------------------------------------------------------
const tickNow = () => Number(store.getMeta('global_tick', 0));
const launchCycle = guarded((c, { cycle }) => orbital.loadCycle(c, { cycle }, tickNow()));
const launch = guarded((c, { name }) => orbital.launch(c, { name }, tickNow()));
const expressLaunch = guarded((c, args) => orbital.expressLaunch(c, args, tickNow()));
const orbitalStorageUpgrade = guarded((c) => orbital.upgradeStorage(c));
const orbitalLinksUpgrade = guarded((c) => orbital.upgradeLinks(c));
const jettison = guarded((c, args) => orbital.jettison(c, args));
const rebuildSlot = guarded((c, args) => orbital.rebuildSlot(c, args));
const shipDeploy = guarded((c, args) => territories.deploy(c, args, tickNow()));
const shipPlan = guarded((c, args) => territories.setPlan(c, args));
const shipReturn = guarded((c, args) => territories.returnShip(c, args, tickNow()));
const dataUnlock = guarded((c, args) => territories.unlockPacket(c, args || {}));
const shipBuild = guarded((c) => territories.buildShip(c, tickNow()));
// Trace recovery (minigames.js): start a play, make a move in it, or give it up.
const minigameStart = guarded((c, args) => minigames.start(c, args, Date.now(), tickNow()));
const minigameMove = guarded((c, args) => minigames.move(c, args, Date.now(), tickNow()));
const minigameQuit = guarded((c, args) => minigames.quit(c, args, Date.now(), tickNow()));
const shipUpgrade = guarded((c, args) => territories.upgradeShip(c, args));
const slotMove = guarded((c, args) => orbital.moveSlot(c, args || {}));
const slotRelease = guarded((c, args) => orbital.releaseSlot(c, args || {}));
// Headquarters (hq.js): deliver toward its bill, commit to (or switch to, or spend a free unlock on) an option, give one up,
// and use a banked level-4 refit.
const hqGive = guarded((c, args) => hq.give(c, args || {}, tickNow()));
const hqStart = guarded((c, args) => hq.start(c, args || {}, tickNow()));
const hqAbort = guarded((c, args) => hq.abort(c, args || {}, tickNow()));
const hqRefit = guarded((c, args) => hq.refit(c, args || {}, tickNow()));
const shipRepair = guarded((c, args) => territories.repairShip(c, args));
const projectContribute = guarded((c, args) => projects.contribute(c, args, tickNow()));
const orbitPost = guarded((c, args) => orbitalMarket.post(c, args, tickNow()));
const orbitCancel = guarded((c, args) => orbitalMarket.cancel(c, args));

// Switch every building a shutdown parked back on.
const resumeOps = guarded((c) => (shutdown.resume(c.id) ? OK : fail('No buildings are parked.')));

// Acknowledge the "while you were away" report.
const ack = guarded((c) => {
  const row = db.prepare('SELECT MAX(id) AS id FROM colony_events WHERE colony_id = ?').get(c.id);
  db.prepare('UPDATE colonies SET report_cursor = ? WHERE id = ?').run(row.id || 0, c.id);
  return OK;
}, { allowFailed: true });

// Full wipe back to the starting state (manual reset).
// Abandon the colony and start over. A healthy colony (no collapse countdown, not shut down, not collapsed) is not
// erased: it is parked under a generated account, where a bot can claim it and play it on. Anything else is wiped.
const healthy = (c) => {
  if (c.status !== 'active' || (c.shutdown_tick !== null && c.shutdown_tick !== undefined)) return false;
  const v = require('./state').viewFor(c.user_id); // required here: state.js needs much of what this file does
  return !!v && !v.lost && !v.doom;
};
const reset = guarded((c) => {
  if (healthy(c)) {
    absence.handOver(c.id);
    store.foundColony(c.user_id, { failures: c.failures });
    return { ok: true, parked: true };
  }
  const old = store.wipeColony(c.id);
  store.foundColony(old.user_id, { failures: old.failures });
  return { ok: true, parked: false };
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

module.exports = { hqGive, hqStart, hqAbort, hqRefit, slotMove, slotRelease, minigameStart, minigameMove, minigameQuit, settlementSponsor, settlementCommit, settlementGive, settlementAnswer, settlementDrop, settlementReserve, buildSlot, requisitionFill, replace, queueMove, rushOrder, dataUnlock, shipDeploy, shipPlan, shipReturn, shipBuild, shipUpgrade, shipRepair, projectContribute, orbitPost, orbitCancel, launchCycle, launch, expressLaunch, orbitalStorageUpgrade, orbitalLinksUpgrade, jettison, rebuildSlot, resumeOps, storySeen, build, demolish, toggle, setBoost, cancelOrder, upgradeHub, foundDistrict, expand, setRecipe, shieldHazard, missionFill, shipment, marketPost, marketCancel, setRoute, upgradeLink, setContract, expressTrip, reset, restart, ack, colonyOf };
