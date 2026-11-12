'use strict';
// The orbital stage: the station's reactor and foundry, its few storage slots (jettisoning what is no longer wanted to free
// one), the links that bring ground goods up, dropship expeditions to the anomalous territories for rare resources, and
// foundry runs that turn them into orbital goods. Ported from scripts/playtest-orbit.js, but planned from the view each turn
// so a run, a trip or a ship the bot has no memory of (a restart, a colony taken over in orbit) is picked up as it stands.
const sim = require('../../src/sim');

const FIXED = ['power_cells', 'frames', 'fittings']; // the station always keeps a slot for power and for what slots are rebuilt with
const RAW = { scrap: 'scrap_extractor', unpurified_water: 'water_pump', raw_synthetics: 'synth_reclaimer', ore: 'ore_drill', crude: 'crude_pump' };
const REFINE = { clean_water: 'water_purifier', machined_parts: 'parts_assembler', ingots: 'smelter', fuel: 'cracking_tower', reagents: 'cracking_tower', polymers: 'polymer_plant' };

class Orbit {
  constructor(m, mem, P, ground) {
    this.m = m; this.P = P; this.G = ground; this.config = m.config; this.O = m.config.orbital;
    mem.orbit = mem.orbit || { run: null, trips: {}, expected: [], made: 0, bought: [] };
    this.o = mem.orbit;
    this.mem = mem;
  }

  get st() { return this.m.v.orbital.station; }
  get sd() { return this.m.v.views[this.st.districtId]; }
  slots() { return this.st.storage.slots; }
  sinv(r) { return this.m.amount(this.sd, r); }
  ships() { return (this.m.v.orbital.ships || {}).ships || []; }
  territories() { return (this.m.v.orbital.ships || {}).territories || []; }
  isRare(r) { return !!(this.config.resources[r] && this.config.resources[r].rare); }
  foundryMode() { return ['orbital', 'any'].includes(this.P.orbitSell.goods) || (this.P.projects || 0) >= 0.5; }

  // ---- global projects --------------------------------------------------------------------------------------------
  // What the open project still needs, for a profile that gives to projects.
  // `planning`: an announced project counts too, so the foundry is already making its goods when it opens.
  projectNeeds({ planning = false } = {}) {
    const p = this.m.v.orbital.project;
    if (!(this.P.projects > 0) || !p) return {};
    const open = p.status === 'active' && p.endsIn >= this.O.dropships.contributeTicks / 2 + 5;
    if (!open && !(planning && p.status === 'announced')) return {};
    const out = {};
    for (const [r, q] of Object.entries(p.needs || {})) { const left = q - ((p.contributed || {})[r] || 0); if (left > 0) out[r] = left; }
    return out;
  }
  async contribute() {
    const m = this.m;
    const need = this.projectNeeds();
    if (!Object.keys(need).length) return;
    // expeditions come first: a ship goes to the project only when no rare is waiting to be fetched
    const run = this.o.run;
    if (run && this.needsOf(run.good).rares.some((r) => !run.fetch[r])) return;
    const ship = this.ships().find((x) => x.state === 'docked' && x.integrity >= 60);
    if (!ship) return;
    const keep = { frames: 150, fittings: 100 };
    const cargo = {};
    let room = ship.hold;
    for (const [r, left] of Object.entries(need)) {
      const q = Math.min(left, room, Math.floor((this.sinv(r) - (keep[r] || 0)) * this.P.projects));
      if (q >= 1) { cargo[r] = q; room -= q; }
    }
    const total = Object.values(cargo).reduce((a, b) => a + b, 0);
    // a trip is worth making for a decent load, or for whatever orbital goods there are (they come a few at a time)
    const orbitalGoods = Object.keys(cargo).some((r) => this.config.resources[r].orbitalTrade);
    if (!total || (!orbitalGoods && total < 50)) return;
    if (await m.act('project-contribute', { ship: ship.id, cargo })) this.mem.events.push(`ship ${ship.num} to the global project with ${Object.entries(cargo).map(([r, q]) => `${q} ${r}`).join(', ')}`);
  }

  needsOf(good) {
    const inp = this.config.orbitalRecipes[good].inputsPerTick;
    const rares = Object.keys(inp).filter((r) => this.isRare(r)).sort((a, b) => inp[b] - inp[a]);
    const x = Object.keys(inp).find((r) => r !== 'energy' && !this.isRare(r));
    return { good, rares, per: inp, x };
  }

