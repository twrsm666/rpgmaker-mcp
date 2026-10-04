# ACCEPTANCE — how to verify this server, and what was measured

This document is written for someone who does not trust the README: a reviewer, or another
model, grading the package against what it claims. Every claim below names the command that
settles it and the number that command printed. Nothing here is "look at the code and agree".

Shortest path to a verdict:

```bash
npm ci && npm run build && node scripts/extract-commands.mjs "<MZ install>/data/corescript"
npm run verify:full          # ~20 minutes; one exit code; per-suite timings
```

Exit code `0` and the line `VERIFY FULL PASS` mean all fourteen entries passed. Any other result
is a failure to grade, and the section for that suite below says what it proves, what the
reference numbers were, and how to tell a genuine regression from a machine that is not set
up (a missing token, an editor holding the project, a browser that is not installed).

---

## 1. What is being accepted

An MCP server that inspects and edits RPG Maker MZ projects through their real data files,
renders maps to PNG from your own installation's engine tables, and drives a **running** game
through a bridge plugin — plus a high-level authoring layer that composes those primitives
into one-call intents.

| Registry | Count |
| --- | --- |
| Primitives (read, write, database, plugins, assets, live bridge, `batch`) | 49 |
| High-level authoring and driving tools | 16 |
| **Total** | **65** |

`13,625` lines of TypeScript (the server and its in-process suites), plus `7,019` lines of harness
scripts under `scripts/` and a `1,051`-line bridge plugin, in ESM with zod v4 schemas and
`@modelcontextprotocol/sdk`. No engine or asset files are vendored: the autotile tables, tile-id
boundaries and command dictionary are read from *your* installation at runtime.

## 2. Prerequisites

- **Node 20+** (measured on v24.18.0), Windows or anything the MCP SDK runs on. `npm ci`.
- **An RPG Maker MZ project** — the folder containing `data/`, `img/`, `js/`. The editor must
  be **closed** while the server writes: MZ keeps the project in memory and overwrites
  external writes on its next save. Every suite that writes has a `undo_writes`/rollback path
  precisely because of this rule.
  A project **copied from the engine's `data/newdata` template** is a valid target and is what
  the README tells a first-time reader to use; it lacks one key the engine reads without a
  fallback (`System.advanced.windowOpacity`), so its game dies on the title screen with
  `reading 'clamp'`. Every suite that boots a game repairs that for itself before it boots and
  prints what it wrote, and `npm run fix-project` is the same repair on its own
  (`-- --check` to only report). `verify:newdata` deliberately does *not* repair first: it
  proves the template is broken, then proves the tool fixes it.
