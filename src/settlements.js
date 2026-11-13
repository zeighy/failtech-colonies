'use strict';
// Settlements: once the Beacon has been heard, camps answer it, and the colony can sponsor them. This is where a mature
// colony's goods go.
//  - Camps on offer come and go (a few at a time, each with a kind, a trait and a lifetime, all rolled); the colony
//    sponsors one per slot (a slot at the Beacon, one more with the Free Port, one more with the station).
//  - Steady support: every tick a sponsored settlement draws its basket from the Core, at the commitment the player set
//    (off, half, full), never taking the Core below the reserve the player set. Its `level` (0 to 1) follows what it has
//    actually been getting, smoothed over a few dozen ticks, and its benefit is its stage's benefit times that level.
//  - Bulk aid: each stage has a drive, a list of goods contributed in any amounts at any time. Completing it moves the
//    settlement up a stage and gives a boon (its full benefit again on top, for a while). The last drive sets it on its
//    own feet: it leaves its slot and becomes a trade partner for good, still giving a share of its benefit unasked.
//  - Appeals: now and then a settlement asks for one thing, quickly. Answering gives a short boon; ignoring costs nothing.
// Benefits never add production: a discount on upgrades, commuters (hands, not mouths), and room on links and the convoy.
// Everything is deterministic given the colony and the tick.
const ms = require('./marketsim');
const store = require('./db');
const { db, config } = store;
const S = config.settlements;
const R = config.resources;

const fail = (error) => ({ ok: false, error });
const OK = { ok: true };
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } };
const between = (r, [lo, hi]) => lo + Math.floor(r() * (hi - lo + 1));
const tickNow = () => Number(store.getMeta('global_tick', 0));
const COMMIT = [0, 0.5, 1];

const unlocked = (c) => !!S && !!c.won;
const rows = (colonyId, status) => db.prepare('SELECT * FROM settlements WHERE colony_id = ? AND status = ? ORDER BY id').all(colonyId, status);
const partners = (colonyId) => (S ? db.prepare("SELECT COUNT(*) AS n FROM settlements WHERE colony_id = ? AND status = 'done'").get(colonyId).n : 0);
// How many settlements the colony may sponsor at once: one for each milestone it has reached.
function slotCount(c) {
  if (!unlocked(c)) return 0;
  const has = (type) => !!db.prepare('SELECT 1 FROM districts WHERE colony_id = ? AND type = ?').get(c.id, type);
  const met = { beacon: true, freeport: has('freeport'), station: has('station') };
  return S.slots.filter((k) => met[k]).length;
}

// ---- what a settlement asks for and gives ------------------------------------------------
const typeOf = (s) => S.types[s.type];
const traitOf = (s) => S.traits[s.trait] || { basketMult: 1, driveMult: 1, benefitMult: 1, standingMult: 1 };
// Its basket per tick at full commitment.
function basketOf(s, stage = s.stage) {
  const t = traitOf(s);
  return Object.fromEntries(Object.entries(typeOf(s).basket[stage]).map(([r, q]) => [r, Math.max(1, Math.round(q * t.basketMult))]));
}
// What its current drive takes in all.
function driveOf(s) {
  const t = traitOf(s);
  return Object.fromEntries(Object.entries(typeOf(s).basket[s.stage]).map(([r, q]) => [r, Math.max(10, Math.round(q * S.driveTicks[s.stage - 1] * t.driveMult / 10) * 10)]));
}
// Its benefit at a stage with full support: a discount (a fraction), hands (people) or logistics (a fraction).
const benefitAt = (s, stage = s.stage) => typeOf(s).benefit.byStage[stage - 1] * traitOf(s).benefitMult;
// How much of that it is giving now: what it has been getting, plus the whole of it again while a boon runs.
const strength = (s, tick) => Math.max(0, s.level) + (s.boon_until > tick ? 1 : 0);

