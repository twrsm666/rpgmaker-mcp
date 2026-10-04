import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import net from "node:net";
import { PACKAGE_ROOT, liveToken, projectDir } from "./local-env.mjs";
import { ensureBoots } from "./ensure-bootable.mjs";

/**
 * Drive the live_session tool the way an agent would: start a headless playtest,
 * look at the frame, reload the page after a file change, stop the browser again,
 * and use batch to paint a block that then fails and is rolled back under the
 * running game. Nothing here opens the editor, and the only process launched is
 * the headless browser live_session itself records and kills.
 */
const here = PACKAGE_ROOT;
const bridgePort = Number(process.env.RMMZ_SESSION_PORT ?? 3791);
const gamePort = Number(process.env.RMMZ_SESSION_GAME_PORT ?? 8091);
const token = liveToken();
process.env.RMMZ_PROJECT = projectDir;
process.env.RMMZ_LIVE_TOKEN = token;
process.env.RMMZ_LIVE_PORT = String(bridgePort);

const pluginsFile = join(projectDir, "js", "plugins.js");
const pluginsSource = readFileSync(pluginsFile, "utf8");
if (!pluginsSource.includes(`"token":"${token}"`)) {
    console.error(`the bridge plugin in ${pluginsFile} does not carry this token; live commands would be refused`);
    process.exit(1);
}

