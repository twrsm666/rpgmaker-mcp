import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_ROOT, corescriptRoot, liveToken, projectDir } from "./local-env.mjs";

/**
 * Verify the live bridge against the real RPG Maker Maker MZ engine: serves the
 * project over http so a browser can run it as a playtest, keeps the MCP server
 * alive in this process, and reports what the running game sends back.
 */
const here = PACKAGE_ROOT;
const token = liveToken();

process.env.RMMZ_LIVE_TOKEN = token;
process.env.RMMZ_LIVE_PORT = process.env.RMMZ_LIVE_PORT ?? "3789";
process.env.RMMZ_PROJECT = projectDir;
process.env.RMMZ_CORESCRIPT_ROOT = corescriptRoot();

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".gif": "image/gif",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".css": "text/css; charset=utf-8",
    ".efkefc": "application/octet-stream",
    ".txt": "text/plain; charset=utf-8"
};

const GAME_PORT = 8080;
const staticServer = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const file = normalize(join(projectDir, path));
    if (!file.startsWith(projectDir) || !existsSync(file)) {
        response.writeHead(404).end("not found");
        return;
    }
    response.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    response.end(readFileSync(file));
});
await new Promise(done => staticServer.listen(GAME_PORT, "127.0.0.1", done));
console.log(`game served at http://127.0.0.1:${GAME_PORT}/index.html  (project ${projectDir})`);

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { server } = await import("../dist/index.js");

