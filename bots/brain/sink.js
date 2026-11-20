'use strict';
// The money pit (profile.sink): a settled colony with credits to spare takes goods off the orbital market so that what
// players and bots list there finds a buyer on a slow day. Past `sink.from` credits, every `sink.every` ticks it takes a
// few units from the cheapest ask another station has listed (never the market maker's: those are not stuck, and buying
// them would only burn credits) for the good with the most units waiting, at no more than `sink.maxRef` times the
// reference. Orbital goods come first; with `goods: 'orbital_first'`, trade goods are taken (in bigger lots: they are far
// cheaper) only when no orbital good qualifies, so the money does not sit idle. What it buys is jettisoned from the
// station: a slot is dumped once it holds `sink.dumpAt` units (`tradeDumpAt` for trade goods), or when a new good needs its
// room, and rebuilt at once.
const { FIXED } = require('./orbit');

const KEEP = new Set([...FIXED, 'modules']); // what the station runs on and upgrades with: never bought to be thrown away
const randInt = (rng, [a, b]) => a + Math.floor(rng() * (b - a + 1));

class Sink {
  constructor(m, mem, P, rng) {
    this.m = m; this.mem = mem; this.P = P; this.S = P.sink; this.rng = rng; this.config = m.config;
    this.k = mem.sink = mem.sink || { bought: 0, spent: 0, dumped: 0, at: 0, goods: [] };
  }

  station() { return this.m.v.orbital && this.m.v.orbital.station; }
  slots() { return this.station().storage.slots; }
  isOrbital(g) { return !!(this.config.resources[g] || {}).orbitalTrade; }
  // 0: an orbital good, 1: a trade good (only when no orbital good qualifies, for 'orbital_first'), null: not taken
  tier(g) {
    const r = this.config.resources[g];
    if (!r || KEEP.has(g)) return null;
    if (r.orbitalTrade) return 0;
    if (!r.trade || this.S.goods === 'orbital') return null;
    return this.S.goods === 'any' ? 0 : 1;
  }
  dumpAt(g) { return this.isOrbital(g) ? this.S.dumpAt : this.S.tradeDumpAt || this.S.dumpAt; }
  canRebuild() { return this.m.can(this.m.stationView(), this.config.orbital.storage.rebuildCost); }

  // Jettison one slot of goods it bought (and rebuild it). `force`: the fullest one, whatever it holds.
  async dump(force = false) {
    const m = this.m;
    const mine = this.slots().filter((s) => s.state === 'open' && s.resource && this.k.goods.includes(s.resource) && s.kind !== 'hc' && s.amount >= 1);
    // (forced: the slot that has gathered most towards its dump goes)
    const s = mine.filter((x) => force || x.amount >= this.dumpAt(x.resource)).sort((a, b) => b.amount / this.dumpAt(b.resource) - a.amount / this.dumpAt(a.resource))[0];
    if (!s || !this.canRebuild()) return false;
    if (!await m.act('jettison', { slot: s.idx })) return false;
    this.k.dumped += s.amount;
    this.mem.events.push(`jettisoned ${s.amount} ${s.resource} (bought to clear the market)`);
    return m.act('rebuild-slot', { slot: s.idx });
  }

  async turn() {
    const m = this.m;
    if (!this.S || !this.station()) return;
    await this.dump();
    const mk = m.v.orbital.market;
    if (!mk || m.colony.credits < this.S.from || m.tick - this.k.at < this.S.every) return;
    if ((mk.orders || []).length >= mk.maxOpenOrders - 1) return;
    // the good with the most units other stations are waiting to sell, within the price limit: orbital goods first
    let best = null;
    for (const x of mk.goods || []) {
      const tier = this.tier(x.resource);
      if (tier === null) continue;
      const asks = (x.asks || []).filter((a) => !a.mine && !a.maker && a.price <= x.reference * this.S.maxRef).sort((a, b) => a.price - b.price);
      const listed = asks.reduce((n, a) => n + a.qty, 0);
      if (!asks.length) continue;
      const better = !best || tier < best.tier || (tier === best.tier && (listed > best.listed || (listed === best.listed && asks[0].price < best.ask.price)));
      if (better) best = { g: x.resource, ask: asks[0], listed, tier };
    }
    if (!best) return;
    const room = () => this.slots().some((s) => s.resource === best.g) || this.slots().some((s) => !s.resource && s.state === 'open');
    if (!room() && !await this.dump(true)) return; // (a slot dumped is rebuilt empty at once)
    const qty = Math.min(randInt(this.rng, this.isOrbital(best.g) ? this.S.lot : this.S.tradeLot || this.S.lot), best.ask.qty);
    if (await m.act('orbit-market', { resource: best.g, side: 'buy', price: best.ask.price, qty, ttl: mk.ttlOptions[0] })) {
      this.k.at = m.tick;
      this.k.bought += qty;
      this.k.spent += Math.round(qty * best.ask.price);
      if (!this.k.goods.includes(best.g)) this.k.goods.push(best.g);
      this.mem.events.push(`orbit: took ${qty} ${best.g} at ${best.ask.price} off the market`);
    }
  }
}

module.exports = { Sink, KEEP };
