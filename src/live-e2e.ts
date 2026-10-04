import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const TOKEN = "e2e-token";
// Its own port: 3789 is the registered server and 3791 is session-tool's, and a suite
// that shares either one reads somebody else's game as its own.
const PORT = Number(process.env["RMMZ_LIVE_PORT"] || 3793);
process.env["RMMZ_LIVE_TOKEN"] = TOKEN;
process.env["RMMZ_LIVE_PORT"] = String(PORT);

const { server } = await import("./index.js");
const { liveBridge } = await import("./bridge/liveServer.js");
const client = new Client({ name: "live-e2e", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

let failures = 0;
function check(name: string, condition: unknown, detail?: unknown): void {
    if (condition) {
        console.log(`  PASS  ${name}`);
    } else {
        failures++;
        console.log(`  FAIL  ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail).slice(0, 300)}`}`);
    }
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) {
        return { toolError: (result.content as any[])[0]?.text };
    }
    return JSON.parse((result.content as any[])[0].text);
}

const ms = async (fn: () => Promise<unknown>): Promise<number> => {
    const began = Date.now();
    await fn();
    return Date.now() - began;
};

// ---------------------------------------------------------------------------
// A stand-in for the running game: same polling contract as RMMZLiveBridge.js
// ---------------------------------------------------------------------------
const PAGE = `e2e-page-${Math.random().toString(36).slice(2, 8)}`;
const game: {
    player: { x: number; y: number };
    variables: Record<number, number>;
    switches: Record<number, boolean>;
    keyName: string | null;
    tick: number;
    frame: number;
    seq: number;
    reloads: number;
    scene: string;
} = {
    player: { x: 5, y: 5 },
    variables: { 3: 42, 7: 0 },
    switches: { 12: true },
    keyName: null as string | null,
    tick: 0,
    frame: 0,
    seq: 0,
    reloads: 0,
    scene: "Scene_Map"
};

const Input = {
    keyMapper: { 13: "ok", 27: "cancel", 16: "shift", 37: "left", 38: "up", 39: "right", 40: "down" } as Record<number, string>,
    _currentState: {} as Record<string, boolean>
};
// frameCount is what the engine actually carries and what `live_key` counts a hold in;
// a mock without it silently turns every timed tool into a 5s failure.
const Graphics = { fps: () => 60, get frameCount() { return game.frame; } };
const $gamePlayer = {
    get x() {
        return game.player.x;
    },
    get y() {
        return game.player.y;
    }
};
const $gameVariables = { value: (id: number) => game.variables[id] ?? 0 };
const $gameSwitches = { value: (id: number) => Boolean(game.switches[id]) };

/**
 * The part of the plugin that makes a press survive: the buttons the bridge is
 * synthesising, re-asserted on every drawn frame *after* the browser-side wipe.
 * `blurEvery` below simulates what a real blur does — `Input.clear()` throws the whole
 * state object away — which is what a single write cannot survive. Counting the frames a
 * button was actually visible for is what turns "we wrote true once" into a test.
 */
const heldButtons = new Set<string>();
// Buttons the mock has written `true` for and has not written `false` for yet. The
// engine's `_currentState` is only written by a real key event, so a bridge that stops
// re-asserting without lowering the key leaves the player walking on their own — and
// cancels the next press in the other direction (`_signX() = right - left`).
const raisedButtons = new Set<string>();
const visibleFrames: Record<string, number> = {};
let blurEvery = 0;

/** Hold one button for `frames` drawn frames and report how many of them saw it down.
 *  The quiet-frame rule is the plugin's: a page that stops drawing must answer with the
 *  reason in less time than the caller's wait, not with a bare timeout. */
async function holdButton(name: string, frames: number, timeoutMs = 20000): Promise<number> {
    const target = game.frame + frames;
    const began = game.frame;
    const before = visibleFrames[name] ?? 0;
    const deadline = Date.now() + timeoutMs;
    let last = game.frame;
    let lastMove = Date.now();
    heldButtons.add(name);
    while (game.frame < target) {
        if (Date.now() > deadline) {
            heldButtons.delete(name);
            throw new Error(`holding ${name} gave up after ${timeoutMs}ms having advanced ${game.frame - began} of ${frames} frames`);
        }
        if (game.frame !== last) {
            last = game.frame;
            lastMove = Date.now();
        } else if (Date.now() - lastMove > 5000) {
            heldButtons.delete(name);
            throw new Error("the game advanced no frame for 5s, so it is paused, hidden, or not running");
        }
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    heldButtons.delete(name);
    return (visibleFrames[name] ?? 0) - before;
}

/** Mirrors the plugin's `settle`: an expression may return a promise and the caller
 *  gets the settled value, not an empty object. */
async function settle(value: unknown, limitMs: number): Promise<unknown> {
    if (!value || typeof (value as Promise<unknown>).then !== "function") {
        return value;
    }
    return await Promise.race([
        value,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`the expression's promise did not settle within ${limitMs}ms`)), limitMs))
    ]);
}

/** The frame rate the mock draws at. A3 drops it to ~9fps, which is what a background-
 *  throttled tab really runs at — a focused headless page measures 60 — so the frame-counted
 *  timing is graded at the slow rate too, where a millisecond-sized hold would not survive. */
let frameIntervalMs = 40;
let lastDrawAt = Date.now();
let drawing = true;
// A fixed 5ms ticker that draws when the interval has elapsed, rather than a
// self-rescheduling timeout: a timeout already in flight cannot be shortened, so a test
// that raised the interval to freeze the game would freeze the *next* test for a minute.
setInterval(() => {
    if (!drawing) {
        return;
    }
    const now = Date.now();
    if (now - lastDrawAt < frameIntervalMs) {
        return;
    }
    lastDrawAt = now;
    game.frame++;
    game.tick++;
    // The browser wiping the input state mid-hold is the failure this suite exists to
    // keep fixed, so it is simulated rather than hoped for.
    if (blurEvery > 0 && game.frame % blurEvery === 0) {
        Input._currentState = {};
    }
    for (const name of heldButtons) {
        Input._currentState[name] = true;
        raisedButtons.add(name);
        visibleFrames[name] = (visibleFrames[name] ?? 0) + 1;
    }
    for (const name of Array.from(raisedButtons)) {
        if (!heldButtons.has(name)) {
            Input._currentState[name] = false;
            raisedButtons.delete(name);
        }
    }
    if (game.tick % 5 === 0) {
        game.player.x = Math.min(20, game.player.x + 1);
    }
}, 5);

type MockCommand = { id: string; type: string; code?: string; keyCode?: number; direction?: number; holdFrames?: number; pulses?: number; cells?: number; gapMs?: number; timeoutMs?: number };

async function runCommand(command: MockCommand): Promise<void> {
    let result: unknown;
    let ok = true;
    try {
        if (command.type === "eval") {
            // Mirrors the plugin: eval inside the game's global scope, awaited if it is
            // a promise, serialized on the way out.
            const value = eval(String(command.code));
            result = await settle(value, 20000);
            result = typeof result === "object" && result !== null ? JSON.parse(JSON.stringify(result)) : result;
        } else if (command.type === "reload") {
            game.reloads++;
            result = { mapId: 1, width: 20, height: 15, eventsBefore: 0, events: 0, player: { ...game.player } };
        } else if (command.type === "key" || command.type === "move") {
            // Same contract as the plugin's `press`/`walk`: the button goes down, stays
            // down for a counted number of frames — re-asserted on every one of them —
            // and the reply says how many frames it actually held and where the player
            // ended up. A mock that skipped the re-assert would let a hold that the
            // engine can wipe look identical to one it cannot.
            const name = command.type === "key" ? (Input.keyMapper[Number(command.keyCode)] ?? null) : { 2: "down", 4: "left", 6: "right", 8: "up" }[Number(command.direction)];
            if (!name) {
                throw new Error(command.type === "key" ? `key code ${command.keyCode} is not mapped by this build of the engine` : `direction ${command.direction} is not one of 2, 4, 6, 8`);
            }
            const began = game.frame;
            const from = { ...game.player };
            const cells = command.type === "move" ? Math.max(1, Number(command.cells ?? 1)) : 1;
            const holdFrames = Math.max(1, Number(command.holdFrames ?? 2));
            const pulses = command.type === "key" ? Math.max(1, Number(command.pulses ?? 1)) : cells;
            let heldFrames = 0;
            for (let pulse = 0; pulse < pulses; pulse++) {
                heldFrames += await holdButton(name, holdFrames, Number(command.timeoutMs ?? 20000));
                if (command.type === "move") {
                    game.player.x = Math.min(20, game.player.x + 1);
                }
            }
            result = {
                button: name,
                pulses,
                holdFrames,
                heldFrames,
                gapMs: Number(command.gapMs ?? 120),
                framesAdvanced: game.frame - began,
                from,
                at: { ...game.player },
                changedCell: game.player.x !== from.x || game.player.y !== from.y,
                ...(command.type === "move" ? { direction: Number(command.direction), requested: cells, moved: cells, stopped: null } : {})
            };
        } else if (command.type === "screenshot") {
            // Mirrors the plugin: the frame as a PNG data url plus what was read.
            result = {
                png: `data:image/png;base64,${"A".repeat(200)}`,
                width: 816,
                height: 624,
                litSamples: 400,
                totalSamples: 511,
                scene: game.scene
            };
        } else if (command.type === "diagnostics") {
            result = { cursor: 0, entries: [] };
        } else {
            result = { ok: true };
        }
    } catch (error) {
        ok = false;
        result = String(error);
    }
    await fetch(`http://127.0.0.1:${PORT}/result`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-rmmz-token": TOKEN },
        // The plugin puts the failure in `error`, and a mock that buries it in `value`
        // turns every negative test into "command failed" with no reason attached.
        body: JSON.stringify(ok ? { id: command.id, ok, value: result } : { id: command.id, ok, error: String(result) })
    });
}

