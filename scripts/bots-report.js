#!/usr/bin/env node
'use strict';
// Reads the bot runner's telemetry log (bots/telemetry.js) and sums it up: per bot, what it reached, the issues it flagged
// and for how long, why it gave up if it did; across all bots, which issues come up most, why colonies were turned down,
// and which refusals keep repeating. A starting point for adjusting the bots' logic.
//
//   npm run bots:report                            the default log (BOT_TELEMETRY, or ./bots-telemetry.jsonl) and its rotations
//   npm run bots:report -- --file path.jsonl       another log
//   npm run bots:report -- --days 7                only the last 7 days
//   npm run bots:report -- --bot Name              one bot (every entry for it, in order)
//   npm run bots:report -- --ev give_up            only entries of one kind, as JSON lines (pipe into jq)
const fs = require('fs');
const { Telemetry } = require('../bots/telemetry');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const file = opt('file', process.env.BOT_TELEMETRY || 'bots-telemetry.jsonl');
const days = Number(opt('days', 0));
const since = days > 0 ? Date.now() - days * 86400000 : 0;
const onlyBot = opt('bot', null);
const onlyEv = opt('ev', null);

const files = Telemetry.files(file);
if (!files.length) { console.error(`No telemetry at ${file}.`); process.exit(1); }
const rows = [];
let bad = 0;
for (const f of files) {
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch (e) { bad++; continue; }
    if (since && Date.parse(r.at) < since) continue;
    rows.push(r);
  }
}

if (onlyEv || onlyBot) {
  for (const r of rows) if ((!onlyEv || r.ev === onlyEv) && (!onlyBot || r.bot === onlyBot)) console.log(JSON.stringify(r));
  process.exit(0);
}

const hrs = (ticks) => (ticks === null || ticks === undefined ? '?' : `${Math.round(ticks / 24) / 10} h`); // 240 ticks = an hour
const count = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);
const top = (m, n = 10) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

const bots = new Map();
const issueTotals = new Map();
const issueTicks = new Map();
const rejectReasons = new Map();
const refusals = new Map();
let rejects = 0;
for (const r of rows) {
  if (r.ev === 'reject') { rejects++; count(rejectReasons, (r.reasons && r.reasons[0] ? r.reasons[0].replace(/\d+/g, '#') : r.verdict)); continue; }
  if (!r.bot) continue;
  const b = bots.get(r.bot) || { bot: r.bot, profile: r.profile, colony: r.colony, milestones: [], issues: new Map(), errors: 0, end: null, snap: null, claim: null };
  bots.set(r.bot, b);
  if (r.ev === 'claim') b.claim = r;
  else if (r.ev === 'milestone') b.milestones.push(`${r.at.slice(0, 16)} ${r.what}`);
  else if (r.ev === 'snapshot') b.snap = r;
  else if (r.ev === 'error') b.errors++;
  else if (r.ev === 'issue') {
    count(issueTotals, r.code);
    const x = b.issues.get(r.code) || { raised: 0, ticks: 0, open: false };
    x.raised++; x.open = true; b.issues.set(r.code, x);
    if (r.code === 'repeated_refusal') for (const f of r.detail.refusals || []) count(refusals, f.example.replace(/\d+(\.\d+)?/g, '#'));
  } else if (r.ev === 'issue_cleared') {
    const x = b.issues.get(r.code) || { raised: 0, ticks: 0, open: false };
    x.ticks += r.ticks || 0; x.open = false; b.issues.set(r.code, x);
    count(issueTicks, r.code, r.ticks || 0);
  } else if (['give_up', 'release', 'gone'].includes(r.ev)) b.end = r;
}

const first = rows[0]; const last = rows[rows.length - 1];
console.log(`Bot telemetry: ${rows.length} entries from ${files.length} file(s), ${first ? first.at : '-'} to ${last ? last.at : '-'}${bad ? ` (${bad} unreadable lines skipped)` : ''}`);
console.log(`Runner starts: ${rows.filter((r) => r.ev === 'start').length}, colonies turned down: ${rejects}, blacklisted: ${rows.filter((r) => r.ev === 'blacklist').length}, give-ups: ${rows.filter((r) => r.ev === 'give_up').length}\n`);

for (const b of bots.values()) {
  console.log(`== ${b.bot} (${b.profile}) on colony ${b.colony}`);
  if (b.claim) console.log(`   claimed ${b.claim.at.slice(0, 16)}: score ${b.claim.assessment.score}${b.claim.assessment.reasons.length ? ` (${b.claim.assessment.reasons.join('; ')})` : ''}, hub ${b.claim.colonyState ? b.claim.colonyState.hub : '?'}, ${b.claim.colonyState ? b.claim.colonyState.places : ''}`);
  if (b.snap) console.log(`   last seen ${b.snap.at.slice(0, 16)}: hub ${b.snap.hub}, pop ${b.snap.pop}, morale ${b.snap.morale}, credits ${Math.round(b.snap.credits)}, ${b.snap.places}${b.snap.station ? ', station' : ''}; put up ${(b.snap.plans && b.snap.plans.trade && b.snap.plans.trade.sold) || 0} for sale in orbit (${(b.snap.plans && b.snap.plans.trade && b.snap.plans.trade.soldFilled) || 0} sold), ${(b.snap.plans && b.snap.plans.trade && b.snap.plans.trade.surfaceSold) || 0} on the exchange; played ${b.snap.played.hours} h`);
  if (b.milestones.length) console.log(`   milestones: ${b.milestones.slice(-12).join(' | ')}`);
  if (b.issues.size) console.log(`   issues: ${[...b.issues.entries()].map(([c, x]) => `${c} x${x.raised} (${hrs(x.ticks)}${x.open ? ', open' : ''})`).join(', ')}`);
  if (b.errors) console.log(`   turn errors: ${b.errors}`);
  if (b.end) {
    if (b.end.ev === 'give_up') {
      console.log(`   GAVE UP ${b.end.at.slice(0, 16)} after ${b.end.played.hours} h: ${b.end.detail}`);
      if (b.end.assessment) console.log(`     check at give-up: ${b.end.assessment.verdict} (score ${b.end.assessment.score}): ${b.end.assessment.reasons.join('; ')}`);
      if (b.end.openIssues && b.end.openIssues.length) console.log(`     open issues: ${b.end.openIssues.map((x) => x.code).join(', ')}`);
      if (b.end.recentEvents && b.end.recentEvents.length) console.log(`     last events: ${b.end.recentEvents.slice(-6).map((x) => x.e).join('; ')}`);
    } else console.log(`   ${b.end.ev} ${b.end.at.slice(0, 16)}${b.end.why ? `: ${b.end.why}` : ''}`);
  }
  console.log('');
}

if (issueTotals.size) {
  console.log('Issues raised, all bots (times raised; hours open in total, cleared ones only):');
  for (const [c, n] of top(issueTotals, 20)) console.log(`   ${c.padEnd(20)} ${String(n).padStart(4)}   ${hrs(issueTicks.get(c) || 0)}`);
  console.log('');
}
if (refusals.size) {
  console.log('Refusals that kept repeating:');
  for (const [f, n] of top(refusals)) console.log(`   ${String(n).padStart(4)}  ${f}`);
  console.log('');
}
if (rejectReasons.size) {
  console.log('Why parked colonies were turned down (first reason):');
  for (const [f, n] of top(rejectReasons)) console.log(`   ${String(n).padStart(4)}  ${f}`);
}
