# Answers to the acceptance review, item by item

The review (`REVIEW-PACKAGE`: `FINDINGS.md` B1–B10, `FIX-CHECKLIST.md` P0-1–P3-4) was run by
a model that built a whole game with the server and wrote down every place the reply did not
match what the engine did. It found two real defects that the previous 11 suites had missed,
and both were in the part that is hardest to fake: driving a running game.

Everything below is a recorded run, not a read-through. The commands are in
[`ACCEPTANCE.md`](ACCEPTANCE.md); the numbers are what those commands printed on Windows,
Node v24, RPG Maker MZ 1.8.1, a 15-map project.

**Verdict on the review: B1–B8 are fixed, each with a recorded run behind it — though B3b and
B3c turned out to have a different root cause than the one diagnosed. B9 and B10 are answered
as documentation. Of the 15 checklist items, 12 are done, 3 are declined with reasons, and none
are left undone.**

Registry: 54 → **59** → **64** → **65** tools (49 primitives, 16 high-level — 0.4.0 added
`make_map`, `describe_tiles`, `make_item`, `make_battle`, `live_dialog`; 0.4.1 added
`fix_project`; 0.4.2 adds **no** tool, it changes what they say and do on a project that is not
the author's). `verify:full`: 11 suites → 14 → **15** entries, and each release's recorded chain —
suite by suite, with its own numbers — is in [`ACCEPTANCE.md`](ACCEPTANCE.md) §4. Bridge plugin:
**v0.4.1**, unchanged in 0.4.2, and `live_status` tells you when the copy in your project is older
than the copy the server ships.

**Round three is at the top of this file**: the 0.4.2 review re-verified `D1`–`D7` at 7/7, filed
`R1` and `R2`, refused to grade a claim it could not run — and `npm run census` is what that claim
became.

---

# Round three — the 0.4.2 review (`R1`, `R2`, and the claim it could not run)

The same reviewer, third round, from the same tarball. It independently re-verified all seven of
round two (**7/7, no regressions**, registry 54 → 64 → 65 with nothing dropped), rebuilt its own
game on 0.4.1 (**37/37**, 20 high-level calls and 0 escape hatches), and filed two findings — both
about *whose project the code was written for* — plus one claim it correctly refused to grade.
Verdict: **可以交付**. Both findings are closed; the claim is now a command.

| What it reported | What happened | Where it is proven |
| --- | --- | --- |
| **R1** the 15-minute path never mentioned `fix_project`, so `verify:input` on a template copy gave `6 PASS / 2 FAIL` and blamed the key bindings | one shared repair step for every suite that boots a game (`scripts/ensure-bootable.mjs`, used by `verify:input`, `play:game`, `play:star-relay`, `session:e2e`), plus `npm run fix-project` (`-- --check` reports only, exit code says whether the project is bootable), plus the step written into the README's "First commands" and the runbook's §1 | the reviewer's own criterion, run as stated: a copy of `data/newdata` with the bridge installed by `enable_plugin` and nothing hand-patched — `verify:input` printed `fix_project wrote ["System.advanced.windowOpacity"]` then **40 PASS / 0 FAIL, exit 0** (bundle `evidence/r1-verify-input-on-fresh-copy.log`) |
| **R2** `e2e` / `smoke:chain` / `verify:package` are bound to the acceptance game and died in a *constructor* on anything else | each gates instead: `e2e` prints `skipped: needs the acceptance game`, names the builders that supply it and exits 0 without writing; `smoke:chain` keeps its project-agnostic half and marks the rest `n/a`; `verify:package` reads whatever map the project has and only judges the game when the game is present. `e2e`'s first check also stopped comparing `projectDir` with the literal `demo-project` | all three run against a **pristine template copy**: `e2e` → the skip line and exit 0, no `TypeError`; `smoke:chain` → `n/a` and exit 0; `verify:package` → **ALL PASS, 50 checks** where it had failed 2 of 46 (bundle `evidence/r2-*`) |
| **the census** — "27 high-level calls, `escape hatches: {}`" was not reproducible without the author's project, so it was marked *not independently confirmed* | `npm run census`: copy the shipped template, build Star Relay into that copy alone, read the census back and **gate on zero writes**; `-- --play` plays it there; it is suite 13 of `verify:full` | measured on a template copy: **25 high-level calls, 0 low-level writes, 3 reads**, `escape hatches: {}`, exit 0 — and with `-- --play`, that same copy **played through to its title screen: 48 PASS / 0 FAIL**. One command, an empty engine template, a finished game. The author's project reports **28** calls: the difference is the three `clear_events` a repaint needs and a first create does not (bundle `evidence/census-from-template.log`, `evidence/r3-census-with-play.log`) |

**What making the census runnable found** — three more ways the acceptance game depended on this
particular machine, none of which any reviewer could have seen without running it:

1. the cave chest gave the player `Items[3]`, which is **the lamp game's** row: in a template copy
   ids 2–5 are blank, and `make_chest` refuses to fill a chest with a nameless row (that refusal is
   what caught it). The game now makes its own `Relay Fuse` row through `make_item`.
2. the encounter troop named `Enemies[6]`, which existed only because this project had grown a
   sixth row; the zone now rolls `Enemies[3]`, and the boss copies `Enemies[1]` rather than `[7]`.
3. the playtest counted item id `3` as a literal, where the rest of the harness resolves by name.
4. and, on the re-run rather than from the census: `play:star-relay`'s encounter beat asserted a
   battle after **one fixed route** through the region. The engine re-rolls the distance to the next
   encounter (`Game_Map.updateEncounterCount` is two `randomInt`s over the map's encounter step), so
   that beat was a coin flip — it came up tails on the first 0.4.2 chain, while the very next beat
   was interrupted by two battles on the same map. The beat now walks the region until a battle
   arrives, within four passes of the same three-stop route, and prints how many passes and steps it
   took: the property is still asserted, the report is no longer luck. Recorded pass: rolled on
   pass 1 after 18 steps, **48 PASS / 0 FAIL**.

**And two defects in the tools, visible in the reviewer's own logs:**

- `make_item` checked the item's type against `System.itemTypes`. That key is MV's; MZ spells an
  item's type as a number (`itypeId` 1 = the Item tab, 2 = the Key Item tab, and
  `Window_ItemList.includes` accepts nothing else) with `$dataSystem.itemCategories` as the tab
  switch (`rmmz_windows.js:2133`–`2140`, v1.8.0). So *every* project got
  `this System.json has no itemTypes list` — a warning true of none of them. It now says what the
  engine does, and refuses a name with the explanation.
- `make_battle` interpolated `create_database_entry`'s `basedOn` — an `{id, name}` object — into a
  sentence and compared it to a number, so the warning both always fired and read
  `Enemies [object Object]`. `e2e` now asserts no warning from the layer spells an object into text.

**Still open, and deliberately so** (it was round one's P3-4 and the reviewer has not asked again):
`set_commands` warns rather than refuses a command code the engine has no method for, because
plugins legitimately add codes; `validate_game` repeats the warning. Say the word and it becomes a
refusal with an override.

---

# Round two — the 0.4.1 review (`D1`–`D7`)

The same reviewer rebuilt its own game on 0.4.0, ran the suites serially from the tarball,
and filed seven new findings. Its own summary: the core capability had improved markedly and
round one's ten were genuinely fixed, but **"the fresh-project path is not covered end to
end"** — every suite ran against a project the editor had made. That is the right diagnosis,
and it is now a suite rather than a hope.

| Finding | Fix | Where it is proven |
| --- | --- | --- |
| **D2b** the caller's `RMMZ_PROJECT` lost to the registration, silently | `{...entry.env, ...process.env}` in `scripts/mcp-client.mjs`; every scripted suite prints `project <path> (from where)` and warns when environment and registration disagree | `verify:newdata` §4 asserts the build printed the copy it was given **and** that the registered project's `MapInfos.json` is byte-identical after a whole build + playtest |
| **D2** a game built on the engine's `newdata` template could not be played | new `fix_project` (16th high-level tool) writes the engine-read `System` keys from your own installation's template; both builders call it, then **exit 1** if `validate_game` still reports an error in the maps they wrote; `live_session boot` returns the moment the engine stops its own loop, quoting the captured error | `verify:newdata` §3–4 (repair → boot → build → play to the credits); `e2e` (idempotent on an editor project); the fail-fast is visible in the suite's own log |
| **D3** `read_database` answered `{table, value}` for `System` and `{table, count, entries}` elsewhere | every table answers `count` and `entries`; `System` keeps `value` and its `entries` holds that object as one row | `e2e`: "System answers entries as well as value, so .entries.find works on it" |
| **D1** the runbook's first two commands both failed on the tarball | `npm install` in the docs (npm strips `package-lock.json` from a pack); `verify:full` skips the `tsc` entry with a printed reason when there is no `src/` | `verify:package`: no lock or shrinkwrap shipped, no `prepare` hook, advertised entry points present, packed README says the command that works |
| **D4** `verify:input` crashed writing into `samples/input`, which is not published | fixed at the tool, not the script: `render_map` and `live_screenshot` create the folder they were told to write into | `verify:newdata`: "live_screenshot makes the folder it was asked to write into" |
| **D5** `enable_plugin` appended `.js` to a `file` that already had it | the trailing `.js` is stripped, and the schema says either spelling works | `e2e` registry + the tool's own reply field |
| **D6** a session record whose pid had been recycled refused every new session | a record counts as live only when the pid is alive **and** its command line still names this package's browser profile directory; otherwise it is cleared and the reply says so | `session:e2e`: writes a record naming its own live pid, then starts a session and checks the record was replaced |
| **D7** `patch_database_entry` silently dropped the keys of a nested object it was given partly | `droppedKeys` plus a warning naming each lost key, for `System` and for row tables | `e2e`: patching `advanced` with one key reports the nine it lost; a complete nested patch reports nothing |

**Two things the new coverage found that nobody had reported**, both in 0.4.1:

1. `build-lightrun` imported the lamp game's ending picture from `../vibe_images/` — a folder
   outside the repository. On a fresh copy the fallback was a `.jpg`, and
   `ImageManager.loadBitmap` asks every `img/` folder for `"<name>.png"` and nothing else
   (`rmmz_managers.js:919`, v1.8.0), so the engine logged `Failed to load:
   img/pictures/lighthouse-night.png` at the credits. The picture is now generated for this
   repository and published in `assets/`; `import_asset` refuses a non-`.png` into an `img/`
   folder; `assetExists` counts `.png` only; `validate_game` reads Show Picture's file names
   (parameter 1 of command 231) and calls a missing one an error — nothing had checked
   pictures at all, which is how a green chain hid it.
2. `check_assets` resolved `Animations[].effectName` against `img/animations/`. MZ plays
   effects through `EffectManager.makeUrl` → `effects/<name>.efkefc`
   (`rmmz_sprites.js:1244`); `img/animations/` is MV's folder, kept in the engine only by the
   compatibility `Sprite_AnimationMV`. The audit now looks where the engine looks, and
   `import_asset` accepts `effects`.

**On the reviewer's own E2 (it modified `demo-project` and apologised).** No action needed:
that project is the chain's target — every map in it is a verification product (`MCP-SELFTEST`,
`E2E-*`, `SWEEP*`, `LR *`, `SR *`), and 0.4.1's `verify:newdata` now proves the registered
project is not written when a caller names another one. The cause was D2b, which was ours.

**On round one's B3b/B3c.** The reviewer wrote back that its own diagnosis (browser `blur` as
the main cause, `_encounterCount` decremented by `moveByInput`) was wrong and the measured
explanation in this file was right, and recorded the lesson that a diagnosis followed instead
of measured sends the next person to the wrong layer. Agreed, and worth repeating: the
corrections in that section came from reading `Input._pollGamepads`,
`Game_Map.checkPassage` and `Game_Player.updateNonmoving` in the installed engine, not from
reasoning about what a game framework usually does.