  // ---- storage slots ----------------------------------------------------------------------------------------------
  // What the station wants to keep a slot for: power, rebuild stock, the run under way, what ships bring, and what it sells.
  keepSet() {
    const k = new Set([...FIXED, ...this.o.expected]);
    const run = this.o.run;
    if (run) { const n = this.needsOf(run.good); n.rares.forEach((r) => k.add(r)); if (n.x) k.add(n.x); k.add(run.good); }
    for (const t of Object.values(this.o.trips)) (t.links || []).forEach((r) => k.add(r));
    for (const g of this.mem.selling || []) k.add(g);
    for (const g of Object.keys(this.projectNeeds())) k.add(g);
    for (const o of (this.m.v.orbital.market || {}).orders || []) k.add(o.resource);
    return k;
  }
  // Is there (or can there be made) a slot for this resource? Making one jettisons the least useful slot and rebuilds it.
  async room(res) {
    const all = this.slots();
    if (all.some((s) => s.resource === res)) return true;
    const waiting = this.o.expected.filter((r) => r !== res && !all.some((s) => s.resource === r)).length;
    if (all.filter((s) => !s.resource && s.state === 'open').length > waiting) return true;
    const keep = this.keepSet();
    const rebuild = this.O.storage.rebuildCost;
    // a slot already jettisoned is rebuilt first
    const gone = all.find((s) => s.state === 'jettisoned');
    if (gone && this.m.can(this.sd, rebuild)) return this.m.act('rebuild-slot', { slot: gone.idx });
    const victim = all.filter((s) => s.resource && s.state === 'open' && !keep.has(s.resource)).sort((a, b) => a.amount - b.amount)[0];
    if (!victim || !this.m.can(this.sd, rebuild)) return false;
    if (!await this.m.act('jettison', { slot: victim.idx })) return false;
    this.mem.events.push(`jettisoned ${victim.amount} ${victim.resource} to free a slot`);
    return this.m.act('rebuild-slot', { slot: victim.idx });
  }
  // Purge: a slot holding something nobody wants, kept full to the cap, goes even when no slot is asked for, so stock does
  // not sit there for ever (whatever arrives for it is lost anyway).
  async purge() {
    const keep = this.keepSet();
    const cap = this.st.storage.cap;
    for (const s of this.slots()) {
      if (!s.resource || s.state !== 'open' || keep.has(s.resource) || this.isRare(s.resource)) continue;
      if (s.amount < cap * 0.9 && s.amount >= 1) continue;
      if (this.m.routes().some((r) => r.resource === s.resource && (r.toDistrict === this.st.districtId || r.fromDistrict === this.st.districtId))) continue;
      if (!this.m.can(this.sd, this.O.storage.rebuildCost)) return;
      if (await this.m.act('jettison', { slot: s.idx })) { this.mem.events.push(`jettisoned ${s.amount} ${s.resource} (unwanted)`); await this.m.act('rebuild-slot', { slot: s.idx }); }
      return; // one a turn
    }
  }

  // ---- links between the Core and the station -------------------------------------------------------------------------
  async links() {
    const m = this.m;
    const core = m.core();
    const ST = this.st.districtId;
    const saving = this.o.saving || {};
    for (const r of [...this.o.expected]) if (!this.isRare(r) && this.slots().some((x) => x.resource === r)) this.o.expected = this.o.expected.filter((x) => x !== r);
    const want = []; // [resource, 'up' | 'down', target]
    const upRoutes = m.routes().filter((x) => x.toDistrict === ST);
    const up = (r, low, target) => {
      if (m.amount(core, r) < 5) return; // nothing to send
      if (this.sinv(r) < low || upRoutes.some((x) => x.resource === r && this.sinv(r) < target)) want.push([r, 'up', target]);
    };
    const reactorOn = m.buildings(this.sd).some((b) => b.type === 'klein_reactor' && !b.paused);
    up('power_cells', reactorOn ? 150 : 40, (reactorOn ? 400 : 100) + (saving.power_cells || 0));
    for (const t of Object.values(this.o.trips)) if (!t.recalled) for (const r of t.links || []) up(r, 250, 600);
    const run = this.o.run;
    if (run) { const n = this.needsOf(run.good); if (n.x && !FIXED.includes(n.x) && n.rares.every((r) => this.sinv(r) >= 1 || this.o.expected.includes(r))) up(n.x, 80, 300); }
    up('frames', 80 + (saving.frames || 0), 200 + (saving.frames || 0));
    up('fittings', 50 + (saving.fittings || 0), 120 + (saving.fittings || 0));
    if (saving.modules) up('modules', saving.modules, saving.modules + 20);
    for (const g of this.mem.selling || []) if (!this.config.resources[g].orbitalOnly) up(g, 20, 120);
    for (const g of Object.keys(this.projectNeeds())) if (!this.config.resources[g].orbitalOnly) up(g, 50, 400);
    const lv = this.st.links;
    const chosen = want.slice(0, lv.count);
    for (const x of m.routes()) {
      const orbitLink = (x.fromDistrict === ST && x.toDistrict === core.id) || (x.toDistrict === ST && x.fromDistrict === core.id);
      if (!orbitLink) continue;
      const dirn = x.toDistrict === ST ? 'up' : 'down';
      if (!chosen.some(([r, d]) => r === x.resource && d === dirn)) await m.act('route', { from: x.fromDistrict, to: x.toDistrict, resource: x.resource, rate: 0 });
    }
    for (const [r, d, target] of chosen) {
      const from = d === 'up' ? core.id : ST; const to = d === 'up' ? ST : core.id;
      if (m.routes().some((x) => x.fromDistrict === from && x.toDistrict === to && x.resource === r)) continue;
      if (d === 'up' && !await this.room(r)) continue;
      if (await m.act('route', { from, to, resource: r, rate: lv.rate, reserve: 0, target }) && d === 'up' && !this.o.expected.includes(r)) this.o.expected.push(r);
    }
  }

