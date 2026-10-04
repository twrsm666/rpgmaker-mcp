/**
 * Does a project built from the engine's own `data/newdata` template actually work?
 *
 *   node scripts/verify-newdata.mjs
 *
 * An independent reviewer found the answer was no, and not for a reason anyone would
 * guess: `newdata/data/System.json` has no `advanced.windowOpacity`, while a project the
 * editor makes does. `Game_System.windowOpacity()` returns that key straight into
 * `Window_Base.updateBackOpacity`, which calls `.clamp` on it, so the game dies on its
 * first title-screen window with a stack that never mentions the missing key — and
 * `validate_game`, which had never looked at `advanced`, said the project was clean.
 *
 * So this suite copies the template, boots it and *watches* it die, repairs it with
 * `fix_project`, boots again and walks into a map — and then, because the second round of
 * review found that "it boots" and "you can build a game in it" are different claims, it
 * builds the lamp game into that same copy and plays it to its credits with the real
 * scripts, as a child process pointed at the copy. That last part is the whole point:
 * every other suite runs against a project the editor had built, which is precisely the
 * path where the key is already there, and the reviewer's fresh project fell through the
 * gap.
 *
 * Own ports (3798 bridge / 8098 game, and 3796 / 8096 for the playtest it spawns). The
 * copy lives under `.rpgmaker-mcp/` and is deleted at the end; nothing in the install
 * directory is written.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PACKAGE_ROOT, corescriptRoot, describeProjectChoice, liveToken, projectDir } from "./local-env.mjs";

const bridgePort = Number(process.env.RMMZ_NEWDATA_PORT ?? 3798);
const gamePort = Number(process.env.RMMZ_NEWDATA_GAME_PORT ?? 8098);
const playBridgePort = Number(process.env.RMMZ_NEWDATA_PLAY_PORT ?? 3796);
const playGamePort = Number(process.env.RMMZ_NEWDATA_PLAY_GAME_PORT ?? 8096);
const token = liveToken();
const template = join(dirname(corescriptRoot()), "newdata");
const copy = join(PACKAGE_ROOT, ".rpgmaker-mcp", "newdata-check");

if (!existsSync(join(template, "data", "System.json"))) {
    console.error(`no newdata template next to the corescript at ${corescriptRoot()}`);
    process.exit(1);
}
console.log(`template ${template}\n→ copy   ${copy}`);
console.log(`   (the project this suite must NOT touch: ${projectDir})`);
rmSync(copy, { recursive: true, force: true });
cpSync(template, copy, { recursive: true });

process.env.RMMZ_PROJECT = copy;
process.env.RMMZ_LIVE_TOKEN = token;
process.env.RMMZ_LIVE_PORT = String(bridgePort);
console.log(describeProjectChoice());

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { server } = await import("../dist/index.js");
const client = new Client({ name: "newdata-verify", version: "1.0.0" });
const pair = InMemoryTransport.createLinkedPair();
await server.connect(pair[1]);
await client.connect(pair[0]);

const sleep = ms => new Promise(done => setTimeout(done, ms));
let failures = 0;
const check = (name, condition, detail) => {
    if (condition) {
        console.log(`  PASS  ${name}`);
    } else {
        failures++;
        console.log(`  FAIL  ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail).slice(0, 400)}`}`);
    }
};
const note = (label, value) => console.log(`   · ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);

async function call(name, args = {}, timeoutMs) {
    const result = await client.callTool({ name, arguments: args }, undefined, timeoutMs ? { timeout: timeoutMs } : undefined);
    const text = result.content?.find(part => part.type === "text")?.text ?? "";
    if (result.isError) {
        throw new Error(`${name} failed: ${text.slice(0, 400)}`);
    }
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}
const evalIn = async (code, timeoutMs = 25000) => (await call("live_eval", { expression: code, timeoutMs }, timeoutMs + 8000)).value;

/** Boot whatever the copy currently is into a game, and report how far it got. */
async function boot(label) {
    const started = await call("live_session", { action: "start", gamePort, newGame: false, waitForBridgeMs: 150000 }, 200000);
    if (started.bridgeConnected !== true) {
        await call("live_session", { action: "stop" }, 60000).catch(() => {});
        throw new Error(`${label}: nothing polled the bridge — ${JSON.stringify(started).slice(0, 300)}`);
    }
    // The title screen is where an unread System key shows up, so press on and watch the
    // frame counter rather than trusting the scene name: a crashed scene can still be
    // Scene_Title, and a stopped loop is the thing that actually means dead. On a dead
    // page the press itself is the finding, so it is caught rather than thrown.
    const pressed = await call("live_key", { keyCode: 13, pulses: 2, holdFrames: 4 }, 60000).catch(error => ({ diedWhen: String(error.message).slice(0, 160) }));
    if (pressed.diedWhen) {
        note(`${label} would not take a press`, pressed.diedWhen);
    }
    await sleep(1500);
    const first = await evalIn("({ frame: Graphics.frameCount, scene: SceneManager._scene && SceneManager._scene.constructor.name })");
    await sleep(2000);
    const second = await evalIn("({ frame: Graphics.frameCount, scene: SceneManager._scene && SceneManager._scene.constructor.name })");
    const advanced = second.frame - first.frame;
    note(`${label} after the first Ok`, { ...second, advancedIn2s: advanced });
    const errors = await call("live_diagnostics", { limit: 6, full: true }, 30000).catch(() => ({ entries: [] }));
    for (const entry of (errors.entries ?? []).filter(item => item.kind !== "info").slice(0, 3)) {
        note(`${label} says`, `${entry.kind}: ${entry.message}`);
    }
    const booted = await call("live_session", { action: "boot", bootMs: 120000 }, 200000).catch(error => ({ failed: error.message.slice(0, 200) }));
    const cell = await evalIn(`(() => ({ frame: Graphics.frameCount, scene: SceneManager._scene && SceneManager._scene.constructor.name, map: $gameMap ? $gameMap.mapId() : null, x: $gamePlayer ? $gamePlayer.x : null, y: $gamePlayer ? $gamePlayer.y : null }))()`);
    note(`${label} after boot`, { ...cell, boot: JSON.stringify(booted.boot ?? booted).slice(0, 120) });
    // Taken while the page is still up, because after `stop` there is nothing to answer. It
    // is also the test that `saveTo` makes the folder it was pointed at: `samples/` is not
    // published, so on a tarball this path does not exist until the tool creates it.
    const shotFile = join(PACKAGE_ROOT, "samples", "newdata", `${label}-boot.png`);
    rmSync(shotFile, { force: true });
    const shot = await call("live_screenshot", { saveTo: shotFile }, 30000).catch(error => ({ failed: error.message.slice(0, 120) }));
    note(`${label} screenshot`, shot?.savedTo ?? shot);
    await call("live_session", { action: "stop" }, 60000);
    return { advanced, cell, shotSaved: existsSync(shotFile), entries: (errors.entries ?? []).map(item => item.message) };
}

