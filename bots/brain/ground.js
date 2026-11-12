'use strict';
// The ground game: keep the colony fed, watered, powered and housed; grow the Core and the three districts to the Beacon;
// wire the districts together with routes; switch to better recipes; and reorganise a colony that was laid out by someone
// else. It is the scripted player of scripts/playtest.js (the one the balance test trusts up to the Beacon) taught to read
// the view instead of the database, with the plans counted rather than remembered, so it can pick up any colony at any
// stage: whatever is already standing counts towards the plan, and only what is missing is built.
const sim = require('../../src/sim');

// ---- what gets built, in order. 'wait:N' holds the list until the place is level N (and asks for the upgrade) ----------
const CORE_PLAN = [
  'scrap_extractor', 'parts_assembler', 'water_pump', 'solar_array', 'water_purifier', 'hydroponics_bay',
  'wait:2', 'solar_array', 'scrap_extractor', 'scrap_extractor', 'parts_assembler', 'solar_array', 'fabrication_works', 'warehouse',
  'wait:3', 'kitchen', 'scrap_extractor', 'scrap_generator', 'foundry', 'parts_assembler', 'scrap_extractor', 'foundry', 'water_pump', 'water_purifier', 'watch_post', 'watch_post',
  'wait:4', 'fabrication_works', 'scrap_generator', 'scrap_extractor', 'scrap_extractor', 'hydroponics_bay', 'warehouse', 'parts_assembler', 'foundry', 'fabrication_works',
  'wait:5', 'beacon_array',
];
const PLANS = {
  pits: ['solar_array', 'scrap_extractor', 'ore_drill', 'smelter', 'scrap_extractor', 'ore_drill', 'wait:3', 'alloy_works', 'smelter', 'alloy_works'],
  stacks: ['solar_array', 'scrap_extractor', 'crude_pump', 'polymer_plant', 'circuit_fab', 'circuit_fab', 'solar_array',
    'wait:3', 'fuel_generator', 'cracking_tower', 'crude_pump', 'cell_forge', 'crude_pump', 'polymer_plant', 'circuit_fab', 'cracking_tower'],
  greenbelt: ['solar_array', 'water_pump', 'bio_dome', 'bio_dome', 'wait:3', 'pharma_lab', 'bio_dome', 'solar_array'],
};
// After the Beacon the districts grow to feed the Free Port and the launch.
const LATE = {
  core: ['parts_assembler', 'parts_assembler', 'warehouse', 'kitchen', 'fabrication_works'],
  pits: ['wait:4', 'ore_drill', 'smelter', 'ore_drill', 'smelter', 'wait:5', 'ore_drill', 'smelter', 'ore_drill', 'smelter', 'alloy_works'],
  stacks: ['wait:4', 'crude_pump', 'polymer_plant', 'synth_reclaimer', 'cracking_tower', 'crude_pump', 'wait:5', 'polymer_plant', 'synth_reclaimer', 'crude_pump', 'cracking_tower', 'crude_pump', 'cracking_tower', 'circuit_fab', 'cell_forge'],
  greenbelt: ['wait:4', 'agri_lab', 'bio_dome', 'pharma_lab', 'wait:5'],
};
// Standing routes, set up as soon as both ends exist: [from, to, resource, rate, reserve, when?]
const ROUTES = [
  ['pits', 'stacks', 'ingots', 3, 0],
  ['stacks', 'core', 'circuits', 2, 25],
  ['stacks', 'core', 'power_cells', 1, 0],
  ['core', 'stacks', 'alloys', 3, 150],
  ['core', 'stacks', 'machined_parts', 2, 200],
  ['stacks', 'greenbelt', 'reagents', 3, 0],
  ['stacks', 'greenbelt', 'polymers', 2, 0],
  ['greenbelt', 'core', 'medicine', 1, 0],
  ['core', 'pits', 'machined_parts', 1, 200],
];
// What feeds the alternative recipes
const ALT_ROUTES = [
  ['pits', 'core', 'ingots', 9, 40, (L) => L.pits >= 3],
  ['stacks', 'pits', 'fuel', 5, 30, (L) => L.pits >= 3 && L.stacks >= 3],
  ['stacks', 'pits', 'reagents', 2, 40, (L) => L.pits >= 4 && L.stacks >= 3],
  ['stacks', 'core', 'polymers', 2, 60, (L) => L.stacks >= 3],
  ['stacks', 'core', 'fuel', 2, 40, (L) => L.stacks >= 3],
  ['greenbelt', 'core', 'biomass', 6, 60, (L) => L.greenbelt >= 2],
];
// Which alternative recipes are worth taking, best last
const ALT_PREF = {
  water_purifier: ['scrap_bed'], parts_assembler: ['ingot_stamping'], hydroponics_bay: ['biomass_feed'], fabrication_works: ['polymer_bound'],
  scrap_generator: ['fuel_assisted'], foundry: ['ingot_charge'], kitchen: ['preserved_stores'], ore_drill: ['fuel_drill'], smelter: ['fuel_fired'],
  alloy_works: ['reagent_quench'], polymer_plant: ['scrap_fed'], fuel_generator: ['afterburn'], circuit_fab: ['alloy_traces'],
  cell_forge: ['reagent_electrolyte', 'polymer_cased'], bio_dome: ['fertilised_beds'], pharma_lab: ['polymer_capsule'], synth_reclaimer: ['reagent_wash'],
};
const MAKER = { scrap: 'scrap_extractor', machined_parts: 'parts_assembler', building_materials: 'fabrication_works' };
const REMOTE = { machined_parts: ['core', 'parts_assembler'], building_materials: ['core', 'fabrication_works'], reagents: ['stacks', 'cracking_tower'], fuel: ['stacks', 'cracking_tower'], polymers: ['stacks', 'polymer_plant'], circuits: ['stacks', 'circuit_fab'], power_cells: ['stacks', 'cell_forge'],
  ingots: ['pits', 'smelter'], alloys: ['pits', 'alloy_works'], medicine: ['greenbelt', 'pharma_lab'], biomass: ['greenbelt', 'bio_dome'] };
