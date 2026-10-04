# rpgmaker-mcp

An MCP server that lets an AI agent inspect and edit an **RPG Maker MZ** project
through its real data files — including rendering maps to PNG so the agent can
*see* the layout instead of guessing it from tile id arrays.

```
data/Map001.json  ──►  read / write / paint / events  ──►  composited PNG preview
data/System.json      (engine-faithful autotiles, shadows, z-order)
img/tilesets/*.png
```

Every claim in this README is checked by a command. [`ACCEPTANCE.md`](ACCEPTANCE.md) is the
reviewer's runbook: what to run, what each suite settles, the numbers the recorded run
printed, and the gaps that are stated rather than smoothed over. [`CHANGELOG.md`](CHANGELOG.md)
says what changed release by release, [`REVIEW-RESPONSE.md`](REVIEW-RESPONSE.md) answers the
three independent acceptance reviews this package has been through item by item, and
[`RELEASING.md`](RELEASING.md) is the checklist for publishing it without shipping someone's
copyrighted project or proprietary engine dump.

## Why this exists

MZ stores the whole game as JSON under `data/`, so an agent can edit it directly.
The problem is that a map is a flat array of ~8,000 integers and event commands
are numeric codes, which makes text-only editing a guessing game. This server
fixes both: it composites maps into images the agent can look at, and it decodes
event commands into named, parameter-labelled lines derived from the engine's own
`Game_Interpreter`.

## Requirements

- Node.js 20+
- An RPG Maker MZ project folder (the one containing `data/`, `img/`, `js/`)
- A local RPG Maker MZ installation. The renderer reads autotile tables and tile
  id boundaries from the engine file `data/corescript/v*/rmmz_core.js` **at
  runtime, from your installation** — nothing proprietary is vendored here, and
  the renderer always matches the engine version you actually use.

## Install

From the source tree:

```bash
git clone https://github.com/twrsm666/rpgmaker-mcp && cd rpgmaker-mcp
npm ci                     # the lock file is committed for this path; from an unpacked
                           # tarball use `npm install` instead — npm strips the lock from a pack
npm run build

# The event-command dictionary is derived from the engine you own rather than
# vendored here. Without it the server still runs, but `decode_commands` reports
# raw codes and `command_catalog` comes back empty.
node scripts/extract-commands.mjs "/path/to/RPG Maker MZ/data/corescript"
```

From the published package (`npm i rpgmaker-mcp`, or `npm pack` + unpack + `npm install`):
`dist/` is already compiled, so there is no build step and `npm run build` is not the
command to reach for — the tarball carries no `src/`, and `tsc` there prints its help and
exits 1. Run `npm run verify:full` and it skips the compile with a printed reason and runs
the other fourteen suites. Use `npm install`, not `npm ci`: npm strips
`package-lock.json` from a pack, so `ci` has nothing to install from. The same
`extract-commands` line applies.

## Configure your MCP client

Point the client at the built server and tell it which project to open:

```json
{
  "mcpServers": {
    "rpgmaker": {
      "command": "node",
      "args": ["/absolute/path/to/rpgmaker-mcp/dist/index.js"],
      "env": {
        "RMMZ_PROJECT": "/absolute/path/to/MyGame",
        "RMMZ_CORESCRIPT_ROOT": "/absolute/path/to/RPG Maker MZ/data/corescript"
      }
    }
  }
}
```

| Variable | Purpose |
| --- | --- |
| `RMMZ_PROJECT` | Project folder to operate on. Also accepted as `--project <dir>`. |
| `RMMZ_CORESCRIPT_ROOT` | `<install>/data/corescript`. Skipped if auto-discovery finds your install. |
| `RMMZ_ENGINE_VERSION` | Pin the engine version (e.g. `1.8.0`) when several are installed. |
| `RMMZ_CODEBOOK` | Path to a generated `commands.json` if it is not in the default place. |
| `RMMZ_LIVE_TOKEN` | Shared secret between the server and `RMMZLiveBridge.js`. Required for any live tool; the plugin's Token parameter must be the same value. |
| `RMMZ_SETTINGS` | The MCP client settings file the scripted suites read the four values above out of, so you never set a path twice. Defaults to `~/.qoder-cn/settings.json`, then `~/.qoder/settings.json`. |

The scripts in `scripts/` need the same three things the server does — project folder,
corescript folder, bridge token — and resolve them in that order: environment variable,
then the registered server's own `env` block in that settings file, then
`.rpgmaker-mcp/live.env` if you generated a token by hand. Nothing in this repository
hardcodes a machine's paths.

## First commands

Three, in this order:

```bash
npm run fix-project -- --check   # every key the engine reads without a fallback, and which are missing
npm run fix-project              # write them. A project copied from the engine's own
                                 # `data/newdata` template has no `System.advanced.windowOpacity`,
                                 # and its game then dies on the title screen with `reading 'clamp'`
npm run census                   # the acceptance game, built from that template alone, with its
                                 # high-level/escape-hatch census printed and gated on zero writes
```

Every suite that starts a game runs that same repair for itself before it boots, so a project
that came out of the template needs no ceremony. `fix-project` is what to reach for when a
playtest sits at a title screen: it names the key it wrote, where the value came from, and
writes nothing on a project that is already complete.

Then, ordered by what each one needs:

