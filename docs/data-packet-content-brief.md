# Data packets: content brief

This is the brief for writing the real lore behind the game's data packets, so it can be handed over and dropped into the game. Everything here is about *content*: wording, scenes, pictures, sound and video. None of it needs code.

## What a data packet is

Territories sometimes carry a **data site**. A Data Recovery building there slowly turns out **data fragments**. The player spends fragments (and, for later parts, a few orbital goods) to unlock **data packets** on the Data screen. A packet is pure lore: it changes nothing in the game.

- A packet is unlocked in **parts**. Part 1 costs fragments only. Later parts cost more fragments **and** a few orbital goods, so reading everything needs the foundry and expeditions as well as data sites.
- A **sealed** packet shows only what it costs. Its name, text and scenes are never sent to the player until they unlock it, so the cost is the only hint to size. The title is a reward for unlocking part 1.
- Each part can be **text**, a **scene** (a visual-novel style scene with a background, a cast, pictures, sound and video), or both (a short caption above a Play button).
- The pacing is deliberately a long game: all eight packets together are 49 fragments. Players come back every day or so, unlock one part, read it, and leave. So each part should be worth the wait.

## The eight packets today

These are placeholders. Replace, rename, merge, split or add as you like; the ids and costs below are what the game uses today. A part's fragment cost (and its goods) tracks its size, so if a part becomes much denser, its cost may need to rise to match. Tell me and I will change it.

| id | Working title | Parts: fragments (later parts also cost two orbital goods) | What it covers today |
|---|---|---|---|
| p01 | Charter Survey, Annex 0 | 1 | The first survey chose the hub's site; nobody argued. |
| p02 | Continuity Audit 4 | 1 | A flawless supply ledger. Too tidy to be real. |
| p03 | Relay Station Night Notes | 2 then 1 | The relay that only answers. A roll call it will not stop making. Part 1 is already a scene. |
| p04 | Site Report: The Slow Ground | 2 then 2 | What the anomalies do; they close on the Office's shift changes. |
| p05 | Founding Roll | 3 then 2 | 412 names, the "Returned" column, and a thirteenth line. |
| p06 | Archivist's Tray Log | 4 then 2 then 3 | Pell's samples; the tray that hums and repeats. Part 1 and the last part are scenes. |
| p07 | The Lapse, As Filed | 5 then 3 then 4 | The official account of the Lapse; the room with the paper; the first draft of the Charter. |
| p08 | Memorandum 0 | 6 then 3 then 5 | The final memo, the ledger of the colony's life, the last page. Part 3 is a scene. |

The current text for every part is in `content/recontinuation/theme.json` under `dataPackets`, and the three scenes are in `content/recontinuation/story.json` (`pk_p03_1`, `pk_p06_1`, `pk_p08_3`). Read them for the voice.

Currently a packet can have up to **three parts**. If you want more for any packet, say so and I will raise the limit.

## How long should a part be

The reader is a person who has waited a day or more for this. Denser is the goal. As a guide, by the fragment cost of the part:

| Cost | Words (text) | If a scene |
|---|---|---|
| 1 | 150 to 300 | 6 to 12 passages |
| 2 to 3 | 300 to 600 | 12 to 25 passages |
| 4 to 6 | 600 to 1,200 | 25 to 45 passages |

A **passage** is one click of the dialogue box. Keep a passage to roughly 250 characters (three or four lines) so it fits the box. A scene node can hold several passages. Long single blocks of text are better as plain text parts than as scenes.

Mix the two on purpose. Text suits documents, ledgers and letters. Scenes suit voices, recordings, places and anything you want the player to see or hear.

## The two shapes a part can take

### A. A text part

For each part give me:

```
PACKET: p03   PART: 2
TITLE (part 1 only): Relay Station Night Notes
TEXT:
First paragraph.

Second paragraph.
```

Plain paragraphs. A blank line between paragraphs. No formatting marks.

### B. A scene part

Give me the script in this shape (or write the JSON yourself; see the end). One block per node, in the order they play:

```
PACKET: p03   PART: 1
SCENE TITLE: Relay Station: Night Notes
BACKGROUND: beacon_night.jpg          (or a new file name; see Media)

CAST (only people who are not already a shared character):
  maren   Maren Voss | Relay technician | colour #6FB7A8 | side left | portrait maren.webp (optional)
  relay   The Relay  | Station 3        | colour #C9A227 | side right

NODES:
  a  (narration)
     The relay hums at night, a note just below hearing.
     -> b
  b  maren  [mood: afraid]
     It is the cooling. I keep telling them it is the cooling.
     -> c
  c  (narration)  [image: pk_p03_1_page.jpg]
     The pages below are in someone else's handwriting.
     -> d
  d  relay  [audio: pk_p03_1_roll.ogg]
     Maren Voss. Aldous Pike. Irene Calloway. Tomas Wren.
     -> end
```

Notes for the script:

- **Narration** has no speaker. A line with a speaker shows that character's name and portrait.
- `->` names the next node. A node ends the scene when it has none.
- **Choices** are allowed (the player picks a branch). They are worth using sparingly in lore, for a moment that matters. Write them as `choice: "label" -> node`.
- A **mood** (`happy`, `sad`, `angry`, `afraid`, `surprised`, `serious`, `thoughtful`) changes the portrait if a mood version exists. Without portrait art the game shows initials, so moods do nothing yet.
- A cast member may use **an existing shared character** instead (see Canon). Just give the id (`seven`, `pell`, `vane`, `noor`, `mags`, `raf`, `signal`) and no cast line.

## Media

