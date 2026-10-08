# Tool defect ledger

Scope: every MCP tool surface defect I could demonstrate against a live MZ 1.8.1 install
(`Documents/Qoder/2026-10-07/fd83859b/lantern-bay`, 40x30 dock map with 9 events, one patrolling NPC,
plus a 13x9 interior reached by a generated 201 transfer). Method: real tool calls over stdio and the
browser test-play bridge, plus in-page engine probes. Where a claim is only read from source it says so.

This file supersedes the standalone `runtime_control-diagnosis.md` experiment log; the deep A/B numbers
for defect 1 live there.

Legend: **Fixed here** = code change in this build plus a test. **Open** = left alone on purpose, reason given.

---

## Tier 1 — fixed in this build

### 1. `runtime_control` blamed the map when MZ had frozen the scene (`Map did not settle`)

Symptom: `start_new_game`, `reload_map`, `teleport` and `move` failed with the bare string
`Map did not settle` while the game was visibly loaded and running.

Root cause is in the engine, not the bridge: `SceneManager.updateScene` calls
`this._scene.update()` only `if (this.isGameActive())`, and `SceneManager.isGameActive` is
`window.top.document.hasFocus()`. When the playtest window loses OS focus the scene stops ticking, so
`_fadeDuration`, `_transferring` and `isMoving` never advance — and `settled()`
(`plugin/MZVisualBridge.js`) expired its 160x30 ms budget against a frozen simulation.

The misleading part: `SceneManager.updateMain` increments `Graphics.frameCount` *before* the gate, so
frameCount keeps rising (~60 fps measured) and looks alive.

Fix, all in `plugin/MZVisualBridge.js`, scoped to `Utils.isOptionValid("test")` so a shipped game is
never touched:
- `SceneManager.isGameActive = () => true` while the bridge is loaded.
- A `sceneTicks` counter wrapped around `Scene_Base.prototype.update` as the honest liveness signal.
- `settled(what)` now reports the action and every blocking predicate plus focus/visibility/tick deltas.
- `move` stops early and states how many steps it completed, instead of running into the 15 s
  transport timeout in `src/runtime.js` (which drops the queued command while the game keeps walking,
  so a retry double-moves).

Measured before -> after, same session, `document.hasFocus()` forced false:
`start_new_game` FAIL -> PASS; `reload_map` FAIL -> PASS; `teleport` FAIL -> PASS;
`move steps=3` (2,8) -> (5,8) PASS. Reverting the override reproduces the failure, so the causality is
closed in both directions. New failure text, taken with a dialogue held open:

```
Map did not settle (teleport) in ~5s: scene=Scene_Map fade=0 wait=0 encounter=0 message=true
transferring=true moving=false focused=false visible=visible sceneTickDelta=296 frames=296
```

`sceneTickDelta=296` says the loop is fine and `message=true` says who is blocking it — the two things
the old message hid.

### 2. Unknown tool arguments were stripped silently, so writes lost intent

`src/server.js` had two `.strict()` calls in 76 tool registrations. Everything else ran zod's default
strip, so a key the tool never implemented was discarded and the call still reported success. The
concrete case: `put_event` has no `transfer` key, so `put_event(..., transfer: {...})` created the
event, returned `changed: true`, and the door led nowhere.

Fix: `register()` now wraps every raw shape in `z.object(shape).strict()`, so all 76 tools reject
unrecognized keys at the boundary. Test: `test/tool-surface.test.js` asserts
`additionalProperties === false` for every advertised schema and that a stray `tileId` on `put_event`
comes back as an error naming the key.

### 3. `put_event` could not generate a transfer that `makeEvent` already implemented

`src/project.js:makeEvent` has supported `transfer` (emitting the 6-parameter MZ 201) all along; only
the `put_event` schema omitted it. Fix: `transfer` added to `put_event` with the same shape as
`upsert_event`, plus the destination-cell validation `upsert_event` does (`point()` against the target
map), so a transfer to a coordinate outside the map is refused instead of writing a broken door.
Test asserts the emitted `{ code: 201, parameters: [0, 1, 6, 7, 2, 0] }`.