  // ---- the station's own buildings ----------------------------------------------------------------------------------
  async stationBuild() {
    const m = this.m;
    for (const t of ['klein_reactor', 'orbital_foundry']) {
      const sd = this.sd;
      if (m.count(sd, t)) continue;
      const pos = m.place(sd, t);
      if (pos) await m.act('build', { ...pos, type: t, district: sd.id });
    }
  }
  foundry() { return this.m.buildings(this.sd).find((x) => x.type === 'orbital_foundry'); }
  reactor() { return this.m.buildings(this.sd).find((x) => x.type === 'klein_reactor'); }
  async power(on) {
    const r = this.reactor();
    if (r && r.paused === on) await this.m.act('toggle', { ring: r.ring, slot: r.slot, paused: !on, district: this.sd.id });
  }

  // ---- planning a tap: how a territory's rare can be drawn with this ship ---------------------------------------------
  fdef(b) { return sim.territoryDef(this.config.buildings[b], 'territory'); }
  sources(r, want, have, linkRate, allowLink) {
    const out = [];
    if (RAW[r] && have.includes(r)) {
      const d = this.fdef(RAW[r]);
      for (let n = 1; n <= 3; n++) out.push({ supply: Math.min(want, n * d.outputsPerTick[r]), power: n * d.inputsPerTick.energy, builds: Array(n).fill(RAW[r]) });
    }
    if (REFINE[r]) {
      const d = this.fdef(REFINE[r]);
      const from = Object.keys(d.inputsPerTick).find((k) => k !== 'energy');
      if (from && RAW[from] && have.includes(from)) {
        const e = this.fdef(RAW[from]);
        for (let k = 1; k <= 3; k++) {
          const n = Math.ceil((k * d.inputsPerTick[from]) / e.outputsPerTick[from]);
          out.push({ supply: Math.min(want, k * d.outputsPerTick[r]), power: k * d.inputsPerTick.energy + n * e.inputsPerTick.energy, builds: [...Array(n).fill(RAW[from]), ...Array(k).fill(REFINE[r])] });
        }
      }
    }
    // a linked input comes from the Core by way of the station: only worth planning on when the Core holds plenty of it
    if (allowLink && this.m.amount(this.m.core(), r) >= 400) out.push({ supply: Math.min(want, linkRate), power: 0, builds: [], link: r });
    return out;
  }
  planTap(t, ship, allowLinks) {
    const an = t.anomaly;
    const power = Math.round(ship.power * (an.powerMult || 1));
    const have = [t.resources.common1, t.resources.common2, t.resources.district];
    const kit = this.O.dropships.starterKit;
    const tap = this.config.buildings.t_tap;
    let best = null;
    for (const [rid, rec] of Object.entries(this.config.tapRecipes)) {
      if (rec.rare !== t.resources.rare) continue;
      const ins = Object.keys(rec.inputsPerTick).filter((k) => k !== 'energy');
      for (const plot of [3, 2]) {
        const batch = this.config.tradeWorks.batchByPlot[plot];
        const o1 = this.sources(ins[0], rec.inputsPerTick[ins[0]] * batch, have, ship.linkRate, allowLinks > 0);
        const o2 = this.sources(ins[1], rec.inputsPerTick[ins[1]] * batch, have, ship.linkRate, allowLinks > 0);
        for (const a of o1) for (const b of o2) {
          const links = [a.link, b.link].filter(Boolean);
          if (links.length > Math.min(allowLinks, this.O.dropships.maxLinks)) continue;
          const builds = [...a.builds, ...b.builds];
          const parts = builds.reduce((n, x) => n + this.fdef(x).cost.machined_parts, 0) + tap.cost.machined_parts;
          const mats = builds.reduce((n, x) => n + this.fdef(x).cost.building_materials, 0) + tap.cost.building_materials;
          if (parts > kit.machined_parts || mats > kit.building_materials || builds.length > 7) continue;
          const eff = Math.min(a.supply / (rec.inputsPerTick[ins[0]] * batch), b.supply / (rec.inputsPerTick[ins[1]] * batch));
          const demand = rec.inputsPerTick.energy * batch * eff + a.power + b.power;
          const sat = Math.min(1, power / demand);
          const rate = rec.outputsPerTick[rec.rare] * batch * eff * sat * (an.rareMult || 1);
          const cand = { recipe: rid, plot, builds, links, rate };
          if (!best || rate > best.rate + 1e-9 || (Math.abs(rate - best.rate) < 1e-9 && links.length < best.links.length)) best = cand;
        }
      }
    }
    return best;
  }
  tripFor(rare, ship, allowLinks) {
    let best = null;
    for (const t of this.territories()) {
      if (t.taken || t.resources.rare !== rare || (t.anomaly.damagePerTick || 0) > 0) continue;
      const plan = this.planTap(t, ship, allowLinks);
      if (!plan || plan.rate < 0.2) continue;
      const usable = t.ticksLeft - this.O.dropships.deployTicks - 30;
      if (usable < 120) continue;
      if (!best || plan.rate > best.plan.rate) best = { t, plan, usable };
    }
    return best;
  }