| Command | Needs | What it settles |
| --- | --- | --- |
| `npm run verify:newdata` | an MZ install, and nothing else — it copies the template and installs the bridge plugin into that copy | the shipped template, shown broken, then repaired, booted, built a game into and played to its credits: 21 checks |
| `npm run census` | an MZ install | the acceptance game rebuilt into that same template copy, and its cost: 25 high-level calls, 0 low-level writes underneath them |
| `npm run verify:input` | the bridge plugin enabled in `RMMZ_PROJECT`, carrying `RMMZ_LIVE_TOKEN` | keys, walking, dialog and a door, in a live headless game: 40 checks |
| `npm run session:e2e`, `npm run e2e:live` | the same plugin, and a Chromium-family browser | `live_session`'s lifecycle and the live bridge against a real engine |
| `npm run e2e`, `npm run smoke:chain` | **the acceptance game present in `RMMZ_PROJECT`** | the whole registry against the real tool list, and the MCP command your client actually recorded. On a project that has never held the game both say so and exit 0 — `skipped: needs the acceptance game`, or `n/a …` — rather than failing obscurely |
| `npm run build:game`, `npm run play:game`, `npm run build:star-relay`, `npm run play:star-relay` | a project you do not mind painting | the two acceptance games, authored through the high-level layer and then played in a headless runtime. `build:star-relay` writes the game; `census` and `verify:newdata` are how you check them without touching your own project |
| `npm run verify:full` | all of the above | fifteen suites in one order, one exit code, about twenty minutes |

To put the acceptance game into a project: `npm run selftest -- "$RMMZ_PROJECT" && npm run build:game && npm run build:star-relay`,
in that order (the first lays down the map `e2e` reads, the second the lamp game `play:game` plays).

## Tools

**Reading** — `project_info`, `list_maps`, `get_map` (with per-layer grid dumps),
`inspect_cell`, `tileset_slots`, `find_events` (search by name, command code or
graphic), `map_connectivity` (flood fill: what is actually reachable from a cell,
which events you can stand on or only touch from next door, and where the transfers
on the reachable cells lead — it walks the maps they land on too, and reports a portal
that drops the player on an impassable tile),
`read_database`, `decode_commands`, `command_catalog`, `block_structure`,
`check_assets` (every image and audio name the data mentions, resolved against the
files on disk).

**Writing** — `create_map`, `set_tiles` (cells or rectangle fills, and **omit `layer`** to
have each tile id placed on the layer its own tile family belongs to, because MZ draws
A1/A2 ground on 1, A3 on 2, A4 upper walls on 3 and everything plain on 0. Painting A2
ground on 0 buries the trees painted before it, and passage is read from *every* layer at
once, so a wall left under the floor still stops the player in a room that looks open — say
`layer` only to override), `set_map_properties` (the map's own
settings: display name, tileset, battlebacks, parallax, its BGM/BGS, dashing and the
encounter table that decides which troops the region cells roll — rows are MZ's
`{regionSet, troopId, weight}`; `regionId` is taken as a one-region shorthand and
`appearances` as MV's name for `weight`, because a row without `regionSet` throws
inside `Scene_Map.updateScene` on its first roll and a row without `weight` sums to
NaN and never rolls at all), `place_event`,
`copy_event` (whole event, another cell or another map), `remove_event`,
`set_event_page` (graphic, trigger, priority, page conditions), `add_commands`,
`set_commands`, `show_text` (a dialog in the shape MZ actually stores: command `101`
plus one `401` per line, so a line can never arrive as `null` in
`$gameMessage._texts`), `patch_database_entry`, `create_database_entry` (claim the next blank
slot, exactly as the editor's add button does; MZ rows are 1-based arrays whose `id`
is their index, and no row is ever deleted, only blanked), `import_asset` (put an
image, audio or movie file in the folder the engine reads, with the checks that make
a hand-placed file work).

`set_event_page` writes only the keys it is given, and the page `place_event` creates
starts at the editor defaults — `priorityType: 1`, same as tiles, which is a wall to
the player. A Player-Touch door you mean to walk onto has to say `priorityType: 0`.

`set_commands` and `add_commands` read the list the way `Game_Interpreter` does, by
indent, and come back with `warnings` when the shape will not do what the caller
meant: a Conditional Branch or Loop with nothing indented under it runs those commands
outside the block (an empty Loop repeats forever), and a 412 or 413 with no opener at
its own indent changes nothing. The engine never complains about either, and the game
just behaves strangely three maps later.

Patching `System` is where an agent's RPG Maker MV habits hurt most, so two things are
checked there: `switches` and `variables` may arrive as an array of names or as an
object keyed by id, and the array is always what gets written (MZ reads
`$dataSystem.switches.length` before it will store a switch, so an object there is a
game that remembers nothing, with no error to tell you); and a key that MZ's
`System.json` does not have is reported — the starting party is `partyMembers`, not
MV's `startActors`.