### 4. `pages` combined with `text`/`image`/`transfer` dropped the extra inputs

`makeEvent` replaces the whole page when `pages` is present, so the generated-command inputs vanished
without a word. Fix: refuse, and say which keys conflict and why. Test in `test/project.test.js`.

### 5. Event page validation did not say which page or field failed

`validateEvent` reported `event tileId must be integer 0..1023` / `Invalid image direction` with no
event or page context, which on a multi-page event is guesswork. Fix: messages are now
`event 7 page 1.image.direction must be 2, 4, 6 or 8` style, including list positions
(`event 8 page 0.list[3].parameters must be an array`). This is what makes hand-written pages
(chests, battles, self switches) debuggable in one round trip.

### 6. No Erase Event generator; the one that existed is a different command

`event_exit_event` emits MZ 115, which in MZ is Abort Event (`this._index = this._list.length`);
erase is 214. `214` appeared nowhere in `src/event-commands.js`, so a one-shot chest had to be written
as raw JSON. Fix: `eraseEventCommands()` plus a new `event_erase_event` tool, and the
`event_exit_event` description now warns that it does not erase. Also added to the server
`instructions` tool list. Test asserts 214 and 115 stay distinct.

### 7. `set_switch` / `set_variable` were write-only

`state()` in the bridge exposed player, events, windows and party but no switch/variable/self-switch
read-back, so the only way to confirm a write was to observe behaviour. Fix: `switches`, `variables`
and `selfSwitches` in every runtime state payload, capped at 64/64/32 non-default entries so the
65536-byte state limit in `src/runtime.js` still holds. Measured: after
`runtime_control set_switch id=1 value=true`, `runtime_status` returns `"switches": { "1": true }`.

### 8. `interact` and `input` reported success when no scene consumed the key

Both fire `Input.virtualClick` and return immediately. `Input.update()` does run while the scene is
gated (it is in `updateMain`, above the gate), so the rising edge was computed and then thrown away —
the tool still returned a state blob that looked fine. Fix: both now return
`consumed: <boolean>` from the scene-tick counter. Measured: `interact` facing the keeper returned
`consumed: true` and `messageBusy: true` with his two lines of dialogue.

### 9. Release packaging (fixed earlier in the same session, kept here for one ledger)

The 0.3.0 zip omitted `plugin/` (playtest page died with `Failed to load:
js/plugins/MZVisualBridge.js`), `bin/` (so `npm test` died on `local-config.js`), `examples/`,
`docs/`, `package-lock.json` and the license files. `bin/audit-release.js` now carries a required-file
gate, `.cjs` is an approved extension, and the gate is proven to reject the original zip (4 missing,
exit 1).

---

## Tier 1b — 0.4.0 layer-guardrail follow-ups (fixed in this build)

### 10. `stampWallShadow` left a stale dark mask wherever a wall had been erased

Symptom: painting a whole map with an A4 wall-side autotile and then carving rooms with
`tileId: 0` produced alternating light/dark vertical stripes across the new floor. Measured:
carved cells kept `layer 4 == 10` (right-half shadow) after the wall tile was gone, and
clearing layer 4 by hand removed the stripes immediately — which is what pinned the cause.

Root cause: the pass only ever wrote `10` (on a wall-side cell) and `5` (on the cell to its
right); nothing ever reclaimed those values, and `paint_tiles` reported `changed: true`
without saying layer 4 had been touched. This is shared code: `src/engine.js` is
byte-identical between the original 0.3.0 release and the patched 0.3.0, and both produce
the same render for this recipe (`sha256 ee36d7310ab0ce7c24cddbdba4c04fb630825718dd6679a09c6818006ad0f3d0`),
so it predates the 0.4.0 guardrails.

