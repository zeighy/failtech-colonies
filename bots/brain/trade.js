'use strict';
// Trading: selling on the orbital market (every profile's main objective), small purchases there, and for the port trader,
// steady business on the ground exchange. Quantities are kept modest and every order respects the colony's own needs: what
// it is saving for, the launch, and the stock kept back by the profile's sense of safety.
const { LAUNCH_GOODS, LAUNCH_INPUTS } = require('./endgame');

const randInt = (rng, [a, b]) => a + Math.floor(rng() * (b - a + 1));
const money = (n) => Math.round(n * 100) / 100;

class Trade {
  constructor(m, mem, P, ground, rng) { this.m = m; this.mem = mem; this.P = P; this.G = ground; this.rng = rng; this.config = m.config; mem.trade = mem.trade || { sold: 0, bought: 0, surfaceSold: 0, surfaceBought: 0 }; this.t = mem.trade; }

  isOrbital(g) { return !!this.config.resources[g].orbitalTrade; }
  isTrade(g) { return !!this.config.resources[g].trade; }
  market() { return this.m.v.orbital.market; }
  station() { return this.m.v.orbital.station; }
  sd() { return this.m.v.views[this.station().districtId]; }

  // ---- what to sell in orbit ----------------------------------------------------------------------------------------
  // Orbital goods are sold from wherever they are; trade goods have to be brought up, so one or two are chosen: the Free
  // Port's most plentiful, never the launch goods or what the launch goods are made of while the launch is still to come.
  chooseSelling() {
    const m = this.m;
    const mode = this.P.orbitSell.goods;
    const out = [];
    if (mode === 'orbital' || mode === 'any') for (const g of Object.keys(this.config.orbitalRecipes)) if (m.amount(this.sd(), g) >= 1) out.push(g);
    if (mode === 'trade' || mode === 'any' || (mode === 'orbital' && !out.length && this.mem.orbitalSoldNothingFor > 2000)) {
      const fp = m.byType('freeport');
      const keep = new Set([...LAUNCH_INPUTS, ...LAUNCH_GOODS]);
      const pool = fp ? Object.keys(this.config.resources).filter((g) => this.isTrade(g) && !keep.has(g)).map((g) => [g, m.amount(fp, g) + m.amount(m.core(), g) + m.amount(this.sd(), g)]) : [];
      // the launch inputs are fair game too, once the station is up, when there is plenty
      for (const g of LAUNCH_INPUTS) if (fp) pool.push([g, Math.max(0, m.amount(fp, g) - 200)]);
      pool.sort((a, b) => b[1] - a[1]);
      const already = (this.mem.selling || []).filter((g) => this.isTrade(g) && pool.some(([x, n]) => x === g && n >= 5));
      const pick = already.length ? already : pool.filter(([, n]) => n >= 30).slice(0, 1).map(([g]) => g);
      out.push(...pick.slice(0, 1));
    }
    this.mem.selling = out;
    return out;
  }

  // Trade goods sold in orbit travel Free Port -> Core by route, then up a link (the orbit module raises the link).
  async feed(goods) {
    const m = this.m;
    const fp = m.byType('freeport');
    if (!fp || !this.G.every(10)) return;
    for (const g of goods) {
      if (!this.isTrade(g) || LAUNCH_GOODS.includes(g)) continue;
      const keep = LAUNCH_INPUTS.includes(g) ? 200 : 20;
      const cur = m.route(fp, m.core(), g);
      if (!cur) await this.G.routes([['freeport', 'core', g, 4, keep]]);
    }
  }

  priceFor(g, side) {
    const x = (this.market().goods || []).find((y) => y.resource === g);
    if (!x) return null;
    const ref = x.reference;
    const [lo, hi] = x.band;
    const S = this.P.orbitSell;
    let p;
    if (side === 'buy') p = ref * (this.P.orbitBuy.maxRef - 0.06);
    else if (S.price === 'band') p = ref * (S.band[0] + this.rng() * (S.band[1] - S.band[0])); // drawn fresh for every order
    else if (S.price === 'under') {
      const best = (x.asks || []).filter((a) => !a.mine)[0];
      p = best ? Math.min(best.price - 0.01, ref * 1.1) : ref * 1.05;
      p = Math.max(p, ref * 0.9);
    } else p = ref;
    return money(Math.min(hi, Math.max(lo, p)));
  }

  async orbitSell() {
    const m = this.m;
    const mk = this.market();
    if (!mk) return;
    const goods = this.chooseSelling();
    await this.feed(goods);
    const mine = mk.orders || [];
    let open = mine.length;
    for (const g of goods) {
      if (open >= mk.maxOpenOrders - 2) break;
      if (mine.filter((o) => o.resource === g && o.side === 'sell').length >= 2) continue;
      const fixedKeep = { frames: 150, fittings: 100 }[g] || 0;
      const avail = Math.floor(m.amount(this.sd(), g) - Math.max(this.P.orbitSell.keep && !this.isOrbital(g) ? this.P.orbitSell.keep : 0, fixedKeep));
      if (avail < this.P.orbitSell.lot[0]) continue;
      const qty = Math.min(avail, randInt(this.rng, this.P.orbitSell.lot));
      const price = this.priceFor(g, 'sell');
      if (!price) continue;
      if (await m.act('orbit-market', { resource: g, side: 'sell', price, qty, ttl: mk.ttlOptions[1] })) { open++; this.t.sold += qty; this.mem.events.push(`orbit: sell ${qty} ${g} at ${price}`); }
    }
    if (goods.some((g) => this.isOrbital(g))) this.mem.orbitalSoldNothingFor = 0;
    else this.mem.orbitalSoldNothingFor = (this.mem.orbitalSoldNothingFor || 0) + this.mem.cadence;
  }

