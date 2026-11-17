'use strict';
// Trace recovery: unlocking, paying (free daily play, standing, daily cap), the three games judged on the server, the
// award toward a fragment, difficulty that follows the streak, expiry, and what the client is (not) told.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failtech-mini-'));
process.env.DB_PATH = path.join(dir, 'mini.db');
process.env.SESSION_SECRET = 'x';
process.env.THEME = 'basic';
process.env.HAZARDS = 'off';
const store = require('../src/db');
const actions = require('../src/actions');
const mini = require('../src/minigames');
const { viewFor } = require('../src/state');
const { db, config } = store;
const G = config.minigames;
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let n = 0;
function colony({ unlocked = true, standing = 0 } = {}) {
  const uid = Number(db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(`mg${++n}`, 'x').lastInsertRowid);
  const id = store.ensureColony(uid);
  if (unlocked) db.prepare("INSERT INTO colony_data_packets (colony_id, packet_id, level) VALUES (?, 'p01', 1)").run(id);
  if (standing) db.prepare("INSERT INTO standing (colony_id, faction, points) VALUES (?, ?, ?)").run(id, Object.keys(config.missions.factions)[0], standing);
  return { uid, id, row: () => db.prepare('SELECT * FROM colonies WHERE id = ?').get(id) };
}
// Only these games are dealt while fn runs.
function only(kind, fn) {
  const saved = G.games;
  G.games = { [kind]: saved[kind] };
  try { return fn(); } finally { G.games = saved; }
}
const secretOf = (id) => JSON.parse(db.prepare('SELECT secret FROM minigame_sessions WHERE id = ?').get(id).secret);
const successes = (c) => c.row().data_successes;
const NOON = Date.UTC(2026, 10, 13, 12);
const DAY = 86400000;

test('locked until a data packet has been read', () => {
  const c = colony({ unlocked: false });
  assert.match(mini.start(c.row(), {}, NOON, 1).error, /opens once/);
  assert.equal(viewFor(c.uid).minigame.unlocked, false);
  assert.match(actions.minigameStart(c.uid, {}).error, /opens once/);
});

test('one free play a day, then standing, with a daily cap; earned standing is untouched', () => {
  const c = colony({ standing: G.cost * 20 });
  const play = (now, args = {}) => { const r = mini.start(c.row(), args, now, 1); if (r.ok) mini.quit(c.row(), { id: r.session.id }, now, 1); return r; };
  const a = play(NOON);
  assert.equal(a.session.paid, 'free');
  assert.equal(c.row().standing_spent, 0);
  assert.match(mini.start(c.row(), { paid: 'free' }, NOON, 1).error, /free trace has been used/);
  for (let i = 0; i < G.paidPerDay; i++) assert.equal(play(NOON + i).session.paid, 'standing');
  assert.equal(c.row().standing_spent, G.cost * G.paidPerDay);
  assert.match(mini.start(c.row(), {}, NOON, 1).error, new RegExp(`all ${G.paidPerDay} paid`));
  const s = mini.standing(c.row());
  assert.equal(s.earned, G.cost * 20, 'earned standing is the faction score, unchanged');
  assert.equal(s.spendable, G.cost * (20 - G.paidPerDay));
  // the next day: free again, and the paid count starts over
  assert.equal(play(NOON + DAY).session.paid, 'free');
  assert.equal(play(NOON + DAY).session.paid, 'standing');
});

test('standing must cover the cost', () => {
  const c = colony({ standing: G.cost - 1 });
  const r = mini.start(c.row(), {}, NOON, 1);
  mini.quit(c.row(), { id: r.session.id }, NOON, 1);
  assert.match(mini.start(c.row(), {}, NOON, 1).error, new RegExp(`costs ${G.cost} standing`));
  assert.equal(c.row().standing_spent, 0);
});

test('only one trace at a time, and moves only on the open one', () => {
  const c = colony({ standing: 500 });
  const r = mini.start(c.row(), {}, NOON, 1);
  assert.match(mini.start(c.row(), { paid: 'standing' }, NOON, 1).error, /already open/);
  assert.match(mini.move(c.row(), { id: r.session.id + 99, input: {} }, NOON, 1).error, /not open/);
});

