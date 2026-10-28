# Content needs: what I need from you for the new setting

> **Status:** answered. The Recontinuation setting, glossary, cast, campaign and open phase were delivered and are in
> `content/recontinuation/` (the default theme). This document remains as the checklist for writing another theme.


The game is now ready to take your world. **Nothing about the rules changes**: only names, descriptions, UI wording and a
story layered on top. Everything lives in `content/basic/` (copy it to `content/<yourtheme>/` and run with
`THEME=<yourtheme>`). `docs/story.md` explains the file formats; `npm run check-content` validates your edits.

Everything below is a request, in the order I would tackle it. You do not need to answer all of it before we start: the
glossary alone is enough for the first pass.

## 1. The setting in a page (before anything else)

1. **Name of the world and of the game** (title screen, browser tab, top-left brand) and a one-line tagline.
2. **What the player is.** Right now: a commander holding a hub in the wastes. Who are they in your world, and why are
   they doing this? One paragraph.
3. **What the colony is for**: why the beacon matters, who might answer it, what "winning" means in the fiction.
4. **Tone**: grim, hopeful, wry, mythic? Two or three example sentences in the voice you want.
5. **Level of technology / vocabulary rules**: words to use, words to avoid, how people speak.
6. **What happens after the beacon** (the open-ended phase): who is the harbour, why do factions trade with the player,
   and why are other players' offers on the exchange there at all (the multiplayer justification).

## 2. Glossary: names and one-line descriptions

Every row is one thing the player sees. Fill in the new name (and description where one exists); leave a row blank to
keep the current wording. Ids never change.

### Resources (33)
| id | name |
|---|---|
| `scrap` | Scrap |
| `unpurified_water` | Raw Water |
| `clean_water` | Clean Water |
| `rations` | Rations |
| `machined_parts` | Machined Parts |
| `building_materials` | Building Materials |
| `raw_synthetics` | Raw Synthetics |
| `alloys` | Alloys |
| `circuits` | Circuits |
| `power_cells` | Power Cells |
| `meals` | Prepared Meals |
| `ore` | Ore |
| `ingots` | Ingots |
| `reagents` | Reagents |
| `crude` | Crude |
| `fuel` | Fuel |
| `polymers` | Polymers |
| `biomass` | Biomass |
| `fertiliser` | Fertiliser |
| `medicine` | Medicine |
| `curios` | Salvage Curios |
| `tool_steel` | Tool Steel |
| `preserves` | Preserved Goods |
| `plastics` | Moulded Plastics |
| `tinctures` | Tinctures |
| `precision_tools` | Precision Tools |
| `field_kits` | Field Kits |
| `grow_stims` | Growth Stimulants |
| `luxuries` | Luxury Goods |
| `masterworks` | Masterworks |
| `frames` | Structural Frames |
| `fittings` | Process Fittings |
| `modules` | Habitat Modules |

