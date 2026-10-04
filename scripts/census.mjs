/**
 * Reproduce the claim the README makes about the high-level layer, from the published tree.
 *
 *   npm run census             # build the acceptance game into a copy of the shipped template
 *   npm run census -- --play   # and play it through with the real playtest harness
 *   npm run census -- --keep   # leave the copy and its logs on disk
 *
 * Why this is a command: the number the docs quote — how many high-level calls the whole game
 * took, and how many low-level writes the layer could not make underneath them — used to be
 * readable only by running `build-star-relay` against the author's own project. That is exactly
 * the starting point an outside reviewer does not have, so a third-round reviewer marked the
 * claim "not independently confirmed" through no fault of the claim.
 *
 * So the builder now runs against a copy of `data/newdata` — the same tree the README tells a
 * first-time reader to point `RMMZ_PROJECT` at, and which needs no map, event or database row
 * from anywhere else — and the census it prints on the way out is read back here and gated: a
 * build that needs a write the layer cannot make fails this command rather than quietly
 * changing what the docs are allowed to say.
 *
 * Owns port 3800 (and game port 8100 with `--play`) so it never collides with the registered
 * server on 3789 or with any other suite's fixed port.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { PACKAGE_ROOT, corescriptRoot, describeProjectChoice, liveToken, projectDir } from "./local-env.mjs";

const flags = process.argv.slice(2);
const play = flags.includes("--play");
const keep = flags.includes("--keep");

const bridgePort = Number(process.env.RMMZ_CENSUS_PORT ?? 3800);
const gamePort = Number(process.env.RMMZ_CENSUS_GAME_PORT ?? 8100);
const template = join(dirname(corescriptRoot()), "newdata");
const work = join(PACKAGE_ROOT, ".rpgmaker-mcp", "census-check");
const shots = join(work, "shots");
const token = liveToken();

if (!existsSync(join(template, "data", "System.json"))) {
    console.error(`no engine template at ${template} — set RMMZ_CORESCRIPT_ROOT to the corescript folder`);
    process.exit(1);
}
console.log(`project the chain normally uses: ${projectDir} — untouched by this command`);
console.log(`template ${template}\n→ copy   ${work}`);

rmSync(work, { recursive: true, force: true });
mkdirSync(shots, { recursive: true });
cpSync(template, work, { recursive: true });

/** Run one of the repo's own scripts against the copy, the way a reader would. */
const run = (script, args = []) => {
    console.log(`\n$ node ${script} ${args.join(" ")}`);
    return spawnSync(process.execPath, [join(PACKAGE_ROOT, script), ...args], {
        cwd: PACKAGE_ROOT,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        env: {
            ...process.env,
            RMMZ_PROJECT: work,
            RMMZ_LIVE_TOKEN: token,
            RMMZ_SR_SHOTS: shots,
            RMMZ_LIVE_PORT: String(bridgePort),
            RMMZ_SR_PLAY_PORT: String(bridgePort),
            RMMZ_SR_GAME_PORT: String(gamePort)
        }
    });
};

