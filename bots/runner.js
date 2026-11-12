#!/usr/bin/env node
'use strict';
// The bot runner: a small utility server that keeps a few parked colonies in play, so a world with only a handful of
// players still has neighbours, trade on the exchange and the orbital market, and stations in orbit.
//
// It talks to the game server only through the bot API (src/botApi.js), so it can run on the same machine or another one.
// Every few minutes it asks for parked colonies; while it runs fewer bots than its limit it looks at each candidate (see
// assess.js), claims the stable ones and gives each a profile (profiles.js), choosing the profile fewest bots are playing.
// Each bot then takes a turn every few ticks (brain/). A colony that fails, or stays shut down for long, is given back:
// it parks again for someone else.
//
// Settings (environment):
//   BOT_SERVER          the game server's address                          default http://127.0.0.1:3000
//   BOT_API_KEY         the key the game server was started with (required, at least 16 characters)
//   BOT_LIMIT           how many colonies bots may run at once              default 5
//   BOT_PROFILES        which profiles to use, comma-separated              default all of them
//   BOT_CLAIM           'all' parked colonies, or only 'given_up' ones (whose commander chose to start over)   default all
//   BOT_TURN_TICKS      game ticks between a bot's turns                    default 4 (a minute at 15 s a tick)
//   BOT_POLL_SECONDS    seconds between looks for parked colonies           default 300
//   BOT_RECHECK_HOURS   how long a colony judged unsafe is left alone       default 24
//   BOT_STATE_FILE      where the bots' memory is kept between restarts    default ./bots-state.json
//   BOT_STATUS_PORT     if set, GET /status on this port (bound to 127.0.0.1) shows what every bot is doing
//   BOT_LOG             'quiet' for errors only, 'verbose' for every event  default normal
const fs = require('fs');
const http = require('http');
const path = require('path');
const { BotClient } = require('./client');
const { assess } = require('./assess');
const profiles = require('./profiles');
const { takeTurn } = require('./brain');

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);