let polling = true;
/** True while a command is being worked on, so a test can see that the bridge did not
 *  hand a second one out on top of it. */
let busy = false;
(async () => {
    while (polling) {
        try {
            const response = await fetch(`http://127.0.0.1:${PORT}/state`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-rmmz-token": TOKEN },
                body: JSON.stringify({
                    page: PAGE,
                    scene: game.scene,
                    frame: game.frame,
                    reloads: game.reloads,
                    reloadPending: false,
                    paused: false,
                    map: { id: 1 },
                    player: { x: game.player.x, y: game.player.y },
                    variables: game.variables,
                    switchesOn: Object.keys(game.switches).filter(key => game.switches[Number(key)])
                })
            });
            const body = (await response.json()) as { command?: { id: string; type: string; code?: string } };
            if (body.command && !busy) {
                // The plugin does not stop polling while it works, so neither does this:
                // that is what lets two queued commands land at once if the bridge lets them.
                const command = body.command;
                busy = true;
                void runCommand(command).finally(() => {
                    busy = false;
                });
            }
        } catch {
            // server not listening yet
        }
        await new Promise(resolve => setTimeout(resolve, 40));
    }
})();

console.log("\n== live bridge");
// Waking the listener is what lets the polling game connect, so give it a beat.
await call("live_status");
await new Promise(resolve => setTimeout(resolve, 400));