const FEED = { smelter: 'ore_drill', cracking_tower: 'crude_pump', polymer_plant: 'crude_pump' };
const SPILL = ['core', 'greenbelt', 'pits', 'stacks']; // where food, water and homes go when the Core is full
const FOOD = ['water_pump', 'water_purifier', 'hydroponics_bay'];
// Plots kept clear for the launch chain: two Colossal plots side by side in the Core, a Heavy plot in the Free Port
const RESERVED = { core: ['5:12', '5:13'], freeport: ['5:10'] };

const DEPTH = 1; // orders the bot leaves waiting behind the one under way (it looks in every few ticks)

class Ground {
  constructor(m, mem, P) { this.m = m; this.mem = mem; this.P = P; this.config = m.config; mem.ground = mem.ground || { stall: {}, extras: {}, altBan: [], held: 0, reqSeen: {} }; this.g = mem.ground; }

  reserved(d) {
    // the launch plots stay clear only while they are free; a colony that already built there plans its launch elsewhere
    return (RESERVED[d.type] || []).filter((k) => !this.m.used(d).has(k));
  }
  place(d, type, opts = {}) { return this.m.place(d, type, { ...opts, reserved: opts.reserved || this.reserved(d) }); }
  roomFor(d, type) { const pos = this.place(d, type); return pos && this.m.plotOf(d, pos.ring) >= (this.m.def(type).minPlotSize || 1) ? pos : null; }

  // Queue a building. `urgent` (food, water, homes, power) goes to the front, and only if the place can pay for it now.
  async build(d, type, { urgent = false, plot, pos: at } = {}) {
    const m = this.m;
    const def = m.def(type);
    if (!def || !sim.buildableIn(def, d.type)) return false;
    if (urgent && !m.can(d, def.cost)) return false;
    if (m.waiting(d).length >= DEPTH + (urgent ? 1 : 0)) return false;
    const pos = at || this.place(d, type, { plot });
    if (!pos) return false;
    if (!await m.act('build', { ...pos, type, district: d.id })) return false;
    if (urgent) {
      const nd = m.v.views[d.id];
      const mine = m.waiting(nd).find((o) => o.data.type === type && o.data.ring === pos.ring && o.data.slot === pos.slot);
      if (mine && mine.pos > 1) await m.act('queue-move', { orderId: mine.id, to: 'top' });
    }
    return true;
  }