// ---------------------------------------------------------------------------
console.log("\n== 1. the template as shipped, with nothing fixed");
const before = JSON.parse(readFileSync(join(copy, "data", "System.json"), "utf8"));
check("this really is the unpatched template (no advanced.windowOpacity)", before.advanced?.windowOpacity === undefined, { keys: Object.keys(before.advanced ?? {}) });
const auditBefore = await call("validate_game", {});
const opacityProblem = (auditBefore.problems ?? []).find(problem => /advanced\.windowOpacity/.test(problem.where));
check("validate_game names the missing key instead of calling the project clean", auditBefore.ok === false && Boolean(opacityProblem), {
    ok: auditBefore.ok,
    where: (auditBefore.problems ?? []).map(problem => problem.where).slice(0, 6)
});
check("and its fix line is a call that would work", /patch_database_entry/.test(opacityProblem?.fix ?? ""), opacityProblem?.fix);
note("problems found", (auditBefore.problems ?? []).map(problem => `${problem.severity} ${problem.where}`));

console.log("\n== 2. boot it and watch it die");
// The bridge has to be installed before any live tool can see the page at all.
writeFileSync(join(copy, "js", "plugins", "RMMZLiveBridge.js"), readFileSync(join(PACKAGE_ROOT, "plugin", "RMMZLiveBridge.js"), "utf8"), "utf8");
const enabled = await call("enable_plugin", {
    name: "RMMZLiveBridge",
    parameters: { token, allowEval: true, keepAwake: true }
});
check("enable_plugin puts a file copied in by hand into js/plugins.js", enabled.added === true || enabled.loadOrder !== undefined, enabled);
const listed = (await call("list_plugins")).plugins.find(plugin => plugin.name === "RMMZLiveBridge");
// A boolean parameter reaches the plugin through `PluginManager.parameters` as either
// `"true"` or `true` depending on who wrote the file, and the plugin reads it with
// String(), so the suite does too — comparing to one spelling would test the script.
check("with the parameters this run needs, and none the plugin never declared", String(listed?.parameters?.keepAwake) === "true" && (listed?.undeclared ?? []).length === 0, listed);
const died = await boot("unpatched");
check("an unpatched template stops drawing frames on the title screen", died.advanced < 5, { advancedIn2s: died.advanced, scene: died.cell.scene });
check("and the engine says why: a clamp on the window opacity that is not there", /clamp|windowOpacity|undefined/.test(died.entries.join(" | ")) || died.cell.scene !== "Scene_Map", died.entries.slice(0, 2));

