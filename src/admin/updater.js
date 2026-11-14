'use strict';
// Updating the game from its Git repository, from the admin panel. The repository and branch are settings (meta
// `update_repo`, `update_branch`), so a fork can follow its own code: by default the checkout's `origin` and `main`.
//
//   check   git fetch <repo> <branch>, then how far ahead the remote is, its commits, and whether it fast-forwards
//   apply   refuses if tracked files were changed by hand; takes a snapshot of the database; fast-forwards to the fetched
//           commit (or, with `force`, resets to it: switching to a fork whose history differs); runs `npm ci --omit=dev`
//           when package.json or package-lock.json changed; then restarts the server, which a supervisor (systemd, pm2)
//           brings back up on the new code. Without a supervisor the restart only stops the server.
// Every git and npm call is an argument list (no shell), with GIT_TERMINAL_PROMPT=0 so a private repository fails instead
// of waiting for a password. Jobs run one at a time; their output is kept for the panel to show.
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const store = require('../db');

const ROOT = path.join(__dirname, '..', '..');
// https://host/path, ssh://user@host/path, git@host:path, or file:///path (a local mirror)
const REPO = /^(?:https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[\w.~%+/-]+|ssh:\/\/[\w.@-]+(?::\d+)?\/[\w.~%+/-]+|git@[A-Za-z0-9.-]+:[\w.~%+/-]+|file:\/\/\/[\w.~%+/-]+)$/;
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,100}(?<![./])$/;

function run(cmd, args, { timeout = 120000, cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 8 * 1048576, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' } }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || '').trim(), err: String(stderr || (err && !stderr ? err.message : '')).trim() });
    });
  });
}
const git = (...args) => run('git', args);
const npmBin = () => process.env.NPM_PATH || (fs.existsSync(path.join(path.dirname(process.execPath), 'npm')) ? path.join(path.dirname(process.execPath), 'npm') : 'npm');

async function defaults() {
  const o = await git('remote', 'get-url', 'origin');
  let repo = o.ok ? o.out : '';
  if (!repo) { try { repo = String((require('../../package.json').repository || {}).url || '').replace(/^git\+/, ''); } catch (e) { repo = ''; } }
  return { repo, branch: 'main' };
}
async function settings() {
  const d = await defaults();
  return { repo: store.getMeta('update_repo') || d.repo, branch: store.getMeta('update_branch') || d.branch, defaults: d };
}
function setSettings({ repo, branch }) {
  if (repo !== undefined) {
    if (repo && (!REPO.test(repo) || repo.startsWith('-'))) return { ok: false, error: 'Repository: an https://, ssh://, git@ or file:/// address.' };
    store.setMeta('update_repo', repo || '');
  }
  if (branch !== undefined) {
    if (branch && !BRANCH.test(branch)) return { ok: false, error: 'Bad branch name.' };
    store.setMeta('update_branch', branch || '');
  }
  return { ok: true };
}

// The running code: commit, branch, local changes.
async function info() {
  const inside = await git('rev-parse', '--is-inside-work-tree');
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); } catch (e) { pkg = {}; }
  if (!inside.ok || inside.out !== 'true') return { git: false, version: pkg.version || null, gitError: inside.err || 'Not a git checkout.' };
  const [head, branch, log, dirty] = await Promise.all([git('rev-parse', 'HEAD'), git('rev-parse', '--abbrev-ref', 'HEAD'), git('log', '-1', '--format=%h%x09%ad%x09%s', '--date=iso-strict'), git('status', '--porcelain', '--untracked-files=no')]);
  const [short, date, subject] = log.out.split('\t');
  return { git: true, version: pkg.version || null, commit: head.out, short, date, subject, branch: branch.out, dirty: dirty.out ? dirty.out.split('\n').slice(0, 30) : [] };
}

// ---- jobs ----------------------------------------------------------------------------------------------------------------
const jobs = new Map();
let seq = 0;
let busy = null;
function startJob(kind, fn) {
  if (busy) return { ok: false, error: `A ${busy.kind} is already running.`, job: busy.id };
  const job = { id: ++seq, kind, status: 'running', lines: [], startedAt: Date.now(), endedAt: null, result: null };
  const say = (line) => { job.lines.push(`${new Date().toISOString().slice(11, 19)} ${line}`); if (job.lines.length > 400) job.lines.shift(); };
  jobs.set(job.id, job);
  busy = job;
  (async () => {
    try { job.result = await fn(say); job.status = job.result && job.result.ok === false ? 'failed' : 'done'; } catch (e) { say(`error: ${e.message}`); job.status = 'failed'; }
    job.endedAt = Date.now();
    busy = null;
    for (const k of jobs.keys()) if (jobs.size > 20 && k !== job.id) jobs.delete(k);
  })();
  return { ok: true, job: job.id };
}
const job = (id) => jobs.get(id) || null;

