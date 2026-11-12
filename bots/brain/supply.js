'use strict';
// Keeping goods moving once the colony is big. Two habits a careful player has and a fixed plan does not:
//   * a line whose every output sits at the storage cap is switched off (it only eats inputs another line could use), and
//     switched back on once there is room again;
//   * a line held up for want of an input gets it: a route from a place holding plenty is raised, or, if nobody has any to
//     spare, another line is built where that input is made (and what feeds it). This is what grows the districts to feed
//     the Free Port's workshops and, through them, the launch.
const sim = require('../../src/sim');
const { REMOTE, FEED } = require('./ground');

const VITAL = new Set(['clean_water', 'rations', 'meals', 'unpurified_water', 'energy']);
const NEVER = new Set(['beacon_array', 'orbital_staging', 'orbital_catapult', 'orbital_command']);
// where an input is made, beyond the ground plan's REMOTE map
const MAKES = { ...REMOTE, biomass: ['greenbelt', 'bio_dome'], crude: ['stacks', 'crude_pump'], ore: ['pits', 'ore_drill'], raw_synthetics: ['stacks', 'polymer_plant'], scrap: [null, 'scrap_extractor'] };

class Supply {
  constructor(m, mem, P, ground) { this.m = m; this.mem = mem; this.P = P; this.G = ground; this.config = m.config; mem.supply = mem.supply || { paused: [], at: {}, extras: {} }; this.s = mem.supply; }

  outputsOf(b) {
    const def = this.m.def(b.type);
    if (b.recipe && def.alternatives && def.alternatives[b.recipe]) return def.alternatives[b.recipe].outputsPerTick || {};
    if (b.recipe && def.recipeBuilding) return ((this.config.recipes || {})[b.recipe] || {}).outputsPerTick || {};
    return def.outputsPerTick || {};
  }

  inputsOf(b) {
    const def = this.m.def(b.type);
    if (b.recipe && def.alternatives && def.alternatives[b.recipe]) return def.alternatives[b.recipe].inputsPerTick || {};
    if (b.recipe && def.recipeBuilding) return ((this.config.recipes || {})[b.recipe] || {}).inputsPerTick || {};
    return def.inputsPerTick || {};
  }

  async capPause() {
    const m = this.m;
    this.short = new Set(this.shortages().filter((x) => !x.cost).map((x) => x.r));
    for (const d of m.places()) {
      const cap = m.cap(d);
      for (const b of m.buildings(d)) {
        const def = m.def(b.type);
        if (!def || NEVER.has(b.type) || def.housing || def.type === 'generator') continue;
        const outs = Object.keys(this.outputsOf(b)).filter((r) => r !== 'energy');
        if (!outs.length || outs.some((r) => VITAL.has(r))) continue;
        const mine = this.s.paused.includes(b.id);
        // plenty everywhere, and it eats something another line is short of (Pits turning every ingot into alloys while the
        // Free Port's tool steel waits for ingots)
        const total = (r) => m.places().reduce((n, x) => n + m.amount(x, r), 0);
        const ins = Object.keys(this.inputsOf(b)).filter((r) => r !== 'energy');
        const glut = outs.every((r) => total(r) >= cap * 1.5) && ins.some((r) => this.short.has(r));
        if (!b.paused && (glut || outs.every((r) => m.amount(d, r) >= cap * 0.95))) {
          if (await m.act('toggle', { ring: b.ring, slot: b.slot, paused: true, district: d.id })) this.s.paused.push(b.id);
        } else if (b.paused && mine && outs.some((r) => m.amount(d, r) < cap * 0.8) && !glut) {
          if (await m.act('toggle', { ring: b.ring, slot: b.slot, paused: false, district: d.id })) this.s.paused = this.s.paused.filter((x) => x !== b.id);
        }
      }
    }
    const ids = new Set(m.places().flatMap((d) => m.buildings(d).map((b) => b.id)));
    this.s.paused = this.s.paused.filter((x) => ids.has(x));
  }

