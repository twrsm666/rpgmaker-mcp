# Legacy line — 0.1.x → 0.4.2 (TypeScript implementation)

Everything in this folder is the documentation of the **previous**
implementation, preserved verbatim when `0.5.0` replaced it:

| File | What it is |
| --- | --- |
| `README.md` | the 0.4.2 root README (65 tools, `tsc` build, `@napi-rs/canvas` renderer) |
| `CHANGELOG.md` | release-by-release history of the TypeScript line |
| `ACCEPTANCE.md` | the reviewer's runbook: suites, recorded numbers, stated gaps |
| `REVIEW-RESPONSE.md` | item-by-item answers to three independent acceptance reviews |
| `RELEASING.md` | the publishing checklist (no copyrighted assets, no engine dumps) |

Relative links inside these files resolve within this folder. References to
`src/*.ts`, `scripts/*.mjs` and `dist/` point at code that only exists in git
history (tag `v0.4.2`) — the 0.5.0 tree is plain JavaScript under `src/`, `bin/`,
`preview/` and `plugin/`.

For the current implementation read the root [`README.md`](../../README.md),
[`CHANGELOG.md`](../../CHANGELOG.md), [`docs/TOOLS.md`](../TOOLS.md) and
[`docs/VALIDATION.md`](../VALIDATION.md).
