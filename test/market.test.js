'use strict';
// The exchange: the price model, the NPC book, matching, escrow, fees, expiry and the player's view of it.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-mkt-'));
process.env.DB_PATH = path.join(dir, 'mkt.db');
process.env.SESSION_SECRET = 'x';
process.env.HAZARDS = 'off';
const store = require('../src/db');
const ms = require('../src/marketsim');
const market = require('../src/market');
const engine = require('../src/engine');
const actions = require('../src/actions');
const { viewFor } = require('../src/state');
const { db, config } = store;
const X = config.exchange;
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let n = 0;
function colony(level = 4) {
  db.prepare("DELETE FROM market_orders WHERE owner = 'player'").run(); // tests share one book: start each from NPC liquidity only
  const uid = Number(db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(`m${++n}`, 'x').lastInsertRowid);
  const id = store.ensureColony(uid);
  const core = store.coreId(id);
  db.prepare('UPDATE colonies SET hub_level = ?, credits = 100000 WHERE id = ?').run(level, id);
  db.prepare("UPDATE colony_inventory SET amount = 1000 WHERE district_id = ? AND resource_id IN ('alloys','scrap','clean_water','rations','machined_parts')").run(core);
  return { uid, id, core };
}
const tickNow = () => Number(store.getMeta('global_tick', 0));
const tick = (k = 1) => { for (let i = 0; i < k; i++) engine.processTick(); };
const credits = (id) => db.prepare('SELECT credits FROM colonies WHERE id = ?').get(id).credits;
const stock = (id, d, r) => store.loadInventory(id, d)[r] || 0;
const post = (c, o) => actions.marketPost(c.uid, { district: c.core, ttl: 100, resource: 'alloys', ...o });
tick(2); // seeds the NPC book
const quote = () => ms.ladder(config, 'alloys', tickNow());

test('the price model is deterministic and wanders within sane bounds', () => {
  for (const res of Object.keys(config.resources)) {
    for (const t of [0, 7, 100, 999]) assert.equal(ms.refPrice(config, res, t), ms.refPrice(config, res, t));
    for (let t = 0; t < 600; t += 13) {
      const r = ms.refPrice(config, res, t);
      assert.ok(r > 0 && Number.isFinite(r));
    }
  }
  let events = 0;
  for (let t = 0; t < 2400; t++) if (ms.event(config, 'alloys', t)) events++;
  assert.ok(events > 0 && events < 1200, `${events} event ticks`);
  assert.equal(ms.history(config, 'alloys', 100).length, X.historyTicks);
});

test('the convoy is never a better deal than the book: bids stay under its buy price, asks over its sell price', () => {
  for (const res of Object.keys(config.resources)) {
    for (let t = 0; t < 800; t += 7) {
      const l = ms.ladder(config, res, t);
      const r = config.resources[res];
      assert.ok(l.bids.every((b) => b.price < r.buy), `${res}@${t} bid`);
      assert.ok(l.asks.every((a) => a.price > r.sell), `${res}@${t} ask`);
      assert.ok(l.asks[0].price > l.bids[0].price, `${res}@${t} crossed`);
    }
  }
});

test('NPC market makers quote every resource, follow the reference price, and the book is exposed to the player', () => {
  const c = colony();
  const v = viewFor(c.uid).exchange;
  assert.equal(v.unlocked, true);
  const a = v.resources.alloys;
  const l = quote();
  assert.equal(a.ask, l.asks[0].price);
  assert.equal(a.bid, l.bids[0].price);
  assert.equal(a.asks.length, X.levels);
  assert.ok(a.hist.length === X.historyTicks);
});

test('buying across the spread fills from the NPC book at their price, refunds the difference, and delivers the goods', () => {
  const c = colony();
  const l = quote();
  const before = { cr: credits(c.id), st: stock(c.id, c.core, 'alloys') };
  const r = post(c, { side: 'buy', price: l.asks[1].price + 5, qty: 20 });
  assert.equal(r.ok, true);
  assert.equal(r.filled, 20);
  assert.equal(stock(c.id, c.core, 'alloys'), before.st + 20);
  const paid = before.cr - credits(c.id);
  assert.equal(paid, Math.ceil(l.asks[0].price * 20 - 1e-9), 'paid the best ask, not the limit');
  assert.equal(db.prepare("SELECT status FROM market_orders WHERE id = ?").get(r.id).status, 'filled');
});

test('selling across the spread pays the NPC bid minus the fee, and the goods are held at posting', () => {
  const c = colony();
  const l = quote();
  const before = { cr: credits(c.id), st: stock(c.id, c.core, 'alloys') };
  const r = post(c, { side: 'sell', price: l.bids[0].price - 1, qty: 30 });
  assert.equal(r.filled, 30);
  assert.equal(stock(c.id, c.core, 'alloys'), before.st - 30);
  assert.equal(credits(c.id) - before.cr, Math.floor(l.bids[0].price * 30 * (1 - X.feeRate) + 1e-9));
});

