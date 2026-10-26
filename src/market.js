'use strict';
// The exchange: one order book per resource, shared by NPC market makers and players. Orders match by price,
// then by time; a trade happens at the price of the older (resting) order. Sells are held at posting, buys
// escrow credits at their limit price (and are refunded the difference when they fill at a better price).
// A fee on the seller's proceeds is the credit sink. Everything runs inside the caller's transaction.
const sim = require('./sim');
const ms = require('./marketsim');
const store = require('./db');
const { own, toInt, toNum } = require('./validate');
const { db, config } = store;

const X = config.exchange;
const resources = () => Object.keys(config.resources);

// ---- NPC market makers --------------------------------------------------------------------
// One persisted order per (resource, side, rung), re-quoted around the reference price, with its quantity
// regenerating toward the target. This is done lazily: a resource's rungs are only brought up to date when something
// needs them (a player posts, a player's order is resting on that resource, or the book is viewed), and they catch
// up for every tick they missed. A world where nobody has an open order therefore costs nothing per tick.
function ensureNpc(tick) {
  if (store.getMeta('npc_seeded')) return;
  const ins = db.prepare("INSERT INTO market_orders (owner, side, resource_id, price, qty, qty_total, level, created_tick, synced_tick) VALUES ('npc', ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const res of resources()) {
    const l = ms.ladder(config, res, tick);
    for (const a of l.asks) ins.run('sell', res, a.price, a.target, a.target, a.level, tick, tick);
    for (const b of l.bids) ins.run('buy', res, b.price, b.target, b.target, b.level, tick, tick);
  }
  store.setMeta('npc_seeded', '1');
}

const regenRate = (res) => (config.resources[res].trade ? X.tradeRegenPerTick : X.regenPerTick);
const regenStep = (res, target) => Math.max(1, Math.ceil(target * regenRate(res)));

function requote(res, tick) {
  const up = db.prepare("UPDATE market_orders SET price = ?, qty = MIN(?, qty + ? * MAX(0, ? - synced_tick)), qty_total = ?, synced_tick = ? WHERE owner = 'npc' AND resource_id = ? AND side = ? AND level = ?");
  const l = ms.ladder(config, res, tick);
  for (const a of l.asks) up.run(a.price, a.target, regenStep(res, a.target), tick, a.target, tick, res, 'sell', a.level);
  for (const b of l.bids) up.run(b.price, b.target, regenStep(res, b.target), tick, b.target, tick, res, 'buy', b.level);
}

// The book as it would be right now, without writing anything (used to show it to players).
function projectedNpc(tick) {
  const rows = db.prepare("SELECT resource_id AS res, side, level, qty, synced_tick AS synced FROM market_orders WHERE owner = 'npc'").all();
  const ladders = {};
  const out = [];
  for (const r of rows) {
    const l = ladders[r.res] || (ladders[r.res] = ms.ladder(config, r.res, tick));
    const q = (r.side === 'sell' ? l.asks : l.bids)[r.level];
    out.push({ owner: 'npc', colony: null, side: r.side, res: r.res, price: q.price, qty: Math.min(q.target, r.qty + regenStep(r.res, q.target) * Math.max(0, tick - r.synced)) });
  }
  return out;
}

// ---- settlement helpers ------------------------------------------------------------------
const addCredits = (colonyId, n) => db.prepare('UPDATE colonies SET credits = credits + ? WHERE id = ?').run(n, colonyId);
const addStock = (districtId, res, n) => db.prepare('UPDATE colony_inventory SET amount = amount + ? WHERE district_id = ? AND resource_id = ?').run(n, districtId, res);
const log = (colonyId, tick, kind, msg) => store.addEvent(colonyId, tick, kind, msg);
const fmtP = (p) => (Math.abs(p - Math.round(p)) < 0.005 ? String(Math.round(p)) : p.toFixed(2));

const capCache = new Map();
// Room left in a district for a resource (what a delivery can still be added without being trimmed away).
function roomIn(districtId, res) {
  const d = db.prepare('SELECT id, colony_id, type, level FROM districts WHERE id = ?').get(districtId);
  if (!d) return 0;
  const level = d.type === 'core' ? db.prepare('SELECT hub_level FROM colonies WHERE id = ?').get(d.colony_id).hub_level : d.level;
  const cap = sim.storageCap(config, { type: d.type, level, buildings: store.loadBuildings(d.colony_id, d.id) });
  const have = (store.loadInventory(d.colony_id, d.id)[res] || 0);
  return Math.max(0, Math.floor(cap - have));
}