**Plugins** — `list_plugins` (load order, switches, stored parameters, cross-checked
against the `@param` blocks in each plugin's own source), `patch_plugin`,
`read_plugin_source`, `write_plugin_source` (author the file and enable it in one
call; MZ has no compile step, so the next game start runs it).

**Seeing** — `render_map` returns a PNG plus composite statistics. Overlays:
`passage` (which edges block movement), `region`, `terrain`. It can freeze the A1
water animation frame, hide events, or draw only selected tile layers. That is the
*data* view; `live_screenshot` is the *player* view — the frame a running game
actually drew, windows and fonts included.

**Safety** — every write copies the previous file to
`<project>/.rpgmaker-mcp/backups/` (20 most recent per file, atomic replace).
`write_history` lists what this server process has written, and reports the journal
`index` it is at; `undo_writes` steps back through it across files — the closest thing
to `Ctrl+Z` available here, either `steps` at a time or straight back to a recorded
`since` index — and it will delete a file a write created. `list_backups` and `rollback_data` address the
same backups by number when you want to land somewhere specific. Backups and restores
are byte-exact for binaries too, so `undo_writes` takes an `import_asset` overwrite
back to the file that was there — or deletes the one it created.
`batch` runs a list of `{tool, args}` calls as one transaction: each step's
arguments are checked against the schema that tool declares, and if any step fails
every file the batch wrote goes back to the bytes it had. A build that dies on step
four leaves nothing behind.

**Live** — `live_status`, `live_eval`, `live_wait`, `live_key`, `live_move`, `live_reload`,
`live_screenshot`, `live_diagnostics`, `live_pause`, `live_step` run a real playtest:
`live_session` starts a headless browser on the project's own files, and the rest drive
the game through the bundled plugin — so the agent can watch real state instead of
inferring it from files, press keys, take the frame the engine drew, and `assert_in_game`
against live variables, switches and the player's own tile.

### High-level authoring tools

The 49 tools above are the primitives; an agent that lays out a game with them alone is
writing assembly. These sixteen compose them server-side — one intent, one call, one
transaction — and each *answers with the picture it made*: the `render_map` PNG of every
map it touched (plus the running game's own frame through `live_screenshot` when a
playtest is up) and a short structured diff of what changed. If any part of a call fails,
every file it wrote goes back to the bytes it had, so a bad argument never leaves a
half-built map behind. They are additive: nothing above was taken away, and `batch` can
call these too.

| Tool | One call does |
| --- | --- |
| `make_npc` | Places a character: graphic, movement or a `patrol` route, its lines, and a second page that takes over once a switch is set. Defaults to `priorityType: 1` (a person blocks their cell) and to replacing an event of the same name, so a build script can be run twice. |
| `make_choice_scene` | Writes an event page from a step list — `choice` branches with per-option gates, `if`, `loop`, `battle` with win/escape/lose, `shop`, transfers, audio, `gameOver` — and produces the indents and branch markers (`402`/`403`, `411`/`412`, `413`, `601`–`603`) the engine reads. Only a page the player or an event can *touch* has to stand on passable ground: an `autorun` (trigger 3) page may sit on a wall or at `0,0`, which is where a map-wide intro usually goes. An autorun that sets no switch, no self switch and does not erase itself is warned about, because `Game_Event.checkEventTriggerAuto` re-arms it every frame and the map then belongs to it. |
| `make_chest` | A chest that pays out gold or items once: the closed graphic, the line, the payout, and the opened page conditioned on self switch A. `requires` gates the payout with a branch, so a locked chest stays openable after the key arrives. |
| `link_maps` | Both ends of a connection, each door transferring the player to the open cell *beside* the other doorway and facing away from it — arriving on the threshold means stepping off it before it can be used again. `land` names the arrival cell, a door walled in on all four sides falls back onto its own threshold and warns, and it refuses up front if a door cell or the chosen arrival cell cannot be stood on. |
| `make_shop` | A shopkeeper whose goods become MZ's real shape: command `302` carrying the first good plus one `605` line each, `[kind, id, priceType, price, purchaseOnly]`. Rows that do not exist or are blank are refused; a good that would be free is called out. |
| `make_encounter_zone` | Paints a region on layer 5, creates the troops from `enemies`, and attaches rows with the `regionSet` and `weight` fields `Scene_Map` reads — then reports any row whose region no cell carries. |
| `clear_events` | Takes every event off a map in one transaction, or only the ones whose `name`, `characterName` or `eventId` you name — the call that makes a rebuild script safe. Without it, re-authoring a map's cast means one `remove_event` per event and a half-cleared map if the script dies halfway; with it, running the build twice leaves one of each NPC. `dryRun` answers with what would go. |
| `set_startup` | The opening state in one call: game title, start map/cell/facing, the starting party, and the switch and variable name tables. `patch_database_entry` can do all of it but has to be handed `advanced` whole to touch one key of it, which is how a build script quietly drops the keys it did not send — `patch_database_entry` now answers with `droppedKeys` naming exactly what a partial nested patch lost, and `set_startup` keeps the whole object in one place instead. The start cell is read back through the engine's own passability rules and refused if the player would open inside a wall. |
| `set_tileset_flags` | Makes a tile a wall, a ladder, a bush, a counter, a damage floor, or gives it a terrain tag, by editing the tileset's 8192-entry `flags` array. Passage is per direction, so a one-way ledge is expressible. For an A1–A4 autotile the change is applied across its whole 48-shape group, because that is what a map stores. `dryRun` shows before and after. |
| `make_map` | Makes (or reuses by name) a map and lays its whole ground in one call: the size and tileset, a `fill`, paint rectangles and cell lists resolved to **one tile per cell with the last stroke winning**, each tile sent to the layer its own A-slot belongs to, the passage flags for the tiles used, region ids on layer 5, and the map's own properties. Resolving the plan instead of stacking it is the engine's rule, not a preference: `Game_Map.checkPassage` reads layers 3→0, so a wall left under a floor still blocks the doorway. The reply counts the walkable cells the finished terrain leaves, because a map with none is a game that boots and never moves. |
| `describe_tiles` | The tile dictionary: for an id, which slot it is (A1–A4 shape groups, A5/B–E fixed), which sheet the tileset binds that slot, which layer it draws on, and what the flags mean in words — blocked from which directions, whether 0x10 makes those bits do nothing, ladder, bush, counter, damage, vehicles, terrain tag — plus how many cells of a map use it. Ask by `mapId`, by `tiles`, by `slot`, or for the whole tileset. `contactSheet` draws a labelled picture, one block per id with its id and passability printed under it, which is how "which id is the water" gets answered without opening a PNG. |
| `make_item` | An Items, Weapons or Armors row with its effects spelled in words. The two shapes are compiled for you — an item **effect** is `{code, dataId, value1, value2}` (11 recovers HP as `mhp×value1+value2`, 21/22 add and remove a state, 31–34 buffs and debuffs, 44 a common event) while a **trait** on the same row is `{code, dataId, value}` — and writing the second shape into the first is how a heal silently becomes `NaN` HP. States, parameters, common events and the equipment type ids (`wtypeId`, `atypeId`, `etypeId`) are resolved against the project and refused when absent. `itypeId` is different, and the difference is MZ's: there is **no item-type name list** (that was MV's `System.itemTypes`), the menu shows a row when `itypeId` is 1 (the Item tab) or 2 (the Key Item tab) and nothing else, and `System.itemCategories` decides whether those tabs are open — so a number outside 1–2 is warned about rather than looked up, because that item would be unfindable. |
| `make_battle` | The foe and the group that holds it, in one call: parameters, exp, gold, battler, actions (each `skillId` checked against Skills, because a missing one throws the turn the enemy acts), element rates and state resists as traits, and drops in the engine's own `{kind, dataId, denominator}` shape — one in three, not thirty per cent, and only three slots. `troop.count` duplicates the foe using positions from a troop the project already has, and `zone` puts the group in a region. |
| `live_dialog` | Reads what a running game is waiting for and answers it: the message text, the choice options with each one's enabled state and cursor position, the number pad's digits. `answer` picks an option by index or types a number; `dismiss` and `cancel` press on until the game is quiet. It exists because `$gameMessage.isChoice()` is true while `Window_ChoiceList` is still fading in and `Window_Selectable.isCursorMovable()` drops a cursor key sent in those frames — so a raw press answers the *first* option whatever you meant. It waits, presses one edge at a time, re-reads the index after every press, and refuses an option the game has switched off. |
| `fix_project` | Makes a project that did not come from the editor bootable: writes the `System.json` keys the engine reads without a fallback and this project does not have, taking the values out of **your own installation's** `data/newdata` template (they belong to the engine, so this package carries no copy of them), and puts `switches`/`variables` back into the array shape the engine indexes. The template itself has no `advanced.windowOpacity`, which is the key whose absence stops a copied project on its title screen, and 192 is what the editor writes. It writes only what is genuinely missing, so running it on a project the editor made changes nothing, and `dryRun` answers with the plan alone. |
| `validate_game` | Read-only audit before a playtest: start position and party, switch and variable tables and every id past their end, transfer destinations against the destination map's size and passability, every database id a command reads, encounter rows, missing image and audio, tiles painted from a slot the tileset has no sheet for, indent shapes that will not run, autorun pages that never let go of the map, the `System.json` fields the engine reads unconditionally (a template with no `System.advanced.windowOpacity` dies on the title screen at frame 3), and reachability from the start through the portals. Each problem comes back as `{severity, where, what, fix}` with `fix` naming the call that clears it. |