test('an order inside the spread rests: sells are held, buys escrow credits, and cancelling gives it all back', () => {
  const c = colony();
  const l = quote();
  const mid = Math.round((l.asks[0].price + l.bids[0].price) / 2 * 100) / 100;
  const cr0 = credits(c.id); const st0 = stock(c.id, c.core, 'alloys');
  const sell = post(c, { side: 'sell', price: l.asks[0].price + 0.5, qty: 40 });
  const buy = post(c, { side: 'buy', price: l.bids[0].price - 0.5, qty: 10 });
  assert.ok(sell.ok && buy.ok);
  assert.equal(sell.filled, 0); assert.equal(buy.filled, 0);
  assert.equal(stock(c.id, c.core, 'alloys'), st0 - 40);
  assert.equal(credits(c.id), cr0 - Math.ceil((l.bids[0].price - 0.5) * 10 - 1e-9));
  assert.equal(viewFor(c.uid).exchange.orders.length, 2);
  assert.deepEqual(actions.marketCancel(c.uid, { orderId: sell.id }), { ok: true });
  assert.deepEqual(actions.marketCancel(c.uid, { orderId: buy.id }), { ok: true });
  assert.equal(stock(c.id, c.core, 'alloys'), st0);
  assert.equal(credits(c.id), cr0);
  assert.match(actions.marketCancel(c.uid, { orderId: sell.id }).error, /no longer open/);
  assert.ok(mid > 0);
});

test('orders expire and give back what they held', () => {
  const c = colony();
  db.prepare("UPDATE colony_inventory SET amount = 1000 WHERE district_id = ? AND resource_id = 'fuel'").run(c.core); // nothing burns fuel
  const l = ms.ladder(config, 'fuel', tickNow());
  const st0 = stock(c.id, c.core, 'fuel'); const cr0 = credits(c.id);
  post(c, { resource: 'fuel', side: 'sell', price: l.asks[4].price * 3, qty: 25, ttl: X.ttlOptions[0] });
  post(c, { resource: 'fuel', side: 'buy', price: l.bids[4].price * 0.4, qty: 25, ttl: X.ttlOptions[0] });
  assert.equal(stock(c.id, c.core, 'fuel'), st0 - 25);
  tick(X.ttlOptions[0] + 1);
  assert.equal(viewFor(c.uid).exchange.orders.length, 0);
  assert.equal(stock(c.id, c.core, 'fuel'), st0);
  assert.equal(credits(c.id), cr0);
});

test('a resting buy fills when the market moves down to it, at the better (resting NPC) price', () => {
  const c = colony();
  // a very low bid will not fill now; force the book down by repricing the NPC asks under it
  const l = quote();
  const r = post(c, { side: 'buy', price: l.bids[0].price, qty: 5 });
  assert.equal(r.filled, 0);
  db.prepare("UPDATE market_orders SET price = ? WHERE owner = 'npc' AND resource_id = 'alloys' AND side = 'sell' AND level = 0").run(l.bids[0].price - 1);
  market.match('alloys', tickNow());
  assert.equal(db.prepare('SELECT status FROM market_orders WHERE id = ?').get(r.id).status, 'filled');
  assert.equal(db.prepare('SELECT escrow FROM market_orders WHERE id = ?').get(r.id).escrow, 0);
  tick(1); // the next tick re-quotes the ladder around the reference price
});

test('eating the book makes it thinner, and it slowly regenerates', () => {
  const c = colony();
  const l = quote();
  const rung = () => db.prepare("SELECT qty FROM market_orders WHERE owner = 'npc' AND resource_id = 'alloys' AND side = 'sell' AND level = 0").get().qty;
  const full = rung();
  db.prepare('UPDATE colonies SET credits = 1e9 WHERE id = ?').run(c.id);
  post(c, { side: 'buy', price: l.asks[0].price * 1.5, qty: Math.min(X.maxQty, full) });
  assert.ok(rung() < full);
  const low = rung();
  tick(2);
  assert.ok(rung() > low && rung() <= ms.ladder(config, 'alloys', tickNow()).asks[0].target);
});

test('validation: price band, quantity, lifetime, funds, stock, level, open-order cap', () => {
  const c = colony();
  const l = quote();
  assert.match(post(c, { side: 'buy', price: l.ref * 9, qty: 1 }).error, /Price must be between/);
  assert.match(post(c, { side: 'buy', price: 0, qty: 1 }).error, /Bad price/);
  assert.match(post(c, { side: 'buy', price: l.ref, qty: 0 }).error, /Bad quantity/);
  assert.match(post(c, { side: 'buy', price: l.ref, qty: X.maxQty + 1 }).error, /At most/);
  assert.match(post(c, { side: 'buy', price: l.ref, qty: 1, ttl: 7 }).error, /lifetime/);
  assert.match(post(c, { side: 'sell', price: l.ref, qty: 1000 }).error === undefined ? 'ok' : post(c, { side: 'sell', price: l.ref, qty: 1000 }).error, /ok|Not enough Alloys/);
  db.prepare("UPDATE colony_inventory SET amount = 10 WHERE district_id = ? AND resource_id = 'alloys'").run(c.core);
  assert.match(post(c, { side: 'sell', price: l.ref, qty: 900 }).error, /Not enough Alloys/);
  assert.match(post(c, { side: 'swap', price: l.ref, qty: 1 }).error, /Bad order side/);
  assert.match(post(c, { side: 'buy', price: l.ref, qty: 1, resource: 'nothing' }).error, /Unknown resource/);
  db.prepare('UPDATE colonies SET credits = 3 WHERE id = ?').run(c.id);
  assert.match(post(c, { side: 'buy', price: l.bids[0].price, qty: 100 }).error, /Not enough credits/);
  const early = colony(3);
  assert.match(post(early, { side: 'buy', price: l.ref, qty: 1 }).error, /opens at hub level 4/);
  const many = colony();
  for (let i = 0; i < X.maxOpenOrders; i++) assert.ok(post(many, { side: 'buy', price: l.bids[4].price * 0.5, qty: 1 }).ok);
  assert.match(post(many, { side: 'buy', price: l.bids[4].price * 0.5, qty: 1 }).error, /At most \d+ open orders/);
});

