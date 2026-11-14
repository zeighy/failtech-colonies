'use strict';
// Automatic database backups. SQLite's online backup copies a consistent snapshot while the game keeps running.
//   BACKUP_INTERVAL_HOURS  how often (default 6; 0 turns backups off)
//   BACKUP_KEEP            how many to keep (default 28, so a week at the default interval)
//   BACKUP_DIR             where they go (default: backups/ beside the database)
// Backups hold password hashes, so the folder is owner-only like the database itself. To restore: stop the server,
// copy a backup over the database file (and delete its -wal and -shm files), then start the server again.
const fs = require('fs');
const path = require('path');
const store = require('./db');
const note = (level, msg) => { try { require('./serverlog').write(level, 'backup', msg); } catch (e) { /* the log is best effort */ } };

const NAME = /^failtech-(\d{8})-(\d{6})\.db$/;
const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);

const settings = () => ({
  hours: num(process.env.BACKUP_INTERVAL_HOURS, 6),
  keep: Math.max(1, Math.floor(num(process.env.BACKUP_KEEP, 28))),
  dir: process.env.BACKUP_DIR || path.join(path.dirname(store.db.name), 'backups'),
});

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => NAME.test(f)).sort() : []);

// Delete the oldest backups beyond `keep`. Only files that look like ours are ever touched.
function prune(dir, keep) {
  const all = list(dir);
  const old = all.slice(0, Math.max(0, all.length - keep));
  for (const f of old) { try { fs.rmSync(path.join(dir, f)); } catch (e) { console.warn('Could not remove old backup', f, e.message); } }
  return old;
}

function ownDir() {
  const { dir } = settings();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch (e) { /* not ours to change */ }
  return dir;
}

// An online copy under `name(stamp)`; a half-written backup never has a real name.
async function copyTo(name) {
  const dir = ownDir();
  let n = name(stamp());
  if (fs.existsSync(path.join(dir, n))) n = name(stamp(new Date(Date.now() + 1000)));
  const tmp = path.join(dir, `${n}.part`);
  await store.db.backup(tmp);
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, path.join(dir, n));
  return path.join(dir, n);
}

async function backupNow() {
  const f = await copyTo((t) => `failtech-${t}.db`);
  prune(path.dirname(f), settings().keep);
  return f;
}

// ---- snapshots and the rest (the admin panel) ------------------------------------------------------------------------
// A snapshot is a backup taken by hand, with a label, that is never pruned. A pre-restore copy is the database as it was
// just before a full restore replaced it (kept like a snapshot). Only files with these names are ever listed or touched.
const SNAPSHOT = /^snapshot-(\d{8})-(\d{6})(?:-([a-z0-9_-]{1,40}))?\.db$/;
const PRE = /^pre-restore-(\d{8})-(\d{6})\.db$/;
const kindOf = (f) => (NAME.test(f) ? 'auto' : SNAPSHOT.test(f) ? 'snapshot' : PRE.test(f) ? 'pre-restore' : null);
const slug = (label) => String(label || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function snapshot(label) {
  const l = slug(label);
  return copyTo((t) => `snapshot-${t}${l ? `-${l}` : ''}.db`);
}
const preRestoreName = () => path.join(ownDir(), `pre-restore-${stamp()}.db`);

function listAll() {
  const { dir } = settings();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(kindOf).map((name) => {
    const st = fs.statSync(path.join(dir, name));
    const m = SNAPSHOT.exec(name);
    return { name, kind: kindOf(name), size: st.size, at: st.mtimeMs, label: m && m[3] ? m[3] : null };
  }).sort((a, b) => b.at - a.at);
}
// The full path of one of ours, or null: a bare name (no folders), one of the three patterns, and present.
function resolve(name) {
  if (typeof name !== 'string' || name !== path.basename(name) || !kindOf(name)) return null;
  const f = path.join(settings().dir, name);
  return fs.existsSync(f) ? f : null;
}
function remove(name) {
  const f = resolve(name);
  if (!f) return false;
  fs.rmSync(f);
  return true;
}
// Keep an automatic backup for good: copied to a snapshot.
function keepAsSnapshot(name, label) {
  const f = resolve(name);
  if (!f) return null;
  const m = NAME.exec(name) || PRE.exec(name);
  const l = slug(label);
  const to = path.join(settings().dir, `snapshot-${m ? `${m[1]}-${m[2]}` : stamp()}${l ? `-${l}` : ''}.db`);
  if (fs.existsSync(to)) return null;
  fs.copyFileSync(f, to);
  fs.chmodSync(to, 0o600);
  return to;
}
// Ask for a full restore at the next start (see db.js applyPendingRestore); the caller restarts the server.
function requestRestore(name) {
  const f = resolve(name);
  if (!f) return null;
  const job = { from: f, keep: preRestoreName(), at: Date.now() };
  fs.writeFileSync(`${store.dbPath}.restore`, JSON.stringify(job), { mode: 0o600 });
  return job;
}
const pendingRestore = () => { try { return JSON.parse(fs.readFileSync(`${store.dbPath}.restore`, 'utf8')); } catch (e) { return null; } };
const cancelRestore = () => fs.rmSync(`${store.dbPath}.restore`, { force: true });

// Start the schedule. A backup is taken soon after start-up if the newest one is older than the interval.
function start(log = console) {
  const { hours, dir } = settings();
  if (!(hours > 0)) { log.log('Backups are off (BACKUP_INTERVAL_HOURS=0).'); return () => {}; }
  const everyMs = hours * 3600000;
  const run = () => backupNow().then((f) => { log.log(`Backup written: ${f}`); note('info', `Backup written: ${path.basename(f)}`); }).catch((e) => { log.error('Backup failed:', e.message); note('error', `Backup failed: ${e.message}`); });
  const newest = list(dir).pop();
  const age = newest ? Date.now() - fs.statSync(path.join(dir, newest)).mtimeMs : Infinity;
  const first = setTimeout(run, age >= everyMs ? 30000 : Math.max(30000, everyMs - age));
  const timer = setInterval(run, everyMs);
  first.unref(); timer.unref();
  log.log(`Backups every ${hours} h, keeping ${settings().keep}, in ${dir}`);
  return () => { clearTimeout(first); clearInterval(timer); };
}

module.exports = { backupNow, prune, list, start, settings, snapshot, listAll, resolve, remove, keepAsSnapshot, requestRestore, pendingRestore, cancelRestore, kindOf };