async function fetchRemote(say) {
  const s = await settings();
  if (!s.repo) return { ok: false, error: 'No repository set.' };
  say(`fetching ${s.branch} from ${s.repo}`);
  const f = await git('fetch', '--no-tags', '--quiet', '--', s.repo, `refs/heads/${s.branch}`);
  if (!f.ok) { say(f.err || 'fetch failed'); return { ok: false, error: `Fetch failed: ${(f.err || '').split('\n').pop()}` }; }
  const remote = (await git('rev-parse', 'FETCH_HEAD')).out;
  return { ok: true, remote, repo: s.repo, branch: s.branch };
}

function check() {
  return startJob('check', async (say) => {
    const i = await info();
    if (!i.git) { say(i.gitError); return { ok: false, error: 'The server is not running from a git checkout.' }; }
    const f = await fetchRemote(say);
    if (!f.ok) return f;
    const [ahead, behind, ff, log, files] = await Promise.all([
      git('rev-list', '--count', 'HEAD..FETCH_HEAD'), git('rev-list', '--count', 'FETCH_HEAD..HEAD'), git('merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD'),
      git('log', '--format=%h%x09%an%x09%ad%x09%s', '--date=short', '-n', '60', 'HEAD..FETCH_HEAD'), git('diff', '--name-only', 'HEAD', 'FETCH_HEAD'),
    ]);
    const changed = files.out ? files.out.split('\n') : [];
    const out = {
      ok: true, current: i.commit, remote: f.remote, ahead: Number(ahead.out) || 0, behind: Number(behind.out) || 0, fastForward: ff.ok, dirty: i.dirty,
      commits: log.out ? log.out.split('\n').map((l) => { const [hash, author, date, subject] = l.split('\t'); return { hash, author, date, subject }; }) : [],
      files: changed.length, depsChanged: changed.some((x) => x === 'package.json' || x === 'package-lock.json'),
    };
    say(out.ahead ? `${out.ahead} new commit(s)${out.fastForward ? '' : ' (histories differ: a forced update resets to the remote)'}` : 'up to date');
    return out;
  });
}

function apply({ force = false, restart = true, snapshot }) {
  return startJob('update', async (say) => {
    const i = await info();
    if (!i.git) return { ok: false, error: 'The server is not running from a git checkout.' };
    if (i.dirty.length) { say(`local changes: ${i.dirty.join(', ')}`); return { ok: false, error: 'Tracked files have local changes; commit or discard them first.' }; }
    const f = await fetchRemote(say);
    if (!f.ok) return f;
    if (f.remote === i.commit) { say('already up to date'); return { ok: true, upToDate: true }; }
    const ff = await git('merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD');
    if (!ff.ok && !force) return { ok: false, error: 'The remote does not fast-forward from here. Use a forced update to reset to it.' };
    const files = (await git('diff', '--name-only', 'HEAD', 'FETCH_HEAD')).out.split('\n');
    say('taking a database snapshot first');
    const snap = await snapshot(`pre-update-${f.remote.slice(0, 8)}`);
    say(`snapshot: ${path.basename(snap)}`);
    const from = i.commit;
    const step = ff.ok ? await git('merge', '--ff-only', 'FETCH_HEAD') : await git('reset', '--hard', 'FETCH_HEAD');
    say(step.out || step.err || (ff.ok ? 'fast-forwarded' : 'reset'));
    if (!step.ok) return { ok: false, error: `Update failed: ${step.err.split('\n').pop()}` };
    if (files.includes('package.json') || files.includes('package-lock.json')) {
      say('dependencies changed: npm ci --omit=dev');
      const n = await run(npmBin(), ['ci', '--omit=dev', '--no-audit', '--no-fund'], { timeout: 600000 });
      for (const l of (n.out + '\n' + n.err).split('\n').filter(Boolean).slice(-15)) say(l);
      if (!n.ok) {
        say('npm ci failed: going back to the previous commit');
        await git('reset', '--hard', from);
        await run(npmBin(), ['ci', '--omit=dev', '--no-audit', '--no-fund'], { timeout: 600000 });
        return { ok: false, error: 'Installing dependencies failed; the previous version was put back.' };
      }
    }
    const now = (await git('rev-parse', 'HEAD')).out;
    say(`now at ${now.slice(0, 8)}`);
    const out = { ok: true, from, to: now, snapshot: path.basename(snap), restarting: false };
    if (restart) {
      const lifecycle = require('../lifecycle');
      out.restarting = lifecycle.restart('updated');
      say(out.restarting ? 'restarting' : 'restart not available: restart the server by hand');
    }
    return out;
  });
}

module.exports = { info, settings, setSettings, check, apply, job, run, REPO, BRANCH };