  // ---- runs: one orbital good at a time, its rare resources fetched by the ships -----------------------------------------
  flexSlots() { return this.st.storage.slots.filter((s) => s.state === 'open' || s.state === 'jettisoned').length - FIXED.length - (this.mem.selling || []).filter((g) => !FIXED.includes(g)).length; }
  chooseRun(ship) {
    const cands = [];
    for (const g of Object.keys(this.config.orbitalRecipes)) {
      const need = this.needsOf(g);
      const base = need.rares.length + 1 + (need.x && !FIXED.includes(need.x) ? 1 : 0);
      if (base > this.flexSlots()) continue;
      const allowLinks = Math.min(this.O.dropships.maxLinks, this.flexSlots() - base);
      const plans = need.rares.map((r) => (this.sinv(r) >= 100 ? { plan: { rate: 9 } } : this.tripFor(r, ship, allowLinks)));
      if (plans.some((p) => !p)) continue;
      cands.push({ good: g, allowLinks, score: Math.min(...plans.map((p) => p.plan.rate)) });
    }
    // what the market pays most for (its reference price), then what can be fetched fastest
    const ref = (g) => { const x = ((this.m.v.orbital.market || {}).goods || []).find((y) => y.resource === g); return x ? x.reference : 0; };
    const wanted = this.projectNeeds({ planning: true });
    const worth = (c) => c.score * ref(c.good) * (wanted[c.good] ? 3 : 1);
    cands.sort((a, b) => worth(b) - worth(a));
    return cands[0] || null;
  }
  targetFor(good, rare, ship) {
    const n = this.needsOf(good);
    const most = Math.max(...n.rares.map((r) => n.per[r]));
    return Math.floor(ship.hold * n.per[rare] / most);
  }

