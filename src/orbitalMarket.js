'use strict';
// Orbit, part three: the orbital market. A separate order book for trade goods made in the orbital foundry (the standard
// trade goods and the orbital-only ones), traded straight from orbital storage. Orders show the station that posted them.
//
// Market makers are deliberately thin: every `makerRefreshTicks` they post one small bid and one small ask per good around
// the reference price (the same reference the ground exchange uses, so prices feel familiar). They set a price band and a
// suggestion; they are not a shop. Matching is price first, then time, at the resting order's price; a fee comes off the
// seller's proceeds. Sells are held from storage when posted and buys hold their credits, so nothing is spent twice.
const store = require('./db');
const credits = require('./credits');
const ms = require('./marketsim');
const orbital = require('./orbital');
const { own, toInt, toNum } = require('./validate');
const { db, config } = store;
const M = config.orbital.market;

const fail = (error) => ({ ok: false, error });
const MAKER = 'Market maker';
const money = (n) => Math.round(n * 100) / 100;

const tradeable = (res) => !!(config.resources[res] && (config.resources[res].trade || config.resources[res].orbitalTrade));
const goods = () => Object.keys(config.resources).filter(tradeable);
const reference = (res, tick) => money(ms.refPrice(config, res, tick));
const band = (res, tick) => [money(reference(res, tick) * M.band[0]), money(reference(res, tick) * M.band[1])];

function credit(colonyId, amount) { db.prepare('UPDATE colonies SET credits = credits + ? WHERE id = ?').run(Math.floor(amount), colonyId); }
function toStation(colonyId, res, qty) {
  const st = orbital.stationOf(colonyId);
  if (!st) return;
  const inv = store.loadInventory(colonyId, st.district_id);
  inv[res] = (inv[res] || 0) + qty;
  store.saveInventory(colonyId, inv, st.district_id);
}

// Release whatever an order still holds back to its owner.
function release(o) {
  if (!o.colony_id || o.remaining <= 0) return;
  if (o.side === 'sell') toStation(o.colony_id, o.resource_id, o.remaining);
  else credit(o.colony_id, o.remaining * o.price);
}

// Cross the book for one good until nothing more can trade.
function match(res, tick) {
  for (let guard = 0; guard < 500; guard++) {
    const bids = db.prepare("SELECT * FROM orbital_orders WHERE resource_id = ? AND side = 'buy' AND status = 'open' ORDER BY price DESC, id ASC").all(res);
    const asks = db.prepare("SELECT * FROM orbital_orders WHERE resource_id = ? AND side = 'sell' AND status = 'open' ORDER BY price ASC, id ASC").all(res);
    let pair = null;
    for (const b of bids) {
      for (const a of asks) {
        if (a.price > b.price) break;
        if (!b.colony_id && !a.colony_id) continue;      // two market makers never trade with each other
        if (b.colony_id && b.colony_id === a.colony_id) continue;
        pair = [b, a]; break;
      }
      if (pair) break;
    }
    if (!pair) return;
    const [b, a] = pair;
    const price = a.id < b.id ? a.price : b.price; // the older order sets the price
    const q = Math.min(a.remaining, b.remaining);
    let brokerage = 0;
    if (b.colony_id) {
      toStation(b.colony_id, res, q);
      credit(b.colony_id, q * (b.price - price)); // a buy held its own limit price; return the difference
      brokerage = credits.chargeBuy(b.colony_id, tick, Math.round(q * price));
    }
    if (a.colony_id) credit(a.colony_id, q * price * (1 - M.feeRate));
    for (const o of [a, b]) {
      const left = o.remaining - q;
      db.prepare('UPDATE orbital_orders SET remaining = ?, status = ? WHERE id = ?').run(left, left > 0 ? 'open' : 'filled', o.id);
    }
    db.prepare('INSERT INTO orbital_trades (tick, resource_id, price, qty, buyer, seller) VALUES (?, ?, ?, ?, ?, ?)').run(tick, res, price, q, b.station_name, a.station_name);
    const name = config.resources[res].name;
    if (b.colony_id) store.addEvent(b.colony_id, tick, 'good', `Orbital market: bought ${q} ${name} from ${a.station_name} at ${price} cr${brokerage ? `, plus ${brokerage} cr brokerage` : ''}.`);
    if (a.colony_id) store.addEvent(a.colony_id, tick, 'good', `Orbital market: sold ${q} ${name} to ${b.station_name} at ${price} cr.`);
  }
}

// Once per tick: expire orders, refresh the market makers, keep only recent history.
function advance(tick) {
  for (const o of db.prepare("SELECT * FROM orbital_orders WHERE status = 'open' AND expires_tick <= ?").all(tick)) {
    release(o);
    db.prepare("UPDATE orbital_orders SET status = 'expired' WHERE id = ?").run(o.id);
  }
  const hasMakers = db.prepare("SELECT 1 FROM orbital_orders WHERE colony_id IS NULL AND status = 'open' LIMIT 1").get();
  if (tick % M.makerRefreshTicks === 0 || !hasMakers) {
    db.prepare("UPDATE orbital_orders SET status = 'cancelled' WHERE colony_id IS NULL AND status = 'open'").run();
    const ins = db.prepare("INSERT INTO orbital_orders (colony_id, station_name, resource_id, side, price, qty, remaining, created_tick, expires_tick) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const res of goods()) {
      const ref = reference(res, tick);
      const qty = M.makerQtyByTier[config.resources[res].tier] || 4;
      ins.run(MAKER, res, 'buy', money(ref * (1 - M.makerSpread)), qty, qty, tick, tick + M.makerRefreshTicks);
      ins.run(MAKER, res, 'sell', money(ref * (1 + M.makerSpread)), qty, qty, tick, tick + M.makerRefreshTicks);
      match(res, tick);
    }
  }
  if (tick % 100 === 0) {
    db.prepare("DELETE FROM orbital_orders WHERE status != 'open' AND id NOT IN (SELECT id FROM orbital_orders WHERE status != 'open' ORDER BY id DESC LIMIT 2000)").run();
    db.prepare('DELETE FROM orbital_trades WHERE id NOT IN (SELECT id FROM orbital_trades ORDER BY id DESC LIMIT 1000)').run();
  }
}

