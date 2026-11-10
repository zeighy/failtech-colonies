'use strict';
// Requisitions: requests for ordinary goods from an early hub level, and the boons they lend.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-req-'));
process.env.DB_PATH = path.join(dir, 'req.db');
process.env.SESSION_SECRET = 'x';
process.env.THEME = 'basic';
process.env.HAZARDS = 'off';
const store = require('../src/db');
const engine = require('../src/engine');
const actions = require('../src/actions');
const requisitions = require('../src/requisitions');
const sim = require('../src/sim');
const { viewFor } = require('../src/state');
const { db, config } = store;
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const Q = config.requisitions;
const R = config.resources;
const tick = (k = 1) => { for (let i = 0; i < k; i++) engine.processTick(); };
const now = () => Number(store.getMeta('global_tick', 0));
let n = 0;
function colony(level = 3, amount = 3000) {
  const uid = Number(db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(`rq${++n}`, 'x').lastInsertRowid);
  const id = store.ensureColony(uid);
  const core = store.coreId(id);
  db.prepare('UPDATE colonies SET hub_level = ?, credits = 1000 WHERE id = ?').run(level, id);
  const inv = {}; for (const r of Object.keys(R)) inv[r] = amount;
  store.saveInventory(id, inv, core);
  return { uid, id, core };
}
const row = (c) => db.prepare('SELECT * FROM colonies WHERE id = ?').get(c.id);
const open = (c) => db.prepare("SELECT * FROM requisitions WHERE colony_id = ? AND status = 'open' ORDER BY slot").all(c.id);
const stock = (c, r) => store.loadInventory(c.id, c.core)[r] || 0;
const setStock = (c, r, a) => db.prepare('UPDATE colony_inventory SET amount = ? WHERE district_id = ? AND resource_id = ?').run(a, c.core, r);

test('requisitions open at an early hub level, fill their slots, and only ask for goods the colony can make', () => {
  const early = colony(1);
  tick(1);
  assert.equal(open(early).length, 0, 'nothing before the hub level they start at');
  assert.equal(viewFor(early.uid).requisitions.unlocked, false);
  const c = colony(Q.unlockHubLevel);
  tick(1);
  const list = open(c);
  assert.equal(list.length, Q.slots);
  assert.notEqual(list[0].good, list[1].good, 'two open requisitions ask for different goods');
  for (const q of list) {
    const g = Q.goods[q.good];
    assert.ok(g && g.from <= Q.unlockHubLevel, `${q.good} is in reach of a level ${Q.unlockHubLevel} hub`);
    assert.ok(q.qty >= g.qty[0] && q.qty <= g.qty[1] + 5);
    assert.equal(q.reward, Math.round(q.qty * R[q.good].sell * Q.payMult));
    assert.ok(Q.boons[q.boon]);
    assert.ok(q.expires_tick - q.created_tick >= Q.durationTicks[0] && q.expires_tick - q.created_tick <= Q.durationTicks[1]);
  }
  // a Core-only colony is never asked for something only a district makes, whatever its level
  const lone = colony(5);
  const pool = requisitions.askable(row(lone));
  assert.ok(pool.includes('alloys') && pool.includes('machined_parts'));
  assert.ok(pool.includes('ingots'), 'the Reclamation Plant makes ingots in the Core');
  for (const g of ['fuel', 'reagents', 'polymers', 'circuits', 'medicine', 'power_cells']) assert.ok(!pool.includes(g), `${g} needs a district`);
  db.prepare("INSERT INTO districts (colony_id, type, level, name, created_tick) VALUES (?, 'stacks', 1, 'stacks', 0)").run(lone.id);
  assert.ok(requisitions.askable(row(lone)).includes('fuel'), 'founding the district that makes it puts it on the list');
  // amounts grow with the hub
  const small = requisitions.build({ ...row(c), hub_level: 2 }, 0, 500);
  const sizes = [2, 3, 4, 5].map((lv) => { const q = requisitions.build({ ...row(c), hub_level: lv }, 0, 500, Object.keys(Q.goods).filter((g) => g !== small.good)); return q.good === small.good ? q.qty : null; });
  assert.ok(sizes[3] > sizes[0], `the same request is bigger at hub 5 (${sizes.join(', ')})`);
});

test('delivering: the whole amount from the Core, paid above the convoy price, with a boon; it is refused if the Core is short', () => {
  const c = colony(3);
  tick(1);
  const [q] = open(c);
  setStock(c, q.good, q.qty - 1);
  assert.match(actions.requisitionFill(c.uid, { id: q.id }).error, /Not enough/);
  assert.match(actions.requisitionFill(c.uid, { id: 999999 }).error, /no longer open/);
  setStock(c, q.good, q.qty + 10);
  const credits = row(c).credits;
  const r = actions.requisitionFill(c.uid, { id: q.id });
  assert.equal(r.ok, true);
  assert.equal(stock(c, q.good), 10);
  assert.equal(row(c).credits, credits + q.reward);
  assert.ok(q.reward > q.qty * R[q.good].sell, 'it pays more than exporting the goods would');
  assert.ok(q.reward < q.qty * R[q.good].buy, 'and less than buying them costs, so there is nothing to be made by buying to deliver');
  assert.match(actions.requisitionFill(c.uid, { id: q.id }).error, /no longer open/, 'it can be delivered once');
  const v = viewFor(c.uid).requisitions;
  assert.equal(v.filled, 1);
  assert.equal(v.boons[q.boon], Q.boons[q.boon].ticks);
  assert.equal(v.open.length, Q.slots - 1, 'the slot stays empty for a while');
  tick(Q.refreshTicks - 1);
  assert.equal(open(c).length, Q.slots - 1);
  tick(2);
  assert.equal(open(c).length, Q.slots, 'then a new one arrives');
  // another player cannot deliver this colony's requisition
  const other = colony(3);
  assert.match(actions.requisitionFill(other.uid, { id: open(c)[0].id }).error, /no longer open/);
});