// ---- what the colony gets ------------------------------------------------------------------
// { discount, hands, logistics } from every sponsored settlement, plus the trade partners' convoy bonus.
const memo = { key: null, value: null };
function effects(colonyId, tick = tickNow()) {
  const none = { discount: 0, hands: 0, logistics: 0, partner: 0 };
  if (!S) return none;
  const key = `${colonyId}:${tick}`;
  if (memo.key === key) return memo.value;
  const out = { ...none };
  for (const s of rows(colonyId, 'active')) out[typeOf(s).benefit.kind] += benefitAt(s) * strength(s, tick);
  // a settlement on its own feet keeps giving a share of what it gave at its last stage, for nothing, and adds to what
  // the convoy will carry; each further partner (of a kind, for the share; of any, for the convoy) counts for less
  const nth = {}; let all = 0;
  for (const s of rows(colonyId, 'done')) {
    const kind = typeOf(s).benefit.kind;
    out[kind] += benefitAt(s, S.stages) * S.partner.keep * S.partner.decay ** (nth[kind] || 0);
    nth[kind] = (nth[kind] || 0) + 1;
    out.partner += S.partner.convoyBonus * S.partner.decay ** all++;
  }
  out.discount = Math.min(S.discountCap, out.discount);
  out.hands = Math.floor(out.hands);
  memo.key = key; memo.value = out;
  return out;
}
const forget = () => { memo.key = null; };
// A cost with the settlements' discount taken off (upgrades and expansions; never below one of anything).
function discounted(colonyId, cost, tick) {
  const d = effects(colonyId, tick).discount;
  if (!cost || d <= 0) return cost;
  return Object.fromEntries(Object.entries(cost).map(([r, a]) => [r, Math.max(1, Math.ceil(a * (1 - d) - 1e-9))]));
}
const discountedFor = (districtId, cost) => {
  if (!S || !cost) return cost;
  const row = db.prepare('SELECT colony_id FROM districts WHERE id = ?').get(districtId);
  return row ? discounted(row.colony_id, cost) : cost;
};
const convoyMult = (c, tick) => { const e = effects(c.id, tick); return 1 + e.logistics + e.partner; };
const linkMult = (colonyId, tick) => 1 + effects(colonyId, tick).logistics;
// Links are checked when a route is set. If the logistics benefit then falls away (a settlement goes short, a boon runs
// out), the routes on a link may add up to more than it carries. What people eat and drink keeps its place: those routes
// run in full while the link can carry them, and the rest are slowed in proportion to fit what is left. Returns the
// routes with the rate each runs at; a slowed one also carries `setRate`, the rate the player asked for.
const vital = (r) => !!config.global.populationConsumptionPerTick[r.resource] || r.resource === 'unpurified_water' || r.resource === 'meals';
function throttle(colonyId, routes, districts, tick) {
  if (!S || !routes.length) return routes;
  const mult = linkMult(colonyId, tick);
  const bonus = require('./perks').linkBonus(colonyId); // Headquarters' boost on every link
  const cap = {};
  for (const d of districts) if (d.type !== 'core' && (config.districtTypes || {})[d.type]) cap[d.id] = Math.floor(config.logistics.link.levels[d.linkLevel || 1].capacity * mult) + bonus;
  const first = {}; const rest = {};
  for (const r of routes) for (const end of [r.fromDistrict, r.toDistrict]) if (cap[end] !== undefined) { const bag = vital(r) ? first : rest; bag[end] = (bag[end] || 0) + r.rate; }
  const factor = (id, isVital) => {
    if (cap[id] === undefined) return 1;
    const a = first[id] || 0; const b = rest[id] || 0;
    if (a + b <= cap[id]) return 1;
    if (isVital) return Math.min(1, cap[id] / a);
    return Math.max(0, cap[id] - a) / b;
  };
  return routes.map((r) => {
    const f = Math.min(factor(r.fromDistrict, vital(r)), factor(r.toDistrict, vital(r)));
    return f >= 1 ? r : { ...r, rate: Math.floor(r.rate * f), setRate: r.rate };
  });
}

// ---- camps on offer -------------------------------------------------------------------------
function pickWeighted(r, table) {
  const entries = Object.entries(table);
  let roll = r() * entries.reduce((n, [, a]) => n + (a.weight || 1), 0);
  for (const [k, a] of entries) { roll -= (a.weight || 1); if (roll <= 0) return k; }
  return entries[0][0];
}
function offers(c, tick) {
  db.prepare("DELETE FROM settlements WHERE colony_id = ? AND status = 'offer' AND expires_tick <= ?").run(c.id, tick);
  const open = rows(c.id, 'offer');
  const taken = new Set([...open, ...rows(c.id, 'active')].map((s) => s.name));
  for (let k = open.length; k < S.offers; k++) {
    const r = ms.rng(ms.hash(`camp:${c.id}:${tick}:${k}:${db.prepare('SELECT COUNT(*) AS n FROM settlements WHERE colony_id = ?').get(c.id).n}`));
    const types = Object.keys(S.types);
    // the kinds on offer are kept different from each other while they can be, so there is always a choice
    const fresh = types.filter((t) => !open.some((o) => o.type === t));
    const type = (fresh.length ? fresh : types)[Math.floor(r() * (fresh.length ? fresh : types).length)];
    const trait = pickWeighted(r, S.traits);
    const names = S.names.filter((n) => !taken.has(n));
    const name = (names.length ? names : S.names)[Math.floor(r() * (names.length ? names : S.names).length)];
    taken.add(name);
    const info = db.prepare("INSERT INTO settlements (colony_id, type, trait, name, status, created_tick, expires_tick) VALUES (?, ?, ?, ?, 'offer', ?, ?)").run(c.id, type, trait, name, tick, tick + between(r, S.offerTicks));
    open.push({ id: Number(info.lastInsertRowid), type });
  }
}

