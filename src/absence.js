'use strict';
// A commander who stops playing should stop costing the server. Everything is measured from their last real interaction
// (signing in, opening the game, a click: see server.js), not from an idle tab left open:
//   live       up to absence.simulateHours  the colony is simulated as normal
//   stewarded  until absence.parkDays       it is no longer simulated and waits exactly as it was. Coming back resumes
//                                           it, with a notice (in the story, Seven ran the place and sent the surplus on)
//   parked     after that                   it stays off the simulation until the commander chooses: retake it, or start
//                                           a new colony. Starting over hands the parked colony to a generated account
//                                           (its station renamed) where it waits to be claimed (claim()).
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const store = require('./db');
const { db, config } = store;

const A = config.global.absence;
const simulateMs = () => A.simulateHours * 3600000;
const parkMs = () => A.parkDays * 86400000;

function phase(c, now = Date.now()) {
  if (!c) return null;
  if (c.parked_at) return 'parked';
  const idle = now - c.last_active_at;
  return idle >= parkMs() ? 'parked' : idle >= simulateMs() ? 'stewarded' : 'live';
}

// The earliest last interaction a colony may have and still be simulated at `tickTime`.
const simulatedSince = (tickTime) => tickTime - simulateMs();

function park(colonyId, now) { db.prepare('UPDATE colonies SET parked_at = ? WHERE id = ? AND parked_at IS NULL').run(now, colonyId); }

// Park every colony whose commander has been gone too long (the engine runs this as time passes).
function sweep(now = Date.now()) {
  return db.prepare('UPDATE colonies SET parked_at = ? WHERE parked_at IS NULL AND last_active_at < ?').run(now, now - parkMs()).changes;
}

// A real interaction. A stewarded colony resumes (and says so once); a parked one waits for the commander's choice.
// Returns true when the colony came back to life, so the caller can push a fresh view.
function markActive(userId, now = Date.now()) {
  const c = db.prepare('SELECT id, last_active_at, parked_at FROM colonies WHERE user_id = ?').get(userId);
  if (!c) return false;
  const p = phase(c, now);
  if (p === 'parked') { park(c.id, now); return false; }
  if (now - c.last_active_at < 30000) return false; // a click a second must not be a write a second
  if (p === 'stewarded') {
    db.prepare('UPDATE colonies SET last_active_at = ?, away_notice = ? WHERE id = ?')
      .run(now, JSON.stringify({ kind: 'stewarded', lastActive: c.last_active_at, frozeAt: c.last_active_at + simulateMs() }), c.id);
    return true;
  }
  db.prepare('UPDATE colonies SET last_active_at = ? WHERE id = ?').run(now, c.id);
  return false;
}

// What the client needs: a notice to show, or the choice a parked colony is waiting on. Null when there is nothing.
function view(c, now = Date.now()) {
  const p = phase(c, now);
  if (p === 'parked') return { phase: p, lastActive: c.last_active_at, parkedAt: c.parked_at || now };
  let notice = null;
  try { notice = c.away_notice ? JSON.parse(c.away_notice) : null; } catch (e) { notice = null; }
  return notice ? { phase: p, notice } : null;
}
// What a commander without a colony sees (it was claimed while parked).
function lostView(userId) {
  const u = db.prepare('SELECT notice FROM users WHERE id = ?').get(userId);
  let n = null;
  try { n = u && u.notice ? JSON.parse(u.notice) : null; } catch (e) { n = null; }
  return n;
}

const fail = (error) => ({ ok: false, error });
const OK = { ok: true };
const colonyOf = (userId) => db.prepare('SELECT * FROM colonies WHERE user_id = ?').get(userId);

const dismiss = db.transaction((userId) => {
  db.prepare('UPDATE colonies SET away_notice = NULL WHERE user_id = ?').run(userId);
  return OK;
});

// Take a parked colony back. It picks up exactly where it stopped.
const retake = db.transaction((userId, now = Date.now()) => {
  const c = colonyOf(userId);
  if (!c) return fail('That colony is no longer yours to retake.');
  if (phase(c, now) !== 'parked') return fail('The colony is not parked.');
  db.prepare('UPDATE colonies SET parked_at = NULL, away_notice = NULL, last_active_at = ? WHERE id = ?').run(now, c.id);
  return OK;
});