  // The inputs each place's lines are short of, most wanted first.
  shortages() {
    const m = this.m;
    const out = [];
    for (const d of m.places()) {
      const seen = {};
      for (const b of m.buildings(d)) {
        if (b.paused || b.eff === undefined || b.eff >= 0.6) continue;
        const r = b.limiting;
        if (!r || !this.config.resources[r] || VITAL.has(r)) continue;
        seen[r] = (seen[r] || 0) + 1;
      }
      for (const [r, n] of Object.entries(seen)) out.push({ d, r, n, prio: (d.type === 'freeport' ? 3 : 0) + n });
    }
    // and what a build or an upgrade is waiting for that nobody could send (see Ground.topUp)
    for (const [k, at] of Object.entries(this.mem.costShort || {})) {
      if (m.tick - at > 60) { delete this.mem.costShort[k]; continue; }
      const [did, r] = k.split(':');
      const d = m.v.views[did];
      if (d && this.config.resources[r] && !out.some((x) => x.d.id === d.id && x.r === r)) out.push({ d, r, n: 1, prio: 2, cost: true });
    }
    return out.sort((a, b) => b.prio - a.prio);
  }

  async feed() {
    const m = this.m;
    const G = this.G;
    let acted = 0;
    for (const { d, r, cost } of this.shortages()) {
      if (acted >= 2) break;
      const key = `${d.id}:${r}`;
      if (this.s.at[key] && m.tick - this.s.at[key] < 60) continue;
      const here = m.v.views[d.id];
      if (m.amount(here, r) > 100) continue; // it is arriving; the lines will catch up
      this.s.at[key] = m.tick;
      acted++;
      // someone holds plenty: raise (or open) the route from them
      const donors = m.places().filter((x) => x.id !== d.id && m.amount(x, r) > 300).sort((a, b) => m.amount(b, r) - m.amount(a, r));
      if (donors.length) {
        if (cost) continue; // a one-off cost is shipped (Ground.topUp), not given a standing route
        const from = donors[0];
        const cur = m.route(from, here, r);
        const rate = Math.max(4, Math.ceil((cur ? cur.rate : 0) * 1.5) + 4);
        await G.routes([[from.type, here.type, r, rate, from.type === 'core' ? 150 : 100]], { soft: true, target: 600 });
        this.s.routes = [...new Set([...(this.s.routes || []), `${from.id}:${here.id}:${r}`])];
        continue;
      }
      // nobody has any to spare: buy a lot to keep things moving, and see to the supply as well
      await this.buy(here, r, r === 'frames' || r === 'fittings' || r === 'modules' ? 40 : 200);
      // another line where it is made
      // a trade good is made by another workshop at the Free Port
      const mk = this.config.resources[r].trade ? ['freeport', 'trade_workshop', r] : MAKES[r];
      if (!mk) continue;
      const home = mk[0] ? m.byType(mk[0]) : here;
      const type = mk[1];
      if (!home || !m.buildable(type, home.type)) continue;
      if (await this.expand(home, type, { forShortage: true })) { if (home.id !== here.id && !cost) await G.routes([[home.type, here.type, r, 8, 100]], { soft: true, target: 600 }); continue; }
      const ek = `${home.id}:${type}`;
      if ((this.s.extras[ek] || 0) >= 8 || m.orders(home).some((o) => o.data && o.data.type === type)) continue;
      if (G.shortHanded(type)) continue;
      if (!G.roomFor(home, type)) { G.missing(home, type); continue; }
      if (!m.can(home, m.def(type).cost)) { await G.topUp(home, m.def(type).cost); continue; }
      const pos = G.roomFor(home, type);
      if (mk[2] && m.waiting(home).length) continue; // (a workshop is not pushed ahead of the Free Port's own list)
      if (await G.build(home, type, { urgent: !mk[2], pos })) {
        if (mk[2]) ((this.mem.fp = this.mem.fp || { pending: {} }).pending)[`${pos.ring}:${pos.slot}`] = mk[2];
        this.s.extras[ek] = (this.s.extras[ek] || 0) + 1;
        this.mem.events.push(`more ${r}: another ${type} in ${home.type}`);
        // what feeds it, if its own input is not made there already
        const feed = FEED[type] || (type === 'bio_dome' ? 'water_pump' : null);
        const h2 = m.v.views[home.id];
        if (feed && G.roomFor(h2, feed) && m.net(h2, Object.keys(m.def(feed).outputsPerTick)[0]) < 10) await G.build(h2, feed);
        if (home.id !== here.id && !cost) await G.routes([[home.type, here.type, r, 6, 20]], { soft: true, target: 600 });
      }
    }
  }