let failures = 0;
function check(name, condition, detail) {
    if (condition) {
        console.log(`  PASS  ${name}`);
    } else {
        failures++;
        console.log(`  FAIL  ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail).slice(0, 500)}`}`);
    }
}

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { server } = await import("../dist/index.js");
const client = new Client({ name: "session-tool", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

async function call(name, args = {}, timeoutMs) {
    const began = Date.now();
    const result = await client.callTool({ name, arguments: args }, undefined, timeoutMs ? { timeout: timeoutMs } : undefined);
    const text = result.content?.find(part => part.type === "text")?.text ?? "";
    let value = text;
    try {
        value = JSON.parse(text);
    } catch {
        // plain text answer
    }
    return { isError: Boolean(result.isError), value, parts: result.content ?? [], ms: Date.now() - began };
}

const liveEval = async expression => (await call("live_eval", { expression })).value?.value;
// MZ stores a map's layers flat: (layer * height + y) * width + x.
const PAINTED_CELL = "(() => { const d = $dataMap; return d.data[(1 * d.height + 2) * d.width + 2]; })()";
const portIsOpen = port =>
    new Promise(resolveOpen => {
        const socket = net.connect({ port, host: "127.0.0.1" });
        socket.once("connect", () => {
            socket.destroy();
            resolveOpen(true);
        });
        socket.once("error", () => resolveOpen(false));
    });


try {
    console.log(`\n== the bridge is on port ${bridgePort} and the page URL will say so`);
    check("the project's own plugin parameters were not touched", readFileSync(pluginsFile, "utf8") === pluginsSource, pluginsFile);

    console.log("\n== status before anything is running");
    const idle = await call("live_session", { action: "status" });
    check("no session in this process", idle.value.session === null, idle.value);
    check("asking for status does not bind the bridge port", idle.value.bridge.listening === false, idle.value.bridge);
    if (idle.value.stale) {
        console.log(`  a record of ${idle.value.stale.url} (pid ${idle.value.stale.pid}) is on disk: ${idle.value.note}`);
    }

    console.log("\n== start");
    // A record on disk whose pid is alive is not necessarily the browser that wrote it —
    // Windows hands pids out again, and a reviewer's fresh run was refused a session by a
    // number that had been recycled to an unrelated process. The profile directory in the
    // command line is what says "ours".
    const staleFile = join(here, ".rpgmaker-mcp", "session.json");
    mkdirSync(dirname(staleFile), { recursive: true });
    writeFileSync(
        staleFile,
        JSON.stringify({ pid: process.pid, profileDir: join(here, ".rpgmaker-mcp", "not-a-browser"), url: "http://127.0.0.1:59999/", port: 59999, startedAt: new Date().toISOString() }),
        "utf8"
    );
    const borrowed = await call("live_session", { action: "status" });
    check("a record naming this script's own live pid is reported as stale", borrowed.value.stale?.pid === process.pid, borrowed.value.stale);
    await ensureBoots(call);
    const began = Date.now();
    const started = await call("live_session", { action: "start", gamePort, waitForBridgeMs: 30_000, newGame: false }, 120_000);
    check("and a live pid that is not the browser it records does not refuse a new session", started.value?.session?.running === true, started.value);
    check("the record now names the session that is actually up", JSON.parse(readFileSync(staleFile, "utf8")).pid === started.value?.session?.browser?.pid, {
        onDisk: JSON.parse(readFileSync(staleFile, "utf8")).pid,
        running: started.value?.session?.browser?.pid
    });
    console.log(`  the call took ${Date.now() - began}ms`);
    check("session started", started.value?.session?.running === true, started.value);
    check("the browser process is alive", started.value?.session?.browser?.alive === true, started.value?.session?.browser);
    check("the page is served on the asked port", started.value?.session?.gamePort === gamePort, started.value?.session);
    check(
        "the page URL carries this server's bridge port, which is how the plugin found it without an edit",
        (started.value?.session?.url ?? "").includes(`?rmmzBridgePort=${bridgePort}`),
        started.value?.session?.url
    );
    check(
        "either the game reported, or the reply says it did not and what to do",
        started.value?.bridgeConnected === true || /live_session \{"action":"boot"\}/.test(started.value?.boot?.note ?? ""),
        started.value?.boot
    );
    console.log(`  bridge connected within the call: ${started.value?.bridgeConnected}`);

    console.log("\n== boot in its own call, the way a sixty-second client would");
    const booted = await call("live_session", { action: "boot", bootMs: 60_000 }, 90_000);
    check("walked to the starting map", booted.value?.boot?.final === "Scene_Map" && booted.value?.boot?.map > 0, booted.value?.boot);
    check("scenes seen on the way in", (booted.value?.boot?.scenes ?? []).length >= 2, booted.value?.boot?.scenes);
    const pid = started.value?.session?.browser?.pid;
    const profileDir = started.value?.session?.profileDir;

    console.log("\n== the live tools have a game to answer from");
    const status = await call("live_status");
    check("scene is a map", status.value?.state?.scene === "Scene_Map", status.value?.state);
    check("the page counts as focused (keepAwake)", status.value?.state?.focused === true, status.value?.state);
    // Scene_Map is entered while the screen is still fading in from black, and a
    // black frame is exactly what live_screenshot refuses to pass off as a view.
    let screenshot = await call("live_screenshot");
    for (let attempt = 0; attempt < 6 && !screenshot.parts.some(part => part.type === "image"); attempt++) {
        await new Promise(done => setTimeout(done, 2000));
        screenshot = await call("live_screenshot");
    }
    const image = screenshot.parts.find(part => part.type === "image");
    check("a frame comes back", Boolean(image) && Buffer.from(image.data, "base64").length > 20_000, screenshot.value);
    const inGameMap = await liveEval("$gameMap.mapId()");
    check("live_eval agrees with the boot report", inGameMap === booted.value.boot.map, { inGameMap, boot: booted.value.boot.map });

    console.log("\n== batch paints, then fails and undoes, under the running game");
    // Paint the map the player is actually standing on, since live_reload is what
    // makes the running game re-read it.
    const liveMapId = booted.value.boot.map || (await liveEval("$gameMap.mapId()"));
    const mapName = `Map${String(liveMapId).padStart(3, "0")}`;
    const mapBytes = readFileSync(join(projectDir, "data", `${mapName}.json`));
    const paint = tileId => ({ tool: "set_tiles", args: { mapId: liveMapId, rect: { x: 2, y: 2, width: 2, height: 2, layer: 1, tileId } } });
    const applied = await call("batch", { steps: [paint(4332), { tool: "live_reload" }] });
    check("the batch applied and wrote the map", applied.value?.ok === true && applied.value.wrote.includes(mapName), applied.value);
    check("the running game shows the painted tiles", (await liveEval(PAINTED_CELL)) === 4332, await liveEval(PAINTED_CELL));
    const undone = await call("batch", { steps: [paint(4400), { tool: "live_reload" }, { tool: "get_map", args: { mapId: 4242 } }] });
    check("the failing batch rolled back", undone.value?.ok === false && undone.value.rolledBack?.length === 1, undone.value);
    check("the rollback names the live step it cannot undo", /live_reload/.test(undone.value?.note ?? ""), undone.value?.note);
    check(
        "the game still shows what that step reloaded",
        (await liveEval(PAINTED_CELL)) === 4400,
        "the running game is ahead of the files, which is what that note is for"
    );
    const fileRow = await call("get_map", { mapId: liveMapId, layerDump: { layer: 1, x: 2, y: 2, width: 2, height: 1 } });
    check("the file already says otherwise", JSON.stringify(fileRow.value.layerDump.grid) === "[[4332,4332]]", fileRow.value.layerDump);
    await call("live_reload");
    check("after a reload the game matches the rolled-back files", (await liveEval(PAINTED_CELL)) === 4332, await liveEval(PAINTED_CELL));

    const writesToMap = (await call("write_history", { limit: 50 })).value.entries.filter(entry => entry.name === mapName).length;
    await call("undo_writes", { steps: writesToMap });
    check(`${mapName}.json is byte-identical to how it started`, readFileSync(join(projectDir, "data", `${mapName}.json`)).equals(mapBytes));

    console.log("\n== reload the page, which is what a new plugin file needs");
    // performance.timeOrigin belongs to the document, so a new one is proof the
    // browser really made a new page rather than carrying on.
    const originBefore = await liveEval("performance.timeOrigin");
    const reloaded = await call("live_session", { action: "reload", newGame: false, waitForBridgeMs: 30_000 }, 60_000);
    check("a new page is polling the bridge", reloaded.value?.reloaded === true, reloaded.value);
    check("the same browser is still in charge", reloaded.value?.session?.browser?.pid === pid, reloaded.value?.session?.browser);
    const afterReload = await call("live_session", { action: "boot", bootMs: 60_000 }, 90_000);
    check("boot reaches a map again after the reload", afterReload.value?.boot?.final === "Scene_Map", afterReload.value?.boot);
    const originAfter = await liveEval("performance.timeOrigin");
    check("the page really restarted: it has a new document", originAfter > originBefore, { originBefore, originAfter });

    console.log("\n== stop");
    const stopped = await call("live_session", { action: "stop" }, 60_000);
    check("the recorded browser was killed", stopped.value?.stopped?.killed === true, stopped.value);
    check("the bridge went quiet, so nothing of ours is still reporting", stopped.value?.wentQuiet === true, stopped.value?.note);
    let alive = true;
    try {
        process.kill(pid, 0);
    } catch {
        alive = false;
    }
    check("that pid is gone", alive === false, { pid, alive });
    check("the game port is released", (await portIsOpen(gamePort)) === false, { gamePort });
    const after = await call("live_session", { action: "status" });
    check("no session and no record left", after.value.session === null && after.value.stale === null, after.value);
    check("the browser profile directory is removed", stopped.value?.profileDirRemoved === true, stopped.value);

    console.log("\n== start again with nothing but the defaults, then stop");
    const oneCall = await call("live_session", { action: "start" }, 180_000);
    console.log(`  the call took ${oneCall.ms}ms and reported bridgeConnected=${oneCall.value?.bridgeConnected}`);
    check("the default start launches a session", oneCall.value?.session?.running === true, oneCall.value);
    if (oneCall.value?.bridgeConnected !== true) {
        check("a page slower than the wait is told, with the next call named", /"action":"boot"/.test(oneCall.value?.boot?.note ?? ""), oneCall.value?.boot?.note);
    }
    const finished =
        oneCall.value?.boot?.final === "Scene_Map"
            ? oneCall
            : await call("live_session", { action: "boot", bootMs: 60_000 }, 90_000);
    check("the default path ends on a map", finished.value?.boot?.final === "Scene_Map" && finished.value?.boot?.map > 0, finished.value?.boot);
    const second = await call("live_session", { action: "stop" });
    check("the second browser is gone too", second.value?.stopped?.killed === true, second.value);
} finally {
    console.log("\nthe project's plugins.js was never moved, so there is nothing to restore");
    const cleanup = await call("live_session", { action: "stop" });
    check("nothing is left running", cleanup.value.stopped === null || cleanup.value.stopped?.killed === true, cleanup.value);
    await client.close();
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}  session-tool`);
process.exit(failures === 0 ? 0 : 1);