  // Ship what a place is short of from whichever other place can spare it.
  async topUp(d, cost) {
    const m = this.m;
    for (const [r, a] of Object.entries(cost || {})) {
      if (r === 'credits') continue;
      const have = m.amount(d, r);
      if (have >= a * 1.1 + 2) continue;
      if (m.shipments().some((s) => s.toDistrict === d.id && s.resource === r)) continue;
      const short = Math.ceil(a * 1.25 + 5 - have);
      for (const from of m.places()) {
        if (from.id === d.id) continue;
        const keep = from.type === 'core' ? (r === 'building_materials' ? 40 : r === 'scrap' ? 700 : ['clean_water', 'rations'].includes(r) ? 300 * this.P.safety : 150) : 15;
        const spare = Math.floor(m.amount(from, r) - keep);
        const qty = Math.min(short, spare, this.config.logistics.shipmentMax);
        if (qty >= 1 && await m.act('shipment', { from: from.id, to: d.id, resource: r, qty })) break;
      }
    }
  }

  levelCap() { return this.m.v.districtLevelCap; }
  async askUpgrade(d) {
    const m = this.m;
    const next = sim.levelDef(this.config, d.type, d.level + 1);
    if (!next || m.orders(d).some((o) => o.kind === 'upgrade')) return;
    if (d.type !== 'core' && d.level + 1 > this.levelCap()) return;
    if (m.waiting(d).length >= DEPTH + 1) return;
    await m.act('upgrade', d.type === 'core' ? {} : { district: d.id });
  }

  // A careful player stops adding workplaces when crews run thin (and builds homes instead), but not for ever.
  shortHanded(type) {
    const staff = this.m.colony.staffing.ratio;
    const hold = staff < 0.85 && !this.homeless && (this.m.def(type).workers || 0) > 0;
    if (!hold) { this.g.held = 0; return false; }
    if (++this.g.held > 30) { this.g.held = 0; return false; }
    return true;
  }

  // Work down a place's plan: what is missing gets built, in order.
  async planStep(d, plan) {
    const m = this.m;
    const seen = {};
    for (const item of plan) {
      d = m.v.views[d.id];
      if (item.startsWith('wait:')) {
        if (d.level < Number(item.split(':')[1])) { await this.askUpgrade(d); break; }
        continue;
      }
      seen[item] = (seen[item] || 0) + 1;
      if (m.count(d, item) >= seen[item]) continue;
      if (!this.place(d, item)) { this.missing(d, item); continue; } // no room: the reorganiser hears of it
      if (this.shortHanded(item)) break;
      if (!await this.build(d, item)) break; // the queue is as deep as the bot lets it get
    }
    d = m.v.views[d.id];
    // whatever is at the front and cannot be paid for: a district is sent what it lacks
    const front = m.waiting(d)[0];
    const stalled = front && !m.busy(d);
    if (stalled && d.type !== 'core') await this.topUp(d, front.cost);
    // a bot that keeps waiting on the same basic thing builds another of what makes it, if there is room
    const key = String(d.id);
    this.g.stall[key] = stalled ? (this.g.stall[key] || 0) + this.mem.cadence : 0;
    if (stalled && this.g.stall[key] >= 12) await this.unstall(d, front, key);
  }