  async dispatch() {
    const m = this.m;
    for (const ship of this.ships()) {
      if (ship.state !== 'docked') continue;
      if (ship.integrity < 60) { if (ship.repairCost && m.colony.credits > (ship.repairCost.credits || 0) * 3) await m.act('ship-repair', { ship: ship.id }); continue; }
      // the run that still lacks a rare nobody has gone for
      let run = this.o.run;
      if (run && run.done) run = this.o.run = null;
      if (!run) {
        const c = this.chooseRun(ship);
        if (!c) continue;
        run = this.o.run = { good: c.good, allowLinks: c.allowLinks, fetch: {}, startedAt: m.tick };
        this.mem.events.push(`plan: ${c.good}`);
      }
      const need = this.needsOf(run.good);
      for (const r of need.rares) if (this.sinv(r) >= this.targetFor(run.good, r, ship) * 0.8) run.fetch[r] = 'home';
      const rare = need.rares.find((x) => !run.fetch[x]);
      if (!rare) continue;
      const pick = this.tripFor(rare, ship, run.allowLinks);
      if (!pick) { if (m.tick - run.startedAt > 2000 && !Object.values(run.fetch).includes('out')) this.o.run = null; continue; }
      let blocked = false;
      for (const r of pick.plan.links) if (!await this.room(r)) blocked = true;
      if (blocked) continue;
      if (!await m.act('ship-deploy', { ship: ship.id, territory: pick.t.id, preload: {} })) continue;
      run.fetch[rare] = 'out';
      this.o.trips[ship.id] = { rare, good: run.good, plan: pick.plan, links: pick.plan.links, want: Math.min(this.targetFor(run.good, rare, ship), Math.floor(pick.usable * pick.plan.rate)), deployAt: m.tick, closesAt: m.tick + pick.t.ticksLeft };
      this.mem.events.push(`ship ${ship.num} to ${pick.t.name} for ${rare}`);
    }
  }

  fieldPlot(d, type, wantPlot) {
    const caps = this.config.orbitalTypes.territory.levels['1'].ringCapacities; const plots = this.config.orbitalTypes.territory.ringPlotSize;
    const taken = this.m.used(d);
    const rings = Object.keys(caps).map(Number).filter((r) => (wantPlot ? plots[r] === wantPlot : plots[r] >= (this.config.buildings[type].minPlotSize || 1))).sort((a, b) => a - b);
    for (const r of rings) for (let s = 0; s < caps[r]; s++) if (!taken.has(`${r}:${s}`)) return { ring: r, slot: s };
    return null;
  }

  async expeditions() {
    const m = this.m;
    const ships = this.ships();
    for (const id of Object.keys(this.o.trips)) if (!ships.some((s) => String(s.id) === id)) delete this.o.trips[id];
    for (const ship of ships) {
      let tr = this.o.trips[ship.id];
      if (ship.state === 'docked') {
        if (tr && tr.recalled) {
          this.o.expected = this.o.expected.filter((r) => r !== tr.rare);
          // home with nothing (the tap never ran): the rare is still to fetch
          if (this.o.run && this.o.run.good === tr.good) this.o.run.fetch[tr.rare] = this.sinv(tr.rare) >= 5 ? 'home' : null;
          delete this.o.trips[ship.id];
        } else if (tr && m.tick - tr.deployAt > 60) { // the world sent it home early
          if (this.o.run && this.o.run.fetch[tr.rare] === 'out') this.o.run.fetch[tr.rare] = null;
          delete this.o.trips[ship.id];
        }
        continue;
      }
      if (ship.state !== 'deployed' || !ship.districtId) continue;
      const d = m.v.views[ship.districtId];
      if (!d || !ship.territory) continue;
      if (!tr) { // a ship the bot has no record of: plan for the territory it is on
        const plan = this.planTap(ship.territory, ship, 0) || { recipe: null, plot: 2, builds: [], links: [], rate: 0 };
        tr = this.o.trips[ship.id] = { rare: ship.territory.resources.rare, plan, links: [], want: ship.hold, deployAt: m.tick, closesAt: m.tick + ship.territory.ticksLeft };
      }
      if (tr.recalled) continue;
      if (!tr.landAt) {
        tr.landAt = m.tick;
        for (const b of tr.plan.builds) { const pos = this.fieldPlot(m.v.views[d.id], b); if (pos) await m.act('build', { ...pos, type: b, district: d.id }); }
        const pos = this.fieldPlot(m.v.views[d.id], 't_tap', tr.plan.plot);
        if (pos) await m.act('build', { ...pos, type: 't_tap', district: d.id });
      }
      const dv = m.v.views[d.id];
      const tap = m.buildings(dv).find((b) => b.type === 't_tap');
      if (tap && !tap.recipe && tr.plan.recipe) {
        await m.act('recipe', { ring: tap.ring, slot: tap.slot, recipe: tr.plan.recipe, district: d.id });
        for (const r of tr.links || []) await m.act('route', { from: this.st.districtId, to: d.id, resource: r, rate: ship.linkRate, reserve: 0 });
        tr.builtAt = m.tick;
      }
      const got = Math.floor(m.amount(m.v.views[d.id], tr.rare));
      if (got > 0 && !tr.firstAt) tr.firstAt = m.tick;
      const left = ship.territory.ticksLeft;
      if (got >= tr.want || left <= 6 || (tr.builtAt && m.tick - tr.builtAt > 150 && got < 5) || !tr.plan.recipe) {
        if (!this.o.expected.includes(tr.rare)) this.o.expected.push(tr.rare);
        await this.room(tr.rare);
        await m.act('ship-plan', { ship: ship.id, plan: { [tr.rare]: true } });
        if (await m.act('ship-return', { ship: ship.id })) { tr.recalled = m.tick; this.mem.events.push(`ship ${ship.num} home with ${got} ${tr.rare}`); }
      }
    }
  }

