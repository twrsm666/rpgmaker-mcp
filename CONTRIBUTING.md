# Contributing

1. Install Node.js 20+ and run `npm ci`.
2. Run `npm run check` and `npm test` before submitting changes.
3. Engine-dependent tests are optional unless `RPG_MCP_ENGINE` is configured.
4. Never commit engine scripts, RTP assets, NW.js, test-project files, tokens or
   generated backups/screenshots from a licensed project.
5. Keep `stdout` reserved for MCP messages; send diagnostics to `stderr`.
6. Keep filesystem operations limited to the explicitly configured project.
7. Preserve revision/conflict checks and pre-write backup behavior.
8. Add regression coverage for ordering, replay and runtime behavior.

Use `.work/` for local fixtures and `verification/` for local generated reports.
Do not hard-code a contributor's home directory or local project path.