## The two that mattered most

### B3c / P0-3 — direction presses that do nothing

The report was right that a `live_key` direction press could leave the player standing still
with nothing said about it. Two things caused it, and neither was the one the review named.

**1. A hold counted in the wrong clock.** `SceneManager.update()` calls `updateInput()` once
and `updateMain()` one or more times after it, so a hold measured in *drawn frames* can open
and close between two input samples. Counted in input polls instead — re-asserted from inside
`Input._pollGamepads`, after the gamepad poll and before `_updateDirection` reads the state —
the same press goes from moving the player on 5 of 10 tries to 10 of 10.

**2. The button was never let go.** `_currentState` is written only by a real keydown/keyup.
The bridge wrote `true` and then simply stopped re-asserting, which is not the same as writing
`false`: on a page nobody types into, the arrow stays down forever. The player then walks on
their own after every press, and — this is the part that made the symptom look random — the
next press in the opposite direction cancels it, because `Input._signX() = right - left`. Measured
before the fix, in one run: `place(1,5)` put the player back at x=2 (a free step right), and a
`live_move` left into a wall reported `heldFrames: 421, moved: 0, stopped: "out of time"` — a
walk that had no direction to walk.

After the fix (`verify:input`, 40 checks, ALL PASS):

```
10 presses with the default 2-frame hold each move the player one cell   PASS
10 presses with the wall-clock-sized hold (8 frames ≈ 133 ms)  …         PASS
no arrow is left held down when a press ends                             PASS
   · buttons the engine still thinks are down after the press: []
live_move walks 6 cells and reports 6                                    PASS
walking into the border says so at once                                  PASS
asked for 25 cells in an 18-wide room it stops at the wall               PASS
```

