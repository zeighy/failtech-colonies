'use strict';
// What a bot knows about its colony: the view the server sends a player's client (src/state.js viewFor), read through a few
// helpers, plus the game config. Nothing here reads the database: the bot runner is a separate process and plays over HTTP.
// Every successful action returns a fresh view, which replaces the old one, so decisions later in a turn see what earlier
// ones did.
const sim = require('../../src/sim');

class Colony {
  constructor({ config, api, log, maxActions = 40 }) {
    this.config = config;
    this.api = api;
    this.log = log || (() => {});
    this.v = null;
    this.acted = 0;
    this.maxActions = maxActions; // a turn never floods the server
    this.failures = [];
    this.neigh = {};
  }

  async refresh() { this.v = await this.api.state(); return this.v; }

  // One game action. True when the server took it. A refused action is noted (the brain often tries things that may not fit).
  async act(route, body = {}) {
    if (this.acted >= this.maxActions) return false;
    this.acted++;
    let r;
    try { r = await this.api.act(route, body); } catch (e) { this.failures.push(`${route}: ${e.message}`); return false; }
    if (r && r.ok) {
      if (r.state) this.v = r.state;
      this.lastResult = r;
      return true;
    }
    this.failures.push(`${route}: ${(r && r.error) || 'refused'}`);
    return false;
  }

  // ---- places -------------------------------------------------------------------------------------------------------
  get tick() { return this.v.tick; }
  get colony() { return this.v.colony; }
  get hub() { return this.v.colony.hubLevel; }
  isGround(type) { return type === 'core' || !!(this.config.districtTypes || {})[type]; }
  places() { return this.v.districts.filter((d) => this.isGround(d.type)).map((d) => this.v.views[d.id]); }
  all() { return this.v.districts.map((d) => this.v.views[d.id]).filter(Boolean); }
  byType(t) { const d = this.v.districts.find((x) => x.type === t); return d ? this.v.views[d.id] : null; }
  core() { return this.byType('core'); }
  station() { return this.byType('station'); }
  meta(d) { return this.v.districts.find((x) => x.id === d.id); }
  levels() { return Object.fromEntries(this.places().map((d) => [d.type, d.level])); }

  // ---- stock --------------------------------------------------------------------------------------------------------
  amount(d, r) { return ((d.resources || {})[r] || {}).amount || 0; }
  net(d, r) { return ((d.resources || {})[r] || {}).net || 0; }
  inv(d) { return Object.fromEntries(Object.entries(d.resources || {}).map(([r, x]) => [r, x.amount || 0])); }
  can(d, cost, extra = 1) { return Object.entries(cost || {}).every(([r, a]) => r === 'credits' ? this.colony.credits >= a * extra : this.amount(d, r) >= a * extra); }
  cap(d) { return d.cap || 0; }

  // ---- buildings and orders -----------------------------------------------------------------------------------------
  buildings(d) { return d.buildings || []; }
  orders(d) { return d.orders || []; }
  waiting(d) { return this.orders(d).filter((o) => o.state === 'queued'); }
  busy(d) { return this.orders(d).some((o) => o.state !== 'queued'); }
  count(d, type) {
    return this.buildings(d).filter((b) => b.type === type).length
      + this.orders(d).filter((o) => (o.kind === 'build' || o.kind === 'replace') && o.data.type === type).length;
  }
  countAll(type) { return this.all().reduce((n, d) => n + this.count(d, type), 0); }
  hasBuilt(type) { return this.all().some((d) => this.buildings(d).some((b) => b.type === type)); }
  ordered(type) { return this.all().some((d) => this.orders(d).some((o) => o.data && o.data.type === type)); }
  def(type) { return this.config.buildings[type]; }

  // plots taken by a building, an order or a slot that is still being cleared
  used(d) {
    const taken = new Set(this.buildings(d).map((b) => `${b.ring}:${b.slot}`));
    for (const o of this.orders(d)) if ((o.kind === 'build' || o.kind === 'replace') && o.data.ring !== undefined) taken.add(`${o.data.ring}:${o.data.slot}`);
    for (const l of d.locks || []) taken.add(`${l.ring}:${l.slot}`);
    return taken;
  }
  rings(d) { return sim.levelDef(this.config, d.type, d.level).ringCapacities; }
  plotOf(d, ring) { return sim.plotSize(this.config, ring, d.type); }
  freePlots(d) { const caps = this.rings(d); return Object.values(caps).reduce((a, b) => a + b, 0) - this.used(d).size; }
  buildable(type, dtype) { const def = this.def(type); return !!def && sim.buildableIn(def, dtype); }
  neighbours(dtype) { return (this.neigh[dtype] = this.neigh[dtype] || sim.buildNeighborMap(this.config, dtype)); }

  // The smallest free plot the building fits; failing that (unless the building insists), the biggest free one.
  place(d, type, { plot: wantPlot, reserved = [] } = {}) {
    const def = this.def(type);
    if (!def) return null;
    const caps = this.rings(d);
    const rings = Object.keys(caps).map(Number);
    const fits = rings.filter((r) => (wantPlot ? this.plotOf(d, r) === wantPlot : this.plotOf(d, r) >= (def.minPlotSize || 1))).sort((a, b) => a - b);
    const rest = wantPlot || def.strictPlot ? [] : rings.filter((r) => !fits.includes(r)).sort((a, b) => b - a);
    const taken = this.used(d);
    for (const r of [...fits, ...rest]) for (let sl = 0; sl < caps[r]; sl++) if (!taken.has(`${r}:${sl}`) && !reserved.includes(`${r}:${sl}`)) return { ring: r, slot: sl };
    return null;
  }
  // A free plot the building fits properly (no undersized plot)
  roomFor(d, type, opts) { const pos = this.place(d, type, opts); return pos && this.plotOf(d, pos.ring) >= (this.def(type).minPlotSize || 1) ? pos : null; }

  // ---- logistics ----------------------------------------------------------------------------------------------------
  routes() { return this.v.routes || []; }
  route(from, to, res) { return this.routes().find((r) => r.fromDistrict === from.id && r.toDistrict === to.id && r.resource === res); }
  shipments() { return this.v.shipments || []; }
  link(d) { const m = this.meta(d); return m && m.link; }
  essentialFood() { return ['clean_water', 'rations']; }
}

module.exports = { Colony };
