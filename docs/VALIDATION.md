# Release validation — 0.5.0

Validation date: 2026-10-08 (Asia/Shanghai).

The publish tree was installed with `npm ci --ignore-scripts` and checked on
Node.js v24.18.0 / Windows (10.0.26200) **without** an engine configured, i.e.
the numbers below are reproducible by anyone with only Node and this archive.
Engine-licensed suites (`npm run verify*`) were not run for this release; they
remain available and are documented in the README. The GitHub Actions matrix
(`.github/workflows/ci.yml`, Node 20/22 on ubuntu/windows) is configured but had
not been run on GitHub at the time this report was written.

| Check | Command | Result |
| --- | --- | --- |
| Dependency install | `npm ci --ignore-scripts` | 0 vulnerabilities; lock file consistent with `package.json` |
| JavaScript syntax | `npm run check` | Passed: 40 JavaScript files |
| Unit tests, no engine | `npm test` | 57 tests: 18 pass, 0 fail, 39 skipped (local integration tests skip themselves without `RPG_MCP_ENGINE`) |
| Release audit | `npm run audit:release` | Passed: 71 source/document files; no bundled engine or project artifacts, no local-machine paths, no runtime tokens |
| Live MCP surface | Qoder stdio session, 2026-10-08 | 78 tools registered (26 project/observation/paint/runtime + 6 step editor + 46 `event_*`) |

## What the live session exercised

The screenshot in [`assets/agent-session-map-build.png`](../assets/agent-session-map-build.png)
is from that session: a 44×32 Chinese-style town map (`#6 永宁镇·青瓦水乡`) built
entirely through MCP tools while the observer panel stayed open in a side
browser. Visible in it:

- the observer's step ledger — nine recorded `paint` steps with per-step cell
  counts (1408 / 429 / 335 / 401 / 228 / 56 / 19 …), pause / single-step /
  replay controls and the live "step 9 of 9" indicator;
- engine-faithful rendering: A4 wall tops with their paired wall sides, A2
  ground, A1 water with bridges, B-sheet props (statues, pillars, pots, trees)
  and layer-2 doors/windows on the building fronts;
- the wall-shadow reconcile at work — two-cell-thick city walls and building
  walls render with a single cast shadow on the ground beside them, no striped
  wall bodies (the defect fixed in this release);
- the agent chat column on the left narrating each tool batch, which is the
  intended human-facing view of the same session.

Also exercised in that session and reflected in the 0.5.0 changelog: the
`expectedSheet` refusal for visual cells, the `tileId: 0` clearing path, and
`shadowCells` reporting on paint results.

The committed hero image
[`assets/map006-chinese-town.png`](../assets/map006-chinese-town.png) was
produced from the same project by the shipped renderer in headless mode
(`render.html` at scale 1, map revision
`2391851c3b7749b64b62e4179131e162eeaf4f9b0185728c6979bb9cf27d4345`, 2112×1536
px, zero renderer warnings). It is the only map render in the archive and
contains no licensed material beyond the stock MZ tiles the project itself
ships.

## Deliberately not claimed

- No automatic walkthrough / playthrough API. `runtime_control` and
  `runtime_capture` are primitives an agent orchestrates; a full scripted
  clear-through is not a release feature.
- Encrypted assets are unsupported; custom plugin compatibility is not
  comprehensively validated. Verified baseline is MZ 1.8.x / Windows with local
  browser rendering.
- Static passability analysis is approximate and does not replace playtesting.
- Raw screenshots of licensed material, test projects, logs, connection tokens
  and engine resources are excluded from the archive. The one shipped PNG is a
  screenshot of the observer UI and the agent's own session, taken on the
  author's machine with their own licensed project.

Reproduce the engine-licensed suites with your own installation using the
commands in [`README.md`](../README.md); the previous line's validation history
is in [`docs/legacy-0.4.2/`](legacy-0.4.2/).