function settings() {
  const list = env('BOT_PROFILES', profiles.ORDER.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  for (const p of list) if (!profiles.get(p)) throw new Error(`Unknown bot profile "${p}". Known: ${profiles.ORDER.join(', ')}.`);
  return {
    server: env('BOT_SERVER', 'http://127.0.0.1:3000'),
    key: env('BOT_API_KEY', ''),
    limit: Math.max(0, Number(env('BOT_LIMIT', 5))),
    profiles: list,
    claim: env('BOT_CLAIM', 'all'),
    turnTicks: Math.max(1, Number(env('BOT_TURN_TICKS', 4))),
    pollMs: Math.max(10, Number(env('BOT_POLL_SECONDS', 300))) * 1000,
    recheckMs: Math.max(0, Number(env('BOT_RECHECK_HOURS', 24))) * 3600000,
    stateFile: path.resolve(env('BOT_STATE_FILE', 'bots-state.json')),
    statusPort: env('BOT_STATUS_PORT', null),
    log: env('BOT_LOG', 'normal'),
  };
}

class Runner {
  constructor(s, client) {
    this.s = s;
    this.client = client || new BotClient(s.server, s.key);
    this.bots = new Map(); // userId -> { userId, username, profile, colonyId, mem, last, errors }
    this.rejected = {}; // colonyId -> { at, verdict, reasons }
    this.config = null;
    this.tickMs = 15000;
    this.stopped = false;
    this.lastPoll = 0;
    this.load();
  }

  say(level, msg) {
    if (this.s.log === 'quiet' && level !== 'error') return;
    if (level === 'debug' && this.s.log !== 'verbose') return;
    (level === 'error' ? console.error : console.log)(`[bots ${new Date().toISOString()}] ${msg}`);
  }

  // ---- memory across restarts -----------------------------------------------------------------------------------
  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.s.stateFile, 'utf8'));
      this.saved = j.bots || {};
      this.rejected = j.rejected || {};
    } catch (e) { this.saved = {}; }
  }
  save() {
    const bots = {};
    for (const [id, b] of this.bots) bots[id] = { mem: b.mem, claimedAt: b.claimedAt };
    const tmp = `${this.s.stateFile}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), bots, rejected: this.rejected }), { mode: 0o600 });
      fs.renameSync(tmp, this.s.stateFile);
    } catch (e) { this.say('error', `could not save ${this.s.stateFile}: ${e.message}`); }
  }

  // ---- the bots the server says we run --------------------------------------------------------------------------
  async sync() {
    const list = await this.client.colonies();
    const seen = new Set();
    for (const row of list) {
      seen.add(row.userId);
      if (!row.colonyId) { await this.client.release(row.userId); continue; } // an account with nothing left to run
      if (!this.bots.has(row.userId)) {
        const prev = this.saved[row.userId] || {};
        this.bots.set(row.userId, { userId: row.userId, username: row.username, profile: profiles.get(row.profile) ? row.profile : this.s.profiles[0], colonyId: row.colonyId, mem: prev.mem || { seed: row.userId }, claimedAt: prev.claimedAt || Date.now(), errors: 0, last: null });
        this.say('info', `running ${row.username} (${row.profile}) on colony ${row.colonyId}`);
      }
    }
    for (const id of [...this.bots.keys()]) if (!seen.has(id)) this.bots.delete(id);
  }

  pickProfile() {
    const used = Object.fromEntries(this.s.profiles.map((p) => [p, 0]));
    for (const b of this.bots.values()) if (used[b.profile] !== undefined) used[b.profile]++;
    const least = Math.min(...Object.values(used));
    const pool = this.s.profiles.filter((p) => used[p] === least);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // ---- finding and claiming parked colonies ---------------------------------------------------------------------
  async poll() {
    this.lastPoll = Date.now();
    await this.sync();
    // a lowered limit: the most recently claimed bots give their colonies back
    while (this.bots.size > this.s.limit) {
      const last = [...this.bots.values()].sort((a, b) => b.claimedAt - a.claimedAt)[0];
      await this.release(last, 'over the limit');
    }
    if (this.bots.size >= this.s.limit) return;
    const now = Date.now();
    for (const [id, r] of Object.entries(this.rejected)) if (now - r.at > this.s.recheckMs) delete this.rejected[id];
    let parked = await this.client.parked();
    if (this.s.claim === 'given_up') parked = parked.filter((p) => p.generated);
    // colonies nobody will come back for first, then the furthest along (more to sell, sooner)
    parked.sort((a, b) => (b.generated - a.generated) || (b.hubLevel - a.hubLevel) || (a.parkedAt - b.parkedAt));
    for (const p of parked) {
      if (this.bots.size >= this.s.limit) break;
      if (this.rejected[p.colonyId]) continue;
      let view;
      try { view = await this.client.parkedView(p.colonyId); } catch (e) { continue; }
      const a = assess(view, this.config);
      if (a.verdict !== 'stable') {
        this.rejected[p.colonyId] = { at: now, verdict: a.verdict, reasons: a.reasons };
        this.say('info', `left colony ${p.colonyId} (${p.holder}, hub ${p.hubLevel}) alone: ${a.verdict}${a.reasons.length ? ` - ${a.reasons.join('; ')}` : ''}`);
        continue;
      }
      const profile = this.pickProfile();
      const r = await this.client.claim(p.colonyId, profile);
      if (!r || !r.ok) { this.say('info', `could not claim colony ${p.colonyId}: ${(r && r.error) || 'refused'}`); continue; }
      this.bots.set(r.userId, { userId: r.userId, username: r.username, profile, colonyId: p.colonyId, mem: { seed: r.userId }, claimedAt: Date.now(), errors: 0, last: null });
      this.say('info', `claimed colony ${p.colonyId} (hub ${p.hubLevel}, score ${a.score}) as ${r.username}, playing ${profiles.get(profile).name}`);
    }
    this.save();
  }

  async release(b, why) {
    try { await this.client.release(b.userId); } catch (e) { this.say('error', `release of ${b.username} failed: ${e.message}`); return; }
    this.bots.delete(b.userId);
    this.rejected[b.colonyId] = { at: Date.now(), verdict: 'released', reasons: [why] };
    this.say('info', `${b.username} gave colony ${b.colonyId} back (${why})`);
  }

  // ---- turns ----------------------------------------------------------------------------------------------------------
  async turn(b) {
    const P = profiles.get(b.profile);
    try {
      const out = await takeTurn({ config: this.config, api: this.client.forBot(b.userId), profile: P, mem: b.mem });
      b.errors = 0;
      b.last = { at: Date.now(), ...out.summary, actions: out.actions, verdict: out.verdict };
      if (out.verdict === 'give_up') return this.release(b, 'the colony failed or stayed shut down');
      if (out.verdict === 'gone') { this.bots.delete(b.userId); return null; }
      for (const e of out.events) this.say('debug', `${b.username}: ${e}`);
      if (out.events.length && this.s.log !== 'verbose') this.say('info', `${b.username} (${b.profile}): ${out.events.slice(0, 4).join('; ')}${out.events.length > 4 ? '...' : ''}`);
      for (const f of out.failures) this.say('debug', `${b.username} refused: ${f}`);
    } catch (e) {
      b.errors++;
      this.say('error', `${b.username} turn failed: ${e.message}`);
      if (e.status === 404) this.bots.delete(b.userId); // the server no longer knows this bot
    }
    return null;
  }

  async loop() {
    const info = await this.client.info();
    this.tickMs = info.tickMs;
    this.config = await this.client.config();
    await this.poll();
    while (!this.stopped) {
      const started = Date.now();
      if (Date.now() - this.lastPoll >= this.s.pollMs) { try { await this.poll(); } catch (e) { this.say('error', `poll failed: ${e.message}`); } }
      for (const b of [...this.bots.values()]) { if (this.stopped) break; await this.turn(b); }
      this.save();
      const wait = Math.max(1000, this.s.turnTicks * this.tickMs - (Date.now() - started));
      await new Promise((r) => { this.wake = r; this.timer = setTimeout(r, wait); });
    }
  }

  stop() { this.stopped = true; clearTimeout(this.timer); if (this.wake) this.wake(); this.save(); }

  status() {
    return {
      limit: this.s.limit, profiles: this.s.profiles, lastPoll: this.lastPoll,
      bots: [...this.bots.values()].map((b) => ({ user: b.username, profile: b.profile, colony: b.colonyId, claimedAt: b.claimedAt, errors: b.errors, last: b.last, trade: b.mem.trade || null })),
      rejected: this.rejected,
    };
  }
}

async function main() {
  const s = settings();
  if (!s.key || s.key.length < 16) { console.error('BOT_API_KEY must be set (at least 16 characters), the same key the game server was started with.'); process.exit(2); }
  const runner = new Runner(s);
  if (s.statusPort) {
    http.createServer((req, res) => {
      if (req.url === '/status') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(runner.status(), null, 1)); return; }
      if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
      res.writeHead(404); res.end();
    }).listen(Number(s.statusPort), '127.0.0.1', () => runner.say('info', `status on http://127.0.0.1:${s.statusPort}/status`));
  }
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { runner.say('info', `${sig}: stopping`); runner.stop(); setTimeout(() => process.exit(0), 200); });
  runner.say('info', `bot runner for ${s.server}: up to ${s.limit} bots, profiles ${s.profiles.join(', ')}`);
  // the game server may not be up yet: keep trying
  for (;;) {
    try { await runner.loop(); break; } catch (e) {
      runner.say('error', `${e.message}; retrying in 30 s`);
      if (runner.stopped) break;
      await new Promise((r) => setTimeout(r, 30000));
    }
  }
}

if (require.main === module) main();
module.exports = { Runner, settings };
