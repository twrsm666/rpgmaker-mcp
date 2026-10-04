/**
 * Prove that driving the running game actually moves the thing, on maps this script
 * builds for itself and then takes away again.
 *
 *   node scripts/verify-input.mjs
 *
 * Why it exists: an independent reviewer found that a `live_key` direction press can
 * leave the player standing still with nothing said about it, that `make_npc` handed both
 * top-level text and `pages[]` silently builds an NPC that never speaks, and that the
 * engine's step counter and encounter roll only advance on the path a keyboard drives.
 * None of those show up in a file-level assertion, so every check here runs against a live
 * headless playtest and reads engine state.
 *
 * It is also the first user of `set_tiles` with no `layer` argument, of `live_move`, and of
 * `delete_map` — the scratch maps are gone at the end, which is the point of that one.
 *
 * Own ports (3797 bridge / 8097 game) so it never collides with the registered server,
 * `session:e2e`, `e2e:live`, the lightrun playtest or Star Relay.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT, describeProjectChoice, liveToken, projectDir } from "./local-env.mjs";
import { ensureBoots } from "./ensure-bootable.mjs";

const bridgePort = Number(process.env.RMMZ_INPUT_PORT ?? 3797);
const gamePort = Number(process.env.RMMZ_INPUT_GAME_PORT ?? 8097);
const ROOM = "MCP INPUT ROOM";
const DOOR_TARGET = "MCP INPUT DOOR TARGET";
const token = liveToken();

process.env.RMMZ_PROJECT = projectDir;
process.env.RMMZ_LIVE_TOKEN = token;
process.env.RMMZ_LIVE_PORT = String(bridgePort);
console.log(describeProjectChoice());

if (!readFileSync(join(projectDir, "js", "plugins.js"), "utf8").includes(`"token":"${token}"`)) {
    console.error(`the bridge plugin in ${projectDir}/js/plugins.js does not carry this token; live commands would be refused`);
    process.exit(1);
}

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { server } = await import("../dist/index.js");
const client = new Client({ name: "input-verify", version: "1.0.0" });
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

/** A call that is supposed to refuse, so the refusal itself can be asserted. */
async function refuse(name, args) {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content?.find(part => part.type === "text")?.text ?? "";
    return result.isError ? text : null;
}

const evalIn = async (code, timeoutMs = 25000) => (await call("live_eval", { expression: code, timeoutMs }, timeoutMs + 8000)).value;
const CELL = `({ x: $gamePlayer.x, y: $gamePlayer.y, map: $gameMap.mapId(), scene: SceneManager._scene.constructor.name })`;
const mapFile = id => join(projectDir, "data", `Map${String(id).padStart(3, "0")}.json`);

/** Stand the player somewhere clean: no dialog, no running event, no half-finished step.
 *  It checks that the player *stayed* there, because a button the bridge left held walks
 *  them off the cell again before the next command reaches the page. */
async function place(x, y) {
    const where = `(() => ({ x: $gamePlayer.x, y: $gamePlayer.y, moving: $gamePlayer.isMoving(), ` +
        `down: Object.keys(Input._currentState).filter(key => Input._currentState[key] === true) }))()`;
    let at = null;
    for (let attempt = 0; attempt < 4; attempt++) {
        await evalIn(
            `(() => { $gameMessage.clear(); $gamePlayer.setPosition(${x}, ${y}); ` +
                // setPosition leaves _realX behind, which the engine reads as "still walking",
                // and moveByInput only ever runs when the player is not.
                `$gamePlayer._realX = ${x}; $gamePlayer._realY = ${y}; $gamePlayer.setDirection(2); $gamePlayer.refresh(); return true; })()`
        );
        await sleep(150);
        at = await evalIn(where);
        if (at.x === x && at.y === y && !at.moving) {
            return at;
        }
    }
    throw new Error(`place(${x}, ${y}) could not leave the player there: ${JSON.stringify(at)}`);
}

/** Wait until the map has nothing in flight: a dialog closing, an interpreter on its last
 *  command, the event re-choosing its page once a self switch lands. Pressing on fixed
 *  sleeps made the conversation section pass or fail on how busy the machine was. */
