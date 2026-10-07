'use strict';
const sim = require('./sim');
const store = require('./db');
const { db, config } = store;

const fail = (error) => ({ ok: false, error });
const OK = { ok: true };

function colonyOf(userId) {
  return db.prepare('SELECT * FROM colonies WHERE user_id = ?').get(userId);
}

function canAfford(inv, cost) {
  return Object.entries(cost).every(([r, a]) => (inv[r] || 0) >= a);
}

// Which district is an action about? The Core unless one is named; a named one must belong to this colony.
// The Core's level lives on the colony (colonies.hub_level); other districts carry their own.
function districtFor(c, id) {
  const d = id === undefined || id === null
    ? db.prepare("SELECT * FROM districts WHERE colony_id = ? AND type = 'core'").get(c.id)
    : db.prepare('SELECT * FROM districts WHERE id = ? AND colony_id = ?').get(Number(id), c.id);
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
  return (userId, args = {}) => {
    const c = colonyOf(userId);
    if (!c) return fail('No colony found.');
    if (c.status !== 'active' && !allowFailed) return fail('This colony has been abandoned.');
    return db.transaction(() => fn(c, args))();
  };
}

const slotBusy = (c, d, ring, slot) => {
  if (db.prepare('SELECT 1 FROM colony_buildings WHERE district_id = ? AND ring_index = ? AND slot_index = ?').get(d.id, ring, slot)) return true;
  return store.loadOrders(c.id, d.id).some((o) => o.action_type === 'build' && o.data.ring === ring && o.data.slot === slot);
};

const build = guarded((c, { ring, slot, type, district }) => {
  const d = districtFor(c, district);
  if (!d) return fail(NO_DISTRICT);
  ring = Number(ring); slot = Number(slot);
  const def = config.buildings[type];
  if (!def) return fail('Unknown building type.');
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

const buildingAt = (d, ring, slot) =>
  db.prepare('SELECT * FROM colony_buildings WHERE district_id = ? AND ring_index = ? AND slot_index = ?').get(d.id, Number(ring), Number(slot));

const demolish = guarded((c, { ring, slot, district }) => {
  const d = districtFor(c, district);
  if (!d) return fail(NO_DISTRICT);
  const b = buildingAt(d, ring, slot);
  if (!b) return fail('Nothing to demolish there.');
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
  db.prepare('UPDATE colony_buildings SET status = ? WHERE id = ?').run(next, b.id);
  return OK;
});

const cancelOrder = guarded((c, { orderId }) => {
  const o = store.loadOrders(c.id).find((x) => x.id === Number(orderId));
  if (!o) return fail('That order no longer exists.');
  const d = districtFor(c, o.district_id);
  const cost = o.action_type === 'build' ? config.buildings[o.data.type].cost : sim.levelDef(config, d.type, o.data.level).upgradeCost;
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

const setContract = guarded((c, { resource, side, amount }) => {
  if (!config.resources[resource]) return fail('Unknown resource.');
  if (side !== 'export' && side !== 'import') return fail('Bad contract side.');
  amount = Math.floor(Number(amount));
  if (!Number.isFinite(amount) || amount < 0) return fail('Bad amount.');
  amount = Math.min(amount, sim.convoyLimit(config, c.hub_level, resource));
  if (amount === 0) db.prepare('DELETE FROM colony_contracts WHERE colony_id = ? AND resource_id = ? AND side = ?').run(c.id, resource, side);
  else db.prepare('INSERT INTO colony_contracts (colony_id, resource_id, side, amount) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET amount = excluded.amount').run(c.id, resource, side, amount);
  return OK;
});

// Express convoy: a one-off, player-dispatched trip. Goods and credits are held on dispatch
// (so nothing can be spent twice) and delivered a few ticks later at worse-than-scheduled rates.
const expressTrip = guarded((c, { sell = {}, buy = {} }) => {
  const x = config.global.express;
  const tick = Number(store.getMeta('global_tick', 0));
  if (store.loadExpress(c.id)) return fail('An express convoy is already on its way.');
  if (tick < c.express_ready_tick) return fail(`The express convoy needs ${c.express_ready_tick - tick} more ticks before it can run again.`);
  const prices = sim.expressPrices(config, sim.marketPrices(config, sim.nextConvoyK(config, tick)));
  const inv = store.loadInventory(c.id);
  const sellOut = {}; const buyOut = {};
  let income = 0; let spend = 0;
  const clean = (o) => Object.entries(o || {}).map(([r, q]) => [r, Math.floor(Number(q))]).filter(([, q]) => q > 0);
  for (const [res, qty] of clean(sell)) {
    if (!config.resources[res]) return fail('Unknown resource.');
    const lim = Math.max(1, Math.floor(sim.convoyLimit(config, c.hub_level, res) * x.limitFraction));
    if (qty > lim) return fail(`Express convoys carry at most ${lim} ${config.resources[res].name}.`);
    if ((inv[res] || 0) < qty) return fail(`Not enough ${config.resources[res].name} in stock to send.`);
    const pay = Math.round(qty * prices[res].sell);
    sellOut[res] = { qty, pay }; income += pay;
  }
  for (const [res, qty] of clean(buy)) {
    if (!config.resources[res]) return fail('Unknown resource.');
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

module.exports = { build, demolish, toggle, cancelOrder, upgradeHub, setContract, expressTrip, reset, restart, ack, colonyOf };
