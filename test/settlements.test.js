'use strict';
// Settlements: camps that answer the Beacon, sponsored with a steady basket and with drives, and what they give back.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-settle-'));
process.env.DB_PATH = path.join(dir, 'settle.db');
process.env.SESSION_SECRET = 'x';
process.env.THEME = 'basic';
process.env.HAZARDS = 'off';
const store = require('../src/db');
const engine = require('../src/engine');
const actions = require('../src/actions');
const settlements = require('../src/settlements');
const sim = require('../src/sim');
const { viewFor, clientConfig } = require('../src/state');
const { db, config } = store;
const S = config.settlements;
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const tick = (k = 1) => { for (let i = 0; i < k; i++) engine.processTick(); };
const now = () => Number(store.getMeta('global_tick', 0));
let n = 0;
// A Core at level 5 that has transmitted, with plenty of everything and nobody to feed it to.
function colony({ won = true, amount = 8000 } = {}) {
  const uid = Number(db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(`s${++n}`, 'x').lastInsertRowid);
  const id = store.ensureColony(uid);
  const core = store.coreId(id);
  db.prepare('UPDATE colonies SET hub_level = 5, credits = 100000, won = ?, population = 20 WHERE id = ?').run(won ? 1 : 0, id);
  const inv = {}; for (const r of Object.keys(config.resources)) inv[r] = config.resources[r].orbitalOnly ? 0 : amount;
  store.saveInventory(id, inv, core);
  return { uid, id, core };
}
const row = (c) => db.prepare('SELECT * FROM colonies WHERE id = ?').get(c.id);
const stock = (c, r) => store.loadInventory(c.id, c.core)[r] || 0;
const setStock = (c, r, a) => db.prepare('UPDATE colony_inventory SET amount = ? WHERE district_id = ? AND resource_id = ?').run(a, c.core, r);
const standing = (c, f) => (db.prepare('SELECT points FROM standing WHERE colony_id = ? AND faction = ?').get(c.id, f) || { points: 0 }).points;
// A sponsored settlement of a chosen kind, without waiting for one to be on offer.
// (effects are remembered for the tick; rows written behind the module's back have to say so)
function sponsored(c, type, { stage = 1, trait = 'steady', level = 0 } = {}) {
  settlements.forget();
  return Number(db.prepare("INSERT INTO settlements (colony_id, type, trait, name, status, stage, level, commitment, created_tick, started_tick, next_appeal) VALUES (?, ?, ?, ?, 'active', ?, ?, 2, ?, ?, ?)")
    .run(c.id, type, trait, `${type} ${++n}`, stage, level, now(), now(), now() + 100000).lastInsertRowid);
}
const get = (id) => db.prepare('SELECT * FROM settlements WHERE id = ?').get(id);
const poke = (sql, ...args) => { db.prepare(sql).run(...args); settlements.forget(); };
const fx = (c) => settlements.effects(c.id, now());

