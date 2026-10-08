# Changelog

Notable changes to `rpgmaker-mcp`, newest first.

**About the two lines.** Up to `0.4.2` this repository shipped a TypeScript
implementation (65 tools, `dist/` compiled from `src/*.ts`, `@napi-rs/canvas`
renderer). `0.5.0` replaces it with the visual-first JavaScript implementation
that has been developed in parallel: **78 tools**, a browser-based renderer that
composites the project's own tileset PNGs, a live step-by-step editing observer,
event-command builders and real playtesting. Nothing was silently dropped — the
previous README, changelog, acceptance runbook, release checklist and review
response are preserved verbatim under
[`docs/legacy-0.4.2/`](docs/legacy-0.4.2/), and the old code stays reachable in
git history at tag `v0.4.2`.

## 0.5.0 — 2026-10-08

- The published implementation is now the visual line: plain ES modules, no build
  step, no native canvas dependency. `npm ci && node src/server.js --project …`
  is the whole install. Rendering runs in a locally installed Chromium-family
  browser through `playwright-core`; no browser is downloaded.
- Tool surface is **78**: 26 project/observation/paint/runtime tools, 6 step
  editor tools, 46 `event_*` command builders.
- Added a step observer UI: pause, single-step, speed selection and replay of
  the last editing session, with each cell drawn as it is written.

### Fixed — wall shadows: reconcile instead of add-only

- **Wall cells were masked, so every thick wall rendered as alternating dark
  stripes** — in the MCP preview and in the real engine. `stampWallShadow` wrote
  `10` (right half) onto the wall-side cell itself in addition to `5` (left half)
  on the ground to its right. Maps authored by hand in the MZ editor keep layer 4
  at `0` on every wall cell and put `5` only on the first ground cell right of
  the wall; that is now the convention the pass reconciles to. The previous
  build's own maps carry the defect (`lantern-bay`: 51 / 43 / 288 / 156 masked
  wall cells on maps 1-4) and repair themselves on the next default paint.
  `tile_info`, `docs/TOOLS.md` and `paint_tiles`' tool description repeated the
  wrong rule, which is how it propagated.
- `stampWallShadow` is now a **reconcile**, not an add-only pass. It reclaims the
  two values it owns (`10` on a wall-side cell, `5` on the cell catching its
  cast) whenever the supporting wall is gone, so filling a map with walls and
  carving rooms afterwards no longer stripes every carved cell with a stale dark
  mask. Hand-painted layer 4 values other than 10/5 are left untouched.
- `paint_tiles` refuses a layer 4 write that the reconcile pass would revert in
  the same call instead of accepting it and silently dropping it. Pass
  `autoShadow: false` to own the whole shadow layer.
- Paint results carry `shadowCells`: how many layer 4 cells the wall-shadow pass
  rewrote, including stale shadows it cleared. Layer 4 used to change silently.

### Fixed — clearing a cell

- `paint_tiles` / `putground` can clear a visual cell again: `tileId: 0` no
  longer requires `expectedSheet` (0 belongs to no sheet) and now rejects a false
  claim with `expectedSheet does not apply to tileId 0`. `expectedSheet` is
  optional in the JSON schema and enforced at runtime, so the failure names the
  missing field instead of collapsing into `Invalid input at rectangles[0]`.

### Tests

- `node --test` 57 pass / 0 skip (adds a thick-wall no-stripe case, a
  repair-a-masked-wall-cell case, a refused layer 4 conflict case, the reclaim
  case, the hand-painted-mask case, and a fill-then-carve integration test
  through `project.paint`). The two assertions that pinned the old
  `10`-on-wall behaviour were rewritten against the editor's own map data.

### Docs

- The 37-item field log of automation traps (headless focus gating, autotile
  shape numbers, ★ passability, event command code differences between MV and
  MZ, NW.js exit codes, and more) is published as
  [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md). It was previously a
  local-only note.

## 0.4.0 — 2026-10-07

- Added `tileset_catalog` to identify the active map Tileset mode and the actual
  image assigned to each A1-A5/B-E slot.
- Clarified that map layers 0..3 are visual draw order, not semantic
  ground/interior/dungeon categories.
- Visual `putground`, `paint_tiles`, and `place_building` writes now require
  expected sheet assertions and reject IDs from a different sheet.
- `paint_tiles` schemas distinguish visual tile IDs from shadow masks and Region
  values, with layer-specific ranges.
- `stamp_region` refuses to copy raw tile IDs between maps using different
  Tilesets.

## 0.4.0-rc — 2026-10-07 (runtime bridge and tool surface)

Runtime bridge (`plugin/MZVisualBridge.js`), all scoped to `--test` play:

- Keep `SceneManager.isGameActive()` true while the bridge is loaded. MZ gates
  `scene.update()` on OS window focus, so a backgrounded playtest page froze
  `_fadeDuration`/`_transferring`/`isMoving` and every `runtime_control` settle
  wait expired with `Map did not settle`.