async function quiet(what) {
    const settled = await call(
        "live_wait",
        { expression: "!$gameMessage.isBusy() && !$gameMap.isEventRunning() && !$gameMap.isAnyEventStarting() && $gamePlayer.canMove()", timeoutMs: 20000, pollMs: 100 },
        35000
    );
    check(`the map is quiet before ${what}`, settled.satisfied === true, settled);
}

let room = null;
let target = null;
const teardown = async () => {
    try {
        await call("live_session", { action: "stop" }, 60000);
    } catch (error) {
        note("live_session stop said", error.message);
    }
    for (const id of [room, target]) {
        if (id) {
            await call("delete_map", { mapId: id, force: true }).catch(error => note(`delete_map ${id} said`, error.message));
        }
    }
};

// ---------------------------------------------------------------------------
// 1. A room to walk in, painted without naming a single layer
// ---------------------------------------------------------------------------

await ensureBoots(call);
console.log("\n== build the scratch room (set_tiles with no `layer`)");
const tilesets = (await call("read_database", { table: "Tilesets" })).entries ?? [];
const tileset = tilesets.find(row => String(row?.name ?? "").toLowerCase().includes("cave")) ?? tilesets[1];
for (const name of [ROOM, DOOR_TARGET]) {
    const stale = (await call("list_maps")).maps.find(map => map.name === name);
    if (stale) {
        await call("delete_map", { mapId: stale.id, force: true });
    }
}
// 2816 and 7378 are the floor and wall ids the acceptance game's cave uses on this same
// tileset — taken from its build script rather than guessed from a pixel.
const FLOOR = 2816;
const WALL = 7378;
room = (await call("create_map", { name: ROOM, width: 20, height: 10, tilesetId: tileset.id })).id;
target = (await call("create_map", { name: DOOR_TARGET, width: 6, height: 6, tilesetId: tileset.id })).id;
// Floor everywhere, then a one-cell wall ring. Painting the wall over the whole map and
// the floor back on top of it would still *look* like a room — and stay impassable,
// because A4 upper wall lives on layer 3, above the ground, and `checkPassage` consults
// every layer of the cell.
const ground = await call("set_tiles", { mapId: room, rect: { x: 0, y: 0, width: 20, height: 10, tileId: FLOOR } });
const walls = [];
for (const block of [
    { x: 0, y: 0, width: 20, height: 1, tileId: WALL },
    { x: 0, y: 9, width: 20, height: 1, tileId: WALL },
    { x: 0, y: 0, width: 1, height: 10, tileId: WALL },
    { x: 19, y: 0, width: 1, height: 10, tileId: WALL }
]) {
    walls.push(await call("set_tiles", { mapId: room, rect: block }));
}
check("filling a rect without a layer lands each tile on the layer its slot belongs to", !ground.warning && walls.every(pass => !pass.warning), {
    floor: ground.warning,
    wall: walls.map(pass => pass.warning).filter(Boolean)
});
check("and the reply says which layers it chose", typeof ground.layersUsed === "string" && walls[0].layersUsed === "A4→3", { floor: ground.layersUsed, wall: walls[0].layersUsed });
note("layers used", { floor: ground.layersUsed, wall: walls[0].layersUsed });
const render = await call("render_map", { mapId: room, saveTo: join(PACKAGE_ROOT, "samples", "input", "scratch-room.png") }, 60000);
check("the room renders", render.mapId === room && Array.isArray(render.pixels), render);

// ---------------------------------------------------------------------------
// 2. Boot, and stand in the room
// ---------------------------------------------------------------------------

console.log("\n== boot the playtest");
const started = await call("live_session", { action: "start", gamePort, newGame: false, waitForBridgeMs: 150000 }, 200000);
check("live_session brings the bridge up", started.bridgeConnected === true, started.session ?? started);
const booted = await call("live_session", { action: "boot", bootMs: 120000 }, 200000);
note("boot", JSON.stringify(booted.boot ?? booted).slice(0, 140));
const draw = await evalIn(
    `(() => new Promise(done => { const first = Graphics.frameCount; const at = Date.now(); ` +
        `setTimeout(() => done({ frames: Graphics.frameCount - first, ms: Date.now() - at, fps: Math.round(((Graphics.frameCount - first) * 1000) / (Date.now() - at)) }), 1500); }))()`
);
note("the page draws at", draw);
const status = await call("live_status");
check("no warning about a stale bridge plugin in the project", !/STALE BRIDGE/.test(status.note), status.note);
check("live_status reports the version the page is running", Boolean(status.state?.bridge), status.state?.bridge);
note("bridge on the page", `v${status.state?.bridge}, ${status.measuredFps} frames/s`);