Anything you want shown or played, name it and send me the file. File names are lowercase letters, digits, dot, underscore and hyphen only, up to 64 characters. Suggested naming: `pk_<packet>_<part>_<what>.<ext>`, for example `pk_p03_1_page.jpg`.

| What | Use it for | Format and size |
|---|---|---|
| **Background** | the scene's backdrop; a node can change it and it stays | JPG or WebP, 1920 x 1080, ideally under 400 KB |
| **Image plate** | a picture shown over the stage for one node (a document, a photo, a map) | PNG, JPG or WebP, up to 1600 px on the long side |
| **Portrait** (cast) | a character shown at the side | WebP with a transparent background, tall, around 800 x 1200, under 200 KB. Optional mood versions named `<name>_afraid.webp` etc. and an `<name>_avatar.webp` for the small round icon |
| **Sound** | played once when the node appears (a voice line, a click, a tone) | OGG (Opus) or MP3, ideally under 1 MB |
| **Music** | loops under the scene until another node changes it or says `stop` | OGG or MP3, a clean loop, ideally under 3 MB |
| **Video** | plays full screen before the node's words, with a Continue button | MP4 (H.264 and AAC) or WebM, 1280 x 720 at most, ideally under 15 MB and a minute long |

Files live in the repository and go to the player as they are, so keep them small. If a file is missing the game just leaves it out until it exists, so you can write the scene first and add media later; mark in your script which files are still to come.

The backgrounds that already exist, if you want to reuse them: `beacon_night`, `black_cut`, `catapult_launch`, `cliffside_reserve`, `colony_dusk`, `command_hub`, `freight_road`, `orbital_command`, `sanctuary_port` and `territory_landing` (all `.jpg`).

## Canon and tone

Write for the existing voice: dry institutional language and plain description, with something slightly wrong underneath. The horror is in the paperwork. Keep these in mind.

- **The Office** and **Continuity**: the bureaucracy that founded the colony and has no form for what is happening. **The Lapse** is the missing event that ended the old world and that the Office files as a clerical error.
- **The Series-9 Beacon**: what the colony builds to transmit. Its message is the quiet question of the whole game.
- **The anomalies and territories**: patient ground that opens, stays, and folds shut. Data sites are recovered traces from inside them.
- **Cast already in the game**: Seven (Continuity Node 7, an AI who files everything), Ansel Pell (archivist, nervous, keeps the humming tray of samples), Hesper Vane (quartermaster, practical), Mags Valdivia (Black Industries remnant, shift boss), Dr. Noor Haddad (Cliffside Accord, reserve warden), Raf Dimaculangan (Ammano Transit dispatcher) and The Signal (unknown). You may use them, or write new voices.
- **Places**: The Core, The Black Cut, The Gulf Stacks, The Cliffside Reserve, The Sanctuary Port, the Orbital Station and the anomalous territories.
- **Spellings and style**: British spelling (colour, grey). Do not use em dashes; use a comma, colon, full stop or a new sentence. The game swaps some words by theme (it says "cycle" where the engine says "tick"), so avoid game-mechanic terms and numbers in lore.
- **Do not contradict** what the main story has already said. The scenes are in `content/recontinuation/story.json` if you want to read them. If a packet reveals something big, tell me where it should sit in the order, and I will check it against what the player has seen by then.
- **Mystery is the point.** Each part should answer something small and ask something bigger. Parts of one packet should build on each other, and later parts (which cost goods as well) should be the bigger reveals.

## What to send back

1. **The text or script** for each part, one block per part in the shapes above. A single document for all packets is fine. Mark which parts are text and which are scenes.
2. **The media files**, with the exact names you used in the script.
3. **A short list of anything you changed from the table above**: new titles, parts added, ids dropped, or costs you think should change.
4. **A note on any new people** (name, role, colour, which side of the screen) and whether they have portrait art.
5. **Anything you want for the other theme.** The "basic" theme currently has a plainer set of the same eight packets. If you want it to match the new material, say so; otherwise I will leave it as it is.

You can send these in a message or as files. I will put them in `content/recontinuation/` (`theme.json`, `story.json` and `assets/`), run the content check, and play each one through to make sure it works before it goes in.

## If you want to write the JSON yourself

A packet is an entry under `dataPackets` in `content/<theme>/theme.json`. Its parts are `text`, `text2`, `text3`, and optionally `scene`, `scene2`, `scene3`, which name scenes in `story.json`:

```json
"p03": {
  "name": "Relay Station Night Notes",
  "text": "A caption shown above the Play button, or the whole text if there is no scene.",
  "scene": "pk_p03_1",
  "text2": "Part two, as text."
}
```

A scene goes in `scenes` in `content/<theme>/story.json`:

```json
"pk_p03_1": {
  "title": "Relay Station: Night Notes",
  "background": "beacon_night.jpg",
  "start": "a",
  "cast": { "maren": { "name": "Maren Voss", "title": "Relay technician", "color": "#6FB7A8", "side": "left" } },
  "nodes": {
    "a": { "text": ["The relay hums at night."], "next": "b" },
    "b": { "who": "maren", "text": ["It is the cooling."], "mood": "afraid", "image": "pk_p03_1_page.jpg", "audio": "pk_p03_1_hum.ogg" }
  }
}
```

The fields a node can use are `who`, `text` (a list of passages), `mood`, `next` or `choices`, `background`, `image`, `audio`, `music` and `video`. The full reference is in `docs/story.md` under "Scenes with their own cast and media", and `npm run check-content` lists every mistake and every missing file. Fragment costs and orbital goods for each part are in `game_config.json` under `orbital.data.packets`.
