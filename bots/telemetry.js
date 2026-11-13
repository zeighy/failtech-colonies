'use strict';
// The bot runner's telemetry log: one JSON object per line, appended to a file that rotates by size, so how the bots
// played over weeks can be read back later (scripts/bots-report.js) and their logic adjusted.
//
// Every line has `at` (ISO time), `ev` (the kind of entry) and, for a bot, `bot`, `profile` and `colony`. Entries:
//   start        the runner started (its settings, without the key)
//   reject       a parked colony was looked at and left alone (the assessment: verdict, score, reasons)
//   claim        a colony was claimed (the assessment, and where the colony stood)
//   milestone    hub level, a new district or level, the Beacon, orbit, the station
//   snapshot     every BOT_TELEMETRY_SNAPSHOT_MINUTES per bot: where the colony stands, trade totals, open issues, plans
//   issue        a bot flagged something wrong (bots/brain/issues.js): code, since (tick), detail
//   issue_cleared  ...and when it stopped (with how many ticks it lasted)
//   give_up      the bot gave its colony up: reason, detail, the assessment run on the colony at that moment, open issues,
//                its plans, recent events and refusals, the last snapshot, and how long it played
//   release      a colony was given back for another reason (over the limit)
//   blacklist    a colony given up was looked at again after the wait and is still unfit
//   error        a turn or a poll failed (message, the first lines of the stack)
//   gone         the server no longer has a bot's colony
//   turn         (verbose level only) every turn: actions, events and refusals
//
// Settings: BOT_TELEMETRY (the file; 'off' to turn it off; default bots-telemetry.jsonl), BOT_TELEMETRY_LEVEL ('normal' or
// 'verbose'), BOT_TELEMETRY_MAX_MB (rotate past this size, default 20), BOT_TELEMETRY_KEEP (rotated files kept, default 10).
const fs = require('fs');
const path = require('path');

class Telemetry {
  constructor({ file, level = 'normal', maxBytes = 20 * 1048576, keep = 10, onError = () => {} } = {}) {
    this.file = file && file !== 'off' ? path.resolve(file) : null;
    this.level = level;
    this.maxBytes = maxBytes;
    this.keep = Math.max(1, keep);
    this.onError = onError;
    this.size = 0;
    this.failed = false;
    if (this.file) try { this.size = fs.statSync(this.file).size; } catch (e) { this.size = 0; }
  }

  get on() { return !!this.file; }
  get verbose() { return this.level === 'verbose'; }

  write(ev, data = {}) {
    if (!this.file) return;
    const line = `${JSON.stringify({ at: new Date().toISOString(), ev, ...data })}\n`;
    try {
      if (this.size + line.length > this.maxBytes && this.size > 0) this.rotate();
      fs.appendFileSync(this.file, line, { mode: 0o600 });
      this.size += Buffer.byteLength(line);
      this.failed = false;
    } catch (e) {
      if (!this.failed) this.onError(`telemetry: could not write ${this.file}: ${e.message}`); // said once until it works again
      this.failed = true;
    }
  }

  // bots-telemetry.jsonl -> .1 -> .2 ... the oldest past `keep` is deleted
  rotate() {
    for (let i = this.keep; i >= 1; i--) {
      const from = i === 1 ? this.file : `${this.file}.${i - 1}`;
      const to = `${this.file}.${i}`;
      try { if (i === this.keep) fs.rmSync(to, { force: true }); fs.renameSync(from, to); } catch (e) { /* not there yet */ }
    }
    this.size = 0;
  }

  // the log files, oldest first
  static files(file) {
    const f = path.resolve(file);
    const dir = path.dirname(f);
    const base = path.basename(f);
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n === base || (n.startsWith(`${base}.`) && /^\d+$/.test(n.slice(base.length + 1)))); } catch (e) { return []; }
    const n = (x) => (x === base ? 0 : Number(x.slice(base.length + 1)));
    return names.sort((a, b) => n(b) - n(a)).map((x) => path.join(dir, x));
  }
}

module.exports = { Telemetry };