### Buildings (29)
| id | name | desc |
|---|---|---|
| `solar_array` | Solar Array | Collector fields feeding the colony grid. The backbone of everything else. |
| `scrap_extractor` | Scrap Extractor | Strip-mines the wreckage fields. Feeds the assemblers. |
| `water_pump` | Groundwater Pump | Pulls toxic water from the aquifer. Undrinkable until filtered. |
| `water_purifier` | Filtration Plant | Turns raw water into something people can actually drink. |
| `parts_assembler` | Parts Assembler | Presses scrap into machined parts. The first real bottleneck. |
| `hydroponics_bay` | Hydroponics Bay | Grows rations under lamps. Needs clean water to run. |
| `fabrication_works` | Fabrication Works | Forges building materials for the largest structures. Hub upgrades need them. |
| `scrap_generator` | Scrap Burner | Burns scrap for serious power. Wants a big plot to breathe. |
| `synth_reclaimer` | Synthetics Reclaimer | Turns surplus raw synthetics into polymers, two to one. The polymer plant makes more synthetics than the circuit line needs; this puts the rest to work. |
| `foundry` | Foundry | Smelts scrap and parts into structural alloys. Big furnaces need big plots. |
| `circuit_fab` | Circuit Fabricator | Prints circuitry from synthetics and polymers. Needs the Stacks. |
| `cell_forge` | Cell Forge | Assembles power cells from alloys and circuits. The most demanding build in the colony. |
| `warehouse` | Warehouse | Extra racking: raises the storage cap of every resource. |
| `watch_post` | Watch Post | Armed lookouts. Their combined strength decides how badly raiders hurt you. |
| `beacon_array` | Beacon Array | A transmitter that can reach what is left of the world. Only one can be built. |
| `kitchen` | Kitchen | Turns plain rations into proper meals. Hungry people survive on rations; people who eat well are happier and work harder. |
| `dormitory` | Dormitory | Bunks for a few more colonists. Noise and fumes from neighbours make for poor sleep. |
| `habitat` | Habitat Block | A proper residential block. Big, and worth placing carefully: homes next to heavy industry are miserable. |
| `ore_drill` | Ore Drill | Bores into the old strata for raw ore. Only the Pits have the seams. |
| `smelter` | Smelter | Runs ore down into ingots. Wants a wide plot and a lot of heat. |
| `alloy_works` | Alloy Works | Bulk alloys from ingots: the heavy end of the Pits. Give it a Large plot and it outproduces the Core foundry. |
| `crude_pump` | Crude Pump | Taps the old pipelines and tar seeps for crude. |
| `cracking_tower` | Cracking Tower | Splits crude into fuel and the reagents everything else is hungry for. |
| `polymer_plant` | Polymer Plant | Cooks crude into polymers, with synthetics as a by-product. The pipework needs ingots, and the Stacks make none. |
| `fuel_generator` | Fuel Generator | Burns refined fuel for serious power. |
| `bio_dome` | Bio Dome | Sealed greenery under glass, watered straight from the valley springs. Grows biomass and makes the neighbours feel better. |
| `agri_lab` | Agri Lab | Cultures soil enhancers out of biomass and reagents. |
| `pharma_lab` | Pharma Lab | Medicine from biomass, reagents and a little polymer packaging. Slow, and worth a lot. |
| `trade_workshop` | Trade Workshop | Turns colony goods into trade goods. Choose one recipe and it is locked in: changing it costs credits and idles the shop. A bigger plot runs a bigger batch (more in, more out), not a better one. |

### Districts (4)
| id | name | desc |
|---|---|---|
| `pits` | The Pits | Strip-mined strata and collapsed foundries. Ore comes out of the ground here, then ingots and bulk alloys. |
| `stacks` | The Stacks | Flare towers and pipe-forests over the old refineries. Crude, fuel, reagents and polymers, plus the synthetics and circuits built from them. |
| `greenbelt` | The Greenbelt | Sealed bio-domes in the one clean valley left. Biomass, fertiliser and medicine, if you can bring it what it lacks. |
| `freeport` | The Free Port | A tax-free harbour on the far side of the wastes. Anything can be built here except the base-resource extractors of the other districts, and its workshops turn what you make into what the world pays for. |

### Hazards (7)
| id | name | desc |
|---|---|---|
| `dust_storm` | Dust Storm | A wall of grit is rolling in. Solar output will collapse while it lasts. |
| `equipment_fault` | Equipment Fault | Worn machinery is about to fail. Several structures will lose efficiency until repaired. |
| `blight` | Crop Blight | Spores are spreading through the growing beds. Food output will crash. |
| `raid` | Raid | Raiders have spotted the colony. Unguarded stockpiles will be looted and outer buildings damaged. |
| `toxic_spill` | Toxic Spill | The aquifer is fouling. Water extraction and filtration will crawl. |
| `cold_snap` | Cold Snap | A killing cold is coming. The colony will burn through water and rations far faster. |
| `signal_storm` | Signal Storm | Interference is building across the bands. The beacon will struggle to transmit. |

