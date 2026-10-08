/*:
 * @target MZ
 * @plugindesc Opt-in localhost MCP test-play bridge: actual screenshots, safe runtime controls, map reload.
 * @author Local Visual MCP
 * @help
 * Enable only in local test play. Start the MCP server with --live-bridge.
 * Reads .rpg-mcp/connection.json inside the project; it is not a publishable asset.
 * Does not evaluate arbitrary code, edit disk maps, or save games.
 * Reloading a map resets its event runtime state. Do not ship this plugin enabled.
 */
(() => {
  "use strict";
  if (!Utils.isOptionValid("test") || (!Utils.isNwjs() && !window.__MZ_MCP_BOOT)) return;
  const native = Utils.isNwjs();
  const fs = native ? require("fs") : null, path = native ? require("path") : null;
  const http = native ? require("http") : null, nodeCrypto = native ? require("crypto") : null;
  const root = native ? path.dirname(process.mainModule.filename) : null;
  if (native) console.info(`[MZVisualBridge] enabled; root=${root}; argv=${JSON.stringify(nw.App.argv)}`);
  const session = native ? nodeCrypto.randomBytes(16).toString("hex") :
    Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, "0")).join("");
  let busy = false, timer = null, lastError = "", lastGameError = "", sceneTicks = 0;
  // MZ gates scene updates on OS window focus: SceneManager.isGameActive() is
  // window.top.document.hasFocus(), so a backgrounded test-play page stops calling
  // scene.update() while Graphics.frameCount keeps rising. Every settle wait below
  // would then expire against a frozen simulation and blame the map.
  SceneManager.isGameActive = () => true;
  const baseSceneUpdate = Scene_Base.prototype.update;
  Scene_Base.prototype.update = function () { sceneTicks++; return baseSceneUpdate.apply(this, arguments); };
  // MZ 1.8 attaches Input listeners to document and derives the one-frame
  // "trigger" edge in Input.update from rising _currentState transitions, which
  // a blur (window "blur" → Input.clear()) wipes mid-press. Input.virtualClick
  // is the engine's own virtual-button API: it survives Input.clear and yields
  // exactly one clean trigger on the next frame, so prefer it and use a real
  // keydown as the realistic path alongside.
  const KEY_CODES = { ok: 13, cancel: 27, up: 38, down: 40, left: 37, right: 39, pageup: 33, pagedown: 34 };
  function tapButton(button) {
    if (typeof Input.virtualClick === "function") { Input.virtualClick(button); return; }
    Input._currentState[button] = true;
  }
  function pressKey(button) {
    const keyCode = KEY_CODES[button];
    if (!keyCode) return false;
    document.dispatchEvent(new KeyboardEvent("keydown", { keyCode, which: keyCode, bubbles: true, cancelable: true }));
    setTimeout(() => document.dispatchEvent(new KeyboardEvent("keyup", { keyCode, which: keyCode, bubbles: true, cancelable: true })), 60);
    return true;
  }
  window.addEventListener("error", event => {
    lastGameError = (event.error && event.error.stack) || `${event.message} (${event.filename}:${event.lineno}:${event.colno})`;
  });
  window.addEventListener("unhandledrejection", event => {
    lastGameError = String((event.reason && event.reason.stack) || event.reason);
  });
  function state() {
    return {
      scene: SceneManager._scene?.constructor?.name || "unknown",
      mapId: $gameMap?.mapId() || 0,
      player: $gamePlayer ? { x: $gamePlayer.x, y: $gamePlayer.y, direction: $gamePlayer.direction(), moving: $gamePlayer.isMoving() } : null,
      events: $gameMap?.events().map(e => ({ id: e.eventId(), name: e.event()?.name, x: e.x, y: e.y, pageIndex: e._pageIndex, erased: e._erased })) || [],
      messageBusy: $gameMessage?.isBusy() || false
      , messageText: $gameMessage?.allText() || "",
      choiceTexts: $gameMessage?.choices() || [],
      sceneWindows: SceneManager._scene ? Object.keys(SceneManager._scene).filter(k => k.endsWith("Window")).map(k => {
        const w = SceneManager._scene[k];
        return w ? { name: k, active: Boolean(w.active), visible: Boolean(w.visible), index: typeof w.index === "function" ? w.index() : null,
          commands: w._list?.map(c => c.name) || [] } : null;
      }).filter(Boolean) : [],
      party: $gameParty?.members().map(a => ({ id: a.actorId(), name: a.name(), hp: a.hp, mhp: a.mhp, mp: a.mp, level: a.level })) || [],
      battle: $gameParty?.inBattle() ? { phase: BattleManager._phase, turn: $gameTroop.turnCount(),
        enemies: $gameTroop.members().map(e => ({ name: e.name(), hp: e.hp, mhp: e.mhp, alive: e.isAlive() })) } : null,
      lastGameError: lastGameError || null,
      errorPrinter: document.getElementById("errorPrinter")?.textContent || null
      // Read-back for set_switch/set_variable/event conditions. Without these the
      // runtime surface is write-only and a switch can only be inferred from behaviour.
      , switches: sparse($gameSwitches?._data, 64), variables: sparse($gameVariables?._data, 64),
      selfSwitches: sparse($gameSelfSwitches?._data, 32)
    };
  }
  function sparse(data, limit) {
    if (!data) return null;
    const out = {};
    for (const [key, value] of Object.entries(data)) { if (value) { out[key] = value; if (Object.keys(out).length >= limit) break; } }
    return out;
  }
  function connection() {
    const value = native ? JSON.parse(fs.readFileSync(path.join(root, ".rpg-mcp", "connection.json"), "utf8")) : window.__MZ_MCP_BOOT;
    const url = new URL(value.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !/^[a-f0-9]{64}$/.test(value.token)) throw new Error("Invalid localhost connection");
    return value;
  }
  function post(route, payload, connectionInfo) {
    if (!native) return fetch(new URL(route, connectionInfo.url), {
      method: "POST", headers: { Authorization: `Bearer ${connectionInfo.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(async response => {
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || "Bridge error");
      return value;
    });
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload), url = new URL(route, connectionInfo.url);
      // DOM URL is not instanceof Node's URL in NW.js's separate contexts.
      // Passing its string form works with the bundled Node 14 HTTP overload.
      const request = http.request(url.href, { method: "POST", headers: { Authorization: `Bearer ${connectionInfo.token}`,
        "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, timeout: 5000 }, response => {
        let text = "";
        response.on("data", chunk => { text += chunk; });
        response.on("end", () => {
          try { const value = JSON.parse(text); if (response.statusCode !== 200) reject(new Error(value.error)); else resolve(value); }
          catch (error) { reject(error); }
        });
      });
      request.on("error", reject); request.on("timeout", () => request.destroy(new Error("Bridge timeout")));
      request.end(body);
    });
  }
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  function settleBlockers() {
    const scene = SceneManager._scene;
    return `scene=${scene?.constructor?.name || "none"} fade=${scene?._fadeDuration} wait=${scene?._waitCount} ` +
      `encounter=${scene?._encounterEffectDuration} message=${$gameMessage?.isBusy() || false} ` +
      `transferring=${$gamePlayer?.isTransferring() || false} moving=${$gamePlayer?.isMoving() || false} ` +
      `focused=${window.top.document.hasFocus()} visible=${document.visibilityState}`;
  }
  async function settled(what = "map") {
    const startTicks = sceneTicks, startFrames = Graphics.frameCount;
    for (let i = 0; i < 160; i++) {
      const scene = SceneManager._scene;
      if (scene instanceof Scene_Map && scene.isStarted() && !SceneManager.isSceneChanging() && !scene.isBusy() &&
          !$gamePlayer.isTransferring() && !$gamePlayer.isMoving()) {
        await wait(80); return;
      }
      await wait(30);
    }
    const stalled = sceneTicks === startTicks;
    throw new Error(`Map did not settle (${what}) in ~5s: ${settleBlockers()} ` +
      `sceneTickDelta=${sceneTicks - startTicks} frames=${Graphics.frameCount - startFrames}` +
      (stalled ? " — the scene loop ticked 0 times, so the engine is not updating this map at all." : ""));
  }
  // sceneTicks is the honest liveness signal: Graphics.frameCount keeps rising even
  // when MZ refuses to call scene.update(), which is what made the old message misleading.
  async function sceneTick(before, limit = 20) {
    for (let i = 0; i < limit; i++) { if (sceneTicks > before) return true; await wait(30); }
    return false;
  }
  async function execute(command) {
    const p = command.parameters || {};
    if (command.command === "start_new_game") {
      if (!(SceneManager._scene instanceof Scene_Title)) throw new Error("start_new_game is allowed only at title screen");
      DataManager.setupNewGame();
      SceneManager.goto(Scene_Map); await settled("start_new_game");
      return { state: state() };
    }
    if (command.command === "capture") {
      const bitmap = SceneManager.snap();
      const png = bitmap.canvas.toDataURL("image/png");
      bitmap.destroy();
      return { png, state: state() };
    }
    if (command.command === "input") {
      if (!Object.keys(KEY_CODES).includes(p.button)) throw new Error("Unknown safe game button");
      // Real keydown for the authentic pipeline plus the engine's virtual
      // click so the trigger edge survives a focus change between frames.
      const before = sceneTicks;
      pressKey(p.button);
      tapButton(p.button);
      const consumed = await sceneTick(before);
      await wait(80);
      Input._currentState[p.button] = false;
      // A trigger no scene ever read is dropped by the engine on the next frame, so
      // reporting success here would be a silent no-op.
      return { consumed, state: state() };
    }
    if (!(SceneManager._scene instanceof Scene_Map)) throw new Error("Runtime control requires active Scene_Map");
    switch (command.command) {
      case "reload_map":
        if ($gameMessage.isBusy() || $gameMap.isEventRunning()) throw new Error("Finish event/message before reloading map");
        $gamePlayer.reserveTransfer($gameMap.mapId(), $gamePlayer.x, $gamePlayer.y, $gamePlayer.direction(), 2);
        $gamePlayer.requestMapReload(); await settled("reload_map"); break;
      case "teleport":
        $gamePlayer.reserveTransfer(p.mapId, p.x, p.y, p.direction || 2, 2); await settled("teleport"); break;
      case "move": {
        // src/runtime.js gives up at 15s and drops the queued command, so stop early and
        // say how far the player actually got instead of letting the retry double-move.
        const steps = p.steps || 1, deadline = Date.now() + 11000;
        for (let i = 0; i < steps; i++) {
          if (!$gamePlayer.canMove()) throw new Error(`Player cannot move during event/message after ${i} of ${steps} step(s)`);
          $gamePlayer.moveStraight(p.direction); await settled(`move step ${i + 1}/${steps}`);
          if (i + 1 < steps && Date.now() > deadline)
            throw new Error(`Stopped after ${i + 1} of ${steps} step(s): bridge command budget nearly exhausted, re-issue the remaining steps`);
        }
        break;
      }
      case "interact": {
        const before = sceneTicks;
        // One rising-edge "ok" trigger via Input.virtualClick; pressing keys
        // directly is unnecessary — MZ routes the confirm through Input.
        tapButton("ok");
        const consumed = await sceneTick(before);
        return { consumed, state: state() };
      }
      case "set_switch": $gameSwitches.setValue(p.id, p.value); await wait(80); break;
      case "set_variable": $gameVariables.setValue(p.id, p.value); await wait(80); break;
      default: throw new Error("Unsupported safe runtime action");
    }
    return { state: state() };
  }
  async function poll() {
    if (busy) return;
    busy = true;
    try {
      const link = connection(), data = await post("/api/runtime/poll", { session, state: state() }, link);
      for (const command of data.commands) {
        let reply;
        try { reply = { result: await execute(command) }; } catch (error) { reply = { error: error.message }; }
        await post("/api/runtime/reply", { session, id: command.id, ...reply }, link);
      }
      lastError = "";
    } catch (error) {
      if (lastError !== error.message) console.warn(`[MZVisualBridge] ${error.message}`);
      lastError = error.message;
    } finally { busy = false; }
  }
  timer = setInterval(poll, 300);
  window.addEventListener("beforeunload", () => clearInterval(timer));
})();
