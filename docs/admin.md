# The admin panel

A web panel for running a public server: players and their colonies, the world and its markets, the bots, backups, logs and
updates. It runs inside the game server's process (same database, same clock) but listens on **its own port, bound to an
internal address**, so nothing of it is reachable through the game's port.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_HOST` | `127.0.0.1` | Address the panel binds to. Keep it internal (loopback, a VPN or LAN address). |
| `ADMIN_PORT` | `3001` | Its port; `off` for no panel. |
| `ADMIN_ALLOW` | none | Comma-separated addresses or IPv4 ranges (`10.0.0.0/8`) allowed in, on top of the bind address. |
| `ADMIN_RATE_LIMIT` | `10` | Sign-in attempts per address per minute. |
| `RESTART_EXIT_CODE` | `75` | Exit code of a restart the panel asks for (see [Restarts](#restarts-and-updates)). |

From another machine, reach a loopback-bound panel with an SSH tunnel: `ssh -L 3001:127.0.0.1:3001 your-server`, then open
`http://127.0.0.1:3001`.

## Admin accounts

Admins are separate from players. Make the first one on the server:

```bash
npm run admin -- create root          # asks for a passcode (10+ characters); ADMIN_PASSWORD=... skips the prompt
npm run admin -- list
npm run admin -- passwd root          # a new passcode (signs that admin out)
npm run admin -- totp-off root        # lost the authenticator: turn the code off, then set it up again
npm run admin -- disable bob | enable bob
```

The CLI works on `DB_PATH` whether or not the server runs. After that, admins are managed under **Admins**. Each admin should
set up a **two-factor code** under **Account** (any authenticator app; the key is shown to type or paste). Once on, sign-in
asks for it, and a code is never accepted twice. Role **viewer** can see everything but change nothing (and cannot download
backups, which hold password hashes). At least one active admin always remains.

Every change made in the panel goes to the **audit log** (who, what, on what, from where), readable under **Logs**.

## What it does

**Overview.** Tick and clock, connected players, sign-ups, active players, colonies by phase, bots, trades, the last backup,
database size, recent server errors.

**Users.** Search by callsign, email, address or `#id`, filter by suspended, unverified or new. For one account:
- edit the callsign, the email (taken as verified unless unticked) and a private admin note;
- mark the email verified;
- suspend, with a reason the player sees, for some hours or until lifted (sessions end and live connections close at once), or lift it;
- set a passcode, or email a reset link (verified addresses only); sign out everywhere; turn off a player's authenticator code (lost device);
- delete the account, with its colony **parked** for someone else (bots may take it up) or **wiped**;
- give or take credits (a line goes into the colony log), set a stock in any district;
- **roll the colony back** to any backup that holds it (below);
- the colony's recent events, the account's server log, and other accounts seen at the same address.

**Colonies.** Every colony by phase (parked, stewarded, live). Park or unpark one, hand a player's parked colony to a
generated account (where bots can claim it), keep a colony away from the bots (the bot API stops listing it), assign a
generated or bot colony to a player account without one, wipe one.

**Market.** Per good: the reference price, the market makers' best bid and ask on the ground exchange and in orbit, open
player orders and the last 24 hours' volume. **Freeze** either market (no new orders and no matching; open orders stay open
and still expire), **adjust** a good's price (a multiplier on its reference, so the market makers and the posting band follow;
goods made from it follow too), cancel any player orders (goods and held credits go back, and the owner is told), recent trades,
the top traders, and **trades worth a look**: player pairs sharing an address, the same pair trading again and again, and
prices far from the reference.

**Bots.** What the runner last reported (it reports every loop): when, from where, its settings, bots running against its
limit and how many slots wait for a colony, parked candidates, colonies it turned down or blacklisted. Controls:
- **pause** the bots (the runner takes no turns and claims nothing; the server also refuses bot claims and actions). They are
  also paused whenever the simulation is paused or idle; the page says which;
- switch the **bot API** off or on;
- **override** the runner's limit, profiles and claim rule (blank: the runner's own environment);
- issue a **new key** (shown once). With `BOT_API_KEY_FILE` set on both the server and the runner (same machine), the key is
  written to that file and the runner picks it up on its next refused request. Otherwise put it in the runner's `BOT_API_KEY`
  and restart the runner;
- change one bot's **profile**; make one **release** its colony (it parks under a generated account), optionally kept away from the bots;
- **telemetry**: the runner sends its telemetry with each report, so it is kept here as well as in its own file (pruned after
  `BOT_TELEMETRY_DAYS`, default 90). Summaries of issues, give-ups and repeated refusals, per-bot entries, and an **export** as
  JSON lines in the runner's own format (`npm run bots:report -- --file <export>` reads it).