### Factions (3)
| id | name | desc |
|---|---|---|
| `cinder` | Cinder Syndicate | Foundry bosses who pay well for anything that cuts or carries a load. |
| `verdant` | Verdant Accord | Valley growers who want medicine, comfort and anything that keeps the green alive. |
| `meridian` | Meridian Transit | A road-and-rail company that buys finished goods by the crate. |

### Trade Workshop recipes (13)
| id | name |
|---|---|
| `curios` | Salvage Curios |
| `tool_steel` | Tool Steel |
| `preserves` | Preserved Goods |
| `plastics` | Moulded Plastics |
| `tinctures` | Tinctures |
| `precision_tools` | Precision Tools |
| `field_kits` | Field Kits |
| `grow_stims` | Growth Stimulants |
| `luxuries` | Luxury Goods |
| `masterworks` | Masterworks |
| `frames` | Structural Frames |
| `fittings` | Process Fittings |
| `modules` | Habitat Modules |

### Mission titles
- Supply requisition
- Standing order
- Urgent shortfall
- Caravan manifest
- Harbour tender
- Quartermaster's request

### UI words
Brand, subtitle, browser title, login note, the top-bar labels (credits, population, morale, collapse clock,
power grid, convoy) and the workspace names (Brief, Site, Hub, People, Districts, Logistics, Convoy, Exchange,
Missions, Comms, Log). These are in `ui` in `theme.json`. If your setting has its own words for *hub*, *colony*,
*credits*, *convoy*, tell me the list.

## 3. The cast

For each recurring character (the steward voice, "The Signal", one voice per faction, anyone else):

- name, title or role, one line of personality, how they address the player
- a colour (used for the name plate)
- which side of the screen they stand on (left or right)
- **portrait** (optional; a coloured silhouette with initials is shown until you supply one): a transparent PNG or WebP,
  roughly 800 x 1200 px (any size works, it is scaled to about 60% of the screen height), full or half length, facing
  the middle of the screen. Put it in `content/<theme>/assets/` and name it in `story.json`.
- **backgrounds** (optional, one per scene or reused): 1920 x 1080 JPG or WebP, darkened a little in the game so text
  stays readable.

## 4. The campaign

The linear story is driven by the 31 Brief directives the player already works through. Each directive is a natural
chapter marker. I need, for the beats you want, **a trigger, a delivery method and the text**. You do not need one per
directive: most players will see a dialogue every few directives, with mail in between.

