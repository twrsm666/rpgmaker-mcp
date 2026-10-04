/**
 * Play the tiny game in a real MZ runtime through the live bridge: start a new
 * game, talk to the NPC, take the portal, open the chest, and check the engine's
 * own state after each step. This is the end of the loop the file layer starts:
 * data authored with MCP tools, then verified by running it.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_ROOT, corescriptRoot, liveToken, projectDir } from "./local-env.mjs";

const here = PACKAGE_ROOT;
const token = liveToken();
process.env.RMMZ_LIVE_TOKEN = token;
// Overridable because an MCP server registered in an editor may already hold the
// default port, and this harness runs its own in-process server.
process.env.RMMZ_LIVE_PORT = String(Number(process.env.RMMZ_LIVE_PORT || 3789));
process.env.RMMZ_PROJECT = projectDir;
process.env.RMMZ_CORESCRIPT_ROOT = corescriptRoot();

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".woff": "font/woff", ".woff2": "font/woff2", ".css": "text/css; charset=utf-8", ".efkefc": "application/octet-stream", ".txt": "text/plain; charset=utf-8" };
const staticServer = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const file = normalize(join(projectDir, path));
    if (!file.startsWith(projectDir) || !existsSync(file) || statSync(file).isDirectory()) {
        response.writeHead(404).end("not found");
        return;
    }
    response.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    response.end(readFileSync(file));
});
await new Promise(done => staticServer.listen(8080, "127.0.0.1", done));

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { server } = await import("../dist/index.js");
const client = new Client({ name: "playtest", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content ?? []).find(part => part.type === "text")?.text ?? "";
    if (result.isError) {
        throw new Error(`${name}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : {};
};

let failures = 0;
const check = (label, condition, detail) => {
    if (!condition) {
        failures++;
    }
    console.log(`  ${condition ? "PASS" : "FAIL"}  ${label}${condition || detail === undefined ? "" : ` -> ${JSON.stringify(detail).slice(0, 260)}`}`);
};

const evalIn = async expression => (await call("live_eval", { expression, timeoutMs: 8000 })).value;
const waitFor = async (what, timeoutMs, probe) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await probe();
        if (value) {
            return value;
        }
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${what}`);
        }
        await new Promise(resolve => setTimeout(resolve, 400));
    }
};

console.log("booting a fresh playtest...");
if (!process.env.RMMZ_SKIP_BOOT) {
    spawnSync(process.execPath, [join(here, "scripts", "drive-game.mjs"), "9333"], { stdio: "inherit" });
}

// Wait for a map scene specifically: the bridge reports from every scene, so the
// first state that arrives is Scene_Boot, not the game under test.
const state = await waitFor("the game to reach a map", 180_000, async () => {
    const status = await call("live_status");
    return status.state && status.ageMs < 8000 && status.state.scene === "Scene_Map" && status.state.map ? status.state : null;
});
console.log(`connected: scene=${state.scene} map=${JSON.stringify(state.map)} player=${JSON.stringify(state.player)}`);

const village = (await call("list_maps")).maps.find(map => map.name === "MCP Village");
const cave = (await call("list_maps")).maps.find(map => map.name === "MCP Cave");
if (!village || !cave) {
    throw new Error("build the tiny game first: node scripts/build-tiny-game.mjs build");
}

console.log("\n== the new game starts where the tools put it");
check(`start map is the village (${village.id})`, state.map.id === village.id, state.map);
check("player is at the authored start position", state.player.x === 8 && state.player.y === 9, state.player);
check("title comes from System.json patched through the tools", (await evalIn("$dataSystem.gameTitle")) === "MCP 小屋试验", await evalIn("$dataSystem.gameTitle"));

console.log("\n== file view and engine view agree about the map");
const engineSize = await evalIn("[$gameMap.width(), $gameMap.height()]");
check(`engine map size ${JSON.stringify(engineSize)} matches the file`, engineSize[0] === village.width && engineSize[1] === village.height, { engineSize, file: [village.width, village.height] });
const engineTileset = await evalIn("$dataTilesets[$gameMap.tilesetId()].name");
check(`engine tileset "${engineTileset}" matches the file`, engineTileset === "Overworld", engineTileset);
const spotChecks = await Promise.all(
    [[8, 9], [12, 4], [0, 7], [19, 8]].map(async ([x, y]) => {
        const engine = await evalIn(`$gameMap.tileId(${x}, ${y}, 0)`);
        const mine = (await call("inspect_cell", { mapId: village.id, x, y })).layers.find(layer => layer.layer === 0).tileId;
        return { x, y, engine, mine };
    })
);
for (const spot of spotChecks) {
    check(`layer 0 tile at (${spot.x},${spot.y}) agrees`, spot.engine === spot.mine, spot);
}

const frameCheck = (label, frame) => {
    const [lit, total] = String(frame.litSamples ?? "0/0").split("/").map(Number);
    check(
        `${label} (${frame.pixels?.join("x")}, ${Math.round((frame.bytes ?? 0) / 1024)}KB, ${lit}/${total} lit)`,
        frame.scene === "Scene_Map" && lit > total * 0.2 && frame.bytes > 20_000,
        frame
    );
};

console.log("\n== the asset scan catches what the engine only complains about at runtime");
const systemFile = join(projectDir, "data", "System.json");
const originalTitle = JSON.parse(readFileSync(systemFile, "utf8")).title1Name;
const cleanScan = await call("check_assets");
check(
    `${cleanScan.refsChecked} references resolve to ${cleanScan.distinctFiles} distinct files`,
    cleanScan.ok === true,
    { missing: cleanScan.missing.slice(0, 6), caseMismatch: cleanScan.caseMismatch.slice(0, 6) }
);
await call("patch_database_entry", { table: "System", patch: { title1Name: "NoSuchTitleImage" } });
const brokenScan = await call("check_assets");
const titleIssue = brokenScan.missing.find(issue => issue.from.includes("title1Name"));
check("a renamed title image shows up as missing", brokenScan.ok === false && Boolean(titleIssue), brokenScan.missing.slice(0, 6));
check(`and it names the folder and the referring field (${titleIssue?.from})`, titleIssue?.folder === "img/titles1", titleIssue);
await call("patch_database_entry", { table: "System", patch: { title1Name: originalTitle.toLowerCase() } });
const caseScan = await call("check_assets");
check(
    "a wrong case is a case mismatch, not a missing file",
    caseScan.caseMismatch.some(issue => issue.from.includes("title1Name") && issue.found?.endsWith(`${originalTitle}.png`)) &&
        caseScan.missing.every(issue => !issue.from.includes("title1Name")),
    { caseMismatch: caseScan.caseMismatch.slice(0, 3), missing: caseScan.missing.slice(0, 3) }
);
await call("patch_database_entry", { table: "System", patch: { title1Name: originalTitle } });
check("and the scan is clean again once it is put back", (await call("check_assets")).ok === true);

console.log("\n== a whole list of assertions runs in one call");
const suite = await call("assert_in_game", {
    assertions: [
        { label: "the party has four members", expression: "$gameParty.battleMembers().length === 4" },
        { label: "the engine and the file agree on the event count", expression: `$gameMap.events().length === ${village.eventCount}` },
        { label: "a dialog opens when one is queued", expression: "(() => { $gameMessage.add('probe'); return $gameMessage.hasText(); })()", timeoutMs: 5000 },
        { label: "a deliberately wrong claim fails instead of throwing", expression: "false" }
    ]
});
check(
    `${suite.passed}/${suite.results.length} passed with the failure reported, not thrown`,
    suite.failed === 1 && suite.results.some(result => !result.ok && result.label.includes("deliberately wrong")),
    suite.results.map(result => `${result.ok ? "ok" : "fail"} ${result.label}`)
);
const polled = suite.results.find(result => result.label.includes("dialog"));
check("the polling assertion waited for the engine and passed", polled.ok && polled.waitedMs >= 0, polled);
check("a clean run logs nothing alongside", suite.loggedWhileRunning.length === 0, suite.loggedWhileRunning);
await evalIn("$gameMessage.clear()");

console.log("\n== talk to the villager");
await evalIn("$gamePlayer.locate(8, 10); $gamePlayer.setDirection(8)");
await call("live_key", { keyCode: 13, pulses: 6 });
const dialog = await waitFor("the villager's dialog to open", 30_000, async () => {
    const texts = await evalIn("$gameMessage.hasText() ? $gameMessage._texts : null");
    return Array.isArray(texts) && texts.length ? texts : null;
});
console.log("  engine shows:", JSON.stringify(dialog));
check("four lines, none of them null", dialog.length === 4 && dialog.every(line => typeof line === "string"), dialog);
check("the escape code is intact for the window to expand", dialog[3].includes("\\N[1]"), dialog[3]);
check("speaker name made it through", (await evalIn("$gameMessage.speakerName()")) === "村民", await evalIn("$gameMessage.speakerName()"));
frameCheck("the frame with the dialog open", await call("live_screenshot", { saveTo: join(here, "samples", "live-frame-dialog.png") }));

console.log("\n== take the portal to the cave");
await evalIn("$gameMessage.clear()");
frameCheck("the frame of the village itself", await call("live_screenshot", { saveTo: join(here, "samples", "live-frame-map.png") }));
const authored = JSON.parse(readFileSync(join(projectDir, "data", `Map${String(village.id).padStart(3, "0")}.json`), "utf8"));
const portal = authored.events.filter(Boolean).find(event => event.name === "To Cave");
const transfer = portal.pages[0].list.find(command => command.code === 201);
const [portalMapId, portalX, portalY] = transfer.parameters.slice(1, 4);
console.log(`  portal event ${portal.id} at (${portal.x},${portal.y}) transfers to map ${portalMapId} (${portalX},${portalY})`);
let arrived = null;
// One press per attempt: a longer pulse train keeps walking after the transfer has
// already been queued, so the player lands a tile away from the authored position.
for (let attempt = 1; attempt <= 4 && !arrived; attempt++) {
    await evalIn(`$gamePlayer.locate(${portal.x}, ${portal.y + 1}); $gamePlayer.setDirection(8)`);
    await call("live_key", { keyCode: 38, pulses: 1 });
    // A player-touch event only fires from actual movement (`checkEventTriggerHere`
    // runs when the player was moving), so walk onto the portal rather than locating.
    arrived = await waitFor("the transfer into the cave", 15_000, async () =>
        (await evalIn("$gameMap.mapId()")) === portalMapId ? portalMapId : null
    ).catch(() => null);
}
check(`player-touch portal moved us to map ${portalMapId}`, arrived === cave.id, await evalIn("$gameMap.mapId()"));
const cavePlayer = await evalIn("[$gamePlayer.x, $gamePlayer.y]");
check(`landed at the coordinates the portal event specified (${portalX},${portalY})`, cavePlayer[0] === portalX && cavePlayer[1] === portalY, cavePlayer);

console.log("\n== open the cave chest");
const chest = (await call("find_events", { mapId: cave.id, name: "MCP Cave Chest" })).hits[0];
if (!chest) {
    throw new Error("no cave chest on the map the tools built");
}
console.log(`  cave chest is event ${chest.eventId} at (${chest.x},${chest.y})`);
const goldBefore = await evalIn("$gameParty.gold()");
await evalIn(`$gamePlayer.locate(${chest.x}, ${chest.y + 1}); $gamePlayer.setDirection(8)`);
await call("live_key", { keyCode: 13, pulses: 6 });
const goldAfter = await waitFor("the chest to pay out", 40_000, async () => {
    const gold = await evalIn("$gameParty.gold()");
    return gold > goldBefore ? gold : null;
}).catch(() => null);
check(`gold went ${goldBefore} -> ${goldAfter}`, goldAfter === goldBefore + 500, { goldBefore, goldAfter });
const selfSwitchKey = `$gameSelfSwitches.value([${cave.id}, ${chest.eventId}, "A"])`;
check("the chest's self switch is on", await evalIn(selfSwitchKey), await evalIn(selfSwitchKey));
const chestGraphic = await evalIn(`(() => { const e = $gameMap.event(${chest.eventId}); return e ? e.characterName() + ":" + e.characterIndex() : "none"; })()`);
check(`chest switched to its opened graphic (${chestGraphic})`, chestGraphic === "!Chest:1", chestGraphic);

console.log("\n== edit the world while the game keeps running");
const spot = { x: 5, y: 9 };
const tileBefore = await evalIn(`$gameMap.tileId(${spot.x}, ${spot.y}, 0)`);
// Paint something that is provably different, or the whole section proves nothing.
const tileAfter = tileBefore === 1536 ? 2816 : 1536;
await call("set_tiles", { mapId: cave.id, rect: { x: spot.x, y: spot.y, width: 1, height: 1, layer: 0, tileId: tileAfter } });
const probe = await call("place_event", { mapId: cave.id, x: 6, y: 9, name: "MCP Reload Probe" });
await call("set_event_page", {
    mapId: cave.id,
    eventId: probe.id,
    image: { characterName: "!Crystal", characterIndex: 0, direction: 8, pattern: 0, tileId: 0 },
    trigger: 0,
    priorityType: 1
});
const stale = await evalIn(`$gameMap.tileId(${spot.x}, ${spot.y}, 0)`);
check(`the running game still holds the copy it loaded (${tileAfter} on disk)`, stale === tileBefore && stale !== tileAfter, { tileBefore, tileAfter, stale });
check("and has no such event yet", (await evalIn(`$gameMap.event(${probe.id}) ? 1 : 0`)) === 0);
const positionBefore = await evalIn("[$gamePlayer.x, $gamePlayer.y]");
const reloaded = await call("live_reload");
console.log("  live_reload:", JSON.stringify(reloaded));
check("live_reload returns once the reloaded map is live", reloaded.mapReady === true, reloaded);
check(`the painted tile is live after reload (${tileBefore} -> ${tileAfter})`, (await evalIn(`$gameMap.tileId(${spot.x}, ${spot.y}, 0)`)) === tileAfter, await evalIn(`$gameMap.tileId(${spot.x}, ${spot.y}, 0)`));
const probeEvent = await evalIn(`(() => { const e = $gameMap.event(${probe.id}); return e ? e.event().name + "/" + e.characterName() : "none"; })()`);
check("the event authored after the game booted now exists", probeEvent === "MCP Reload Probe/!Crystal", probeEvent);
check("the player was left where they stood", JSON.stringify(await evalIn("[$gamePlayer.x, $gamePlayer.y]")) === JSON.stringify(positionBefore), await evalIn("[$gamePlayer.x, $gamePlayer.y]"));
check("the chest is still open, so game state survived the reload", await evalIn(selfSwitchKey), await evalIn(selfSwitchKey));
check("and back on a map scene", (await evalIn("SceneManager._scene.constructor.name")) === "Scene_Map");

console.log("== undo the probe edits and reload again");
await call("remove_event", { mapId: cave.id, eventId: probe.id });
await call("set_tiles", { mapId: cave.id, rect: { x: spot.x, y: spot.y, width: 1, height: 1, layer: 0, tileId: tileBefore } });
await call("live_reload");
check("the tile is back to what it was", (await evalIn(`$gameMap.tileId(${spot.x}, ${spot.y}, 0)`)) === tileBefore, await evalIn(`$gameMap.tileId(${spot.x}, ${spot.y}, 0)`));
check("the probe event is gone from the running map", (await evalIn(`$gameMap.event(${probe.id}) ? 1 : 0`)) === 0);

console.log("\n== freeze the world and walk it forward a frame at a time");
await waitFor("the player to stop walking", 20000, async () => ((await evalIn("$gamePlayer.isMoving()")) ? null : true));
// Find open ground rather than assuming the chest test left the player somewhere
// walkable: Game_CharacterBase.canPass answers for any tile, not just here.
const walk = await evalIn(
    `(() => {
        for (let y = 1; y < $gameMap.height() - 1; y++) {
            for (let x = 1; x < $gameMap.width() - 1; x++) {
                for (const d of [4, 6, 2, 8]) {
                    if ($gamePlayer.canPass(x, y, d)) {
                        return { x, y, d };
                    }
                }
            }
        }
        return null;
    })()`
);
if (!walk) {
    throw new Error(`no walkable tile on map ${JSON.stringify((await call("live_status")).state.map)}`);
}
// Input.keyMapper spells 37 left, 38 up, 39 right, 40 down; the engine's
// direction codes are 4 left, 8 up, 6 right, 2 down.
const keyCode = { 2: 40, 4: 37, 6: 39, 8: 38 }[walk.d];
console.log(`  walking from (${walk.x},${walk.y}) towards ${walk.d} with key ${keyCode}`);
await evalIn(`$gamePlayer.locate(${walk.x}, ${walk.y}); $gamePlayer.setDirection(${walk.d})`);
await call("live_key", { keyCode, pulses: 2 });
await waitFor("the player to start a step", 20000, async () => ((await evalIn("$gamePlayer.isMoving()")) ? true : null));
check("live_pause reports the new state", (await call("live_pause", { paused: true })).paused === true);
const frozenRealX = await evalIn("$gamePlayer._realX");
const frozenFrame = (await call("live_status")).state.frame;
await new Promise(resolve => setTimeout(resolve, 1500));
check("the walk stops mid-step, down to the sub-tile position", (await evalIn("$gamePlayer._realX")) === frozenRealX, {
    frozen: frozenRealX,
    now: await evalIn("$gamePlayer._realX")
});
check("and the character still reads as moving, because nothing has updated it", (await evalIn("$gamePlayer.isMoving()")) === true);
check(`the engine frame counter holds while paused (${frozenFrame})`, (await call("live_status")).state.frame === frozenFrame);
const stepped = await call("live_step", { frames: 10 });
check("live_step advanced exactly the frames asked for", stepped.advanced === 10 && stepped.paused === true, stepped);
check("and the walk moved forward", (await evalIn("$gamePlayer._realX")) !== frozenRealX, await evalIn("$gamePlayer._realX"));
frameCheck("a frame captured while paused", await call("live_screenshot", { saveTo: join(here, "samples", "live-frame-paused.png") }));
await call("live_pause", { paused: false });
check(
    "resuming lets the step finish",
    (await waitFor("the world to run again", 20000, async () => ((await evalIn("$gamePlayer.isMoving()")) ? null : true))) === true
);
const runningFrame = (await call("live_status")).state.frame;
check("and the frame counter moves on its own again", runningFrame > stepped.frame, { stepped: stepped.frame, runningFrame });

console.log("\n== the running game reports what it has logged");
await call("live_diagnostics", { clear: true });
await evalIn('console.error("playtest: deliberate console error")');
// Ask the engine's own loader, because that is the path a real missing sheet
// takes: a detached Image never reaches a window error listener.
await evalIn('Boolean(ImageManager.loadCharacter("__no_such_sheet__"))');
const diag = await waitFor("both faults to be recorded", 25000, async () => {
    const seen = await call("live_diagnostics");
    return seen.entries.length >= 2 ? seen : null;
});
console.log("  entries:", diag.entries.map(entry => `${entry.kind}/${entry.message.slice(0, 40)}`).join("  |  "));
check(
    "a console.error from inside the game comes back",
    diag.entries.some(entry => entry.kind === "console.error" && entry.message.includes("deliberate console error")),
    diag.entries
);
check(
    "a missing image sheet comes back as an asset fault with its url",
    diag.entries.some(entry => entry.kind === "asset" && entry.source.includes("__no_such_sheet__")),
    diag.entries
);
check("the cursor hides what was already read", (await call("live_diagnostics", { since: diag.cursor })).entries.length === 0);

console.log("\n== and it still talks after the game dies");
await evalIn('setTimeout(() => { throw new Error("playtest: deliberate crash"); }, 50)');
const crashed = await waitFor(
    "the crash to reach the buffer",
    30000,
    async () => {
        const seen = await call("live_diagnostics", { since: diag.cursor });
        return seen.entries.some(entry => entry.message.includes("deliberate crash")) ? seen : null;
    }
);
const crashEntries = crashed.entries.filter(entry => String(entry.message).includes("deliberate crash"));
const crashEntry = crashEntries.find(entry => entry.kind === "error");
check(`the uncaught error is recorded (${crashEntries.map(entry => entry.kind).join(", ")})`, Boolean(crashEntry), crashEntries);
check("and keeps the file and line it came from", /:\d+:\d+$/.test(crashEntry?.source || ""), crashEntry);
check("an ordinary read carries no call stack", crashEntry && crashEntry.stack === undefined, crashEntry);
const withStacks = await call("live_diagnostics", { since: diag.cursor, full: true });
const stacked = withStacks.entries.find(entry => entry.kind === "error" && String(entry.message).includes("deliberate crash"));
check(
    `full: true brings the frames back (${(stacked?.stack ?? []).length})`,
    Array.isArray(stacked?.stack) && stacked.stack.length > 0 && /^at |:\/|\.js/.test(stacked.stack.join(" ")),
    stacked?.stack
);
check(
    "the engine's own error screen is captured as a separate record",
    crashEntries.some(entry => entry.kind === "engine"),
    crashEntries
);
const deadState = (await call("live_status")).state;
check("live_status reports that the engine stopped its own loop", deadState.stopped === true, {
    stopped: deadState.stopped,
    paused: deadState.paused,
    scene: deadState.scene
});
check("and the bridge is still answering on a scene that is no longer updating", deadState.scene === "Scene_Map", deadState.scene);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
await client.close();
await server.close();
staticServer.close();
process.exit(failures === 0 ? 0 : 1);