// ---- every tick ------------------------------------------------------------------------------
// `inv` is the Core's stock in memory for this tick (mutated); `cap` its storage cap per resource.
function advance(c, tick, inv, cap) {
  if (!unlocked(c)) return;
  if (tick % 5 === 0 || !rows(c.id, 'offer').length) offers(c, tick);
  const floor = Math.max(0, Math.min(0.9, c.settle_reserve === undefined || c.settle_reserve === null ? S.defaultReserve : c.settle_reserve)) * cap;
  for (const s of rows(c.id, 'active')) {
    const frac = COMMIT[s.commitment] || 0;
    let sum = 0; let n = 0; let sent = 0;
    for (const [r, q] of Object.entries(basketOf(s))) {
      n++;
      const need = q * frac;
      if (need <= 0) continue;
      const take = Math.max(0, Math.min(need, (inv[r] || 0) - floor));
      inv[r] = (inv[r] || 0) - take; sent += take; sum += take / need;
    }
    const got = n ? (frac * sum) / n : 0;
    let level = s.level + (got - s.level) / S.smoothTicks;
    if (level < 1e-4) level = 0;
    // word gets round: standing with the faction the settlement belongs to, a little every tick it is looked after
    let acc = s.standing_acc + s.stage * S.standingPerStage * level * traitOf(s).standingMult;
    const pts = Math.floor(acc);
    if (pts > 0) { acc -= pts; addStanding(c.id, typeOf(s).faction, pts); }
    // appeals: one thing, soon
    let appeal = parse(s.appeal, null); let next = s.next_appeal;
    if (appeal && appeal.expires <= tick) { appeal = null; next = tick + between(ms.rng(ms.hash(`gap:${s.id}:${tick}`)), S.appeal.gapTicks); }
    if (!appeal && tick >= next) {
      const r = ms.rng(ms.hash(`appeal:${s.id}:${tick}`));
      const pool = typeOf(s).appeals.filter((g) => R[g]);
      const good = pool[Math.floor(r() * pool.length)];
      const value = Object.entries(basketOf(s)).reduce((v, [g, q]) => v + q * R[g].sell, 0) * between(r, S.appeal.sizeTicks);
      const qty = Math.max(10, Math.min(S.appeal.maxQty, Math.round(value / R[good].sell / 5) * 5));
      appeal = { good, qty, expires: tick + between(r, S.appeal.windowTicks) };
      store.addEvent(c.id, tick, 'info', `${s.name} is appealing for ${qty} ${R[good].name}.`);
    }
    db.prepare('UPDATE settlements SET level = ?, sent = sent + ?, standing_acc = ?, appeal = ?, next_appeal = ? WHERE id = ?').run(level, sent, acc, appeal ? JSON.stringify(appeal) : null, next, s.id);
  }
  forget();
}
function addStanding(colonyId, faction, pts) {
  db.prepare('INSERT INTO standing (colony_id, faction, points) VALUES (?, ?, ?) ON CONFLICT(colony_id, faction) DO UPDATE SET points = points + excluded.points').run(colonyId, faction, pts);
}
// What the settlements would take from the Core this tick, per resource, given its stock (for showing rates).
function draw(c, inv, cap) {
  const out = {};
  if (!unlocked(c)) return out;
  const floor = Math.max(0, Math.min(0.9, c.settle_reserve === undefined || c.settle_reserve === null ? S.defaultReserve : c.settle_reserve)) * cap;
  const left = { ...inv };
  for (const s of rows(c.id, 'active')) {
    const frac = COMMIT[s.commitment] || 0;
    for (const [r, q] of Object.entries(basketOf(s))) {
      const take = Math.max(0, Math.min(q * frac, (left[r] || 0) - floor));
      if (take > 0) { left[r] -= take; out[r] = (out[r] || 0) + take; }
    }
  }
  return out;
}