test('a requisition that runs out of time lapses and is replaced', () => {
  const c = colony(2);
  tick(1);
  const [q] = open(c);
  db.prepare('UPDATE requisitions SET expires_tick = ? WHERE id = ?').run(now() + 1, q.id);
  tick(1);
  assert.equal(db.prepare('SELECT status FROM requisitions WHERE id = ?').get(q.id).status, 'expired');
  assert.match(db.prepare("SELECT message FROM colony_events WHERE colony_id = ? AND message LIKE 'A requisition lapsed%' ORDER BY id DESC").get(c.id).message, /lapsed unfilled/);
  assert.equal(row(c).boons, '{}', 'no boon for a lapsed one');
});

test('loaned work crews: work under way moves an extra tick every third tick, for as long as the boon lasts', () => {
  const c = colony(3);
  const every = Q.boons.crews.everyTicks;
  // without the boon a 6-tick build takes 6 ticks
  assert.deepEqual(actions.build(c.uid, { ring: 1, slot: 0, type: 'parts_assembler' }), { ok: true });
  const total = config.buildings.parts_assembler.constructionTicks;
  tick(total - 1);
  assert.equal(store.loadBuildings(c.id, c.core).length, 0);
  tick(1);
  assert.equal(store.loadBuildings(c.id, c.core).length, 1);
  // with it, the same build finishes sooner
  db.prepare('UPDATE colonies SET boons = ? WHERE id = ?').run(JSON.stringify({ crews: now() + 1000 }), c.id);
  assert.deepEqual(actions.build(c.uid, { ring: 1, slot: 1, type: 'parts_assembler' }), { ok: true });
  let took = 0;
  while (store.loadBuildings(c.id, c.core).length < 2 && took < 50) { tick(1); took++; }
  assert.ok(took < total, `built in ${took} ticks instead of ${total}`);
  assert.ok(took >= Math.ceil(total * every / (every + 1)) - 1, 'but only about a third faster');
  assert.equal(requisitions.crewBonus({ boons: JSON.stringify({ crews: 10 }) }, 9), 9 % every === 0 ? 1 : 0);
  assert.equal(requisitions.crewBonus({ boons: JSON.stringify({ crews: 10 }) }, 12), 0, 'nothing once it has run out');
  assert.equal(requisitions.crewBonus({ boons: '{}' }, 9), 0);
  // earning the same boon again adds to the time left
  db.prepare("UPDATE colonies SET boons = '{}' WHERE id = ?").run(c.id);
  tick(1);
  for (let i = 0; i < 2; i++) {
    const q = open(c)[0];
    db.prepare("UPDATE requisitions SET boon = 'crews' WHERE id = ?").run(q.id);
    setStock(c, q.good, q.qty);
    assert.equal(actions.requisitionFill(c.uid, { id: q.id }).ok, true);
  }
  assert.equal(viewFor(c.uid).requisitions.boons.crews, 2 * Q.boons.crews.ticks);
});

test('a priority convoy slot: the convoy carries more of everything while it lasts', () => {
  const c = colony(3);
  const base = sim.convoyLimit(config, 3, 'scrap');
  assert.equal(viewFor(c.uid).market.limits.scrap, base);
  assert.deepEqual(actions.setContract(c.uid, { resource: 'scrap', side: 'export', amount: 999999 }), { ok: true });
  assert.equal(store.loadContracts(c.id).export.scrap, base, 'a standing order is held to the limit');
  db.prepare('UPDATE colonies SET boons = ? WHERE id = ?').run(JSON.stringify({ convoy: now() + 1000 }), c.id);
  const wide = Math.floor(base * Q.boons.convoy.limitMult);
  assert.equal(viewFor(c.uid).market.limits.scrap, wide);
  assert.deepEqual(actions.setContract(c.uid, { resource: 'scrap', side: 'export', amount: 999999 }), { ok: true });
  assert.equal(store.loadContracts(c.id).export.scrap, wide);
  // the convoy itself: the wider limit applies while the boon is on, and the old one again once it is gone
  const state = { hubLevel: 3, inventory: { scrap: 99999 }, credits: 0, cap: 1e9 };
  const prices = sim.marketPrices(config, 1);
  const sold = (limitMult) => 99999 - sim.runConvoy(config, { ...state, limitMult }, { export: { scrap: wide }, import: {} }, prices).inventory.scrap;
  assert.equal(sold(Q.boons.convoy.limitMult), wide);
  assert.equal(sold(undefined), base);
});

test('the view and the themes: requisitions travel with the state, and every theme names the boons and the forms', () => {
  const c = colony(3);
  tick(1);
  const v = viewFor(c.uid).requisitions;
  assert.equal(v.unlocked, true);
  assert.equal(v.open.length, Q.slots);
  assert.deepEqual(Object.keys(v.boons).sort(), Object.keys(Q.boons).sort());
  for (const q of v.open) assert.ok(q.title && q.ticksLeft > 0 && R[q.good]);
  assert.ok(Q.titles.length >= 4);
  const theme = require('../src/theme');
  for (const id of theme.listThemes()) {
    const t = theme.readJson(path.join(theme.dir(id), 'theme.json'));
    assert.ok(Array.isArray(t.requisitionTitles) && t.requisitionTitles.length >= 4, `${id} names the requisitions`);
    for (const k of Object.keys(Q.boons)) assert.ok(t.boons && t.boons[k] && t.boons[k].name, `${id} names the ${k} boon`);
  }
});