// A name nobody has: callsigns and station names share one namespace (see orbital.checkName).
function freeName(make) {
  for (let i = 0; i < 200; i++) {
    const n = make(i);
    if (!db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(n) && !db.prepare('SELECT 1 FROM stations WHERE name = ? COLLATE NOCASE').get(n)) return n;
  }
  throw new Error('No free name found.');
}
const rnd = (n) => crypto.randomInt(n);
const pick = (list) => list[rnd(list.length)];
const STATION_A = ['Halden', 'Corvel', 'Tessary', 'Ostrin', 'Calder', 'Pryne', 'Kessel', 'Brannock', 'Sallow', 'Wexley', 'Arden', 'Tirn', 'Morrow', 'Vashti', 'Lantry', 'Quell'];
const STATION_B = ['Reach', 'Spindle', 'Anchor', 'Lantern', 'Hollow', 'Crown', 'Rest', 'Watch'];
const ROMAN = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'XI', 'XII'];
const randomCallsign = () => freeName((i) => `Cmdr_${crypto.randomBytes(3).toString('hex').toUpperCase()}${i > 20 ? i : ''}`);
const randomStation = () => freeName((i) => `${pick(STATION_A)} ${rnd(2) ? pick(STATION_B) : pick(ROMAN)}${i > 50 ? ` ${i}` : ''}`);

// An account to hold a parked colony. Nobody can sign in to it: its passcode is random and thrown away.
function generatedAccount() {
  const hash = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 4); // the low cost is fine: the secret is 192 random bits
  return Number(db.prepare('INSERT INTO users (username, password, generated) VALUES (?, ?, 1)').run(randomCallsign(), hash).lastInsertRowid);
}

// Hand a colony to another account, keeping it parked, under a new station name.
function moveColony(colonyId, toUserId) {
  db.prepare('UPDATE colonies SET user_id = ?, away_notice = NULL WHERE id = ?').run(toUserId, colonyId);
  const st = db.prepare('SELECT district_id FROM stations WHERE colony_id = ?').get(colonyId);
  if (st) {
    const name = randomStation();
    db.prepare('UPDATE stations SET name = ? WHERE colony_id = ?').run(name, colonyId);
    db.prepare('UPDATE districts SET name = ? WHERE id = ?').run(name, st.district_id);
  }
}

// Start a new colony. A parked colony is not lost: it moves to a generated account and waits there to be claimed.
const startOver = db.transaction((userId, now = Date.now()) => {
  const c = colonyOf(userId);
  if (c) {
    if (phase(c, now) !== 'parked') return fail('The colony is still yours to run.');
    park(c.id, now);
    moveColony(c.id, generatedAccount());
  }
  db.prepare('UPDATE users SET notice = NULL WHERE id = ?').run(userId);
  store.foundColony(userId);
  return OK;
});

// Someone else takes over a parked colony (the bot runner does, through src/botApi.js). The account must
// not have a colony of its own. If the colony still belonged to its commander, they are told when they next sign in.
const claim = db.transaction((colonyId, userId, now = Date.now()) => {
  const c = db.prepare('SELECT * FROM colonies WHERE id = ?').get(colonyId);
  if (!c || phase(c, now) !== 'parked') return fail('Only a parked colony can be claimed.');
  if (colonyOf(userId)) return fail('That account already runs a colony.');
  const prev = db.prepare('SELECT id, generated FROM users WHERE id = ?').get(c.user_id);
  if (prev && !prev.generated) db.prepare('UPDATE users SET notice = ? WHERE id = ?').run(JSON.stringify({ kind: 'claimed', at: now }), prev.id);
  moveColony(colonyId, userId);
  db.prepare('UPDATE colonies SET parked_at = NULL, last_active_at = ? WHERE id = ?').run(now, colonyId);
  return OK;
});

// A colony someone else was running (a bot) is given up: it parks again under a generated account, to be claimed afresh.
const release = db.transaction((colonyId, now = Date.now()) => {
  moveColony(colonyId, generatedAccount());
  db.prepare('UPDATE colonies SET parked_at = ? WHERE id = ?').run(now, colonyId);
  return OK;
});

// Parked colonies waiting to be claimed, oldest first.
function listParked(limit = 50) {
  return db.prepare('SELECT c.id, c.user_id AS userId, u.username, u.generated, c.parked_at AS parkedAt, c.last_active_at AS lastActive FROM colonies c JOIN users u ON u.id = c.user_id WHERE c.parked_at IS NOT NULL ORDER BY c.parked_at LIMIT ?').all(limit);
}

module.exports = { phase, simulatedSince, sweep, markActive, view, lostView, dismiss, retake, startOver, claim, release, listParked, generatedAccount };
