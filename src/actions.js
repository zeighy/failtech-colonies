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

function pay(colonyId, cost) {
  const up = db.prepare('UPDATE colony_inventory SET amount = amount - ? WHERE colony_id = ? AND resource_id = ?');
  for (const [r, a] of Object.entries(cost)) up.run(a, colonyId, r);
}

// Refunds add straight to stock; the next tick trims anything above the storage cap.
function refund(colonyId, cost, fraction) {
  const up = db.prepare('UPDATE colony_inventory SET amount = amount + ? WHERE colony_id = ? AND resource_id = ?');
  for (const [r, a] of Object.entries(cost)) up.run(Math.floor(a * fraction), colonyId, r);
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

const slotBusy = (colonyId, ring, slot) => {
  if (db.prepare('SELECT 1 FROM colony_buildings WHERE colony_id = ? AND ring_index = ? AND slot_index = ?').get(colonyId, ring, slot)) return true;
  return store.loadOrders(colonyId).some((o) => o.action_type === 'build' && o.data.ring === ring && o.data.slot === slot);
};

const build = guarded((c, { ring, slot, type }) => {
  ring = Number(ring); slot = Number(slot);
  const def = config.buildings[type];
  if (!def) return fail('Unknown building type.');
  if (!sim.slotUnlocked(config, c.hub_level, ring, slot)) return fail('That slot is locked. Upgrade the hub.');
  if (def.minHubLevel && c.hub_level < def.minHubLevel) return fail(`${def.name} requires hub level ${def.minHubLevel}.`);
  if (slotBusy(c.id, ring, slot)) return fail('That slot is already in use.');
  if (def.maxCount) {
    const have = store.loadBuildings(c.id).filter((b) => b.type === type).length
      + store.loadOrders(c.id).filter((o) => o.action_type === 'build' && o.data.type === type).length;
    if (have >= def.maxCount) return fail(`Only ${def.maxCount} ${def.name} can be built.`);
  }
  if (!canAfford(store.loadInventory(c.id), def.cost)) return fail(`Not enough resources for ${def.name}.`);
  pay(c.id, def.cost);
  db.prepare('INSERT INTO colony_work_orders (colony_id, action_type, target_data, ticks_remaining, ticks_total) VALUES (?, ?, ?, ?, ?)')
    .run(c.id, 'build', JSON.stringify({ ring, slot, type }), def.constructionTicks, def.constructionTicks);
  return OK;
});

const demolish = guarded((c, { ring, slot }) => {
  ring = Number(ring); slot = Number(slot);
  const b = db.prepare('SELECT * FROM colony_buildings WHERE colony_id = ? AND ring_index = ? AND slot_index = ?').get(c.id, ring, slot);
  if (!b) return fail('Nothing to demolish there.');
  db.prepare('DELETE FROM colony_buildings WHERE id = ?').run(b.id);
  refund(c.id, config.buildings[b.building_type].cost, config.global.demolishRefund);
  return OK;
});

const toggle = guarded((c, { ring, slot }) => {
  const b = db.prepare('SELECT * FROM colony_buildings WHERE colony_id = ? AND ring_index = ? AND slot_index = ?').get(c.id, Number(ring), Number(slot));
  if (!b) return fail('Nothing there.');
  db.prepare('UPDATE colony_buildings SET status = ? WHERE id = ?').run(b.status === 'active' ? 'paused' : 'active', b.id);
  return OK;
});

const cancelOrder = guarded((c, { orderId }) => {
  const o = store.loadOrders(c.id).find((x) => x.id === Number(orderId));
  if (!o) return fail('That order no longer exists.');
  const cost = o.action_type === 'build' ? config.buildings[o.data.type].cost : config.hubLevels[o.data.level].upgradeCost;
  refund(c.id, cost, 1);
  db.prepare('DELETE FROM colony_work_orders WHERE id = ?').run(o.id);
  return OK;
});

const upgradeHub = guarded((c) => {
  const next = config.hubLevels[c.hub_level + 1];
  if (!next) return fail('The hub is already at maximum level.');
  if (store.loadOrders(c.id).some((o) => o.action_type === 'upgrade')) return fail('An upgrade is already underway.');
  if (!canAfford(store.loadInventory(c.id), next.upgradeCost)) return fail('Not enough resources for the upgrade.');
  pay(c.id, next.upgradeCost);
  db.prepare('INSERT INTO colony_work_orders (colony_id, action_type, target_data, ticks_remaining, ticks_total) VALUES (?, ?, ?, ?, ?)')
    .run(c.id, 'upgrade', JSON.stringify({ level: c.hub_level + 1 }), next.upgradeTicks, next.upgradeTicks);
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

module.exports = { build, demolish, toggle, cancelOrder, upgradeHub, setContract, reset, restart, ack, colonyOf };