// The acceptance game opens on an autorun that talks to the player, and a starting event
// is what `Game_Player.canMove()` and the scene's transfer check both refuse to work
// around. Clearing the message is not enough — the interpreter is still running and just
// shows the next line — so press on until the map is quiet.
for (let attempt = 0; attempt < 16; attempt++) {
    const busy = await evalIn("({ msg: $gameMessage.hasText() || $gameMessage.isBusy(), evRun: $gameMap.isEventRunning() })");
    if (!busy.msg && !busy.evRun) {
        break;
    }
    await call("live_key", { keyCode: 13, pulses: 2, holdFrames: 4 }, 60000);
    await sleep(250);
}
note("map quiet before the transfer", await evalIn("({ msg: $gameMessage.hasText(), evRun: $gameMap.isEventRunning() })"));
// reserveTransfer and *wait*: Scene_Map owns the transfer, because it is the scene that
// loads the new map file. Calling $gamePlayer.performTransfer() by hand rebuilds the map
// with the previous map's $dataMap still in place, which leaves the player "on" the new
// map while the old map's events are still running under them.
await evalIn(`(() => { $gamePlayer.reserveTransfer(${room}, 2, 5, 6, 0); return true; })()`);
const landed = await call("live_wait", { expression: `$gameMap.mapId() === ${room} && $gamePlayer.isTransferring() === false`, timeoutMs: 60000, pollMs: 200 }, 75000);
check("the engine's own transfer path put the player in the room", landed.satisfied === true, landed);
await sleep(600);
const arrived = await evalIn(CELL);
check("the player is standing in the scratch room", arrived.map === room && arrived.scene === "Scene_Map", arrived);

// ---------------------------------------------------------------------------
// 3. Twenty direction presses: the player has to have moved for every one
// ---------------------------------------------------------------------------

console.log("\n== live_key direction presses land");
const wallClockHold = Math.max(2, Math.ceil((120 * draw.fps) / 1000));
for (const [label, holdFrames] of [["default 2-frame hold", 2], [`wall-clock-sized hold (${wallClockHold} frames ≈ ${Math.round((wallClockHold / draw.fps) * 1000)}ms)`, wallClockHold]]) {
    let moved = 0;
    const misses = [];
    for (let press = 0; press < 10; press++) {
        await place(2, 5);
        const answer = await call("live_key", { keyCode: 39, pulses: 1, holdFrames }, 90000);
        const cell = await evalIn(CELL);
        if (cell.x > 2) {
            moved++;
        } else {
            misses.push({ press: press + 1, at: `${cell.x},${cell.y}`, heldFrames: answer.heldFrames, busy: answer.busy });
        }
    }
    check(`10 presses with the ${label} each move the player one cell`, moved === 10, { moved, misses: misses.slice(0, 4) });
}
const single = await call("live_key", { keyCode: 39, pulses: 1, holdFrames: 12 }, 90000);
check("the reply counts the frames the button was really down for", single.heldFrames === 12, single);
check("and names the cell it started on and the one it ended on", typeof single.from?.x === "number" && typeof single.at?.x === "number", single);
// The engine only learns a key went up from a real keyup event, which this page never
// gets: a bridge that stops asserting without writing false leaves `right` down, the
// player walks on their own, and the next press left reads `_signX() = right - left = 0`.
await sleep(200);
const stillDown = await evalIn("Object.keys(Input._currentState).filter(key => Input._currentState[key] === true)");
note("buttons the engine still thinks are down after the press", stillDown);
check("no arrow is left held down when a press ends", (stillDown ?? []).every(name => !["left", "right", "up", "down"].includes(name)), stillDown);

