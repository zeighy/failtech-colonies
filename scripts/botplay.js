#!/usr/bin/env node
'use strict';
// The bot brain (bots/brain) played on the real engine and a throwaway database, fast: for tuning the bots and checking
// that they get on from the ground up without running the colony into the ground. Several bots can share one world, so
// they meet on the exchange and the orbital market.
//
//   node scripts/botplay.js [--profiles broker,porter,...] [--ticks 6000] [--turn 4] [--hazards on|off] [--quiet]
//                           [--json FILE]
//
// --turn N: a bot takes a turn every N ticks (the runner's BOT_TURN_TICKS).
const os = require('os');
const path = require('path');
const fs = require('fs');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : (argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[i + 1]); };
const PROFILES = String(arg('profiles', 'broker')).split(',');
const TICKS = Number(arg('ticks', 6000));
const TURN = Math.max(1, Number(arg('turn', 4)));
const QUIET = !!arg('quiet', false);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-botplay-'));
process.env.DB_PATH = path.join(dir, 'play.db');
process.env.SESSION_SECRET = 'x';
process.env.THEME = arg('theme', 'basic');
process.env.HAZARDS = arg('hazards', 'off') === 'on' ? 'on' : 'off';
const store = require('../src/db');
const engine = require('../src/engine');
const { localApi } = require('../bots/local');
const { takeTurn } = require('../bots/brain');
const profiles = require('../bots/profiles');
const { db, config } = store;
const cfg = JSON.parse(JSON.stringify(config)); // what the runner would be sent

const bots = PROFILES.map((p, i) => {
  if (!profiles.get(p)) { console.error(`Unknown profile ${p}`); process.exit(2); }
  const uid = Number(db.prepare('INSERT INTO users (username, password, bot_profile) VALUES (?, ?, ?)').run(`bot${i}_${p}`, 'x', p).lastInsertRowid);
  const id = store.ensureColony(uid);
  return { uid, id, profile: p, P: profiles.get(p), mem: { seed: uid * 31 }, api: localApi(uid), marks: {}, actions: 0, refused: 0, shutdowns: 0, minMorale: 100, starvingTicks: 0, events: [] };
});

let T = 0;
const hrs = (t) => `${(t * config.global.tickRateMs / 3600000).toFixed(1)}h`;
function mark(b, name) { if (b.marks[name] === undefined) { b.marks[name] = T; if (!QUIET) console.log(`  ${String(T).padStart(5)}  ${b.profile.padEnd(13)} ${name}`); } }

async function run() {
  const t0 = Date.now();
  for (T = 1; T <= TICKS; T++) {
    const now = Date.now();
    db.prepare('UPDATE colonies SET last_seen_at = ?, last_active_at = ?').run(now, now);
    engine.processTick();
    for (const [i, b] of bots.entries()) {
      const c = db.prepare('SELECT * FROM colonies WHERE id = ?').get(b.id);
      b.minMorale = Math.min(b.minMorale, c.morale);
      if (c.starving) b.starvingTicks++;
      if (c.shutdown_tick !== null && !b.shut) { b.shut = true; b.shutdowns++; mark(b, `SHUT DOWN #${b.shutdowns}`); }
      if (c.shutdown_tick === null) b.shut = false;
      for (let l = 2; l <= c.hub_level; l++) mark(b, `Core ${l}`);
      if (store.hasBeacon(c.id)) mark(b, 'Beacon built');
      if (c.won) mark(b, 'Beacon transmitted');
      if (c.orbital_unlocked) mark(b, 'Orbit unlocked');
      for (const d of store.loadDistricts(c.id)) if (d.type !== 'core' && d.type !== 'territory') mark(b, `${d.type} founded`);
      if ((T + i) % TURN !== 0) continue;
      const out = await takeTurn({ config: cfg, api: b.api, profile: b.P, mem: b.mem });
      b.actions += out.actions; b.refused += out.failures.length; for (const f of out.failures) { b.fails = (b.fails || []).concat(`${T} ${f}`).slice(-25); }
      for (const e of out.events) { b.events.push(`${T} ${e}`); if (/sell|buy|launched|foundry|ship|reorganised|jettison/.test(e)) mark(b, e.replace(/ at [\d.]+$/, '').replace(/\d+ /, '').slice(0, 60)); }
      if (out.verdict !== 'play') { mark(b, `verdict ${out.verdict}`); }
    }
  }
  const secs = (Date.now() - t0) / 1000;
  console.log(`\n== ${TICKS} ticks (${hrs(TICKS)}) in ${secs.toFixed(0)} s, a turn every ${TURN} ticks, hazards ${process.env.HAZARDS}`);
  for (const b of bots) {
    const c = db.prepare('SELECT * FROM colonies WHERE id = ?').get(b.id);
    const places = store.loadDistricts(c.id).map((d) => `${d.type}${d.type === 'core' ? c.hub_level : d.level}/${store.loadBuildings(c.id, d.id).length}`).join(' ');
    const st = db.prepare('SELECT COALESCE(SUM(points), 0) AS n FROM standing WHERE colony_id = ?').get(c.id).n;
    console.log(`${b.profile}: hub ${c.hub_level}, pop ${c.population}, morale ${Math.round(c.morale)} (min ${Math.round(b.minMorale)}), credits ${c.credits}, standing ${st}, ${b.shutdowns} shutdowns, starving ${b.starvingTicks} ticks; ${b.actions} actions, ${b.refused} refused; ${places}`);
    console.log(`  trade: ${JSON.stringify(b.mem.trade || {})}; reorganised ${(b.mem.reorg || {}).done || 0}`);
    console.log('  milestones: ' + Object.entries(b.marks).map(([k, t]) => `${k} ${t}`).join(' · '));
  }
  if (arg('dump')) {
    const { viewFor } = require('../src/state');
    for (const b of bots) {
      const v = viewFor(b.uid);
      console.log(`\n--- ${b.profile}: orbit ${JSON.stringify({ unlocked: v.orbital.unlocked, site: v.orbital.site, launch: v.orbital.launch, station: !!v.orbital.station })}`);
      for (const d of v.districts) {
        const dv = v.views[d.id];
        const keys = ['frames', 'fittings', 'modules', 'tool_steel', 'plastics', 'precision_tools', 'luxuries', 'curios', 'preserves', 'circuits', 'alloys', 'polymers', 'ingots', 'power_cells', 'building_materials', 'fuel'];
        console.log(`  ${d.type} L${d.level}: ${keys.map((k) => `${k}=${Math.floor(dv.resources[k].amount)}(${dv.resources[k].net.toFixed(1)})`).join(' ')}`);
        if (d.type === 'freeport') console.log('   workshops: ' + dv.buildings.filter((x) => x.type === 'trade_workshop').map((x) => `${x.recipe}@${x.ring}${x.eff !== undefined ? `:${x.eff.toFixed(2)}` : ''}${x.limiting ? `[${x.limiting}]` : ''}`).join(' '));
        console.log('   queue: ' + dv.orders.map((o) => `${o.state}:${o.kind}:${o.data.type || o.data.level || ''}${o.waiting ? ` waits ${JSON.stringify(o.waiting.short)}` : ''}`).join(' | '));
      }
      console.log('  wanted: ' + JSON.stringify(b.mem.wanted || {}));
      console.log('  last refusals: ' + (b.fails || []).join(' / '));
    }
  }
  if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify(bots.map((b) => ({ profile: b.profile, marks: b.marks, events: b.events, mem: b.mem })), null, 1));
}

run().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
