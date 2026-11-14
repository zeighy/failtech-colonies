'use strict';
// Market intervention from the admin panel, kept in the meta table:
//   frozen    { ground, orbit }: a frozen market takes no new orders and matches nothing (orders already open stay open,
//             holding what they hold, and still expire); cancelling stays possible
//   adjust    { resource: multiplier }: shifts that good's reference price (and so the market makers' quotes and the price
//             band players may post in) on the ground exchange and in orbit. Goods made from it follow, as they always do.
// The multipliers live on config.exchange.adminMult, where src/marketsim.js reads them.
const store = require('./db');
const { config } = store;

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } };

function frozen(kind) { return !!parse(store.getMeta('market_frozen'), {})[kind]; }
function setFrozen(kind, on) {
  const f = parse(store.getMeta('market_frozen'), {});
  f[kind] = !!on;
  store.setMeta('market_frozen', JSON.stringify(f));
}
const frozenAll = () => ({ ground: frozen('ground'), orbit: frozen('orbit') });

function adjustments() { return parse(store.getMeta('market_adjust'), {}); }
function load() { config.exchange.adminMult = adjustments(); }
// mult 1 (or null) clears it. Kept between 0.1 and 10.
function setAdjust(res, mult) {
  if (!Object.prototype.hasOwnProperty.call(config.resources, res)) return { ok: false, error: 'Unknown resource.' };
  const a = adjustments();
  const m = Number(mult);
  if (mult === null || mult === undefined || m === 1) delete a[res];
  else if (!Number.isFinite(m) || m < 0.1 || m > 10) return { ok: false, error: 'Multiplier must be between 0.1 and 10.' };
  else a[res] = Math.round(m * 1000) / 1000;
  store.setMeta('market_adjust', JSON.stringify(a));
  load();
  return { ok: true, adjust: a };
}

load();
module.exports = { frozen, setFrozen, frozenAll, adjustments, setAdjust, load };
