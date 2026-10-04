/**
 * Play "Star Relay" from a cold boot to the title screen, headless, driven with
 * nothing but the keys a player has — the run that proves the high-level layer built
 * a game rather than a pile of files.
 *
 *   node scripts/verify-star-relay.mjs
 *
 * Every beat asserts engine state, not file state: the door the player walks through
 * is checked by where they come out, the shop by the gold that left the party, the
 * encounter zone by a battle actually arriving. `build-star-relay.mjs` must have run
 * first. Own ports (3794 bridge / 8094 game) so it never collides with the registered
 * server, `session:e2e`, `e2e:live` or the lightrun playtest.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT, describeProjectChoice, liveToken, projectDir } from "./local-env.mjs";
import { ensureBoots } from "./ensure-bootable.mjs";

const here = PACKAGE_ROOT;
const bridgePort = Number(process.env.RMMZ_SR_PLAY_PORT ?? 3794);
const gamePort = Number(process.env.RMMZ_SR_GAME_PORT ?? 8094);
const shots = process.env.RMMZ_SR_SHOTS ? join(process.env.RMMZ_SR_SHOTS, "play") : join(here, "samples", "star-relay", "play");
const token = liveToken();
process.env.RMMZ_PROJECT = projectDir;
process.env.RMMZ_LIVE_TOKEN = token;
process.env.RMMZ_LIVE_PORT = String(bridgePort);
console.log(describeProjectChoice());

const pluginsSource = readFileSync(join(projectDir, "js", "plugins.js"), "utf8");
if (!pluginsSource.includes(`"token":"${token}"`)) {
    console.error(`the bridge plugin in ${projectDir}/js/plugins.js does not carry this token; live commands would be refused`);
    process.exit(1);
}
mkdirSync(shots, { recursive: true });

// ---------------------------------------------------------------------------
// Reporting: per-beat timings, because "it passed" without a duration is how a
// suite hides that one step has been waiting out a 90 second timeout for a month.
// ---------------------------------------------------------------------------

let failures = 0;
let shotsTaken = 0;
let fatal = false;
const beats = [];
/** One named stretch of the run, timed. After a beat that makes the rest impossible —
 *  a boot that never happened — the others are skipped rather than walked blind, because
 *  a suite that spends ten more minutes probing a title screen reports a lie either way. */
async function beat(what, run) {
    if (fatal) {
        console.log(`\n== ${what}\n  SKIP  the run was already lost`);
        return;
    }
    const started = Date.now();
    console.log(`\n== ${what}`);
    try {
        await run();
    } catch (error) {
        failures++;
        console.log(`  FAIL  ${what} threw: ${error instanceof Error ? error.message : String(error)}`);
        const diag = await call("live_diagnostics", { limit: 8, full: true }, 30000).catch(() => null);
        for (const entry of (diag?.entries ?? []).filter(item => item.kind !== "info").slice(0, 4)) {
            console.log(`        ${entry.kind}: ${entry.message}`);
        }
        beats.push({ what, ms: Date.now() - started, threw: true });
        return;
    }
    beats.push({ what, ms: Date.now() - started });
}

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { server } = await import("../dist/index.js");
const client = new Client({ name: "star-relay-player", version: "1.0.0" });
const pair = InMemoryTransport.createLinkedPair();
await server.connect(pair[1]);
await client.connect(pair[0]);

async function call(name, args = {}, timeoutMs) {
    const result = await client.callTool({ name, arguments: args }, undefined, timeoutMs ? { timeout: timeoutMs } : undefined);
    const text = result.content?.find(part => part.type === "text")?.text ?? "";
    let value = text;
    try {
        value = JSON.parse(text);
    } catch {
        // plain text answer
    }
    if (result.isError) {
        throw new Error(`${name} failed: ${text.slice(0, 300)}`);
    }
    return value;
}

const sleep = ms => new Promise(done => setTimeout(done, ms));

