/**
 * Play "Return the Lamp" from a cold boot to the credits, headless, driving it
 * with nothing but the keys a player has. Every beat asserts a piece of game
 * state, and every branch writes its own variable, so the run proves that the
 * choices, conditional branches, loops, battle branches and shop that the MCP
 * server wrote actually behave — not merely that they parse.
 *
 *   node scripts/play-lightrun.mjs
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT, describeProjectChoice, liveToken, projectDir } from "./local-env.mjs";
import { ensureBoots } from "./ensure-bootable.mjs";

const here = PACKAGE_ROOT;
const bridgePort = Number(process.env.RMMZ_PLAY_PORT ?? 3792);
const gamePort = Number(process.env.RMMZ_PLAY_GAME_PORT ?? 8092);
const shots = join(here, "samples", "lightrun", "play");
const token = liveToken();
process.env.RMMZ_PROJECT = projectDir;
process.env.RMMZ_LIVE_TOKEN = token;
process.env.RMMZ_LIVE_PORT = String(bridgePort);
console.log(describeProjectChoice());

// The page URL carries the bridge port now, so nothing here edits the project.
const pluginsSource = readFileSync(join(projectDir, "js", "plugins.js"), "utf8");
if (!pluginsSource.includes(`"token":"${token}"`)) {
    console.error(`the bridge plugin in ${projectDir}/js/plugins.js does not carry this token; live commands would be refused`);
    process.exit(1);
}
mkdirSync(shots, { recursive: true });

let failures = 0;
let shotsTaken = 0;
const trace = [];
const check = (name, condition, detail) => {
    if (condition) {
        console.log(`  PASS  ${name}`);
    } else {
        failures++;
        console.log(`  FAIL  ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail).slice(0, 400)}`}`);
    }
};
const note = message => {
    trace.push(message);
    console.log(`   · ${message}`);
};

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { server } = await import("../dist/index.js");
const client = new Client({ name: "lightrun-player", version: "1.0.0" });
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

// --- the probe: one expression that says everything about the current frame --

const SW = { intro: 20, woke: 21, quest: 22, lampLit: 23, bossDown: 24, ending: 25 };
const VR = { caps: 21, branch: 22, loop: 23 };
const ITEM = { oil: 2, matches: 3, cap: 4, key: 5, potion: 7 };

const PROBE = `(() => {
    const scene = SceneManager._scene;
    const items = {};
    for (const id of [${Object.values(ITEM).join(",")}]) {
        items[id] = $dataItems[id] ? $gameParty.numItems($dataItems[id]) : -1;
    }
    return {
        scene: scene ? scene.constructor.name : "none",
        map: $gameMap ? $gameMap.mapId() : 0,
        x: $gamePlayer.x, y: $gamePlayer.y, dir: $gamePlayer.direction(),
        moving: $gamePlayer.isMoving(), waiting: $gamePlayer._waitCount > 0,
        message: $gameMessage.hasText(), choice: $gameMessage.isChoice(), numbers: $gameMessage.isNumberInput(),
        gold: $gameParty.gold(), hp: $gameParty.members().map(actor => actor.hp + "/" + actor.mhp),
        switches: [${Object.values(SW).join(",")}].map(id => $gameSwitches.value(id)),
        variables: [${Object.values(VR).join(",")}].map(id => $gameVariables.value(id)),
        items,
        steps: $gameParty._steps,
        battle: $gameParty.inBattle() ? $gameTroop.members().map(enemy => enemy.name() + ":" + enemy.hp + "/" + enemy.mhp + (enemy.isDead() ? " dead" : "")) : null
    };
})()`;

const probe = async () => (await call("live_eval", { expression: PROBE })).value;
const label = state => `${state.scene} map${state.map} (${state.x},${state.y}) gold=${state.gold}`;

/** Read the dialog lines the game is showing right now. */
const messageText = async () =>
    (await call("live_eval", { expression: "$gameMessage.allText()" })).value;

// --- input primitives -------------------------------------------------------

const KEY = { 2: 40, 4: 37, 6: 39, 8: 38 };
const OK = 13;
const CANCEL = 27;

const press = async (keyCode, pulses = 1) => call("live_key", { keyCode, pulses });