### What the high-level layer covers

The claim being tested is that an agent can build a whole game without dropping to the
primitives, so the coverage is a table rather than a hope. Each row is what a game needs,
the call that owns it, and the primitive an agent would otherwise have to place itself.

| A game needs | High-level call | Below the layer |
| --- | --- | --- |
| ground to walk on | `make_map` (size, tiles, passage flags, regions) | nothing |
| to know which tile id is which | `describe_tiles` (+ labelled contact sheet) | nothing |
| doors between maps | `link_maps` | nothing |
| people who talk, with pages | `make_npc` | nothing |
| a beat with choices, branches, loops | `make_choice_scene` | nothing |
| loot that pays out once | `make_chest` | nothing |
| a shop | `make_shop` + `make_item` | nothing |
| random battles | `make_encounter_zone` | nothing |
| a foe, a group, its drops and its spells | `make_battle` (+ `make_item` with `table: "Skills"` for the spell the action names) | nothing |
| items, weapons, armour | `make_item` | nothing |
| the opening state and name tables | `set_startup` | nothing |
| a project copied from the engine's template, that boots | `fix_project` | nothing |
| a plugin on, and its settings | `enable_plugin`, `patch_plugin`, `write_plugin_source` | reading a source: `read_plugin_source` |
| assets the data names | `import_asset` | `check_assets` (audit) |
| "is the game sound before playing it" | `validate_game` | `map_connectivity`, `inspect_cell` (targeted reads) |
| to drive and watch the running game | `live_session`, `live_move`, `live_dialog`, `assert_in_game` | `live_key`, `live_eval`, `live_screenshot` (the raw ends) |
| to take the edits back | `undo_writes`, `rollback_data` | `write_history`, `list_backups` |
| actors, classes, states, common events, the tileset rows themselves | — | `create_database_entry`, `patch_database_entry`, `read_database`. Deliberate: these are table rows with no cross-file shape to get wrong, which is what this layer is for. |
| resizing a map in place | — | refused everywhere. A map's tile array length *is* its size; `make_map` says so and `delete_map` + a new `make_map` is the way. |

The acceptance game is what keeps this honest: `node scripts/build-star-relay.mjs build`
writes every record of `samples/star-relay/escape-hatches.json`, so the number of writes
the layer could not make is a measured number, not a claim.

The step vocabulary (`say`, `choice`, `if`, `switch`, `gold`, `transfer`, `battle`,
`moveRoute`, …) is documented in each tool's own `script` parameter, and a step name that
does not exist answers with the list. Two of them are escape hatches on purpose —
`script` (engine code, stored as command 355) and `raw` (verbatim commands): a build that
uses either gets its call answered with `escapeHatches` naming where, so what the layer
does not cover yet is visible instead of buried.