const status = await call("live_status");
check("live_status reports the game", status.state?.player?.x >= 5, status.state ?? status);
check("bridge is listening", status.listening === true, status.listening);

const evaluated = await call("live_eval", { expression: "$gameVariables.value(3)" });
check("live_eval returns the in-game value", evaluated.value === 42, evaluated);

const position = await call("live_eval", { expression: "({ x: $gamePlayer.x, y: $gamePlayer.y })" });
check("object results survive serialization", position.value?.x >= 5, position);

const waited = await call("live_wait", { expression: "$gamePlayer.x >= 12", timeoutMs: 6000, pollMs: 100 });
check("live_wait observes the player walking", waited.satisfied === true, waited);

const reloaded = await call("live_reload", {});
check("live_reload round-trips the plugin's map summary", reloaded.mapId === 1 && typeof reloaded.player?.x === "number", reloaded);

const shot = (await client.callTool({ name: "live_screenshot", arguments: {} })) as { content: any[] };
check(
    "live_screenshot leads with a PNG part",
    shot.content[0]?.type === "image" && shot.content[0]?.mimeType === "image/png" && shot.content[0]?.data?.length > 50,
    { type: shot.content[0]?.type, mimeType: shot.content[0]?.mimeType }
);
check("live_screenshot also reports the frame it read", JSON.parse(shot.content[1]?.text ?? "{}").pixels?.[0] === 816, shot.content[1]?.text);

// ---------------------------------------------------------------------------
console.log("\n== A2: live_eval waits as long as the plugin does");
// The plugin gives a promise 20s to settle. An 8s default cut a 12s wait short with a
// timeout that blamed the game, so the documented ceiling was never reachable.
const slow = await ms(async () => {
    const settled = await call("live_eval", { expression: "new Promise(done => setTimeout(() => done('settled after 12s'), 12000))" });
    check("a 12s promise comes back on the default timeout", settled.value === "settled after 12s", settled);
});
check("and it took the 12s rather than failing at 8s", slow > 11500 && slow < 19000, { slow });