Fix: the pass now computes the desired value per cell (`10` if a wall-side tile is on layer
0 or 1, else `5` if the cell to the left is wall-side and this cell is not a wall, else `0`)
and reconciles toward it. Only `10` and `5` are ever reset, so hand-painted masks such as
`15` or `1` survive. Tests: `test/shadow.test.js` (reclaim + hand-painted),
`test/project.test.js` (fill-then-carve through `project.paint`, asserting `shadow == 0` on
the carved cell and on the cell that used to catch the cast).

### 11. Clearing a visual cell was impossible under the new sheet guard

`expectedSheet` was required for every layer 0..3 write, but `tileId: 0` belongs to no
sheet. Omitting the key failed inside the `anyOf` union as `Invalid input at
rectangles[0]` (the real reason was swallowed); supplying the truthful sheet failed as
`Tile 0 belongs to sheet B, not expectedSheet A4`. There was no accepted spelling of
"erase this cell", so carving had to be done by painting walls instead of removing them —
which is what triggered defect 10.

Fix: `expectedSheet` is optional in the schema and enforced in `project.paint` with two
precise messages — `expectedSheet is required for visual layer N` for non-zero tiles, and
`expectedSheet does not apply to tileId 0` for a false claim. `putground` follows the same
rule. Test asserts both branches.

### 12. Layer 4 changed silently

`paint_tiles` discarded `stampWallShadow`'s return value. Paint results now include
`shadowCells`, so a write that rewrote shadows is visible in the response.

## Tier 2b — still open in 0.4.0

1. **`move` returns before a touch-triggered transfer fires.** `settled()` is satisfied the
   frame the player stops on the trigger cell, while the interpreter reserves the transfer
   on the next frame, so `runtime_control move` reports the old map. Callers must re-read
   `runtime_status` after moving onto a `trigger: 1` tile. Fixing it properly means waiting
   for one interpreter tick, not just for the player to be idle.
2. **`put_event` / `upsert_event` cannot set `priorityType`.** A floor door needs
   `trigger: 1` **and** `priorityType: 0`; with the default `priorityType: 1` the event is
   solid and never fires. Because `pages` cannot be combined with the generated-command
   inputs (defect 4), the only route today is a hand-written full `pages` array. Either
   expose `priorityType`/`through` as top-level inputs, or accept `pages` together with
   them and merge.
3. **`analyze_map` reports `reachable: false` when the destination is an event cell**,
   without naming that as the reason; the `caveat` string covers it in prose. A
   `blockedBy: {eventId}` field would save a round trip.


## Tier 2 — open, with the reason

1. **Native test play mutates the project.** `native_playtest_start` requires
   `node bin/install-bridge.js --project <p> --enable`, which edits `js/plugins.js` and the plugin list,
   while the browser path injects the same plugin on the fly (`src/preview-server.js:81-84`) and leaves
   the project untouched. Recommendation: have `native_playtest_start` stage the plugin into its
   private copy the way the browser path stages `index.html`, so neither playtest route writes to the
   author's project. Left open because it changes the native runtime copy layout and needs its own
   verification pass on NW.js.
2. **Observer step presentation needs a visible panel.** `presentation.status` degrades to
   `pending_or_paused` when the browser panel is collapsed, because the acknowledgement is drawn from
   a `requestAnimationFrame` path. Same family as defect 1 — the service assumes a foreground page.
   Recommendation: acknowledge from the delta-applied callback rather than the paint callback, and keep
   "a human saw it" as a separate signal.
3. **`stamp_region` is misnamed.** It copies a rectangular layout between maps; region ids are
   `paint_tiles` with `layer: 5`. Renaming is a breaking change for existing callers, so the name
   stays and the description carries the correction.
4. **`runtime_control` forwards the whole argument object to the plugin**, including `sessionId` and
   `action` (`src/server.js:292`), which the plugin then ignores. Harmless, but it means an added
   argument silently becomes a plugin-visible parameter. Worth tightening to an explicit allowlist.
5. **No arbitrary-eval escape hatch by design.** The bridge's `state()` is a fixed allowlist, which is
   why defects 7 and 8 existed. The right direction is to widen the allowlist (as done here), not to
   add an eval endpoint.
