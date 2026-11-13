# Headquarters: the long sink after the story

Headquarters is a resource sink for colonies that have finished everything else. It works like a research tree without using that name: every piece of work makes an existing system a little bigger. It adds no new mechanics. Every number is in `config.hq` (and dropship level 4 in `orbital.dropships.levels`). The generated tables are in section 16c of `prod_guide.md`.

## Flow

1. **Found.** The screen appears beside Data (Archive group) once the colony has read part 1 of any data packet, whatever the packet cost. `hq.rowOf` creates the colony's row the first time it is asked, sets the story flag `hqOpened` and logs it.
2. **Activation.** One heavy bill (three orbital goods × 500, five trade goods × 10,000, five intermediates × 100,000) is paid from the **Core** in any instalments, like a settlement drive. Goods held elsewhere have to be shipped or routed to the Core first. The player can send one good (all of it, or an amount) or everything the Core holds that the bill still needs.
3. **Rebuilding.** After the last delivery the rebuild takes `activation.ticks` (18 h at 15 s ticks).
4. **Charter.** The rebuild finishing sets the story flag `chartered` and pays `charter.credits` into the treasury. The station's name then carries `charter.badge` (◆) on the orbital market and on the station screen, and the colony gets `charter.freeUnlocks` free unlocks.
5. **Unlocks.** One piece of work at a time, with no caps.
   - Before committing, the player sees which goods an option takes but not how many (the view sends only the goods' ids).
   - Committing takes `fragmentCost` data fragments (1), and so does switching. This keeps data sites and trace recovery worth doing after every packet has been read. Free unlocks take none.
   - Committing locks in the bill: the category's base × `costMult`^n (1.25), and `baseTicks` × `timeMult`^n of work afterwards (6 h × 1.1^n). Here n counts every paid unlock so far, one counter for all categories.
   - Each category's bill includes its own orbital good and two trade goods, so no category is a cheap way round the counter.
   - **Abandon:** nothing is refunded.
   - **Switch:** choosing another option while one is still being funded carries `switchCarry` (25%) of each delivered good across, for the goods both bills share. Credits count as a good. Nothing can be switched once the work has started.
   - **Free unlocks** apply at once. They have no bill and no wait, and they do not move the counter.

## The options

| Category | Option | What it changes | Where |
| --- | --- | --- | --- |
| Discover New District | Chart a new district | A copy of an existing district type with its own name prefix ("Far Pits"), listed for founding at the type's own cost and rules. It is never founded automatically. The first discovery is always a Free Port; after that the type is random and never the same as the previous one. Each discovery lies `extraDistance` × its number further from the Core, which only slows one-off shipments. | `hq.discover`, `hq_discoveries`, `districts.discovery_id/extra_distance` |
| Station Expansion | Orbital link | +1 Core link at any link level | `orbital.linkCount` |
| | High-capacity slot | A slot of its own kind (`orbital_slots.kind = 'hc'`, numbered from 100) holding `capMult` × the level cap. It is never jettisoned. Goods move between it and an ordinary slot; once empty it can be freed for any resource. A resource that needs a slot takes an ordinary one first. | `orbital.enforceSlots/moveSlot/releaseSlot`, `capHigh` in the simulation |
| | Dropship bay | +1 to the dropship limit (the ship still has to be built) | `territories.maxShips` |
| | Level 4 refit | The chosen level-3 ship becomes level 4 (power 240, hold 3,600, links 60/t). A level-4 ship is never destroyed: at worst it comes home at 10% with its cargo lost. Level 4 can never be bought the ordinary way. If the ship is no longer at level 3 when the work finishes, the refit is banked and used from the ship card. The option is closed while no ship is at level 3. | `orbital.dropships.levels.4` (`hqOnly`, `unbreakable`) |
| Surface Colony Expansion | Standing route slot | +1 on `logistics.maxRoutes` | `perks.maxRoutes` |
| | District link capacity | +50/tick on every district link, on top of its level and any settlement bonus | `perks.linkBonus` |
| Territory Deployment Support | Territory stabilizer | Chosen at deploy time. The stabilizer cools down for 7 days from deployment and is never consumed. On landing (if the territory is not already stabilised) the remaining time × 100. Harm stops (rare yield and ship power never below ×1, no damage, no late damage) while bonuses stay. Leaving never destabilises it, and any station can land one ship there. | `territories.stabilizeTerritory`, `orbital.anomalyOf` |
| | Stable territory finder | Creates a private territory (`owner_colony`) only this colony sees. Its rare is random, and its commons and district resource are chosen so the tap can extract it. It has the hidden `stable` anomaly (no effects), no data site, and lasts 500 × the average territory lifetime (about a year and a half). It never destabilises, so the player can return as often as they like. | `territories.spawnPrivate/extractable` |
| | Extra territory link | A reusable kit: chosen at deploy time it gives that ship +1 territory link, and it is free again once the ship flies home (or is lost) | `perks.freeLinkKits`, `dropships.extra_links` |

## Code map

| File | What it owns |
| --- | --- |
| `src/hq.js` | the row, activation, rebuild, charter, bills, timers, start/switch/abort, free unlocks, applying an option, discoveries, the view |
| `src/perks.js` | what has been unlocked (`colony_hq.perks`), read by the code each option changes; kept apart so orbital.js and territories.js need not require hq.js |
| `src/orbital.js` | high-capacity slots, the extra Core links, `anomalyOf` (stabilised territories), the badge on the station view |
| `src/territories.js` | stabilizer, private territories, link kits, dropship bays, level-4 ships |
| `public/js/game.js` | the Headquarters screen (`hqTab`), discovered districts on the district map and the Districts screen |
| `public/js/orbit.js` | high-capacity slots, deploy options, territory tags, the refit button |
| `test/hq.test.js` | the whole feature |

Bots ignore Headquarters entirely. Story: `hq01_found` (Seven: qualified to run independently, but the headquarters is down) on `hqOpened`, and `hq02_charter` (Seven: Independent Colony Commander) on `chartered`, in both themes.