const raised = await call("live_eval", { expression: "new Promise(done => setTimeout(() => done('x'), 400))", timeoutMs: 60000 });
check("timeoutMs still raises the ceiling on request", raised.value === "x", raised);

// ---------------------------------------------------------------------------
console.log("\n== A3: live_key is sized by the frame rate it measures");
// A3 runs the mock at the ~9fps of a background-throttled tab. A hold counted in frames must
// wait real frames, and a press list too long for its budget must be clipped and say so.
frameIntervalMs = 111;
await new Promise(resolve => setTimeout(resolve, 1900));
const metered = await call("live_status");
check("the bridge measures the slow frame rate", metered.measuredFps !== null && metered.measuredFps < 15, { measuredFps: metered.measuredFps });

const walk = await call("live_key", { keyCode: 39, pulses: 1, holdFrames: 15 });
check("a 15-frame hold lands at 9fps", walk.button === "right" && walk.pulses === 1, walk);
check("the reply carries the measured rate it was sized with", walk.timing?.measuredFps && walk.timing.measuredFps < 15, walk.timing);
check("and the button was really down for all 15 of those frames", walk.heldFrames === 15, walk);

// ---------------------------------------------------------------------------
console.log("\n== A3b: a hold that a blurring page cannot undo, and walking without keys");
// Counting a hold in frames is only half of it. A browser blur runs Input.clear(), which
// throws the whole state object away, and a gamepad poll writes false over a button the
// pad says is up — either lands in the middle of a hold. The plugin re-asserts the held
// buttons every frame after that, so the frames the reply counts are the frames the game
// could act on. `blurEvery` is the wipe, and 3 frames is well inside a 12-frame hold.
blurEvery = 3;
const throughBlurs = await call("live_key", { keyCode: 39, pulses: 3, holdFrames: 4 });
check("3 presses x 4 frames are 12 frames a button was down, blurs and all", throughBlurs.heldFrames === 12, throughBlurs);
check("and it still reports the presses it sent", throughBlurs.pulses === 3 && throughBlurs.button === "right", throughBlurs);
blurEvery = 0;

// A hold is not over when the bridge stops re-asserting: the engine only ever hears
// about a key going up from a real keyup event, which a headless page never gets. Left
// down, a released key walks the player on its own *and* cancels the next press in the
// other direction, because the engine folds the arrows into `_signX() = right - left`.
await new Promise(resolve => setTimeout(resolve, 260));
const afterRelease = await call("live_eval", { expression: "({ right: Input._currentState.right === true, left: Input._currentState.left === true })" });
check("a finished press leaves no button down", afterRelease.value?.right === false && afterRelease.value?.left === false, afterRelease.value);

const stepped = await call("live_move", { direction: 6, cells: 3 });
check("live_move answers with the cells it walked", stepped.moved === 3 && stepped.requested === 3 && stepped.stopped === null, stepped);
check("naming the arrow it held, and where the player stands now", stepped.button === "right" && typeof stepped.at?.x === "number", stepped);
const badMove = await call("live_move", { direction: 5 } as any);
check("a direction that is not an arrow is refused, not guessed", Boolean(badMove.toolError), badMove);

// Now stop drawing frames: the game is hidden/paused, which used to hang for the full
// 15s + pulses and then report nothing but a timeout.
frameIntervalMs = 60_000;
const frozeAt = Date.now();
const clamped = await call("live_key", { keyCode: 13, pulses: 20, holdFrames: 30 });
const frozeMs = Date.now() - frozeAt;
check("a frozen page fails with a reason, not a bare timeout", Boolean(clamped.toolError) && /no frame for 5s/.test(clamped.toolError), clamped);
check("and names how many presses it actually scheduled", /asked for 20 presses, sent \d+/.test(clamped.toolError ?? ""), clamped);
check("it gives up in seconds, not the 66s the old arithmetic allowed", frozeMs < 14000, { frozeMs });

const stalled = await call("live_status");
check("live_status says the page has stopped advancing frames", stalled.stalled === true && /STALLED/.test(stalled.note), { stalled: stalled.stalled, note: stalled.note?.slice(0, 160) });
frameIntervalMs = 40;
await new Promise(resolve => setTimeout(resolve, 1900));
const resumed = await call("live_status");
check("and clears it once frames move again", resumed.stalled === false, { stalled: resumed.stalled });