6. **Qoder-side tool table refresh** (76 server tools vs the 41 shown earlier) is a client reload
   behaviour, not a package defect; it self-healed after one conversation round.

---

## Tier 3 — my authoring errors, not service defects

Recorded so nobody re-chases them as tool bugs: using MV's 115 where MZ needs 214; `scrollType: 1` on
a 13x9 interior (doubled rendering); one dialogue typo; four wrong argument shapes in the sweep
harness (`undo_map_edit` needs `mapId` + `expectedRevision`, `move_event`/`set_event_image` need
`editorId`, `event_variables` operand must be `{ type: "constant", value: n }`).

Two of my own earlier diagnoses were also wrong and are retracted here: "a patrolling event keeps the
map from settling" and "`reload_map` is refused by the same condition only `reload_map` can clear".
Both were the focus gate of defect 1. `Scene_Map.isBusy` never looks at other events.

---

## Corrections to `docs/TROUBLESHOOTING.md` (published as of 0.5.0; formerly the local note `常见bug.md`)

Item 2 ("失焦冻结") states that on focus loss `updateMain` stops entirely, "连 updateInputData 都不跑".
Measured otherwise: `Graphics.frameCount` advanced 42 in 700 ms while `_fadeDuration` stayed at 24,
which is only possible if `updateMain` ran — the gate is inside `updateScene`, so `updateInputData`
does keep running. That distinction is what makes defect 8 (input consumed by nobody) possible, and it
changes the triage order in item 4 of that file.

---

## Verification log for this build

```
RPG_MCP_ENGINE=<MZ install> npm test    -> 54 tests, 54 pass, 0 fail, 0 skip   (48 before the shadow work)
npm run check                           -> syntax checks passed: 40 JavaScript files
npm run audit:release                   -> passed: 63 source/document files
```

Shadow reconcile, proven as an A/B rather than by reading the diff. The striped-floor report was
reproduced against the **unpatched** package first: `src/engine.js` md5 was identical on both arms and
both renders hashed `ee36d7310ab0ce7c24cddbdba4c04fb630825718dd6679a09c6818006ad0f3d0`, with
`shadowAt(6,11) == 10` on a carved floor cell — i.e. the defect pre-dates every change in this document.
Then the same fill-then-carve recipe was replayed through a real `StdioClientTransport` against this
build (server on port 3797, scratch project, no author's project touched):

```
fillShadowCells    11    walls painted, shadows added
carveShadowCells  121    rooms carved, stale shadows reclaimed
carvedFloorShadow   0    the striped cell is clean now (was 10)
standingWallShadow 10    a wall that still stands keeps its own shadow
```

Hand-painted layer 4 values other than 0/5/10 are left alone (third shadow test), which is why
`carveShadowCells` is large without erasing deliberate masks.

Live cave chain (`lantern-bay`, Map003 26x20 tileset 4, server `--live-bridge`): the shore door
(Map001 event 10, `trigger 1 priorityType 0`, transfer `[0,3,2,10,6,0]`) moves the player onto Map003 at
(2,10); the chest runs `250,125,126,121,122,214` before its text so the second OK cannot re-trigger it;
the gate NPC (Map003 event 3, `111/115/412` on switch 1) read `"灯塔没亮，洞里不敢深走。"` with the switch
off and `"灯亮了。退潮时洞里能听见水声，你沿着东壁走。"` with `switches: {"1": true, "3": true}` read back
from `$gameSwitches._data`.

Runtime bridge (server `--live-bridge`, port 3790, session `fe297cdce4669d98d19d7e8f481aacd0`):
`start_new_game` PASS, `set_switch` PASS with `switches: {"1": true}` read-back, `teleport` PASS,
`interact` PASS with `consumed: true`, and a held dialogue now fails `teleport` with the predicate
report quoted in defect 1. All of these ran with `document.hasFocus()` forced false, i.e. in the exact
condition that previously produced `Map did not settle`.
