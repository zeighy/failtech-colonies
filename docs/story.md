# Themes and story: how the content layer works

All wording and narrative live in `content/<theme>/`. The rules (`game_config.json`) never change with a theme.
Pick a theme with the `THEME` environment variable (default `default`). Check your edits with `npm run check-content`.

```
content/<theme>/
  theme.json   names, descriptions, directive text and UI wording
  story.json   characters, scenes, beats and mail
  assets/      portraits and backgrounds, served at /theme-assets/<file>
```

## theme.json

Every section is optional and partial: anything you omit keeps the name in `game_config.json`. Ids must exist in the
config; unknown ids are reported (and ignored), never fatal.

| section | ids | fields |
|---|---|---|
| `resources` | resource ids | `name` |
| `buildings` | building ids | `name`, `desc` |
| `districts` | district types | `name`, `desc` |
| `hazards` | hazard types | `name`, `desc` |
| `factions` | faction ids | `name`, `desc` |
| `recipes` | Trade Workshop recipes | `name` |
| `missionTitles` | | list of titles |
| `directives` | Brief directive ids | `title`, `hint` |
| `ui` | | `brand`, `subtitle`, `title` (browser tab), `loginNote`, `tabs{}`, `labels{}` |

Only text fields can be replaced; costs, recipes and rates cannot be touched by a theme.

## story.json

```jsonc
{
  "characters": { "steward": { "name": "Hub Steward", "title": "Keeper", "color": "#ff9f1c", "side": "left", "portrait": "steward.png" } },
  "scenes": {
    "prologue": {
      "title": "Cold start", "background": "wastes.jpg", "start": "wake",
      "nodes": {
        "wake": { "who": "steward", "text": ["First passage.", "Second passage."],
                  "choices": [ { "label": "Where is everyone?", "next": "where" }, { "label": "What do we have?", "next": "have" } ] },
        "where": { "who": "steward", "text": ["..."], "next": null }
      }
    }
  },
  "beats": [
    { "id": "c01_prologue", "phase": "campaign", "trigger": { "type": "start" }, "delivery": "dialogue", "scene": "prologue" },
    { "id": "c02_power", "phase": "campaign", "trigger": { "type": "directive", "id": "power" }, "delivery": "mail",
      "mail": { "from": "steward", "subject": "Lights on", "body": ["Paragraph one.", "Paragraph two."], "scene": "optional_scene" } }
  ]
}
```

- A **node** shows its `text` passages one click at a time (`who: null` is narration). It then either shows `choices`,
  continues to `next`, or ends the scene. Choices only choose which node comes next: they never change the game.
- **Campaign** beats are delivered strictly in file order: a beat waits until the one before it has been delivered, so
  the story always reads in order even if the player finishes directives out of order. **Open** beats are independent.
- A beat is delivered once per colony. A **dialogue** pops up as a full-screen overlay (the player can choose Later,
  which keeps it in Comms, or Skip); a **mail** goes to the Comms tab with an unread badge and a toast. Played dialogues
  stay in the Comms archive and can be replayed.
- Restarting a colony starts its story over.
- If anything in `story.json` is invalid the whole story is switched off (and the problems printed) rather than played
  half-broken.

### Triggers

| type | fields | fires when |
|---|---|---|
| `start` | | the colony exists |
| `directive` | `id` | a Brief directive is done |
| `hubLevel` | `min` | Core level reached |
| `district` | `district` | a district of that type exists |
| `standing` | `faction`, `min` | faction standing reached |
| `missions` | `min` | missions filled |
| `hazards` | `min` | hazards survived |
| `population` | `min` | people in the colony |
| `won` | | the Beacon message got through |
| `campaignDone` | | every Brief directive is done |
| `after` | `beat`, `delayTicks?` | some ticks after another beat |

A trigger looks at the colony's current state, so a beat can be late but never missed. A colony that has already passed
several triggers gets its backlog in script order, and the dialogue overlay offers "Skip all".

## Delivery of text

The live game view carries only light metadata (id, title, sender, read state). The text itself is fetched from
`/api/story` and contains only what this colony has already been sent, so the script is not sent ahead of time.

## Adding a trigger type

Add it to `TRIGGERS` (validation) and `fires()` (evaluation) in `src/story.js`; document it above. Everything a trigger
needs is in the view built by `src/state.js`.

## Open source use

A theme is a folder. To publish the game with different wording, ship another `content/<name>/` and set `THEME`.
Portraits and backgrounds live under that theme's `assets/`, so artwork travels with the theme and nothing else.