  async unstall(d, front, key) {
    const m = this.m;
    for (const [r, a] of Object.entries(front.cost || {})) {
      if (m.amount(d, r) >= a) continue;
      // lines here that were switched to a recipe eating what the order waits for go back to their base recipe
      for (const b of m.buildings(d)) {
        const def = m.def(b.type);
        const alt = b.recipe && def.alternatives ? def.alternatives[b.recipe] : null;
        if (alt && alt.inputsPerTick[r] && !(def.inputsPerTick || {})[r] && !b.resetting && await m.act('recipe', { ring: b.ring, slot: b.slot, recipe: null, district: d.id })) this.g.altBan.push(b.id);
      }
      // made in another district: that district gets another line
      const far = REMOTE[r];
      const home = far && far[0] !== d.type && this.g.stall[key] >= 30 ? m.byType(far[0]) : null;
      const ek = home && `${home.id}:${far[1]}`;
      if (home && (this.g.extras[ek] || 0) < 3 && !m.orders(home).some((o) => o.data.type === far[1]) && this.roomFor(home, far[1])) {
        if (!m.can(home, m.def(far[1]).cost)) await this.topUp(home, m.def(far[1]).cost);
        else if (await this.build(home, far[1], { urgent: true })) {
          this.g.extras[ek] = (this.g.extras[ek] || 0) + 1;
          const h2 = m.v.views[home.id];
          if (FEED[far[1]] && this.roomFor(h2, FEED[far[1]])) await this.build(h2, FEED[far[1]]);
        }
      }
      const maker = MAKER[r];
      d = m.v.views[d.id];
      if (!maker || m.amount(d, r) >= a || !m.buildable(maker, d.type)) continue;
      const xk = `${key}:${maker}`;
      if ((this.g.extras[xk] || 0) >= 4 || !m.can(d, m.def(maker).cost) || m.orders(d).some((o) => o.data.type === maker)) continue;
      const pos = this.roomFor(d, maker);
      if (pos && await this.build(d, maker, { urgent: true, pos })) { this.g.extras[xk] = (this.g.extras[xk] || 0) + 1; this.g.stall[key] = 0; }
    }
  }

  missing(d, type) { (this.mem.wanted = this.mem.wanted || {})[`${d.id}:${type}`] = this.m.tick; }

  // ---- survival: water, food, meals, homes, power -----------------------------------------------------------------
  async survival() {
    const m = this.m;
    const v = m.v;
    const core = m.core();
    const S = this.P.safety;
    const allOrders = m.all().flatMap((d) => m.orders(d));
    const pendingAny = (types) => allOrders.some((o) => (o.kind === 'build' || o.kind === 'replace') && types.includes(o.data.type));
    const margin = (v.colony.won ? 3 : 1) * S + (S > 1 ? 1 : 0);
    const net = (r) => m.net(core, r);
    const grow = async (type) => {
      if (pendingAny(FOOD)) return;
      for (const t of SPILL.slice(0, 2)) { // the Core, then the farm district
        const d = m.byType(t);
        if (!d || (t !== 'core' && d.level < 2)) continue;
        let what = type;
        if (t !== 'core' && what === 'hydroponics_bay' && m.net(d, 'clean_water') < 5) what = 'water_purifier';
        if (what === 'water_purifier' && m.net(d, 'unpurified_water') < (t === 'core' ? 8 : 15)) what = 'water_pump';
        const pos = this.roomFor(d, what);
        if (!pos) { this.missing(d, what); continue; }
        if (!m.can(d, m.def(what).cost)) { if (t !== 'core') await this.topUp(d, m.def(what).cost); return; }
        if (await this.build(d, what, { urgent: true, pos })) return;
      }
    };
    // (a full tank needs no new plant: a route cannot deliver into a full store, so the rate alone would mislead)
    const low = (r) => net(r) < margin && v.resources[r].amount < v.resources[r].cap * 0.8;
    if (low('clean_water')) await grow('water_purifier');
    else if (low('rations')) await grow('hydroponics_bay');
    // a stock run down below a safe floor is rebuilt even at a small surplus
    else if (v.resources.clean_water.amount < 150 * S && net('clean_water') < 3 * S) await grow('water_purifier');
    else if (v.resources.rations.amount < 150 * S && net('rations') < 3 * S) await grow('hydroponics_bay');
    if (m.hub >= 3 && v.colony.moraleInfo.mealCoverage < 0.95 && !pendingAny(['kitchen']) && net('rations') > 6 && m.can(core, m.def('kitchen').cost)) {
      const pos = this.roomFor(m.core(), 'kitchen');
      if (pos) await this.build(m.core(), 'kitchen', { urgent: true, pos }); // eating well keeps the colony growing
    }
    await this.homes(pendingAny);
    await this.power();
    // what a district grows for the colony goes home
    if (this.every(5)) {
      const has = (t, type) => { const d = m.byType(t); return !!d && m.buildings(d).some((b) => b.type === type); };
      await this.routes(SPILL.slice(1).flatMap((t) => [[t, 'core', 'rations', 30, 20, () => has(t, 'hydroponics_bay')], [t, 'core', 'clean_water', 30, 60, () => has(t, 'water_purifier')]]));
    }
  }

