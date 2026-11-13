# Deploying FAILTECH

Running a server: settings, backups, upgrades, bots for small worlds and security. For working on the code, see [`development.md`](development.md).

## Running it

```bash
npm install
npm start                 # http://localhost:3000
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `TICK_MS` | `15000` (from config) | Milliseconds per game tick. `npm run dev` uses 1000 for fast testing. |
| `HAZARDS` | on | Set `off` to disable hazards (used by most tests). |
| `SESSION_SECRET` | generated, stored in the DB | Session signing key |
| `DB_PATH` | `./failtech.db` | SQLite file |
| `AUTH_RATE_LIMIT` | `20` | Login/register attempts per IP per minute |
| `TRUST_PROXY` | `loopback` | Reverse proxies in front: a count (`1`), an address/range, or `false` when exposed directly |
| `ALLOWED_ORIGINS` | none | Extra origins allowed to make writes (comma separated) |
| `BCRYPT_ROUNDS` | `12` | Password hashing cost |
| `API_RATE_LIMIT` | `120` | API requests per player per 10 seconds |
| `MAX_STREAMS` | `1000` | Open live connections in total (4 per player) |
| `THEME` | `recontinuation` | Which `content/<folder>` supplies names and story (`basic` is the neutral original wording) |
| `BACKUP_INTERVAL_HOURS` | `6` | Automatic database backups; `0` turns them off |
| `BACKUP_KEEP` | `28` | How many backups to keep |
| `BACKUP_DIR` | `backups/` beside the database | Where backups go (owner-only) |
| `BOT_API_KEY` | none (bot API off) | Shared key for the bot runner (at least 16 characters). Unset, `/api/bot` answers 404. |
| `BOT_API_RATE_LIMIT` | `1500` | Bot API requests per 10 seconds, all bots together |

**Backups.** The server copies the database every few hours (a consistent snapshot taken while the game runs) into `backups/`, keeping the newest 28. To restore: stop the server, copy a backup over the database file, delete its `-wal` and `-shm` files, start the server. Backups contain password hashes, so the folder is owner-only like the database.

**Upgrading:** schema v4 changed ring sizes and the economy, so existing colonies are dropped on first start (accounts are kept and colonies are re-founded at next login).

## Bots for small worlds

A world with few players can run **bots** on parked colonies, so there are still neighbours trading on the exchange and the orbital market. The bot runner is a separate process that talks to the game server only through a key-protected bot API, so it can run on the same machine or another.

```bash
BOT_API_KEY=some-long-random-key npm start                                 # the game server, with the bot API on
BOT_API_KEY=some-long-random-key BOT_SERVER=http://127.0.0.1:3000 npm run bots   # the runner
```

Every hour the runner asks for colonies parked in the last 7 days (`BOT_POLL_SECONDS`, `BOT_PARKED_DAYS`); older ones are not considered, so a long list of long-abandoned colonies costs nothing. While it runs fewer than `BOT_LIMIT` (default 5) it looks at each candidate and **leaves alone any colony already on its way to collapse** (shut down, starving, a collapse clock it has neither the stock, the plots nor the time to stop, power or crews far short). It claims the stable ones, colonies whose commander chose to start over first (that includes healthy colonies abandoned from the menu, so new players restarting early leave colonies behind for bots). Each claim makes a bot account with a random callsign nobody can sign in to. If the colony belonged to a real player who simply went away, they are told it was claimed, as for any claim. Each bot takes a turn every few ticks through the same actions a player has. It keeps the colony fed, watered, powered and housed before anything else, grows it from whatever stage it was left at (the plans count what is already standing), wires the districts together, builds the Beacon, then the Free Port, earns standing with missions, builds the launch chain and goes to orbit. It **reorganises** a colony someone else laid out, replacing surplus or idle buildings in place when something it needs has no plot (two side-by-side Colossal plots for the launch pads included). In orbit it runs the station's reactor and foundry, sends dropships to the anomalous territories for rare resources, and **jettisons** orbital storage slots holding what it no longer needs. A colony that fails or stays shut down for long is given back: it parks again for someone else. After `BOT_RECHECK_HOURS` the runner looks at it once more; if it still isn't fit to take over, it goes on a **pickup blacklist** and is never looked at again (the game server leaves it out of the runner's listing). The exception is a colony someone else takes up and that parks again later: it counts as a new candidate. The blacklist is kept in the state file (`blocked`); delete an entry to undo it.

Bots let go of any settlements they inherit (those are for players) and never sponsor new ones. Some profiles give to the **global projects** (see [gameplay.md](gameplay.md#orbit)); stations run by bots are not counted when a project's size is set, so projects stay sized for the people playing and anything bots deliver is help on top. Bots also prepare for forecast hazards: they bring in the stock the Brief asks for and raise the Free Port's shield when they hold its goods.

Every profile's main objective is to **sell on the orbital market**. They differ in temper:

| Profile | Plays |
| --- | --- |
| `broker` (Foundry Broker) | Pushes for orbit and the foundry, and sells orbital goods (lattice cores, null alloy...) in small lots at a price drawn fresh for each order between **20% under and 20% over** the market maker's reference. Buys small lots of foundry inputs. |
| `porter` (Port Trader) | A busy Free Port; keeps the **ground exchange** moving with sells and small buys of trade goods and surplus. In orbit, sells trade goods just under the best ask, and sends some to the global project. |
| `steward` (Steward) | Deep food and water reserves, slow and safe growth; gives everything its foundry makes to the global project, and sells spare trade goods at the reference price. |
| `industrialist` (Industrialist) | Builds big, takes every alternative recipe, fills requisitions; gives half its orbital goods to the global project and sells whatever it makes most of. |
| `scavenger` (Scavenger) | Lean; picks up cheap asks in small lots and sells orbital and trade goods near the reference. |

| Runner variable | Default | Purpose |
| --- | --- | --- |
| `BOT_SERVER` | `http://127.0.0.1:3000` | The game server |
| `BOT_API_KEY` | required | The same key the server was started with |
| `BOT_LIMIT` | `5` | Most colonies run by bots at once (lowering it gives the newest back) |
| `BOT_PROFILES` | all five | Which profiles to hand out (the least used goes to each new claim) |
| `BOT_CLAIM` | `all` | `given_up` claims only colonies whose commander chose to start over |
| `BOT_TURN_TICKS` | `4` | Ticks between a bot's turns |
| `BOT_POLL_SECONDS` | `3600` | How often it looks for parked colonies (bots take their turns in between regardless) |
| `BOT_PARKED_DAYS` | `7` | Only colonies parked within this many days are candidates (`0`: any; a colony a bot gives back parks afresh) |
| `BOT_RECHECK_HOURS` | `24` | How long a colony judged unsafe (or given back) is left alone; a given-back colony still unfit after that is blacklisted |
| `BOT_STATE_FILE` | `./bots-state.json` | The bots' memory across restarts (they play on without it) |
| `BOT_STATUS_PORT` | off | `GET /status` on 127.0.0.1 shows every bot's colony, last turn and trading |
| `BOT_LOG` | normal | `quiet` or `verbose` |
| `BOT_TELEMETRY` | `./bots-telemetry.jsonl` | The telemetry log (`off` for none) |
| `BOT_TELEMETRY_LEVEL` | `normal` | `verbose` also writes every turn's actions and refusals |
| `BOT_TELEMETRY_SNAPSHOT_MINUTES` | `60` | How often each bot's colony is written down |
| `BOT_TELEMETRY_MAX_MB` / `BOT_TELEMETRY_KEEP` | `20` / `10` | Rotate the log past this size, keeping this many old files |