// ---- matching ----------------------------------------------------------------------------
function match(res, tick) {
  const buys = db.prepare("SELECT * FROM market_orders WHERE resource_id = ? AND side = 'buy' AND status = 'open' AND qty > 0 ORDER BY price DESC, id").all(res);
  const sells = db.prepare("SELECT * FROM market_orders WHERE resource_id = ? AND side = 'sell' AND status = 'open' AND qty > 0 ORDER BY price ASC, id").all(res);
  const name = config.resources[res].name;
  let bi = 0;
  while (bi < buys.length) {
    const b = buys[bi];
    if (b.qty <= 0) { bi++; continue; }
    // best ask this buyer can trade with: not itself, still has stock, not above the buyer's limit
    const s = sells.find((x) => x.qty > 0 && x.price <= b.price + 1e-9 && !(b.colony_id && b.colony_id === x.colony_id) && !(b.owner === 'npc' && x.owner === 'npc'));
    if (!s) { bi++; continue; }
    const price = b.id < s.id ? b.price : s.price; // the resting (older) order sets the price
    let q = Math.min(b.qty, s.qty);
    if (b.owner === 'player') q = Math.min(q, roomIn(b.district_id, res));
    if (q <= 0) { bi++; continue; } // nowhere to put the goods: leave the order waiting
    const cost = Math.ceil(price * q - 1e-9);
    // buyer
    b.qty -= q; s.qty -= q;
    if (b.owner === 'player') {
      const held = Math.min(b.escrow, Math.ceil(b.price * q - 1e-9));
      const refund = Math.max(0, held - cost);
      b.escrow -= held;
      if (b.qty === 0 && b.escrow > 0) { addCredits(b.colony_id, b.escrow); b.escrow = 0; }
      if (refund) addCredits(b.colony_id, refund);
      addStock(b.district_id, res, q);
      log(b.colony_id, tick, 'good', `Exchange: bought ${q} ${name} at ${fmtP(price)} cr each (${cost} cr).`);
    }
    // seller
    if (s.owner === 'player') {
      const net = Math.floor(price * q * (1 - X.feeRate) + 1e-9);
      addCredits(s.colony_id, net);
      log(s.colony_id, tick, 'good', `Exchange: sold ${q} ${name} at ${fmtP(price)} cr each for ${net} cr after the ${Math.round(X.feeRate * 100)}% fee.`);
    }
    for (const o of [b, s]) {
      db.prepare("UPDATE market_orders SET qty = ?, escrow = ?, status = ? WHERE id = ?").run(o.qty, o.escrow || 0, o.qty === 0 && o.owner === 'player' ? 'filled' : 'open', o.id);
    }
    db.prepare('INSERT INTO market_trades (tick, resource_id, price, qty, buy_colony, sell_colony) VALUES (?, ?, ?, ?, ?, ?)').run(tick, res, price, q, b.colony_id, s.colony_id);
  }
}

// Resources somebody has an open player order on: the only ones whose books need work every tick.
const activeResources = () => db.prepare("SELECT DISTINCT resource_id AS res FROM market_orders WHERE owner = 'player' AND status = 'open'").all().map((r) => r.res);
function matchAll(tick) { for (const res of activeResources()) { requote(res, tick); match(res, tick); } }

function prune() {
  db.prepare('DELETE FROM market_trades WHERE id NOT IN (SELECT id FROM market_trades ORDER BY id DESC LIMIT ?)').run(X.tradesKept * 20);
  db.prepare("DELETE FROM market_orders WHERE owner = 'player' AND status != 'open' AND id NOT IN (SELECT id FROM market_orders WHERE owner = 'player' AND status != 'open' ORDER BY id DESC LIMIT 400)").run();
}

// ---- cancelling and expiry -------------------------------------------------------------------
function close(o, status, tick, why) {
  if (o.side === 'sell') { if (o.qty > 0 && o.district_id) addStock(o.district_id, o.resource_id, o.qty); }
  else if (o.escrow > 0) addCredits(o.colony_id, o.escrow);
  db.prepare("UPDATE market_orders SET status = ?, escrow = 0 WHERE id = ?").run(status, o.id);
  const name = config.resources[o.resource_id].name;
  const back = o.side === 'sell' ? `${o.qty} ${name} returned` : `${o.escrow} cr returned`;
  log(o.colony_id, tick, 'info', `Exchange: your ${o.side} order for ${o.qty} ${name} ${why}. ${o.qty > 0 ? back + '.' : ''}`);
}