  // The free plot with the best neighbours for a home (homes beside smoky buildings are miserable)
  homePlot(d, minPlot, maxPlot = 9) {
    const m = this.m;
    const caps = m.rings(d);
    const taken = m.used(d);
    const held = this.reserved(d);
    const here = new Map(m.buildings(d).map((b) => [`${b.ring}:${b.slot}`, b.type]));
    const nb = m.neighbours(d.type);
    let best = null;
    for (const r of Object.keys(caps).map(Number)) {
      const p = m.plotOf(d, r);
      if (p < minPlot || p > maxPlot) continue;
      for (let sl = 0; sl < caps[r]; sl++) {
        const k = `${r}:${sl}`;
        if (taken.has(k) || held.includes(k)) continue;
        const score = (nb.get(k) || []).reduce((n, [nr, ns]) => n + (here.has(`${nr}:${ns}`) ? m.def(here.get(`${nr}:${ns}`)).comfort || 0 : 0), 0);
        if (!best || score > best.score) best = { ring: r, slot: sl, score };
      }
    }
    return best;
  }

  async homes(pendingAny) {
    const m = this.m;
    const v = m.v;
    const pop = v.colony.population;
    const cap = v.colony.maxPopulation;
    const wanted = Math.ceil(v.colony.staffing.posts / this.config.global.workforceShare) + 8;
    if (pendingAny(['habitat', 'dormitory']) || !(pop >= cap - 2 || (cap < wanted && pop >= cap - 15))) return;
    let done = false;
    for (const t of SPILL) {
      const d = m.byType(t);
      const pos = d && (t === 'core' || d.level >= 4) && this.homePlot(d, 3);
      if (!pos) continue;
      if (m.can(d, m.def('habitat').cost)) done = await this.build(d, 'habitat', { urgent: true, pos: { ring: pos.ring, slot: pos.slot } });
      else if (t !== 'core') { await this.topUp(d, m.def('habitat').cost); done = true; }
      break;
    }
    if (!done) { const pos = this.homePlot(m.core(), 1, 2); if (pos) done = await this.build(m.core(), 'dormitory', { urgent: true, pos: { ring: pos.ring, slot: pos.slot } }); }
    for (const t of SPILL.slice(1)) {
      const d = m.byType(t);
      if (done || !d || m.freePlots(d) < 2) continue;
      const pos = this.homePlot(d, 1, 2);
      if (!pos) continue;
      if (m.can(d, m.def('dormitory').cost)) done = await this.build(d, 'dormitory', { urgent: true, pos: { ring: pos.ring, slot: pos.slot } });
      else { await this.topUp(d, m.def('dormitory').cost); done = true; }
    }
    this.homeless = !done;
    if (!done) this.missing(m.core(), 'habitat');
  }

  // A grid that is short gets another generator: the best the place can build and pay for.
  async power() {
    const m = this.m;
    for (const d of m.places()) {
      const e = d.energy;
      if (!e || e.satisfaction >= 0.97) continue;
      if (m.orders(d).some((o) => (o.kind === 'build' || o.kind === 'replace') && m.def(o.data.type).type === 'generator')) continue;
      const order = d.type === 'freeport' || d.type === 'stacks' ? ['fuel_generator', 'scrap_generator', 'solar_array'] : ['scrap_generator', 'fuel_generator', 'solar_array'];
      const choice = order.find((g) => {
        const def = m.def(g);
        if (!sim.buildableIn(def, d.type) || !m.can(d, def.cost)) return false;
        if (g === 'fuel_generator' && m.amount(d, 'fuel') < 100) return false;
        if (g === 'scrap_generator' && d.type !== 'core' && m.amount(d, 'scrap') < 600) return false;
        return !!this.roomFor(d, g);
      });
      if (choice) await this.build(d, choice, { urgent: true });
      else this.missing(d, 'solar_array');
    }
  }

  every(n) { return Math.floor(this.m.tick / n) !== Math.floor((this.mem.lastTick || 0) / n) || !this.mem.lastTick; }