**Backups.** Every automatic backup, snapshot and pre-restore copy, with size and age.
- **Back up now**, or take a **snapshot** with a label: snapshots are never pruned. **Keep** turns an automatic backup into one.
- **Inside** lists a backup's colonies; **Restore this colony** rolls just that colony back.
- **Download**, **Delete** (type the file name).
- **Restore all**: the whole game back to that backup. The server restarts, swaps the database at start-up, and keeps the
  database it replaced as a `pre-restore-*.db` copy (so a restore can be undone the same way). The admin accounts, the audit
  and server logs, the bot telemetry, the bot key and the panel's update settings are carried over, not rolled back.

**Logs.** The server log (sign-ups, sign-ins, failed sign-ins, verification and reset emails, suspensions, admin changes that
touch players, backups, market interventions, bot control, server errors), filtered by level, category, account and text,
paged, exported as CSV or JSON lines. Kept `SERVER_LOG_DAYS` (default 90). The **admin audit** is the second tab.

**Maintenance.**
- **Maintenance mode**: players cannot sign in or act; the sign-in page shows the message. Optionally signs everyone out.
- **Banner**: a line every player sees in the game, for some hours or until cleared.
- **Support link** on the sign-in page (Maintenance → Sign-up and email): any http(s) address; blank uses the code repository being followed.
- **Simulation**: pause the game. No ticks run, and nothing is caught up when it resumes. Players see "Simulation paused",
  their countdowns stop, and their actions are refused (apart from marking a call or a notice as seen) so nothing can be
  queued or traded against a world that is not moving. The bots pause too.
- **Idle hold** (automatic): when no player's colony is being simulated (every commander has been away longer than
  `absence.simulateHours`, 96 hours, or there are no players yet), the server stops ticking by itself and the bots pause,
  because there is nobody for them to play alongside. Colonies run by bots do not count. The first player to sign in or act
  wakes it at once; the idle time is skipped, nothing is caught up. The Overview and Maintenance pages show when the world is
  idle. `IDLE_PAUSE=off` turns this off.
- Sign every player out; restart the server; database integrity check and compaction; a test email; the sign-up settings,
  table sizes and the environment (secrets shown only as "set").
- **Updates** (below).

## Rolling a colony back

A colony restore replaces every row the colony owns with the backup's: the colony, its districts, buildings, stock, orders,
routes, missions, settlements, story, station, dropships and Headquarters. The shared world stays as it is now: market books
and history, territories, global projects. At the edges:
- its open market orders today are dropped; the orders it had open in the backup are not restored but **refunded** into the
  restored colony (goods back where they came from, held credits back);
- a dropship that was down on a territory that has since closed, or that someone else now holds, comes back **docked**;
- a station name taken since by someone else gets a number after it;
- the colony is live again under the account it was restored to. If that account runs a different colony now (it started
  over), the panel asks whether to **park** or **wipe** that one first.

## Restarts and updates

A restart from the panel (after an update, a full restore, or the restart button) stops the server cleanly with exit code
`RESTART_EXIT_CODE` (75). Run the server under a supervisor that starts it again: systemd with `Restart=always` (or
`on-failure`), pm2, supervisord. Without one, a restart only stops the server; the panel says so when it cannot see a supervisor
(set `RESTART_SUPERVISED=1` if it misses yours).

**Updates.** Under **Maintenance → Code**: set the repository and branch to follow (default: the checkout's `origin` and `main`;
point it at your fork to run your own version: `https://`, `ssh://`, `git@host:path` or `file:///path`).
- **Check for updates** fetches the branch and lists the new commits, whether they fast-forward and whether dependencies changed.
- **Update and restart** refuses if tracked files were edited by hand, takes a database snapshot (`pre-update-<commit>`),
  fast-forwards, runs `npm ci --omit=dev` when `package.json` or `package-lock.json` changed (putting the old version back if
  that fails), and restarts.
- **Force** resets to the remote branch instead, for a fork whose history differs from yours.

Git runs without a terminal, so a private repository needs credentials the server's user already has (a deploy key, a
credential helper). `NPM_PATH` points at npm if it is not next to node.

## A systemd unit

```ini
[Unit]
Description=FAILTECH game server
After=network.target

[Service]
User=failtech
WorkingDirectory=/srv/failtech
EnvironmentFile=/etc/failtech.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

`/etc/failtech.env` holds the settings (`PORT`, `PUBLIC_URL`, `SMTP_*`, `TURNSTILE_*`, `ADMIN_HOST`...), readable only by root
and the service user. A second unit like it runs the bot runner (`ExecStart=/usr/bin/node bots/runner.js`).
