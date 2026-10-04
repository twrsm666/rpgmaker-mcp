/**
 * One command for the whole verification flow, so "it works" is a thing that gets run
 * rather than a thing that gets remembered:
 *
 *   npm run verify:full
 *
 * The order is the contract. The lamp game is (re)built and played first because it
 * owns `System.json`'s start position at that point; Star Relay is authored after it,
 * since it moves the start position to its own house. The chain smoke run comes last
 * among the project suites, because it is the one that talks to the server the way an
 * agent does — spawn it, ask it for its registry, write, and take the writes back. The
 * run that closes the chain packs the publishable tarball, unpacks it, and asks that
 * copy the same questions, because a file missing from the `files` allow-list is a bug
 * no test inside the working tree can see. Every suite keeps its own ports
 * (3789 registered server, 3791 session:e2e, 3792 lightrun, 3793 live-e2e, 3794 star
 * relay, 3795 session probe, 3797 input verification, 3798 the newdata template, 3796
 * the playtest inside that template suite) and every headless browser is stopped by the
 * script that started it, so a failure halfway through leaves nothing holding a port.
 * Re-runnable: both builders find their maps by name and rebuild their own content.
 *
 * Two paths are covered on purpose rather than by accident. The newdata suite does not
 * stop at "the patched template boots": it builds the lamp game into that copy and plays
 * it, because every other suite runs against a project the editor made, and a reviewer
 * found the copied-from-the-engine path broken by exactly that much distance. And the
 * compile step is skipped, with a printed reason, when the tree has no `src/` — which is
 * what a `npm pack`ed install looks like, so the chain a stranger runs is the chain that
 * reports its own result rather than failing on its first line.
 *
 * Project folder, corescript folder and bridge token come from the environment or from
 * the MCP server's own registered entry (`scripts/local-env.mjs`), so nothing here
 * hardcodes where your engine is installed.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { PACKAGE_ROOT, corescriptRoot, liveToken, projectDir, settingsPath } from "./local-env.mjs";

let corescript;
try {
    corescript = corescriptRoot();
    liveToken();
} catch (error) {
    console.error(`${error.message}`);
    console.error("the renderer suites need the engine, and the headless suites cannot boot a game without a token");
    process.exit(1);
}
const samplemaps = join(dirname(corescript), "samplemaps");
console.log(`project    ${projectDir}\ncorescript ${corescript}\nsettings   ${settingsPath()}`);

const node = process.execPath;
const suites = [
    // The published tarball has `dist/` and no `src/`, so a stranger running this from
    // npm gets a skipped compile and thirteen real suites rather than a chain that stops
    // on its first line. A reviewer measured that: "14 of 14" was not reproducible from
    // the artifact.
    { name: "tsc", hard: true, skipWithout: "src", cmd: [node, join(PACKAGE_ROOT, "node_modules", "typescript", "bin", "tsc")] },
    { name: "e2e (the whole registry, file layer)", cmd: [node, "dist/e2e.js", projectDir, corescript] },
    { name: "round-trip (every data file re-serialises identically)", cmd: [node, "dist/roundtrip.js", join(projectDir, "data")] },
    { name: "fidelity:sweep (renderer against the editor's own previews)", cmd: [node, "dist/sweep.js", samplemaps, projectDir] },
    { name: "e2e:live (the live bridge against a real engine, port 3793)", cmd: [node, "dist/live-e2e.js"], env: { RMMZ_LIVE_PORT: "3793" } },
    { name: "verify:input (keys and walking proven in a running game, port 3797)", cmd: [node, "scripts/verify-input.mjs"] },
    { name: "verify:newdata (the shipped template made into a playable game, port 3798)", cmd: [node, "scripts/verify-newdata.mjs"] },
    { name: "session:e2e (headless session lifecycle, port 3791)", cmd: [node, "scripts/session-tool.mjs"] },
    { name: "build:game (the lamp game, authored through the tools)", cmd: [node, "scripts/build-lightrun.mjs", "build"] },
    { name: "play:game (the lamp game played to its credits, port 3792)", cmd: [node, "scripts/play-lightrun.mjs"] },
    { name: "build-star-relay (the acceptance game, high-level tools only)", cmd: [node, "scripts/build-star-relay.mjs", "build"] },
    { name: "play:star-relay (it played through, port 3794)", cmd: [node, "scripts/verify-star-relay.mjs"] },
    { name: "census (the acceptance game rebuilt from the shipped template, port 3800)", cmd: [node, "scripts/census.mjs"] },
    { name: "smoke:chain (the registered command, spawned fresh, writes undone)", cmd: [node, "scripts/smoke-registered.mjs"] },
    { name: "verify:package (the tarball itself, unpacked and spawned)", cmd: [node, "scripts/verify-package.mjs"] }
];

const results = [];
let lost = false;

for (const suite of suites) {
    const started = Date.now();
    console.log(`\n\n########## ${suite.name} ##########`);
    if (suite.skipWithout && !existsSync(join(PACKAGE_ROOT, suite.skipWithout))) {
        console.log(`SKIPPED — this tree has no ${suite.skipWithout}/ (it is a published package, which ships dist/ compiled). Nothing to compile.`);
        results.push({ name: suite.name, code: 0, ms: 0, skipped: true });
        continue;
    }
    console.log(`$ ${suite.cmd.map(part => (/\s/.test(part) ? `"${part}"` : part)).join(" ")}`);
    // No shell: the corescript path contains spaces and parentheses, and cmd.exe's
    // re-parsing of a quoted argument is what turns one suite into "Not an RPG Maker
    // MZ project: ...\Maker". Node spawns the child directly, quoting is our business.
    const run = spawnSync(suite.cmd[0], suite.cmd.slice(1), {
        cwd: PACKAGE_ROOT,
        stdio: "inherit",
        env: { ...process.env, RMMZ_PROJECT: projectDir, RMMZ_CORESCRIPT_ROOT: corescript, ...(suite.env ?? {}) }
    });
    const ms = Date.now() - started;
    results.push({ name: suite.name, code: run.status, ms });
    if (run.status !== 0) {
        console.log(`########## ${suite.name} exited ${run.status} after ${(ms / 1000).toFixed(0)}s ##########`);
        if (suite.hard) {
            lost = true;
            break;
        }
    } else {
        console.log(`########## ${suite.name} ok in ${(ms / 1000).toFixed(0)}s ##########`);
    }
}

console.log(`\n\n== verify:full`);
for (const entry of results) {
    console.log(`   ${entry.code === 0 ? "ok  " : "FAIL"}  ${(entry.ms / 1000).toFixed(0).padStart(5)}s  ${entry.name}${entry.skipped ? "  (skipped: nothing to compile in a published package)" : ""}`);
}
if (lost) {
    console.log(`   the first suite is a hard prerequisite; the rest did not run`);
}
const failed = results.filter(entry => entry.code !== 0).length;
const skipped = results.filter(entry => entry.skipped).length;
console.log(`\n${failed === 0 && !lost ? `VERIFY FULL PASS — ${results.length - skipped} suite(s) run${skipped ? `, ${skipped} skipped` : ""}` : `${failed + (lost ? 1 : 0)} suite(s) failed`}`);
process.exitCode = failed === 0 && !lost ? 0 : 1;