function post(c, { resource, side, price, qty, ttl }, tick) {
  const st = orbital.stationOf(c.id);
  if (!st) return fail('There is no station.');
  if (!own(config.resources, resource) || !tradeable(resource)) return fail('Only trade goods are traded in orbit.');
  if (side !== 'buy' && side !== 'sell') return fail('Bad side.');
  price = money(toNum(price)); qty = toInt(qty); ttl = toInt(ttl);
  if (!Number.isFinite(price) || price <= 0) return fail('Bad price.');
  if (Number.isNaN(qty) || qty < 1 || qty > M.maxQty) return fail(`Order between 1 and ${M.maxQty}.`);
  if (!M.ttlOptions.includes(ttl)) return fail('Bad lifetime.');
  const [lo, hi] = band(resource, tick);
  if (price < lo || price > hi) return fail(`The orbital market only takes prices between ${lo} and ${hi} cr for that.`);
  const open = db.prepare("SELECT COUNT(*) AS n FROM orbital_orders WHERE colony_id = ? AND status = 'open'").get(c.id).n;
  if (open >= M.maxOpenOrders) return fail(`At most ${M.maxOpenOrders} open orders.`);
  if (side === 'sell') {
    const inv = store.loadInventory(c.id, st.district_id);
    if ((inv[resource] || 0) < qty) return fail(`Not enough ${config.resources[resource].name} in orbital storage.`);
    inv[resource] -= qty;
    store.saveInventory(c.id, inv, st.district_id);
  } else {
    if (!orbital.hasRoomFor(c.id, resource)) return fail('Orbital storage has no slot for that. Jettison a slot first.');
    const cost = Math.ceil(qty * price);
    if (c.credits < cost) return fail(`Not enough credits: ${cost} cr needed.`);
    credit(c.id, -cost);
  }
  const id = Number(db.prepare('INSERT INTO orbital_orders (colony_id, station_name, resource_id, side, price, qty, remaining, created_tick, expires_tick) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(c.id, st.name, resource, side, price, qty, qty, tick, tick + ttl).lastInsertRowid);
  match(resource, tick);
  return { ok: true, id };
}

function cancel(c, { orderId }) {
  const o = db.prepare("SELECT * FROM orbital_orders WHERE id = ? AND colony_id = ? AND status = 'open'").get(toInt(orderId), c.id);
  if (!o) return fail('No such open order.');
  release(o);
  db.prepare("UPDATE orbital_orders SET status = 'cancelled' WHERE id = ?").run(o.id);
  return { ok: true };
}

function view(c, tick) {
  // a station whose colony holds its independent charter (Headquarters) shows the charter's badge after its name
  const H = config.hq;
  const charteredNames = new Set(H ? db.prepare("SELECT s.name FROM stations s JOIN colony_hq h ON h.colony_id = s.colony_id WHERE h.stage = 'chartered'").all().map((x) => x.name) : []);
  const badged = (name) => (charteredNames.has(name) ? `${name} ${H.charter.badge}` : name);
  const book = (res, side) => db.prepare(`SELECT id, colony_id, station_name AS station, price, remaining AS qty FROM orbital_orders WHERE resource_id = ? AND side = ? AND status = 'open' ORDER BY price ${side === 'buy' ? 'DESC' : 'ASC'}, id ASC LIMIT 6`).all(res, side)
    .map((o) => ({ id: o.id, station: o.colony_id ? badged(o.station) : o.station, price: o.price, qty: o.qty, mine: o.colony_id === c.id, maker: !o.colony_id }));
  return {
    feeRate: M.feeRate, ttlOptions: M.ttlOptions, maxOpenOrders: M.maxOpenOrders, maxQty: M.maxQty, refreshTicks: M.makerRefreshTicks,
    nextRefresh: M.makerRefreshTicks - (tick % M.makerRefreshTicks),
    goods: goods().map((res) => ({ resource: res, reference: reference(res, tick), band: band(res, tick), bids: book(res, 'buy'), asks: book(res, 'sell'), orbitalOnly: !!config.resources[res].orbitalTrade })),
    orders: db.prepare("SELECT id, resource_id AS resource, side, price, qty, remaining, expires_tick FROM orbital_orders WHERE colony_id = ? AND status = 'open' ORDER BY id DESC").all(c.id)
      .map((o) => ({ ...o, ticksLeft: Math.max(0, o.expires_tick - tick) })),
    trades: db.prepare('SELECT tick, resource_id AS resource, price, qty, buyer, seller FROM orbital_trades ORDER BY id DESC LIMIT 20').all()
      .map((t) => ({ ...t, buyer: badged(t.buyer), seller: badged(t.seller) })),
  };
}

module.exports = { advance, post, cancel, match, view, tradeable, goods, reference, band, MAKER };
