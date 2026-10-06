'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-exp-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.SESSION_SECRET = 'test-secret';
process.env.HAZARDS = 'off';

const engine = require('../src/engine');
const store = require('../src/db');
const actions = require('../src/actions');
const sim = require('../src/sim');
const { viewFor } = require('../src/state');
const { db, config } = store;
const X = config.global.express;

test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let n = 0;
function newColony(credits = 5000) {
  const uid = Number(db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(`x${++n}`, 'x').lastInsertRowid);
  const id = store.ensureColony(uid);
  db.prepare('UPDATE colonies SET credits = ? WHERE id = ?').run(credits, id);
  for (const r of ['clean_water', 'rations']) db.prepare('UPDATE colony_inventory SET amount = 1500 WHERE colony_id = ? AND resource_id = ?').run(id, r);
  return { uid, id };
}
const tick = (k = 1) => { for (let i = 0; i < k; i++) engine.processTick(); };
const stock = (id, r) => store.loadInventory(id)[r];
const credits = (id) => db.prepare('SELECT credits FROM colonies WHERE id = ?').get(id).credits;
const events = (id) => db.prepare('SELECT message FROM colony_events WHERE colony_id = ? ORDER BY id').all(id).map((e) => e.message);

test('dispatch holds goods and money immediately, then delivers after the travel time', () => {
  const { uid, id } = newColony();
  const before = { credits: credits(id), scrap: stock(id, 'scrap'), parts: stock(id, 'machined_parts') };
  const v0 = viewFor(uid);
  const pr = v0.express.prices;
  const r = actions.expressTrip(uid, { sell: { scrap: 100 }, buy: { machined_parts: 20 } });
  assert.deepEqual(r, { ok: true });
  const cost = Math.round(20 * pr.machined_parts.buy);
  const fee = sim.expressFee(config, 1);
  assert.equal(credits(id), before.credits - cost - fee, 'goods cost and fee are taken now');
  assert.equal(stock(id, 'scrap'), before.scrap - 100, 'sold goods leave now');
  assert.equal(stock(id, 'machined_parts'), before.parts, 'nothing delivered yet');
  const v1 = viewFor(uid);
  assert.equal(v1.express.active.ticksLeft, X.travelTicks);
  tick(X.travelTicks - 1);
  assert.equal(stock(id, 'machined_parts'), before.parts);
  tick(1);
  assert.equal(stock(id, 'machined_parts'), before.parts + 20, 'delivered');
  const pay = Math.round(100 * pr.scrap.sell);
  assert.ok(credits(id) >= before.credits - cost - fee + pay - 1, 'sale paid on arrival');
  assert.ok(events(id).some((m) => /express convoy arrived/i.test(m)));
  assert.equal(viewFor(uid).express.active, null);
});

test('only one trip at a time, then a cooldown', () => {
  const { uid } = newColony();
  assert.equal(actions.expressTrip(uid, { buy: { machined_parts: 5 } }).ok, true);
  assert.match(actions.expressTrip(uid, { buy: { machined_parts: 5 } }).error, /already on its way/);
  tick(X.travelTicks);
  const cd = actions.expressTrip(uid, { buy: { machined_parts: 5 } });
  assert.equal(cd.ok, false);
  assert.match(cd.error, /more ticks/);
  assert.equal(viewFor(uid).express.readyIn, X.cooldownTicks);
  tick(X.cooldownTicks);
  assert.equal(actions.expressTrip(uid, { buy: { machined_parts: 5 } }).ok, true);
});

test('validation: limits, stock, funds, unknown resources, empty orders', () => {
  const { uid, id } = newColony(300);
  const lim = Math.floor(sim.convoyLimit(config, 1, 'scrap') * X.limitFraction);
  assert.match(actions.expressTrip(uid, { buy: { scrap: lim + 1 } }).error, /at most/);
  assert.match(actions.expressTrip(uid, { sell: { alloys: 5 } }).error, /Not enough Alloys/);
  assert.match(actions.expressTrip(uid, { buy: { machined_parts: 100 } }).error, /Not enough credits/);
  assert.match(actions.expressTrip(uid, { buy: { gold: 5 } }).error, /Unknown resource/);
  assert.match(actions.expressTrip(uid, {}).error, /Nothing to send/);
  assert.match(actions.expressTrip(uid, { buy: { machined_parts: 0 } }).error, /Nothing to send/);
  assert.equal(credits(id), 300, 'failed attempts cost nothing');
  assert.equal(store.loadExpress(id), null);
});

test('express prices are worse than the scheduled convoy, and caps scale with hub level', () => {
  const { uid, id } = newColony();
  const v = viewFor(uid);
  for (const [res, p] of Object.entries(v.market.prices)) {
    assert.ok(v.express.prices[res].buy >= p.buy, `${res} buys cost more`);
    assert.ok(v.express.prices[res].sell <= p.sell, `${res} sells pay less`);
  }
  assert.equal(v.express.limits.scrap, Math.floor(v.market.limits.scrap * X.limitFraction));
  db.prepare('UPDATE colonies SET hub_level = 4 WHERE id = ?').run(id);
  const hi = viewFor(uid);
  assert.ok(hi.express.limits.scrap > v.express.limits.scrap);
  assert.ok(hi.express.fee > v.express.fee, 'the fee grows with hub level');
});

test('if storage is full on arrival, the undelivered share is refunded', () => {
  const { uid, id } = newColony();
  db.prepare("UPDATE colony_inventory SET amount = 1990 WHERE colony_id = ? AND resource_id = 'scrap'").run(id);
  const pr = viewFor(uid).express.prices.scrap;
  const c0 = credits(id);
  assert.equal(actions.expressTrip(uid, { buy: { scrap: 100 } }).ok, true);
  const fee = sim.expressFee(config, 1);
  assert.equal(c0 - credits(id), Math.round(100 * pr.buy) + fee);
  tick(X.travelTicks);
  assert.ok(stock(id, 'scrap') <= 2000, 'capped at storage');
  // 10 of 100 delivered (cap 2000): the other 90% of the goods cost comes back
  const spent = c0 - credits(id);
  assert.ok(spent < Math.round(100 * pr.buy) + fee, `refund applied (spent ${spent})`);
});

test('a collapsed colony cannot dispatch', () => {
  const { uid, id } = newColony();
  db.prepare("UPDATE colonies SET status = 'failed' WHERE id = ?").run(id);
  assert.match(actions.expressTrip(uid, { buy: { machined_parts: 5 } }).error, /abandoned/);
});