const check = (name, condition, detail) => {
    if (condition) {
        console.log(`  PASS  ${name}`);
    } else {
        failures++;
        console.log(`  FAIL  ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail).slice(0, 400)}`}`);
    }
};
const note = message => console.log(`   · ${message}`);

// ---------------------------------------------------------------------------
// What the running game is asked, in one expression, about the current frame
// ---------------------------------------------------------------------------

const SW = { met: 27, quest: 28, shrine: 29, boss: 30, ending: 31 };
const VR = { branch: 25, bats: 26, core: 27 };

const itemRow = async name => ((await call("read_database", { table: "Items" })).entries ?? []).find(row => row.name === name)?.id;
const LANTERN = await itemRow("Star Lantern");
const GUARDIAN = "SR Relay Warden";
const guardianRow = ((await call("read_database", { table: "Enemies" })).entries ?? []).find(row => row.name === GUARDIAN)?.id;
const FUSE = await itemRow("Relay Fuse");
const ITEMS = [LANTERN, FUSE, 7].filter(id => id > 0);

const PROBE = `(() => {
    const scene = SceneManager._scene;
    const items = {};
    for (const id of [${ITEMS.join(",")}]) {
        items[id] = $dataItems[id] ? $gameParty.numItems($dataItems[id]) : -1;
    }
    return {
        scene: scene ? scene.constructor.name : "none",
        map: $gameMap ? $gameMap.mapId() : 0,
        x: $gamePlayer.x, y: $gamePlayer.y, dir: $gamePlayer.direction(),
        moving: $gamePlayer.isMoving(), waiting: $gamePlayer._waitCount > 0,
        message: $gameMessage.hasText(), choice: $gameMessage.isChoice(), numbers: $gameMessage.isNumberInput(),
        gold: $gameParty.gold(), hp: $gameParty.members().map(actor => actor.hp + "/" + actor.mhp),
        reward: $gameParty.inBattle() ? $gameTroop.members().reduce((r, e) => r + e.gold(), 0) : 0,
        switches: [${Object.values(SW).join(",")}].map(id => $gameSwitches.value(id)),
        variables: [${Object.values(VR).join(",")}].map(id => $gameVariables.value(id)),
        items,
        steps: $gameParty._steps,
        battle: $gameParty.inBattle() ? $gameTroop.members().map(enemy => enemy.name() + ":" + enemy.hp + "/" + enemy.mhp) : null
    };
})()`;

const probe = async () => (await call("live_eval", { expression: PROBE })).value;
const label = state => `${state.scene} map${state.map} (${state.x},${state.y}) gold=${state.gold}`;
const messageText = async () => (await call("live_eval", { expression: "$gameMessage.allText()" })).value;
const sw = (state, key) => state.switches[Object.keys(SW).indexOf(key)] === true;
const vr = (state, key) => state.variables[Object.keys(VR).indexOf(key)];
const count = (state, id) => state.items[id] ?? 0;

// ---------------------------------------------------------------------------
// Input primitives
// ---------------------------------------------------------------------------

const KEY = { 2: 40, 4: 37, 6: 39, 8: 38 };
const OK = 13;
const CANCEL = 27;

const press = async (keyCode, pulses = 1) => call("live_key", { keyCode, pulses });

/** Press OK until the game stops showing a dialog, so no beat waits on a window. */
/**
 * Press on until nothing is waiting. The server's own dialog tool does the reading, so a
 * window that is still fading in is waited for instead of mashed at.
 */
async function dismiss(limit = 14) {
    const quiet = await call("live_dialog", { action: "dismiss", limit }, 120000);
    if (quiet.warning) {
        note(`dismiss: ${quiet.warning}`);
    }
    return quiet.presses;
}

/** Walk one tile in a direction and wait for the player to settle. */
async function advance(direction) {
    const before = await probe();
    await press(KEY[direction], 1);
    for (let attempt = 0; attempt < 25; attempt++) {
        await sleep(80);
        const now = await probe();
        if (now.x !== before.x || now.y !== before.y) {
            if (!now.moving) {
                return now;
            }
            continue;
        }
        if (attempt > 6) {
            await press(KEY[direction], 2);
        }
    }
    return probe();
}

/** A walk that did not arrive: say what stopped it instead of timing out quietly. */
async function stall(target, state) {
    const scene = await call("live_eval", {
        expression: `(() => { const s = SceneManager._scene; return {
            scene: s ? s.constructor.name : "none", stopped: SceneManager._stopped,
            frames: Graphics.frameCount, eventRunning: $gameMap.isEventRunning(),
            messageBusy: $gameMessage.isBusy(), inBattle: $gameParty.inBattle(),
            moving: $gamePlayer.isMoving(), waitCount: $gamePlayer._waitCount
        }; })()`
    });
    const diag = await call("live_diagnostics", { limit: 8, full: true }, 30000);
    const faults = (diag.entries ?? []).filter(entry => entry.kind !== "info");
    throw new Error(
        `walkTo(${target}) stalled at (${state.x},${state.y}) on map ${state.map}: ${JSON.stringify(scene.value)} ` +
            (faults.length ? `| logged: ${faults.slice(0, 3).map(f => `${f.kind}: ${f.message}`).join(" | ")}` : "| nothing logged")
    );
}

/** Breadth-first walk to a cell, planned by the running engine, driven by keys. */
async function walkTo(x, y, { maxSteps = 60 } = {}) {
    let lastPosition = null;
    let stuckRounds = 0;
    for (let round = 0; round < maxSteps; round++) {
        if (round % 10 === 9) {
            const where = await probe();
            note(`still walking to (${x},${y}) after ${round + 1} rounds`, { scene: where.scene, at: `${where.x},${where.y}`, map: where.map });
        }
        // Only the first round clears what an earlier beat left open. A door's own line
        // arrives in the middle of a walk, and dismissing every round would click straight
        // through the evidence the beat is standing there to collect.
        if (round === 0) {
            await ensureMap();
            await dismiss();
        }
        const plan = (
            await call("live_eval", {
                expression: `(() => {
                    const p = $gamePlayer;
                    const target = [${x}, ${y}];
                    const dirs = [[0, 1, 2], [0, -1, 8], [-1, 0, 4], [1, 0, 6]];
                    const key = (cx, cy) => cx * 1000 + cy;
                    // A player-touch event is not a tile you walk across: stepping on the
                    // door you arrived at takes the map away from under you. Routes go around
                    // them, and the beats that want a door step onto it deliberately.
                    const touch = (cx, cy) => $gameMap.eventsXy(cx, cy).some(ev => ev.isTriggerIn([1]));
                    const prev = new Map([[key(p.x, p.y), null]]);
                    const queue = [[p.x, p.y]];
                    while (queue.length) {
                        const [cx, cy] = queue.shift();
                        if (cx === target[0] && cy === target[1]) break;
                        for (const [dx, dy, d] of dirs) {
                            if (!p.canPass(cx, cy, d)) continue;
                            const nx = cx + dx, ny = cy + dy;
                            if (touch(nx, ny) && !(nx === target[0] && ny === target[1])) continue;
                            const nk = key(nx, ny);
                            if (prev.has(nk)) continue;
                            prev.set(nk, [cx, cy, d]);
                            queue.push([nx, ny]);
                        }
                    }
                    const end = key(target[0], target[1]);
                    if (!prev.has(end)) {
                        return { error: "no walkable path from " + p.x + "," + p.y + " to " + target.join(",") + " on map " + $gameMap.mapId() };
                    }
                    const path = [];
                    let cursor = end;
                    while (prev.get(cursor)) {
                        const [px, py, d] = prev.get(cursor);
                        path.unshift(d);
                        cursor = key(px, py);
                    }
                    return { path, from: [p.x, p.y] };
                })()`
            })
        ).value;
        if (plan?.error) {
            // The file layer says this map is open, so "no path" is about the player's
            // state or an event standing in a doorway, not about tiles. Ask the engine
            // which of the four ways it refuses and why, and put that in the error.
            const why = (await call("live_eval", {
                expression: `(() => { const p = $gamePlayer; const ways = {};
                    for (const d of [2, 4, 6, 8]) {
                        const x2 = $gameMap.roundXWithDirection(p.x, d), y2 = $gameMap.roundYWithDirection(p.y, d);
                        ways["d" + d] = {
                            canPass: p.canPass(p.x, p.y, d),
                            mapPassable: p.isMapPassable(p.x, p.y, d),
                            collidedEvent: p.isCollidedEvent(x2, y2),
                            region: $gameMap.regionId(x2, y2),
                            tile: $gameMap.tileId(x2, y2, 0)
                        };
                    }
                    return { at: [p.x, p.y], moving: p.isMoving(), through: p.isThrough(),
                        forcing: p.isMoveRouteForcing(), eventRunning: $gameMap.isEventRunning(), ways };
                })()`
            })).value;
            throw new Error(`walkTo(${x},${y}): ${plan.error} | engine says ${JSON.stringify(why)}`);
        }
        if (!plan.path.length) {
            return probe();
        }
        for (const direction of plan.path) {
            const before = await probe();
            const after = await advance(direction);
            if (after.scene === "Scene_Battle") {
                note(`a random battle interrupted the walk to (${x},${y}) at (${after.x},${after.y})`);
                // Play it out. `ensureMap` presses OK up to 25 times, which is enough for a
                // short fight and not for a long one, and a walk that resumes while the
                // battle is still on screen spends its whole retry budget on a player who
                // cannot move.
                seen.battles++;
                const outcome = await fight();
                note(`that battle took ${outcome.rounds} presses to get out of`, { scene: outcome.state.scene, hp: outcome.state.hp });
                await ensureMap();
                break;
            }
            if (after.map !== before.map || after.scene !== before.scene) {
                note(`walk interrupted by ${after.scene} map${after.map} at (${after.x},${after.y})`);
                return after;
            }
            if (after.message || after.choice) {
                break;
            }
        }
        const here2 = await probe();
        const spot = `${here2.x},${here2.y}`;
        stuckRounds = spot === lastPosition ? stuckRounds + 1 : 0;
        lastPosition = spot;
        if (stuckRounds >= 3) {
            await stall(`${x},${y}`, here2);
        }
    }
    const state = await probe();
    if (state.x !== x || state.y !== y) {
        await stall(`${x},${y}`, state);
    }
    return state;
}

/** Stand next to an event, face it, press the action button. */
async function talkTo(x, y) {
    const faces = [
        { spot: [x, y + 1], face: 8 },
        { spot: [x, y - 1], face: 2 },
        { spot: [x + 1, y], face: 4 },
        { spot: [x - 1, y], face: 6 }
    ];
    for (const attempt of faces) {
        await ensureMap();
        try {
            await walkTo(attempt.spot[0], attempt.spot[1], { maxSteps: 30 });
        } catch {
            continue;
        }
        await press(KEY[attempt.face], 1);
        await sleep(200);
        await press(OK, 1);
        await sleep(320);
        const state = await probe();
        if (state.message || state.choice || state.battle || state.scene !== "Scene_Map") {
            return state;
        }
    }
    return probe();
}

/**
 * Talk to an event by name rather than by cell, because this game's keeper walks a
 * patrol route: the coordinates the build gave him are where he *started*, and a driver
 * that walks to them arrives a tile away from the person it came to speak to.
 */
async function talkToEvent(name) {
    for (let attempt = 0; attempt < 5; attempt++) {
        const cell = (await call("live_eval", { expression: `(() => { const e = $gameMap.events().find(ev => ev.event().name === ${JSON.stringify(name)}); return e ? [e.x, e.y] : null; })()` })).value;
        if (!cell) {
            throw new Error(`no event named "${name}" on map ${(await probe()).map}`);
        }
        const state = await talkTo(cell[0], cell[1]);
        if (state.message || state.choice || state.scene !== "Scene_Map") {
            return state;
        }
        await sleep(400);
    }
    return probe();
}

/** Answer an open choice window by index. */
/**
 * Answer a choice by index through `live_dialog`. The old hand-rolled version pressed Down
 * on the strength of `$gameMessage.isChoice()`, which is true while the list is still
 * fading in, and `Window_Selectable.isCursorMovable()` drops a cursor key sent before the
 * window is open and active — the answer then came out as the first option. The tool waits,
 * presses one edge at a time and re-reads the cursor index after every press.
 */
async function choose(index) {
    const answered = await call("live_dialog", { action: "answer", index }, 120000);
    if (answered.ok === false) {
        throw new Error(`choose(${index}) was refused: ${answered.refused}`);
    }
    if (!answered.settled) {
        note(`choose(${index}): the window was still up after ${answered.presses} press(es) — ${JSON.stringify(answered.now).slice(0, 160)}`);
    } else {
        note(`chose ${answered.chose.label} in ${answered.presses} press(es)`);
    }
    return probe();
}

/** Press Cancel until the game is back in the scene wanted. */
async function backToScene(name, limit = 10) {
    for (let attempt = 0; attempt < limit; attempt++) {
        const state = await probe();
        if (state.scene === name) {
            return true;
        }
        await press(CANCEL, 1);
        await sleep(260);
    }
    return false;
}

/** Get back to walking, counting any battle that landed in the middle of a route. */
const seen = { battles: 0 };
async function ensureMap(limit = 25) {
    for (let attempt = 0; attempt < limit; attempt++) {
        const state = await probe();
        if (state.scene === "Scene_Battle") {
            seen.battles++;
        }
        if (state.scene === "Scene_Map" && !state.message && !state.choice) {
            return state;
        }
        await press(OK, 1);
        await sleep(300);
    }
    return probe();
}

/** Fight with the attack command until the battle scene goes away. */
async function fight(limit = 240) {
    let rounds = 0;
    while (rounds < limit) {
        const state = await probe();
        if (!state.battle) {
            return { rounds, state };
        }
        await press(OK, 1);
        rounds++;
        await sleep(230);
    }
    return { rounds, state: await probe(), exhausted: true };
}

async function shot(name) {
    shotsTaken++;
    const file = join(shots, `${String(shotsTaken).padStart(2, "0")}-${name}.png`);
    await call("live_screenshot", { saveTo: file }, 30000);
    return file;
}

async function waitScene(name, timeoutMs = 30000) {
    const result = await call("live_wait", { expression: `SceneManager._scene && SceneManager._scene.constructor.name === "${name}"`, timeoutMs, pollMs: 200 }, timeoutMs + 5000);
    return result.satisfied === true;
}

/** Wait for the map to be quiet. A running event is what `Game_Player.canMove()` reads,
 *  so a walk started while an autorun still holds the map simply never happens, and a
 *  suite that does not wait for this reports the map as broken instead. */
async function settle(timeoutMs = 25000) {
    const result = await call("live_wait", { expression: "$gameMap.isEventRunning() === false && $gameMessage.isBusy() === false", timeoutMs, pollMs: 150 }, timeoutMs + 5000);
    return result.satisfied === true;
}

async function waitFor(expression, timeoutMs = 15000) {
    const result = await call("live_wait", { expression, timeoutMs, pollMs: 150 }, timeoutMs + 5000);
    return result.satisfied === true;
}

/** A linear playthrough says which map it expects to be standing on. Without this, one
 *  lost player turns into a hundred failures as the driver walks around the wrong map
 *  pressing the action button at nothing. */
async function onMap(mapId) {
    const state = await probe();
    if (state.map !== mapId) {
        fatal = true;
        throw new Error(`the player is on map ${state.map} at (${state.x},${state.y}), not map ${mapId} — the run lost them before this beat`);
    }
    return state;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const main = async () => {
    let ids = {};
    await beat("validate_game is clean before anything boots", async () => {
        const maps = (await call("list_maps")).maps;
        ids = {
            home: maps.find(map => map.name === "SR Keeper's House")?.id,
            village: maps.find(map => map.name === "SR Village")?.id,
            cave: maps.find(map => map.name === "SR Relay Cave")?.id
        };
        check("all three maps of the game are in the project", ids.home && ids.village && ids.cave, ids);
        const report = await call("validate_game", { mapIds: [ids.home, ids.village, ids.cave] });
        const errors = (report.problems ?? []).filter(problem => problem.severity === "error");
        check(`validate_game reports 0 errors over ${report.checked?.events ?? "?"} events`, report.ok === true && errors.length === 0, errors.slice(0, 4));
        check("the lantern the whole game turns on is a real row", LANTERN > 0, { LANTERN });
        check("and so is the guardian the altar fights", guardianRow > 0, { name: GUARDIAN, guardianRow });
    });

    await beat("cold boot into a new game", async () => {
        await ensureBoots(call);
        const started = await call("live_session", { action: "start", gamePort, newGame: false, waitForBridgeMs: 150000 }, 200000);
        check("live_session brings the bridge up", started.bridgeConnected === true, started.session ?? started);
        // bootMs is capped at 120 s by the tool's own schema; a cold boot plus the title
        // walk has been measured under it, so ask for the maximum rather than more.
        const booted = await call("live_session", { action: "boot", bootMs: 120000 }, 200000);
        const state = await probe();
        note(`booted into ${label(state)} (${JSON.stringify(booted.boot ?? booted).slice(0, 160)})`);
        check("the new game starts in the keeper's house", state.map === ids.home && state.x === 3 && state.y === 5, state);
        if (state.scene !== "Scene_Map") {
            fatal = true;
            throw new Error(`never reached a map (scene ${state.scene}) — the rest of the run has nothing to walk on`);
        }
        await shot("boot");
    });

    await beat("the opening autorun fires once and then lets go of the map", async () => {
        const state = await probe();
        check("the intro is on screen", state.message === true, state);
        const text = await messageText();
        check("the intro text arrived intact", /星之 relay/.test(text), text);
        await dismiss();
        const settled = await probe();
        check("it set the switch its second page waits on", sw(settled, "met"), settled.switches);
        // The page ends with a self switch and an Erase Event, and this is where that
        // shows: a still-running autorun keeps `Game_Map.isEventRunning()` true, which is
        // what `Game_Player.canMove()` refuses to walk through.
        check("and the map is quiet again", await settle(), await probe());
        const moved = await advance(6);
        check("the player can walk", moved.x === 4 && moved.y === 5, moved);
    });

    await beat("the door refuses the player until the keeper gives the order", async () => {
        await walkTo(12, 5);
        // One deliberate step onto the threshold, not a walkTo: the door's own line is the
        // evidence, and a path that ends inside a player-touch event clicks through it.
        const stepped = await advance(6);
        check("walking onto an unmet door does not move the player", stepped.map === ids.home && stepped.x === 13 && stepped.y === 5, stepped);
        check("and it says why", await waitFor("$gameMessage.hasText()", 8000), await probe());
        const text = await messageText();
        check("the locked line is the one the build wrote", /门从里面闩着/.test(text), text);
        await dismiss();
    });

    await beat("talking to the keeper advances his pages", async () => {
        // He walks a patrol route, so he is found by name at his current cell.
        await talkToEvent("Maren the Keeper");
        const text = await messageText();
        check("Maren speaks", /传灯链/.test(text), text);
        await dismiss();
        let state = await probe();
        check("and the quest switch is now set", sw(state, "quest"), state.switches);
        await talkToEvent("Maren the Keeper");
        const second = await messageText();
        check("the follow page replaced the first", /星灯在村东/.test(second), { second, state: await probe() });
        await dismiss();
        await shot("keeper");
    });

    await beat("the chest gives its loot and becomes the opened graphic", async () => {
        const before = await probe();
        await talkTo(10, 2);
        await dismiss();
        const after = await probe();
        check("gold arrived", after.gold === before.gold + 90, { before: before.gold, after: after.gold });
        check("and two of the potion", count(after, 7) === count(before, 7) + 2, { before: before.items, after: after.items });
        await talkTo(11, 2);
        await dismiss();
        const strong = await probe();
        check("the strongbox that waits on the quest opens now", strong.gold === after.gold + 200, { gold: strong.gold, expected: after.gold + 200 });
    });


    await beat("the door moves the player, and lands them beside the far door", async () => {
        await walkTo(12, 5);
        await advance(6);
        const arrived = await waitFor(`$gameMap.mapId() === ${ids.village}`, 25000);
        const state = await probe();
        check("the village now holds the player", arrived && state.map === ids.village, state);
        // link_maps put the arrival one cell above the doorway, facing away from it.
        check("and they came out beside the door, not on its threshold", state.x === 2 && state.y === 8, state);
        check("facing away from the way they came in", state.dir === 8, state);
        await settle();
        await shot("village");
    });

    await beat("the shop sells the lantern for what the build charged", async () => {
        await onMap(ids.village);
        const before = await probe();
        await talkTo(8, 10);
        // The keeper greets you in a Show Text, and MZ runs Shop Processing when that
        // message closes — so the greeting has to be clicked through before there is a
        // shop scene to wait for.
        await dismiss();
        const opened = await waitScene("Scene_Shop", 15000);
        check("the shop window opens", opened, await probe());
        // Buy → the first good (the lantern) → confirm one. The windows are opened by
        // the engine's own scene transitions, and headless runs at ~9 fps, so each press
        // gets a second to land rather than the 400 ms a 60 fps machine would need.
        await press(OK, 1);
        await sleep(900);
        await press(OK, 1);
        await sleep(900);
        await press(OK, 1);
        await sleep(900);
        const back = await backToScene("Scene_Map");
        check("and closes back onto the map", back, await probe());
        const after = await probe();
        check("the lantern is in the bag", count(after, LANTERN) === count(before, LANTERN) + 1, { before: before.items, after: after.items });
        check("the price came out of the purse", after.gold === before.gold - 80, { before: before.gold, after: after.gold });
        await shot("shop");
    });

    await beat("the offering chest only opens for a player carrying one", async () => {
        await onMap(ids.village);
        const before = await probe();
        await talkTo(20, 5);
        await dismiss();
        const after = await probe();
        check("holding the lantern unlocked it", after.gold === before.gold + 30 && count(after, FUSE) === count(before, FUSE) + 1, { before: before.items, after: after.items });
    });

    await beat("the cave mouth takes the player down", async () => {
        await walkTo(24, 8);
        await advance(2);
        const arrived = await waitFor(`$gameMap.mapId() === ${ids.cave}`, 25000);
        const state = await probe();
        check("the cave now holds the player", arrived && state.map === ids.cave, state);
        check("arrived beside the door they came through", state.x === 1 && state.y === 7 && state.dir === 8, state);
        check("the cave's own autorun greeted them", await waitFor("$gameMessage.hasText()", 10000), await probe());
        const text = await messageText();
        check("and said the line the build wrote", /洞窟里没有风/.test(text), text);
        await dismiss();
        const settled = await probe();
        check("it left its switch and variable behind", sw(settled, "shrine") && vr(settled, "core") === 0, { switches: settled.switches, variables: settled.variables });
        check("and it let go of the map, so the walk to the well is possible", await settle(), await probe());
        await shot("cave");
    });

    await beat("the region really rolls encounters", async () => {
        await onMap(ids.cave);
        const before = await probe();
        // The engine re-rolls the distance to the next encounter (`Game_Map.updateEncounterCount`
        // is `randomInt(n) + randomInt(n) + 1` over the map's encounter step), so asserting a
        // battle after one fixed route is a coin flip — and a coin flip in an acceptance suite is
        // just a false report scheduled for later. What is claimed here is a property: a region
        // the data lists really does roll. So walk it until one arrives, inside a budget only a
        // broken region can miss, and print how many passes it took.
        const ROUTE = [[9, 6], [14, 10], [7, 11]];
        const battlesBefore = seen.battles;
        const passes = [];
        while (passes.length < 4 && seen.battles === battlesBefore && (await probe()).scene !== "Scene_Battle") {
            const at = (await probe()).steps;
            for (const [x, y] of ROUTE) {
                await walkTo(x, y);
                if (seen.battles > battlesBefore || (await probe()).scene === "Scene_Battle") {
                    break;
                }
            }
            passes.push((await probe()).steps - at);
        }
        const fought = seen.battles > battlesBefore || (await probe()).scene === "Scene_Battle";
        note(`the region rolled a battle on pass ${passes.length}, after ${passes.join("+")} steps of the ${ROUTE.length}-stop route`);
        check("walking the painted region started a battle", fought, {
            battles: seen.battles - battlesBefore,
            passes,
            engine: (await call("live_eval", { expression: `({ steps: $gameParty._steps, encounterCount: $gamePlayer._encounterCount, region: $gameMap.regionId($gamePlayer.x, $gamePlayer.y), rows: $dataMap.encounterList.length })` })).value,
            state: await probe()
        });
        await ensureMap();
        const after = await probe();
        check("and the party walked out of it alive", after.scene === "Scene_Map" && Number(after.hp[0].split("/")[0]) > 0, after.hp);
        check("the steps counted between encounters moved", after.steps > before.steps, { before: before.steps, after: after.steps });
    });

    await beat("the altar's choice, its gate, and the battle its win branch runs", async () => {
        await onMap(ids.cave);
        await talkTo(18, 8);
        const asked = await probe();
        check("the well opens a choice window", asked.choice === true, asked);
        await shot("altar-choice");
        await choose(0);
        await dismiss();
        const fighting = await waitScene("Scene_Battle", 20000);
        check("the lantern branch started the guardian fight", fighting, await probe());
        const inBattle = await probe();
        check("and it is the troop this game named",
            (inBattle.battle ?? []).length === 1 && inBattle.battle[0].startsWith(`${GUARDIAN}:`), inBattle.battle);
        const result = await fight();
        check(`the party won it in ${result.rounds} key presses`, !result.exhausted && result.state.scene !== "Scene_Battle", result.state);
        // The win branch speaks before it moves anyone, and a Show Text holds the interpreter:
        // the Transfer Player is only reserved once that line is dismissed. Then arrive, and
        // read the state before the village's own credits autorun starts clearing switches.
        await dismiss();
        const arrived = await waitFor(`$gameMap.mapId() === ${ids.village}`, 30000);
        const after = await probe();
        check("the win branch set both ending switches", sw(after, "boss") && sw(after, "ending"), after.switches);
        const promised = 150;
        const gained = after.gold - inBattle.gold;
        check(
            `paid the ${promised} it promised on top of the ${inBattle.reward} the troop drops`,
            gained === promised + inBattle.reward,
            { before: inBattle.gold, after: after.gold, gained, fromWinBranch: promised, fromVictory: inBattle.reward }
        );
        check("and wrote the branch variable, so the route taken is on record", vr(after, "branch") === 1, after.variables);
        check("the win branch moved the player back to the village", arrived && after.map === ids.village && after.x === 15 && after.y === 9, after);
        if (after.scene === "Scene_Map") {
            await shot("back-in-village");
        }
    });

    await beat("the credits autorun ends the game on the title screen", async () => {
        // The region can still roll a battle on the way back from the altar, and a battle
        // holds the scene until somebody fights it — the ending's autorun waits for the map.
        for (let attempt = 0; attempt < 4; attempt++) {
            const state = await probe();
            if (state.scene !== "Scene_Battle") {
                break;
            }
            note("the ending waited out a battle the region rolled", { hp: state.hp, battle: state.battle });
            await fight();
            await ensureMap();
        }
        const toTitle = await waitScene("Scene_Title", 60000);
        check("the ending autorun ran the game out to the title", toTitle, await probe());
        const state = await probe();
        check("the ending switch stayed set behind it", sw(state, "ending"), state.switches);
    });

    await beat("nothing was logged wrong along the way", async () => {
        const diagnostics = await call("live_diagnostics", { limit: 40, full: true }, 30000);
        const faults = (diagnostics.entries ?? []).filter(entry => entry.kind !== "info");
        check("the whole run logged no fault", faults.length === 0, faults.slice(0, 5));
        for (const fault of faults.slice(0, 6)) {
            console.log(`        ${fault.kind}: ${fault.message}`);
        }
    });
};

const startedAt = Date.now();
main()
    .then(() => {
        console.log(`\n== beats`);
        for (const entry of beats) {
            console.log(`   ${(entry.ms / 1000).toFixed(1).padStart(6)}s  ${entry.what}${entry.threw ? "  (threw)" : ""}`);
        }
        console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURES`} — ${(seen.battles)} battle(s) seen, ${shotsTaken} frames captured in ${shots}, ${((Date.now() - startedAt) / 1000).toFixed(0)}s total`);
        process.exitCode = failures === 0 ? 0 : 1;
    })
    .catch(error => {
        failures++;
        console.error(`RUN ABORTED: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    })
    .finally(async () => {
        try {
            const status = await call("live_session", { action: "status" });
            if (status.session?.running) {
                await call("live_session", { action: "stop" }, 60000);
                console.log("stopped the playtest browser on the way out");
            }
        } catch {
            // the browser is already gone
        }
        process.exit(failures === 0 ? 0 : 1);
    });