test('cipher: the key stays on the server; solving it adds one success toward a fragment', () => only('cipher', () => {
  const c = colony();
  const r = mini.start(c.row(), {}, NOON, 1);
  assert.equal(r.session.kind, 'cipher');
  assert.equal(r.session.game.code, undefined);
  assert.equal(viewFor(c.uid).minigame.active.game.code, undefined);
  assert.ok(!JSON.stringify(viewFor(c.uid).minigame).includes('secret'));
  const { code } = secretOf(r.session.id);
  assert.match(mini.move(c.row(), { id: r.session.id, input: { guess: [0] } }, NOON, 1).error, /symbols/);
  assert.match(mini.move(c.row(), { id: r.session.id, input: { guess: code.map(() => 99) } }, NOON, 1).error, /Unknown symbol/);
  const wrong = code.map((k) => (k + 1) % r.session.game.symbols);
  const w = mini.move(c.row(), { id: r.session.id, input: { guess: wrong } }, NOON + 1000, 1);
  assert.equal(w.status, 'active');
  assert.equal(w.reply.exact, 0);
  const before = successes(c);
  const win = mini.move(c.row(), { id: r.session.id, input: { guess: code } }, NOON + 2000, 1);
  assert.equal(win.status, 'won');
  assert.deepEqual(win.session.game.code, code, 'revealed once it is over');
  assert.equal(successes(c), before + 1);
  assert.equal(win.award.wins, before + 1);
  assert.equal(viewFor(c.uid).minigame.active, null);
}));

test('cipher scoring counts misplaced symbols once', () => {
  const L = { length: 4, symbols: 6, guesses: 9 };
  const st = { guesses: [] };
  const r = mini.GAMES.cipher.move(L, { code: [0, 0, 1, 2] }, st, { guess: [0, 1, 0, 0] });
  assert.deepEqual(r.reply, { exact: 1, near: 2 });
});

test('cipher: running out of guesses loses', () => only('cipher', () => {
  const c = colony();
  const r = mini.start(c.row(), {}, NOON, 1);
  const { code } = secretOf(r.session.id);
  const wrong = code.map((k) => (k + 1) % r.session.game.symbols);
  let last;
  for (let i = 0; i < r.session.game.maxGuesses; i++) last = mini.move(c.row(), { id: r.session.id, input: { guess: wrong } }, NOON, 1);
  assert.equal(last.status, 'lost');
  assert.equal(successes(c), 0);
}));

test('sweep: the board is laid after the first read, which is safe; reading every clean sector wins', () => only('sweep', () => {
  const c = colony();
  const r = mini.start(c.row(), {}, NOON, 1);
  const g = r.session.game, total = g.width * g.height;
  assert.equal(secretOf(r.session.id).bad, null);
  const first = mini.move(c.row(), { id: r.session.id, input: { cell: 0 } }, NOON, 1);
  assert.equal(first.status, 'active');
  assert.equal(first.session.game.corrupted, undefined);
  const bad = new Set(secretOf(r.session.id).bad);
  assert.equal(bad.size, g.bad);
  assert.ok(!bad.has(0));
  assert.match(mini.move(c.row(), { id: r.session.id, input: { cell: 0 } }, NOON, 1).error, /been read/);
  let res = first;
  for (let i = 0; i < total && res.status === 'active'; i++) {
    if (bad.has(i) || res.session.game.open[i] !== undefined) continue;
    res = mini.move(c.row(), { id: r.session.id, input: { cell: i } }, NOON, 1);
  }
  assert.equal(res.status, 'won');
  assert.equal(successes(c), 1);
}));

test('sweep: reading corrupted sectors spends integrity, then loses', () => only('sweep', () => {
  const c = colony();
  const r = mini.start(c.row(), {}, NOON, 1);
  mini.move(c.row(), { id: r.session.id, input: { cell: 0 } }, NOON, 1);
  const bad = secretOf(r.session.id).bad;
  let res;
  for (let i = 0; i < r.session.game.integrity; i++) res = mini.move(c.row(), { id: r.session.id, input: { cell: bad[i] } }, NOON, 1);
  assert.equal(res.status, 'lost');
  assert.deepEqual(res.session.game.corrupted, bad);
}));