console.log("\n== 3. repair it with the tool that exists for this, and boot again");
const repaired = await call("fix_project", {});
check("fix_project changed this project, and named the key it wrote", repaired.changed === true && (repaired.repaired ?? []).includes("System.advanced.windowOpacity"), {
    changed: repaired.changed,
    repaired: repaired.repaired,
    cannotFix: repaired.cannotFix
});
const after = JSON.parse(readFileSync(join(copy, "data", "System.json"), "utf8"));
check("it added that key without dropping the ones the template has", after.advanced.windowOpacity === 192 && Object.keys(after.advanced).length === Object.keys(before.advanced).length + 1, {
    before: Object.keys(before.advanced).length,
    after: Object.keys(after.advanced).length
});
check("and running it again writes nothing", (await call("fix_project", {})).changed === false);
const auditAfter = await call("validate_game", {});
check("validate_game no longer reports a missing engine key", !(auditAfter.problems ?? []).some(problem => /advanced\./.test(problem.where)), (auditAfter.problems ?? []).map(problem => problem.where).slice(0, 6));
const lived = await boot("patched");
check("the same template now walks into a map", lived.cell.scene === "Scene_Map" && lived.cell.map !== null, lived.cell);
check("and the game keeps drawing frames there", lived.advanced >= 5, { advancedIn2s: lived.advanced });
check("live_screenshot makes the folder it was asked to write into", lived.shotSaved === true, join(PACKAGE_ROOT, "samples", "newdata", "patched-boot.png"));

console.log("\n== 4. build the acceptance game into this copy, and play it");
// The reviewer's D2: every suite up to this point proved a template can *boot*, and then
// the real work — `build:game`, `play:game` — was run only against a project the editor
// had made. These two children are the same scripts the chain runs, pointed at the copy by
// environment variable alone, which is also the first test of the precedence fix: a build
// that silently wrote the registered project instead would fail the next three checks.
const demoMapInfos = createHash("sha256").update(readFileSync(join(projectDir, "data", "MapInfos.json"))).digest("hex");
const run = (script, args, extraEnv) =>
    spawnSync(process.execPath, [script, ...args], {
        cwd: PACKAGE_ROOT,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, RMMZ_PROJECT: copy, RMMZ_LIVE_TOKEN: token, RMMZ_CORESCRIPT_ROOT: corescriptRoot(), ...extraEnv }
    });
const tail = result => (result.stdout ?? "").split(/\r?\n/).slice(-14).join("\n");
const count = (text, pattern) => (text ?? "").split(/\r?\n/).filter(line => pattern.test(line)).length;
const saveLog = (name, result) => {
    const dir = join(PACKAGE_ROOT, "samples", "newdata");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), `${result.stdout ?? ""}${result.stderr ?? ""}`, "utf8");
};

const built = run("scripts/build-lightrun.mjs", ["build"], { RMMZ_LIVE_PORT: "3799" });
saveLog("build-game-on-fresh-copy.log", built);
check("build:game ran against the copy and passed its own gate (exit code)", built.status === 0, tail(built));
check("and it said out loud which project it was writing", (built.stdout ?? "").includes(copy), (built.stdout ?? "").split(/\r?\n/)[0]);
const copyMaps = (JSON.parse(readFileSync(join(copy, "data", "MapInfos.json"), "utf8")).filter(Boolean) ?? []).filter(map => /^LR /.test(map.name)).map(map => map.id);
check("the lamp game's four maps are in this copy's own files", copyMaps.length === 4, copyMaps);
check("and the project the registration points at is byte-for-byte what it was", createHash("sha256").update(readFileSync(join(projectDir, "data", "MapInfos.json"))).digest("hex") === demoMapInfos, {
    project: projectDir
});

const played = run("scripts/play-lightrun.mjs", [], { RMMZ_PLAY_PORT: String(playBridgePort), RMMZ_PLAY_GAME_PORT: String(playGamePort) });
saveLog("play-game-on-fresh-copy.log", played);
const passed = count(played.stdout, /^ {2}PASS {2}/);
const lost = count(played.stdout, /^ {2}FAIL {2}/);
note("the playtest's own count", `${passed} PASS / ${lost} FAIL, exit ${played.status}`);
check("play:game played the game built on the template to its credits", played.status === 0 && lost === 0 && passed > 30, tail(played));
check("and the project the registration points at never changed hands", createHash("sha256").update(readFileSync(join(projectDir, "data", "MapInfos.json"))).digest("hex") === demoMapInfos, {
    project: projectDir
});

console.log("\n== teardown");
rmSync(copy, { recursive: true, force: true });
check("the copy is gone", !existsSync(copy));
note("the project this suite touched", copy);
note("and not", projectDir);

await client.close();
await server.close();
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
