'use strict';
// Trace recovery: short puzzles that earn one successful recovery attempt toward the next data fragment, the same as a
// Data Recovery rig's (territories.addDataSuccess). Opens once the colony has read its first data packet.
//
// Server-authoritative. The server makes every puzzle (with crypto randomness, so it cannot be predicted from the colony
// or the tick), keeps it, and judges every move. The client is told only what a player may see:
//   cipher  the key never leaves the server; each guess is scored here
//   sweep   the corrupted sectors never leave the server; each read is answered here
//   relay   the scrambled grid is public (the player turns tiles in the client); the server checks the final layout
// The secret is revealed in the reply that ends a session, never before.
//
// Paying: one free play a server day, then `cost` standing a play, at most `paidPerDay` a day. Standing is spent from a
// separate counter (colonies.standing_spent): the standing a colony has earned stays its faction score.
// Difficulty: each game has its own level per colony, moved up after `promoteAfter` wins in a row and down after
// `demoteAfter` losses in a row.
const crypto = require('crypto');
const store = require('./db');
const orbital = require('./orbital');
const territories = require('./territories');
const { toInt } = require('./validate');
const { db, config } = store;

const fail = (error) => ({ ok: false, error });
const M = () => config.minigames;
const ri = (n) => crypto.randomInt(n);

// ---- the server day ---------------------------------------------------------------------------------------------
const zone = () => M().timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
function parts(ms) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: zone(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const p = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
const dayKey = (ms) => { const p = parts(ms); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };
// The next midnight in the server's zone, as a timestamp (the zone's offset now, applied to tomorrow's midnight).
function nextReset(ms) {
  const p = parts(ms);
  const off = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
  return Date.UTC(p.y, p.m - 1, p.d + 1) - off;
}

// ---- the three games --------------------------------------------------------------------------------------------
// Each: make(L) -> { secret, state }; view(L, state, secret|null) -> what the client sees (secret only once it is over);
// move(L, secret, state, input, ctx) -> { error } | { status: 'active'|'won'|'lost', reply }  (it may change state/secret).

const cipher = {
  make(L) { return { secret: { code: Array.from({ length: L.length }, () => ri(L.symbols)) }, state: { guesses: [] } }; },
  view(L, st, sec) { return { length: L.length, symbols: L.symbols, maxGuesses: L.guesses, guesses: st.guesses, code: sec ? sec.code : undefined }; },
  move(L, sec, st, input) {
    const g = input && input.guess;
    if (!Array.isArray(g) || g.length !== L.length) return { error: `A guess is ${L.length} symbols.` };
    const guess = g.map(toInt);
    if (guess.some((x) => Number.isNaN(x) || x < 0 || x >= L.symbols)) return { error: 'Unknown symbol.' };
    let exact = 0;
    const a = new Array(L.symbols).fill(0); const b = new Array(L.symbols).fill(0);
    for (let i = 0; i < L.length; i++) {
      if (guess[i] === sec.code[i]) exact++;
      else { a[guess[i]]++; b[sec.code[i]]++; }
    }
    let near = 0;
    for (let k = 0; k < L.symbols; k++) near += Math.min(a[k], b[k]);
    st.guesses.push({ guess, exact, near });
    const status = exact === L.length ? 'won' : st.guesses.length >= L.guesses ? 'lost' : 'active';
    return { status, reply: { exact, near } };
  },
};

const around = (w, h, i) => {
  const x = i % w, y = Math.floor(i / w), out = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < w && ny < h) out.push(ny * w + nx);
  }
  return out;
};
const sweep = {
  // The board is laid on the first read, away from it (and its neighbours where there is room), so the first read is safe.
  make() { return { secret: { bad: null }, state: { open: {}, blown: [], hits: 0 } }; },
  view(L, st, sec) {
    return { width: L.width, height: L.height, bad: L.bad, integrity: L.integrity, hits: st.hits, open: st.open, blown: st.blown,
      corrupted: sec ? (sec.bad || []) : undefined };
  },
  move(L, sec, st, input) {
    const n = L.width * L.height, cell = toInt(input && input.cell);
    if (Number.isNaN(cell) || cell < 0 || cell >= n) return { error: 'No such sector.' };
    if (st.open[cell] !== undefined || st.blown.includes(cell)) return { error: 'That sector has been read.' };
    if (!sec.bad) {
      const keep = new Set([cell, ...around(L.width, L.height, cell)]);
      let pool = [...Array(n).keys()].filter((i) => !keep.has(i));
      if (pool.length < L.bad) pool = [...Array(n).keys()].filter((i) => i !== cell);
      for (let i = pool.length - 1; i > 0; i--) { const j = ri(i + 1); [pool[i], pool[j]] = [pool[j], pool[i]]; }
      sec.bad = pool.slice(0, L.bad).sort((a, b) => a - b);
    }
    const bad = new Set(sec.bad);
    if (bad.has(cell)) {
      st.blown.push(cell); st.hits++;
      return { status: st.hits >= L.integrity ? 'lost' : 'active', reply: { corrupted: true } };
    }
    const count = (i) => around(L.width, L.height, i).filter((j) => bad.has(j)).length;
    const todo = [cell];
    while (todo.length) {
      const i = todo.pop();
      if (st.open[i] !== undefined || bad.has(i)) continue;
      st.open[i] = count(i);
      if (st.open[i] === 0) for (const j of around(L.width, L.height, i)) if (st.open[j] === undefined && !st.blown.includes(j)) todo.push(j);
    }
    return { status: Object.keys(st.open).length >= n - L.bad ? 'won' : 'active', reply: {} };
  },
};