const client = new Client({ name: "verify-live", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const textPart = result.content.find(part => part.type === "text");
    const imagePart = result.content.find(part => part.type === "image");
    if (result.isError) {
        return { toolError: textPart?.text ?? "" };
    }
    const parsed = textPart ? JSON.parse(textPart.text) : {};
    return imagePart ? { ...parsed, image: imagePart } : parsed;
};

const waitFor = async (what, timeoutMs, probe) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await probe();
        if (value) {
            return value;
        }
        if (Date.now() > deadline) {
            throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
};

const started = Date.now();
// Boot the game before anything else: every phase then talks to one fresh session
// instead of a leftover page from a previous run.
console.log("starting a fresh game session...");
if (process.env.RMMZ_SKIP_BOOT) {
    console.log("RMMZ_SKIP_BOOT is set: the browser is expected to open the game page itself.");
} else {
    const booted = spawnSync(process.execPath, [join(here, "scripts", "drive-game.mjs"), "9333"], { stdio: "inherit" });
    if (booted.status !== 0) {
        console.error(`drive-game.mjs failed with status ${booted.status}; nothing to verify against.`);
        process.exit(1);
    }
}
console.log("waiting for the game to connect through RMMZLiveBridge...");
let connected = false;
while (Date.now() - started < 300_000) {
    const status = await call("live_status");
    if (status.state && status.ageMs < 8000) {
        console.log(`\nconnected after ${((Date.now() - started) / 1000).toFixed(1)}s`);
        console.log(`state: scene=${status.state.scene} map=${JSON.stringify(status.state.map)} player=${JSON.stringify(status.state.player)} gold=${status.state.gold} title=${JSON.stringify(status.state.gameTitle)} engine=${status.state.engine}`);
        connected = true;
        break;
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
}
if (!connected) {
    console.log("TIMEOUT: no game connected within 300s");
    process.exit(1);
}

const probes = [
    ["engine version", "$dataSystem.advanced.gameId"],
    ["map id", "$gameMap.mapId()"],
    ["map size", "[$gameMap.width(), $gameMap.height()]"],
    ["player tile", "[$gamePlayer.x, $gamePlayer.y]"],
    ["pixel position", "[$gamePlayer.screenX(), $gamePlayer.screenY()]"],
    ["tileset name", "$dataTilesets[$gameMap.tilesetId()].name"],
    ["tile under player", "$gameMap.tileId($gamePlayer.x, $gamePlayer.y, 0)"],
    ["passable up?", "$gameMap.isPassable($gamePlayer.x, $gamePlayer.y, 3)"],
    ["region under player", "$gameMap.regionId($gamePlayer.x, $gamePlayer.y)"],
    ["party", "$gameParty.battleMembers().map(m => m.name() + ' Lv' + m.level)"],
    ["frame counter", "Graphics.frameCount"],
    ["renderer", "String(PIXI.VERSION)"]
];
console.log("\n== live_eval against the running engine");
// Collect engine errors through the bridge: SceneManager.catchException stops the
// game loop, so a failure this side of the bridge is otherwise invisible.
console.log("error hook:", JSON.stringify(await call("live_eval", {
    expression: `(() => {
        window.__rmmzErrors = window.__rmmzErrors || [];
        if (!window.__rmmzHooked) {
            const original = SceneManager.catchException.bind(SceneManager);
            SceneManager.catchException = function (error) {
                window.__rmmzErrors.push(String((error && (error.stack || error.message)) || error));
                original(error);
            };
            window.addEventListener("error", event => window.__rmmzErrors.push("onerror: " + event.message));
            window.__rmmzHooked = true;
        }
        return "hooked";
    })()`,
    timeoutMs: 8000
})));
for (const [label, expression] of probes) {
    const result = await call("live_eval", { expression, timeoutMs: 6000 });
    console.log(`${label.padEnd(20)} ${result.toolError ? "ERROR " + result.toolError.slice(0, 120) : JSON.stringify(result.value)}`);
}

console.log("\n== live_key + live_wait");
const key = await call("live_key", { keyCode: 13 });
console.log("live_key 13 ->", JSON.stringify(key));
const start = (await call("live_eval", { expression: "[$gamePlayer.x, $gamePlayer.y]" })).value;
const up = await call("live_key", { keyCode: 38, pulses: 4 });
console.log("live_key 38 ->", JSON.stringify(up));
const moving = await call("live_wait", { expression: "$gamePlayer.isMoving()", timeoutMs: 4000, pollMs: 200 });
console.log("live_wait isMoving ->", JSON.stringify(moving));
const afterMove = await call("live_wait", {
    expression: `($gamePlayer.x !== ${start[0]} || $gamePlayer.y !== ${start[1]}) ? [$gamePlayer.x, $gamePlayer.y] : null`,
    timeoutMs: 6000,
    pollMs: 250
});
console.log(`player from ${JSON.stringify(start)} ->`, JSON.stringify(afterMove));
const facing = await call("live_eval", { expression: "$gamePlayer.direction()" });
console.log("player direction after the up press (8 = up):", JSON.stringify(facing.value));

console.log("\n== render_map vs the map the game is actually on");
const liveMapId = (await call("live_eval", { expression: "$gameMap.mapId()" })).value;
const render = await call("render_map", { mapId: liveMapId, scale: 1 });
writeFileSync(join(here, "samples", "live-render.png"), Buffer.from(render.image.data, "base64"));
console.log(`map ${liveMapId} rendered ${render.pixels?.join("x")} engine=${render.stats?.engine} rects=${render.stats?.lowerRects} warnings=${(render.warnings ?? []).length}`);
const engineTile = (await call("live_eval", { expression: "[$gamePlayer.x, $gamePlayer.y, $gameMap.tileId($gamePlayer.x, $gamePlayer.y, 0)]" })).value;
const cell = await call("inspect_cell", { mapId: liveMapId, x: engineTile[0], y: engineTile[1] });
const myTile = cell.layers.find(layer => layer.layer === 0).tileId;
console.log(`engine says tile ${engineTile[2]} at (${engineTile[0]},${engineTile[1]}), inspect_cell says ${myTile} -> ${engineTile[2] === myTile ? "MATCH" : "MISMATCH"}`);

console.log("\n== author a Show Text dialog with the tools, then let the real engine load it from disk");
// The reported bug was a dialog whose 401 lines arrived as
// $gameMessage._texts = [null, null]. An empty line is included on purpose: it
// must stay "" and must not become null.
// A transfer to a map the game has never loaded is used instead of reloading the
// page, because that is the path the engine itself uses to read a map file.
const PROBE_MAP_NAME = "McpBridgeProbe";
const sourceMap = liveMapId;
const maps = (await call("list_maps")).maps;
const source = maps.find(map => map.id === sourceMap);
const existingMap = maps.find(map => map.name === PROBE_MAP_NAME);
const created = existingMap ?? (await call("create_map", { name: PROBE_MAP_NAME, width: 6, height: 6, tilesetId: source.tilesetId }));
const probeMap = existingMap ? existingMap.id : created.mapId ?? created.id;
console.log(`probe map ${probeMap} (${existingMap ? "reused" : "created"}, tileset ${source.tilesetId})`);

const before = (await call("get_map", { mapId: probeMap })).events?.find(event => event && event.name === "McpBridgeDialog");
const placed = before ? { id: before.id } : await call("place_event", { mapId: probeMap, x: 2, y: 2, name: "McpBridgeDialog" });
const dialogEvent = placed.id;
console.log("place_event:", JSON.stringify(placed));
await call("set_event_page", { mapId: probeMap, eventId: dialogEvent, pageIndex: 0, trigger: 3, priorityType: 1, conditions: {} });
await call("set_commands", { mapId: probeMap, eventId: dialogEvent, pageIndex: 0, list: [] });
const dialog = await call("show_text", {
    mapId: probeMap,
    eventId: dialogEvent,
    lines: ["bridge dialog", "", "party leader is \\N[1]", "end"],
    background: 0,
    positionType: 1,
    speakerName: "MCP"
});
// An autorun page restarts the moment it finishes, which would reopen the dialog
// forever, so end it with a self switch and park a second page on that switch -
// the way real eventing does.
await call("add_commands", {
    mapId: probeMap,
    eventId: dialogEvent,
    commands: [{ code: 123, indent: 0, parameters: ["A", 0] }]
});
await call("set_event_page", { mapId: probeMap, eventId: dialogEvent, pageIndex: 1, conditions: { selfSwitch: "A" } });
console.log("show_text:", JSON.stringify({ commandsAdded: dialog.commandsAdded, notice: dialog.notice ? "present" : "missing" }));
const onDisk = await call("decode_commands", { mapId: probeMap, eventId: dialogEvent });
console.log("decoded back:", JSON.stringify(onDisk.commands ?? onDisk).slice(0, 300));

console.log(`transferring the live player onto map ${probeMap}...`);
console.log("reserveTransfer ->", JSON.stringify(await call("live_eval", { expression: `$gamePlayer.reserveTransfer(${probeMap}, 1, 2, 8, 0), $gamePlayer.isTransferring()`, timeoutMs: 8000 })));
let arrived = null;
try {
    arrived = await waitFor("the transfer to land on the probe map", 40_000, async () => {
        const value = (await call("live_eval", { expression: "$gameMap.mapId()", timeoutMs: 6000 })).value;
        return value === probeMap ? value : null;
    });
} catch (error) {
    console.log(String(error.message));
    console.log("engine errors seen:", JSON.stringify((await call("live_eval", { expression: "window.__rmmzErrors", timeoutMs: 6000 })).value, null, 1));
    console.log("live state:", JSON.stringify((await call("live_eval", { expression: "({scene: SceneManager._scene.constructor.name, frame: Graphics.frameCount, changing: SceneManager.isSceneChanging(), map: $gameMap.mapId(), transferring: $gamePlayer._transferring, newMap: $gamePlayer._newMapId, mapLoaded: DataManager.isMapLoaded(), dataMap: Boolean($dataMap), player: [$gamePlayer.x, $gamePlayer.y]})", timeoutMs: 6000 })).value));
    throw error;
}
console.log("player is on map", arrived);

const message = await waitFor("the dialog to open", 60_000, async () => {
    const value = (await call("live_eval", { expression: "$gameMessage && $gameMessage.hasText() ? $gameMessage._texts : null", timeoutMs: 6000 })).value;
    return Array.isArray(value) && value.length > 0 ? value : null;
});
console.log("engine $gameMessage._texts =", JSON.stringify(message));
const hasNull = message.some(line => line === null || line === undefined);
console.log(`no null lines -> ${hasNull ? "FAIL" : "PASS"}`);
console.log(`line count ${message.length} (authored 4) -> ${message.length === 4 ? "PASS" : "FAIL"}`);
const authored = ["bridge dialog", "", "party leader is \\N[1]", "end"];
console.log(`lines match what was authored -> ${JSON.stringify(message) === JSON.stringify(authored) ? "PASS" : "FAIL: " + JSON.stringify(authored)}`);
console.log(`empty line stayed "" -> ${message[1] === "" ? "PASS" : "FAIL: " + JSON.stringify(message[1])}`);
const rendered = (await call("live_eval", {
    expression: "SceneManager._scene._messageWindow ? SceneManager._scene._messageWindow.convertEscapeCharacters($gameMessage._texts[2]) : null",
    timeoutMs: 6000
})).value;
console.log(`escape code through the real window -> ${rendered && !rendered.includes("\\N") ? "PASS: " + JSON.stringify(rendered) : "FAIL: " + JSON.stringify(rendered)}`);

// Informational rather than a verdict: pressing Ok is confirmed to reach the
// message window (the pause flips and the typewriter index moves), but in an
// unfocused headless tab the typewriter can stop mid-page, which is the runtime's
// own behaviour and nothing the server can influence. What the *tools* are
// responsible for - that the dialog data loads into the engine at all - is
// asserted above.
let response = "no response recorded";
for (let attempt = 1; attempt <= 6; attempt++) {
    await call("live_key", { keyCode: 13 });
    await call("live_key", { keyCode: 13 });
    const windowState = JSON.parse((await call("live_eval", {
        expression: `JSON.stringify({pause: SceneManager._scene._messageWindow.pause, typed: SceneManager._scene._messageWindow._textState ? SceneManager._scene._messageWindow._textState.index : null, hasText: $gameMessage.hasText()})`,
        timeoutMs: 6000
    })).value ?? "{}");
    console.log(`  press round ${attempt}: ${JSON.stringify(windowState)}`);
    if (!windowState.hasText) {
        response = `closed after ${attempt} round(s)`;
        break;
    }
    response = `window reacted (pause=${windowState.pause}, typed=${windowState.typed})`;
}
console.log(`dialog key input -> ${response}`);
const cleaned = await call("remove_event", { mapId: probeMap, eventId: dialogEvent });
console.log("probe event removed again:", JSON.stringify(cleaned));

await client.close();
await server.close();
staticServer.close();
console.log("\ndone");
process.exit(0);
