/**
 * Make sure the project is running in the browser attached to a CDP endpoint:
 * reuse a game page that answers, otherwise open a new tab, skip the splash,
 * start a new game, and report the scene it lands in.
 *
 * Reuse first because *creating* a game tab is the unreliable part under headless
 * Chromium: the tab appears in /json/list with the right url but never commits the
 * navigation, so every evaluate against it times out.
 */
const PORT = Number(process.argv[2] ?? 9333);
const GAME_URL = process.argv[3] ?? "http://127.0.0.1:8080/index.html";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function openSocket(url) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        socket.onopen = () => resolve(socket);
        socket.onerror = () => reject(new Error(`websocket to ${url} failed`));
    });
}

function makeRpc(socket) {
    const pending = new Map();
    let nextId = 1;
    socket.addEventListener("message", event => {
        const message = JSON.parse(event.data);
        const entry = pending.get(message.id);
        if (entry) {
            pending.delete(message.id);
            clearTimeout(entry.timer);
            entry.resolve(message);
        }
    });
    return (method, params = {}, timeoutMs = 20_000) =>
        new Promise((resolve, reject) => {
            const id = nextId++;
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            pending.set(id, { resolve, reject, timer });
            socket.send(JSON.stringify({ id, method, params }));
        });
}

const targets = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json());
const gamePages = async () => (await targets()).filter(target => target.type === "page" && target.url.includes("index.html"));

/** Attach to a game page only if its renderer actually answers. */
async function usableGamePage() {
    for (const candidate of await gamePages()) {
        let socket = null;
        try {
            socket = await openSocket(candidate.webSocketDebuggerUrl);
            const rpc = makeRpc(socket);
            const answer = await rpc("Runtime.evaluate", { expression: "location.href", returnByValue: true }, 6000);
            const href = answer.result?.result?.value;
            if (typeof href === "string" && href.includes("index.html")) {
                console.log(`reusing game tab ${candidate.id.slice(0, 8)} at ${href}`);
                return { socket, rpc };
            }
        } catch {
            // still committing, or wedged: not usable
        }
        socket?.close();
    }
    return null;
}

async function createGamePage() {
    const { webSocketDebuggerUrl: browserWs } = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const browser = await openSocket(browserWs);
    const browserRpc = makeRpc(browser);
    for (const stale of await gamePages()) {
        console.log(`closing the unresponsive game tab ${stale.id.slice(0, 8)}...`);
        await browserRpc("Target.closeTarget", { targetId: stale.id }).catch(() => {});
    }
    console.log(`opening ${GAME_URL}...`);
    const created = await browserRpc("Target.createTarget", { url: GAME_URL });
    await browser.close();
    const targetId = created.result?.targetId;
    for (let attempt = 0; attempt < 20; attempt++) {
        await wait(1500);
        const usable = await usableGamePage();
        if (usable && (!targetId || usable.socket.url.includes(targetId))) {
            return usable;
        }
        usable?.socket.close();
    }
    throw new Error(`no game page answered on the CDP endpoint (created target ${targetId ?? "(none)"})`);
}

const attached = (await usableGamePage()) ?? (await createGamePage());
const { socket, rpc } = attached;

/**
 * Retry while the page is still loading: a missing context is not a failure, and
 * a blocked renderer shows up as a timeout rather than an error.
 */
async function evaluate(expression, { timeoutMs = 20_000, retries = 15 } = {}) {
    let last = "no attempt";
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const answer = await rpc("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs }, timeoutMs + 4000);
            if (answer.error) {
                last = "CDP " + JSON.stringify(answer.error);
            } else if (answer.result.exceptionDetails) {
                last = answer.result.exceptionDetails.exception?.description ?? JSON.stringify(answer.result.exceptionDetails);
            } else {
                return answer.result.result.value;
            }
        } catch (error) {
            last = String(error.message ?? error);
        }
        await wait(1200);
    }
    throw new Error(`Runtime.evaluate kept failing: ${last}`);
}

await rpc("Runtime.enable").catch(() => {});

const boot = await evaluate(
    `(async () => {
        const nap = (ms) => new Promise(r => setTimeout(r, ms));
        const seen = [];
        for (let i = 0; i < 90; i++) {
            if (typeof SceneManager === 'undefined') { await nap(500); continue; }
            const scene = SceneManager._scene ? SceneManager._scene.constructor.name : 'none';
            if (!seen.includes(scene)) seen.push(scene);
            if (scene === 'Scene_Map') break;
            if (scene === 'Scene_Splash') {
                Input._currentState.ok = true;
                await nap(120);
                Input._currentState.ok = false;
            }
            // The title scene only opens its command window once it is no longer
            // busy; pressing New Game before that leaves the runtime stuck, so
            // wait for the same condition the engine itself waits for.
            const title = scene === 'Scene_Title' ? SceneManager._scene : null;
            if (title && title._commandWindow && !title.isBusy() &&
                !SceneManager.isSceneChanging() && globalThis.$dataSystem) {
                title.commandNewGame();
            }
            await nap(300);
        }
        const has = name => typeof globalThis[name] !== 'undefined' && globalThis[name];
        return JSON.stringify({
            scenes: seen,
            final: typeof SceneManager === 'undefined' ? 'no engine' : (SceneManager._scene ? SceneManager._scene.constructor.name : 'none'),
            map: has('$dataMap') && has('$gameMap') ? { id: $gameMap.mapId(), size: [$gameMap.width(), $gameMap.height()] } : null,
            player: has('$gamePlayer') && has('$dataMap') ? [$gamePlayer.x, $gamePlayer.y] : null,
            frame: typeof Graphics === 'undefined' ? null : Graphics.frameCount
        });
    })()`,
    { timeoutMs: 60_000, retries: 3 }
);
console.log("game state:", boot);
socket.close();