  async foundryStep() {
    const m = this.m;
    const f = this.foundry();
    if (!f) return;
    const run = this.o.run;
    if (!run || !run.running) await this.power(false); // the reactor burns a cell a tick whether or not anything needs the power
    if (!run) return;
    const need = this.needsOf(run.good);
    const batch = this.config.tradeWorks.batchByPlot[m.plotOf(this.sd, f.ring)] || 1;
    const rares = need.rares.every((r) => this.sinv(r) >= need.per[r] * batch);
    const enough = rares && (!need.x || this.sinv(need.x) >= need.per[need.x] * batch);
    const allHome = need.rares.every((r) => run.fetch[r] === 'home');
    if (!run.running && allHome && enough) {
      if (!await this.room(need.good)) return;
      if (f.recipe !== need.good && !await m.act('recipe', { ring: f.ring, slot: f.slot, recipe: need.good, district: this.sd.id })) return;
      run.running = m.tick;
      await this.power(true);
      if (!this.o.expected.includes(need.good)) this.o.expected.push(need.good);
      this.mem.events.push(`foundry starts ${need.good}`);
    }
    if (run.running && !rares) { // the rares are spent: the run is over
      this.mem.events.push(`foundry run of ${run.good} done`);
      run.done = true; this.o.run = null;
      this.o.expected = this.o.expected.filter((r) => r !== need.good);
      await this.power(false);
    } else if (run.running && !enough) await this.power(false);
    else if (run.running) await this.power(true);
  }

  // ---- upgrades: storage first (more slots), then a better ship, more links, a second ship -----------------------------
  async upgrades() {
    const m = this.m;
    this.o.saving = {};
    if (this.o.run && this.o.run.running) return;
    const plan = this.foundryMode() ? ['storage', 'ship', 'links', 'ship2'] : ['storage'];
    const st = this.st;
    const next = plan.find((k) => !this.o.bought.includes(k));
    if (!next) return;
    const ship = this.ships().find((x) => x.state === 'docked' && x.level === 1);
    const cost = next === 'storage' ? (this.O.storage.levels[st.storage.level + 1] || {}).cost : next === 'links' ? (this.O.links.levels[st.links.level + 1] || {}).cost
      : next === 'ship' ? (ship ? (this.O.dropships.levels[2] || {}).cost : null) : (this.ships().length < this.O.dropships.max ? this.O.dropships.buildCost : null);
    if (!cost) { if (next !== 'ship' || !this.ships().some((x) => x.level === 1)) this.o.bought.push(next); return; }
    // credits are spent only with a good cushion left: the ground comes first
    if (m.colony.credits < (cost.credits || 0) * 1.3 + 150000) return;
    for (const [r, q] of Object.entries(cost)) if (r !== 'credits') this.o.saving[r] = q;
    if (Object.entries(cost).some(([r, q]) => r !== 'credits' && this.sinv(r) < q)) return;
    const route = next === 'storage' ? 'orbit-storage' : next === 'links' ? 'orbit-links' : next === 'ship2' ? 'ship-build' : 'ship-upgrade';
    if (await m.act(route, next === 'ship' ? { ship: ship.id } : {})) { this.o.bought.push(next); this.mem.events.push(`bought ${next}`); }
  }

  async turn() {
    if (!this.st) return;
    await this.stationBuild();
    await this.expeditions();
    if (this.foundryMode()) await this.dispatch();
    await this.contribute();
    await this.upgrades();
    await this.links();
    if (this.foundryMode()) await this.foundryStep(); else await this.power(false);
    await this.purge();
  }
}

module.exports = { Orbit, FIXED };