// ---- the player's actions ---------------------------------------------------------------------
const mine = (c, id, status = 'active') => db.prepare('SELECT * FROM settlements WHERE id = ? AND colony_id = ? AND status = ?').get(Number(id), c.id, status);
const coreStock = (c) => store.loadInventory(c.id, store.coreId(c.id));
const takeCore = (c, r, q) => db.prepare('UPDATE colony_inventory SET amount = amount - ? WHERE district_id = ? AND resource_id = ?').run(q, store.coreId(c.id), r);

function sponsor(c, { id }, tick) {
  if (!unlocked(c)) return fail('Nobody has answered yet.');
  const s = mine(c, id, 'offer');
  if (!s || s.expires_tick <= tick) return fail('That camp is no longer asking.');
  if (rows(c.id, 'active').length >= slotCount(c)) return fail('The colony is already sponsoring all the settlements it can.');
  const gap = between(ms.rng(ms.hash(`gap:${s.id}:${tick}`)), S.appeal.gapTicks);
  db.prepare("UPDATE settlements SET status = 'active', started_tick = ?, next_appeal = ?, commitment = 2 WHERE id = ?").run(tick, tick + gap, s.id);
  store.addEvent(c.id, tick, 'good', `The colony is sponsoring ${s.name}.`);
  forget();
  return OK;
}
function commit(c, { id, level }) {
  const s = mine(c, id);
  if (!s) return fail('No such settlement.');
  const l = Number(level);
  if (![0, 1, 2].includes(l)) return fail('Support is off, half or full.');
  db.prepare('UPDATE settlements SET commitment = ? WHERE id = ?').run(l, s.id);
  return OK;
}
// Contribute to the drive: one resource and an amount, or (with neither) everything the Core can spare above its reserve.
function give(c, { id, resource, qty }, tick) {
  const s = mine(c, id);
  if (!s) return fail('No such settlement.');
  const need = driveOf(s); const got = parse(s.drive, {});
  const stock = coreStock(c);
  const give1 = {};
  if (resource !== undefined && resource !== null && resource !== '') {
    if (!Object.prototype.hasOwnProperty.call(need, resource)) return fail('The drive does not need that.');
    const q = Math.floor(Number(qty));
    if (!Number.isFinite(q) || q < 1) return fail('Bad quantity.');
    const left = need[resource] - (got[resource] || 0);
    if (left <= 0) return fail('The drive has all of that it needs.');
    if ((stock[resource] || 0) < Math.min(q, left)) return fail(`Not enough ${R[resource].name} in the Core.`);
    give1[resource] = Math.min(q, left);
  } else {
    const row = db.prepare('SELECT hub_level FROM colonies WHERE id = ?').get(c.id);
    const cap = require('./sim').storageCap(config, { type: 'core', level: row.hub_level, buildings: store.loadBuildings(c.id, store.coreId(c.id)) });
    const floor = (c.settle_reserve === undefined || c.settle_reserve === null ? S.defaultReserve : c.settle_reserve) * cap;
    for (const [r, q] of Object.entries(need)) {
      const amount = Math.min(q - (got[r] || 0), Math.floor((stock[r] || 0) - floor));
      if (amount >= 1) give1[r] = amount;
    }
    if (!Object.keys(give1).length) return fail('The Core has nothing to spare above its reserve for this drive.');
  }
  let total = 0;
  for (const [r, q] of Object.entries(give1)) { takeCore(c, r, q); got[r] = (got[r] || 0) + q; total += q; }
  const done = Object.entries(need).every(([r, q]) => (got[r] || 0) >= q);
  if (!done) {
    db.prepare('UPDATE settlements SET drive = ?, sent = sent + ? WHERE id = ?').run(JSON.stringify(got), total, s.id);
    return { ok: true, given: give1 };
  }
  addStanding(c.id, typeOf(s).faction, Math.round(S.driveStanding * s.stage * traitOf(s).standingMult));
  if (s.stage >= S.stages) {
    db.prepare("UPDATE settlements SET status = 'done', done_tick = ?, drive = '{}', appeal = NULL, sent = sent + ? WHERE id = ?").run(tick, total, s.id);
    store.addEvent(c.id, tick, 'good', `${s.name} stands on its own now. It will trade with the colony for good, and another camp can be sponsored in its place.`);
  } else {
    db.prepare("UPDATE settlements SET stage = stage + 1, drive = '{}', boon_until = ?, sent = sent + ? WHERE id = ?").run(Math.max(tick, s.boon_until) + S.boonTicks, total, s.id);
    store.addEvent(c.id, tick, 'good', `${s.name} has grown to stage ${s.stage + 1}. Its people are giving twice what they usually do for a while.`);
  }
  forget();
  return { ok: true, given: give1, completed: true };
}
function answer(c, { id }, tick) {
  const s = mine(c, id);
  if (!s) return fail('No such settlement.');
  const a = parse(s.appeal, null);
  if (!a || a.expires <= tick) return fail('That appeal has passed.');
  if ((coreStock(c)[a.good] || 0) < a.qty) return fail(`Not enough ${R[a.good].name} in the Core: ${a.qty} needed.`);
  takeCore(c, a.good, a.qty);
  addStanding(c.id, typeOf(s).faction, Math.round(S.appeal.standing * s.stage * traitOf(s).standingMult));
  const gap = between(ms.rng(ms.hash(`gap:${s.id}:${tick}`)), S.appeal.gapTicks);
  db.prepare('UPDATE settlements SET appeal = NULL, answers = answers + 1, next_appeal = ?, boon_until = ?, sent = sent + ? WHERE id = ?').run(tick + gap, Math.max(tick, s.boon_until) + S.appeal.boonTicks, a.qty, s.id);
  store.addEvent(c.id, tick, 'good', `${s.name}'s appeal was answered: ${a.qty} ${R[a.good].name}.`);
  forget();
  return OK;
}
function drop(c, { id }, tick) {
  const s = mine(c, id);
  if (!s) return fail('No such settlement.');
  db.prepare("UPDATE settlements SET status = 'gone', done_tick = ? WHERE id = ?").run(tick, s.id);
  store.addEvent(c.id, tick, 'warn', `The colony has stopped sponsoring ${s.name}.`);
  forget();
  return OK;
}
function setReserve(c, { reserve }) {
  const v = Number(reserve);
  if (!Number.isFinite(v) || v < 0 || v > 0.9) return fail('The reserve is a share of the Core\'s storage, from 0 to 90%.');
  db.prepare('UPDATE colonies SET settle_reserve = ? WHERE id = ?').run(Math.round(v * 100) / 100, c.id);
  return OK;
}