  // ---- routes between places --------------------------------------------------------------------------------------
  async routes(list) {
    const m = this.m;
    const L = m.levels();
    for (const [a, b, res, rate, reserve, when] of list) {
      const da = m.byType(a); const db = m.byType(b);
      if (!da || !db || (when && !when(L))) continue;
      const want = typeof rate === 'function' ? rate(L, this.linkCaps()) : rate;
      const keep = typeof reserve === 'function' ? reserve(L) : reserve;
      if (want < 1) continue;
      const cur = m.route(da, db, res);
      if (cur && cur.rate >= want && cur.reserve === keep) continue;
      if (await m.act('route', { from: da.id, to: db.id, resource: res, rate: want, reserve: keep })) continue;
      // the link is full: raise whichever end is (paid from the Core), and meanwhile run the route at what room there is
      let room = want;
      for (const d of [da, db]) {
        if (d.type === 'core') continue;
        const l = m.link(d);
        if (!l) continue;
        const free = l.capacity - l.load + (cur ? cur.rate : 0);
        if (free < want && l.next) {
          if (!await m.act('link', { district: d.id })) {
            const cost = l.next.upgradeCost || {};
            await this.topUp(m.core(), Object.fromEntries(Object.entries(cost).filter(([r]) => this.config.resources[r] && this.config.resources[r].trade)));
          }
        }
        const l2 = m.link(m.v.views[d.id]);
        room = Math.min(room, l2.capacity - l2.load + (cur ? cur.rate : 0));
      }
      if (room >= 1 && (!cur || room > cur.rate)) await m.act('route', { from: da.id, to: db.id, resource: res, rate: room, reserve: keep });
    }
  }
  linkCaps() { return Object.fromEntries(this.m.places().filter((d) => d.type !== 'core').map((d) => [d.type, (this.m.link(d) || {}).capacity || 0])); }

  // ---- alternative recipes ----------------------------------------------------------------------------------------
  async alternatives() {
    const m = this.m;
    const ms = m.v.milestones || {};
    for (const d of m.places()) {
      const stock = m.inv(d);
      for (const b of m.buildings(d)) {
        const def = m.def(b.type);
        const prefs = ALT_PREF[b.type];
        if (!prefs || !def.alternatives || b.resetting || this.g.altBan.includes(b.id)) continue;
        let pick = null;
        for (const a of prefs) {
          const alt = def.alternatives[a];
          if (!alt || !sim.altUnlocked(alt, { level: d.level, milestones: ms })) continue;
          if (!Object.entries(alt.inputsPerTick).every(([r, q]) => r === 'energy' || (stock[r] || 0) >= q * 15)) continue;
          // a line that feeds or waters people only moves to a recipe whose new inputs arrive as fast as it eats them
          const vital = Object.keys(def.outputsPerTick || {}).some((r) => ['rations', 'meals', 'clean_water'].includes(r));
          if (vital && b.recipe !== a && !Object.entries(alt.inputsPerTick).every(([r, q]) => r === 'energy' || (def.inputsPerTick || {})[r] || m.net(d, r) >= q * this.P.safety)) continue;
          pick = a;
        }
        if (pick && b.recipe !== pick && prefs.indexOf(pick) > prefs.indexOf(b.recipe)) await m.act('recipe', { ring: b.ring, slot: b.slot, recipe: pick, district: d.id });
      }
    }
  }

  // ---- the Office's requisitions: delivered only from what the colony will not miss -------------------------------
  async requisitions() {
    const m = this.m;
    const v = m.v.requisitions;
    if (!v || !v.open || !v.open.length) return;
    const core = m.core();
    const saving = {};
    const add = (cost) => { for (const [r, a] of Object.entries(cost || {})) saving[r] = (saving[r] || 0) + a; };
    for (const o of m.waiting(core)) add(o.cost);
    add((this.config.hubLevels[m.hub + 1] || {}).upgradeCost);
    for (const q of v.open) {
      const base = (['clean_water', 'rations'].includes(q.good) ? 400 : q.good === 'machined_parts' ? 120 : q.good === 'building_materials' ? 80 : 40) * this.P.safety;
      if (m.amount(m.core(), q.good) - q.qty < base + (saving[q.good] || 0)) continue;
      await m.act('requisition', { id: q.id });
    }
  }

