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
| **Sound** | played once when the node appears (a voice line, a click, a tone) | MP3 or M4A, ideally under 1 MB (see Providing audio and video) |
| **Music** | loops under the scene until another node changes it or says `stop` | MP3 or M4A, a clean loop, ideally under 3 MB (see Providing audio and video) |
| **Video** | plays full screen before the node's words, with a Continue button | MP4 (H.264 and AAC), 1280 x 720 at most, ideally under 15 MB and a minute long (see Providing audio and video) |

Files live in the repository and go to the player as they are, so keep them small. If a file is missing the game just leaves it out until it exists, so you can write the scene first and add media later; mark in your script which files are still to come.

The backgrounds that already exist, if you want to reuse them: `beacon_night`, `black_cut`, `catapult_launch`, `cliffside_reserve`, `colony_dusk`, `command_hub`, `freight_road`, `orbital_command`, `sanctuary_port` and `territory_landing` (all `.jpg`).

### Providing audio and video

**How to hand them over.** Send each clip as a normal file, named as in the script (for example `pk_p03_1_roll.mp3`), alongside the script. Any common source format is fine (WAV, FLAC, AIFF, MP3, M4A, OGG, MOV, MP4, MKV, WebM); I can convert and trim it for you, so you do not need to encode anything yourself. If you would rather deliver game-ready files, use the formats below. Always send the **highest quality original** if you have one, so I convert from that rather than from an already compressed copy.

Alongside each clip, add a line to the script saying:

- **Which node** it belongs to, and whether it is a **sound** (plays once), **music** (loops) or **video**.
- A **transcript** of any speech in it (used for captions and checked against the scene's text, so what is shown and what is heard match).
- For music: where the loop point is, if the clip is not already a clean loop.

**What the player's browser can play.** The game uses the browser's own audio and video players, so the files must be formats browsers support. These are the safe choices:

| | Best choice (works everywhere) | Also accepted |
|---|---|---|
| **Sound and music** | **MP3**, 128 kbps (stereo, or mono for speech at 96 kbps), 44.1 kHz. Or **M4A** (AAC) at 128 kbps | **OGG** (Vorbis or Opus): fine in Chrome, Edge and Firefox, but older Safari cannot play it, so use it only if you do not mind that; **WAV** works but is large |
| **Video** | **MP4**: H.264 video, AAC audio, yuv420p, up to 1280 x 720 at 24 or 30 fps, with the "fast start" flag so it begins playing before it has fully downloaded | **WebM** (VP9 video, Opus audio): Chrome, Edge and Firefox play it, older Safari does not |

The game accepts these file extensions: sound and music `.mp3 .ogg .opus .m4a .wav`; video `.mp4 .webm`. Anything else is rejected by the content check.

**Sizes and lengths.**

- **Sounds**: a few seconds to a minute; ideally under 1 MB.
- **Music**: one to three minutes of a clean loop; ideally under 3 MB. Loops should start and end on the same level with no silence at either end, or the repeat will be audible. MP3 adds a tiny gap at the start and end, so for a tight loop send the original WAV and I will encode it as M4A or OGG.
- **Speech**: record at a consistent level. Aim for roughly -16 LUFS (about the loudness of a podcast) for voice and a bit quieter, around -20 LUFS, for music, so music never covers a voice. I can normalise levels if they are uneven.
- **Video**: up to about one minute, 1280 x 720 or smaller, ideally under 15 MB, with sound in the video itself (there is no separate subtitle track, so burn captions in if you need them). Keep the main action in the middle of the frame: the Continue button sits underneath it.

**Playback behaviour to design around.**

- Sound only starts after the player clicks or presses a key. A scene always starts from a click (the Play button), so it works, but a scene that begins with music is better than one that waits a minute before any.
- A **sound** plays once when its node appears. **Music** keeps looping across the following nodes until another node changes it or says `stop`, and it stops when the scene ends or is minimised.
- A **video** plays full screen *before* its node's words. The player can pause it or press Continue; the words appear when it ends or is continued.
- There is no volume control inside a scene yet; the music plays at half volume. Tell me if you want one.

**If you want to prepare files yourself**, these `ffmpeg` commands make files the game accepts (replace the names):

```
# sound or music, MP3 (works everywhere)
ffmpeg -i input.wav -codec:a libmp3lame -b:a 128k -ar 44100 pk_p03_1_roll.mp3

# sound or music, M4A (AAC)
ffmpeg -i input.wav -codec:a aac -b:a 128k -ar 44100 pk_p03_1_roll.m4a

# video, MP4 (works everywhere)
ffmpeg -i input.mov -vf "scale=-2:720" -c:v libx264 -crf 24 -preset slow -pix_fmt yuv420p \
  -c:a aac -b:a 128k -movflags +faststart pk_p03_1_tape.mp4

# video, WebM (smaller, but not older Safari)
ffmpeg -i input.mov -vf "scale=-2:720" -c:v libvpx-vp9 -b:v 0 -crf 33 -c:a libopus -b:a 96k pk_p03_1_tape.webm
```

I have checked that this version of the game plays a WebM video, an OGG sound and an MP3 music loop through a scene and returns to the words after the video ends. H.264 MP4 and M4A are standard browser formats, but the test browser I use has no H.264, so I have not seen those play here; they are the formats I recommend for real players.

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