- `settled()` now names the action and every blocking predicate, plus `focused`,
  `visible`, `sceneTickDelta` and `frames`. `Graphics.frameCount` alone is not a
  liveness signal: it keeps rising through `updateMain` while the scene is gated
  off.
- `interact` and `input` return `consumed`, so a trigger no scene read is no
  longer reported as success.
- `move` stops inside the 15 s transport budget and reports how many steps
  landed.
- `state()` gained `switches`, `variables` and `selfSwitches` read-back
  (64/64/32 entries), which makes `set_switch`/`set_variable` observable instead
  of write-only.

Tool surface:

- All tool schemas reject unknown arguments. Previously zod stripped them, so
  `put_event(..., transfer)` silently produced an event with no transfer and
  reported `changed: true`.
- `put_event` accepts `transfer` (the 6-parameter MZ 201) and validates the
  destination cell, matching `upsert_event`.
- `makeEvent` refuses `pages` combined with `transfer`/`text`/`image` instead of
  dropping the extras.
- `validateEvent` messages now name the event, page index and list position.
- New `event_erase_event` tool for MZ 214; `event_exit_event` (115) is Abort
  Event, not erase.

Full ledger, including what is deliberately left open: `docs/tool-defects.md`.
`node --test` 48/48, `npm run check` 40 files, `npm run audit:release` 62 files.

## 0.3.0 — 2026-10-07

- 27 new event layout tools: transfer/wait/choices/input-number, party and actor
  HP/MP/level/state/skill/images, enemy HP/appear/transform, screen
  fade/tint/flash/shake/weather, animation, set event location,
  show/move/erase picture, comment, exit event, common event, label/jump, name
  input, shop, timer and save/menu/encounter/formation access (verified against
  MZ 1.8.1 `Game_Interpreter`, including the five-parameter 102 layout and the
  302 `params[4]` purchase-only flag).
- Project open now validates `data/System.json` `advanced.windowOpacity` (stock
  newdata template omission that crashed the title screen with "Cannot read
  properties of undefined (reading 'clamp')") and repairs it with a backup;
  read-only mode fails with exact remediation instead.
- `MZVisualBridge` input uses `Input.virtualClick` plus document-level key events
  instead of unreliable `Input._currentState` writes; runtime state now reports
  `lastGameError`, the engine error printer text, and enemy alive flags.
- Tool errors now include zod issue lists, cause chains, system codes and top
  stack frames instead of a bare message.
- New `tile_info` tool: probe a tile id for sheet/autotile role and the paired A4
  wall-top/wall-side base ids, plus multi-piece-composite warnings for B-E/A5
  tiles.
- `paint_tiles` now stamps editor-parity wall shadows automatically
  (`autoShadow`, on by default): A4 wall-side cells cast left-half shadow bits
  (z=4 value 5) onto the ground tile to their right, using engine predicates
  `Tilemap.isWallSideTile`/`isWallTile` and the `Tilemap._addShadow` quadrant
  encoding.
- `examples/EnemyHpBars.js`: purely visual front-view enemy HP gauges.
- `examples/audit-events.cjs`: full event auditor (missing images/audio/animation
  files, dangling item/enemy/transfer references, and the
  set-flag-without-gated-page infinite-repeat class that caught seven events in
  the demo project).
- Fixed `event_move_route` semantics: engine `character()` encoding is -1 player
  / 0 this event (previously documented reversed), and repeat now defaults to
  false because `repeat:true + wait:true` on failing steps deadlocks the
  interpreter route wait (player-level soft-lock).

## 0.1.0 — 2026-10-07

Initial developer-preview source release.

- Standard stdio MCP with authenticated localhost map observation.
- Map PNG, crop, grid, tile palette and layer inspection.
- Map creation/configuration, batch paint, building placement and region stamps.
- Event creation, dialogue/transfer helpers and deletion.
- Single-cell `putground`, event movement/image changes, sequential deltas,
  browser render acknowledgements, pause/step/speed/replay.
- Revision conflict checks, writer lock, backups and undo.
- Browser game runtime, Windows native NW.js private-copy launcher.
- Runtime screenshots and limited safe input/state controls.
- Portable configuration, unit tests and optional licensed-engine integration
  tests.

Not included: native editor in-memory sync, encrypted-asset support, one-call
scripted automatic walkthrough, persistent cross-restart replay, or
comprehensive compatibility validation for custom plugins.

---

## Legacy line — TypeScript implementation, 0.1.x → 0.4.2

The release-by-release history of the previous implementation (65 tools,
`tsc` build, `@napi-rs/canvas` renderer, 15 verification suites) is preserved
unchanged in [`docs/legacy-0.4.2/CHANGELOG.md`](docs/legacy-0.4.2/CHANGELOG.md),
together with that line's [`README`](docs/legacy-0.4.2/README.md),
[`ACCEPTANCE`](docs/legacy-0.4.2/ACCEPTANCE.md) runbook,
[`REVIEW-RESPONSE`](docs/legacy-0.4.2/REVIEW-RESPONSE.md) and
[`RELEASING`](docs/legacy-0.4.2/RELEASING.md) checklist.
