'use strict';
// One bot turn. The order matters: staying alive comes first (inside the ground turn, survival runs after the plans so
// it can push urgent food, water, homes and power to the front of the queues), then growing, then the endgame, orbit and
// trade, then reorganising whatever had no room.
//
// `mem` is the bot's memory between turns. It is kept small and only ever a help: the runner saves it, but a bot that lost
// it (a restart, a fresh claim) plays on from the view alone.
const { Colony } = require('./model');
const { Ground } = require('./ground');
const { Endgame } = require('./endgame');
const { Orbit } = require('./orbit');
const { Trade } = require('./trade');
const { Reorg } = require('./reorg');
const { Supply } = require('./supply');

function rngFrom(seed) { // mulberry32: decisions vary between bots, and are repeatable in tests
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// What the bot should do with a colony it runs: play on, or give it up (it has failed, or has stayed shut down too long).
function verdict(v, mem) {
  if (!v || v.lost) return 'gone';
  if (v.colony.status !== 'active') return 'give_up';
  if (v.colony.shutdown && v.colony.shutdown.ticks > 2880) return 'give_up'; // shut down for half a day of play
  void mem;
  return 'play';
}

async function takeTurn({ config, api, profile, mem, log = () => {}, maxActions = 40 }) {
  const m = new Colony({ config, api, log, maxActions });
  await m.refresh();
  mem.events = [];
  mem.rngState = (mem.rngState || 0) + 1;
  const rng = rngFrom((mem.seed || 1) * 7919 + mem.rngState);
  mem.cadence = mem.lastTick ? Math.max(1, m.tick - mem.lastTick) : 4;
  const out = { verdict: verdict(m.v, mem), actions: 0, failures: [], events: mem.events };
  if (out.verdict !== 'play') return out;
  const G = new Ground(m, mem, profile);
  // a shutdown that has lifted leaves its buildings parked until someone switches them back on
  if (!m.colony.shutdown && m.colony.parked > 0) await m.act('resume');
  if (m.v.absence && m.v.absence.notice) await m.act('ack');
  try {
    await G.turn();
    await new Supply(m, mem, profile, G).turn();
    if (m.v.colony.won) await new Endgame(m, mem, profile, G, rng).turn();
    if (m.v.orbital && m.v.orbital.station) await new Orbit(m, mem, profile, G).turn();
    await new Trade(m, mem, profile, G, rng).turn();
    await new Reorg(m, mem, profile, G).turn();
  } finally {
    mem.lastTick = m.tick;
    out.actions = m.acted;
    out.failures = m.failures;
    out.summary = summary(m.v);
  }
  return out;
}

// A line for the runner's log and status page.
function summary(v) {
  const c = v.colony;
  const places = v.districts.filter((d) => !d.orbital).map((d) => `${d.type}${d.level}`).join(' ');
  return {
    tick: v.tick, hub: c.hubLevel, pop: c.population, morale: Math.round(c.morale), credits: c.credits,
    places, won: c.won, orbit: !!(v.orbital && v.orbital.unlocked), station: !!(v.orbital && v.orbital.station),
    standing: v.orbital ? v.orbital.standing : 0, doom: v.doom ? `${v.doom.phase} ${v.doom.ticks}` : null, shutdown: !!c.shutdown,
  };
}

module.exports = { takeTurn, verdict, summary, rngFrom };