/**
 * Press on until the game stops showing a dialog. This is `live_dialog` rather than a
 * loop of key presses: the server reads which window is actually up, and waits for the
 * one that can take a key, instead of mashing Ok at a fade.
 */
async function dismiss(limit = 12) {
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
        await sleep(70);
        const now = await probe();
        if (now.x !== before.x || now.y !== before.y) {
            if (!now.moving) {
                return now;
            }
            continue;
        }
        if (attempt > 6) {
            // The tap can land between two frames; press again rather than give up.
            await press(KEY[direction], 2);
        }
    }
    return probe();
}

/** Breadth-first walk to a cell, asked of the running engine, driven by keys. */
async function walkTo(x, y, { maxSteps = 60 } = {}) {
    let lastPosition = null;
    let stuckRounds = 0;
    for (let round = 0; round < maxSteps; round++) {
        await ensureMap();
        await dismiss();
        const plan = await call("live_eval", {
            expression: `(() => {
                const p = $gamePlayer;
                const target = [${x}, ${y}];
                const dirs = [[0, 1, 2], [0, -1, 8], [-1, 0, 4], [1, 0, 6]];
                const key = (cx, cy) => cx * 1000 + cy;
                const prev = new Map([[key(p.x, p.y), null]]);
                const queue = [[p.x, p.y]];
                while (queue.length) {
                    const [cx, cy] = queue.shift();
                    if (cx === target[0] && cy === target[1]) break;
                    for (const [dx, dy, d] of dirs) {
                        if (!p.canPass(cx, cy, d)) continue;
                        const nk = key(cx + dx, cy + dy);
                        if (prev.has(nk)) continue;
                        prev.set(nk, [cx, cy, d]);
                        queue.push([cx + dx, cy + dy]);
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
        });
        const value = plan.value;
        if (value?.error) {
            throw new Error(`walkTo(${x},${y}): ${value.error}`);
        }
        if (!value.path.length) {
            return probe();
        }
        for (const direction of value.path) {
            const before = await probe();
            const after = await advance(direction);
            if (after.scene === "Scene_Battle") {
                // A random encounter is not the end of the walk. Fight it off and let
                // the round loop re-plan from wherever the player ends up.
                note(`a random battle interrupted the walk to (${x},${y}) at (${after.x},${after.y})`);
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

/**
 * A walk that does not arrive is almost never the map's fault: the engine stopped
 * updating, an event owns the player, or a key is landing on something that is not
 * there. Say which, with whatever the running game logged, instead of spending ten
 * minutes repolling before giving up.
 */
async function stall(target, state) {
    const scene = await call("live_eval", {
        expression: `(() => { const s = SceneManager._scene; return {
            scene: s ? s.constructor.name : "none", stopped: SceneManager._stopped,
            frames: Graphics.frameCount, eventRunning: $gameMap.isEventRunning(),
            messageBusy: $gameMessage.isBusy(), inBattle: $gameParty.inBattle(),
            moving: $gamePlayer.isMoving(), waitCount: $gamePlayer._waitCount,
            fade: $gamePlayer._fadeType ?? null
        }; })()`
    });
    const diag = await call("live_diagnostics", { limit: 8, full: true }, 30000);
    const faults = (diag.entries ?? []).filter(entry => entry.kind !== "info");
    throw new Error(
        `walkTo(${target}) stalled at (${state.x},${state.y}) on map ${state.map}: ` +
            `${JSON.stringify(scene.value)} ` +
            (faults.length ? `| logged: ${faults.slice(0, 3).map(fault => `${fault.kind}: ${fault.message}`).join(" | ")}` : "| nothing logged")
    );
}

/**
 * Stand next to an event, face it, press the action button. Returns once the
 * game is showing something, which is what proves the event ran.
 */
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
        await sleep(180);
        // One press, not two: the second lands on whatever the first one opened, and
        // a choice window answers it with its default entry.
        await press(OK, 1);
        await sleep(300);
        const state = await probe();
        if (state.message || state.choice || state.battle || state.scene !== "Scene_Map") {
            return state;
        }
    }
    return probe();
}

/**
 * Answer an open choice window by index, through the server. `$gameMessage.isChoice()` is
 * true the moment a choice is queued — while `Window_ChoiceList` is still fading in — and
 * `Window_Selectable.isCursorMovable()` needs the window open *and active*, so a cursor key
 * sent on the strength of that flag is dropped and the first option is confirmed. Measured:
 * this harness picked option 1 when it meant option 2. `live_dialog` waits for the window,
 * presses one edge at a time and re-reads the cursor index after each, and refuses an option
 * the game has switched off instead of buzzing it and waiting.
 */
async function choose(index) {
    const answered = await call("live_dialog", { action: "answer", index }, 120000);
    if (answered.ok === false) {
        throw new Error(`choose(${index}) was refused: ${answered.refused}`);
    }
    note(`chose ${answered.chose.label} in ${answered.presses} press(es): ${answered.keys}`);
    return probe();
}

/**
 * Press Cancel until the game is back in the scene wanted. A player leaving a shop
 * does not count how many panels are stacked, and neither should this: the number
 * window, the goods list and the command window each eat one press, and one press
 * too many lands in the item screen rather than on the map.
 */
async function backToScene(name, limit = 10) {
    for (let attempt = 0; attempt < limit; attempt++) {
        const state = await probe();
        if (state.scene === name) {
            return true;
        }
        await press(CANCEL, 1);
        await sleep(250);
    }
    return false;
}

/**
 * Get back to walking. A random encounter can land in the middle of any route, and a
 * battle scene answers the same OK presses a dialog does, so every walk starts by
 * fighting its way out of whatever scene it is in. Battles are counted here as well,
 * because the encounter the player walked into is evidence whether or not the beat
 * that was looking for it was the one standing there when it rolled.
 */
const seen = { battles: 0 };

async function ensureMap(limit = 80) {
    for (let attempt = 0; attempt < limit; attempt++) {
        const state = await probe();
        if (state.scene === "Scene_Battle") {
            seen.battles++;
        }
        if (state.scene === "Scene_Map" && !state.message && !state.choice) {
            return state;
        }
        await press(OK, 1);
        await sleep(280);
    }
    return probe();
}

async function shot(name) {
    shotsTaken++;
    const file = join(shots, `${String(shotsTaken).padStart(2, "0")}-${name}.png`);
    await call("live_screenshot", { saveTo: file }, 30000);
    return file;
}

/** Wait for the scene to become something, then report what it is. */
async function waitScene(name, timeoutMs = 20000) {
    const result = await call("live_wait", { expression: `SceneManager._scene && SceneManager._scene.constructor.name === "${name}"`, timeoutMs, pollMs: 200 }, timeoutMs + 5000);
    return result.satisfied === true;
}

/**
 * Wait for the ending to be *underway* rather than probing once. Its first act is a picture
 * and a 30-frame wait, so a single probe right after the transfer can land in that gap and
 * report a game that has not begun its credits — which is a race in this script, not a
 * missing autorun.
 */
async function waitEnding(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const state = await probe();
        if (state.message === true || state.switches[5] === true || Date.now() > deadline) {
            return state;
        }
        await sleep(400);
    }
}

/** Fight with the attack command until the battle scene goes away. */
async function fight(limit = 200) {
    let rounds = 0;
    while (rounds < limit) {
        const state = await probe();
        if (!state.battle) {
            return { rounds, state };
        }
        await press(OK, 1);
        rounds++;
        await sleep(220);
    }
    return { rounds, state: await probe(), exhausted: true };
}

// --- the run ----------------------------------------------------------------

const main = async () => {
    await ensureBoots(call);
    const started = await call("live_session", { action: "start", gamePort, newGame: false, waitForBridgeMs: 120000 }, 180000);
    check("live_session start brings the bridge up", started.error === undefined, started);
    const booted = await call("live_session", { action: "boot", bootMs: 120000 }, 180000);
    let state = await probe();
    note(`booted into ${label(state)} (${JSON.stringify(booted).slice(0, 160)})`);
    const homeMap = state.map;
    check("a new game starts in the home", homeMap > 0 && state.scene === "Scene_Map", state);
    await shot("boot");

    // 1. The autorun intro, then the mirror that unlocks the door.
    check("the autorun intro is on screen", state.message === true, state);
    const introText = await messageText();
    check("the intro text arrived intact", /还灯/.test(introText), introText);
    await shot("intro");
    await dismiss();
    state = await probe();
    check("the intro ran but the door is still locked", state.switches[0] === true && state.switches[1] === false, state.switches);

    await talkTo(2, 2);
    await dismiss();
    state = await probe();
    check("the mirror sets the wake switch", state.switches[1] === true, state.switches);

    // 2. Choices, including the cancel branch.
    await talkTo(5, 6);
    const asked = await probe();
    check("the cat opens a choice window", asked.choice === true, asked);
    await shot("choices");
    await choose(1);
    state = await probe();
    check("choice 2 ran and only choice 2 ran", state.variables[1] === 11, { probe: state.variables, text: await messageText() });
    await dismiss();
    await talkTo(5, 6);
    await press(CANCEL, 2);
    await sleep(250);
    state = await probe();
    check("cancelling a choice takes the cancel branch", state.variables[1] === 13, state.variables);
    await dismiss();

    // 3. The locked chest: the conditional branch's false side.
    await talkTo(11, 2);
    await dismiss();
    state = await probe();
    check("the chest refuses without the order", state.items[ITEM.oil] === 0, state.items);

    // 4. The door. The page condition decides whether it moves the player.
    await walkTo(13, 5);
    await sleep(600);
    await dismiss();
    state = await probe();
    const villageMap = state.map;
    check("the door walks the player into the village", state.map !== homeMap && state.x === 2 && state.y === 10, state);
    await shot("village");

    // 5. The elder's quest, which unlocks the chest back home.
    await talkTo(12, 7);
    const elder = await probe();
    check("the elder asks with a choice", elder.choice === true, elder);
    await choose(0);
    await dismiss();
    state = await probe();
    check("accepting the quest sets the switch and pays", state.switches[2] === true && state.gold === 150, { switches: state.switches, gold: state.gold });

    // 6. The shop, driven through its own scene.
    await talkTo(17, 7);
    await dismiss();
    const shopOpen = await waitScene("Scene_Shop", 8000);
    check("the shop event opens Scene_Shop", shopOpen, await probe());
    if (shopOpen) {
        await shot("shop");
        const goldBefore = (await probe()).gold;
        await press(OK, 1); // Buy
        await sleep(300);
        await press(40, 1); // down to the potion
        await sleep(250);
        await press(OK, 1); // pick it
        await sleep(350);
        await press(OK, 1); // quantity 1
        await sleep(400);
        const bought = await probe();
        check("buying the potion takes money and gives the item", bought.gold === goldBefore - 100 && bought.items[ITEM.potion] === 1, {
            goldBefore,
            after: { gold: bought.gold, potion: bought.items[ITEM.potion] }
        });
        await press(CANCEL, 1);
        await sleep(250);
        const closed = await backToScene("Scene_Map", 8);
        check("the shop scene closes again", closed, await probe());
        await dismiss();
    }

    // 7. The loop the storyteller runs, counted by a variable.
    await talkTo(7, 12);
    await dismiss(20);
    state = await probe();
    check("the loop ran exactly three times and broke", state.variables[2] === 3, state.variables);

    // 8. Back home for the oil, now that the order exists.
    await walkTo(1, 10);
    await sleep(500);
    await dismiss();
    state = await probe();
    check("the return door leads home", state.x === 12 && state.y === 5, state);
    await talkTo(11, 2);
    await dismiss();
    state = await probe();
    check("the chest opens with the order", state.items[ITEM.oil] === 1, state.items);
    await walkTo(13, 5);
    await sleep(500);
    await dismiss();

    // 9. The cave gate tests an item page condition.
    state = await probe();
    check("back in the village with the oil", state.map === villageMap && state.items[ITEM.oil] === 1, state);
    await walkTo(25, 9);
    await sleep(600);
    await dismiss();
    state = await probe();
    check("the oil opens the cave", state.map !== villageMap && state.x === 1 && state.y === 9, state);
    const caveMap = state.map;
    await shot("cave");

    // 10. The encounter region: walking it has to start a battle at some point. The
    // roll is random, so the budget is the engine's own step counter rather than one
    // lap of the band, and a miss reports the counter instead of just "no battle".
    let metEncounter = false;
    for (const spot of [[4, 4], [10, 4], [16, 4], [10, 5], [4, 5], [16, 5], [10, 4], [4, 4]]) {
        await walkTo(spot[0], spot[1]);
        const during = await probe();
        if (during.battle) {
            metEncounter = true;
            note(`random encounter on the region: ${during.battle.join(", ")}`);
            await shot("encounter");
            const fought = await fight();
            check("the random battle ends in a win", !fought.exhausted && fought.state.battle === null, fought.state);
            await dismiss();
            check("the win branch of a random battle is not required", (await probe()).map === caveMap, await probe());
            break;
        }
    }
    check(
        "the painted region produced an encounter",
        metEncounter || seen.battles > 0,
        await call("live_eval", {
            expression: `({ steps: $gameParty._steps, count: $gamePlayer._encounterCount, region: $gameMap.regionId($gamePlayer.x, $gamePlayer.y), row: $dataMap.encounterList[0] })`
        })
    );

    // 11. The three glow caps, each a variable and an item.
    for (const spot of [[5, 5], [14, 2], [18, 12]]) {
        await talkTo(spot[0], spot[1]);
        await dismiss();
    }
    state = await probe();
    check("all three caps collected into the variable and the bag", state.variables[0] === 3 && state.items[ITEM.cap] === 3, { caps: state.variables[0], items: state.items });

    // 12. The guardian: a placed battle with three result branches. It stands at
    // (18,15) with "same as tiles" priority, so the player walks up to it and then
    // bumps into it, which is what a Player-Touch/Event-Touch event answers to.
    await walkTo(17, 15);
    await sleep(300);
    let guardian = await probe();
    for (let attempt = 0; attempt < 4 && !guardian.battle; attempt++) {
        await press(KEY[6], 2);
        await sleep(500);
        guardian = await probe();
    }
    // The battle is the point, not who was watching when it rolled: a walk that
    // stepped onto the guardian and fought its way out through ensureMap has already
    // proven the same thing, and leaves the win branch's switch set behind.
    check("touching the guardian starts the placed battle", guardian.battle !== null || guardian.switches[4] === true, guardian);
    await shot("boss");
    const fought = await fight();
    check("the guardian battle finishes", !fought.exhausted && fought.state.battle === null, fought.state);
    await dismiss();
    state = await probe();
    check("only the win branch ran", state.variables[1] === 1, { branch: state.variables[1], switches: state.switches });
    check("the guardian dropped the key", state.items[ITEM.key] === 1, state.items);

    // 13. The lamp without matches, before the matches exist.
    await walkTo(6, 1);
    await sleep(600);
    await dismiss();
    state = await probe();
    check("the north door opens for the guardian's winner", state.map !== caveMap, state);
    const towerMap = state.map;
    await walkTo(3, 16);
    await sleep(500);
    await dismiss();
    await walkTo(3, 9);
    await sleep(500);
    await dismiss();
    state = await probe();
    check("the stairs walk the player up two floors", state.map === towerMap && state.y < 10, state);
    await talkTo(3, 1);
    await dismiss();
    state = await probe();
    check("the lamp refuses without a light", state.switches[3] === false, state.switches);

    // 14. Down, back for the matches, up again.
    await walkTo(8, 5);
    await sleep(500);
    await dismiss();
    await walkTo(8, 13);
    await sleep(500);
    await dismiss();
    await walkTo(1, 17);
    await sleep(700);
    await dismiss();
    state = await probe();
    check("the tower door returns to the village", state.map !== towerMap, state);
    await walkTo(25, 9);
    await sleep(600);
    await dismiss();
    state = await probe();
    check("and the cave again", state.map === caveMap, state);
    await talkTo(3, 14);
    await dismiss();
    state = await probe();
    check("the matches chest opens once the guardian is down", state.items[ITEM.matches] === 1, state.items);

    await walkTo(6, 1);
    await sleep(600);
    await dismiss();
    await walkTo(3, 16);
    await sleep(500);
    await dismiss();
    await walkTo(3, 9);
    await sleep(500);
    await dismiss();
    await talkTo(3, 1);
    const lampText = await messageText();
    await dismiss();
    state = await probe();
    check("oil plus matches lights the lamp", state.switches[3] === true, { switches: state.switches, text: lampText });
    check("the lamp consumes both items", state.items[ITEM.oil] === 0 && state.items[ITEM.matches] === 0, state.items);
    await sleep(1200);
    await dismiss();
    state = await probe();
    check("the lit lamp sends the player back to the village", state.map !== towerMap, state);

    // 15. The ending: a picture, scrolling credits, and a switch.
    await waitScene("Scene_Map", 15000);
    const ending = await waitEnding();
    check("the autorun ending fires on the village", ending.message === true || ending.switches[5] === true, ending);
    await shot("ending");
    for (let i = 0; i < 14 && !(await probe()).switches[5]; i++) {
        await press(OK, 1);
        await sleep(300);
    }
    state = await probe();
    check("the credits ran to the end", state.switches[5] === true, state);
    const pictures = await call("live_eval", { expression: "$gameScreen._pictures.filter(picture => picture && picture._name).length" });
    check("the ending picture was shown and erased", pictures.value === 0, pictures.value);
    await dismiss();
    await shot("final");

    // 16. Hot reload on a finished game: paint the cell under the player, reload,
    // and ask the running map what it now holds.
    const cellHere = await call("inspect_cell", { mapId: state.map, x: state.x, y: state.y });
    const original = cellHere.layers[0].tileId;
    const paintedId = original === 214 ? 215 : 214;
    const flat = `(0 * $dataMap.height + ${state.y}) * $dataMap.width + ${state.x}`;
    const apply = async tileId =>
        call("batch", { steps: [{ tool: "set_tiles", args: { mapId: state.map, cells: [{ x: state.x, y: state.y, layer: 0, tileId }] } }, { tool: "live_reload", args: {} }] }, 120000);
    const first = await apply(paintedId);
    check("batch paints and reloads as one transaction", first.ok === true, first.failures ?? first);
    const reloadCheck = await call("live_wait", { expression: `$dataMap.data[${flat}] === ${paintedId}`, timeoutMs: 8000, pollMs: 250 }, 20000);
    check("the reloaded map carries the new tile", reloadCheck.satisfied === true, { expected: paintedId, reloadCheck });
    await apply(original);
    const restored = await call("live_wait", { expression: `$dataMap.data[${flat}] === ${original}`, timeoutMs: 8000, pollMs: 250 }, 20000);
    check("and carries it back again", restored.satisfied === true, restored);

    const diagnostics = await call("live_diagnostics", { limit: 40, full: true }, 30000);
    const faults = (diagnostics.entries ?? []).filter(entry => entry.kind !== "info");
    check("the whole run logged no fault", faults.length === 0, faults.slice(0, 5));
    if (faults.length) {
        for (const fault of faults.slice(0, 6)) {
            console.log(`        ${fault.kind}: ${fault.message}${fault.stack ? `\n            ${String(fault.stack).split("\n").slice(0, 3).join("\n            ")}` : ""}`);
        }
    }
    const final = await probe();
    note(`finished at ${label(final)} hp=${final.hp.join(" ")} gold=${final.gold} caps=${final.variables[0]}`);
    check("the party is alive at the end", final.hp.every(entry => Number(entry.split("/")[0]) > 0), final.hp);

    const stopped = await call("live_session", { action: "stop" }, 60000);
    check("the session stops cleanly", stopped.stopped !== undefined && stopped.wentQuiet === true, stopped);
};

main()
    .then(async () => {
        console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURES`} — ${shotsTaken} frames captured in ${shots}`);
        process.exitCode = failures === 0 ? 0 : 1;
    })
    .catch(error => {
        failures++;
        console.error(`RUN ABORTED: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    })
    .finally(async () => {
        try {
            const stopped = await call("live_session", { action: "status" });
            if (stopped.running) {
                await call("live_session", { action: "stop" }, 60000);
                console.log("stopped the playtest browser on the way out");
            }
        } catch {
            // the browser is already gone
        }
        // The browser child and the two loopback servers keep the event loop alive
        // long after the run is reported, which would hang a caller waiting on exit.
        process.exit(failures === 0 ? 0 : 1);
    });
