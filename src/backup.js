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

async function backupNow() {
  const { dir, keep } = settings();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch (e) { /* not ours to change */ }
  let name = `failtech-${stamp()}.db`;
  if (fs.existsSync(path.join(dir, name))) name = `failtech-${stamp(new Date(Date.now() + 1000))}.db`;
  const tmp = path.join(dir, `${name}.part`);
  await store.db.backup(tmp);
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, path.join(dir, name)); // a half-written backup never has a real name
  prune(dir, keep);
  return path.join(dir, name);
}

// Start the schedule. A backup is taken soon after start-up if the newest one is older than the interval.
function start(log = console) {
  const { hours, dir } = settings();
  if (!(hours > 0)) { log.log('Backups are off (BACKUP_INTERVAL_HOURS=0).'); return () => {}; }
  const everyMs = hours * 3600000;
  const run = () => backupNow().then((f) => log.log(`Backup written: ${f}`)).catch((e) => log.error('Backup failed:', e.message));
  const newest = list(dir).pop();
  const age = newest ? Date.now() - fs.statSync(path.join(dir, newest)).mtimeMs : Infinity;
  const first = setTimeout(run, age >= everyMs ? 30000 : Math.max(30000, everyMs - age));
  const timer = setInterval(run, everyMs);
  first.unref(); timer.unref();
  log.log(`Backups every ${hours} h, keeping ${settings().keep}, in ${dir}`);
  return () => { clearTimeout(first); clearInterval(timer); };
}

module.exports = { backupNow, prune, list, start, settings };
