//=============================================================================
// RMMZLiveBridge.js v0.4.1
// Part of rpgmaker-mcp: reports live game state to a local MCP server and,
// only when explicitly enabled, executes commands returned by that server.
//
// The server binds to 127.0.0.1 and shares a token with this plugin, so state
// never leaves the machine unless you point `host` somewhere else.
//
// v0.4.1: a button the bridge raised is lowered again when the hold ends. Leaving
// it down made the player drift after every press and cancelled the next one.
// v0.4.0: `key` and `move` commands, and the held-button re-assert that makes a
// press survive a browser blur. The version is reported to the server, which
// says so when the copy in the project is older than the one it ships — the
// otherewise-invisible way to lose a live tool is to upgrade the server only.
//=============================================================================

/*:
 * @target MZ
 * @version 0.4.1
 * @orderAfter rpgmaker-mcp
 * @plugindesc Live state bridge for the rpgmaker-mcp MCP server. Read-only unless Allow Eval is turned on.
 * @author rpgmaker-mcp
 *
 * @param host
 * @text Server host
 * @desc Keep this on the local machine.
 * @default 127.0.0.1
 *
 * @param port
 * @text Server port
 * @type number
 * @default 3789
 *
 * @param token
 * @text Shared token
 * @desc Must equal RMMZ_LIVE_TOKEN on the MCP server. Commands are refused when it does not match.
 * @default
 *
 * @param allowEval
 * @text Allow Eval
 * @type boolean
 * @default false
 * @desc Lets the MCP server run arbitrary JavaScript inside the running game. Only enable for your own project.
 *
 * @param intervalFrames
 * @text Report interval (poll ticks)
 * @type number
 * @default 6
 *
 * @param variableWindow
 * @text Max variable id reported
 * @type number
 * @default 200
 *
 * @param keepAwake
 * @text Keep running without focus
 * @type boolean
 * @default false
 * @desc Overrides SceneManager.isGameActive so the game keeps ticking while the window is not focused. Intended for automated testing.
 *
 * @param switchWindow
 * @text Max switch id reported
 * @type number
 * @default 200
 *
 * @param captureErrors
 * @text Capture errors and console
 * @type boolean
 * @default true
 * @desc Keeps a rolling buffer of runtime errors, failed asset loads and console warnings so live_diagnostics can read them. Turns off the engine's own behaviour in no way.
 *
 * @help
 *
 * Reports the player position, scene, switches and variables to the MCP server
 * while the game runs (editor playtest or a browser build served over http).
 *
 * Tools on the MCP server side: live_status, live_eval, live_wait, live_key,
 * live_move, live_reload, live_screenshot, live_diagnostics, live_pause, live_step,
 * and the assert_in_game runner that drives them. live_session starts and stops a
 * headless browser running this page, so no editor has to be open.
 * Set Allow Eval to true only if you want those tools to be able to run code
 * inside your game; live_key, live_move, live_reload, live_pause and live_step
 * work without it, because they run no code of the caller's.
 *
 * A press from live_key or live_move is held for a counted number of engine
 * frames, and the plugin re-asserts it every frame while it is held: a browser
 * blur, a gamepad poll or a second caller can otherwise put the button back up
 * before the frame that was meant to see it arrives.
 *
 * ?rmmzBridgePort= (and ?rmmzBridgeHost=) in the page URL override those two
 * parameters, which is how live_session points a playtest at the port its own
 * process listens on without editing this project. Nothing else can be set that
 * way: in particular Allow Eval stays a project setting.
 *
 * A live_eval expression may return a promise: the plugin waits up to 20 seconds
 * for it to settle and reports the settled value, or an error if it never does.
 *
 * The poll runs on its own timer rather than from a scene update hook, which is
 * what lets it keep answering after SceneManager.stop() cancels the game loop
 * (that is what the engine does when it hits an error) and while paused.
 */