// Relay tiles are bit masks of their open sides: N 1, E 2, S 4, W 8. Turning a tile a quarter clockwise shifts them left.
const DIRS = [[1, 0, -1, 4], [2, 1, 0, 8], [4, 0, 1, 1], [8, -1, 0, 2]]; // [bit, dx, dy, opposite bit]
const turn = (m, k) => { for (let i = 0; i < (k & 3); i++) m = ((m << 1) | (m >> 3)) & 15; return m; };
// Every open side meets an open side, and every tile is reached from the core. (The tiles come from a tree, so a layout
// that passes has no loops: rotating a tile does not change how many sides are open.)
function relayValid(size, core, masks) {
  for (let i = 0; i < masks.length; i++) {
    const x = i % size, y = Math.floor(i / size);
    for (const [bit, dx, dy, opp] of DIRS) {
      if (!(masks[i] & bit)) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size || !(masks[ny * size + nx] & opp)) return false;
    }
  }
  const seen = new Set([core]); const todo = [core];
  while (todo.length) {
    const i = todo.pop(), x = i % size, y = Math.floor(i / size);
    for (const [bit, dx, dy] of DIRS) if (masks[i] & bit) { const j = (y + dy) * size + x + dx; if (!seen.has(j)) { seen.add(j); todo.push(j); } }
  }
  return seen.size === masks.length;
}
// A random spanning tree grown out from the centre, no tile with more than three sides (a four-way tile cannot be turned).
function relayTree(size) {
  const n = size * size, core = Math.floor(size / 2) * size + Math.floor(size / 2);
  for (;;) {
    const masks = new Array(n).fill(0), inTree = new Set([core]);
    const deg = (m) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);
    while (inTree.size < n) {
      const edges = [];
      for (const i of inTree) {
        if (deg(masks[i]) >= 3) continue;
        const x = i % size, y = Math.floor(i / size);
        for (const [bit, dx, dy, opp] of DIRS) {
          const nx = x + dx, ny = y + dy, j = ny * size + nx;
          if (nx >= 0 && ny >= 0 && nx < size && ny < size && !inTree.has(j)) edges.push([i, j, bit, opp]);
        }
      }
      if (!edges.length) break;
      const [i, j, bit, opp] = edges[ri(edges.length)];
      masks[i] |= bit; masks[j] |= opp; inTree.add(j);
    }
    if (inTree.size === n) return { core, masks };
  }
}
const relay = {
  make(L) {
    const { core, masks } = relayTree(L.size);
    let tiles;
    do tiles = masks.map((m) => turn(m, ri(4))); while (relayValid(L.size, core, tiles));
    return { secret: { solution: masks }, state: { tiles, core } };
  },
  view(L, st, sec) { return { size: L.size, core: st.core, tiles: st.tiles, solution: sec ? sec.solution : undefined }; },
  // One move: the whole layout, as quarter turns for each tile. It is final: a layout that does not hold loses.
  move(L, sec, st, input, ctx) {
    const rot = input && input.turns;
    if (!Array.isArray(rot) || rot.length !== st.tiles.length) return { error: 'Send a turn for every tile.' };
    const k = rot.map(toInt);
    if (k.some((x) => Number.isNaN(x) || x < 0 || x > 3)) return { error: 'A tile turns 0 to 3 quarters.' };
    if (ctx.elapsed < (M().games.relay.minSolveSec || 0) * 1000) return { error: 'The relay is still settling. Try again in a moment.' };
    const masks = st.tiles.map((m, i) => turn(m, k[i]));
    st.turns = k;
    return { status: relayValid(L.size, st.core, masks) ? 'won' : 'lost', reply: {} };
  },
};

