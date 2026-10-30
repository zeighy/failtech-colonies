'use strict';
// Credit sinks and a soft limit on heavy buying, so a pile of credits cannot simply buy everything.
//  - Brokerage: each colony has a daily allowance of credits it can spend buying goods (exchange, orbital market, express
//    convoy) before a surcharge applies, rising in steps. Normal play never reaches it; stockpiling and cornering do. The
//    surcharge is burned (it goes to nobody).
//  - Rush: pay to finish a work order now. The price rises with every rush in the last day.
// Both use one small ledger of what each colony spent in the trailing window.
const store = require('./db');
const { db, config } = store;
const C = config.credits;

const since = (tick) => tick - C.windowTicks;
const spent = (colonyId, kind, tick) => db.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM credit_ledger WHERE colony_id = ? AND kind = ? AND tick > ?').get(colonyId, kind, since(tick)).n;
const count = (colonyId, kind, tick) => db.prepare('SELECT COUNT(*) AS n FROM credit_ledger WHERE colony_id = ? AND kind = ? AND tick > ?').get(colonyId, kind, since(tick)).n;
function record(colonyId, kind, tick, amount) { db.prepare('INSERT INTO credit_ledger (colony_id, tick, kind, amount) VALUES (?, ?, ?, ?)').run(colonyId, tick, kind, Math.round(amount)); }
function prune(tick) { if (tick % 100 === 0) db.prepare('DELETE FROM credit_ledger WHERE tick <= ?').run(tick - 2 * C.windowTicks); }

// ---- brokerage -----------------------------------------------------------------------
const allowance = (hubLevel) => C.brokerage.allowancePerHubLevel * Math.max(1, hubLevel);
const hubOf = (colonyId) => (db.prepare('SELECT hub_level FROM colonies WHERE id = ?').get(colonyId) || { hub_level: 1 }).hub_level;
// The surcharge on the next purchase, from what the colony has already bought in the window.
function brokerageRate(colonyId, tick) {
  const ratio = spent(colonyId, 'buy', tick) / allowance(hubOf(colonyId));
  let rate = 0;
  for (const t of C.brokerage.tiers) if (ratio >= t.over) rate = t.rate;
  return rate;
}
// A purchase of `cost` credits is about to be paid: the extra it carries, taken from the colony's credits (never below
// zero), and the spend counted. Returns the extra.
function chargeBuy(colonyId, tick, cost) {
  const extra = Math.round(cost * brokerageRate(colonyId, tick));
  const have = db.prepare('SELECT credits FROM colonies WHERE id = ?').get(colonyId).credits;
  const take = Math.min(extra, Math.max(0, have));
  if (take > 0) db.prepare('UPDATE colonies SET credits = credits - ? WHERE id = ?').run(take, colonyId);
  record(colonyId, 'buy', tick, cost);
  return take;
}

// ---- rush ----------------------------------------------------------------------------
const rushPerTick = (kind) => C.rush.perTick[kind] || C.rush.perTick.build;
function rushCost(colonyId, kind, remaining, tick) {
  const n = Math.max(0, remaining - 1);
  return Math.round(n * rushPerTick(kind) * (1 + C.rush.surgePerRush * count(colonyId, 'rush', tick)));
}

function view(colonyId, hubLevel, tick) {
  const s = spent(colonyId, 'buy', tick), a = allowance(hubLevel);
  return {
    windowTicks: C.windowTicks,
    brokerage: { spent: s, allowance: a, rate: brokerageRate(colonyId, tick), tiers: C.brokerage.tiers },
    rush: { rushes: count(colonyId, 'rush', tick), surge: C.rush.surgePerRush },
  };
}

module.exports = { record, prune, spent, brokerageRate, chargeBuy, rushCost, view, allowance };