console.log("\n== live_move: walk, and stop honestly at a wall");
await place(2, 5);
await evalIn(`(() => { $gamePlayer._encounterCount = 999; return true; })()`);
const walk6 = await call("live_move", { direction: 6, cells: 6 }, 60000);
check("live_move walks 6 cells and reports 6", walk6.moved === 6 && walk6.at.x - walk6.from.x === 6, walk6);
check("over the engine's input path, so the party's step counter moved", walk6.steps?.after > walk6.steps?.before, walk6.steps);
// `moved` counts the cells the player *entered* (`_x` moves when a step starts), while the
// engine decrements `_encounterCount` when a step *finishes* (`updateNonmoving`), so the
// last cell of a walk is legitimately still in the air. One per step on plain ground, two
// on a bush tile — `encounterProgressValue()`. What must not happen is no movement at all,
// which is what an API call that moves the character directly gives you.
const dropped = walk6.encounterCount.before - walk6.encounterCount.after;
check(
    "and the encounter counter came down by a walked step's worth per cell",
    dropped >= walk6.moved - 1 && dropped <= walk6.moved * 2,
    { dropped, moved: walk6.moved, perStep: await evalIn("$gamePlayer.encounterProgressValue()"), counts: walk6.encounterCount }
);
await place(2, 5);
note(
    "state before the long walk",
    await evalIn(
        `(() => ({ cell: [$gamePlayer.x, $gamePlayer.y], moving: $gamePlayer.isMoving(), canMove: $gamePlayer.canMove(), evRunning: $gameMap.isEventRunning(), anyStarting: $gameMap.isAnyEventStarting(), interp: $gameMap._interpreter.isRunning(), msg: $gameMessage.isBusy(), events: $gameMap.events().length }))()`
    )
);
const walkFar = await call("live_move", { direction: 6, cells: 25 }, 60000);
check("asked for 25 cells in an 18-wide room it stops at the wall", walkFar.moved < 25 && walkFar.moved >= 14, walkFar);
check("and names the wall, rather than reporting nothing", /will not let the player through/.test(String(walkFar.stopped)), walkFar.stopped);
check("a walk that arrives early still counts the frames its key was held for", walkFar.heldFrames > walkFar.moved, walkFar.heldFrames);
await place(1, 5);
const intoWall = await call("live_move", { direction: 4, cells: 1 }, 60000);
check("walking into the border says so at once", intoWall.moved === 0 && /will not let the player through/.test(String(intoWall.stopped)), intoWall);
check("a direction that is not an arrow is refused", Boolean(await refuse("live_move", { direction: 5, cells: 1 })));

// ---------------------------------------------------------------------------
// 4. A two-page NPC, talked to in the running game
// ---------------------------------------------------------------------------

console.log("\n== make_npc with pages[], then talked to in the running game");
const PAGE_ONE = "第一页：你踩到的是我的地板。";
const PAGE_TWO = "第二页：你还在，Self Switch A 也亮了。";
const npc = await call("make_npc", {
    mapId: room,
    x: 10,
    y: 5,
    name: "Input Two Page NPC",
    image: { characterName: "Actor3", index: 0 },
    priorityType: 1,
    pages: [
        { script: [{ say: { lines: [PAGE_ONE], speaker: "Keeper" } }, { selfSwitch: { letter: "A" } }] },
        { when: { selfSwitch: "A" }, say: { lines: [PAGE_TWO], speaker: "Keeper" } }
    ]
});
const written = await call("get_map", { mapId: room });
const event = (written.events ?? []).find(one => one?.name === "Input Two Page NPC");
const pages = event?.pages ?? [];
// get_map summarises a page's conditions as the list of the *Valid flags that are on, so
// page 1 has none of them. The letter itself is only in the file.
const raw = JSON.parse(readFileSync(mapFile(room), "utf8"));
const rawPages = (raw.events ?? []).find(one => one?.name === "Input Two Page NPC")?.pages ?? [];
check("pages[] builds two pages, not one", npc.pages === 2 && pages.length === 2, { reply: npc.pages, file: pages.length });
check("page 1 of the file carries no condition, so the NPC can be talked to at all", (pages[0]?.conditions ?? []).length === 0, pages[0]?.conditions);
check(
    "page 2 is the one waiting on self switch A",
    (pages[1]?.conditions ?? []).includes("selfSwitchValid") && rawPages[1]?.conditions?.selfSwitchCh === "A",
    { summary: pages[1]?.conditions, file: rawPages[1]?.conditions }
);
const mixed = await refuse("make_npc", { mapId: room, x: 11, y: 5, say: ["x"], pages: [{ when: { selfSwitch: "A" }, say: ["y"] }] });
check("top-level text alongside pages[] is refused instead of merged into every page", /pages\[\] replaces the page list/.test(String(mixed)), mixed);
const both = await call("make_npc", { mapId: room, x: 12, y: 7, name: "Input Both NPC", image: { characterName: "Actor3", index: 0 }, pages: [{ say: ["spoken?"], script: [{ wait: 1 }] }] });
check("a page with say *and* script says the text is dropped instead of muting quietly", (both.warnings ?? []).some(line => /say lines are dropped/.test(String(line))), both.warnings ?? both);