test('relay: the scrambled grid does not hold; the server accepts a working layout and refuses a broken one', () => only('relay', () => {
  const c = colony({ standing: 500 });
  const r = mini.start(c.row(), {}, NOON, 1);
  const g = r.session.game;
  assert.equal(g.solution, undefined);
  assert.equal(mini.relayValid(g.size, g.core, g.tiles), false);
  const { solution } = secretOf(r.session.id);
  const turns = g.tiles.map((m, i) => [0, 1, 2, 3].find((k) => mini.turn(m, k) === solution[i]));
  assert.match(mini.move(c.row(), { id: r.session.id, input: { turns } }, NOON + 100, 1).error, /settling/, 'too fast to be a person');
  assert.match(mini.move(c.row(), { id: r.session.id, input: { turns: [1] } }, NOON + 10000, 1).error, /every tile/);
  const win = mini.move(c.row(), { id: r.session.id, input: { turns } }, NOON + 10000, 1);
  assert.equal(win.status, 'won');
  // a broken layout ends it as a loss
  const r2 = mini.start(c.row(), {}, NOON, 1);
  const lose = mini.move(c.row(), { id: r2.session.id, input: { turns: r2.session.game.tiles.map(() => 0) } }, NOON + 10000, 1);
  assert.equal(lose.status, 'lost');
  assert.ok(lose.session.game.solution);
}));

test('relay layouts are trees: any rotation of the tiles that connects everything is accepted', () => {
  // two tiles side by side: an east end and a west end
  assert.equal(mini.relayValid(2, 0, [2, 8, 0, 0].slice(0, 4)), false, 'the bottom row is not reached');
  assert.equal(mini.relayValid(2, 0, [6, 8, 1, 0]), false, 'the last tile is not reached');
  assert.equal(mini.relayValid(2, 0, [6, 12, 1, 1]), true);
  assert.equal(mini.relayValid(2, 0, [3, 8, 0, 0]), false, 'an open side at the edge');
});

test('difficulty follows the streak, per game', () => only('cipher', () => {
  const c = colony({ standing: 5000 });
  const win = () => { const r = mini.start(c.row(), { paid: 'standing' }, NOON, 1); return mini.move(c.row(), { id: r.session.id, input: { guess: secretOf(r.session.id).code } }, NOON, 1); };
  const lose = () => { const r = mini.start(c.row(), { paid: 'standing' }, NOON + DAY, 1); return mini.quit(c.row(), { id: r.session.id }, NOON + DAY, 1); };
  const level = () => viewFor(c.uid).minigame.games.cipher.level;
  for (let i = 0; i < G.promoteAfter - 1; i++) assert.equal(win().levelChanged, false);
  assert.equal(level(), 0);
  assert.equal(win().levelChanged, true);
  assert.equal(level(), 1);
  const r = mini.start(c.row(), { paid: 'standing' }, NOON, 1);
  assert.equal(r.session.level, 1);
  assert.equal(r.session.game.symbols, G.games.cipher.levels[1].symbols);
  mini.quit(c.row(), { id: r.session.id }, NOON, 1);
  for (let i = 0; i < G.demoteAfter - 1; i++) lose();
  assert.equal(level(), 0, 'a win then two losses in a row: back down');
  for (let i = 0; i < G.demoteAfter + 2; i++) lose();
  assert.equal(level(), 0, 'never below the first level');
}));

test('a trace past its time is lost, and does not block the next one', () => only('cipher', () => {
  const c = colony({ standing: 500 });
  const r = mini.start(c.row(), {}, NOON, 1);
  const late = r.session.expiresAt + 1;
  const { code } = secretOf(r.session.id);
  const m = mini.move(c.row(), { id: r.session.id, input: { guess: code } }, late, 1);
  assert.equal(m.status, 'expired');
  assert.equal(successes(c), 0);
  const r2 = mini.start(c.row(), {}, late, 1);
  const s2 = mini.start(c.row(), {}, r2.session.expiresAt + 5, 1);
  assert.ok(s2.ok, 'an expired session is settled when the next one starts');
  assert.equal(db.prepare('SELECT status FROM minigame_sessions WHERE id = ?').get(r2.session.id).status, 'expired');
}));

test('the seventh success makes a fragment', () => only('cipher', () => {
  const c = colony();
  db.prepare('UPDATE colonies SET data_successes = ? WHERE id = ?').run(config.orbital.territories.dataSite.attemptsPerFragment - 1, c.id);
  const before = c.row().data_fragments;
  const r = mini.start(c.row(), {}, NOON, 1);
  const win = mini.move(c.row(), { id: r.session.id, input: { guess: secretOf(r.session.id).code } }, NOON, 1);
  assert.equal(win.award.fragment, true);
  assert.equal(c.row().data_fragments, before + 1);
  assert.equal(c.row().data_successes, 0);
}));

