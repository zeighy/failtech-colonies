#!/usr/bin/env node
'use strict';
// Trace recovery difficulty report: real win rates per game and level, read from minigame_sessions, against the 60-70%
// the levels are meant to land in. Opens the database read-only, so it is safe to run against a live server.
//
//   npm run minigames:report                    every finished play
//   npm run minigames:report -- --days 7        only plays started in the last 7 days
//   npm run minigames:report -- --db path.db    another database (default DB_PATH, or ./failtech.db)
const path = require('path');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const file = opt('db', process.env.DB_PATH || path.join(__dirname, '..', 'failtech.db'));
const days = Number(opt('days', 0));
const since = days > 0 ? Date.now() - days * 86400000 : 0;
const config = JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'game_config.json'), 'utf8'));
const TARGET = [0.6, 0.7];

let db;
try { db = new Database(file, { readonly: true, fileMustExist: true }); } catch (e) { console.error(`Cannot open ${file}: ${e.message}`); process.exit(1); }
if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'minigame_sessions'").get()) { console.error('No minigame_sessions table: this database predates trace recovery.'); process.exit(1); }

const rows = db.prepare(`
  SELECT kind, level, COUNT(*) AS plays, COUNT(DISTINCT colony_id) AS colonies,
    SUM(status = 'won') AS won, SUM(status = 'lost') AS lost, SUM(status = 'expired') AS expired, SUM(status = 'abandoned') AS abandoned
  FROM minigame_sessions WHERE status != 'active' AND started_at >= ? GROUP BY kind, level ORDER BY kind, level`).all(since);
const winTimes = db.prepare("SELECT ended_at - started_at AS ms FROM minigame_sessions WHERE kind = ? AND level = ? AND status = 'won' AND started_at >= ? ORDER BY ms");
const times = (kind, level, from) => winTimes.all(kind, level, from);
const median = (xs) => (xs.length ? xs[Math.floor(xs.length / 2)].ms : null);
const sec = (ms) => (ms === null ? '-' : `${Math.round(ms / 1000)}s`);
const pct = (x) => `${Math.round(x * 100)}%`.padStart(4);

console.log(`Trace recovery, ${days > 0 ? `last ${days} days` : 'all time'} (${file}). Target win rate ${pct(TARGET[0]).trim()}-${pct(TARGET[1]).trim()}.\n`);
if (!rows.length) { console.log('No finished plays yet.'); process.exit(0); }
console.log('game     level  plays colonies  win   lost expired gave-up  median win  verdict');
for (const r of rows) {
  const rate = r.won / r.plays;
  const verdict = r.plays < 20 ? 'too few plays' : rate > TARGET[1] ? 'too easy' : rate < TARGET[0] ? 'too hard' : 'on target';
  const limit = ((config.minigames.games[r.kind] || {}).levels || [])[r.level];
  console.log(`${r.kind.padEnd(8)} L${String(r.level + 1).padEnd(5)} ${String(r.plays).padStart(5)} ${String(r.colonies).padStart(8)} ${pct(rate)} ${String(r.lost).padStart(6)} ${String(r.expired).padStart(7)} ${String(r.abandoned).padStart(7)}  ${sec(median(times(r.kind, r.level, since))).padStart(10)}${limit ? ` /${limit.timeLimitSec}s` : ''}  ${verdict}`);
}
console.log('\nWhere colonies sit now (current level per game):');
for (const r of db.prepare('SELECT kind, level, COUNT(*) AS n FROM minigame_skill GROUP BY kind, level ORDER BY kind, level').all()) console.log(`  ${r.kind.padEnd(8)} L${r.level + 1}: ${r.n}`);