// ---- the view -----------------------------------------------------------------------------------
function view(c, tick, inv, cap) {
  if (!S) return { unlocked: false };
  if (!unlocked(c)) return { unlocked: false };
  const card = (s) => {
    const t = typeOf(s); const tr = traitOf(s);
    return { id: s.id, name: s.name, type: s.type, trait: s.trait, faction: t.faction, kind: t.benefit.kind, basket: basketOf(s, s.stage || 1), benefit: benefitAt(s, s.stage || 1), benefitTop: benefitAt(s, S.stages), driveMult: tr.driveMult };
  };
  const e = effects(c.id, tick);
  // what a settlement would go on giving, unasked, once it stands on its own (less for each partner of its kind there already is)
  const done = rows(c.id, 'done');
  const keeps = (s) => benefitAt(s, S.stages) * S.partner.keep * S.partner.decay ** done.filter((d) => typeOf(d).benefit.kind === typeOf(s).benefit.kind).length;
  return {
    unlocked: true, slots: slotCount(c), slotNeeds: S.slots, reserve: c.settle_reserve === undefined || c.settle_reserve === null ? S.defaultReserve : c.settle_reserve,
    partners: partners(c.id), effects: e, drawing: draw(c, inv, cap),
    active: rows(c.id, 'active').map((s) => {
      const a = parse(s.appeal, null);
      return { ...card(s), stage: s.stage, stages: S.stages, commitment: s.commitment, level: Math.round(s.level * 1000) / 1000, now: benefitAt(s) * strength(s, tick),
        next: s.stage < S.stages ? benefitAt(s, s.stage + 1) : null, keeps: keeps(s), drive: { need: driveOf(s), got: parse(s.drive, {}) }, last: s.stage >= S.stages,
        boonLeft: Math.max(0, s.boon_until - tick), appeal: a && a.expires > tick ? { good: a.good, qty: a.qty, ticksLeft: a.expires - tick } : null,
        standingPerTick: s.stage * S.standingPerStage * s.level * traitOf(s).standingMult, sent: Math.round(s.sent) };
    }),
    offers: rows(c.id, 'offer').map((s) => ({ ...card(s), ticksLeft: Math.max(0, s.expires_tick - tick) })),
  };
}

module.exports = { forget, unlocked, slotCount, partners, effects, discounted, discountedFor, convoyMult, linkMult, throttle, advance, draw, sponsor, commit, give, answer, drop, setReserve, view, basketOf, driveOf, benefitAt };