test('higher levels give extra progress: 1, 1, 2, 2, 3', () => only('cipher', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(mini.stepsFor), [1, 1, 2, 2, 3]);
  const c = colony({ standing: 5000 });
  let t = NOON;
  for (const [level, steps] of [[2, 2], [4, 3]]) {
    db.prepare("INSERT INTO minigame_skill (colony_id, kind, level, streak) VALUES (?, 'cipher', ?, 0) ON CONFLICT (colony_id, kind) DO UPDATE SET level = excluded.level, streak = 0").run(c.id, level);
    db.prepare('UPDATE colonies SET data_successes = 0 WHERE id = ?').run(c.id);
    const r = mini.start(c.row(), {}, t, 1);
    assert.equal(r.session.level, level);
    const win = mini.move(c.row(), { id: r.session.id, input: { guess: secretOf(r.session.id).code } }, t, 1);
    assert.equal(win.award.steps, steps);
    assert.equal(successes(c), steps);
    t += 1000;
  }
}));

test('extra progress past a fragment carries into the next', () => only('cipher', () => {
  const c = colony();
  const per = config.orbital.territories.dataSite.attemptsPerFragment;
  db.prepare("INSERT INTO minigame_skill (colony_id, kind, level, streak) VALUES (?, 'cipher', 4, 0)").run(c.id);
  db.prepare('UPDATE colonies SET data_successes = ? WHERE id = ?').run(per - 1, c.id);
  const before = c.row().data_fragments;
  const r = mini.start(c.row(), {}, NOON, 1);
  const win = mini.move(c.row(), { id: r.session.id, input: { guess: secretOf(r.session.id).code } }, NOON, 1);
  assert.equal(win.award.fragment, true);
  assert.equal(win.award.carried, 2);
  assert.equal(c.row().data_fragments, before + 1);
  assert.equal(successes(c), 2);
}));

test('the server day and its midnight', () => {
  const saved = G.timezone;
  G.timezone = 'America/Toronto';
  try {
    const t = Date.UTC(2026, 10, 14, 3, 30); // 22:30 on the 13th in Toronto (UTC-5)
    assert.equal(mini.dayKey(t), '2026-11-13');
    assert.equal(mini.nextReset(t), Date.UTC(2026, 10, 14, 5));
  } finally { G.timezone = saved; }
});

test('the actions are wired to the player routes and refused to bots', () => {
  const routes = new Map(require('../src/routes'));
  for (const r of ['minigame-start', 'minigame-move', 'minigame-quit']) assert.ok(routes.has(r));
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'botApi.js'), 'utf8'), /REFUSED = new Set\([^)]*'minigame-start', 'minigame-move', 'minigame-quit'/);
});

test('finished sessions are kept for the report, their boards dropped after two weeks', () => only('cipher', () => {
  const c = colony({ standing: 500 });
  const r = mini.start(c.row(), {}, NOON, 1);
  mini.quit(c.row(), { id: r.session.id }, NOON, 1);
  mini.start(c.row(), {}, NOON + 15 * DAY, 1);
  const old = db.prepare('SELECT status, secret, state FROM minigame_sessions WHERE id = ?').get(r.session.id);
  assert.deepEqual(old, { status: 'abandoned', secret: '{}', state: '{}' });
}));

test('every game has levels that get no easier: cipher slack, sweep density and lives, relay time per tile', () => {
  const g = G.games;
  for (let i = 1; i < g.cipher.levels.length; i++) {
    const [a, b] = [g.cipher.levels[i - 1], g.cipher.levels[i]];
    assert.ok(b.symbols ** b.length >= a.symbols ** a.length && b.guesses <= a.guesses, `cipher L${i + 1}`);
  }
  for (let i = 1; i < g.relay.levels.length; i++) {
    const per = (l) => l.timeLimitSec / (l.size * l.size);
    assert.ok(per(g.relay.levels[i]) < per(g.relay.levels[i - 1]), `relay L${i + 1}`);
  }
  const sw = g.sweep.levels;
  for (let i = 1; i < sw.length; i++) assert.ok(sw[i].integrity <= sw[i - 1].integrity && sw[i].width * sw[i].height >= sw[i - 1].width * sw[i - 1].height, `sweep L${i + 1}`);
});
