# Changelog

## 0.4.2 — the third acceptance round: the quick path, and anyone else's project

The reviewer rebuilt its game on 0.4.1, ran the suites serially from the tarball and closed all
seven of round two's findings (`D1`–`D7`) with its own scripts, then filed two things and one
missing command. Its verdict was **可以交付**; both findings are the same shape — *the path that
works is the path the author walks* — and both are closed. The registry is unchanged at **65**
(49 primitives, 16 high-level); this is a patch release about what the tools *say and do* on a
project that is not the author's.

Measured on this build: `npm run verify:full` is **15 of 15, VERIFY FULL PASS, exit 0** in 1166 s
with zero `FAIL` lines. `e2e` is **272 checks** (was 269: three new `itypeId` assertions, one that
no warning may interpolate an object, and the check that read the project folder's name as
`demo-project` is gone). `census` is **5 checks** reporting **25 high-level calls and 0 writes below
them** in a copy of the shipped template against **28** in the author's project — the three extra
calls are the `clear_events` a repaint needs and a first create does not — and `census -- --play`
takes that same copy through its title screen with **48 PASS / 0 FAIL**. `verify:newdata` **21**,
`verify:input` **40**, `e2e:live` **39**, `session:e2e` **39**, `play:game` **45**,
`play:star-relay` **48**, `smoke:chain` **34 calls**, `verify:package` **50 checks** on a tarball of
**56** files at **65** tools. A "check" is a printed `PASS` line, and `grep -c '^  PASS'` on the log
reproduces every number in these documents.

### Fixed — R1: every suite that boots a game now repairs the template key itself

`build:game`, `build-star-relay` and `verify:newdata` called `fix_project`, but `verify:input` —
the suite a reader is pointed at first, because it is the one that proves keys and walking — did
not. Following the fifteen-minute path with `RMMZ_PROJECT` set to a copy of `data/newdata`, which
the documentation explicitly permits, produced `6 PASS / 2 FAIL` and an output that blamed the
key bindings for a missing `System` key. The repair is now one shared step
(`scripts/ensure-bootable.mjs`) taken by every suite that starts a game — `verify:input`,
`play:game`, `play:star-relay`, `session:e2e` — and it prints what it wrote. `npm run fix-project`
is the same thing on its own, with `-- --check` to only report, and a non-zero exit when a key the
engine reads without a fallback is still missing afterwards.

The new command was itself tested by running it, which found a Windows-only defect in it: it
imported `dist/index.js` by absolute path, and Node reads `C:\…` as a URL scheme
(`ERR_UNSUPPORTED_ESM_URL_SCHEME`). It takes a `file://` URL now, and `-- --check` / repair /
re-repair were measured on a template copy: exit 1 naming the key, then `changed: true`, then
"wrote nothing" with exit 0.

### Fixed — R2: a suite that needs the acceptance game says so instead of crashing

`dist/e2e.js` on a foreign project failed two assertions and then threw
`TypeError: Cannot read properties of undefined (reading 'id')`, because it reads `MCP-SELFTEST`
by name; `smoke:chain` did the same on `SR Village`; `verify:package` judged the reader's own
project (`/^SR /` maps, a non-empty `gameTitle`). Each now gates: `e2e` prints
`skipped: needs the acceptance game`, names the three builders that would provide it and the three
suites that need nothing, and exits 0 having written nothing; `smoke:chain` keeps the parts that
are project-agnostic (the registered command, the tool list, the descriptions, `project_info`,
`list_maps`) and prints `n/a` for the rest; `verify:package` reads whichever map the project
actually has, and only asserts the game is sound when the acceptance game is the project being
checked. `e2e`'s first check also stopped comparing `projectDir` against the string
`demo-project` — it now asserts the server resolved the project **this run asked for**.

### Added — `npm run census`, so the high-level claim is a command rather than a sentence