const GAMES = { cipher, sweep, relay };
const kinds = () => Object.keys(GAMES).filter((k) => M().games[k] && M().games[k].levels && M().games[k].levels.length);
const levelOf = (kind, level) => { const ls = M().games[kind].levels; return ls[Math.max(0, Math.min(ls.length - 1, level))]; };

// ---- the colony's side ------------------------------------------------------------------------------------------
const unlocked = (c) => !!db.prepare('SELECT 1 FROM colony_data_packets WHERE colony_id = ? AND level >= 1').get(c.id);
function standing(c) {
  const earned = orbital.standingTotal(c.id);
  const spent = db.prepare('SELECT standing_spent AS n FROM colonies WHERE id = ?').get(c.id).n;
  return { earned, spent, spendable: Math.max(0, earned - spent) };
}
const used = (c, day, paid) => db.prepare('SELECT COUNT(*) AS n FROM minigame_sessions WHERE colony_id = ? AND day = ? AND paid = ?').get(c.id, day, paid).n;
const skillOf = (c, kind) => db.prepare('SELECT level, streak FROM minigame_skill WHERE colony_id = ? AND kind = ?').get(c.id, kind) || { level: 0, streak: 0 };
const activeRow = (c) => db.prepare("SELECT * FROM minigame_sessions WHERE colony_id = ? AND status = 'active'").get(c.id);

// Win or lose, the game's level for this colony follows the streak.
function adjust(c, kind, won) {
  const G = M(); const top = G.games[kind].levels.length - 1;
  let { level, streak } = skillOf(c, kind);
  level = Math.max(0, Math.min(top, level));
  streak = won ? Math.max(streak, 0) + 1 : Math.min(streak, 0) - 1;
  if (won && streak >= G.promoteAfter) { if (level < top) level++; streak = 0; }
  if (!won && -streak >= G.demoteAfter) { if (level > 0) level--; streak = 0; }
  db.prepare('INSERT INTO minigame_skill (colony_id, kind, level, streak) VALUES (?, ?, ?, ?) ON CONFLICT (colony_id, kind) DO UPDATE SET level = excluded.level, streak = excluded.streak')
    .run(c.id, kind, level, streak);
  return level;
}

// Close a session. The status guard makes it happen once, however many requests race for it.
function finish(c, row, status, now, tick) {
  const changed = db.prepare("UPDATE minigame_sessions SET status = ?, ended_at = ?, state = ?, secret = ? WHERE id = ? AND status = 'active'")
    .run(status, now, row.state, row.secret, row.id).changes;
  if (!changed) return null;
  const won = status === 'won';
  const level = adjust(c, row.kind, won);
  const name = M().games[row.kind].name;
  const award = won ? territories.addDataSuccess(c, tick, `${name}: a trace was recovered`) : null;
  if (!won) store.addEvent(c.id, tick, 'info', `${name}: the trace was lost.`);
  return { award, level, levelChanged: level !== row.level };
}

function publicSession(row, over) {
  const L = levelOf(row.kind, row.level), st = JSON.parse(row.state), sec = over ? JSON.parse(row.secret) : null;
  return { id: row.id, kind: row.kind, name: M().games[row.kind].name, level: row.level, paid: row.paid, startedAt: row.started_at, expiresAt: row.expires_at,
    status: row.status, game: GAMES[row.kind].view(L, st, sec) };
}

// A session past its time is lost. Called by every minigame action, so a stale one never blocks a new play.
function settleExpired(c, now, tick) {
  const row = activeRow(c);
  if (row && now > row.expires_at) { finish(c, row, 'expired', now, tick); return db.prepare('SELECT * FROM minigame_sessions WHERE id = ?').get(row.id); }
  return null;
}

