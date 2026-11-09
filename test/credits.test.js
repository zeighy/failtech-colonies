'use strict';
// Credit sinks and the soft limit on heavy buying: the brokerage surcharge and rush orders.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-credits-'));
process.env.DB_PATH = path.join(dir, 'credits.db');
process.env.SESSION_SECRET = 'x';
process.env.THEME = 'basic';
process.env.HAZARDS = 'off';
const store = require('../src/db');
const engine = require('../src/engine');
const actions = require('../src/actions');
const credits = require('../src/credits');
const { viewFor } = require('../src/state');
const { db, config } = store;
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let n = 0;
function colony(hub = 5) {
  const uid = Number(db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(`cr${++n}`, 'x').lastInsertRowid);
  const id = store.ensureColony(uid);
  db.prepare('UPDATE colonies SET hub_level = ?, credits = 1000000 WHERE id = ?').run(hub, id);
  return { uid, id, core: store.coreId(id) };
}
const now = () => Number(store.getMeta('global_tick', 0));
const creditsOf = (id) => db.prepare('SELECT credits FROM colonies WHERE id = ?').get(id).credits;

test('brokerage: a daily allowance of buying is free, then a surcharge rises in steps, and old spending ages out', () => {
  const c = colony(5);
  const A = credits.allowance(5), tiers = config.credits.brokerage.tiers;
  assert.equal(A, config.credits.brokerage.allowancePerHubLevel * 5);
  const t = now() + 10;
  assert.equal(credits.brokerageRate(c.id, t), 0);
  credits.record(c.id, 'buy', t, A * 0.9);
  assert.equal(credits.brokerageRate(c.id, t), 0, 'under the allowance nothing is added');
  credits.record(c.id, 'buy', t, A * 0.1);
  assert.equal(credits.brokerageRate(c.id, t), tiers[0].rate, 'at the allowance the first step applies');
  credits.record(c.id, 'buy', t, A * 3);
  assert.equal(credits.brokerageRate(c.id, t), tiers[2].rate, 'a heavy buyer pays the top step');
  assert.equal(credits.brokerageRate(c.id, t + config.credits.windowTicks + 1), 0, 'and it ages out of the window');
  // a purchase takes its surcharge from the treasury, never below zero, and is counted
  db.prepare('UPDATE colonies SET credits = 100 WHERE id = ?').run(c.id);
  const extra = credits.chargeBuy(c.id, t, 1000);
  assert.equal(extra, 100, 'the surcharge is capped at what the colony has');
  assert.equal(creditsOf(c.id), 0);
  // a normal colony is never touched
  const d = colony(5);
  assert.equal(credits.chargeBuy(d.id, t, 10000), 0);
  assert.equal(creditsOf(d.id), 1000000);
});

test('the surcharge reaches an express convoy purchase', () => {
  const c = colony(5);
  const t = now();
  const X = config.global.express;
  const buy = { scrap: 10 };
  const before = creditsOf(c.id);
  assert.deepEqual(actions.expressTrip(c.uid, { buy }), { ok: true });
  const plain = before - creditsOf(c.id);
  db.prepare('DELETE FROM colony_express WHERE colony_id = ?').run(c.id);
  db.prepare('UPDATE colonies SET express_ready_tick = 0, credits = 1000000 WHERE id = ?').run(c.id);
  credits.record(c.id, 'buy', t, credits.allowance(5) * 5); // a heavy buyer
  const rate = credits.brokerageRate(c.id, t);
  assert.ok(rate > 0);
  assert.deepEqual(actions.expressTrip(c.uid, { buy }), { ok: true });
  const heavy = 1000000 - creditsOf(c.id);
  assert.ok(heavy > plain, `a heavy buyer pays more for the same goods (${heavy} against ${plain})`);
  assert.ok(X);
});

test('rush: a work order can be finished for credits, and each rush in the day costs more', () => {
  const c = colony(5);
  const inv = store.loadInventory(c.id, c.core);
  for (const r of Object.keys(config.resources)) inv[r] = 5000;
  store.saveInventory(c.id, inv, c.core);
  assert.deepEqual(actions.build(c.uid, { ring: 1, slot: 0, type: 'solar_array' }), { ok: true });
  assert.deepEqual(actions.build(c.uid, { ring: 1, slot: 1, type: 'solar_array' }), { ok: true });
  const orders = store.loadOrders(c.id);
  assert.equal(orders.length, 2);
  // the view carries the price
  const v = viewFor(c.uid).views[c.core].orders;
  const first = orders[0], per = config.credits.rush.perTick.build;
  assert.equal(v.find((o) => o.id === first.id).rush, Math.round((first.ticks_remaining - 1) * per), 'the first rush is the base price');
  const cr0 = creditsOf(c.id);
  assert.deepEqual(actions.rushOrder(c.uid, { orderId: first.id }), { ok: true });
  assert.equal(cr0 - creditsOf(c.id), Math.round((first.ticks_remaining - 1) * per));
  assert.equal(store.loadOrders(c.id).find((o) => o.id === first.id).ticks_remaining, 1);
  assert.match(actions.rushOrder(c.uid, { orderId: first.id }).error, /already finishing/);
  // the second costs more
  const second = orders[1], base = Math.round((second.ticks_remaining - 1) * per);
  const quoted = viewFor(c.uid).views[c.core].orders.find((o) => o.id === second.id).rush;
  assert.equal(quoted, Math.round(base * (1 + config.credits.rush.surgePerRush)), 'one rush in the day raises the next price');
  db.prepare('UPDATE colonies SET credits = 5 WHERE id = ?').run(c.id);
  assert.match(actions.rushOrder(c.uid, { orderId: second.id }).error, /costs/);
  assert.match(actions.rushOrder(c.uid, { orderId: 999999 }).error, /no longer exists/);
  db.prepare('UPDATE colonies SET credits = 1000000 WHERE id = ?').run(c.id);
  engine.processTick();
  assert.ok(store.loadBuildings(c.id, c.core).some((b) => b.ring === 1 && b.slot === 0 && b.type === 'solar_array'), 'the rushed building is finished on the next tick');
});