`ACCEPTANCE.md` quoted "27 high-level calls and 0 writes below them", which could only be read by
running the acceptance game's builder against the author's project. The reviewer marked the claim
*not independently confirmed*, correctly. `npm run census` copies the engine's own template,
builds Star Relay into **that copy alone** and reads the census back, gated: any low-level write
the layer could not make fails the command. `-- --play` runs the real playtest inside the copy,
`-- --keep` leaves it on disk. It is the fifteenth suite in `verify:full` (port 3800/8100).

Getting that to pass found **three more ways the acceptance game depended on this machine**, all
fixed here:

1. Its cave chest handed out `Items[3]`, which is **the lamp game's** row — in a copy of the
   template, ids 2–5 are blank slots, and `make_chest` (rightly) refuses to fill a chest with a
   row that has no name. The game now makes its own `Relay Fuse` row with `make_item`.
2. Its encounter troop named `Enemies[6]`, which only existed because this project had grown a
   sixth row. The zone now rolls one member of `Enemies[3]`, a row the shipped template has, and
   the boss copies from `Enemies[1]` (`Goblin`) rather than `Enemies[7]`.
3. Its playtest counted item id `3` literally; it now resolves `Relay Fuse` and `Star Lantern` by
   name, the way the rest of the harness does.

### Fixed — `make_item`'s item type was validated against a key MZ does not have

`System.itemTypes` is RPG Maker MV's. MZ spells an item's type as a number and has no name list:
`Window_ItemList.includes` shows a row when `itypeId` is 1 (the Item tab) or 2 (the Key Item tab)
and accepts nothing else, while `$dataSystem.itemCategories` is the four-slot switch
`[item, weapon, armor, keyItem]` (`rmmz_windows.js:2133`–`2140`, v1.8.0). So every `make_item` call
on every MZ project printed `this System.json has no itemTypes list` — a warning that was true of
no project and false of all of them, and it is what the reviewer's own build log showed. The check
now says what the engine does: a name is refused with the explanation, a number outside 1–2 is
warned about as unreachable, and a tab the project switched off is named.

### Fixed — `make_battle`'s copy-source warning printed `[object Object]`

`create_database_entry` reports `basedOn` as a row `{id, name}`, and `make_battle` interpolated it
into a sentence and compared it to a number, so the warning both fired on every copy and was
illegible. It now fires only when the row actually copied is not the one the call asked for, and
names it: `the foe was based on Enemies 4 "Treant" rather than the row 1 this call asked to copy`.

### Fixed — `play:star-relay` asserted one RNG draw, and lost it

The region beat walked three fixed cells and required a battle. The engine re-rolls the distance to
the next encounter every time (`Game_Map.updateEncounterCount` is two `randomInt`s over the map's
encounter step), so the beat was a coin flip: the first 0.4.2 chain failed it with `battles: 0`
while the very next beat — walking to a different cell on the *same* map — was interrupted by two
battles. That is the suite being wrong, not the game. The beat now walks the region until a battle
arrives, within a budget of four passes (~90 steps) that only a region the data does not list can
miss, asserts the battle came from **this** beat rather than from any earlier one, and prints how
many passes and steps it took. The failure detail now carries the engine's own
`{steps, encounterCount, region, encounterRows}` the way `play:game` already did, so a future miss
says what the engine thought rather than just `battles: 0`.

## 0.4.1 — the fresh-project path, end to end


The second independent acceptance run confirmed the 0.4.0 fixes and reported seven new
findings, `D1`–`D7`. Every one is closed. They share one root, which the reviewer stated
better than I could: **every suite ran against a project the editor had made**, so the path
where a project is copied from the engine's own `data/newdata` — the one a stranger reaches
for first — was untested from end to end, and the scripts on it silently wrote somewhere
else. The registry is **64 → 65** (49 primitives, 16 high-level).