  // Build upward: expand an existing building of this kind (the cheapest step first), paying with what the place holds and
  // having the rest (mostly the Free Port's trade goods) shipped over. True when an expansion was ordered or paid towards.
  async expand(d, type, { forShortage = false } = {}) {
    const m = this.m;
    const G = this.G;
    if (!m.byType('freeport')) return false; // expansions are paid in trade goods
    if (m.orders(d).some((o) => o.kind === 'expand') || m.waiting(d).length > 1) return false;
    const opts = m.buildings(d).filter((b) => b.type === type && b.xnext && !b.paused).sort((a, b) => a.level - b.level);
    const b = opts[0];
    if (!b) return false;
    if (G.shortHanded(type)) return false;
    // while the launch stock is building up, the launch goods are not spent on expansions
    if (!forShortage && this.mem.launchSaving && Object.keys(b.xnext.cost).some((r) => (this.mem.launchShort || {})[r])) return false;
    if (!m.can(d, b.xnext.cost)) { await G.topUp(d, b.xnext.cost); return true; }
    if (await m.act('expand', { ring: b.ring, slot: b.slot, district: d.id })) { this.mem.events.push(`expanded ${type} in ${d.type} to level ${b.xnext.level}`); return true; }
    return false;
  }

  // Buy what nobody in the colony can spare, on the ground exchange: a modest lot, into the place that needs it, never far
  // over the reference price and never more than a small share of the treasury. It breaks the late game's knots (link
  // upgrades paid in fittings that need the very goods the link would carry) the way a player with money would.
  async buy(d, r, want) {
    const m = this.m;
    const x = m.v.exchange;
    if (!x || !x.unlocked || !x.resources[r] || this.config.resources[r].orbitalOnly) return false;
    const credits = m.colony.credits;
    if (credits < 150000) return false; // a cushion stays: the convoy may have to feed the colony one day
    const mine = x.orders || [];
    if (mine.length >= this.config.exchange.maxOpenOrders - 1 || mine.some((o) => o.resource === r && o.side === 'buy')) return false;
    const q = x.resources[r];
    const price = Math.round(Math.min(q.ask || q.ref * 1.1, q.ref * 1.25) * 100) / 100;
    const qty = Math.max(1, Math.min(Math.ceil(want), this.config.exchange.maxQty, Math.floor(((credits - 150000) * 0.03) / price)));
    if (await m.act('market', { side: 'buy', resource: r, price, qty, ttl: this.config.exchange.ttlOptions[0], district: d.id })) {
      this.mem.events.push(`exchange: buy ${qty} ${r} for ${d.type} at ${price}`);
      (this.mem.trade = this.mem.trade || {}).boughtForSupply = ((this.mem.trade || {}).boughtForSupply || 0) + qty;
      return true;
    }
    return false;
  }

  // What the plan or survival asked for and found no plot for: an existing one of the kind is expanded instead.
  async wanted() {
    const m = this.m;
    for (const [k, at] of Object.entries(this.mem.wanted || {})) {
      if (m.tick - at > 40) continue;
      const [did, type] = k.split(':');
      const d = m.v.views[did];
      if (!d || !m.def(type) || !m.def(type).expand) continue;
      if (await this.expand(d, type)) { delete this.mem.wanted[k]; return; }
    }
  }

  // Routes the supply step opened that are no longer needed (the place holds plenty) are closed, freeing link room and slots.
  async tidy() {
    const m = this.m;
    const keep = [];
    for (const k of this.s.routes || []) {
      const [f, t, r] = k.split(':');
      const route = m.routes().find((x) => String(x.fromDistrict) === f && String(x.toDistrict) === t && x.resource === r);
      if (!route) continue;
      const dest = m.v.views[t];
      const limited = dest && m.buildings(dest).some((b) => b.limiting === r);
      if (dest && !limited && m.amount(dest, r) > 1500) { await m.act('route', { from: Number(f), to: Number(t), resource: r, rate: 0 }); continue; }
      keep.push(k);
    }
    this.s.routes = keep;
  }

  async turn() {
    if (this.G.every(50)) await this.tidy();
    if (this.G.every(5)) await this.capPause();
    if (this.m.v.colony.hubLevel >= 4 && this.G.every(10)) await this.feed();
    if (this.G.every(10)) await this.wanted();
  }
}

module.exports = { Supply, sim };
