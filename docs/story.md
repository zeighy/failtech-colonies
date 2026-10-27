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
| `ranks` | faction ids | `[{ "min": 0, "name": "..." }, ...]`, ascending, first at 0. Shown beside the faction's standing on the Missions tab. Fiction only |
| `ui` | | `brand`, `subtitle`, `title` (browser tab), `loginNote`, `tabs{}`, `labels{}`, `won{title,text,button}`, `failed{title,text,carry,count,button}` (`{credits}` and `{n}` are filled in) |

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

- A **node** shows its `text` passages one click at a time (`who: null` is narration; `tag: "radio"` adds a small note beside the speaker's name; `prompt` is a line shown above the choices). It then either shows `choices`,
  continues to `next`, or ends the scene. Choices only choose which node comes next: they never change the game.
- **Campaign** beats are delivered strictly in file order: a beat waits until the one before it has been delivered, so
  the story always reads in order even if the player finishes directives out of order. **Open** beats are independent.
- A beat is delivered once per colony. A **dialogue** arrives as an incoming call: a card in the bottom-right corner that
  the player answers when convenient (it also rings on login if one was triggered while they were away). Answering opens
  the full-screen scene, which can be **minimized** at any time (button or Esc) into a small "On call" bar in the corner and
  resumed later. The ringing card can be collapsed to a pill, or skipped. A **mail** goes to the Comms tab with an unread
  badge and a toast; clicking a mail opens it in a reading window (sender portrait or initials, subject, body, and an "Open transmission" button when the mail carries a scene). Played dialogues stay in the Comms archive and can be replayed.
- **Pacing.** Beats are delivered one at a time. A call is never delivered while another call is unanswered. When several
  beats are due at once (an existing colony catching up with a new script, or one event unlocking two beats), the next
  arrives only once everything already delivered has been answered, skipped or read, so progress can be reviewed step by
  step. A lone due beat is not held up by unread mail.
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
| `progress` | `min` | the Beacon has been transmitting for `min` ticks |
| `won` | | the Beacon message got through |
| `campaignDone` | | every Brief directive is done |
| `after` | `beat`, `delayTicks?` | some ticks after another beat |

A trigger looks at the colony's current state, so a beat can be late but never missed. A colony that has already passed
several triggers gets its backlog in script order, one beat at a time (see Pacing), and the call card offers "Skip all".

## Artwork

`portrait` (characters) and `background` (scenes) name files in `content/<theme>/assets/`. A file that is not there yet is
simply ignored (a coloured silhouette and a plain backdrop are shown) and `npm run check-content` lists what is still
missing, so the story can be written before the art exists. Portraits: transparent PNG or WebP, about 800 x 1200.
Backgrounds: 1920 x 1080.

## Delivery of text

The live game view carries only light metadata (id, title, sender, read state). The text itself is fetched from
`/api/story` and contains only what this colony has already been sent, so the script is not sent ahead of time.

## Adding a trigger type

Add it to `TRIGGERS` (validation) and `fires()` (evaluation) in `src/story.js`; document it above. Everything a trigger
needs is in the view built by `src/state.js`.

## Open source use

A theme is a folder. To publish the game with different wording, ship another `content/<name>/` and set `THEME`.
Portraits and backgrounds live under that theme's `assets/`, so artwork travels with the theme and nothing else.
