# Themes and story: how the content layer works

All wording and narrative live in `content/<theme>/`. The rules (`game_config.json`) never change with a theme.
Pick a theme with the `THEME` environment variable (default `recontinuation`; `basic` is the neutral original wording). Check your edits with `npm run check-content`.

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
  resumed later. The ringing card can be collapsed to a pill, or skipped. A **mail** goes to the Messages window with an unread
  badge and a toast; clicking a mail opens it in a reading window (sender portrait or initials, subject, body, and an "Open transmission" button when the mail carries a scene). Played dialogues stay in the Calls list of the Messages window and can be replayed.
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
| `requisitions` | `min` | requisitions filled |
| `buildSlots` | `min` | some place (the Core or a district) has that many build slots |
| `building` | `id` | a building of that type stands anywhere in the colony |
| `recipes` | `min` | that many lines run an alternative recipe (a workshop's chosen recipe does not count) |
| `settlement` | `flag`, `kind?`, `min?` | `sponsored` (settlements ever sponsored), `stage` (one has reached stage `min`), `answered` (appeals answered), `partner` (settlements set on their own feet). `kind` limits it to one kind (`foundry`, `valley`, `depot`); `min` defaults to 1 |
| `orbital` | `flag` | an orbit milestone (`unlocked`, `staging`, `catapult`, `command`, `cycleDone`, `launched`, `ring2`, `ring3`, `deployed`, `rareReturned`, `shipSaved`, `shipLost`, `contributed`, `projectCompleted`, `dataFragment`) |

A trigger looks at the colony's current state, so a beat can be late but never missed. A colony that has already passed
several triggers gets its backlog in script order, one beat at a time (see Pacing), and the call card offers "Skip all".

## Scenes with their own cast and media

A scene can bring its **own cast** and carry **images, sound and video**, which is how data packets are told (they need not use the shared characters at all), but any scene can use them.

```json
"pk_example": {
  "title": "Relay Station: Night Notes",
  "background": "beacon_night.jpg",
  "start": "a",
  "cast": { "maren": { "name": "Maren Voss", "title": "Relay technician", "color": "#6FB7A8", "side": "left", "portrait": "maren.webp" } },
  "nodes": {
    "a": { "text": ["No `who` means narration."], "image": "plate.jpg", "next": "b" },
    "b": { "who": "maren", "text": ["A line from a cast member."], "audio": "clip.ogg", "next": "c" },
    "c": { "text": ["Changes the backdrop from here on."], "background": "cellar.jpg", "music": "hum.ogg", "video": "tape.mp4" }
  }
}
```

- `cast`: characters that exist only in this scene (same fields as `characters`; a cast id may not repeat a shared character). Portraits and moods work the same way; with no portrait the game shows initials.
- Node media, all plain file names in `assets/`, each checked for its file type (`check-content` lists any that are missing and the game simply leaves them out until the file exists):
  - `background`: an image that replaces the scene's backdrop from this node on. A scene's or a node's `background` may also be a list of images (`["camp_a.jpg", "camp_b.jpg"]`): the game picks one at random each time the scene is played. `image`: a plate shown over the stage for this node only.
  - `audio`: a sound played once when the node is shown (`.mp3 .ogg .opus .m4a .wav`). `music`: a loop that continues across nodes until another node sets `music` or `"stop"`; it stops when the scene ends or is minimised.
  - `video`: (`.mp4 .webm`) plays full screen before the node's words, with controls and a Continue button; the text follows when it ends or is continued.
- Browsers only start sound after a click or key press. A scene always starts from one, so this is normally fine.
- Keep media small. Files live in the repository (`content/<theme>/assets/`) and are sent to the player as they are.

### Data packets as scenes

A packet part can be played as a scene: in `theme.json`, `dataPackets.<id>` takes `scene`, `scene2`, `scene3` (ids of scenes in `story.json`) beside its `text`, `text2`, `text3`. A part may have text only, a scene only, or both (the text is then a short caption above a Play button). The scene is not sent to the player until that part is unlocked.

## Artwork

`portrait` and `avatar` (characters) and `background` (scenes) name files in `content/<theme>/assets/`. A file that is not there yet is
simply ignored (a coloured silhouette and a plain backdrop are shown) and `npm run check-content` lists what is still
missing, so the story can be written before the art exists. Portraits (used in scenes): transparent WebP (or PNG; WebP is about 15 times smaller), about
800 x 1200. Avatars (used in the call card and mail window, shown in a circle): square, about 256 x 256, face at the top
centre; a character without one falls back to the portrait.
Backgrounds: 1920 x 1080.

## Moods

A scene node can set `"mood"` to show the speaker with a different expression. The set is fixed so that every character can
be drawn the same way: `neutral` (the default portrait), `happy`, `sad`, `angry`, `afraid`, `surprised`, `serious`,
`thoughtful`. The image is the portrait's name plus the mood, with the same extension, beside it in `assets/`: for `mags.webp`,
`mags_happy.webp`, `mags_sad.webp` and so on. Draw them on the same canvas, pose position and scale as the default so the swap does not jump.
A mood image that does not exist is replaced by the default portrait, and `npm run check-content` reports any mood a
scene uses that has not been drawn. Mood images are found when the server starts. Avatars have no moods.

## Delivery of text

The live game view carries only light metadata (id, title, sender, read state). The text itself is fetched from
`/api/story` and contains only what this colony has already been sent, so the script is not sent ahead of time.

## Adding a trigger type

Add it to `TRIGGERS` (validation) and `fires()` (evaluation) in `src/story.js`; document it above. Everything a trigger
needs is in the view built by `src/state.js`.

## Open source use

A theme is a folder. To publish the game with different wording, ship another `content/<name>/` and set `THEME`.
Portraits and backgrounds live under that theme's `assets/`, so artwork travels with the theme and nothing else.

## Future work: inline images in mail (not built)

The mail reading window already lets an image fit the width of the window, but the mail format has no way to include one.
The plan is an optional `images` list on `mail` (file names in `assets/`, shown between paragraphs or after the body) with
the same checks as portraits (plain file names, existing files only, reported by `npm run check-content`).