  // ---- the convoy: sell what presses against the storage cap ------------------------------------------------------
  async contracts() {
    const m = this.m;
    const core = m.core();
    const cap = m.cap(core);
    const have = m.v.contracts || { export: {}, import: {} };
    for (const r of ['machined_parts', 'building_materials', 'alloys', 'clean_water', 'rations', 'meals', 'scrap']) {
      const a = m.amount(core, r);
      const spare = a >= cap * 0.9 ? Math.floor(a - cap * 0.75) : 0;
      if ((have.export[r] || 0) === spare) continue;
      await m.act('contract', { resource: r, side: 'export', amount: Math.max(0, spare) });
    }
    // a shortage of what people need is bought in by the convoy while the treasury can pay for it
    for (const r of ['clean_water', 'rations']) {
      const res = m.v.resources[r];
      const short = res.net < 0 && res.ticksLeft !== null && res.ticksLeft < 200;
      const want = short ? Math.min(Math.ceil(-res.net * this.config.global.convoyIntervalTicks * 1.5), Math.floor(m.colony.credits / (m.v.market.prices[r].buy * 2))) : 0;
      if ((have.import[r] || 0) === want) continue;
      await m.act('contract', { resource: r, side: 'import', amount: Math.max(0, want) });
    }
  }

  // ---- build slots: bought where work waits and paying would not take what the front order needs -------------------
  async slots() {
    const m = this.m;
    for (const d of m.places()) {
      const next = d.slots && d.slots.next;
      const line = m.waiting(d);
      if (!next || m.hub < next.coreLevel || !line.length || m.colony.credits < next.credits * 1.5) continue;
      const front = line[0].cost || {};
      if (!Object.entries(next.cost).every(([r, a]) => m.amount(d, r) >= a + (front[r] || 0))) continue;
      await m.act('build-slot', d.type === 'core' ? {} : { district: d.id });
    }
  }

  // ---- one ground turn --------------------------------------------------------------------------------------------
  async turn() {
    const m = this.m;
    const P = this.P;
    const v = m.v;
    // upgrades whenever a place can pay, without waiting for its list to ask (never the hub before food and water stand)
    for (const d of m.places()) {
      const next = sim.levelDef(this.config, d.type, d.level + 1);
      if (!next) continue;
      const fed = d.type !== 'core' || ['water_purifier', 'hydroponics_bay'].every((t) => m.buildings(d).some((b) => b.type === t));
      if (fed && m.can(d, next.upgradeCost)) await this.askUpgrade(d);
      else if (d.type !== 'core' && d.level + 1 <= this.levelCap() && this.every(3)) await this.topUp(d, next.upgradeCost);
    }
    // districts, in the profile's order
    if (v.districtsUnlocked) {
      const core = m.core();
      for (const t of P.districts) {
        if (m.byType(t) || (v.founding || []).length) continue;
        if (!m.can(m.core(), this.config.districtTypes[t].foundCost)) break; // one at a time, in order
        if (await m.act('found', { type: t })) {
          const mine = m.waiting(m.core()).find((o) => o.kind === 'found');
          if (mine && mine.pos > 1) await m.act('queue-move', { orderId: mine.id, to: 'top' });
        }
        break;
      }
      void core;
      if (this.every(5)) { await this.routes(ROUTES); if (P.alts) await this.routes(ALT_ROUTES); }
    }
    const late = v.colony.won;
    await this.planStep(m.core(), CORE_PLAN.concat(late ? LATE.core : []));
    for (const t of ['pits', 'stacks', 'greenbelt']) { const d = m.byType(t); if (d) await this.planStep(d, PLANS[t].concat(late ? LATE[t] : [])); }
    await this.survival();
    // parts assemblers rest when parts pile up
    for (const b of m.buildings(m.core())) {
      if (b.type !== 'parts_assembler') continue;
      const want = m.amount(m.core(), 'machined_parts') > (late ? 3000 : 600);
      if (b.paused !== want) await m.act('toggle', { ring: b.ring, slot: b.slot, paused: want });
    }
    if (this.every(5)) await this.slots();
    if (P.alts && this.every(10)) await this.alternatives();
    if (P.requisitions) await this.requisitions();
    if (this.every(10)) await this.contracts();
  }
}

module.exports = { Ground, RESERVED, REMOTE, FEED, CORE_PLAN, PLANS, LATE };