await call("live_reload", {}, 60000);
// The reload goes through a scene change, and a scene that is fading does not pass input
// to the player — a press lands in the transition and is simply not heard.
const ready = await call("live_wait", { expression: `$gameMap.mapId() === ${room} && !SceneManager.isSceneChanging() && $gamePlayer.canMove()`, timeoutMs: 30000, pollMs: 150 }, 45000);
check("the reloaded map takes input again", ready.satisfied === true, ready);
await place(9, 5);
await quiet("the first conversation");
await evalIn("$gamePlayer.setDirection(6); true");
note("what stands in front of the player", await evalIn("({ cell: [$gamePlayer.x, $gamePlayer.y], facing: $gamePlayer.direction(), eventId: $gameMap.eventIdXy(10, 5) })"));
const talk = await call("live_key", { keyCode: 13, pulses: 1, holdFrames: 4 }, 60000);
note("the confirm press reported", { heldFrames: talk.heldFrames, busy: talk.busy });
await sleep(300);
const firstText = String(await evalIn("$gameMessage.hasText() ? $gameMessage.allText() : ''"));
check("one confirm press says page 1 out loud", firstText.includes(PAGE_ONE), { firstText });
await call("live_key", { keyCode: 13, pulses: 2, holdFrames: 4 }, 60000);
await quiet("page 2");
const selfOn = await evalIn(`String($gameSelfSwitches.value([${room}, ${npc.eventId}, "A"]))`);
check("and page 1 set the self switch the second page waits on", selfOn === "true", { selfOn, eventId: npc.eventId });
note("the page the engine has the event on now", await evalIn(`$gameMap.event(${npc.eventId})._pageIndex`));
await evalIn("$gamePlayer.setDirection(6); true");
await call("live_key", { keyCode: 13, pulses: 1, holdFrames: 4 }, 60000);
await sleep(300);
const secondText = String(await evalIn("$gameMessage.hasText() ? $gameMessage.allText() : ''"));
check("the next conversation is page 2", secondText.includes(PAGE_TWO), { secondText });
await call("live_key", { keyCode: 13, pulses: 2, holdFrames: 4 }, 60000);
await quiet("the map deletions");

// ---------------------------------------------------------------------------
// 5. Deleting maps, including one a door still opens onto
// ---------------------------------------------------------------------------

console.log("\n== delete_map, and the door that still points there");
const door = await call("place_event", { mapId: room, x: 14, y: 5, name: "Door To Nowhere" });
await call("set_commands", {
    mapId: room,
    eventId: door.id,
    pageIndex: 0,
    list: [{ code: 201, indent: 0, parameters: [0, target, 2, 2, 6, 0] }, { code: 0, indent: 0, parameters: [] }]
});
const refusal = await refuse("delete_map", { mapId: target });
check("deleting a map an event still transfers to is refused", Boolean(refusal), refusal);
check("and the refusal names the event that leads there", new RegExp(`"Door To Nowhere"|Door To Nowhere`).test(String(refusal)) && String(refusal).includes(String(room)), refusal);
const peek = await call("delete_map", { mapId: target, force: true, dryRun: true });
check("dryRun reports the plan without writing", peek.dryRun === true && existsSync(mapFile(target)), peek);
const removed = await call("delete_map", { mapId: target, force: true });
check("force deletes the file and clears the MapInfos slot", removed.removedFile === `Map${String(target).padStart(3, "0")}.json` && !existsSync(mapFile(target)), removed);
check("list_maps no longer shows it", !(await call("list_maps")).maps.some(map => map.id === target));
const again = await refuse("delete_map", { mapId: target });
check("asking twice says it is already gone rather than pretending", /not registered in MapInfos/.test(String(again)), again);
target = null;

// ---------------------------------------------------------------------------
// 6. Tear it all down
// ---------------------------------------------------------------------------

console.log("\n== teardown");
await teardown();
check("the room is gone with it", !existsSync(mapFile(room)));
room = null;

await client.close();
await server.close();
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