What the high-level layer does *not* pretend to be: it cannot show you a modal the editor
would pop (there is no editor automation — MZ's Qt/QML UI has no debug endpoint), and it
will not invent an MZ feature that is not there. A shop has no after-purchase branch in
MZ, so `make_shop` says the commands after the goods run when the window closes; a page
condition can only test a switch that is ON, so `when: {switch: 4, value: false}` is
refused with the `if` step that does the same job.

## Live playtest bridge

`plugin/RMMZLiveBridge.js` is an MZ plugin that polls the MCP server while the
game runs, so the agent can watch real state instead of inferring it from files:

1. Put `plugin/RMMZLiveBridge.js` in `<project>/js/plugins/` — a `cp` is enough — and register
   it. The editor's plugin manager does that, and so does the server, which is what the headless
   path needs: `enable_plugin {"file": "RMMZLiveBridge", "parameters": {"Token": "<your token>"}}`
   writes the registration line and the parameters into `js/plugins.js` without opening the
   editor, and `verify:newdata` installs it into a fresh project copy that way on every run.
2. Set `RMMZ_LIVE_TOKEN` for the server and put the same value in the plugin's
   **Token** parameter. The port needs nothing but the default: `live_session`
   launches the page with `?rmmzBridgePort=`, which the plugin reads before its own
   parameter, so a playtest never edits the project to move a port. `?rmmzBridgeHost=`
   works the same way; nothing else can be set from the URL, and Allow Eval
   deliberately stays a project setting.
3. Start a playtest. `live_status` now reports scene, map, player position,
   switches, variables and party.
4. `live_wait '$gamePlayer.x >= 12'` follows the game until a condition holds,
   `live_key` presses a key, and `live_eval` runs an expression in game scope.
   To get *past* a dialog rather than poke at it, use `live_dialog`: it reads what
   the game is showing (the lines, the choice options with their enabled state, the
   number pad), waits until the window can take a key, and then picks an option by
   index, types a number, or presses on until the game is quiet.
5. `live_reload` closes the author-then-look loop: after `set_tiles` or
   `set_event_page` have written the map, it makes the running game re-read that
   map file and rebuild itself around it — tiles, autotiles, events and map size —
   with the player left where they stand and game state (switches, variables, the
   party, self switches) intact. Event interpreters restart from the top, and the
   database tables are not re-read, so `System.json`/actor/item edits still need a
   new game. It answers once the reloaded map is actually in — `Scene_Map.create()`
   nulls `$dataMap` and re-reads the file asynchronously, so a tool that returned
   earlier would leave the next `live_eval` reading `null`. A paused game never
   finishes that scene change, because the change happens inside the update loop.
6. `live_screenshot` returns the frame the game just drew — message windows, face
   graphics, fonts, weather, sprites — as a PNG. It re-runs `Graphics._app.render()`
   and reads the canvas inside the same task, because MZ leaves
   `preserveDrawingBuffer` off and a `toDataURL()` after the browser has composited
   gives a blank image. PIXI's own `renderer.extract` is deliberately not used: it
   sizes its readback from the stage bounds, and MZ's stage carries the screen
   scale, which asks for a gigapixel buffer and throws.
7. `live_diagnostics` returns what the running game logged: uncaught errors with
   their file and line, the text of the engine's own error screen, failed image and
   audio loads, and `console.warn`/`console.error` output. The plugin keeps a
   rolling 200-entry buffer and merges repeats, so an error thrown every frame
   arrives once with a `repeat` count. Read the `cursor` it hands back to fetch
   only what is new, or pass `clear` before an edit so anything that appears
   afterwards came from it, or `full` to get the recorded call stack with the entry it
   belongs to (left out otherwise, because most reads only want the one line).
8. `live_pause` freezes `SceneManager.updateMain` without leaving the scene, and
   `live_step` runs it a chosen number of times. Together they answer "what does
   frame 40 of this animation look like" without a stopwatch: the last frame stays
   on the canvas, so `live_screenshot` and `live_eval` keep working while the world
   is stopped. Keys are sampled inside the update loop, so a `live_key` sent while
   paused is dropped.
9. `live_session` removes the last manual step. `{"action":"start"}` serves the
   project from the server process on a loopback port, launches a windowless
   Chromium-family browser on it, waits for the plugin to report and then walks the
   title screen into a new game by calling the engine's own `commandNewGame`.
   `{"action":"status"}`, `{"action":"boot"}`, `{"action":"reload"}` and
   `{"action":"stop"}` cover the rest: `reload` is what a file written by
   `write_plugin_source` needs, and `boot` is the second call for a client that only
   allows sixty seconds per tool call — a cold browser can need more than that to
   reach the title screen. `stop` kills the process tree it launched, after
   confirming the recorded profile directory is still on that pid's command line, so
   a recycled pid is never touched; the record lives in
   `<package>/.rpgmaker-mcp/session.json` and survives a server restart, which is
   how a session left by a previous process is found and cleaned up.

The plugin also reports `focused`, which is `SceneManager.isGameActive()`. That is
how `live_session` can say "the game is sitting still because nothing has focus"
instead of timing out silently.

The plugin polls from its own `setInterval` rather than from a scene update hook,
which matters in two situations. `SceneManager.onError` calls `stop()`, and
`Graphics.stopGameLoop()` cancels the animation frame loop the game runs on — a
bridge riding that loop goes quiet at exactly the moment the game has crashed,
which is the only moment the log is wanted from it. And `Game_Map.width()` reads
the global `$dataMap`, so state is reported from the title screen and every other
scene with the map fields simply absent. `live_status`'s `stopped` field reports
which of the two you are looking at.

`live_key` holds each press for a counted number of **input polls** (`pulses`, default
1, `holdFrames` default 2) and answers only after the last one has been released — and it
puts the button back down when the hold ends. Both halves are load-bearing:
`Input.isTriggered` is true only on the frame that first samples a press, so a press timed
in milliseconds can fall between two polls and never exist; and `Input._currentState` is
only ever written by a real keydown/keyup, so a bridge that stops asserting a button
without writing `false` leaves it down forever on a page nobody types into — the player
walks off on their own, and the next press in the other direction cancels it
(`Input._signX() = right - left`). Measured on a real playtest at 60fps: 10 of 10 direction
presses moved the player exactly one cell with the default 2-poll hold, and no arrow was
left down afterwards. A background-throttled tab does drop to about 9fps, which is exactly
why the hold is counted in polls rather than in milliseconds. If the game is not advancing
frames at all (paused, hidden, or stopped by an error) the press says so instead of
returning quietly.

`live_move` is that same key held for a whole walk: `live_move({direction: 6, cells: 5})`
holds Right and answers with the cells the player actually gained, where they started,
where they ended and *why* it stopped — the cell ahead will not let the player through, a
dialog is on screen, the scene changed. Reach for it instead of `live_key` when the thing
being proved is a walk, because only the walked path runs `updateNonmoving`, which is what
counts the party's steps, walks the encounter counter down and fires the player-touch event
triggers. Moving the character with `moveStraight` through `live_eval` moves the sprite and
none of that happens.

`live_eval` accepts a promise: an expression that returns one is waited for, up to
twenty seconds, and the settled value comes back. That is how a caller watches a
transfer, a scene change or a frame counter from a single call rather than polling
`live_wait` for it.

To drive a playtest that nobody is looking at, enable the plugin's **Keep running
without focus** parameter: MZ pauses the loop when the window loses focus
(`SceneManager.isGameActive()`), which freezes an automated session. Leave it off
for normal playtests.

**Security.** The bridge listens on `127.0.0.1` only, and commands are delivered
exclusively to a client presenting the shared token. Running code inside the game
requires *both* the token and the plugin's **Allow Eval** parameter, which
defaults to `false`. `live_reload`, `live_screenshot`, `live_diagnostics`, `live_pause`, `live_step`,
`live_key` and `live_move` are the exception: each one calls a known engine
method or writes one known button to `Input`, so the token gates them and Allow Eval does not.
State reporting works without a token, so `live_status` is
safe to leave enabled while `live_eval` refuses until you configure one. Never
enable Allow Eval in a build you ship to players. `live_session` is the one tool that
starts a process: a windowless browser, audio muted, pointed at a loopback url, in its
own profile directory under `.rpgmaker-mcp/`. `stop` kills that recorded pid's tree
only after confirming the profile directory is still on its command line, so a pid the
operating system has handed to something else is never touched.

## Map data model

`data/MapNNN.json` stores `width * height * 6` integers. The layer index is the
outermost dimension: `data[(layer * height + y) * width + x]`.

| Layer | Contents |
| --- | --- |
| 0-3 | Tile layers, composited in this order |
| 4 | Shadow bits, `0x01`-`0x0F` per quadrant — never a tile id |
| 5 | Region id |

Tile ids are segmented, not sequential per image: `0` empty, `1-255` B,
`256-511` C, `512-767` D, `768-1023` E, `1536-2047` A5, `2048+` the autotile
ranges A1-A4. Whether a tile is passable, a counter, a bush, or draws above the
player comes from `Tilesets[].flags[tileId]`, where `0x10` means "no effect on
passage" and the terrain tag is `flags >> 12`.

## Event command structure

`map.events` is indexed **by event id**: slot `0` is always `null`, deleted
events leave a `null` hole, and the runtime looks an event up as
`$dataMap.events[event.id]`. Packing the array densely therefore crashes the map
on the frame it is entered (`Game_Event.initialize`: *Cannot read properties of
null (reading 'x')*), which is why `place_event` / `remove_event` and every map
write re-align the array instead of pushing onto it.

Blocks are indent-based: `skipBranch()` walks past every command deeper than the
current one, so Conditional Branch (`111`) and Show Choices (`102`) have **no**
closing command. Only `Loop` is explicitly paired (`112` opens, `413` closes, and
`113` Break Loop counts those pairs). A few codes repeat at the same indent as
their opener and have no interpreter handler at all, which is why their payload
lives in separate commands: `101`→`401` (text lines), `105`→`405`, `108`→`408`,
`355`→`655`. Ask `block_structure` and `command_catalog` instead of relying on
memory.

## Known limitations

- **The editor keeps the project in memory.** If RPG Maker MZ has the project
  open while this server writes `data/*.json`, the editor's next save overwrites
  those changes. Close the editor or reload the project after writing; every
  write result repeats this warning. The editor exposes no API to write through
  (it is a Qt/QML application with no scripting surface — see
  `src/bridge/FINDINGS.md`), so this is a workflow rule rather than something the
  server can enforce. The **running game** is not subject to it: `live_reload`
  makes a playtest re-read the map you just edited, so the edit → look → edit loop
  happens without leaving the game or touching the editor.
- **Undo is a journal of writes, not the editor's undo stack.** `undo_writes`
  restores the backups this server made, newest first, across files — but it cannot
  reach what you did by hand in the editor, it forgets the order when the server
  process restarts (the backup files stay, and `list_backups` still sees them), and
  one *tool call* can be several writes: `create_map` adds a map file and a
  `MapInfos` entry, so undoing that operation is two steps and undoing one of them
  leaves a dangling tree entry. Read `write_history` before stepping back more than
  once.
- **A rollback rolls back files, not the game.** `batch` and `undo_writes` put
  `data/*.json` and `js/plugins.js` back byte for byte, but a step that reached the
  running game is not undone by it: a key press, a `live_reload` that pulled in a
  tile the batch then threw away, or a plugin file the page has already loaded all
  stay as they were. Those steps are named in the reply, and `live_reload` (or a new
  game, for database and plugin edits) is what brings the game back in line with the
  files.
- **`live_session` runs one browser per server process**, because two games polling
  one bridge cannot be told apart from the server side. It needs a Chromium-family
  browser on the machine (`RMMZ_BROWSER` if it is somewhere unusual), and a cold boot
  can take longer than a client's sixty-second call timeout, which is why `start`
  accepts `newGame: false` and `boot` finishes the walk. If the server process is
  killed hard the browser survives headless and harmless until `live_session
  {"action":"stop"}` reads the record in `session.json` and clears it.
- **The engine asks for `.png` and nothing else** in every `img/` folder:
  `ImageManager.loadBitmap` builds `folder + name + ".png"` (v1.8.0's
  `rmmz_managers.js:919`), so a `.jpg` dropped into `img/pictures/` is a file no game will
  ever show. `import_asset` refuses it, `check_assets` calls a reference satisfied only by
  another format `not-png`, and `validate_game` checks the names Show Picture commands use.
  Animations are the exception because they are not bitmaps: MZ plays `Animations[].effectName`
  from `effects/<name>.efkefc` (`EffectManager.makeUrl`), which is where the audit looks
  rather than at the MV-era `img/animations/` a copied project still carries.
- Rendering reproduces the runtime `Tilemap` compositing, including the parallax
  underlay, the 50% black shadow quads and the higher-tile (`0x10`) z-order. It
  does not draw battlebacks or character shadow/semi-transparency effects, and
  event graphics only appear when the project actually has those images.
- The parallax is drawn as the engine does — a tiling sprite from `parallaxSx/Sy` —
  but a whole-map preview has no camera, so the map origin stands in for the scroll
  offset. Verified against the editor's own previews: where the picture under that
  name is the same, tiling from the origin matches (see `fidelity:sweep`).
- `map_connectivity` asks whether *any* page of an event is same-as-tiles, which is
  the engine's blocking rule (`isNormalPriority`), but it cannot evaluate page
  conditions, so a chest that only stands there until it is opened counts as a wall
  forever. Transfers are followed from the pages that hold them, whichever page they
  sit on, so a portal you have not unlocked yet still maps its destination.
- A misspelled or unsupported argument name is dropped before the handler runs
  (MCP parses tool input as an object of the declared keys), so `command_catalog`
  with `{ code: 125 }` silently returns the whole dictionary instead of complaining
  about `codes`. Read the tool's schema when a filter appears to do nothing.
- The command dictionary is generated from the engine, so parameter *names* come
  from local variable names in the engine source. Semantics of individual enum
  values (e.g. `priorityType: 2`) are documented in tool descriptions, not in the
  dictionary. Ask `command_catalog` for exact `codes` to get the engine body next
  to the names: `operateValueArg1` alone does not say whether the amount is
  `params[1]` or `params[2]`, and the body does.

- `data/newdata`, the template a new project is scaffolded from, is not always complete
  for the engine that ships it: measured on an untouched MZ 1.8.1 `newdata`, the file has
  no `System.advanced.windowOpacity`, which `Window_Base.updateBackOpacity` calls `.clamp`
  on, so a project built from it dies on the title screen at frame 3 with
  `TypeError: Cannot read properties of undefined (reading 'clamp')` and never reaches a
  map. `validate_game` reports it as an error naming the path and the call that fixes it,
  and `npm run verify:newdata` proves both halves on a throwaway copy of the real template:
  unpatched it stops drawing frames on the title screen, patched it boots to `Scene_Map`.
  The same run installs the bridge plugin with `enable_plugin`, which is the other thing a
  fresh template does not have. `node scripts/check-system-fields.mjs <project>
  "<install>/data/corescript"` lists the fields the engine reads that the file does not
  have.
- The **editor process cannot be driven directly**. It is a native Qt/QML
  application whose JS side is Qt's JavaScriptCore, which has no Chrome DevTools
  Protocol at all; `src/bridge/FINDINGS.md` records the evidence. Observing and
  controlling a *running game* is what the live bridge is for, and writing files is
  what the rest of the server is for.

## Development

```bash
npm run build
npm run selftest -- ../MyGame        # writes a map exercising autotiles/shadows/regions/events, renders 4 PNGs
npm run fix-project                  # write the System keys the engine reads without a fallback (-- --check reports only)
npm run e2e                          # every tool in the registry, against the project your env names
npm run e2e -- ../MyGame "<install>/data/corescript"   # or say the two paths out loud
npm run e2e:live                     # simulates a running game against the live bridge
npm run roundtrip -- ../MyGame/data  # re-serializes editor-written files byte for byte
npm run fidelity:sweep -- "<install>/data/samplemaps" ../MyGame
node scripts/verify-live.mjs         # against a real MZ runtime in a browser
node scripts/build-tiny-game.mjs build   # author a two-map game with the tools
node scripts/serve-project.mjs ../MyGame 8080   # just the http side, see below
VERIFY_SCRIPT=scripts/playtest-tiny-game.mjs bash scripts/live-session.sh  # then play it
npm run session:e2e                  # live_session + batch against a real headless browser
npm run build:star-relay             # author the acceptance game through the high-level tools only
npm run play:star-relay              # play it start to finish in a headless browser, beat by beat
npm run census                       # build that same game into a copy of the shipped template and print its high-level/escape-hatch census (-- --play to play it there too)
npm run smoke:chain                  # drive the command an MCP client actually spawned, then undo it
npm run verify:package               # npm pack, unpack, and check *that* tree: allow-list, no local paths, registry identical
npm run verify:full                  # every suite above, in one order, one exit code
```

`verify-live.mjs` serves the project over http, boots it in a browser attached to a
CDP endpoint (`scripts/live-session.sh` wraps the whole sequence), and then checks
both layers at once: what the engine reports through the bridge versus what the
server reads from the files — map id, player tile, the tile id under the player
against `inspect_cell`, and a `show_text` dialog authored through the tools being
loaded by the real engine into `$gameMessage._texts`.

That suite owns both ports, so it cannot be used to exercise an MCP server that is
already running somewhere else (an editor's registered server, a second terminal).
For that, run `scripts/serve-project.mjs` alone, point a browser at the url it
prints, and drive the live tools through the registered server instead.

`npm run session:e2e` (`scripts/session-tool.mjs`) is the suite for that path: it
moves the bridge plugin's port to 3791 for the run, starts a session through the
`live_session` tool, takes a frame, paints a block with `batch` and then fails a
batch on purpose to check that the block went back under a running game, reloads the
page, stops the browser, and restores `js/plugins.js`. The suites therefore keep to
their own ports so they can never be fighting over one: 3789 for a registered server (and
for `scripts/live-session.sh`, which is why it cannot run next to one), 3791 with game port
8091 for `live_session`, 3792/8092 for the lamp game, 3793 for `e2e:live`, 3794/8094 for
Star Relay, 3795/8095 for the session-lifecycle probe, 3797/8097 for `verify:input`,
3798/8098 for `verify:newdata` and 3800/8100 for `census`. `verify:full` runs them one after
another and prints the port each one owns. Run them one at a time by hand: a second server on
a port another process still owns refuses to bind and says so, which is right, but every call
after it repeats that refusal and the run reads as thirteen failures that are one.

`scripts/build-tiny-game.mjs` is the authoring end-to-end demo: `harvest` reads
which tile ids the project's own maps actually use, `build` paints two maps, wires
portals, an NPC, chests and the start position through the MCP tools, and `render`
writes `samples/tiny-village.png` / `tiny-cave.png`. It borrows house and prop
tiles from another map on the same tileset rather than inventing ids, so it needs
one map of at least 20x15 in the project that is not one of its own two.
`scripts/playtest-tiny-game.mjs` then plays that game in a real MZ runtime: start
position, file-vs-engine tile agreement, the NPC's dialog, a portal transfer to the
authored coordinates, and a chest that pays out, sets its self switch and swaps to
its opened page.

`scripts/build-star-relay.mjs` (`npm run build:star-relay`) is the acceptance game for
the high-level layer: a keeper's house, a village and a cave joined by doors, a two-page
NPC, a shop, three chests, a region-painted encounter zone, an altar choice that runs a
real battle and branches on what you are carrying, and an ending that plays itself out to
the title screen. Every piece of content is authored with the high-level tools and nothing
else. What the layer could not author is written to `escape-hatches.json` with the reason each
low-level call was still needed, so the gaps are a list rather than a rumour, and
**`npm run census` prints that list and fails if it ever contains a write** — it builds the game
into a throwaway copy of the engine's own `data/newdata`, needing no map, item or enemy from any
other project. Measured on the current build: **28 high-level calls and 0 writes below them** in the
author's project, **25 and 0** in the template copy (the difference is the calls that only happen
when a map already exists to be cleared), with 3 reads either way — the switch table, the variable
table and a troop lookup. It was 19 calls with six
writes under them before `make_map` and `make_battle`/`make_item` existed: three
`create_map` and three `set_tiles`, plus two `create_database_entry` the dirty project was
hiding because the lamp game had made those rows already. Re-runnable: maps, events, items,
foes and troops are found by name, `clear_events` takes the cast off before it is rebuilt,
and running it twice leaves one of each, not two.

`scripts/verify-star-relay.mjs` (`npm run play:star-relay`) plays that game in a headless
MZ runtime started through `live_session` on its own port, beat by beat, using the engine's
own `canPass` to walk it. It checks the things a file diff cannot: that a locked door holds
the player and says why, that a transfer leaves them *beside* the far door facing away, that
the chest's gold and the shop's price arrive in the party, that the painted region really
rolls an encounter, and that an autorun lets go of the map instead of re-arming every frame.
Frames go to `samples/star-relay/play/`.

`npm run smoke:chain` answers a question the in-process suites cannot: it spawns the
command, arguments and environment your MCP client has actually recorded in its settings
file and drives that process — registry, read surface, a scratch map written and then taken
back through `undo_writes`, with a timing per call. Which is how a stale registry becomes
visible: a server process that has been alive since before the layer was rebuilt keeps
serving the tool list it read at startup, so an agent sees fewer tools than the same
command launched fresh. Reload the server (`/mcp reload` in Qoder) after `npm run build`.

`npm run verify:full` runs the lot in one order — build, then the file-layer suites, then the
two that need a running game (`verify:input` proves keys and walking in a room it builds and
deletes; `verify:newdata` boots a copy of the engine's own project template, before and after
the one `System` key it ships without), then the lamp game, then Star Relay built and played,
then the chain smoke — and exits non-zero if any of them did. Its header comment explains why
that order matters.

`e2e` drives the server through a real MCP client over an in-memory transport and
asserts on every tool group. `roundtrip` is the guard that keeps writes from
producing whole-file diffs: parse and re-serialize must reproduce the editor's
bytes exactly.
`fidelity:sweep` is the renderer's proof of correctness. An MZ installation ships
`data/samplemaps/` with a `.json` and an editor-generated `.png` for each sample
map, so the sweep renders every map and compares each cell's average colour with
the editor's own preview. Measured on a 1.8.1 install: **104 maps, median
difference 0.98 / 255 over the cells the compositor draws, p90 1.46, worst map
5.69, no map diverging and no missing-asset warnings**.

Cells with no tiles at all are counted separately, because they show only the
parallax and that layer is an asset question rather than a compositing one: the
preview of `Map077` matches tiling this install's `Forest.png` at 4.7 and its own
named `River.png` at 119.9, so the sample project kept a different picture under
that name. Four of the 35 maps with a parallax differ on such cells and the sweep
names them without failing the run.

## License

MIT. This project ships no RPG Maker assets, engine sources, or project files,
and is not affiliated with or endorsed by KADOKAWA Corporation.
