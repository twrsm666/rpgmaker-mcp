# Why there is no editor automation — findings

Status: **CONCLUDED — NOT FEASIBLE.** The *game runtime* is a different story and works:
see `plugin/RMMZLiveBridge.js`.

Question this answers: can an MCP server drive the running RPG Maker MZ **editor** the
way Unity-MCP drives Unity, so it reads and writes project data in editor memory? The
short answer is no, and the reason is architectural rather than a missing flag.

*Note:* the raw investigation log — launch variants, probe output, registry and on-disk
observations from one specific machine — is deliberately not published with this package.
It documents a proprietary binary and contained local paths. If you are maintaining this
server, keep your own copy of it outside the repo.*

## What the editor is

The MZ editor is a native Qt5 application: its map editor, tile palette and project data
model are compiled C++/QML types, with Qt's own `QJSEngine` (JavaScriptCore) for the small
JavaScript glue. Chromium is present only through QtWebEngine, and it is used for
web-ish sub-views — help, the effect viewer. NW.js ships in the installation as a separate
runtime that is handed an app at launch time (the playtest/preview path); it is not the
editor's host.

Two consequences:

1. **CDP is a V8/Chromium protocol.** `QJSEngine` is JavaScriptCore and implements no CDP,
   so even a listening debug port would expose the embedded web views — never the project
   model behind `DataManager`, `$dataMap` or `EditorExtend`.
2. **No debug port ever opened.** Launch variants were tried against a real installation,
   with the probe harness validated first against headless Edge (targets listed,
   `Runtime.evaluate` round-tripped) so the negatives are trustworthy rather than a broken
   script. `QWEBENGINE_REMOTE_DEBUGGING` and `--remote-debugging-port` both produced
   nothing to attach to. The only channel that reaches editor internals at all is Qt's QML
   debugger, which is a debugger rather than a supported scripting surface: it needs the
   editor restarted under our control and breaks on the next editor update. Not pursued.

## What this server does instead

- **The file layer is the editor API.** `data/*.json` is plain JSON and
  `src/core/json.ts` reproduces the editor's bytes exactly — `npm run roundtrip` proves
  parse-and-reserialize is byte-identical for every file in a project — so writes are safe
  and the editor can open the project afterwards without surprises.
- **`*.rmmzproject`** is only a sidecar pointing at the folder that holds `data/`, `img/`
  and `js/`; nothing in this server depends on reading it.
- **The live bridge runs inside the game**, which really is Chromium (NW.js for a
  playtest, any browser for an exported build), so live inspection and control work there.
- **`live_reload` replaces the missing editor round trip.** The running game re-reads the
  current `MapNNN.json` and rebuilds `$gameMap` and its scene, so edit → look → edit
  happens inside a playtest. Verified on a real v1.8 runtime by
  `scripts/playtest-tiny-game.mjs`: a tile painted after boot stayed invisible to the
  running map, then was live after one call, with the player position and the chest's self
  switch intact.
- **`render_map` gives the picture the editor would have given you**: the same composite
  the engine builds, from your own installation's tile tables.

## Workflow rule that follows from this

Close the editor while the server writes. MZ keeps the project in memory and overwrites
MCP writes on its next save. This is a workflow constraint, not a bug in this server.