Measured on this build: `npm run verify:full` is **14 of 14, VERIFY FULL PASS, exit 0** in
1185 s with zero `FAIL` lines; `npm run e2e` is **269 checks** against a registry snapshot of
**65** names; `verify:newdata` is **21 checks** and 485 s of that chain, because it now builds
the lamp game into its throwaway template copy and plays it to the credits (**45 PASS / 0
FAIL** inside it) before deleting the copy; `verify:package` is **46 checks** on the unpacked
tarball at **65** tools; `build-star-relay` reports **27 high-level calls and 0 writes below
them** (the 27th is `fix_project`). A "check" is a printed `PASS` line, and
`grep -c '^  PASS'` on the log reproduces every number in these documents.

### Added — `fix_project`, because "it boots" was a claim about one kind of project

`validate_game` already knew which `System.json` keys the engine dereferences without a
fallback; `fix_project` writes the ones this project is missing. The values come from
*your* installation's `data/newdata/data/System.json` — they belong to the engine, so this
package carries no copy of them — except `advanced.windowOpacity`, the one key the template
does not have either, which is the whole reason a copied template dies on its title screen
with a stack about `clamp`. It also puts `switches`/`variables` back into the array shape the
engine indexes, writes only what is genuinely absent, and `dryRun` answers with the plan.
Both build scripts call it before they write anything.

### Fixed — D2b: the caller's `RMMZ_PROJECT` now beats the registration

`scripts/mcp-client.mjs` assembled the spawned server's environment as
`{...process.env, ...entry.env}`, so the project named in the MCP client's settings file won
over the one the caller set — and a reviewer's `build:game` printed map ids from a project
they had never pointed at, with no line saying so, for a long time. The precedence is
reversed, and every scripted suite now prints `project <path> (from where)` before it writes,
with an extra warning line when the environment and the registration disagree. `verify:newdata`
asserts the whole shape of it: it builds the lamp game into its throwaway copy by environment
variable alone and checks that the registered project's `MapInfos.json` is byte-for-byte
unchanged afterwards.

### Fixed — D2: the chain fails where the game actually fails

- `build:game` and `build-star-relay` now **end** with `validate_game` over the maps they
  wrote and exit 1 on any error, instead of printing map ids and letting a playtest spend
  two minutes discovering the game was still on its title screen.
- `live_session {action:"boot"}` returns as soon as the engine has stopped its own game
  loop, which is what `SceneManager.onError` does, quoting the captured error. The 0.4.0
  behaviour was 120 000 ms of patience followed by "Still not on a map".
- `verify:newdata` no longer stops at "the patched template walks into a map": it spawns the
  chain's own `build:game` and `play:game` against that copy and plays the game to its
  credits. That is the suite that found the picture defect below.

### Fixed — a build that reached outside the repository, and an audit that could not see it

