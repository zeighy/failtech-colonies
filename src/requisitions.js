'use strict';
// Requisitions: something to do between the first upgrades and the Beacon. From an early hub level the colony is asked for
// ordinary goods, a set amount by a set time, delivered from the Core. Filling one pays above the convoy's price and lends
// the colony a boon for a while: work crews that speed up whatever is under construction, or a bigger convoy.
// They only ever ask for goods the colony's own districts can make, the amounts grow with the hub, and an unfilled one
// simply lapses. Everything here is deterministic given the colony and the tick.
const ms = require('./marketsim');
const sim = require('./sim');
const store = require('./db');
const { db, config } = store;
const Q = config.requisitions;

const unlocked = (c) => !!Q && c.hub_level >= Q.unlockHubLevel;
const parse = (s) => { try { return s ? JSON.parse(s) : {}; } catch (e) { return {}; } };

// ---- boons ---------------------------------------------------------------------------
// { crews: untilTick, convoy: untilTick } on the colony row. Earning the same boon again adds to the time left.
const boonsOf = (c) => parse(c.boons);
const active = (c, key, tick) => (boonsOf(c)[key] || 0) > tick;
function grant(c, key, tick) {
  const b = boonsOf(c);
  b[key] = Math.max(tick, b[key] || 0) + Q.boons[key].ticks;
  db.prepare('UPDATE colonies SET boons = ? WHERE id = ?').run(JSON.stringify(b), c.id);
  return b[key];
}
// Loaned work crews: how many extra ticks work under way moves this tick (0 or 1).
const crewBonus = (c, tick) => (Q && active(c, 'crews', tick) && tick % Q.boons.crews.everyTicks === 0 ? 1 : 0);
// A priority convoy slot: what the convoy's limits are multiplied by.
const convoyMult = (c, tick) => (Q && active(c, 'convoy', tick) ? Q.boons.convoy.limitMult : 1);

// ---- what can be asked for -------------------------------------------------------------
// Goods that some building in a place the colony holds can make (base recipes), and that the hub is far enough along for.
function askable(c) {
  const places = store.loadDistricts(c.id).map((d) => d.type).filter((t) => t === 'core' || (config.districtTypes || {})[t]);
  const made = new Set();
  for (const b of Object.values(config.buildings)) {
    if (!places.some((t) => sim.buildableIn(b, t))) continue;
    for (const r of Object.keys(b.outputsPerTick || {})) made.add(r);
  }
  return Object.keys(Q.goods).filter((g) => made.has(g) && c.hub_level >= Q.goods[g].from);
}

function build(c, slot, tick, exclude = []) {
  const r = ms.rng(ms.hash(`requisition:${c.id}:${slot}:${tick}`));
  const pool = askable(c);
  const fresh = pool.filter((g) => !exclude.includes(g));
  const list = fresh.length ? fresh : pool;
  if (!list.length) return null;
  const good = list[Math.floor(r() * list.length) % list.length];
  const g = Q.goods[good];
  const grow = 1 + Q.growthPerLevel * (c.hub_level - g.from);
  const qty = Math.max(1, Math.round((g.qty[0] + r() * (g.qty[1] - g.qty[0])) * grow / 5) * 5);
  const boons = Object.keys(Q.boons);
  return {
    title: Q.titles[Math.floor(r() * Q.titles.length) % Q.titles.length], good, qty,
    reward: Math.round(qty * config.resources[good].sell * Q.payMult),
    boon: boons[Math.floor(r() * boons.length) % boons.length],
    expires: tick + Q.durationTicks[0] + Math.floor(r() * (Q.durationTicks[1] - Q.durationTicks[0] + 1)),
  };
}

// Called every tick for each colony: lapse what has run out of time, and open new requisitions in free slots.
function advance(c, tick) {
  if (!unlocked(c)) return;
  for (const q of db.prepare("SELECT id, title FROM requisitions WHERE colony_id = ? AND status = 'open' AND expires_tick <= ?").all(c.id, tick)) {
    db.prepare("UPDATE requisitions SET status = 'expired', closed_tick = ? WHERE id = ?").run(tick, q.id);
    store.addEvent(c.id, tick, 'info', `A requisition lapsed unfilled: ${q.title}.`);
  }
  for (let slot = 0; slot < Q.slots; slot++) {
    if (db.prepare("SELECT 1 FROM requisitions WHERE colony_id = ? AND slot = ? AND status = 'open'").get(c.id, slot)) continue;
    const last = db.prepare('SELECT closed_tick FROM requisitions WHERE colony_id = ? AND slot = ? ORDER BY id DESC LIMIT 1').get(c.id, slot);
    if (last && tick - last.closed_tick < Q.refreshTicks) continue;
    const asked = db.prepare("SELECT good FROM requisitions WHERE colony_id = ? AND status = 'open'").all(c.id).map((x) => x.good);
    const q = build(c, slot, tick, asked);
    if (!q) continue;
    db.prepare('INSERT INTO requisitions (colony_id, slot, title, good, qty, reward, boon, created_tick, expires_tick) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.id, slot, q.title, q.good, q.qty, q.reward, q.boon, tick, q.expires);
    store.addEvent(c.id, tick, 'info', `New requisition: ${q.qty} ${config.resources[q.good].name}.`);
  }
}

// Deliver a requisition in full from the Core's stockpile.
function fill(c, { id }, tick) {
  const fail = (error) => ({ ok: false, error });
  const q = db.prepare("SELECT * FROM requisitions WHERE id = ? AND colony_id = ? AND status = 'open'").get(id, c.id);
  if (!q) return fail('That requisition is no longer open.');
  const core = store.coreId(c.id);
  const name = config.resources[q.good].name;
  if ((store.loadInventory(c.id, core)[q.good] || 0) < q.qty) return fail(`Not enough ${name} in the Core: ${q.qty} needed.`);
  db.prepare('UPDATE colony_inventory SET amount = amount - ? WHERE district_id = ? AND resource_id = ?').run(q.qty, core, q.good);
  db.prepare('UPDATE colonies SET credits = credits + ? WHERE id = ?').run(q.reward, c.id);
  db.prepare("UPDATE requisitions SET status = 'done', closed_tick = ? WHERE id = ?").run(tick, q.id);
  const until = grant(c, q.boon, tick);
  store.addEvent(c.id, tick, 'good', `Requisition filled: ${q.qty} ${name} for ${q.reward} cr. ${Q.boons[q.boon].name} for ${until - tick} ticks.`);
  return { ok: true, reward: q.reward, boon: q.boon, until };
}

function view(c, tick) {
  if (!Q) return { unlocked: false, open: [], boons: {}, filled: 0 };
  const b = boonsOf(c);
  return {
    unlocked: unlocked(c), unlockHubLevel: Q.unlockHubLevel,
    open: db.prepare("SELECT id, slot, title, good, qty, reward, boon, expires_tick FROM requisitions WHERE colony_id = ? AND status = 'open' ORDER BY slot").all(c.id)
      .map((q) => ({ id: q.id, slot: q.slot, title: q.title, good: q.good, qty: q.qty, reward: q.reward, boon: q.boon, ticksLeft: Math.max(0, q.expires_tick - tick) })),
    boons: Object.fromEntries(Object.keys(Q.boons).map((k) => [k, Math.max(0, (b[k] || 0) - tick)])),
    filled: db.prepare("SELECT COUNT(*) AS n FROM requisitions WHERE colony_id = ? AND status = 'done'").get(c.id).n,
  };
}

module.exports = { advance, fill, view, build, askable, active, crewBonus, convoyMult, unlocked };
