# Security notes

What the server defends against, where, and what is deliberately left alone. Tests: `test/security.test.js`.

## Trust model
The client is untrusted and purely presentational. Every rule (costs, slots, plots, limits, prices, who owns what) is enforced on the server inside a
transaction. The simulation is server-authoritative, so there is nothing for a modified client to "cheat" except by sending bad input.

## Input
- `src/validate.js`: numbers are strict (a string, array, `NaN`, `Infinity`, `-0`, hex or exponent form is not a number); integers must be safe integers; names looked up
  in config tables (`building`, `resource`, `recipe`, `district type`) are own-property lookups, so `constructor`, `__proto__` and friends never match.
- Slots and rings must be integers inside the unlocked rings (a negative or fractional slot would otherwise be a free extra slot).
- Request bodies must be plain JSON objects, at most 10 kB, strict JSON. Malformed or oversized bodies are 400/413, never 500.
- All SQL is parameterised; the only interpolated SQL is built from constants.
- The only player-chosen text anywhere is the callsign (`[A-Za-z0-9_]{3,20}`), rendered with `textContent`; all other text comes from config. CSP forbids inline script.

## HTTP
- Headers: CSP (`script-src 'self'`, no `unsafe-eval`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`), `X-Content-Type-Options`, `X-Frame-Options`,
  COOP/CORP, Referrer and Permissions policies, HSTS over HTTPS, `Cache-Control: no-store` on the API.
- CSRF: cookies are `HttpOnly; SameSite=Lax`; writes must be `application/json`; a write with a cross-site `Origin` or `Sec-Fetch-Site` is refused (403).
- Static files: only `public/` is served, dotfiles are denied, no directory listings, traversal is refused. The database, config and source are outside it.
- Errors: a generic message to the client, details only in the server log.
- Timeouts: header 15 s, request 30 s, keep-alive 15 s.

## Accounts and sessions
- bcrypt (12 rounds by default, `BCRYPT_ROUNDS`), passcodes 8-72 bytes (bcrypt ignores anything past 72, so longer is refused, not truncated). Existing shorter passcodes still sign in.
- A new session id on every sign-in; logout destroys it server-side; expired sessions are purged hourly.
- Login always runs a bcrypt compare at full cost, so timing does not reveal which callsigns exist. Failed logins are throttled per callsign (8 per 15 minutes) as well as per IP.
- Callsigns are unique case-insensitively, enforced by a database index; sign-up checks and inserts without yielding, so simultaneous sign-ups cannot take one name.

## Abuse and load
- Rate limits: auth per IP, the whole API per player (120 per 10 s, `API_RATE_LIMIT`) and per IP (600 per 10 s). `429` with `Retry-After`.
- Live streams: 4 per player, 1000 in total (`MAX_STREAMS`).
- Exchange: orders are bounded (price band around the market, quantity, count, lifetime); escrow means a player cannot spend what they do not have.
- NPC market books are lazy: no per-tick cost unless somebody has an open order.

## Races and consistency
- better-sqlite3 is synchronous, so inside the process each action and each tick runs to completion. Beyond that, every action and the tick use `BEGIN IMMEDIATE`, read the
  colony inside the transaction, and the database waits (`busy_timeout`) for a competing writer, so two requests, or two processes, cannot act on a stale balance.
- A lock file beside the database (`<db>.lock`) refuses a second server on the same database (two clocks would double every tick). A stale lock from a crash is taken over.
- Anything that spends (building, shipments, routes, orders, express trips) checks and pays in one transaction; tests fire dozens of simultaneous requests at one stock.

## Game-rule exploits closed
- Scrapping a configured recipe building (Trade Workshop, Orbital Foundry, Anomaly Tap) costs its recipe-reset fee and locks the slot for `tradeWorks.reset.delayTicks` (table `slot_locks`), so demolish-and-rebuild is never a faster or cheaper reset than changing the recipe.
- Trade goods cannot go through the convoy; the exchange has an escrow, a fee and a price band; crafting from exchange-bought goods never makes money (tested).
- No player-to-player self-trading; one express trip at a time; per-resource limits scale with hub level.

## Deployment
- Put it behind HTTPS. Set `TRUST_PROXY` to the number of proxies in front (e.g. `1`), or an address range; the default `loopback` only believes `X-Forwarded-For` from the same machine.
  Exposed directly, set `TRUST_PROXY=false`.
- If the site is served from a different origin than the API host header, list it in `ALLOWED_ORIGINS` (comma separated).
- Keep `SESSION_SECRET` out of the repository (or let the server generate one in the database). Back up the database file, which is created owner-only (0600).
- Run `npm audit` now and then (currently clean).

## Not done (on purpose)
- No account recovery, email or CAPTCHA, and no per-account registration cap beyond the IP limit.
- Rate limits are in memory, per process (the server is single-instance by design).
- Seeded randomness (hazards, missions, prices) is deterministic per colony and therefore predictable by a determined player; it is game design, not a secret.

## Backups

`src/backup.js` takes SQLite online backups on a schedule (see the README for the variables). The backup folder is created
owner-only (0700) and each file is 0600, because a backup holds password hashes. A backup is written under a temporary
name and renamed when complete, so a half-written file never looks like a backup, and only files named `failtech-<date>-<time>.db`
are ever deleted when old backups are pruned. Copy backups off the machine if you need protection against losing the disk.