  // Small purchases: a cheap ask is taken; otherwise now and then a small bid rests a little under the reference.
  async orbitBuy() {
    const m = this.m;
    const mk = this.market();
    const B = this.P.orbitBuy;
    if (!mk || !B || !this.G.every(40)) return;
    const mine = mk.orders || [];
    if (mine.length >= mk.maxOpenOrders - 1) return;
    const held = new Set(this.station().storage.slots.filter((s) => s.resource).map((s) => s.resource));
    const wanted = B.goods === 'rare_inputs' ? ['precision_tools', 'frames', 'fittings', ...Object.keys(this.config.orbitalRecipes).filter((g) => held.has(g))]
      : B.goods === 'trade' ? [...held].filter((g) => this.isTrade(g))
        : [...held].filter((g) => this.isTrade(g) || this.isOrbital(g));
    const budget = m.colony.credits * B.budget - mine.filter((o) => o.side === 'buy').reduce((n, o) => n + o.price * o.remaining, 0);
    const cands = wanted.filter((g) => held.has(g) && !mine.some((o) => o.resource === g && o.side === 'buy'));
    if (!cands.length || budget <= 0) return;
    const g = cands[Math.floor(this.rng() * cands.length)];
    const x = (mk.goods || []).find((y) => y.resource === g);
    if (!x) return;
    const ask = (x.asks || []).find((a) => !a.mine);
    let price; let qty = randInt(this.rng, B.lot);
    if (ask && ask.price <= x.reference * B.maxRef) { price = ask.price; qty = Math.min(qty, ask.qty); } else if (this.rng() < 0.4) price = this.priceFor(g, 'buy'); else return;
    if (!price || price * qty > budget) return;
    if (await m.act('orbit-market', { resource: g, side: 'buy', price, qty, ttl: mk.ttlOptions[1] })) { this.t.bought += qty; this.mem.events.push(`orbit: buy ${qty} ${g} at ${price}`); }
  }

  // ---- the ground exchange (the port trader) -------------------------------------------------------------------------
  async surface() {
    const m = this.m;
    const S = this.P.surface;
    const x = m.v.exchange;
    if (!S || !x || !x.unlocked || !this.G.every(8)) return;
    const mine = x.orders || [];
    if (mine.length >= Math.min(S.maxOrders, this.config.exchange.maxOpenOrders - 1)) return;
    const fp = m.byType('freeport');
    const core = m.core();
    const ttl = this.config.exchange.ttlOptions[2];
    // what can be sold: trade goods at the port beyond a working stock; and Core goods pressing on the storage cap
    const sells = [];
    if (fp) for (const g of Object.keys(this.config.resources).filter((r) => this.isTrade(r))) {
      const keep = LAUNCH_INPUTS.includes(g) || LAUNCH_GOODS.includes(g) ? 250 : 30;
      const spare = Math.floor((m.amount(fp, g) - keep) * S.sellShare);
      if (spare >= S.lot[0]) sells.push([fp, g, spare]);
    }
    const cap = m.cap(core);
    for (const g of ['machined_parts', 'building_materials', 'alloys', 'ingots', 'polymers', 'fuel', 'biomass', 'meals']) {
      const spare = Math.floor((m.amount(core, g) - cap * 0.6) * S.sellShare);
      if (spare >= S.lot[0]) sells.push([core, g, spare]);
    }
    const sellable = sells.filter(([, g]) => !mine.some((o) => o.resource === g && o.side === 'sell'));
    if (sellable.length) {
      const [d, g, spare] = sellable[Math.floor(this.rng() * sellable.length)];
      const ref = x.resources[g].ref;
      const qty = Math.min(spare, randInt(this.rng, S.lot));
      const price = money(ref * (S.spread[0] + this.rng() * (S.spread[1] - S.spread[0])));
      if (await m.act('market', { side: 'sell', resource: g, price, qty, ttl, district: d.id })) { this.t.surfaceSold += qty; this.mem.events.push(`exchange: sell ${qty} ${g} at ${price}`); }
    }
    // small buys of what the colony is short of, or what the port's workshops eat
    const shortList = ['circuits', 'polymers', 'ingots', 'reagents', 'medicine', 'alloys'].filter((g) => m.amount(core, g) < 150 && !mine.some((o) => o.resource === g && o.side === 'buy'));
    const budget = m.colony.credits * S.buyBudget - mine.filter((o) => o.side === 'buy').reduce((n, o) => n + (o.escrow || 0), 0);
    if (shortList.length && budget > 0 && this.rng() < 0.6) {
      const g = shortList[Math.floor(this.rng() * shortList.length)];
      const r = x.resources[g];
      const qty = randInt(this.rng, S.buyLot);
      const price = money(Math.min(r.ask || r.ref * 1.05, r.ref * 1.02));
      if (price * qty <= budget && await m.act('market', { side: 'buy', resource: g, price, qty, ttl, district: (fp && this.rng() < 0.5 ? fp : core).id })) { this.t.surfaceBought += qty; this.mem.events.push(`exchange: buy ${qty} ${g} at ${price}`); }
    }
  }

  async turn() {
    await this.surface();
    if (!this.station()) return;
    await this.orbitSell();
    await this.orbitBuy();
  }
}

module.exports = { Trade };