- **An RPG Maker MZ installation**, for `data/corescript` (renderer + command dictionary) and
  `data/samplemaps` (the renderer's reference PNGs). Licensing and activation are out of
  scope; the files are only read.
- **A Chromium-family browser** for the three headless suites. `live_session` finds
  msedge/chrome/chromium on Windows and macOS and launches it windowless; nothing here opens
  the editor or a visible window.
- **A bridge token.** Set `RMMZ_LIVE_TOKEN`, or put it in the registered server's `env` block,
  or in `.rpgmaker-mcp/live.env`. The same value must be the `Token` parameter of
  `plugin/RMMZLiveBridge.js` as enabled in the project — the scripts check that and refuse to
  start a playtest that would only get 401s.

Resolution order for project / corescript / token is identical in every script
(`scripts/local-env.mjs`): environment variable → the `mcpServers.rpgmaker.env` block in your
client's settings file (`RMMZ_SETTINGS` to override its location) → `.rpgmaker-mcp/live.env`.
No file in this repository contains a machine-specific path.

**The authoring suites write into the project you point them at.** `build:game` and
`build:star-relay` add maps, troops, items and database rows, and both move `System.json`'s
start position to their own opening map, because that is what a game needs to be playable.
They are re-runnable — maps, events and troops are found by name and rebuilt in place — but
they are not sandboxes. Point them at a project you do not mind painting, or copy one first:

```bash
cp -r "<your project>" ./verify-project     # then RMMZ_PROJECT=./verify-project
```

The tileset flag change `build:star-relay` makes is reported at the end of its run and is not
reverted, because reverting it would break the game it just built. Per-call reversibility is
what `write_history` / `undo_writes` / `rollback_data` are for, and `smoke:chain` exercises
them against your project on every run: it creates a `SMOKE-MAP`, writes into it, and leaves
nothing behind.

What a full run leaves in the project, on purpose: the lamp game's maps, Star Relay's three
maps (`SR Keeper's House`, `SR Village`, `SR Relay Cave`) with `System.json`'s start position
pointing at the house, and two scratch maps the file-layer suites reuse — `MCP-SELFTEST` and
`E2E-MAP`. Everything the suites make transiently (batch scratch maps, troops they created,
`SMOKE-MAP`) is removed by the suite that made it; `e2e` reuses its scratch maps instead of
adding a numbered copy each run, which is why those two names stay.

## 3. The one command, suite by suite

`npm run verify:full` (`scripts/verify-full.mjs`) runs, in this order:

| # | Suite | What it settles |
| --- | --- | --- |
| 1 | `tsc` | The package compiles. Hard prerequisite: if it fails nothing else runs. Skipped, with a printed reason, when the tree has no `src/` — which is what an `npm pack`ed install looks like, so the chain is runnable from the artifact too. |
| 2 | `e2e` | Every one of the 65 tools against the real registry, over a real MCP client, on the file layer: project info, maps, tiles, cells, events, command decoding, database, plugins, assets, connectivity, rendering, the high-level layer, `batch` transactions, the write journal and its undo. Cleans up its own scratch maps. Its later assertions read the acceptance game's maps by name, so on a project that has never held them it prints `skipped: needs the acceptance game` and exits 0 — having written nothing — rather than failing two checks and then dereferencing `undefined`. |
| 3 | `roundtrip` | Parse + re-serialise reproduces the editor's bytes exactly for every data file. This is the guard against a write producing a whole-file diff. |
| 4 | `fidelity:sweep` | The compositor against the editor's own preview PNGs for every sample map in your installation, cell by cell. |
| 5 | `e2e:live` | The live bridge against a real running engine: state reports, `live_eval`, waits, keys, walking, reload, screenshots, diagnostics, auth refusals, oversized payloads, queue ordering, port failure and recovery — and that a finished press leaves no button down. |
| 6 | `verify:input` | Keys and walking proven in a running game the script built for itself: 40 checks, ALL PASS. 10 of 10 direction presses move exactly one cell at both the default 2-poll hold and a wall-clock-sized one; no arrow is left held afterwards; `live_move` walks 6 cells and the party's step counter and encounter counter move with it; a walk into the border stops at once and names the wall; a two-page `make_npc` is *talked to* — page 1 speaks, sets the self switch, the engine switches its page, page 2 speaks; `delete_map` refuses the map a door still points at, honours `dryRun`, and takes the scratch maps away at the end. |
| 7 | `verify:newdata` | A throwaway copy of the engine's own `data/newdata`, taken all the way to a finished game rather than to "it boots". `validate_game` reports the missing `System.advanced.windowOpacity`; `enable_plugin` puts the bridge into `js/plugins.js`; the unpatched template is booted and stops drawing frames at 3 on the title screen with `Cannot read properties of undefined (reading 'clamp')` — and the session now *says* that instead of waiting out its timeout. `fix_project` then writes the key, changes nothing when re-run, and the same boot reaches `Scene_Map`. Then the suite spawns the chain's own `build:game` and `play:game` against that copy by environment variable alone, and asserts the four maps landed in the copy, that the scripts printed which project they used, and that the registered project's `MapInfos.json` is byte-for-byte what it was. |
| 8 | `session:e2e` | `live_session` owns the whole loop: start, boot, frame, `batch` paint that then fails and rolls back **under the running game**, reload, stop, and nothing left polling or holding a port. |
| 9 | `build:game` | The lamp game ("还灯 · Return the Lamp") authored through the tools. |
| 10 | `play:game` | That game played to its credits in a headless runtime. |
| 11 | `build-star-relay` | The acceptance game, authored with **high-level tools only**. |
| 12 | `play:star-relay` | It played through, 14 beats, engine-state assertions only. |
| 13 | `census` | The claim about the high-level layer, made reproducible. A throwaway copy of the shipped `data/newdata` is made, `build-star-relay` runs against **only that copy** — no map, item or enemy from the author's project — and the census it writes is read back and gated: the number of high-level calls, **zero** low-level writes below them (the gate fails the run, it is not a footnote), and the reads it asked for. `-- --play` additionally runs the real playtest harness inside the copy. Before this suite existed the number could only be read by running the builder against the author's own project, which is exactly the starting point an outside reviewer does not have. |
| 14 | `smoke:chain` | The command your MCP client actually recorded, spawned fresh and driven end to end, writes undone at the end. The read and write sections work on the acceptance game's maps and tilesets, so on a project without them it reports the registry, `project_info` and `list_maps`, prints `n/a` with the reason, and exits 0. |
| 15 | `verify:package` | The **publishable tarball**, not the working tree: `npm pack` → unpack → the `files` allow-list is checked both ways (every entry you meant to publish is there; no project data, engine codebook, `samples/` or your token is) → every shipped text file is scanned for this machine's paths → the unpacked `dist/index.js` is spawned as its own process and its `tools/list` must equal the working tree's name for name → its `initialize` version must equal `package.json` → three real calls go through it. This is the only suite that can see a file missing from `files`, which is otherwise a bug you meet after `npm publish`. |

Suites keep to their own bridge ports so they can never fight: 3789 registered server,
3791 `live_session`, 3792 lamp game, 3793 `e2e:live`, 3794 Star Relay (3795 for the optional
session-lifecycle probe), 3797 `verify:input`, 3798 `verify:newdata`, 3800 `census`, and
3796/3799 for the build and playtest that `verify:newdata` spawns against its own project copy. Each script
stops the browser it started, so a failure halfway through leaves nothing holding a port.

## 4. Reference numbers from the recorded runs

### 0.4.2 — recorded 2026-10-04, same machine, same project

The third review round's two findings plus the claim it would not grade without a command. The
registry is unchanged (**65**); what changed is what the tools do on a project that is not the
author's. A "check" is still a printed `PASS` line, so `grep -c '^  PASS'` on your own log
reproduces every number here.

| Suite | Measured | Notes |
| --- | --- | --- |
| `verify:full` | **VERIFY FULL PASS — 15 of 15, exit 0** | 1166 s end to end, zero `FAIL` lines: tsc 0 s, `e2e` 272 checks 13 s, round-trip 0 s, `fidelity:sweep` 104 maps 33 s, `e2e:live` 39 checks 31 s, `verify:input` 40 checks 30 s, `verify:newdata` 21 checks 502 s, `session:e2e` 39 checks 23 s, `build:game` 2 s, `play:game` 45 checks 358 s, `build-star-relay` 9 s (28 high-level calls, 0 writes), `play:star-relay` 48 checks 148 s, `census` 5 checks 9 s, `smoke:chain` 34 calls 4 s, `verify:package` 50 checks 4 s |
| `census` | **25 high-level calls, 0 low-level writes, 3 reads**, ALL PASS | the round's point, and the command the reviewer asked for: the acceptance game built into a copy of the shipped `data/newdata` needing nothing from any other project. With `-- --play`, that same copy **played through: 48 PASS / 0 FAIL, exit 0**. The author's project reports 28 — the three extra calls are the `clear_events` a repaint needs and a first create does not |
| `e2e` | **272 checks, ALL PASS**, registry snapshot exactly **65** names | +3 net over 0.4.1: three new `itypeId` assertions (a healthy project gets no type warning, `itypeId` 5 is named as unreachable, a *spelled* item type is refused with the MZ explanation) and one that no warning may interpolate an object; and its first check now asserts the server resolved the project **this run asked for**, instead of comparing `projectDir` to the literal `demo-project` |
| `verify:input` | **40 checks, ALL PASS**, on a **pristine template copy** with nothing hand-patched | R1's criterion, run as the reviewer wrote it: the suite printed `fix_project wrote ["System.advanced.windowOpacity"]` and then passed all 40 (it was 6 PASS / 2 FAIL before the shared repair step). Log in the round-4 bundle's `evidence/r1-verify-input-on-fresh-copy.log` |
| `e2e`, `smoke:chain`, `verify:package` on a foreign project | skip / `n/a` / **ALL PASS**, all exit 0 | R2's criterion: against an untouched template copy `e2e` prints `skipped: needs the acceptance game` and writes nothing, `smoke:chain` reports the registry and marks the game-bound half `n/a`, and `verify:package` — which had failed 2 of 46 — passes all 50 by reading whichever map the project has. No `TypeError` anywhere |
| `play:star-relay` | **48 checks, ALL PASS**, 148 s (was 207 s) | faster because its encounter troop is now one enemy the shipped template actually has rather than two including an id only this project had grown. Its region beat no longer asserts a single RNG draw: it walks until a battle arrives within four passes and prints how many (this run: pass 1, 18 steps) |
| `fix-project` | `-- --check` exits 1 naming the key; repair exits 0 having written it; a second run writes nothing | measured on a template copy: `advanced` goes from 9 keys to 10 with `windowOpacity: 192`, and nothing else in `System.json` moves |


### 0.4.1 — recorded 2026-10-04, same machine, same project

The second review round's seven findings, plus the two defects the new coverage found by
itself. A "check" is still a printed `PASS` line; `grep -c '^  PASS'` on your own log
reproduces every number here.

| Suite | Measured | Notes |
| --- | --- | --- |
| `verify:full` | **VERIFY FULL PASS — 14 of 14, exit 0** | 1185 s end to end, zero `FAIL` lines: tsc 0 s, `e2e` 269 checks 12 s, round-trip 0 s, `fidelity:sweep` 104 maps 33 s, `e2e:live` 39 checks 31 s, `verify:input` 40 checks 30 s, `verify:newdata` 21 checks **485 s**, `session:e2e` 39 checks 22 s, `build:game` 2 s, `play:game` 45 checks 343 s, `build:star-relay` 9 s, `play:star-relay` 48 checks 210 s, `smoke:chain` 34 calls 4 s, `verify:package` 46 checks 4 s |
| `verify:newdata` | **21 checks, ALL PASS**, 485 s (was 12 checks / 161 s) | the round's point: a copy of the engine's `data/newdata` is booted and watched to die at frame 3 (`clamp` on a missing `advanced.windowOpacity`), repaired by `fix_project`, booted again into `Scene_Map`, then built into and played through as a real game by the chain's own `build:game` + `play:game` — **45 PASS / 0 FAIL inside it** — with the registered project's `MapInfos.json` byte-identical before and after |
| `e2e` | **269 checks, ALL PASS**, registry snapshot exactly **65** names | +11 over 0.4.0: `System` answers `entries` as well as `value`; a partial nested patch names the nine `advanced` keys it lost and a complete one says nothing; `fix_project` on an editor project plans nothing and writes nothing; a Show Picture naming a missing file is an error whose fix line says a `.jpg` will not load; `import_asset` refuses one into `img/pictures`; `enable_plugin` takes `"RMMZLiveBridge.js"` without appending a second `.js` |
| `verify:package` | **46 checks, ALL PASS**, 53 files / ~408 kB — the sha256 of the tarball you are reading this from is in the handoff bundle's `MANIFEST.json` | the published registry is the working tree's name for name at **65**, `all 16 high-level calls survive the pack`, the packed README tells the installer `npm install` (npm strips `package-lock.json` from a pack, so `npm ci` has nothing to work from — the first command in 0.4.0's runbook), no `prepare` hook, the advertised `main`/`bin` present, and `assets/lighthouse-night.png` in the tree so the acceptance game's ending needs nothing outside the package |
| `build:star-relay` | **27 high-level calls, 0 writes below the layer**, 3 reads | was 26; the extra call is `fix_project`, which the build now makes before it writes anything. `samples/star-relay/escape-hatches.json` is still an empty write list |
| `session:e2e` | **39 checks, ALL PASS** (was 36) | the three new ones are D6: a session record naming a live pid that is *not* the browser it records (this script's own pid, borrowed) is reported as stale, does not refuse a new session, and is replaced by the record of the one that is actually up |
| Fail-fast, measured | the unpatched boot returns in one poll instead of 120 000 ms | `live_session {action:"boot"}` came back with `"The engine stopped its own game loop, which it does when a frame throws, so no map is coming. Captured error: TypeError: Cannot read properties of undefined (reading 'clamp')…"` — 0.4.0 waited out the timeout and said only "Still not on a map after 120000ms." |
| Two defects the new chain found | the ending picture, and the animation folder | `build-lightrun` reached outside the repository for its picture, and the fresh copy's `.jpg` could never load (`loadBitmap` appends `".png"`, v1.8.0 `rmmz_managers.js:919`) — the playtest logged it at the credits. Separately `check_assets` resolved `Animations[].effectName` against MV's `img/animations/`; MZ plays `effects/<name>.efkefc` (`EffectManager.makeUrl`, `rmmz_sprites.js:1244`). Both fixed, both asserted in `e2e` |

### 0.4.0 — recorded 2026-10-03 → 10-04 on the same machine

The five new tools each carry their own assertions, and the two playtests were rewired onto
`live_dialog` rather than keeping their hand-rolled key loops. A "check" below is a printed
`PASS` line, so these counts are reproducible with `grep -c '^  PASS'` on your own run.

| Suite | Measured | Notes |
| --- | --- | --- |
| `verify:full` | **VERIFY FULL PASS — 14 of 14, exit 0** | 793 s end to end: tsc 1 s, `e2e` 258 checks 12 s, round-trip 0 s, `fidelity:sweep` 104 maps 31 s, `e2e:live` 39 checks 31 s, `verify:input` 40 checks 29 s, `verify:newdata` 12 checks 161 s, `session:e2e` 36 checks 22 s, `build:game` 2 s, `play:game` 45 checks 320 s, `build:star-relay` 8 s, `play:star-relay` 48 checks 169 s, `smoke:chain` 34 calls 3 s, `verify:package` 42 checks 4 s |
| `verify:package` | **42 checks, ALL PASS**, 52 files / 309 kB | the tarball, unpacked and spawned on its own, lists the same **64** tool names as the working tree, advertises `0.4.0` in its handshake, and answers three real calls. It found two things the working tree could not see: a fresh install has no command dictionary and nothing said so (now `project_info`, `decode_commands` and `command_catalog` each name the command that builds it), and `initialize` was advertising a hard-coded `0.1.0` |
| `e2e` | **258 checks, ALL PASS**, registry snapshot exactly **64** names | 44 of them are the new tools: the doorway with no wall under it, a repaint clearing last run's roof, `dryRun` leaving the file byte-identical, the effect `{code,dataId,value1,value2}` vs trait `{code,dataId,value}` pair, the three drop slots, a troop holding the foe *this call made*, the labelled sheet and its scratch map deleted again |
| `make_item` on this project | Skills row writes `repeats: 3`, not MV's inert `repeat` | `Game_Action.numRepeats()` reads `item().repeats` (rmmz_objects.js:1504) — measured against the corescript, not from memory |
| `build:star-relay` | **26 high-level calls, 0 writes below the layer**, 3 reads | was 19 calls / 6 writes (8 on a clean project); `samples/star-relay/escape-hatches.json` is now an empty write list, and three labelled `*-tiles.png` sheets come out of `check` |
| `play:star-relay` | **48 checks, ALL PASS**, after one harness fix | the *first* 0.4.0 chain was 12 of 13: "and it is the troop this game named" still matched the lamp game's boss string, while moving the guardian to `make_battle` had renamed the row. The harness now resolves that name from `Enemies` when it starts, so a rename fails in beat 1 with its real cause. No service code was involved — the detail line showed the engine fighting `SR Relay Warden:60/60`, the right troop, all along |
| `play:game` | the cat's second option, chosen and proven | `chose 问它灯塔的事 in 2 press(es): down, ok` — the check that failed on the 0.3.0 run. The old failure was a key sent to a `Window_ChoiceList` that was still fading in |
| `play:game`, the ending beat | caught and fixed a race in the harness itself | one chain failed `the autorun ending fires on the village` with the player standing in the village, no message, switch not yet set: the ending's first act is a `Show Picture` and a 30-frame `Wait`, and the script probed exactly once after the transfer. It passed before only because an earlier `dismiss` loop happened to burn that time. The beat now polls for up to 30 s (`waitEnding`) — the game was never wrong, the reading was too early |

### 0.3.0 — recorded 2026-10-03, Windows 10.0.26200, Node v24, RPG Maker MZ 1.8.1 corescript

The suites the review asked for were run on their own before the whole chain, and each number
below is what that run printed. `samples/` holds the logs of the author's own runs and is not
published, so re-run the command to compare — `npm run verify:input` and
`npm run verify:newdata` take about four minutes each and need the token, the project and the
engine install, nothing else.

| Suite | Measured | Notes |
| --- | --- | --- |
| `verify:input` | **40 checks, ALL PASS** | 10 of 10 presses per hold size, no arrow left down, `live_move` steps and encounter counter, honest wall stops, the two-page NPC talked to in the running game, `delete_map` refuse/dryRun/force |
| `verify:newdata` | **12 checks, ALL PASS** | unpatched template stops at frame 3 with the `clamp` TypeError; `enable_plugin` installs; patched boots to `Scene_Map` map 1 at (8,6), 121 frames in 2 s |
| `e2e:live` | **ALL PASS**, with the page reporting bridge v0.4.1 | includes the new "a finished press leaves no button down" |
| `e2e` | **ALL PASS**, registry snapshot exactly 59 names | 64 names as of 0.4.0 |
| `build:star-relay` | 19 high-level calls; **6 writes** below the layer (3 `create_map`, 3 `set_tiles`) + 8 reads | was 17 / 40; `samples/star-relay/escape-hatches.json` |
| page rate on a focused headless page | **59.9 – 60.5 frames/s** | the ~9fps in older notes is a hidden or throttled tab |

### 0.2.0 — recorded 2026-10-03 on Windows 10.0.26200, Node v24.18.0, RPG Maker MZ 1.8.1 corescript, a
15-map project. Fill in your own numbers next to these when you grade it.

| Suite | Measured | Wall | Notes |
| --- | --- | --- | --- |
| `verify:full` (11 suites) | **VERIFY FULL PASS, exit 0** | **712 s** | the order is the contract; see the table above |
| `tsc` | clean | 0 s | |
| `e2e` | **214 checks, 0 failures** | 9 s | includes the exact registry snapshot (54 names) |
| `roundtrip` | **round-trip identical for all files** | 0 s | every `data/*.json` in the project |
| `fidelity:sweep` | **104 maps compared, all match; median 0.98/255, p90 1.46, worst map 5.69** | 31 s | 4 of 35 parallax maps differ only where the parallax shows through (`Map077`=119.9, `Map010`=33.7, `Map100`=6.8, `Map087`=6.5) — named, not failed |
| `e2e:live` | **32 checks, 0 failures** | 28 s | this is where A1–A6 are proven, against a real v1.8 runtime |
| `session:e2e` | **36 checks, ALL PASS** | 22 s | includes the `batch` rollback under a running game, and a clean stop |
| `build:game` | ok | 2 s | the lamp game authored through the tools |
| `play:game` | **45 checks, ALL PASS, 9 frames** | 378 s | played to its credits |
| `build:star-relay` | **17 high-level calls; 40 low-level writes recorded as escape hatches (+11 reads)** | 7 s | `samples/star-relay/escape-hatches.json` |
| `play:star-relay` | **14 beats, 47 checks, ALL PASS, 98 battles entered, 7 frames** | 234 s | every assertion is engine state |
| `smoke:chain` | **34 calls, 32 checks, ALL PASS, 1 open finding** | 1 s | slowest: `make_chest` 160 ms, `link_maps` 137 ms, `make_npc` 127 ms; everything else ≤ 20 ms |

## 5. Grading the bug fixes one by one

Each row names the check that now exists. You can confirm them by watching `e2e:live` and
`session:e2e` output, or by re-running the scenario yourself.

| Bug | Symptom before | The check that now holds |
| --- | --- | --- |
| A1 body caps | A full-screen `live_screenshot` was refused "payload too large" because the 4 MB command cap also applied to `/result` | `e2e:live`: a state report over its limit is rejected *by name*, and the same size arriving as a result is accepted |
| A2 `live_eval` timeout | The plugin waited 20 s for a settled promise while the server's default cut off at 8 s | `e2e:live`: a 12 s promise returns its value; the call takes 12 s, not a failure at 8 s; `timeoutMs` still raises the ceiling |
| A3 `live_key` arithmetic | 20 pulses × 30 frames ≈ 66 s on a throttled page exceeded the timeout the tool itself computed | `e2e:live`: the bridge's measured fps sizes the budget; a 15-frame hold lands correctly; a frozen page fails in seconds naming how many presses it scheduled |
| A4 latched listen error | If 3789 was busy on the first call the bridge was dead for the process lifetime | `e2e:live`: a taken port reports the failure, and once the port is free the bridge listens again |
| A5 unauthenticated state | Any local process could push `/state`; a token mismatch left state arriving but commands silently refused | `e2e:live`: wrong token on `/state` → 401, `authError` names the imposter, `rejectedPolls` counts it, the forgery never becomes the reported game, and a result pushed without the token is refused too |
| A6 command concurrency | One command dequeued per poll while results returned async, so two queued evals could overlap | `e2e:live`: the queued write runs before the queued read, and the queue is empty afterwards |
| A7 teardown | Strays were matched by executable name (non-Edge Chromium families leaked) and a synchronous CIM query blocked the event loop for seconds | `session:e2e` plus `node scripts/probe-session-lifecycle.mjs`: after `stop`, only the recorded pid tree is gone and the bridge stops receiving polls |
| A8 registry assertion | `e2e` asserted only "at least 20 tools" | `e2e`: the tool-name list must equal the snapshot exactly — missing and unexpected names are printed |

## 6. Grading the high-level layer

The layer is sixteen tools. The first ten were `make_npc`, `make_choice_scene`, `make_chest`,
`make_shop`, `make_encounter_zone`, `link_maps`, `set_tileset_flags`, `validate_game`,
`clear_events` and `set_startup`; 0.4.0 added `make_map`, `describe_tiles`, `make_item`,
`make_battle` and `live_dialog`, and 0.4.1 added `fix_project`. Three properties matter and
all three are covered by `e2e`, with the last two also run for real by `verify:input` and
`build:star-relay`:

1. **One call, one transaction, with proof.** Each answers with the `render_map` PNG of every
   map it touched plus a structured diff. If a later part fails, earlier files go back to the
   bytes they had.
2. **Refusals are loud.** A cell that cannot be stood on, a database row that does not exist,
   an indent shape the engine will not run, a shop good that would be free, a page condition
   MZ cannot express — each is refused with the call that would fix it, not written silently.
3. **Escape hatches are counted, and the count is a command.** A build that needs `script` or
   `raw` gets `escapeHatches` in its reply. `npm run census` builds the whole acceptance game into
   a copy of the shipped `data/newdata` — no map, item or enemy from any other project — prints
   how many high-level calls it took and how many writes the layer could not make underneath
   them, and **fails if that second number is not zero**, so the claim in these documents is
   something you can run rather than something you have to trust. `-- --keep` leaves the copy and
   its `escape-hatches.json` on disk; against the author's own project the same file is written to
   `samples/star-relay/escape-hatches.json`, which is git-ignored because it sits beside rendered
   previews of copyrighted tilesets.

`link_maps` deserves its own check because it was wrong before: a transfer used to park the
player **on** the far door's own cell. The measured behaviour now is that they arrive at the
first open cell beside it, facing away, and `e2e`, `smoke:chain` and `play:star-relay` all
verify it — the reply's `landed`, the `201` parameters in the map file, and where the player
actually stands in the running engine agree. (Landing on the threshold does not re-fire a
touch door — the engine leaves the player stationary — but it does mean two presses are
needed to step back off it, which is the reason for the change.)

Autorun hygiene, found by playtest rather than by reading: an `autorun` page that sets no
switch, no self switch and does not erase itself re-arms every frame and the player cannot
move on that map. `make_choice_scene` now warns when it writes one, `validate_game` reports
one it did not write, and `play:star-relay` proves the released version lets the player walk.

## 7. The chain smoke, and the one thing only it can show

`npm run smoke:chain` does not import `dist/index.js`. It reads your client's settings file and
spawns **that** command, args and environment over stdio, then:

- lists the registry (65 tools, all descriptions meaningful);
- reads: maps, cells, slots, events, decoded commands, catalog, database, plugins,
  connectivity, assets, whole-project validation, a rendered passage PNG;
- writes a scratch map — `create_map`, `set_tiles`, `make_npc`, `make_chest`, `link_maps` —
  then compares the promised landing against the bytes in the file, fails a `batch` on
  purpose and checks its first step went back, then `undo_writes` all the way to where the
  section started and verifies the map file is gone from disk and out of `MapInfos.json`.

What it showed about a **live** client is the single most useful finding in this release: a
server process that has been running since before the layer was built keeps serving the tool
list it read at startup. Measured on this machine: the in-session connection reported **46**
tools and none of the eight high-level ones, while the same command spawned fresh reported
**54** with all eight. `npm run build` is not enough — reload the server (`/mcp reload` in
Qoder) after rebuilding, and confirm with `smoke:chain` before believing "the tool is missing".

## 8. Known gaps, stated plainly

- **Unknown command codes are accepted, now with a warning.** `set_commands` validates the
  parameter shape of every known code and refuses a wrong one (measured: `Command 101
  parameters must be [faceName:string, faceIndex:number, background:number,
  positionType:number, speakerName:string], got [0,0,0,"Still here."]`). A code the engine has
  no method for — the probe used `9999` — is still written, because plugins do add codes and
  the editor keeps whatever it is given. What changed is that it no longer passes silently:
  `set_commands`, `add_commands` and `validate_game` name the code and say what stops working
  for it (`decode_commands` can only print "code N", and no parameter check exists). Measured
  against the demo project's own 461 commands: 0 of them trip the warning, so it is not noise.
- **A few suites read the acceptance game's own content, and say so when it is not there.**
  `e2e`'s later sections, `smoke:chain`'s read and write sections and `play:star-relay` name maps,
  troops and tile ids that the game's builders lay down, so on a project that has never held them
  the first two skip with a named reason and exit 0 rather than failing obscurely. The portable
  half of the same proof — the fresh-project path, the high-level layer end to end, and the
  census — is `verify:newdata`, `census` and `verify:input`, which need nothing but an MZ
  installation and the token. This is a boundary, not a gap: the game is the fixture.
- Closed in 0.4.0: **the tile dictionary and contact sheet** (`describe_tiles` answers slot,
  bound sheet, draw layer, decoded flags and cell usage per id, and can draw the labelled
  sheet on a scratch map it deletes again), **map creation and terrain in one call**
  (`make_map`; the acceptance game's six below-layer writes became 0), **database rows the game
  plays on** (`make_item` for Items/Weapons/Armors/Skills, `make_battle` for the foe and its
  troop), and **driving a dialog** (`live_dialog`, which waits for `isCursorMovable()` instead
  of assuming a queued choice can already take a key).
- Closed in 0.3.0, and each was a gap here until it was: terrain painting (`set_tiles` takes a
  whole plan and places each tile on the layer its slot belongs to — Star Relay's 24 writes
  became 3), a map's event rebuild (`clear_events`; 14 `remove_event` calls became 0), the
  opening state (`set_startup`; 2 `patch_database_entry` calls became 0), a map that should not
  exist (`delete_map`), and installing a plugin file (`enable_plugin`).
- **Not in, and not planned for this release**: MCP resources (a read-only `map://` view of the
  project rather than a tool call per question), partial text edits of plugin sources (the
  whole-file `write_plugin_source` plus `patch_plugin` is what exists), and an HTTP transport
  (stdio only, which is what the local-token security story assumes).
- **There is no editor automation, and there will not be.** See
  `src/bridge/FINDINGS.md`: MZ's editor is native Qt/QML with JavaScriptCore, which has no
  CDP; the substitute is the file layer plus `live_reload` inside a playtest.
- **Frame rate is not a constant.** A focused headless page measures 60fps here; a hidden or
  background-throttled tab runs near 9, and a loaded machine lands between. Nothing in the
  suites trusts a millisecond: holds are counted in input polls, waits in `Graphics.frameCount`,
  and a page that stops advancing frames reports that in words instead of timing out.

## 9. What is deliberately not in this repository

- Any RPG Maker project or asset. `samples/` is git-ignored: its PNGs are composites of
  copyrighted tilesets and its logs contain local paths.
- `src/codebook/commands.json`, generated from your installation by
  `node scripts/extract-commands.mjs`; it embeds function bodies from a proprietary runtime.
- `.rpgmaker-mcp/` — write backups, browser profiles, and the optional hand-made `live.env`.

If you publish this package, publish those rules too: they are the reason it is safe to put
an MCP server for a commercial editor on GitHub.

## 10. Before you call a failure a failure

Five environmental causes have accounted for every confusing run while this was built:

1. **The editor is open.** MZ keeps the project in memory and overwrites what the server wrote
   on its next save. Symptoms: a write looks like it did nothing, or a playtest shows the old
   map. Close the editor, then `live_reload` or start a new game.
2. **You are talking to a stale registered server.** After `npm run build`, the process your
   client keeps alive is still the old code, so tools added since then are simply not in its
   list — measured three times here: **46 tools in-session against 54 from the same command
   spawned fresh**, then **54 against 59** after the 0.3.0 tools landed, then **59/64 against 65**
   after `fix_project`. Reload the server
   (`/mcp reload` in Qoder) and confirm with `npm run smoke:chain` before believing "the tool
   is missing". The live half of the same trap is the *plugin*: `live_status` compares the
   bridge version the page reports with the one in `plugin/` and says `STALE BRIDGE`.
3. **Token mismatch.** If the plugin's `Token` parameter is not `RMMZ_LIVE_TOKEN`,
   `live_status` shows `authError` naming the imposter and `rejectedPolls` climbing, and every
   live command is refused. The scripts check this before booting and say so on one line.
4. **Two suites on one port.** Start them one at a time. A second server on a port another
   process owns refuses to bind and says so — `Live bridge could not listen on
   127.0.0.1:3794: ... Another process has that port, most likely another copy of this
   server` — which is the correct answer, but every later call in that run repeats it, so a
   run started while its predecessor is still finishing reads as thirteen failures that are one.
5. **You set `RMMZ_PROJECT` and the scripts wrote somewhere else.** Until 0.4.1 that was the
   bug rather than the diagnosis: the registered entry's environment was merged *after*
   `process.env`, so the project in your client's settings file won and nothing said so — the
   round-2 reviewer spent a long stretch on it and briefly filed the service as "reports
   success, writes nothing". Now the caller wins and every scripted suite prints
   `project <path> (from …)` on its first line, with a second line when the environment and the
   registration disagree. Read that line before reading any failure.

Then the timing one: a focused headless page draws **60fps** here (measured 59.9 and 60.5
frames/s in `verify:input`), but a hidden or background-throttled tab runs near **9fps**, and
the software renderer on a loaded machine can drop between the two. Every timing in the suites
is therefore counted in frames rather than milliseconds, so a beat that involves walking still
takes tens of seconds and a whole playtest is minutes, not seconds. `verify:full` finishing in
a quarter of an hour is normal. A suite that goes quiet for minutes *inside* a section is
not — `live_diagnostics` and that suite's own output will say which page it is waiting on.

## 11. How to record the verdict

Per suite: the command, the exit code, the check counts, and anything surprising in the output.
The rule this work was run under, and the one worth keeping: **a gate is not done because the
code reads correctly — it is done because a run is recorded.** Every number in section 4 came
from a single `npm run verify:full` invocation.