**Telemetry.** The runner keeps a log, one JSON object per line, so how the bots played over weeks can be read back and their logic adjusted. It records:
- colonies claimed and turned down, with the assessment;
- milestones (hub levels, districts, the Beacon, orbit, the station);
- an hourly snapshot of each colony (where it stands, trade totals, what the bot is saving for);
- turn errors;
- the **issues bots flag** about their own play. An issue is written when it starts, once it has lasted its grace period, and again when it clears, with how long it lasted. The codes: `at_risk` (the takeover check run on its own colony no longer says stable), `shutdown`, `collapse_clock`, `starving`, `power_short`, `morale_low`, `people_leaving`, `credits_low`, `stalled` (a day without growth or a sale), `no_orbital_sales` (a station and nothing sold for a day), `launch_short` (saving for a launch for a day), `repeated_refusal` (the same action refused turn after turn, with the server's reason), `cannot_afford`, `wanted_no_room` and `capped_paused`;
- every **give-up**: the reason (`status_failed`, `shutdown_too_long`...), the takeover check run on the colony at that moment, the issues still open, what it was saving for and selling, its last 40 events and refusals, its last snapshot, and how long it played.

`npm run bots:report` sums the log up per bot and across bots: most frequent issues, refusals that kept repeating, why colonies were turned down. Add `-- --days 7` for the last week, `-- --bot <name>` for one bot's entries, or `-- --ev give_up` for one kind of entry as JSON lines.

A bot's colony is only tended while the runner runs. If the game server keeps going while the runner is down, bot colonies play on unattended, so keep the runner up alongside the server.

`npm run botplay -- --profiles broker,porter --ticks 6000` plays the same bot brain in-process on a throwaway world, several bots sharing it, and prints their milestones and trading.

## Security

The server is the only authority: the client sends intents and every rule is enforced server-side in a transaction. Input is validated strictly, writes must be same-origin JSON, sessions are regenerated on sign-in, logins and the API are rate limited, the database is owner-only, and a lock file stops two servers sharing one database. Details, deployment notes and what is deliberately not done are in [[`security.md`](security.md)](security.md). Run it behind HTTPS and set `TRUST_PROXY`.
