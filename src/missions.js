'use strict';
// Missions: NPC factions post requests for trade goods. Each mission offers the same job in the name of each
// faction, asking for a different good, and the player fills one offer (the others lapse). A filled offer pays
// credits above market value and raises that faction's standing. Standing does nothing yet; it is a score, and
// the hook for whatever comes next. Everything here is deterministic given the colony and the tick.
const ms = require('./marketsim');
const store = require('./db');
const { db, config } = store;
const M = config.missions;

const hasFreePort = (colonyId) => !!db.prepare("SELECT 1 FROM districts WHERE colony_id = ? AND type = 'freeport'").get(colonyId);
const tradeGoods = () => Object.keys(config.resources).filter((k) => config.resources[k].trade);
const mid = (res) => ms.midPrice(config, res);

function pickWeighted(r, wants, exclude) {
  const entries = Object.entries(wants).filter(([g]) => !exclude.has(g));
  const list = entries.length ? entries : Object.entries(wants);
  let roll = r() * list.reduce((n, [, w]) => n + w, 0);
  for (const [g, w] of list) { roll -= w; if (roll <= 0) return g; }
  return list[0][0];
}

function build(colonyId, slot, tick) {
  const r = ms.rng(ms.hash(`mission:${colonyId}:${slot}:${tick}`));
  const used = new Set();
  const offers = Object.entries(M.factions).map(([faction, f]) => {
    const good = pickWeighted(r, f.wants, used);
    used.add(good);
    const tier = config.resources[good].tier;
    const [lo, hi] = M.qtyByTier[tier];
    const qty = lo + Math.floor(r() * (hi - lo + 1));
    return {
      faction, good, qty,
      reward: Math.round(qty * mid(good) * M.rewardMult),
      standing: Math.max(1, Math.round(qty * M.standingPerTier[tier] / 10)),
    };
  });
  const title = M.titles[Math.floor(r() * M.titles.length)];
  const dur = M.durationTicks[0] + Math.floor(r() * (M.durationTicks[1] - M.durationTicks[0] + 1));
  return { title, offers, expires: tick + dur };
}

// Called every tick for each colony: expire stale missions and open new ones in free slots.
function advance(c, tick) {
  if (!hasFreePort(c.id)) return;
  for (const q of db.prepare("SELECT id FROM missions WHERE colony_id = ? AND status = 'open' AND expires_tick <= ?").all(c.id, tick)) {
    db.prepare("UPDATE missions SET status = 'expired', closed_tick = ? WHERE id = ?").run(tick, q.id);
    store.addEvent(c.id, tick, 'info', 'A mission lapsed unfilled.');
  }
  for (let slot = 0; slot < M.slots; slot++) {
    if (db.prepare("SELECT 1 FROM missions WHERE colony_id = ? AND slot = ? AND status = 'open'").get(c.id, slot)) continue;
    const last = db.prepare('SELECT closed_tick FROM missions WHERE colony_id = ? AND slot = ? ORDER BY id DESC LIMIT 1').get(c.id, slot);
    if (last && tick - last.closed_tick < M.refreshTicks) continue;
    const q = build(c.id, slot, tick);
    db.prepare('INSERT INTO missions (colony_id, slot, title, offers, created_tick, expires_tick) VALUES (?, ?, ?, ?, ?, ?)').run(c.id, slot, q.title, JSON.stringify(q.offers), tick, q.expires);
    store.addEvent(c.id, tick, 'info', `New mission: ${q.title}.`);
  }
}

// Fill one offer of an open mission from a district's stockpile.
function fill(c, { id, faction, district }, tick) {
  const fail = (error) => ({ ok: false, error });
  const q = db.prepare("SELECT * FROM missions WHERE id = ? AND colony_id = ? AND status = 'open'").get(Number(id), c.id);
  if (!q) return fail('That mission is no longer open.');
  const offer = JSON.parse(q.offers).find((o) => o.faction === faction);
  if (!offer) return fail('That faction made no such offer.');
  const have = store.loadInventory(c.id, district.id)[offer.good] || 0;
  const name = config.resources[offer.good].name;
  if (have < offer.qty) return fail(`Not enough ${name} in ${district.name}: ${offer.qty} needed.`);
  db.prepare('UPDATE colony_inventory SET amount = amount - ? WHERE district_id = ? AND resource_id = ?').run(offer.qty, district.id, offer.good);
  db.prepare('UPDATE colonies SET credits = credits + ? WHERE id = ?').run(offer.reward, c.id);
  db.prepare('INSERT INTO standing (colony_id, faction, points) VALUES (?, ?, ?) ON CONFLICT(colony_id, faction) DO UPDATE SET points = points + excluded.points').run(c.id, faction, offer.standing);
  db.prepare("UPDATE missions SET status = 'done', closed_tick = ?, filled_faction = ? WHERE id = ?").run(tick, faction, q.id);
  store.addEvent(c.id, tick, 'good', `Mission filled for the ${M.factions[faction].name}: ${offer.qty} ${name} for ${offer.reward} cr and ${offer.standing} standing.`);
  return { ok: true, reward: offer.reward, standing: offer.standing };
}

function view(c, tick) {
  const open = db.prepare("SELECT id, slot, title, offers, expires_tick FROM missions WHERE colony_id = ? AND status = 'open' ORDER BY slot").all(c.id)
    .map((q) => ({ id: q.id, slot: q.slot, title: q.title, offers: JSON.parse(q.offers), ticksLeft: Math.max(0, q.expires_tick - tick) }));
  const standing = Object.fromEntries(Object.keys(M.factions).map((f) => [f, 0]));
  for (const r of db.prepare('SELECT faction, points FROM standing WHERE colony_id = ?').all(c.id)) standing[r.faction] = r.points;
  const filled = db.prepare("SELECT COUNT(*) AS n FROM missions WHERE colony_id = ? AND status = 'done'").get(c.id).n;
  return { open, standing, total: Object.values(standing).reduce((a, b) => a + b, 0), filled };
}

module.exports = { advance, fill, view, build, hasFreePort, tradeGoods };