let failures = 0;
const check = (name, condition, detail) => {
    if (condition) {
        console.log(`  PASS  ${name}`);
    } else {
        failures++;
        console.log(`  FAIL  ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail).slice(0, 400)}`}`);
    }
};
const tail = result => `${(result.stderr ?? "").split(/\r?\n/).filter(Boolean).slice(-6).join(" | ")}${(result.stdout ?? "").split(/\r?\n/).filter(Boolean).slice(-3).join(" | ")}`;

const built = run("scripts/build-star-relay.mjs", ["build"]);
const buildLog = join(work, "build.log");
writeFileSync(buildLog, built.stdout ?? "", "utf8");
console.log((built.stdout ?? "").split(/\r?\n/).slice(0, 12).join("\n"));
check(`the acceptance game builds into a copy of the shipped template (exit ${built.status ?? "?"})`, built.status === 0, tail(built));
check("and it said out loud which project it was writing", (built.stdout ?? "").includes(work), (built.stdout ?? "").split(/\r?\n/)[0]);

const censusFile = join(shots, "escape-hatches.json");
const census = existsSync(censusFile) ? JSON.parse(readFileSync(censusFile, "utf8")) : null;
check("the build left its census behind", Boolean(census), censusFile);

const hatches = census?.escapeHatches ?? [];
const writes = hatches.filter(hatch => hatch.kind === "write");
const reads = hatches.filter(hatch => hatch.kind === "read");
const byTool = {};
for (const hatch of hatches) {
    byTool[`${hatch.tool} (${hatch.kind})`] = (byTool[`${hatch.tool} (${hatch.kind})`] ?? 0) + 1;
}

console.log(`\n== the census, from a project that came out of the engine's own template`);
console.log(`   high-level calls : ${census?.highLevelCalls ?? "?"}`);
console.log(`   low-level writes the layer could not make : ${writes.length}`);
console.log(`   reads it asked for along the way : ${reads.length}`);
console.log(`   escape hatches : ${JSON.stringify(byTool)}`);
check("not one write below the high-level layer", writes.length === 0, writes.slice(0, 4));
check("and the game is in the copy's own files", (JSON.parse(readFileSync(join(work, "data", "MapInfos.json"), "utf8")).filter(Boolean) ?? []).filter(map => /^SR /.test(map.name)).length === 3);

if (play) {
    // The playtest drives a running page through the bridge plugin, and a copy of the shipped
    // template does not carry it. Install the file and register it the way the README's
    // editor-free path says to — which is also the second reason this command exists: the whole
    // chain from an empty template to a played game, with nothing from the author's project.
    writeFileSync(join(work, "js", "plugins", "RMMZLiveBridge.js"), readFileSync(join(PACKAGE_ROOT, "plugin", "RMMZLiveBridge.js"), "utf8"), "utf8");
    process.env.RMMZ_PROJECT = work;
    process.env.RMMZ_LIVE_TOKEN = token;
    process.env.RMMZ_LIVE_PORT = "3804";
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { server } = await import(pathToFileURL(join(PACKAGE_ROOT, "dist", "index.js")).href);
    const installer = new Client({ name: "census-plugin-install", version: "1.0.0" });
    const pair = InMemoryTransport.createLinkedPair();
    await server.connect(pair[1]);
    await installer.connect(pair[0]);
    const installed = await installer.callTool({ name: "enable_plugin", arguments: { name: "RMMZLiveBridge", parameters: { token, allowEval: true, keepAwake: true } } });
    await installer.close();
    console.log(`installed the bridge plugin in the copy: ${(installed.content?.find(part => part.type === "text")?.text ?? "").slice(0, 140)}`);

    const played = run("scripts/verify-star-relay.mjs", []);
    writeFileSync(join(work, "play.log"), played.stdout ?? "", "utf8");
    const count = (text, pattern) => (text ?? "").split(/\r?\n/).filter(line => pattern.test(line)).length;
    const passed = count(played.stdout, /^ {2}PASS {2}/);
    const lost = count(played.stdout, /^ {2}FAIL {2}/);
    console.log(`   the playtest's own count: ${passed} PASS / ${lost} FAIL, exit ${played.status}`);
    check("the copy played through to its title screen with no failed assertion", played.status === 0 && lost === 0 && passed > 30, tail(played));
}

if (keep) {
    console.log(`\nkept: ${work} (build.log${play ? " and play.log" : ""}, screenshots in ${shots})`);
} else {
    rmSync(work, { recursive: true, force: true });
    console.log("\nthe copy is deleted; re-run with --keep to hold on to its logs and screenshots");
}

console.log(failures ? `\n${failures} census check(s) failed` : "\nALL PASS");
process.exit(failures ? 1 : 0);