`build-lightrun` imported the lamp game's ending picture from `../vibe_images/`, a folder
that exists only on the author's machine. On the fresh copy the fallback was a `.jpg`, and
`ImageManager.loadBitmap` asks every `img/` folder for `"<name>.png"` and nothing else
(v1.8.0's `rmmz_managers.js:919`), so the file could never load — which is exactly what the
new playtest logged: `Failed to load: img/pictures/lighthouse-night.png`. Three changes, all
measured:

- the picture is generated for this repository and published in `assets/` as a 79 kB `.png`,
  so a build needs nothing outside the package;
- `import_asset` refuses a non-`.png` into an `img/` folder, `check_assets` reports a
  reference satisfied only by another format as `not-png`, and `assetExists` — which the
  high-level tools consult before accepting a graphic — counts `.png` only;
- `validate_game` now reads the picture names out of Show Picture commands (`231`, whose
  second parameter is the file name) and calls a missing one an error. Nothing checked
  pictures before, which is how this survived a green chain.

The same reading of the engine corrected a folder the audit had wrong since 0.1.0:
`Animations[].effectName` is played by `EffectManager` from `effects/<name>.efkefc`, not by
`ImageManager` from `img/animations/`, which is MV's folder and is dead in MZ outside the
compatibility `Sprite_AnimationMV`.

### Fixed — D1, D3, D4, D5, D6, D7

- **D1** — the runbook's first two commands (`npm ci`, `npm run build`) both failed on the
  tarball: npm strips `package-lock.json` from a pack, so `ci` has nothing to install from,
  and there is no `src/` to compile. The runbook now says `npm install` and stops offering a
  build step to a package that has none, and `verify:full` skips the compile with a printed
  reason when `src/` is absent, so thirteen suites still run from the artifact.
  `verify:package` asserts all of it — no lock or shrinkwrap shipped, no `prepare` hook, the
  entry points `package.json` advertises present in the tree, and the packed README telling
  the installer the command that works.
- **D3** — `read_database` answers `count` and `entries` for *every* table; `System` keeps
  `value` as well and its `entries` holds that object as its single row, so `.entries.find()`
  means the same thing on `System` as on `Troops` instead of throwing a bare `TypeError`.
- **D4** — `render_map` and `live_screenshot` create the folder they were told to write into.
  `samples/` is deliberately not published, so a suite that saved a picture into it crashed on
  a tarball over a missing directory rather than over anything it was testing.
- **D5** — `enable_plugin`'s `file` accepts `"RMMZLiveBridge.js"` as well as the bare name it
  was appending `.js` to.
- **D6** — a session record on disk counts as a live session only when its pid is alive *and*
  that process's command line still names this package's browser profile directory. Pids are
  recycled; "alive" was not evidence. `session:e2e` proves a borrowed pid no longer refuses a
  new session.
- **D7** — `patch_database_entry` answers with `droppedKeys` and a warning when a nested
  object patch replaces an object and loses keys it did not mention. The README had been
  describing that as a trap for a year; the tool now catches it.

### Fixed — two counts in the documentation that were wrong

`ENGINE_READS`' fix strings said `terms.basic` was 8 entries, `terms.commands` 14 and
`terms.messages` a 58-entry array. Read off a project the editor wrote: 10, 26, and an object
of message groups. The strings now match the data.

## 0.4.0 — the high-level layer closes its own gaps

The acceptance review's remaining complaint was shape, not correctness: the layer stopped at
*content*, so building a map still meant dropping to `create_map` + `set_tiles`, choosing a
tile still meant reading a PNG and a flags array by hand, and driving a dialog still meant
counting key presses. Five tools close those, and the registry is **59 → 64** (49 primitives,
15 high-level).

- **`make_map`** — one call makes or reuses a map and lays its entire ground: size, tileset, a
  fill, rectangles and cell lists resolved to one tile per cell (last stroke wins), each tile
  sent to the layer its own slot belongs to, the passage flags for the tiles used, region ids,
  and the map's properties. Repainting owns the cell's whole stack, so last run's roof cannot
  survive under this run's floor. The reply counts the walkable cells left behind, and refuses
  to pretend a plan with none is a map.
- **`describe_tiles`** — the tile dictionary: slot, bound sheet, draw layer, the flags decoded
  into words (including the 0x10 bit that makes the direction bits do nothing), terrain tag,
  and how many cells of a map use each id. `contactSheet` draws a labelled picture, one block
  per id, from a scratch map it creates and deletes again.
- **`make_item`** — Items, Weapons, Armors **and Skills** rows with their effects spelled in
  words. The effect/trait distinction is the point: an effect is `{code, dataId, value1,
  value2}` and a trait is `{code, dataId, value}`, and writing the second into the first makes
  the engine compute `mhp × undefined` and put `NaN` into an actor's HP. States, parameters,
  common events, elements and every type id are resolved against the project and refused when
  the project has not got them, and fields the row type does not carry are called out instead
  of written inert.
- **`make_battle`** — the Enemies row and the Troops row that holds it, in one call: parameters,
  exp, gold, battler, actions (`skillId` checked against Skills), element rates and state
  resists as traits, drops in `{kind, dataId, denominator}` with the engine's three slots, and
  `zone` to roll the group in a region.
- **`live_dialog`** — reads what a running game is waiting for (the text, the choice options
  with their enabled state and cursor index, the number pad's digits) and answers it: pick this
  option, type that number, dismiss, cancel.

### Fixed — a cursor key sent to a window that is not listening

`play:game` failed one check on the recorded 0.3.0 run: a choice answered as the *first*
option whatever was pressed. `$gameMessage.isChoice()` is true the moment a choice is queued,
while `Window_ChoiceList` is still fading in, and `Window_Selectable.isCursorMovable()` needs
the window open **and active** — so the Down press was dropped on the floor. The old stuck-key
defect had been masking it: a button that never came down kept repeating until the cursor
landed somewhere. Both playtest harnesses now drive dialogs through `live_dialog`, which waits
for the window, presses one edge at a time, re-reads the index after every press, presses
through the line that asks the question, and refuses an option the game has switched off.
Recorded: `chose 问它灯塔的事 in 2 press(es): down, ok`.

Also found while writing this, against the engine rather than from memory: MZ's
`Game_Action.numRepeats()` reads `item().repeats` even for a skill, so the MV spelling
`repeat` is inert — and there is no `hits` field to write at all.

Measured on this build: `npm run e2e` **258 checks, ALL PASS** with the registry snapshot at
64 names; `node scripts/build-star-relay.mjs build` now reports **26 high-level calls and 0
writes below the layer** (was 6, or 8 on a clean project — the lamp game was hiding two); and
`npm run verify:full` is **14 of 14, VERIFY FULL PASS, exit 0** in 793 s. The 14th entry is new:
`verify:package`. (A "check" is a printed `PASS` line — `grep -c '^  PASS'` on the log
reproduces every count in these docs.)

### Added — `verify:package`, the gate that looks at the artifact instead of the source

`npm pack`, unpack into `.rpgmaker-mcp/package-check/`, and judge *that* tree: the `files`
allow-list checked both ways, every shipped text file scanned for this machine's paths and the
bridge token, then the unpacked `dist/index.js` spawned as its own process so its `tools/list`
can be diffed name for name against the working tree and its three read calls replayed. The
tarball it verifies is the one left on disk, so what passes is what gets published.

It found two defects on its first run, both real, neither visible from inside the repo: a fresh
install has no command dictionary — it is derived from a licensed engine and deliberately not
shipped — and nothing said so, so `decode_commands` quietly printed "code 101" forever;
`project_info`, `decode_commands` and `command_catalog` now name the command that builds it.
And `initialize` was advertising a hard-coded `0.1.0` while `package.json` said otherwise, which
is the first string a client reads.

The acceptance game moved onto the new tools — its three maps come from `make_map`, its lantern
from `make_item`, its guardian and group from `make_battle` — and that rename is what the first
0.4.0 chain caught: `play:star-relay` failed on its own check "and it is the troop this game
named", because the harness still matched the *lamp game's* boss string that had been copied
into it. The check now resolves the guardian by name from the `Enemies` row at startup and
asserts one battler wearing that name, so a rename fails loudly in the first beat instead of
silently in the twelfth.

The same chain then caught a second harness bug of a different kind: `play:game` failed "the
autorun ending fires on the village" with the player standing in the village, no message on
screen and the ending switch still off. The ending event opens with a `Show Picture` and a
30-frame `Wait`, and the script probed exactly once after the transfer — it had always only been
passing because an earlier `dismiss` loop happened to spend that time. The beat polls now.
Nothing in the service was involved, which is worth saying out loud because the failure message
looked like one.

`npm run e2e` also stopped being a trap: it used to print a usage line and exit unless you
passed both paths, while every other suite reads them from the environment. It goes through
`scripts/e2e-run.mjs` now, so the bare command works and
`npm run e2e -- <project> <corescript>` still does.



`REVIEW-PACKAGE` — an independent acceptance run that built a whole game with the tools and
wrote down every place the reply was a lie — produced ten findings. Every one is addressed
below or answered in `ACCEPTANCE.md`, and each fix is a recorded run, not a read-through:
`npm run verify:input` (40 checks, ALL PASS), `npm run verify:newdata` (12 checks, ALL PASS),
`npm run e2e:live` and `npm run e2e` (both ALL PASS). The registry is 59 tools and
`verify:full` now runs 12 suites.

### Fixed — driving the running game

- **A synthesised key was never let go.** `live_key` raised a button in `Input._currentState`
  and then simply stopped re-asserting it, and nothing else on a headless page ever writes
  `false` there — no human, no keyup. The player kept walking on their own after every
  press, and the next press in the other direction cancelled it silently, because the engine
  folds the arrows into one direction (`Input._signX() = right - left`). This is the reason
  a reviewer's direction presses "did not work" *and* the reason a walk reported nothing was
  in the way. The bridge now lowers every button it raised, on the next input poll, from the
  same hook that raises them. Measured: 10 of 10 presses move exactly one cell, and
  `Input._currentState` holds no arrow afterwards.
- **A hold is timed in input polls, not engine frames.** `SceneManager.update` calls
  `updateInput()` once and `updateMain()` one or more times after it, so a hold counted in
  frames could open and close between two samples. Measured on a real page at 60fps: 5 of 10
  presses moved the player counted in frames, 10 of 10 counted in polls. `heldFrames` in the
  reply is the number of polls the button was really down for.
- **`live_key` refuses to say nothing.** When the player did not move, the reply now carries
  `busy` — a dialog is on screen, an event is running, a forced route has the player — and a
  walk that cannot start names the reason rather than running out its timeout: the cell ahead
  will not let the player through, or the engine reads a different direction while the key is
  held.

### Added — the input path an author can actually verify

- **`live_move`** holds an arrow for a whole walk and answers with `requested`, `moved`,
  `from`, `at`, `heldFrames`, `framesAdvanced`, `steps` and `encounterCount` before/after,
  plus `stopped` when it did not arrive. Only this path runs `updateNonmoving`, which is what
  counts the party's steps, walks the encounter counter down and fires player-touch triggers
  — so it is the tool that proves a map is playable rather than merely drawn. A walk that
  enters a cell stops the moment the engine will not let it through that cell.
- **`delete_map`** takes a map out of `MapInfos` and off the disk with a backup, and refuses
  while an event still transfers the player there — naming which event on which map — unless
  `force`. `dryRun` answers with the plan. (Its first run found a real bug: the guard read
  `parameters[0]` of a Transfer Player command, which is *what* transfers, not where it goes.)
- **`enable_plugin`** turns a plugin file that is already in `js/plugins/` into a live entry
  in `js/plugins.js`, seeding its parameters from the `@default` in its own header and
  refusing keys the plugin never declares. Installing the bridge used to mean opening the
  editor.
- **`clear_events`** and **`set_startup`**: one call to take a map's cast off before
  rebuilding it, one call to set the title, opening cell, party and the switch/variable name
  tables.

### Fixed — what a reply promised

- **`make_npc`'s `pages[]` is the page list.** Passing top-level `say`/`script` alongside
  `pages[]` is refused instead of merged into every page — which conditioned page 0 on the
  last page's condition and produced an NPC that never spoke and never said why. A page that
  carries both `say` and `script` now says the text was dropped. Proved in a running game:
  one confirm press speaks page 1, page 1 sets the self switch, the engine moves the event to
  page 2, and the next press speaks it.
- **`validate_game` checks the fields the engine reads** without asking: 15 `System` paths
  including `advanced.windowOpacity`, each with the call that fixes it. On an untouched MZ
  1.8.1 `data/newdata` it reports the missing key, and the same template — installed with
  `enable_plugin` and booted — stops drawing frames at 3 on the title screen with
  `Cannot read properties of undefined (reading 'clamp')`. After the patch the same boot
  reaches `Scene_Map`.
- **`set_tiles` places each tile where its slot belongs.** Leave `layer` out and an A2 floor
  goes to layer 1, an A4 wall to 3, a plain B–E tile to 0, and the reply says which layers it
  used. Painting ground over trees, and a wall left impassable under a floor that looks open,
  were both this.
- **`live_status` means what it says.** `listening` is now *this process owns the port* (the
  bridge `ensure()` is awaited instead of fired), a page running an older plugin is reported
  as `STALE BRIDGE` by version handshake, and a port with nothing polling it is named.
- **`make_encounter_zone`** reuses a troop it already made under the same name instead of
  adding a second one per build; **`map_connectivity`** reports each map once.
- **Unknown command codes are named, not swallowed.** `set_commands`, `add_commands` and
  `validate_game` warn when a code is not in the engine's own dictionary, because for those
  `decode_commands` can only say "code N" and no parameter check exists. 0 of the 461 commands
  in the demo project trip it.

### Changed — the acceptance game, rebuilt

`build-star-relay.mjs` now authors the same three maps through the new calls: `set_tiles`
24 writes → 3 (one per map, no `layer` argument), `remove_event` 14 → 0 (`clear_events`),
`patch_database_entry` 2 → 0 (`set_startup`). Its terrain is resolved to one tile per cell
before it is written, because two tiles in one cell are read as *both* applying to passage.
The playtest that walks it (`play:star-relay`) is unchanged.

## 0.2.0 — the high-level authoring layer, and one command that proves it

Everything in this release was verified by running it; see `ACCEPTANCE.md` for the
commands and the measured numbers.

### Fixed — live bridge and headless session

- **Large screenshots were refused.** The 4 MB body cap applied to the bridge's `/result`
  route as well as to commands, so a full-screen `live_screenshot` came back "payload too
  large". Commands and results now have separate limits, and an oversized *state report* is
  rejected by name rather than silently dropped.
- **`live_eval` stopped at 8 s while the plugin waited 20 s.** The default now matches the
  plugin's own settle window, and `timeoutMs` still raises it on request. A 12 s promise
  expression comes back with its value.
- **`live_key` could time out on its own arithmetic.** At the headless ~9 fps a worst case
  of 20 pulses × 30 frames runs ~66 s, longer than the timeout the tool itself computed.
  Presses are now sized from the frame rate the bridge measures, the reply carries
  `timing.measuredFps`, and a page that has stopped advancing frames fails in seconds with
  the number of presses it actually scheduled.
- **A busy port used to kill the bridge for the life of the process.** The listen failure
  latched; it is now retried on the next call, and `live_status` reports `listenError` only
  while it is actually true.
- **Unauthenticated state reports.** When a token is configured it is now required on
  `/state` too: a forgery is refused with 401, `live_status` names the imposter in
  `authError` and counts `rejectedPolls`, and the forged state never becomes the reported
  game.
- **Command ordering.** One command was dequeued per poll while results returned
  asynchronously, so two queued `live_eval`s could overlap. The queue is now serialized:
  the next command goes out only after the previous result has been posted.
- **The A4 scenario hung forever.** `e2e:live` takes the bridge's port with a throwaway
  server to prove the listen failure is retried, then closes that server and waits — but the
  polling page keeps a socket open, and `server.close()` waits for idle keep-alive
  connections, so the suite stalled the whole chain. The blocker now answers `503` with
  `Connection: close` and calls `closeAllConnections()` before closing.
- **Session teardown on Windows.** Stray browsers were matched by executable name, which
  missed non-Edge Chromium families, and the synchronous `Get-CimInstance` query blocked the
  server's event loop for seconds. Kill now follows the recorded pid tree with a
  `taskkill /T` fallback, and the process query is asynchronous.
- **The registry snapshot.** `e2e` asserted only "at least 20 tools". It now compares the
  full tool-name list against a snapshot, so adding or dropping a tool is a deliberate
  change with a failing test until the snapshot moves.

### Added — eight high-level authoring tools

One intent, one call, one transaction, and the answer includes the picture it made. Each
composes the existing primitives server-side; if any part fails, every file it wrote goes
back to the bytes it had.

| Tool | What one call does |
| --- | --- |
| `make_npc` | character, movement or patrol route, lines, second page on a switch |
| `make_choice_scene` | a whole event page from a step list: choices with per-option gates, `if`, `loop`, battles with win/escape/lose, shops, transfers, audio, game over |
| `make_chest` | closed graphic, line, payout, opened page on self switch A, and an item gate that stays openable afterwards |
| `make_shop` | MZ's real shop shape: command `302` plus one `605` per good |
| `make_encounter_zone` | paints a region, creates the troops, attaches rows with the fields `Scene_Map` reads |
| `link_maps` | both ends of a connection, each arriving beside the far door and facing away |
| `set_tileset_flags` | passage, bush, counter, damage floor and terrain tags, autotile groups included |
| `validate_game` | read-only audit of the whole project before a playtest |

`script` and `raw` remain as deliberate escape hatches, and a build that needs them gets
`escapeHatches` in its reply so the gaps in the layer stay visible.

### Added — landing, and autorun hygiene

- `link_maps` no longer parks the player on the far door's own cell. A transfer lands on
  the first open cell *beside* it (above, right, left, below) facing away from the door;
  `land` picks the cell explicitly, a door walled in on all four sides keeps its threshold
  and says so in `warnings`, and the call refuses up front if either end or the chosen
  arrival cell cannot be stood on. The reply's `landed` and the bytes in the map file are
  checked against each other.
- `make_choice_scene` only requires standable ground for pages the player or another event
  can touch: an `autorun` page may sit on a wall or at `0,0`.
- An `autorun` page that sets no switch, no self switch and does not erase itself re-arms
  every frame and takes the map over. `make_choice_scene` warns when it writes one, and
  `validate_game` reports it on pages it did not write.

### Added — verification

- `npm run verify:full` — build, then the file-layer suites, then the live suites, then the
  lamp game built and played, then the acceptance game Star Relay built and played, then the
  registered-command chain smoke. One order, one exit code, per-suite timings.
- `npm run build:star-relay` / `npm run play:star-relay` — a three-map game authored with
  the high-level tools only, and a headless playthrough that asserts engine state beat by
  beat (47 checks) rather than file state.
- `npm run smoke:chain` — spawns the command your MCP client has actually recorded and
  drives it: registry, read surface, a scratch map written and then taken back through
  `undo_writes`, with a timing per call.
- `scripts/local-env.mjs` — project folder, corescript folder and bridge token now resolve
  from environment → registered server → `.rpgmaker-mcp/live.env`, so a fresh clone can run
  the whole flow without editing a script, and no file in this repository hardcodes a
  machine path.
- Suite ports are separated: 3789 registered server, 3791 `live_session`, 3792 lamp game,
  3793 `e2e:live`, 3794 Star Relay, 3795 the session-lifecycle probe.

### Documentation

- `README.md` gained the high-level layer, the landing contract, the new environment
  variables, and the port map.
- `src/bridge/FINDINGS.md` was rewritten as the publishable "why there is no editor
  automation" conclusion; the raw machine-specific investigation log stays out of the repo.

### Known gaps

- `set_commands` validates the parameter shape of every *known* command code and refuses a
  bad one, but a code the engine has no method for is accepted and written. Refusing or
  merely warning is a policy decision (plugins do add codes), so it is reported rather than
  guessed at. See `ACCEPTANCE.md`.
- The terrain of a map still needs `set_tiles`: the layer has no terrain-painting call yet,
  and Star Relay's 24 `set_tiles` writes are recorded as the largest escape hatch.