| id | current title | what it asks of the player |
|---|---|---|
| `power` | Lights out | The hub's own supply won't carry much. Everything that wants energy competes for the same… |
| `scrap` | Running on fumes | Scrap pays for every structure and some machines eat it. The cache only ever goes down unl… |
| `parts` | Components | The advanced structures need parts you aren't holding. Nobody sells them cheaply, and they… |
| `water` | Something drinkable | Water from the ground is poison. The colony drinks from clean tanks, and the tanks are dra… |
| `food` | Something edible | Rations don't appear on their own. Growing food needs light, clean water and components, a… |
| `adjacency` | Good neighbours | Placement matters. Inspect a structure to see who sits beside it, and think about who shou… |
| `steady` | Break even | Everything the colony consumes must be replaced. Watch the green and red rates beside your… |
| `market` | Open the market | A convoy passes on a schedule, at prices that move. It only trades what you arranged befor… |
| `hub2` | Room to grow | The first ring fills quickly. The hub itself can be pushed further, at a price, and more o… |
| `plots` | Elbow room | Some structures want more room than the inner rings offer. A cramped plot still works, at… |
| `housing` | A roof overhead | The hub's own quarters only hold so many, and machines need people to run them. More homes… |
| `meals` | Something worth eating | Bare rations keep people alive, not happy. A proper meal does something rations never will… |
| `quiet` | A quiet corner | People sleep badly beside furnaces and diggers. Where the homes go decides how the neighbo… |
| `storm` | Trouble comes with a warning | Something will eventually be headed your way. What the colony has in reserve when it lands… |
| `materials` | Heavy lifting | The larger upgrades want a material nobody mines. Something has to forge it, and that some… |
| `hub3` | The crown's price | A bigger hub is a hungrier one. From here it draws on the colony just to stay standing, so… |
| `alloys` | Hard metal | Structural metals need furnaces, and furnaces need room to breathe.… |
| `hub4` | A wider circle | Another ring, another bill. The upkeep climbs, and it now includes things you had to make.… |
| `district` | Beyond the walls | The hub is wide enough to reach past its own rings. Somewhere out there is ground worth ho… |
| `ore` | Raw from the ground | A satellite makes its own power and keeps its own stockpile. Whatever it digs up has to be… |
| `route` | Keep it flowing | Hauling goods by hand does not scale. Some things are needed every tick, and a standing ar… |
| `exchange` | Name your price | The convoy takes what it is offered at its own prices. Somewhere there is a place where yo… |
| `synth` | Something synthetic | Plastics and fine chemistry come from the old refineries, a long way from the hub. Whoever… |
| `circuits` | Fine work | Precision parts need synthetics, a chemical ingredient, patience, and a plot that gives th… |
| `cells` | Concentrated power | Something has to combine your best metals and your finest circuits into a compact power so… |
| `medicine` | Something to heal with | The last materials for the transmitter are grown, not forged, in the one place that still… |
| `hub5` | The far ring | The outermost ring has plots big enough for anything. The hub has to be strong enough to o… |
| `beacon` | Reach out | A transmitter big enough to be heard across the wastes wants the largest plot, the finest… |
| `transmit` | Hold the signal | It has to keep running, powered and supplied, until the message gets through. Anything tha… |
| `harbour` | Someone heard | The signal reached something. There is a place now that will take anything you can make, a… |
| `mission` | A name in the harbour | People there post what they need and name what they will pay. Doing someone a favour is a… |

Other triggers available: Core level reached, a district founded, faction standing reached, missions filled, hazards
survived, population, the beacon completing, the Brief being complete (the open phase starts), and "N ticks after
another beat".

For each beat:

- **Dialogue** (the full-screen scene): 2 to 6 short passages, optionally a branching choice (choices only change
  which lines you hear, never the game). Say who speaks each passage.
- **Mail**: sender, subject, 1 to 3 paragraphs. A mail can also carry a button that opens a dialogue.

A rough target to start with: **6 to 10 dialogues and 10 to 15 mails for the campaign**, plus the open phase below.

## 5. The open phase (after the campaign)

The factions' standing is the hook: for each faction I need dialogue or mail unlocked at standing thresholds (the
placeholder uses 10 and 40; missions award roughly 3 to 10 standing each, so these are about 2 to 5 missions and
about 10 to 15 missions). Useful to know from you: what each faction wants from the player *in the fiction*, how they
speak, and what a "rank" in their favour means. If you want more than three factions, or different ones, say so; adding
one is a config change plus its text.

## 6. Things the theme layer cannot do yet (and what I will do about them)

- Prose written into the interface code (panel hints, button labels, error messages) still uses the current words
  (hub, convoy, credits and so on). Once I have your glossary I will move the important ones into `ui` so they can be
  themed too. Tell me which terms matter most.
- Numbers, costs, recipes and balance are not part of a theme and are not meant to be.
- The short log lines the game writes (for example "Mission filled for the ...") use the themed names but keep their
  sentence structure.

## 7. Handing it over

The easiest format is whatever you already have: notes, a lore document, or a spreadsheet. I will do the conversion
into `theme.json` and `story.json`. Or you can edit those files directly; `npm run check-content` will tell you about
mistakes (unknown ids, broken branches, unreachable lines).