function expire(tick) {
  for (const o of db.prepare("SELECT * FROM market_orders WHERE owner = 'player' AND status = 'open' AND expires_tick IS NOT NULL AND expires_tick <= ?").all(tick)) close(o, 'expired', tick, 'expired');
}

// ---- the tick ---------------------------------------------------------------------------------
function advance(tick) {
  ensureNpc(tick);
  matchAll(tick);
  expire(tick);
  if (tick % 50 === 0) prune();
}

// ---- player orders ----------------------------------------------------------------------------
const openCount = (colonyId) => db.prepare("SELECT COUNT(*) AS n FROM market_orders WHERE colony_id = ? AND owner = 'player' AND status = 'open'").get(colonyId).n;

// c: colony row. d: the district goods come from (sell) or are delivered to (buy), a districts row.
// Returns { ok } or { ok: false, error }; on success { ok, filled, id }.
function post(c, d, { side, resource, price, qty, ttl }, tick) {
  const fail = (error) => ({ ok: false, error });
  if (c.hub_level < X.unlockCoreLevel) return fail(`The exchange opens at hub level ${X.unlockCoreLevel}.`);
  if (side !== 'buy' && side !== 'sell') return fail('Bad order side.');
  if (!own(config.resources, resource)) return fail('Unknown resource.');
  qty = Math.floor(toNum(qty)); price = Math.round(toNum(price) * 100) / 100; ttl = toInt(ttl);
  if (!Number.isFinite(qty) || qty < 1) return fail('Bad quantity.');
  if (qty > X.maxQty) return fail(`At most ${X.maxQty} per order.`);
  if (!Number.isFinite(price) || price <= 0) return fail('Bad price.');
  if (!X.ttlOptions.includes(ttl)) return fail('Bad order lifetime.');
  ensureNpc(tick);
  const ref = ms.refPrice(config, resource, tick);
  if (price < ref * 0.2 || price > ref * 5) return fail(`Price must be between ${fmtP(ref * 0.2)} and ${fmtP(ref * 5)} cr (the market is around ${fmtP(ref)}).`);
  if (openCount(c.id) >= X.maxOpenOrders) return fail(`At most ${X.maxOpenOrders} open orders.`);
  const name = config.resources[resource].name;
  let escrow = 0;
  if (side === 'sell') {
    const have = store.loadInventory(c.id, d.id)[resource] || 0;
    if (have < qty) return fail(`Not enough ${name} in ${d.name}.`);
    db.prepare('UPDATE colony_inventory SET amount = amount - ? WHERE district_id = ? AND resource_id = ?').run(qty, d.id, resource);
  } else {
    escrow = Math.ceil(price * qty - 1e-9);
    const credits = db.prepare('SELECT credits FROM colonies WHERE id = ?').get(c.id).credits;
    if (credits < escrow) return fail(`Not enough credits: the order holds ${escrow} cr.`);
    addCredits(c.id, -escrow);
  }
  const id = Number(db.prepare(`INSERT INTO market_orders (owner, colony_id, district_id, side, resource_id, price, qty, qty_total, escrow, created_tick, expires_tick)
    VALUES ('player', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.id, d.id, side, resource, price, qty, qty, escrow, tick, tick + ttl).lastInsertRowid);
  requote(resource, tick);
  match(resource, tick);
  const o = db.prepare('SELECT * FROM market_orders WHERE id = ?').get(id);
  return { ok: true, id, filled: qty - o.qty };
}

function cancel(c, orderId, tick) {
  const o = db.prepare("SELECT * FROM market_orders WHERE id = ? AND colony_id = ? AND owner = 'player' AND status = 'open'").get(toInt(orderId), c.id);
  if (!o) return { ok: false, error: 'That order is no longer open.' };
  close(o, 'cancelled', tick, 'was cancelled');
  return { ok: true };
}

module.exports = { projectedNpc, advance, ensureNpc, requote, match, matchAll, post, cancel, expire, roomIn, openCount };