test('camps answer the Beacon: nothing before it, then a choice of kinds; one slot, more with the Free Port and the station', () => {
  const quiet = colony({ won: false });
  tick(2);
  assert.equal(viewFor(quiet.uid).settlements.unlocked, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM settlements WHERE colony_id = ?').get(quiet.id).n, 0);
  const c = colony();
  tick(1);
  const v = viewFor(c.uid).settlements;
  assert.equal(v.unlocked, true);
  assert.equal(v.slots, 1);
  assert.equal(v.offers.length, S.offers);
  assert.equal(new Set(v.offers.map((o) => o.type)).size, Math.min(S.offers, Object.keys(S.types).length), 'the kinds on offer differ');
  for (const o of v.offers) { assert.ok(S.types[o.type] && S.traits[o.trait] && o.ticksLeft > 0 && Object.keys(o.basket).length); }
  assert.deepEqual(actions.settlementSponsor(c.uid, { id: v.offers[0].id }), { ok: true });
  assert.match(actions.settlementSponsor(c.uid, { id: v.offers[1].id }).error, /all the settlements it can/);
  db.prepare("INSERT INTO districts (colony_id, type, level, name, created_tick) VALUES (?, 'freeport', 1, 'Free Port', 0)").run(c.id);
  assert.equal(viewFor(c.uid).settlements.slots, 2);
  assert.deepEqual(actions.settlementSponsor(c.uid, { id: v.offers[1].id }), { ok: true });
  // the camps taken are replaced, and an offer that runs out is replaced too
  tick(5);
  assert.equal(viewFor(c.uid).settlements.offers.length, S.offers);
  db.prepare("UPDATE settlements SET expires_tick = ? WHERE colony_id = ? AND status = 'offer'").run(now(), c.id);
  tick(5);
  const again = viewFor(c.uid).settlements.offers;
  assert.equal(again.length, S.offers);
  assert.ok(again.every((o) => o.ticksLeft > 0));
  assert.match(actions.settlementSponsor(c.uid, { id: 999999 }).error, /no longer asking/);
});

test('steady support: the basket leaves the Core every tick, never below the reserve; the level follows what was really sent', () => {
  const c = colony();
  const id = sponsored(c, 'foundry');
  const basket = settlements.basketOf(get(id));
  const before = Object.fromEntries(Object.keys(basket).map((r) => [r, stock(c, r)]));
  tick(1);
  for (const [r, q] of Object.entries(basket)) assert.ok(Math.abs(before[r] - stock(c, r) - q) < 3, `${r}: ${before[r] - stock(c, r)} of ${q} a tick`);
  for (let k = 0; k < 4; k++) { for (const r of Object.keys(basket)) setStock(c, r, 8000); tick(S.smoothTicks); }
  assert.ok(get(id).level > 0.95, `full support brings the level up (${get(id).level})`);
  assert.ok(standing(c, S.types.foundry.faction) >= 1, 'and standing with its faction trickles in');
  // half support settles at a half
  for (const r of Object.keys(basket)) setStock(c, r, 8000);
  assert.deepEqual(actions.settlementCommit(c.uid, { id, level: 1 }), { ok: true });
  tick(S.smoothTicks * 5);
  assert.ok(Math.abs(get(id).level - 0.5) < 0.05, `half support, half level (${get(id).level})`);
  // nothing is taken below the reserve: with scrap at the reserve, scrap stops and the level drops with it
  actions.settlementCommit(c.uid, { id, level: 2 });
  const cap = viewFor(c.uid).resources.scrap.cap;
  setStock(c, 'scrap', Math.floor(cap * row(c).settle_reserve));
  const scrap = stock(c, 'scrap');
  tick(1);
  assert.ok(stock(c, 'scrap') >= scrap - 0.001, 'scrap at the reserve is left alone');
  assert.match(actions.settlementReserve(c.uid, { reserve: 2 }).error, /0 to 90%/);
  assert.deepEqual(actions.settlementReserve(c.uid, { reserve: 0.1 }), { ok: true });
  tick(1);
  assert.ok(stock(c, 'scrap') < scrap, 'a lower reserve frees it');
  // off: nothing leaves, and the level drains away
  actions.settlementCommit(c.uid, { id, level: 0 });
  const fuel = stock(c, 'fuel'); // (nothing else in this Core uses fuel)
  tick(S.smoothTicks * 6);
  assert.equal(stock(c, 'fuel'), fuel);
  assert.ok(get(id).level < 0.05);
  // the view shows the draw in the Core's rates
  actions.settlementCommit(c.uid, { id, level: 2 });
  const v = viewFor(c.uid);
  assert.ok(v.resources.machined_parts.aid > 0 && v.resources.machined_parts.net < 0);
});

test('a valley settlement sends commuters: hands, not mouths', () => {
  const c = colony();
  const base = viewFor(c.uid).colony.staffing.workforce;
  const id = sponsored(c, 'valley', { stage: 3, level: 1 });
  const hands = Math.floor(settlements.benefitAt(get(id)));
  assert.equal(fx(c).hands, hands);
  const v = viewFor(c.uid).colony;
  assert.equal(v.staffing.commuters, hands);
  assert.ok(Math.abs(v.staffing.workforce - base - hands) < 1e-9);
  assert.equal(v.population, row(c).population, 'the population is what it was');
  // at half the level, half the hands
  poke('UPDATE settlements SET level = 0.5 WHERE id = ?', id);
  assert.ok(Math.abs(fx(c).hands - hands / 2) <= 1);
});

test('a foundry town makes upgrades cheaper; an order refunds what it paid, not what it would cost now', () => {
  const c = colony();
  db.prepare('UPDATE colonies SET hub_level = 4 WHERE id = ?').run(c.id);
  const id = sponsored(c, 'foundry', { stage: 5, level: 1 });
  const d = fx(c).discount;
  assert.ok(d > 0.1 && d <= S.discountCap);
  const full = config.hubLevels[5].upgradeCost;
  const scrap = stock(c, 'scrap');
  assert.deepEqual(actions.upgradeHub(c.uid, {}), { ok: true });
  const paid = Math.ceil(full.scrap * (1 - d) - 1e-9);
  assert.equal(scrap - stock(c, 'scrap'), paid, 'the upgrade cost less');
  assert.equal(viewFor(c.uid).views[c.core].orders[0].cost.scrap, paid);
  // the settlement is dropped while the upgrade is under way: cancelling gives back what was paid
  assert.deepEqual(actions.settlementDrop(c.uid, { id }), { ok: true });
  assert.equal(fx(c).discount, 0);
  const o = store.loadOrders(c.id, c.core)[0];
  assert.deepEqual(actions.cancelOrder(c.uid, { orderId: o.id }), { ok: true });
  assert.equal(stock(c, 'scrap'), scrap, 'not a unit more than it paid');
  // several towns add up, to a cap
  for (let i = 0; i < 4; i++) sponsored(c, 'foundry', { stage: 5, level: 1 });
  assert.equal(fx(c).discount, S.discountCap);
});

test('a rail depot widens the links and the convoy; when it stops, routes over the link are slowed, not broken', () => {
  const c = colony();
  db.prepare('UPDATE colonies SET hub_level = 5 WHERE id = ?').run(c.id);
  const pits = Number(db.prepare("INSERT INTO districts (colony_id, type, level, name, created_tick) VALUES (?, 'pits', 2, 'pits', 0)").run(c.id).lastInsertRowid);
  const inv = {}; for (const r of Object.keys(config.resources)) inv[r] = 0;
  store.saveInventory(c.id, inv, pits);
  const base = config.logistics.link.levels[1].capacity;
  const limit0 = viewFor(c.uid).market.limits.scrap;
  assert.match(actions.setRoute(c.uid, { from: c.core, to: pits, resource: 'scrap', rate: base + 4 }).error, /Upgrade the link/);
  const id = sponsored(c, 'depot', { stage: 5, level: 1 });
  const bonus = fx(c).logistics;
  assert.ok(bonus >= 0.2);
  const v = viewFor(c.uid);
  assert.equal(v.districts.find((d) => d.id === pits).link.capacity, Math.floor(base * (1 + bonus)));
  assert.equal(v.market.limits.scrap, Math.floor(sim.convoyLimit(config, 5, 'scrap') * (1 + bonus)));
  assert.ok(v.market.limits.scrap > limit0);
  assert.deepEqual(actions.setRoute(c.uid, { from: c.core, to: pits, resource: 'scrap', rate: base + 4 }), { ok: true });
  tick(1);
  assert.equal(store.loadInventory(c.id, pits).scrap, base + 4, 'the wider link carries it');
  // the depot is dropped: the route stays, and runs at what the link carries
  actions.settlementDrop(c.uid, { id });
  const had = store.loadInventory(c.id, pits).scrap;
  tick(1);
  assert.equal(store.loadInventory(c.id, pits).scrap - had, base);
  assert.equal(store.loadRoutes(c.id)[0].rate, base + 4, 'the route itself is as the player set it');
  const shown = viewFor(c.uid).routes[0];
  assert.equal(shown.rate, base + 4, 'and is shown at that rate');
  assert.equal(shown.slowed, base);
  assert.equal(shown.limit, 'link');
  // what people eat and drink goes first: a rations route on the same over-full link runs in full, and the rest give way
  db.prepare('INSERT INTO colony_routes (colony_id, from_district, to_district, resource_id, rate, reserve, target) VALUES (?, ?, ?, ?, ?, 0, 0)').run(c.id, c.core, pits, 'rations', 10);
  const slowed = settlements.throttle(c.id, store.loadRoutes(c.id), store.loadDistricts(c.id), now());
  assert.equal(slowed.find((r) => r.resource === 'rations').rate, 10);
  assert.equal(slowed.find((r) => r.resource === 'scrap').rate, base - 10);
});

test('drives: goods in any amounts move a settlement up a stage with a boon; the last one sets it on its own feet', () => {
  const c = colony();
  const id = sponsored(c, 'valley', { stage: 1, level: 1 });
  const need = settlements.driveOf(get(id));
  const [r0] = Object.keys(need);
  assert.match(actions.settlementGive(c.uid, { id, resource: 'scrap', qty: 5 }).error, /does not need/);
  const water = stock(c, r0);
  assert.equal(actions.settlementGive(c.uid, { id, resource: r0, qty: 100 }).ok, true);
  assert.equal(stock(c, r0), water - 100);
  assert.equal(viewFor(c.uid).settlements.active[0].drive.got[r0], 100);
  // "everything the Core can spare" stops at the reserve
  actions.settlementReserve(c.uid, { reserve: 0.9 });
  assert.match(actions.settlementGive(c.uid, { id }).error, /nothing to spare/);
  actions.settlementReserve(c.uid, { reserve: 0 });
  const hands1 = fx(c).hands;
  const before = standing(c, S.types.valley.faction);
  const r = actions.settlementGive(c.uid, { id });
  assert.ok(r.ok && r.completed);
  const s = get(id);
  assert.equal(s.stage, 2);
  assert.equal(s.drive, '{}');
  assert.ok(s.boon_until > now());
  assert.ok(standing(c, S.types.valley.faction) > before);
  // stage 2 gives more, and the boon gives it all over again on top
  const at2 = settlements.benefitAt(get(id));
  assert.ok(at2 > hands1);
  assert.equal(fx(c).hands, Math.floor(at2 * 2));
  assert.equal(viewFor(c.uid).settlements.active[0].boonLeft, s.boon_until - now());
  poke('UPDATE settlements SET boon_until = 0 WHERE id = ?', id);
  assert.ok(Math.abs(fx(c).hands - Math.floor(at2 * get(id).level)) <= 1);
  // the last drive: it leaves its slot and becomes a trade partner
  poke("UPDATE settlements SET stage = ?, drive = '{}' WHERE id = ?", S.stages, id);
  const limit = viewFor(c.uid).market.limits.scrap;
  for (const g of Object.keys(config.resources)) if (!config.resources[g].orbitalOnly) setStock(c, g, 60000);
  const last = actions.settlementGive(c.uid, { id });
  assert.ok(last.ok && last.completed);
  assert.equal(get(id).status, 'done');
  const v = viewFor(c.uid);
  assert.equal(v.settlements.partners, 1);
  assert.equal(v.settlements.active.length, 0);
  // on its own feet it goes on giving a share of what it gave at its last stage, and a second partner of its kind adds less
  const kept = settlements.benefitAt(get(id), S.stages) * S.partner.keep;
  assert.equal(fx(c).hands, Math.floor(kept));
  const second = sponsored(c, 'valley', { stage: S.stages, level: 1 });
  poke("UPDATE settlements SET status = 'done', trait = ? WHERE id = ?", get(id).trait, second);
  settlements.forget();
  assert.equal(fx(c).hands, Math.floor(kept * (1 + S.partner.decay)));
  poke('DELETE FROM settlements WHERE id = ?', second);
  settlements.forget();
  assert.equal(v.market.limits.scrap, Math.floor(sim.convoyLimit(config, 5, 'scrap') * (1 + S.partner.convoyBonus)));
  assert.ok(v.market.limits.scrap > limit);
});

test('appeals: one thing, soon; answering gives a short boon and standing, ignoring costs nothing', () => {
  const c = colony();
  const id = sponsored(c, 'depot', { stage: 2, level: 0 });
  db.prepare('UPDATE settlements SET next_appeal = ?, commitment = 0 WHERE id = ?').run(now() + 1, id);
  tick(2);
  const a = viewFor(c.uid).settlements.active[0].appeal;
  assert.ok(a && S.types.depot.appeals.includes(a.good) && a.qty >= 10 && a.qty <= S.appeal.maxQty && a.ticksLeft > 0);
  setStock(c, a.good, a.qty - 1);
  assert.match(actions.settlementAnswer(c.uid, { id }).error, /Not enough/);
  setStock(c, a.good, a.qty + 7);
  const before = standing(c, S.types.depot.faction);
  assert.deepEqual(actions.settlementAnswer(c.uid, { id }), { ok: true });
  assert.equal(get(id).answers, 1, 'counted, for the story');
  assert.equal(require('../src/story').fires({ type: 'settlement', flag: 'answered' }, { facts: require('../src/story').factsOf(c.id) }), true);
  assert.equal(Math.round(stock(c, a.good)), 7);
  assert.ok(standing(c, S.types.depot.faction) > before);
  assert.ok(get(id).boon_until >= now() + S.appeal.boonTicks);
  assert.ok(fx(c).logistics > 0, 'the boon works even with no steady support');
  assert.equal(viewFor(c.uid).settlements.active[0].appeal, null);
  // one that is ignored simply passes
  db.prepare('UPDATE settlements SET next_appeal = ?, boon_until = 0 WHERE id = ?').run(now() + 1, id);
  tick(2);
  assert.ok(get(id).appeal);
  db.prepare("UPDATE settlements SET appeal = json_set(appeal, '$.expires', ?) WHERE id = ?").run(now() + 1, id);
  tick(2);
  assert.equal(get(id).appeal, null);
  assert.match(actions.settlementAnswer(c.uid, { id }).error, /passed/);
});

test('the numbers hold together: baskets and benefits grow with every stage, and the client is told the kinds', () => {
  for (const [k, t] of Object.entries(S.types)) {
    assert.ok(config.missions.factions[t.faction], `${k} belongs to a faction`);
    assert.equal(t.benefit.byStage.length, S.stages);
    let last = 0; let lastB = 0;
    for (let s = 1; s <= S.stages; s++) {
      const total = Object.values(t.basket[s]).reduce((a, b) => a + b, 0);
      assert.ok(total > last, `${k} stage ${s} asks for more`);
      assert.ok(t.benefit.byStage[s - 1] > lastB, `${k} stage ${s} gives more`);
      for (const r of Object.keys(t.basket[s])) assert.ok(config.resources[r] && !config.resources[r].trade && !config.resources[r].orbitalOnly, `${k}: ${r} is a ground good`);
      last = total; lastB = t.benefit.byStage[s - 1];
    }
    for (const r of t.appeals) assert.ok(config.resources[r], `${k} appeals for a real good`);
  }
  assert.equal(S.driveTicks.length, S.stages);
  const cc = clientConfig();
  assert.ok(cc.settlements.types.foundry.name && cc.settlements.traits.steady.name);
});