The refusal to *say nothing* is also in now. A press that did not move the player reports
`busy` — `a dialog is on screen`, `an event is running`, `a movement route has the player`; a
walk that cannot start names the cell that will not let the player through, or says the engine
reads a different direction while the key is held.

**What the review attributed it to, and what was measured instead.** `blur` → `Input.clear()`
was named the main cause. It is real and the re-assert survives it — `e2e:live` A3b wipes the
whole state object every third frame and still reports 12 of 12 frames held — but on this
machine it never happened in a playtest run, and turning it off did not fix the presses. The
two causes above did. `e2e:live` keeps the blur simulation so it cannot regress.

### B2 / P0-2 — `make_npc`'s `pages[]` built a mute NPC

`pages[]` is now the page list, period:

- top-level `say` or `script` alongside `pages[]` is **refused**, with the reason (merging it
  into every page conditions page 0 on the last page's condition);
- a page that carries both `say` and `script` **warns** that the script is what runs and the
  text is dropped, because `script` replacing `say` is the documented rule but a dropped line
  is still a dropped line;
- per-page errors name the page index, and a build whose every page is behind a condition says
  so, since that is what a mute NPC looks like.

Proved by talking to it in the running game (`verify:input`; the NPC stands in a room the
script painted and deleted afterwards):

```
pages[] builds two pages, not one                       PASS   reply 2, file 2
page 1 of the file carries no condition                  PASS   conditions []
page 2 is the one waiting on self switch A               PASS   selfSwitchCh "A"
one confirm press says page 1 out loud                  PASS
and page 1 set the self switch the second page waits on  PASS   $gameSelfSwitches → true
the page the engine has the event on now                ·        _pageIndex 1
the next conversation is page 2                          PASS
```

---

## B1 / P0-1 — the shipped `data/newdata` does not boot

The review's diagnosis was right and the acceptance criteria are met. Measured against an
untouched copy of the install's own `data/newdata`, with nothing added by hand
(`verify:newdata`, 12 checks, ALL PASS):

```
this really is the unpatched template (no advanced.windowOpacity)   PASS
validate_game names the missing key instead of calling it clean     PASS
   · problems found: ["error System.advanced.windowOpacity"]
enable_plugin puts a file copied in by hand into js/plugins.js      PASS
an unpatched template stops drawing frames on the title screen      PASS
   · frame 3, scene Scene_Title, 0 frames advanced in 2 s
   · engine: TypeError: Cannot read properties of undefined (reading 'clamp')
     at Window_Base.updateBackOpacity (rmmz_windows.js:77)
the same template now walks into a map                               PASS
   · Scene_Map, map 1, player (8,6), 121 frames in 2 s
```

`validate_game` grew `ENGINE_READS`: 15 `System` paths the engine reads without asking, each
with its own `why` and a `fix` line that is a call you can paste. The patch preserves the other
keys of `advanced` — that was the point of adding `set_startup` rather than telling people to
hand `patch_database_entry` a whole nested object to change one number.

## B3 — two servers, one port

B3 was about a second MCP server taking the bridge port and the bridge then dying quietly. The
refusal is loud now and it stayed loud in a real run: when a Star Relay playtest from an
interrupted previous run still owned 3794, the next run's every call answered

```
Live bridge could not listen on 127.0.0.1:3794: listen EADDRINUSE: address already in use
127.0.0.1:3794. Another process has that port, most likely another copy of this server.
```

and the run died in 114 s instead of hanging. Two things made that possible: `liveBridge.ensure()`
is awaited (so `listening` means *this process owns the port*, not "a listen call was issued once"
— the old field was true while the bind had failed), and `live_status` adds `NOT LISTENING` when
it is not. The companion warning, `STALLED`, covers a page that reports but has stopped advancing
frames; and `live_status` now names a second document polling the same port.

## P0-4 — `live_move`, so the input path is testable

New tool. `live_move({direction, cells})` holds the arrow and answers `requested`, `moved`,
`from`, `at`, `heldFrames`, `framesAdvanced`, `steps` before/after and `encounterCount`
before/after, plus `stopped`. The suite uses those fields to prove the thing the review said
was unprovable: that a walk went through the engine's own input path.

One correction to the review's mechanism note: the counter is not decremented by
`moveByInput`. It is `updateNonmoving(wasMoving)` that calls `$gameParty.onPlayerWalk()` and
`updateEncounterCount()`, and the decrement is `encounterProgressValue()` — 1 per step, 2 on a
bush tile, halved by the Encounter Half effect. So a 6-cell walk measures a drop of 5: the
sixth cell is counted as *entered* when `_x` moves, and its step finishes later, which is what
`verify:input` now asserts (`moved - 1 ≤ drop ≤ moved × 2`) instead of the exact number the
review predicted.

## B4 / P1-1 — `delete_map`

Added: backs the file up, removes it, clears the `MapInfos` slot. It refuses while an event
still transfers the player there and names which one, and refuses the start map unless `force`;
`dryRun` answers with the plan without writing.

Writing the test for it found a bug in the guard itself: Transfer Player (201) puts *what*
transfers in `parameters[0]` and the destination map in `parameters[1]`, and the first version
read index 0. Proven in `verify:input` against a door event on the scratch map:

```
deleting a map an event still transfers to is refused            PASS
and the refusal names the event that leads there                 PASS   map 47 event 3 "Door To Nowhere"
dryRun reports the plan without writing                          PASS
force deletes the file and clears the MapInfos slot              PASS
list_maps no longer shows it                                      PASS
asking twice says it is already gone rather than pretending       PASS
```

## B5 / P1-2 — `enable_plugin`

Added. Reads the plugin file that is already sitting in `js/plugins/`, seeds its parameters
from the `@default` in its own header, refuses keys the plugin never declares, and turns the
entry on in `js/plugins.js`. `list_plugins` cross-checks the same way and reports `undeclared`
and `unset`, so a parameter that never took effect is visible without opening the editor.
`verify:newdata` uses it to install the bridge into a copy of the template.

## P1-3 / P1-4 — fewer low-level calls, and tiles on the right layer

`set_tiles` now places each tile id on the layer its own slot belongs to (A1/A2 → 1, A3 → 2,
A4 → 3, A5/B/C/D/E → 0) when `layer` is left out, and says which layers it used:
`layersUsed: "A2→1"`, `"A4→3"`. Explicit `layer` keeps the old behaviour and still warns when a
tile is on a layer its slot does not belong to.

What was *not* added is `paint_map`. The capability it wanted — a whole map's plan in one call
— fits `set_tiles` as it stands (`cells` is an array of any length, and `rect` works too), and a
second tool that does the same writes with a different name is a second thing to learn and to
keep wrong. The acceptance game is the measurement:

| Call | Before | Now |
| --- | --- | --- |
| `set_tiles` | 24 (one per layout block, each with an explicit `layer`) | **3** — one per map, no `layer` argument |
| `remove_event` | 14 | **0** (`clear_events`) |
| `patch_database_entry` for the opening state | 2 | **0** (`set_startup`) |
| high-level calls in the build | 17 | **19** |
| writes below the high-level layer | 40 | **6** — 3 `create_map`, 3 `set_tiles` |

`play:star-relay` then needed three fixes of its own, and it is worth separating those from the
service, because the game was never broken by the rebuild — the harness was relying on luck that
the rebuilt maps stopped providing:

1. A walk interrupted by a random encounter used to call `ensureMap`, which presses OK 25 times —
   enough for the short fights it had met before, not for a 63-press one. The player then stood in
   a battle scene while the walk kept planning routes, and the section spent its whole retry
   budget (60 rounds × an 8-second walk) doing nothing. It now fights the battle it interrupted.
2. Picking a choice can arrive while the prompt's own line is still on screen; the OK dismisses
   the *text* and the choice then opens under a key nobody is holding. It presses until the window
   is actually gone.
3. The win branch speaks before it transfers, and a Show Text holds the interpreter — so the
   transfer was only reserved after the line was dismissed, and the beat probed the cave and
   reported the player never left. It dismisses, then waits for the arrival.

Final recorded numbers, including the whole chain in one run, are in
[`ACCEPTANCE.md`](ACCEPTANCE.md) §4.

Re-runnable, and that is the part that found something: with auto-layering, two tiles can end
up in one cell, and MZ reads passage from **every** tile layer at once. The old build painted a
wall over the whole map and the floor back over it, which worked only because both went to
layer 0 and the last write won. On their proper layers the wall stays under the floor and the
house interior becomes impassable — the same trap the review fell into with trees and grass, in
the other direction. `build-star-relay.mjs` now resolves the plan to one tile per cell before
writing it, which is what an author painting in the editor means by "the last brushstroke is on
top". `play:star-relay` walks the rebuilt maps and its assertions are engine state, not files.

`clear_events` and `set_startup` are the other two adds here; both are used by that build, and
`clear_events` runs on all three maps of the acceptance game.

## B6 / B7 / B8 — the small ones

- **B6** is covered by the `ENGINE_READS` list above.
- **B7**: `make_encounter_zone` reuses a troop it already created under the same name and
  patches its `members` when they differ, instead of adding a fresh troop per build.
- **B8**: `map_connectivity` reports each map once and adds a flat `maps` list.

## B9, B10 — documented rather than changed

**B9**: `set_map_properties`' `name` is the MapInfos tree name and `displayName` is the in-game
banner; they are two fields in the file and two arguments here. Both are named that way in the
tool's own schema, which is where a caller reads it.

**B10**: the files are written as UTF-8 without a BOM, which is what MZ itself does — MZ reads
them with `JsonEx`, and the game is the consumer. What garbles Chinese switch and variable names
is PowerShell's default encoding on *read*, not the bytes in the file; `Get-Content -Encoding
utf8` shows them correctly. This is now stated in `ACCEPTANCE.md` rather than left to be
rediscovered.

## P2-2 — `live_status` semantics

`listening` now means *this process owns the port*: the bridge's `ensure()` is awaited instead
of fired and forgotten, so a server that failed to bind says `NOT LISTENING` with the reason
instead of reporting a healthy bridge with nothing attached. Two more warnings came out of the
same area: `STALE BRIDGE`, from a version handshake with the plugin (the copy in a project is
easily older than the copy the server ships, and that failure is invisible otherwise), and a
port with a listener but no poller. A page that reports but has not advanced a frame is
`STALLED`, and more than one document polling the same port is named.

## P3-4 — unknown command codes

Not a strict mode, and not silence. `set_commands`, `add_commands` and `validate_game` now warn
when a code is not in the dictionary read out of the engine's own `Game_Interpreter`, and say
what stops working for it: `decode_commands` can only print `code N`, and no parameter check
exists. A refusal would have been wrong — plugins add codes and the editor keeps whatever it is
given — so the write goes through and does not pass quietly. Measured against the demo project's
461 commands across 45 distinct codes: **0 trip it**, so the warning is not noise.

## P2-1 — done in 0.4.0, as `describe_tiles`

The tile dictionary the review asked for is in: for an id it answers slot (A1–A4 shape group
or fixed), the sheet the tileset binds to that slot, the layer MZ draws it on, the flags array
decoded into words — blocked from which directions, whether 0x10 makes those bits do nothing,
ladder / bush / counter / damage / vehicles, terrain tag — and how many cells of a given map
use it. Ask by map, by id list, by slot, or for the whole tileset.

`contactSheet` draws the labelled picture too, which is the half that cannot come from the
flags: one 3×3 block per id, rendered through the same autotile resolution as a real map, with
the id and the engine's own passability verdict printed under each block. It is drawn on a
scratch map that the call creates and deletes again, because resolving 48 shape ids into a
bitmap is the renderer's job and re-implementing it here would have been a second, worse copy
of the truth. The review's caveat about sampling a block's centre is right and is why the
sheet shows whole patterns rather than a pixel from each. Measured in `npm run e2e`: two ids
on the map come back with their cell counts, the wall reads `impassable / layer 3 / A4`, five
of the nine slots report `bound: false, sheet: null`, walking A2 yields base patterns 48 ids
apart, and the scratch map is gone again afterwards. The acceptance game writes its own three
sheets into `samples/star-relay/*-tiles.png` on every `check`.

## What 0.4.0 added beyond the checklist

The review's summary judgement was that the layer was usable but stopped short of *comfortable*.
Five more tools and two harness bugs later:

- **`make_map`** — the item the checklist did not name but the acceptance game did:
  `samples/star-relay/escape-hatches.json` said, in its own words, "no high-level tool makes a
  map" and "no high-level tool paints terrain". Six writes below the layer (three
  `create_map`, three `set_tiles`) — **eight** on a clean project, because the lamp game had
  already made the item and troop rows this game reuses, which is a census understating itself
  and is now fixed by construction. Both are in the layer now, and the same build measures
  **26 high-level calls and 0 writes below it**.
- **`make_item` / `make_battle`** — the other two reasons the file recorded
  ("no high-level tool authors database rows", "no high-level tool authors a one-off battle
  troop"). Effects and traits are compiled from words into the shapes the engine reads, and
  every state, parameter, common event, element, skill and type id is resolved against the
  project instead of assumed.
- **`live_dialog`** — driving dialogs was the layer's blind spot on the *playtest* side, and it
  cost a recorded run: `$gameMessage.isChoice()` is true while `Window_ChoiceList` is still
  fading in, and `Window_Selectable.isCursorMovable()` drops a cursor key sent before the
  window is open and active, so the harness's Down press picked option 1 while meaning 2. The
  old stuck-key defect had been hiding that by repeating the press until something gave way.
  `live_dialog` waits for the window, presses one edge at a time, re-reads the index after
  every press, presses through the line that asks the question, and refuses an option whose
  condition is off rather than buzzing it and timing out. Both playtests now use it.
- **A coverage table in the README**, scenario by scenario, with what is still deliberately
  below the layer (actors, classes, states, common events, tileset rows themselves: table rows
  with no cross-file shape to get wrong) and what is refused outright (resizing a map in place,
  because a map's tile-array length *is* its size).
- **The chain caught a second harness bug, and it is ours, so it is reported as one.** Giving
  the acceptance game's guardian to `make_battle` renamed its `Enemies` row, and
  `play:star-relay` failed "and it is the troop this game named" — the harness was still
  matching the *lamp game's* boss string that had been copied into it. Nothing was wrong in the
  service: the detail line shows the engine fighting the right troop at full health
  (`SR Relay Warden:60/60`). The check now resolves the guardian's name from the `Enemies` row
  when the harness starts, so a rename fails in the first beat with its real cause rather than
  in the twelfth with a misleading one.
- **A second harness bug, caught by the same chain**: `play:game` failed "the autorun ending
  fires on the village" with the player in the village, no message, and the switch not yet set.
  The ending opens with a `Show Picture` and a 30-frame `Wait`; the script probed once. It had
  been passing because an earlier `dismiss` loop happened to spend that time. The beat polls
  for up to 30 s now. Reported because "a verification that only passes when the machine is
  busy" is the kind of finding the review was for, even when the machine in question is ours.
- **`verify:package`** — a 14th suite that judges the *artifact*: `npm pack`, unpack, check the
  allow-list both ways, scan every shipped file for local paths and the token, then spawn the
  unpacked server and diff its 64 tool names against the working tree's. It found two things
  worth fixing before publishing: a fresh install has no command dictionary and nothing said so
  (three tools now name the command that builds it), and `initialize` advertised a hard-coded
  `0.1.0`. Recorded: **42 checks, ALL PASS**, 52 files / 309 kB.


## P3-1, P3-2, P3-3 — declined for now, with reasons

- **MCP resources**: the file layer already answers every read through a tool, and adding a
  second surface for the same data doubles the things that can disagree.
- **Fine-grained plugin text edits** (`apply_text_edit`): `read_plugin_source` plus
  `patch_plugin`'s anchored replacements cover the editing cases, and a line-number edit into a
  JS file that a playtest is about to reload is the kind of operation that needs a diff review
  nobody is doing here.
- **HTTP transport**: stdio-only is part of the security story — a token in a local process
  table, `127.0.0.1`, and commands delivered only to a poller that presents the token. A
  listening HTTP server is a different threat model and should not arrive as a side effect.

---

## Where the review's diagnosis needed a measurement

Three of its mechanism claims did not survive contact with a run, and one of its
characterisations was too soft on the code. All four are worth writing down, because the wrong
diagnosis sends the next person to debug the wrong layer.

1. `blur` as the primary cause of the dropped presses — real, simulated in the suite, and not the
   cause on this machine. The two that were: frame-vs-input-poll accounting, and the button that
   was never released.
2. "only `moveByInput` decrements the encounter counter" — it is `updateNonmoving`, and the rate is
   `encounterProgressValue()`: 1 per step, 2 on a bush tile, halved by Encounter Half.
3. "headless playtests run at ~9 fps" — a focused page measures 60 here. The ~9 fps is the hidden
   or throttled case, and it is the reason the timing is in frames, not the reason a press failed.
   Corrected everywhere it was stated as normal.

The review's `listening` complaint, by contrast, was exactly right: the field reported a bridge
that had never bound its port, because `ensure()` was fired and forgotten. It now means what it
says, and the refusal is named.

Two more arrived while building the 0.4.0 layer, and both are the same lesson — measure the
engine, do not recall it:

4. **A choice answers the option you did not pick is not a bridge bug.** The recorded 0.3.0
   `play:game` failure came from the harness trusting `$gameMessage.isChoice()`, which is true
   while `Window_ChoiceList` is still fading in; `Window_Selectable.isCursorMovable()` needs the
   window open *and* active, so the Down press was dropped and Ok confirmed whatever was under
   the cursor. It had been hidden by the stuck-key defect, which kept repeating the press until
   the cursor happened to land where it was meant. `live_dialog` waits for `isCursorMovable()`,
   presses one edge at a time and re-reads `index()` after each.
5. **`repeat` is not an MZ field.** A first cut of `make_item` mapped the caller's `repeats` onto
   `repeat` for Skills rows, because MV spells it that way. `Game_Action.numRepeats()` reads
   `this.item().repeats` (rmmz_objects.js:1504) for a skill too, and there is no `hits` field at
   all — so the "correction" would have written an inert key and silently left the real one at the
   template's value. The suite that caught it was the assertion `!("repeat" in storedSpell)`.