// Start a play: the free one when it is there (or when asked for), otherwise one paid with standing.
function start(c, args, now, tick) {
  const G = M();
  if (!unlocked(c)) return fail('Trace recovery opens once you have read a data packet.');
  settleExpired(c, now, tick);
  if (activeRow(c)) return fail('A trace is already open. Finish it or let it go first.');
  const day = dayKey(now);
  const freeLeft = used(c, day, 'free') < G.freePerDay;
  const want = args && args.paid === 'standing' ? 'standing' : args && args.paid === 'free' ? 'free' : freeLeft ? 'free' : 'standing';
  if (want === 'free' && !freeLeft) return fail('Today\'s free trace has been used. It comes back at midnight.');
  if (want === 'standing') {
    if (used(c, day, 'standing') >= G.paidPerDay) return fail(`That is all ${G.paidPerDay} paid traces for today. More at midnight.`);
    if (standing(c).spendable < G.cost) return fail(`A trace costs ${G.cost} standing.`);
    db.prepare('UPDATE colonies SET standing_spent = standing_spent + ? WHERE id = ?').run(G.cost, c.id);
  }
  // A different game from the last one, when there is a choice.
  const last = db.prepare('SELECT kind FROM minigame_sessions WHERE colony_id = ? ORDER BY id DESC LIMIT 1').get(c.id);
  let pool = kinds();
  if (last && pool.length > 1) pool = pool.filter((k) => k !== last.kind);
  const kind = pool[ri(pool.length)];
  const level = Math.max(0, Math.min(G.games[kind].levels.length - 1, skillOf(c, kind).level));
  const L = levelOf(kind, level);
  const { secret, state } = GAMES[kind].make(L);
  const id = Number(db.prepare(`INSERT INTO minigame_sessions (colony_id, kind, level, paid, cost, day, secret, state, started_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.id, kind, level, want, want === 'standing' ? G.cost : 0, day, JSON.stringify(secret), JSON.stringify(state), now, now + L.timeLimitSec * 1000).lastInsertRowid);
  // Finished sessions are kept for the difficulty report (scripts/minigame-report.js); their boards are dropped after two weeks.
  db.prepare("UPDATE minigame_sessions SET secret = '{}', state = '{}' WHERE colony_id = ? AND status != 'active' AND started_at < ? AND state != '{}'").run(c.id, now - 14 * 86400000);
  return { ok: true, session: publicSession(db.prepare('SELECT * FROM minigame_sessions WHERE id = ?').get(id), false) };
}

function ended(c, row, status, now, tick, reply) {
  const r = finish(c, row, status, now, tick);
  const after = db.prepare('SELECT * FROM minigame_sessions WHERE id = ?').get(row.id);
  return { ok: true, status: after.status, reply, award: r ? r.award : null, levelChanged: r ? r.levelChanged : false, session: publicSession(after, true) };
}

function move(c, args, now, tick) {
  const row = activeRow(c);
  const id = toInt(args && args.id);
  if (!row || row.id !== id) {
    const old = !Number.isNaN(id) && db.prepare('SELECT * FROM minigame_sessions WHERE id = ? AND colony_id = ?').get(id, c.id);
    return old && old.status !== 'active' ? { ok: true, status: old.status, session: publicSession(old, true) } : fail('That trace is not open.');
  }
  if (now > row.expires_at) return ended(c, row, 'expired', now, tick, null);
  const L = levelOf(row.kind, row.level), sec = JSON.parse(row.secret), st = JSON.parse(row.state);
  const r = GAMES[row.kind].move(L, sec, st, args.input, { elapsed: now - row.started_at });
  if (r.error) return fail(r.error);
  row.secret = JSON.stringify(sec); row.state = JSON.stringify(st);
  if (r.status !== 'active') return ended(c, row, r.status, now, tick, r.reply);
  db.prepare("UPDATE minigame_sessions SET secret = ?, state = ? WHERE id = ? AND status = 'active'").run(row.secret, row.state, row.id);
  return { ok: true, status: 'active', reply: r.reply, session: publicSession(row, false) };
}

// Give up the open trace (or close one whose time ran out). It counts as a loss.
function quit(c, args, now, tick) {
  const row = activeRow(c);
  if (!row) return fail('No trace is open.');
  const id = toInt(args && args.id);
  if (!Number.isNaN(id) && id !== row.id) return fail('That trace is not open.');
  return ended(c, row, now > row.expires_at ? 'expired' : 'abandoned', now, tick, null);
}

function view(c, now = Date.now()) {
  const G = M();
  if (!G) return null;
  const open = unlocked(c);
  const day = dayKey(now);
  const row = open ? activeRow(c) : null;
  return {
    unlocked: open, cost: G.cost, standing: standing(c), serverNow: now, nextReset: nextReset(now),
    free: { used: used(c, day, 'free'), limit: G.freePerDay },
    paid: { used: used(c, day, 'standing'), limit: G.paidPerDay },
    games: Object.fromEntries(kinds().map((k) => [k, { name: G.games[k].name, blurb: G.games[k].blurb, level: Math.min(skillOf(c, k).level, G.games[k].levels.length - 1), levels: G.games[k].levels.length }])),
    active: row ? publicSession(row, false) : null,
  };
}

module.exports = { start, move, quit, view, dayKey, nextReset, relayValid, turn, standing, unlocked, GAMES };