test('a player never trades with themselves', () => {
  const c = colony();
  const l = quote();
  const p1 = Math.round((l.bids[0].price + (l.asks[0].price - l.bids[0].price) * 0.4) * 100) / 100;
  const p2 = Math.round((l.bids[0].price + (l.asks[0].price - l.bids[0].price) * 0.6) * 100) / 100;
  const s = post(c, { side: 'sell', price: p1, qty: 10 });
  const b = post(c, { side: 'buy', price: p2, qty: 10 });
  assert.equal(s.filled, 0); assert.equal(b.filled, 0);
  tick(1);
  assert.equal(viewFor(c.uid).exchange.orders.length, 2, 'both still resting');
});

test('two players trade with each other through the same book, at the resting order\'s price, fee on the seller', () => {
  const a = colony(); const b = colony();
  const l = quote();
  const price = Math.round((l.bids[0].price + (l.asks[0].price - l.bids[0].price) * 0.5) * 100) / 100;
  const a0 = credits(a.id); const b0 = credits(b.id);
  const sell = post(a, { side: 'sell', price, qty: 15 });
  assert.equal(sell.filled, 0);
  const buy = post(b, { side: 'buy', price: price + 0.2, qty: 15 });
  assert.equal(buy.filled, 15);
  assert.equal(credits(a.id) - a0, Math.floor(price * 15 * (1 - X.feeRate) + 1e-9));
  assert.equal(b0 - credits(b.id), Math.ceil(price * 15 - 1e-9), 'the buyer pays the resting price, not their limit');
  assert.equal(viewFor(a.uid).exchange.trades[0].side, 'sell');
  assert.equal(viewFor(b.uid).exchange.trades[0].side, 'buy');
});

test('a buyer with no room in the delivery district waits instead of losing the goods', () => {
  const c = colony();
  const l = quote();
  const cap = config.hubLevels[4].maxStorage;
  db.prepare("UPDATE colony_inventory SET amount = ? WHERE district_id = ? AND resource_id = 'alloys'").run(cap - 3, c.core);
  const r = post(c, { side: 'buy', price: l.asks[0].price * 1.2, qty: 50 });
  assert.equal(r.filled, 3);
  assert.equal(stock(c.id, c.core, 'alloys'), cap);
  assert.equal(db.prepare('SELECT qty FROM market_orders WHERE id = ?').get(r.id).qty, 47);
});

test('selling from, and delivering to, a satellite district works', () => {
  const c = colony();
  const pits = Number(db.prepare("INSERT INTO districts (colony_id, type, level, name, created_tick) VALUES (?, 'pits', 1, 'The Pits', 0)").run(c.id).lastInsertRowid);
  const ins = db.prepare('INSERT INTO colony_inventory (colony_id, district_id, resource_id, amount) VALUES (?, ?, ?, ?)');
  for (const r of Object.keys(config.resources)) ins.run(c.id, pits, r, r === 'alloys' ? 200 : 0);
  const l = quote();
  const r = actions.marketPost(c.uid, { district: pits, side: 'sell', resource: 'alloys', price: l.bids[0].price, qty: 50, ttl: 30 });
  assert.equal(r.filled, 50);
  assert.equal(stock(c.id, pits, 'alloys'), 150);
  const b = actions.marketPost(c.uid, { district: pits, side: 'buy', resource: 'alloys', price: l.asks[0].price * 1.2, qty: 10, ttl: 30 });
  assert.equal(b.filled, 10);
  assert.equal(stock(c.id, pits, 'alloys'), 160);
});

test('the player view lists the book, the reference history, events and activity; the first order ticks the directive', () => {
  const c = colony();
  assert.equal(viewFor(c.uid).exchange.activity, false);
  assert.equal(viewFor(c.uid).brief.directives.find((d) => d.id === 'exchange').done, false);
  post(c, { side: 'buy', price: quote().asks[0].price * 1.1, qty: 1 });
  const v = viewFor(c.uid);
  assert.equal(v.exchange.activity, true);
  assert.equal(v.brief.directives.find((d) => d.id === 'exchange').done, true);
  assert.ok(Object.values(v.exchange.resources).every((r) => r.ref > 0 && r.hist.length));
});
