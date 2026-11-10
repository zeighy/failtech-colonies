'use strict';
// The work queue. Every place (the Core, a district, the station, a territory) has one build slot and a queue behind it.
// Building, replacing, expanding, upgrading and (in the Core) founding a district all wait in the same line.
//  - Orders run strictly in the order they were queued. Nothing behind the front of the queue starts early, even if the
//    place could pay for it: starting it could spend what the front order is waiting for.
//  - An order is paid for when it starts, not when it is queued, so it can be queued before the materials exist. The front
//    order waits until its place can pay.
//  - An order that can no longer be carried out when its turn comes (the plot was taken, the building is gone) is dropped
//    with a note in the log, and the next one gets its turn.
// Orders created before the queue existed are simply 'active': they keep running side by side until they finish.
const sim = require('./sim');
const store = require('./db');
const territories = require('./territories');
const { db, config } = store;

const Q = { maxPerPlace: 8, replaceTimeMult: 1.5, ...(config.global.buildQueue || {}) };
const defAt = (d, type) => sim.territoryDef(config.buildings[type], d.type);
const placeName = (d) => (d.type !== 'core' && (config.districtTypes || {})[d.type] ? config.districtTypes[d.type].name : d.name);
const where = (d) => (d.type === 'core' ? '' : ` in ${placeName(d)}`);

// What an order costs when it starts.
function costOf(d, o) {
  if (o.action_type === 'build' || o.action_type === 'replace') return defAt(d, o.data.type).cost;
  if (o.action_type === 'found') return config.districtTypes[o.data.type].foundCost;
  if (o.action_type === 'expand') return sim.expansionCost(config, config.buildings[o.data.type], o.data.level);
  return sim.levelDef(config, d.type, o.data.level).upgradeCost;
}
// What a replacement gets back for the building it scraps: the same share as demolishing it.
function refundOf(d, o) {
  const out = {};
  if (o.action_type !== 'replace') return out;
  for (const [r, a] of Object.entries(defAt(d, o.data.from).cost)) out[r] = Math.floor(a * config.global.demolishRefund);
  return out;
}
// How long an order takes once it has started.
function ticksOf(d, kind, data) {
  if (kind === 'build') return defAt(d, data.type).constructionTicks;
  if (kind === 'replace') return Math.ceil(defAt(d, data.type).constructionTicks * Q.replaceTimeMult);
  if (kind === 'found') return config.districtTypes[data.type].foundTicks;
  if (kind === 'expand') return config.expansion.ticks[data.level];
  return sim.levelDef(config, d.type, data.level).upgradeTicks;
}
// What the place is short of for this cost (after anything it gets back), or null.
function shortfall(inv, cost, back = {}) {
  const s = {};
  for (const [r, a] of Object.entries(cost)) {
    const have = (inv[r] || 0) + (back[r] || 0);
    if (have < a) s[r] = Math.ceil(a - have);
  }
  return Object.keys(s).length ? s : null;
}
function label(d, o) {
  const b = (t) => config.buildings[t].name;
  if (o.action_type === 'build') return b(o.data.type);
  if (o.action_type === 'replace') return `Replacing ${b(o.data.from)} with ${b(o.data.type)}`;
  if (o.action_type === 'expand') return `Expanding ${b(o.data.type)} to level ${o.data.level}`;
  if (o.action_type === 'found') return `Founding ${config.districtTypes[o.data.type].name}`;
  return `The level ${o.data.level} upgrade`;
}

// Can this order still be carried out now that its turn has come? null = yes; { drop } = never (take it off the queue);
// { wait } = not yet (it keeps its place at the front).
function check(c, d, level, o, tick) {
  const { ring, slot, type } = o.data;
  const at = () => db.prepare('SELECT * FROM colony_buildings WHERE district_id = ? AND ring_index = ? AND slot_index = ?').get(d.id, ring, slot);
  const tooMany = (def) => {
    if (!def.maxCount) return false;
    const built = db.prepare('SELECT COUNT(*) AS n FROM colony_buildings WHERE colony_id = ? AND building_type = ?').get(c.id, type).n;
    const under = store.loadOrders(c.id).filter((x) => x.id !== o.id && x.state === 'active' && (x.action_type === 'build' || x.action_type === 'replace') && x.data.type === type).length;
    return built + under >= def.maxCount;
  };
  const beside = (def) => {
    if (!def.requiresAdjacent) return true;
    const nbs = sim.buildNeighborMap(config, d.type).get(sim.key(ring, slot)) || [];
    return store.loadBuildings(c.id, d.id).some((x) => x.type === def.requiresAdjacent && nbs.some(([r, sl]) => r === x.ring && sl === x.slot));
  };
  if (o.action_type === 'build') {
    const def = config.buildings[type];
    if (at()) return { drop: 'the plot is no longer free' };
    if (!sim.slotUnlocked(config, level, ring, slot, d.type)) return { drop: 'the plot is locked' };
    const lock = db.prepare('SELECT until_tick FROM slot_locks WHERE district_id = ? AND ring_index = ? AND slot_index = ?').get(d.id, ring, slot);
    if (lock && lock.until_tick > tick) return { wait: 'the plot is still being cleared' };
    if (tooMany(def)) return { drop: `only ${def.maxCount} can be built` };
    if (!beside(def)) return { drop: `it must stand beside the ${config.buildings[def.requiresAdjacent].name}` };
    if (d.type === 'territory' && !def.dataRecovery) { const bad = territories.checkBuild(d, def); if (bad) return { drop: 'there is nothing for it to work on here' }; }
    if (def.dataRecovery && db.prepare('SELECT 1 FROM colony_buildings WHERE district_id = ? AND building_type = ?').get(d.id, type)) return { drop: 'there is already one here' };
    return null;
  }
  if (o.action_type === 'replace') {
    const b = at();
    if (!b || b.building_type !== o.data.from) return { drop: 'the building it was to replace is gone' };
    if (b.recipe && config.buildings[b.building_type].recipeBuilding) return { drop: 'the workshop has a recipe set now' };
    const def = config.buildings[type];
    if (tooMany(def)) return { drop: `only ${def.maxCount} can be built` };
    if (!beside(def)) return { drop: `it must stand beside the ${config.buildings[def.requiresAdjacent].name}` };
    return null;
  }
  if (o.action_type === 'expand') {
    const b = at();
    if (!b || b.building_type !== type) return { drop: 'the building is gone' };
    if ((b.level || 1) !== o.data.level - 1) return { drop: 'the building is not at the level it was queued from' };
    return null;
  }
  if (o.action_type === 'upgrade') return level === o.data.level - 1 ? null : { drop: 'the level has changed' };
  if (o.action_type === 'found') return db.prepare('SELECT 1 FROM districts WHERE colony_id = ? AND type = ?').get(c.id, type) ? { drop: 'it is already founded' } : null;
  return { drop: 'unknown order' };
}