(function () {
    "use strict";

    /** Reported in every state poll, so the server can tell a project still carrying an
     *  older copy of this file from one running what it ships. */
    const BRIDGE_VERSION = "0.4.1";

    const parameters = PluginManager.parameters("RMMZLiveBridge");
    // live_session puts the port it is listening on in the page URL, so a playtest
    // never has to rewrite this project's plugin parameters to talk to a different
    // server. A killed caller leaves the file alone instead of pointing the game at
    // a port nobody listens on.
    const query = new URL(location.href).searchParams;
    const host = String(query.get("rmmzBridgeHost") || parameters.host || "127.0.0.1");
    const port = Number(query.get("rmmzBridgePort") || parameters.port || 3789);
    const token = String(parameters.token || "");
    const allowEval = String(parameters.allowEval || "false") === "true";
    const intervalFrames = Math.max(1, Number(parameters.intervalFrames || 6));
    const variableWindow = Math.max(0, Number(parameters.variableWindow || 200));
    const switchWindow = Math.max(0, Number(parameters.switchWindow || 200));
    const keepAwake = String(parameters.keepAwake || "false") === "true";
    const captureErrors = String(parameters.captureErrors || "true") !== "false";
    const baseUrl = `http://${host}:${port}`;
    // Identifies this document. A server waiting for a reloaded page cannot rely on
    // the frame counter alone: the dying page gets a report in after the reload is
    // asked for, and a throttled page climbs too slowly to tell them apart.
    const pageId = Math.random().toString(36).slice(2, 10);

    if (keepAwake) {
        // The engine pauses on blur via window.top.document.hasFocus(); an
        // automated playtest has no focus, so opt out of the pause.
        SceneManager.isGameActive = function() {
            return true;
        };
    }

    let ticks = 0;
    let failures = 0;
    let backoff = 1;
    let broken = false;
    let engineFrames = 0;
    let paused = false;
    // How many reloads this page has been asked for, and whether the last one has
    // landed yet. The server waits on these instead of guessing from a timestamp.
    let reloads = 0;
    let reloadPending = false;
    let reloadMapId = 0;

    //-------------------------------------------------------------------------
    // Diagnostics buffer
    //
    // The engine's own error handling ends the game: SceneManager.onError calls
    // stop(), which cancels the requestAnimationFrame loop, and prints into a DOM
    // div that no canvas capture can see. So the only way an agent learns what
    // broke is if the plugin records it as it happens.

    const MAX_LOG = 200;
    const log = [];
    let logSeq = 0;
    let dropped = 0;

    function sceneName() {
        return SceneManager._scene ? SceneManager._scene.constructor.name : "none";
    }

    function loopStopped() {
        // Graphics.stopGameLoop() is PIXI's `app.stop()`, which clears the
        // ticker's `started` flag. SceneManager.onError calls it, so this is how
        // the bridge can tell "the game crashed" from "the game is running".
        return Boolean(Graphics._app && Graphics._app.ticker && !Graphics._app.ticker.started);
    }

    function brief(value) {
        if (value instanceof Error) {
            return `${value.name}: ${value.message}`;
        }
        if (typeof value === "string") {
            return value;
        }
        if (value === null || value === undefined) {
            return String(value);
        }
        try {
            return JSON.stringify(value).slice(0, 300);
        } catch (error) {
            return String(value);
        }
    }

    /**
     * One error's call stack, kept apart from the short `source` location so an
     * ordinary read of the log stays small and `full` can bring the frames back.
     */
    function stackLines(error) {
        const raw = error && error.stack ? String(error.stack) : "";
        if (!raw) {
            return [];
        }
        return raw
            .split("\n")
            .map(line => line.trim().slice(0, 200))
            .filter(Boolean)
            .slice(0, 24);
    }

    function record(kind, message, source, stack) {
        const text = String(message === undefined ? "" : message).slice(0, 500);
        if (!text) {
            return;
        }
        // A per-frame throw would otherwise bury everything else in the buffer,
        // and the engine reports one fault through several hooks.
        for (let i = log.length - 1, seen = 0; i >= 0 && seen < 12; i--, seen++) {
            if (log[i].message === text) {
                log[i].repeat++;
                log[i].at = Date.now();
                return;
            }
        }
        log.push({
            seq: ++logSeq,
            at: Date.now(),
            frame: engineFrames,
            scene: sceneName(),
            kind: kind,
            message: text,
            source: source ? String(source).slice(0, 300) : "",
            stack: stack || [],
            repeat: 0
        });
        if (log.length > MAX_LOG) {
            log.shift();
            dropped++;
        }
    }

    function readDiagnostics(since, limit, clear, full) {
        const entries = log
            .filter(entry => entry.seq > since)
            .slice(-limit)
            .map(entry => {
                const shaped = {
                    seq: entry.seq,
                    at: entry.at,
                    frame: entry.frame,
                    scene: entry.scene,
                    kind: entry.kind,
                    message: entry.message,
                    source: entry.source,
                    repeat: entry.repeat
                };
                if (full && entry.stack.length) {
                    shaped.stack = entry.stack;
                }
                return shaped;
            });
        if (clear) {
            log.length = 0;
        }
        return {
            entries: entries,
            cursor: logSeq,
            buffered: log.length,
            dropped: dropped,
            paused: paused,
            stopped: loopStopped(),
            scene: sceneName(),
            frame: engineFrames
        };
    }

    if (captureErrors) {
        // Capture phase: the error events for <img>/<audio>/<script> do not
        // bubble, so a listener on window only sees them while going down. This
        // is how a missing character sheet shows up, which the engine otherwise
        // swallows in Bitmap._onError. Registered from a plugin, so it runs
        // before the engine's own handler and its record is the one that carries
        // the file and line.
        window.addEventListener("error", event => {
            const target = event.target;
            if (target && target !== window && target.tagName) {
                record("asset", `${target.tagName.toLowerCase()} could not be loaded`, String(target.currentSrc || target.src || target.href || ""));
            } else {
                const where = event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : "";
                record("error", event.message, where, stackLines(event.error));
            }
        }, true);
        window.addEventListener("unhandledrejection", event => {
            record("error", `unhandled promise rejection: ${brief(event.reason)}`, "", stackLines(event.reason));
        }, true);

        // Every fatal path funnels through here: DataManager load failures,
        // SceneManager.catchNormalError, EffectManager. Hooking it instead of each
        // caller means a future engine release cannot slip an error past us.
        const enginePrintError = Graphics.printError.bind(Graphics);
        Graphics.printError = function(name, message, error) {
            if (name !== undefined) {
                const where = error && error.fileName ? `${error.fileName}:${error.lineNumber}` : "";
                record("engine", `${name}: ${brief(message)}`, where, stackLines(error));
            }
            return enginePrintError(name, message, error);
        };

        // A missing image or sound never reaches the window error listener: the
        // engine loads them through detached `new Image()` / fetch objects, and an
        // event on a node that is not in the document has no propagation path to
        // window. So hook the two places the engine records the failure itself.
        for (const [owner, method, folder] of [
            [Bitmap, "_onError", "image"],
            [WebAudio, "_onError", "audio"]
        ]) {
            const original = owner.prototype[method];
            owner.prototype[method] = function() {
                const url = this._url || (this._image && this._image.src) || (this._element && this._element.src) || "";
                record("asset", `${folder} could not be loaded`, String(url).replace(/^.*\/\/[^/]+/, ""));
                return original.apply(this, arguments);
            };
        }

        for (const level of ["warn", "error"]) {
            const original = console[level];
            console[level] = function() {
                record(`console.${level}`, Array.prototype.map.call(arguments, brief).join(" "));
                return original.apply(console, arguments);
            };
        }
    }

    //-------------------------------------------------------------------------
    // Pause and frame stepping
    //
    // Gated on SceneManager.updateMain, not on the scene: Graphics drives the
    // loop by calling SceneManager.update every animation frame, and update calls
    // updateMain one or more times. Skipping only updateMain leaves the loop
    // alive, so the last rendered frame stays on the canvas, live_screenshot keeps
    // working, and this plugin keeps polling.

    const engineUpdateMain = SceneManager.updateMain.bind(SceneManager);

    function runEngineFrame() {
        engineUpdateMain();
        engineFrames++;
    }

    SceneManager.updateMain = function() {
        if (!paused) {
            runEngineFrame();
        }
    };

    function step(frames) {
        const before = engineFrames;
        paused = true;
        for (let i = 0; i < frames; i++) {
            try {
                runEngineFrame();
            } catch (error) {
                // Same handling the engine gives a frame that throws: report it and
                // stop, rather than letting it escape into the animation frame.
                SceneManager.catchException(error);
                break;
            }
        }
        return { paused: true, advanced: engineFrames - before, frame: engineFrames, requested: frames };
    }

    //-------------------------------------------------------------------------
    // Synthesised key presses
    //
    // A press used to be a single write to `Input._currentState[name]` from a timer,
    // and two things were wrong with it. One: the engine can undo that write before the
    // frame meant to see it — `Input.clear()` (a browser blur) throws the whole state
    // object away, and `Input._pollGamepads` writes `false` over a button its pad
    // reports up. Two, and worse: `SceneManager.update` calls `updateInput()` once and
    // `updateMain()` one or more times after it, so a hold timed in *engine* frames can
    // be raised and released between two input polls and the game never sees it at all.
    // Measured on a real page at 60fps: a 2-frame direction press moved the player on
    // 5 of 10 tries; counted in input polls, 10 of 10.
    //
    // So the bridge keeps the buttons it is synthesising, re-asserts them inside
    // `Input._pollGamepads` — after the gamepad poll, before `_updateDirection` reads
    // the state — and times a hold in polls. That is the one point in a frame where the
    // write is certain to be seen by the frame it belongs to, at 9fps or at 60fps.
    //
    // And a button has to be *put back* when the hold ends. `_currentState` is only ever
    // written by a real keydown/keyup or by this bridge, so raising a button and then
    // simply stopping the re-assert leaves `right: true` in the engine's state forever —
    // one physical keypress and release away from being cleared, which is never on a
    // headless page. Measured: the player drifts right on its own after a walk, and the
    // next walk left reads `Input._signX() = right - left = 0`, freezes for the whole
    // timeout, and reports nothing was in the way. So every button the bridge raised is
    // lowered again on the next poll, by the poll hook rather than by the command that
    // finished, so a page reload cannot strand it.

    const heldButtons = new Map();
    const BUTTON_OF_DIR = { 2: "down", 4: "left", 6: "right", 8: "up" };
    const raisedButtons = new Set();
    let inputPolls = 0;

    const pollGamepads = Input._pollGamepads.bind(Input);
    Input._pollGamepads = function () {
        pollGamepads();
        inputPolls++;
        for (const [name, entry] of heldButtons) {
            this._currentState[name] = true;
            raisedButtons.add(name);
            entry.polls++;
        }
        for (const name of raisedButtons) {
            if (!heldButtons.has(name)) {
                this._currentState[name] = false;
                raisedButtons.delete(name);
            }
        }
    };

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    /**
     * Hold one button until the engine has sampled input `count` times with it down.
     * The quiet rule is the difference between "this press is taking a while" and
     * "nothing is drawing at all"; without it a hidden tab turns every timed tool into
     * a bare timeout.
     */
    async function hold(name, count, timeoutMs, what) {
        const entry = { polls: 0 };
        heldButtons.set(name, entry);
        const deadline = Date.now() + timeoutMs;
        let lastSeen = -1;
        let lastMove = Date.now();
        try {
            while (entry.polls < count) {
                if (Date.now() > deadline) {
                    throw new Error(`${what} gave up after ${timeoutMs}ms with the button seen by ${entry.polls} of ${count} input frames`);
                }
                if (entry.polls !== lastSeen) {
                    lastSeen = entry.polls;
                    lastMove = Date.now();
                } else if (Date.now() - lastMove > 5000) {
                    throw new Error("the game advanced no frame for 5s, so it is paused, hidden, or not running");
                }
                await sleep(4);
            }
        } finally {
            heldButtons.delete(name);
        }
        return entry.polls;
    }

    /** Wait for one input pass, so a walking loop advances exactly one frame per step. */
    async function nextPoll(timeoutMs) {
        const target = inputPolls + 1;
        const deadline = Date.now() + timeoutMs;
        let last = inputPolls;
        let lastMove = Date.now();
        while (inputPolls < target) {
            if (Date.now() > deadline) {
                throw new Error("the walk ran out of time before the game sampled input again");
            }
            if (inputPolls !== last) {
                last = inputPolls;
                lastMove = Date.now();
            } else if (Date.now() - lastMove > 5000) {
                throw new Error("the game advanced no frame for 5s, so it is paused, hidden, or not running");
            }
            await sleep(4);
        }
    }

    function playerCell() {
        if (typeof $gamePlayer === "undefined" || !$gamePlayer) {
            return null;
        }
        return { x: $gamePlayer.x, y: $gamePlayer.y, map: typeof $gameMap !== "undefined" && $gameMap ? $gameMap.mapId() : null };
    }

    /** What the engine thinks is in the way, in words an agent can act on. */
    function busyReason() {
        if (typeof $gamePlayer === "undefined" || !$gamePlayer) {
            return null;
        }
        if ($gameMessage.hasText() || $gameMessage.isBusy()) {
            return "a dialog is on screen";
        }
        if ($gameMap.isEventRunning()) {
            return "an event is running";
        }
        if ($gamePlayer.isMoveRouteForcing()) {
            return "a movement route has the player";
        }
        return null;
    }

    function buttonFor(command) {
        const name = command.button || BUTTON_OF_DIR[Number(command.direction)];
        const mapped = command.keyCode === undefined || command.keyCode === null ? name : Input.keyMapper[Number(command.keyCode)];
        if (!mapped) {
            throw new Error(
                command.keyCode === undefined || command.keyCode === null
                    ? `no such direction ${JSON.stringify(command.direction)}: pass 2, 4, 6 or 8`
                    : `key code ${command.keyCode} is not mapped by this build of the engine`
            );
        }
        return mapped;
    }

    /** Hold a button for a counted number of input frames, `pulses` times. */
    async function press(command) {
        const name = buttonFor(command);
        const holdFrames = Math.max(1, Math.min(60, Number(command.holdFrames ?? 2)));
        const pulses = Math.max(1, Math.min(40, Number(command.pulses ?? 1)));
        const gapMs = Math.max(0, Math.min(2000, Number(command.gapMs ?? 120)));
        const timeoutMs = Math.max(500, Math.min(20000, Number(command.timeoutMs ?? 20000)));
        const began = engineFrames;
        const from = playerCell();
        let sent = 0;
        let heldPolls = 0;
        for (; sent < pulses; sent++) {
            heldPolls += await hold(name, holdFrames, timeoutMs, `holding ${name}`);
            if (gapMs && sent + 1 < pulses) {
                await sleep(gapMs);
            }
        }
        const to = playerCell();
        const moved = Boolean(from && to && (from.x !== to.x || from.y !== to.y));
        return {
            button: name,
            pulses: sent,
            holdFrames: holdFrames,
            heldFrames: heldPolls,
            gapMs: gapMs,
            framesAdvanced: engineFrames - began,
            from: from,
            at: to,
            changedCell: moved,
            ...(moved || !from ? {} : { busy: busyReason() })
        };
    }

    /**
     * Walk the player a number of cells by holding the arrow key, which is the
     * engine's own input path: `Game_Player.moveByInput` sees the button and steps,
     * and the nonmoving update that follows is what counts the step, walks the
     * encounter counter down and checks the touch triggers. An API call that moves the
     * character directly reaches some of that and not the rest, and an agent cannot
     * tell which from the outside — so this one takes the path a person takes.
     */
    async function walk(command) {
        const dir = Number(command.direction);
        if (!BUTTON_OF_DIR[dir]) {
            throw new Error(`direction must be 2, 4, 6 or 8, not ${JSON.stringify(command.direction)}`);
        }
        const name = BUTTON_OF_DIR[dir];
        const cells = Math.max(1, Math.min(30, Number(command.cells ?? 1)));
        const timeoutMs = Math.max(500, Math.min(20000, Number(command.timeoutMs ?? 8000)));
        if (typeof $gamePlayer === "undefined" || !$gamePlayer) {
            throw new Error("walking needs a game in progress");
        }
        if (!(SceneManager._scene instanceof Scene_Map)) {
            throw new Error(`walking needs a map scene, not ${sceneName()}`);
        }
        const began = engineFrames;
        const from = playerCell();
        const stepsBefore = typeof $gameParty !== "undefined" && $gameParty ? $gameParty._steps : null;
        const encounterBefore = $gamePlayer._encounterCount;
        const axis = dir === 4 || dir === 6 ? "x" : "y";
        const sign = dir === 6 || dir === 2 ? 1 : -1;
        const entry = { polls: 0 };
        const deadline = Date.now() + timeoutMs;
        let moved = 0;
        let stopped = null;
        heldButtons.set(name, entry);
        try {
            while (moved < cells && Date.now() < deadline) {
                await nextPoll(Math.max(200, deadline - Date.now()));
                moved = Math.max(moved, sign * ($gamePlayer[axis] - from[axis]));
                if (moved >= cells) {
                    break;
                }
                if (!(SceneManager._scene instanceof Scene_Map)) {
                    stopped = `the scene became ${sceneName()}`;
                    break;
                }
                const busy = busyReason();
                if (busy) {
                    stopped = busy;
                    break;
                }
                if (!$gamePlayer.isMoving()) {
                    if (!$gamePlayer.canPass($gamePlayer.x, $gamePlayer.y, dir)) {
                        stopped = "the cell ahead will not let the player through";
                        break;
                    }
                    // A walk that the ground permits and the player does not take has a
                    // reason, and "out of time" is not it. The engine folds the four arrow
                    // buttons into one direction (`_signX() = right - left`), so a second
                    // button down in the opposite direction cancels this one, and a map
                    // event or a dialog takes input away without moving anyone.
                    if (Input.dir4 !== dir) {
                        stopped = `the engine reads direction ${Input.dir4} with ${name} held, so another button is cancelling it`;
                        break;
                    }
                    if (!$gamePlayer.canMove()) {
                        stopped = "the player is not taking input: an event, a dialog, a forced route or a transfer has it";
                        break;
                    }
                }
            }
        } catch (error) {
            stopped = String(error && error.message ? error.message : error);
        } finally {
            heldButtons.delete(name);
        }
        return {
            button: name,
            direction: dir,
            requested: cells,
            moved: moved,
            heldFrames: entry.polls,
            from: from,
            at: playerCell(),
            stopped: stopped || (moved >= cells ? null : "out of time"),
            framesAdvanced: engineFrames - began,
            steps: typeof $gameParty !== "undefined" && $gameParty ? { before: stepsBefore, after: $gameParty._steps } : null,
            encounterCount: { before: Math.round(encounterBefore * 100) / 100, after: Math.round($gamePlayer._encounterCount * 100) / 100 }
        };
    }

    function engineVersion() {
        // MZ exposes no public engine version string; `versionId` is what the
        // runtime itself uses to invalidate saves, so it identifies the build.
        if ($dataSystem && $dataSystem.versionId !== undefined) {
            return $dataSystem.versionId;
        }
        return "unknown";
    }

    function snapshot() {
        const state = {
            gameTitle: $dataSystem ? $dataSystem.gameTitle : "",
            engine: engineVersion(),
            bridge: BRIDGE_VERSION,
            scene: sceneName(),
            page: pageId,
            frame: engineFrames,
            paused: paused,
            // True once SceneManager.stop() has cancelled the game loop, which is
            // what the engine does on an uncaught error. The bridge still answers.
            stopped: loopStopped(),
            // SceneManager.updateScene only updates the scene while the page has
            // focus, so a headless browser sits still unless keepAwake is on.
            // Reporting it turns "nothing moves" into something the caller can read.
            focused: Boolean(SceneManager.isGameActive()),
            reloads: reloads,
            reloadPending: reloadPending,
            time: Date.now()
        };
        if (log.length) {
            const last = log[log.length - 1];
            state.diagnostics = { total: logSeq, dropped: dropped, lastKind: last.kind, lastMessage: last.message };
        }
        if ($dataMap && $gameMap) {
            // Game_Map.width() and height() read the global $dataMap, so asking
            // them before a map is loaded (title screen, mid-transfer) throws.
            state.map = { id: $gameMap.mapId(), width: $gameMap.width(), height: $gameMap.height() };
        }
        if ($dataMap && $gamePlayer) {
            state.player = {
                x: $gamePlayer.x,
                y: $gamePlayer.y,
                direction: $gamePlayer.direction(),
                transparency: $gamePlayer.isTransparent(),
                // MZ has no Game_Player.inVehicle(); that is MV. `vehicle()`
                // returns the vehicle the player is riding, or null.
                inVehicle: typeof $gamePlayer.vehicle === "function" ? Boolean($gamePlayer.vehicle()) : false,
                moving: $gamePlayer.isMoving()
            };
        }
        if ($gameSwitches) {
            const on = [];
            for (let id = 1; id <= switchWindow; id++) {
                if ($gameSwitches.value(id)) {
                    on.push(id);
                }
            }
            state.switchesOn = on;
        }
        if ($gameVariables) {
            const values = {};
            for (let id = 1; id <= variableWindow; id++) {
                const value = $gameVariables.value(id);
                if (value !== 0 && value !== null && value !== undefined) {
                    values[id] = value;
                }
            }
            state.variables = values;
        }
        if ($gameParty) {
            state.party = $gameParty.battleMembers().map(member => ({
                id: member.actorId(),
                name: member.name(),
                level: member.level,
                hp: member.hp,
                mhp: member.mhp
            }));
            state.gold = $gameParty.gold();
        }
        if ($gameMessage) {
            state.messageActive = $gameMessage.isBusy();
        }
        return state;
    }

    function request(path, payload, method) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open(method || "POST", baseUrl + path, true);
            xhr.setRequestHeader("Content-Type", "application/json");
            xhr.setRequestHeader("x-rmmz-token", token);
            xhr.timeout = 2000;
            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(xhr.responseText ? JSON.parse(xhr.responseText) : {});
                } else {
                    reject(new Error(`HTTP ${xhr.status}`));
                }
            };
            xhr.onerror = () => reject(new Error("network"));
            xhr.ontimeout = () => reject(new Error("timeout"));
            xhr.send(payload ? JSON.stringify(payload) : null);
        });
    }

    /**
     * Re-read the current map from disk and rebuild the running map around it.
     *
     * The XHR is synchronous on purpose. `DataManager.loadMapData` nulls
     * `$dataMap` and fills it in a later callback, and anything that touches the
     * map in that window — an event page check, a tile lookup — takes the game
     * down on the MZ error screen. One atomic swap has no such gap.
     */
    function reloadMap() {
        if (!(SceneManager._scene instanceof Scene_Map)) {
            throw new Error(`reload needs a map scene, not ${sceneName()}`);
        }
        const mapId = $gameMap.mapId();
        reloads++;
        reloadMapId = mapId;
        reloadPending = true;
        const file = "data/Map" + mapId.padZero(3) + ".json";
        const before = ($dataMap.events || []).filter(Boolean).length;
        const xhr = new XMLHttpRequest();
        xhr.open("GET", file, false);
        xhr.overrideMimeType("application/json");
        xhr.send(null);
        if (xhr.status >= 400 || !xhr.responseText) {
            throw new Error(`${file} could not be read (HTTP ${xhr.status})`);
        }
        $dataMap = JSON.parse(xhr.responseText);
        // Same post-processing DataManager.onLoad does for a map file.
        DataManager.extractMetadata($dataMap);
        DataManager.extractArrayMetadata($dataMap.events);
        $gameMap.setup(mapId);
        // A fresh Scene_Map rebuilds the tilemap and the character sprites from
        // the new map; requesting the change from here is what the engine's own
        // transfer path does from inside Scene_Map.update.
        SceneManager.goto(Scene_Map);
        return {
            mapId: mapId,
            width: $dataMap.width,
            height: $dataMap.height,
            eventsBefore: before,
            events: $dataMap.events.filter(Boolean).length,
            player: { x: $gamePlayer.x, y: $gamePlayer.y }
        };
    }

    /**
     * Read back the frame the game is actually drawing: message windows, face
     * graphics, fonts, weather, character sprites, tile blending. No file-layer
     * tool can show those, which is why this exists next to `render_map`.
     *
     * `app.render()` first, then `drawImage` in the same task: MZ never sets
     * `preserveDrawingBuffer`, so the WebGL canvas is only readable before the
     * browser composites it. PIXI's `renderer.extract` is not used because it
     * sizes its readback from the stage bounds, and MZ's stage carries the screen
     * scale, which asks for a gigapixel buffer and throws.
     */
    function screenshot() {
        const app = Graphics._app;
        const source = Graphics._canvas;
        if (!app || !source || !source.width || !source.height) {
            throw new Error("the game has not created its canvas yet");
        }
        app.render();
        const canvas = document.createElement("canvas");
        canvas.width = source.width;
        canvas.height = source.height;
        const context = canvas.getContext("2d");
        context.drawImage(source, 0, 0);
        // A blank frame would otherwise come back looking like a success.
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let lit = 0;
        let samples = 0;
        for (let i = 0; i + 2 < pixels.length; i += 4 * 997) {
            samples++;
            if (pixels[i] > 8 || pixels[i + 1] > 8 || pixels[i + 2] > 8) {
                lit++;
            }
        }
        if (!samples || !lit) {
            throw new Error("the captured frame is entirely black");
        }
        return {
            png: canvas.toDataURL("image/png"),
            width: canvas.width,
            height: canvas.height,
            litSamples: lit,
            totalSamples: samples,
            scene: sceneName()
        };
    }

    /**
     * An expression may return a promise — waiting on a frame counter, a transfer,
     * a scene change — and a caller that asked for the value wants the settled
     * value. The deadline keeps a promise that never resolves from holding the
     * bridge open forever.
     */
    function settle(value, ms) {
        if (!value || typeof value.then !== "function") {
            return value;
        }
        return Promise.race([
            value,
            new Promise((_, reject) => setTimeout(() => reject(new Error(`the expression's promise did not settle within ${ms}ms`)), ms))
        ]);
    }

    async function runCommand(command) {
        const result = { id: command.id };
        if (command.type === "eval") {
            if (!allowEval) {
                result.ok = false;
                result.error = "Allow Eval is disabled in the RMMZLiveBridge plugin";
            } else {
                try {
                    // eslint-disable-next-line no-eval
                    const value = eval(command.code);
                    result.ok = true;
                    result.value = serialize(await settle(value, 20000));
                } catch (error) {
                    result.ok = false;
                    result.error = String(error && error.message ? error.message : error);
                }
            }
        } else if (command.type === "state") {
            result.ok = true;
            result.value = snapshot();
        } else if (command.type === "reload") {
            // No Allow Eval gate: this reads one known file and calls known
            // engine methods, it does not run anything the caller invented.
            try {
                result.ok = true;
                result.value = reloadMap();
            } catch (error) {
                result.ok = false;
                result.error = String(error && error.message ? error.message : error);
            }
        } else if (command.type === "screenshot") {
            try {
                result.ok = true;
                result.value = screenshot();
            } catch (error) {
                result.ok = false;
                result.error = String(error && error.message ? error.message : error);
            }
        } else if (command.type === "diagnostics") {
            try {
                result.ok = true;
                result.value = readDiagnostics(
                    Number(command.since || 0),
                    Number(command.limit || 50),
                    Boolean(command.clear),
                    Boolean(command.full)
                );
            } catch (error) {
                result.ok = false;
                result.error = String(error && error.message ? error.message : error);
            }
        } else if (command.type === "key") {
            // No Allow Eval gate, same as reload and pause: this writes one known
            // button into the engine's own input state and waits for frames. It runs
            // nothing the caller invented.
            try {
                result.ok = true;
                result.value = await press(command);
            } catch (error) {
                result.ok = false;
                result.error = String(error && error.message ? error.message : error);
            }
        } else if (command.type === "move") {
            try {
                result.ok = true;
                result.value = await walk(command);
            } catch (error) {
                result.ok = false;
                result.error = String(error && error.message ? error.message : error);
            }
        } else if (command.type === "pause") {
            paused = Boolean(command.paused);
            result.ok = true;
            result.value = { paused: paused, frame: engineFrames };
        } else if (command.type === "step") {
            try {
                result.ok = true;
                result.value = step(Math.max(1, Math.min(600, Number(command.frames || 1))));
            } catch (error) {
                result.ok = false;
                result.error = String(error && error.message ? error.message : error);
            }
        } else {
            result.ok = false;
            result.error = `unknown command type ${command.type}`;
        }
        return result;
    }

    function serialize(value) {
        if (value === undefined) {
            return null;
        }
        if (value === null || typeof value !== "object") {
            return value;
        }
        if (typeof Game_Interpreter !== "undefined" && value instanceof Game_CharacterBase) {
            return { character: true, name: value.name ? value.name() : "", x: value.x, y: value.y };
        }
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (error) {
            return String(value);
        }
    }

    let snapshotFailures = 0;

    /** Command ids this page has been handed, mapped to the answer it produced (null
     *  while still running), so a re-delivery cannot run a command twice. */
    const answered = new Map();

    function bridgeTick() {
        if (broken) {
            return;
        }
        // A reload is finished when the scene change has happened and the map the
        // engine re-read for it is back. Scene_Map.create() sets $dataMap to null and
        // loads the file asynchronously, so between the reload command and this
        // condition the game is still holding the old map or no map at all.
        if (
            reloadPending &&
            $dataMap &&
            $gameMap &&
            SceneManager._scene instanceof Scene_Map &&
            !SceneManager.isSceneChanging() &&
            $gameMap.mapId() === reloadMapId
        ) {
            reloadPending = false;
        }
        ticks++;
        // Back off while the MCP server is not listening: starting the editor
        // before the server is the normal order, so giving up permanently after
        // a few failures would make the bridge useless in exactly that case.
        if (ticks % Math.max(1, intervalFrames * backoff) !== 0) {
            return;
        }
        let payload;
        try {
            payload = snapshot();
            snapshotFailures = 0;
        } catch (error) {
            // A transient fault (a scene mid-transition) should not end the
            // session, so report it and keep going; only a run of them switches
            // the bridge off. This runs outside the engine's try/catch, and an
            // exception escaping here would surface as a window error, which the
            // engine answers by stopping the game loop.
            record("bridge", `snapshot failed: ${error.message}`);
            if (++snapshotFailures >= 10) {
                broken = true;
                console.log(`RMMZLiveBridge: disabled after ${snapshotFailures} snapshot errors (${error.message})`);
            }
            return;
        }
        request("/state", payload)
            .then(response => {
                if (failures > 0) {
                    console.log("RMMZLiveBridge: server reachable again");
                }
                failures = 0;
                backoff = 1;
                const command = response && response.command;
                if (command) {
                    // The server re-sends a command it has not heard back about, which is
                    // right for a response lost on the wire and wrong for a command that is
                    // simply still working: walking 25 cells takes seconds, and running it
                    // twice moves the player somewhere nobody asked for. So an id the page
                    // has already answered is answered again from the copy, and an id it is
                    // working on is left alone.
                    if (answered.has(command.id)) {
                        const remembered = answered.get(command.id);
                        return remembered ? request("/result", remembered) : null;
                    }
                    answered.set(command.id, null);
                    if (answered.size > 80) {
                        answered.delete(answered.keys().next().value);
                    }
                    // runCommand can wait for a promise, so the answer goes back when
                    // it settles rather than when the command was picked up.
                    return Promise.resolve(runCommand(command))
                        .then(result => result, error => ({ id: command.id, ok: false, error: String(error && error.message ? error.message : error) }))
                        .then(result => {
                            answered.set(command.id, result);
                            return request("/result", result);
                        });
                }
                return null;
            })
            .catch(error => {
                failures++;
                if (failures % 20 === 1) {
                    console.log(`RMMZLiveBridge: server not reachable (${error.message}), retrying with backoff`);
                }
                backoff = Math.min(32, Math.ceil(failures / 20) + 1);
            });
    }

    // Driven from its own timer rather than a scene update alias: SceneManager
    // .stop() calls Graphics.stopGameLoop(), so anything riding the game loop
    // goes quiet at the exact moment the game has crashed. setInterval also covers
    // every scene, not just map and battle.
    setInterval(() => {
        try {
            bridgeTick();
        } catch (error) {
            broken = true;
            console.log(`RMMZLiveBridge: disabled after an error (${error.message})`);
        }
    }, 1000 / 60);
})();
