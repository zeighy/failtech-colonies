# FAILTECH - Radial Command

A browser-based colony management game with a server-authoritative simulation. You command a central **Core** in a broken world. Build outward through five rings, keep a power grid alive, turn scrap and bad water into food and parts, and grow a colony that can reach what is left of the world with a **Beacon**. After that the game opens up: a harbour and its factions, then **orbit**, where every player's station shares the same territories, market and projects.

The game ships with a story and a full theme, **Recontinuation** (Earth after the Lapse, run by the surviving Continuity Office). Rules and wording are separate, so the same game can be re-themed by adding a content folder. The Recontinuation story belongs to the FAILTECH story universe by Ivan Lapis and is licensed separately (see [Story attribution and license](#story-attribution-and-license)).

## Features

- **A radial build map.** Five rings of slots, with plots that grow larger outward. Adjacency matters: neighbours that pair well make each other better.
- **A real production chain.** Raw scrap, water and synthetics become rations, parts, building materials, alloys, circuits and power cells. Power is a grid, not a stockpile, and shortages throttle everything.
- **People, not just numbers.** Housing, crews and morale. When food or water runs short, people leave. When hope runs out, the colony shuts down instead of dying outright.
- **Districts.** Satellite bases (mines, refineries, farmland), each with its own rings, stockpile and power grid, joined to the Core by shipments and standing routes over links you widen.
- **Hazards.** Dust storms, faults, blight, raids, spills, cold snaps and signal storms, forecast ahead and fixed once announced. Being ready is never free.
- **Trade.** A scheduled convoy with drifting prices, express trips, and an order-book exchange with NPC traders and other players.
- **The work queue.** Each place builds one thing at a time, strictly in order, and is paid for when an order starts. More build slots come with hub levels.
- **Alternative recipes and expansions.** Better ways of making things as the colony grows, and buildings that build upward to level 10.
- **The Beacon and the Free Port.** Transmit, and a harbour opens: trade goods, hazard shields, missions for three factions, standing and rank. Settlements answer the Beacon and take the colony's surplus in exchange for lasting help.
- **Orbit (multiplayer).** Launch a station, run its reactor and foundry, send dropships to shared anomalous territories for rare resources, trade on the orbital market and pitch in on server-wide projects.
- **Data and lore.** Data sites and a daily puzzle recover fragments that open lore packets.
- **Headquarters.** A post-game rebuild that grants the colony an independent charter, then permanent unlocks that make every system a little bigger, at a rising cost.
- **A story.** Calls with branching scenes, moods and portraits, and mail, paced to the colony's progress.
- **Desk and phone layouts** over the same game, with live updates and offline catch-up.
- **An admin panel** on an internal port: accounts and suspensions, colony rollbacks, market intervention, bot control, backups, logs and updates from the repository.
- **Bots for small worlds.** Bots take over parked and given-up colonies, so there are still neighbours to trade with.

## Quick start

```bash
npm install
npm start                 # http://localhost:3000
```

Node.js 22. Register a Commander ID and click an empty slot on the radar. Without mail settings the email code is printed in the server's console. `npm run admin -- create <name>` makes an admin for the panel at http://127.0.0.1:3001.

## Documentation

| Guide | What it covers |
| --- | --- |
| [Playing](docs/gameplay.md) | The full manual: the screen layout, every system, orbit, Headquarters, hazards, story delivery |
| [Production guide](prod_guide.md) | Every number: buildings, recipes, costs, prices, hazards, orbit, Headquarters |
| [Deployment](docs/deployment.md) | Server settings, email and Turnstile, backups, upgrades, the bot runner, security |
| [Admin panel](docs/admin.md) | Managing players, colonies, markets, bots, backups, logs and updates |
| [Development](docs/development.md) | Tech stack, architecture, tests, tuning and playtests, themes and story, roadmap |
| [Design notes](docs/districts.md) | Districts, the exchange and the Free Port; also [orbit](docs/orbital.md) and [Headquarters](docs/headquarters.md) |
| [Story format](docs/story.md) | Writing a theme and a story; [content checklist](docs/content-needs.md) |
| [Security](docs/security.md) | What the server enforces and how to deploy it safely |

## Story attribution and license

FAILTECH and the world of FAILTECH are part of the FAILTECH story universe and are the copyrighted intellectual property of Ivan Lapis. Learn more at <https://failtech.info>.

The FAILTECH Recontinuation story included in `content/recontinuation/` was created for the game and is licensed alongside the FAILTECH Colonies: Radial Command game. The story license permits deployment of the Recontinuation story as-is, without modification, along with the game. No modification of the Recontinuation story by third parties is permitted under this license without prior authorization. The story is licensed separately from the game itself.

The same notice is kept beside the theme data, in [`content/recontinuation/NOTICE.md`](content/recontinuation/NOTICE.md). To change the wording or the narrative of your own deployment, write a theme of your own in another `content/` folder (see [Themes and story](docs/development.md#themes-and-story)) rather than editing `content/recontinuation/`. The easiest start is the `basic` theme: edit `content/basic/` (or copy it to a new folder, such as `content/mystory/`), write your own story and wording there, then start the server with `THEME=<folder>` (for example `THEME=mystory npm start`).

The art in `content/recontinuation/assets/` is AI-generated, and you may reuse it in your own theme. The characters, story and world of FAILTECH remain copyrighted intellectual property, so a theme that reuses the art must replace the character names and the narrative with its own.

## License

Copyright 2026 Ivan Lapis (ivan@terrantech.ca).

The game (its code and the `basic` theme) is licensed under the [Apache License, Version 2.0](LICENSE). In short: you may use, modify and redistribute it, commercially or not, provided you include the license and the [`NOTICE`](NOTICE) file with any copy or derivative, mark the files you changed, and keep the copyright and attribution notices. It comes with no warranty.

The Recontinuation story is not covered by the Apache License; see [Story attribution and license](#story-attribution-and-license).