// A place's stock, as the queue needs it: read, take, add. The engine works on the stock it holds in memory for the tick;
// player actions work on the database.
const memBag = (inv) => ({
  inv: () => inv,
  take: (cost) => { for (const [r, a] of Object.entries(cost)) inv[r] = (inv[r] || 0) - a; },
  add: (cost) => { for (const [r, a] of Object.entries(cost)) inv[r] = (inv[r] || 0) + a; },
});
const dbBag = (c, d) => {
  const up = db.prepare('UPDATE colony_inventory SET amount = amount + ? WHERE district_id = ? AND resource_id = ?');
  return {
    inv: () => store.loadInventory(c.id, d.id),
    take: (cost) => { for (const [r, a] of Object.entries(cost)) up.run(-a, d.id, r); },
    add: (cost) => { for (const [r, a] of Object.entries(cost)) up.run(a, d.id, r); },
  };
};

const count = (c, d) => db.prepare('SELECT COUNT(*) AS n FROM colony_work_orders WHERE colony_id = ? AND district_id = ?').get(c.id, d.id).n;

// Put an order at the back of a place's queue. It does not start, and nothing is paid, until `advance` gives it its turn.
function enqueue(c, d, kind, data) {
  const ticks = ticksOf(d, kind, data);
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM colony_work_orders WHERE colony_id = ?').get(c.id).p;
  return Number(db.prepare("INSERT INTO colony_work_orders (colony_id, district_id, action_type, target_data, ticks_remaining, ticks_total, state, position) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)")
    .run(c.id, d.id, kind, JSON.stringify(data), ticks, ticks, pos).lastInsertRowid);
}

// If the place's build slot is free, start the order at the front of its queue, provided it can still be carried out and
// the place can pay. Returns the id of the order it started, or null.
function advance(c, d, coreLevel, bag, tick, ev) {
  const level = d.type === 'core' ? coreLevel : (db.prepare('SELECT level FROM districts WHERE id = ?').get(d.id) || { level: d.level }).level;
  for (let i = 0; i < 64; i++) {
    const orders = store.loadOrders(c.id, d.id);
    if (orders.some((o) => o.state === 'active')) return null;
    const o = orders.find((x) => x.state === 'queued');
    if (!o) return null;
    const bad = check(c, d, level, o, tick);
    if (bad && bad.drop) {
      db.prepare('DELETE FROM colony_work_orders WHERE id = ?').run(o.id);
      if (ev) ev('warn', `${label(d, o)} was taken off the work queue${where(d)}: ${bad.drop}.`);
      continue;
    }
    if (bad) return null;
    const cost = costOf(d, o); const back = refundOf(d, o);
    if (shortfall(bag.inv(), cost, back)) return null; // it waits at the front; nothing behind it may start
    bag.add(back);
    bag.take(cost);
    if (o.action_type === 'replace') db.prepare('DELETE FROM colony_buildings WHERE district_id = ? AND ring_index = ? AND slot_index = ?').run(d.id, o.data.ring, o.data.slot);
    db.prepare("UPDATE colony_work_orders SET state = 'active' WHERE id = ?").run(o.id);
    return o.id;
  }
  return null;
}

// Move a waiting order within its place's queue: 'up', 'down' or 'top' (never ahead of the order under way).
function move(c, orderId, to) {
  const o = store.loadOrders(c.id).find((x) => x.id === orderId);
  if (!o) return 'That order no longer exists.';
  if (o.state !== 'queued') return 'That order is already under way.';
  const line = store.loadOrders(c.id, o.district_id).filter((x) => x.state === 'queued');
  const i = line.findIndex((x) => x.id === o.id);
  const j = to === 'top' ? 0 : to === 'up' ? i - 1 : to === 'down' ? i + 1 : -1;
  if (j < 0 || j >= line.length || j === i) return null; // nowhere to go: nothing changes
  const next = line.slice();
  next.splice(i, 1);
  next.splice(j, 0, o);
  const slots = line.map((x) => x.position).sort((a, b) => a - b); // the same positions, handed out in the new order
  const up = db.prepare('UPDATE colony_work_orders SET position = ? WHERE id = ?');
  next.forEach((x, k) => up.run(slots[k], x.id));
  return null;
}

module.exports = { max: Q.maxPerPlace, replaceTimeMult: Q.replaceTimeMult, costOf, refundOf, ticksOf, shortfall, label, check, memBag, dbBag, count, enqueue, advance, move };