// ---------------------------------------------------------------------------
console.log("\n== A6: commands run one after another, in the order they were asked for");
// Results come back on a different request than the poll that carried the command, so
// the next command used to go out on the next poll while the first was still running.
const [first, second] = await Promise.all([
    call("live_eval", { expression: "new Promise(done => setTimeout(() => { game.seq++; done('first'); }, 600))" }),
    call("live_eval", { expression: "game.seq" })
]);
check("the queued write ran before the queued read", first.value === "first" && second.value === 1, { first: first.value, second: second.value });

const third = await call("live_eval", { expression: "game.seq" });
check("and the queue is empty again afterwards", third.value === 1, third);

// ---------------------------------------------------------------------------
console.log("\n== A5: a poll without the right token is turned away, and says so");
const rejected = await fetch(`http://127.0.0.1:${PORT}/state`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-rmmz-token": "wrong" },
    body: JSON.stringify({ page: "imposter", player: { x: 99 } })
});
const rejectedBody = (await rejected.json()) as any;
check("a wrong token is refused on /state", rejected.status === 401 && rejectedBody.ok === false, { status: rejected.status, body: rejectedBody });
check("the forgery did not become the reported game", (await call("live_status")).state?.player?.x !== 99);
const afterRejection = await call("live_status");
check("live_status names the refused page", /imposter/.test(afterRejection.authError ?? ""), afterRejection.authError);
check("and counts the polls it turned away", afterRejection.rejectedPolls >= 1, afterRejection.rejectedPolls);

const forgedResult = await fetch(`http://127.0.0.1:${PORT}/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "cmd-1-1", ok: true, value: "from nowhere" })
});
check("a result pushed without the token is refused too", forgedResult.status === 401, { status: forgedResult.status });

// ---------------------------------------------------------------------------
console.log("\n== A1: a screenshot frame is not capped like a command");
const bigPng = "A".repeat(9_000_000);
const oversizedState = await fetch(`http://127.0.0.1:${PORT}/state`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-rmmz-token": TOKEN },
    body: JSON.stringify({ page: PAGE, frame: game.frame, blob: bigPng })
});
const oversizedBody = (await oversizedState.json()) as any;
check("a state report over its limit is rejected by name", /over the .* byte limit/.test(oversizedBody.error ?? ""), oversizedBody);
const bigResult = await fetch(`http://127.0.0.1:${PORT}/result`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-rmmz-token": TOKEN },
    body: JSON.stringify({ id: "nobody-is-waiting", ok: true, value: { png: `data:image/png;base64,${bigPng}` } })
});
const bigAccepted = (await bigResult.json()) as any;
check("the same size arriving as a result is accepted", bigAccepted.ok === true, bigAccepted);

const unmapped = await call("live_key", { keyCode: 202 });
check("unmapped key codes surface as errors", Boolean(unmapped.toolError), unmapped);

// ---------------------------------------------------------------------------
console.log("\n== A4: a busy port is retried once it frees, not latched forever");
// The bridge used to give up for the life of the process if the port was taken when it
// first tried, so the window that quits last left the one that stays running deaf.
await liveBridge.close();
const blocker = createServer((_request, response) => {
    // Answer and hang up: this server exists to hold the port, and a keep-alive
    // socket it leaves open against the polling page is a socket `close()` will
    // then wait for forever.
    response.writeHead(503, { connection: "close" });
    response.end();
});
await new Promise<void>(done => blocker.listen(PORT, "127.0.0.1", done));
liveBridge.ensure();
await new Promise(resolve => setTimeout(resolve, 200));
const blocked = await call("live_status");
check("a port that is taken reports the failure", blocked.listening === false && /could not listen/.test(blocked.listenError ?? ""), {
    listening: blocked.listening,
    listenError: blocked.listenError
});
await new Promise<void>(resolve => {
    blocker.closeAllConnections?.();
    blocker.close(() => resolve());
});
await new Promise(resolve => setTimeout(resolve, 1200));
const recovered = await call("live_status");
check("once the port is free the bridge listens again", recovered.listening === true && recovered.listenError === null, {
    listening: recovered.listening,
    listenError: recovered.listenError
});
await new Promise(resolve => setTimeout(resolve, 300));
const afterRecovery = await call("live_eval", { expression: "$gameVariables.value(3)" });
check("and the same page is drivable again", afterRecovery.value === 42, afterRecovery);

polling = false;
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
await client.close();
await server.close();
process.exit(failures === 0 ? 0 : 1);
