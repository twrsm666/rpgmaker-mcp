import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { basename, extname, join, normalize, resolve } from "node:path";
import { liveBridge } from "./liveServer.js";

/**
 * A headless browser running the project, so the live tools have a game to talk
 * to without anyone opening the editor. The page is loaded by the browser itself
 * rather than through a debugging protocol: a tab created that way under headless
 * Chromium sometimes never commits its navigation, which the scripted suites hit
 * and a tool must not depend on. Everything past the first frame goes through the
 * bridge plugin, so this side needs no CDP client at all.
 */

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".gif": "image/gif",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".webm": "video/webm",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".css": "text/css; charset=utf-8",
    ".efkefc": "application/octet-stream",
    ".txt": "text/plain; charset=utf-8"
};

const BROWSER_NAMES = [
    "microsoft-edge",
    "msedge",
    "google-chrome",
    "chrome",
    "chromium",
    "chromium-browser",
    "brave-browser"
];

interface BrowserGuess {
    path: string;
    why: string;
}

function candidates(): BrowserGuess[] {
    const home = process.env["HOME"] ?? "";
    const programFiles = process.env["ProgramFiles"] ?? "C:/Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)";
    const local = process.env["LOCALAPPDATA"] ?? "";
    if (process.platform === "win32") {
        return [
            { path: join(programFilesX86, "Microsoft/Edge/Application/msedge.exe"), why: "Edge (x86)" },
            { path: join(programFiles, "Microsoft/Edge/Application/msedge.exe"), why: "Edge" },
            { path: join(programFiles, "Google/Chrome/Application/chrome.exe"), why: "Chrome" },
            { path: join(local, "Google/Chrome/Application/chrome.exe"), why: "Chrome (per-user)" },
            { path: join(programFiles, "BraveSoftware/Brave-Browser/Application/brave.exe"), why: "Brave" }
        ];
    }
    if (process.platform === "darwin") {
        return [
            { path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", why: "Edge" },
            { path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", why: "Chrome" },
            { path: "/Applications/Chromium.app/Contents/MacOS/Chromium", why: "Chromium" },
            { path: `${home}/.cache/ms-playwright/chromium-headless_shell`, why: "playwright cache" }
        ];
    }
    return [
        { path: "/usr/bin/microsoft-edge", why: "Edge" },
        { path: "/opt/google/chrome/chrome", why: "Chrome" },
        { path: "/usr/bin/google-chrome", why: "google-chrome" },
        { path: "/usr/bin/chromium", why: "Chromium" },
        { path: "/usr/bin/chromium-browser", why: "chromium-browser" }
    ];
}

/** A Chromium-family binary that can run a page without a window. */
export function findBrowser(explicit?: string): { path: string; how: string } {
    if (explicit) {
        if (!existsSync(explicit)) {
            throw new Error(`The browser "${explicit}" does not exist.`);
        }
        return { path: explicit, how: "caller" };
    }
    const fromEnv = process.env["RMMZ_BROWSER"];
    if (fromEnv) {
        if (!existsSync(fromEnv)) {
            throw new Error(`RMMZ_BROWSER points at "${fromEnv}", which does not exist.`);
        }
        return { path: fromEnv, how: "RMMZ_BROWSER" };
    }
    for (const guess of candidates()) {
        if (existsSync(guess.path)) {
            return { path: guess.path, how: guess.why };
        }
    }
    const finder = process.platform === "win32" ? "where" : "which";
    for (const name of BROWSER_NAMES) {
        const looked = spawnSync(finder, [name], { encoding: "utf8" });
        const first = (looked.stdout ?? "").split(/\r?\n/).find(line => line.trim());
        if (looked.status === 0 && first && existsSync(first.trim())) {
            return { path: first.trim(), how: `PATH/${name}` };
        }
    }
    throw new Error(
        `No Chromium-family browser found. Looked for ${candidates().map(guess => guess.path).join(", ")} and then ` +
            `for ${BROWSER_NAMES.join(", ")} on PATH. Set RMMZ_BROWSER to the executable, or pass "browser".`
    );
}

function pidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * The command line of a process, used to prove a recorded pid is still the browser
 * this tool launched before anything is killed. The pid comes from a file, and the
 * operating system recycles pids, so this check is what keeps `stop` from ever
 * pointing at somebody else's process.
 */
function commandLineOfSync(pid: number): string {
    if (!Number.isInteger(pid) || pid <= 0) {
        return "";
    }
    try {
        return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    } catch {
        return "";
    }
}

/**
 * Ask a child process for text without stopping the event loop. PowerShell takes a
 * second or two to enumerate processes, and this server answers MCP over that same
 * loop: a synchronous query here froze every other tool - including `live_status` on
 * a game that is very much still running - for as long as it took.
 */
function runCapture(command: string, args: string[]): Promise<{ status: number; stdout: string }> {
    return new Promise(resolve => {
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
        let stdout = "";
        child.stdout?.on("data", chunk => {
            stdout += String(chunk);
        });
        child.on("error", () => resolve({ status: -1, stdout: "" }));
        child.on("close", status => resolve({ status: status ?? -1, stdout }));
    });
}

async function commandLineOf(pid: number): Promise<string> {
    if (!Number.isInteger(pid) || pid <= 0) {
        return "";
    }
    if (process.platform === "win32") {
        // Ask for one specific pid rather than filtering every process by its
        // command line, which is how a cleanup script once matched its own query.
        const looked = await runCapture("powershell", [
            "-NoProfile",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
        ]);
        return looked.status === 0 ? (looked.stdout ?? "").trim() : "";
    }
    return commandLineOfSync(pid);
}

/** Delete a directory tree, tolerating the files a just-killed browser still locks. */
function removeDirectory(dir: string): boolean {
    try {
        rmSync(dir, { recursive: true, force: true });
        return !existsSync(dir);
    } catch {
        return false;
    }
}

/**
 * Process names a browser can appear as. The filter is a list of names rather than a
 * scan of every command line because the scan is what once matched the cleanup
 * script's own PowerShell query. Brave is the reason the list is longer than the
 * installer's file name: `brave.exe` hands the page to `brave_browser.exe`, so a kill
 * that only knew the first left a whole game polling the bridge.
 */
const BROWSER_PROCESS_NAMES = ["msedge.exe", "edge.exe", "chrome.exe", "chrome_beta.exe", "chromium.exe", "chromium_browser.exe", "brave.exe", "brave_browser.exe", "vivaldi.exe"];

function browserNameFilter(): string {
    const names = new Set<string>(BROWSER_PROCESS_NAMES);
    for (const guess of candidates()) {
        names.add(basename(guess.path).toLowerCase());
    }
    return [...names].map(name => `Name='${name.replace(/'/g, "")}'`).join(" OR ");
}

/**
 * Every process still carrying this session's profile directory. A renderer can
 * outlive the browser process it belongs to, and it is the renderer that runs the
 * page's JavaScript, so a kill that leaves one behind leaves a game polling.
 */
async function pidsWithMarker(marker: string): Promise<number[]> {
    if (process.platform === "win32") {
        const escaped = marker.replace(/'/g, "''");
        const looked = await runCapture(
            "powershell",
            [
                "-NoProfile",
                "-Command",
                `Get-CimInstance Win32_Process -Filter "${browserNameFilter()}" | ` +
                    `Where-Object { $_.CommandLine -ne $null -and $_.CommandLine.Contains('${escaped}') } | ` +
                    `Select-Object -ExpandProperty ProcessId`
            ]
        );
        if (looked.status !== 0) {
            return [];
        }
        return (looked.stdout ?? "")
            .split(/\r?\n/)
            .map(line => Number(line.trim()))
            .filter(pid => Number.isInteger(pid) && pid > 0);
    }
    const found: number[] = [];
    for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) {
            continue;
        }
        if (commandLineOfSync(Number(entry)).includes(marker)) {
            found.push(Number(entry));
        }
    }
    return found;
}

/** Run a taskkill without making the caller wait on the event loop. */
async function kill(pid: number, tree: boolean): Promise<void> {
    if (process.platform === "win32") {
        await runCapture("taskkill", tree ? ["/F", "/T", "/PID", String(pid)] : ["/F", "/PID", String(pid)]);
        return;
    }
    try {
        if (tree) {
            // The browser was spawned as a group leader, so the negative pid takes the
            // renderer and GPU processes with it.
            process.kill(-pid, "SIGKILL");
            return;
        }
        process.kill(pid, "SIGKILL");
    } catch {
        // Already gone.
    }
}

async function killTree(pid: number, marker: string): Promise<{ killed: boolean; note: string; remaining: number[] }> {
    const commandLine = await commandLineOf(pid);
    if (commandLine.includes(marker)) {
        await kill(pid, true);
    }
    // The recorded pid can be dead, recycled, or a launcher stub that handed the page
    // to another process. Whatever it is, the processes that still hold the profile are
    // the ones that can poll the bridge, so they are picked off by marker rather than
    // trusted to the tree of a pid we can no longer account for.
    for (const straggler of await pidsWithMarker(marker)) {
        await kill(straggler, false);
    }
    const remaining = await pidsWithMarker(marker);
    return {
        killed: remaining.length === 0,
        note:
            remaining.length === 0
                ? "every process holding the session profile is gone"
                : `still running: ${remaining.join(", ")}`,
        remaining
    };
}

async function listenOn(preferred: number, root: string): Promise<{ server: Server; port: number }> {
    let lastError = "";
    for (let attempt = 0; attempt < 12; attempt++) {
        const port = preferred + attempt;
        const server = createServer((request, response) => {
            const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
            const file = normalize(join(root, path));
            if (!file.startsWith(root) || !existsSync(file)) {
                response.writeHead(404).end("not found");
                return;
            }
            response.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
            response.end(readFileSync(file));
        });
        try {
            await new Promise<void>((resolveListen, rejectListen) => {
                server.once("error", rejectListen);
                server.listen(port, "127.0.0.1", () => resolveListen());
            });
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            continue;
        }
        // An error on a later request must not reach the process default handler,
        // which would end the MCP server over a broken socket.
        server.on("error", () => {});
        return { server, port };
    }
    throw new Error(`Could not bind a loopback port near ${preferred}: ${lastError}`);
}

export interface SessionReport {
    running: boolean;
    url: string;
    gamePort: number;
    browser: { path: string; how: string; pid: number; alive: boolean };
    startedAt: string;
    profileDir: string;
    stderr: string[];
    bridge: { listening: boolean; port: number; listenError: string | null; ageMs: number | null; state: any };
}

export interface StartResult {
    session: SessionReport;
    bridgeConnected: boolean;
    boot: { scenes: string[]; final: string; map?: number; player?: number[]; note?: string };
    note?: string;
}

/**
 * One browser session per server process. Two would both poll the same bridge,
 * and the live tools cannot tell whose game they are driving.
 */
class PlaytestSession {
    private current: {
        server: Server;
        child: ReturnType<typeof spawn>;
        pid: number;
        port: number;
        url: string;
        browser: { path: string; how: string };
        profileDir: string;
        startedAt: string;
        stderr: string[];
    } | null = null;

    /** When this process last stopped a browser, so its dying poll is not read as a
     *  game that is currently up. */
    private stoppedAt = 0;

    constructor(private readonly stateDir: string, private readonly projectDirProvider: () => string) {}

    private get stateFile(): string {
        return join(this.stateDir, "session.json");
    }

    /** Records what was launched so a later server process can still clean it up. */
    private persist(): void {
        const session = this.current;
        if (!session) {
            return;
        }
        mkdirSync(this.stateDir, { recursive: true });
        writeFileSync(
            this.stateFile,
            JSON.stringify(
                {
                    pid: session.pid,
                    port: session.port,
                    url: session.url,
                    profileDir: session.profileDir,
                    startedAt: session.startedAt,
                    browser: session.browser.path
                },
                null,
                2
            ),
            "utf8"
        );
    }

    private readStateFile(): { pid: number; profileDir: string; url: string; port: number; startedAt: string } | null {
        if (!existsSync(this.stateFile)) {
            return null;
        }
        try {
            return JSON.parse(readFileSync(this.stateFile, "utf8"));
        } catch {
            return null;
        }
    }

    private clearStateFile(): void {
        rmSync(this.stateFile, { force: true });
    }

    /**
     * What the live bridge currently reports, with the noisy parts of the state
     * payload left out.
     */
    private bridgeView(): SessionReport["bridge"] {
        const status = liveBridge.status();
        const state = status.state ?? {};
        return {
            listening: status.listening,
            port: status.port,
            listenError: status.listenError,
            ageMs: status.ageMs,
            state: {
                scene: state.scene ?? null,
                page: state.page ?? null,
                frame: state.frame ?? null,
                paused: state.paused ?? false,
                stopped: state.stopped ?? false,
                focused: state.focused ?? null,
                map: state.map ?? null,
                player: state.player ? [state.player.x, state.player.y] : null,
                gameTitle: state.gameTitle ?? ""
            }
        };
    }

    private report(): SessionReport | null {
        if (!this.current) {
            return null;
        }
        return {
            running: true,
            url: this.current.url,
            gamePort: this.current.port,
            browser: {
                path: this.current.browser.path,
                how: this.current.browser.how,
                pid: this.current.pid,
                alive: pidAlive(this.current.pid)
            },
            startedAt: this.current.startedAt,
            profileDir: this.current.profileDir,
            stderr: this.current.stderr.slice(-8),
            bridge: this.bridgeView()
        };
    }

    /** Wait for a report that is new since `since` and, when asked, from a
     *  different document. After a reload the dying page gets one more report in,
     *  and a throttled page's frame counter climbs too slowly to tell them apart, so
     *  the plugin's per-document `page` id is the signal and the frame reset is only
     *  the fallback for an older plugin build. */
    private async waitForBridge(timeoutMs: number, since: number, expect?: { page?: string; belowFrame?: number }): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const child = this.current?.child;
            if (child && child.exitCode !== null && child.signalCode === null) {
                throw new Error(
                    `The browser exited with code ${child.exitCode} before the game reported anything. ` +
                        `${(this.current?.stderr ?? []).slice(-3).join(" | ") || "No output from the browser."}`
                );
            }
            const seen = liveBridge.status();
            if (seen.lastSeenAt !== null && seen.lastSeenAt >= since) {
                if (!expect) {
                    this.claimPoller();
                    return true;
                }
                const state = (seen.state ?? {}) as any;
                const differentPage = expect.page !== undefined && typeof state.page === "string" && state.page !== expect.page;
                const frameRestarted =
                    expect.belowFrame !== undefined && Number.isFinite(state.frame) && Number(state.frame) < expect.belowFrame;
                if (differentPage || frameRestarted || (expect.page === undefined && expect.belowFrame === undefined)) {
                    this.claimPoller();
                    return true;
                }
            }
            await new Promise(done => setTimeout(done, 500));
        }
        return false;
    }

    /**
     * Tell the bridge which of the polling documents is this session's game, so
     * commands cannot be answered by a playtest somebody else opened on the same port.
     */
    private claimPoller(): void {
        const newest = liveBridge.status().pollers[0];
        if (newest) {
            liveBridge.claimPage(newest.page);
        }
    }

    /**
     * Walk from whatever scene the page booted into to the starting map: confirm
     * the splash, then ask the title scene to do what its own menu item does. This
     * is the engine's own code path, so a project with a custom title scene simply
     * reports the scene it stayed in rather than being forced.
     */
    private async walkToMap(timeoutMs: number): Promise<StartResult["boot"]> {
        const seen: string[] = [];
        const deadline = Date.now() + timeoutMs;
        const expression =
            `(() => { const scene = SceneManager._scene ? SceneManager._scene.constructor.name : "none"; ` +
            `if (scene === "Scene_Splash") { Input._currentState.ok = true; setTimeout(() => { Input._currentState.ok = false; }, 150); return scene; } ` +
            `const title = scene === "Scene_Title" ? SceneManager._scene : null; ` +
            `if (title && title._commandWindow && !title.isBusy() && !SceneManager.isSceneChanging() && globalThis.$dataSystem) { ` +
            `title.commandNewGame(); return "Scene_Title:new game"; } return scene; })()`;
        let lastError = "";
        while (Date.now() < deadline) {
            let scene = "";
            try {
                const answer = await liveBridge.send({ type: "eval", code: expression }, 8000);
                if (answer.ok) {
                    scene = String(answer.value ?? "unknown");
                } else if (/allow eval/i.test(answer.error ?? "")) {
                    return {
                        scenes: seen,
                        final: "unknown",
                        note:
                            `The game is running but will not take commands (${answer.error}). Turn on the bridge plugin's ` +
                            `Allow Eval to start a new game from here, or press the keys yourself.`
                    };
                } else {
                    lastError = answer.error ?? "the command failed";
                }
            } catch (error) {
                // No answer inside the timeout is the page still loading its scripts,
                // not a fault worth reporting yet.
                lastError = error instanceof Error ? error.message : String(error);
            }
            const live = (liveBridge.status().state ?? {}) as any;
            if (live.stopped === true) {
                // `Graphics.stopGameLoop()` runs from `SceneManager.onError`, so a stopped
                // ticker is the engine having given up — and the bridge keeps answering
                // afterwards, which is how a dead game used to read as a slow one. The
                // reviewer waited 120 seconds for a `clamp` on a missing System key that
                // was already sitting in the error log.
                return {
                    scenes: seen,
                    final: live.scene ?? "none",
                    note:
                        `The engine stopped its own game loop, which it does when a frame throws, so no map is coming. ` +
                        `Captured error: ${live.diagnostics?.lastMessage ?? lastError ?? "nothing captured"}. ` +
                        `Read live_diagnostics for the stack, and validate_game for the engine keys this project is missing.`
                };
            }
            if (scene) {
                if (!seen.includes(scene)) {
                    seen.push(scene);
                }
                const state = (liveBridge.status().state ?? {}) as any;
                if (state.scene === "Scene_Map" && state.map?.id > 0) {
                    // Scene_Map is entered before the transfer has finished placing
                    // the player, and a page that is reloading reports the scene it
                    // is leaving. Read the state once more after a beat and only
                    // accept it if it still says map.
                    await new Promise(done => setTimeout(done, 1000));
                    const settled = (liveBridge.status().state ?? {}) as any;
                    if (settled.scene === "Scene_Map" && settled.map?.id > 0) {
                        return {
                            scenes: seen,
                            final: settled.scene,
                            map: settled.map.id,
                            player: settled.player ? [settled.player.x, settled.player.y] : undefined
                        };
                    }
                }
            }
            await new Promise(done => setTimeout(done, 400));
        }
        return {
            scenes: seen,
            final: (liveBridge.status().state as any)?.scene ?? "none",
            note: lastError ? `Still not on a map after ${timeoutMs}ms; last command error: ${lastError}` : `Still not on a map after ${timeoutMs}ms.`
        };
    }

    /**
     * Read the project's own plugin list to explain a session that never reports in,
     * which is nearly always the bridge plugin being absent, switched off, or holding
     * a different token. The page URL carries the port, so a stale `port` parameter is
     * not a reason for silence and is not reported as one.
     */
    private bridgePluginHint(projectDir: string): string | null {
        const file = join(projectDir, "js", "plugins.js");
        if (!existsSync(file)) {
            return `${file} does not exist, so the project cannot load any plugin, RMMZLiveBridge included.`;
        }
        const source = readFileSync(file, "utf8");
        if (!source.includes('"RMMZLiveBridge"')) {
            return (
                "js/plugins.js does not list RMMZLiveBridge. Copy plugin/RMMZLiveBridge.js into <project>/js/plugins/ " +
                "and enable it (list_plugins then patch_plugin, or write_plugin_source, do this from here)."
            );
        }
        const entry = /"RMMZLiveBridge",\s*"status":(true|false)/.exec(source.replace(/\s+/g, " ")) ?? null;
        if (entry && entry[1] === "false") {
            return 'RMMZLiveBridge is listed but switched off: patch_plugin {"name":"RMMZLiveBridge","status":true}.';
        }
        const token = /"RMMZLiveBridge".{0,400}?"token":"([^"]*)"/s.exec(source)?.[1] ?? "";
        if (token !== liveBridge.token) {
            return `RMMZLiveBridge's token parameter is "${token || "(unset)"}" but this server sends commands with a different token, so state will arrive and commands will be refused. Set them the same (patch_plugin).`;
        }
        if (!/allowEval":\s*"?true/.test(source)) {
            return 'RMMZLiveBridge has Allow Eval off, so live_eval, live_key, live_screenshot and live_session\'s own new-game walk are refused. Set the plugin parameter allowEval to true for a playtest you want driven from here.';
        }
        return null;
    }

    async start(options: {
        gamePort?: number;
        browser?: string;
        newGame?: boolean;
        waitForBridgeMs?: number;
        bootMs?: number;
        force?: boolean;
    }): Promise<StartResult> {
        if (this.current) {
            throw new Error(`This server already has a session on port ${this.current.port} (pid ${this.current.pid}). Stop it first.`);
        }
        // The page reports *to* this port, so a session that never bound it can never
        // see the game it just launched: `waitForBridge` would poll its own closed
        // socket and every cold `start` would time out. Awaiting the bind is what makes
        // the conflict a refusal here rather than a browser with nothing to talk to.
        await liveBridge.ensure();
        const listenError = liveBridge.status().listenError;
        if (listenError) {
            throw new Error(listenError);
        }
        const profileDir = join(this.stateDir, "browser-profile");
        const seen = liveBridge.status();
        // The last poll of a game this tool itself stopped is still recent for a few
        // seconds, so only polls that arrived after that count as "a game is up".
        if (!options.force && seen.ageMs !== null && seen.ageMs < 4000 && (seen.lastSeenAt ?? 0) > this.stoppedAt) {
            // A browser left by a session that was killed rather than stopped keeps
            // polling and would be driven instead of the new one. It carries this
            // package's own profile directory, so it is ours to remove; anything else
            // is a playtest somebody started by hand and must not be touched.
            const strays = await pidsWithMarker(profileDir);
            if (strays.length === 0) {
                throw new Error(
                    `A game is already reporting to the bridge (${seen.ageMs}ms ago), so the live tools can drive it as it is. ` +
                        `Starting a second one would leave two games polling port ${liveBridge.port} and no way to tell them apart. ` +
                        `Pass force: true only if you mean it.`
                );
            }
            for (const pid of strays) {
                await killTree(pid, profileDir);
            }
            await this.waitForQuiet(8000);
            this.stoppedAt = Date.now();
            liveBridge.noteStopped();
        }
        const projectDir = resolve(this.projectDirProvider());
        if (!existsSync(join(projectDir, "index.html"))) {
            throw new Error(`${projectDir} has no index.html, so there is nothing for a browser to run.`);
        }
        const pluginHint = this.bridgePluginHint(projectDir);
        const stale = this.readStateFile();
        let staleSweep: string | null = null;
        if (stale && pidAlive(stale.pid)) {
            // A live pid from a file is not necessarily the browser that file recorded:
            // Windows hands out pids again, so a killed playtest's number can belong to
            // somebody else's process by the next run. The command line carries this
            // package's profile directory, which nothing else has any reason to name.
            const line = await commandLineOf(stale.pid);
            if (line.includes(stale.profileDir)) {
                throw new Error(
                    `A session from an earlier server process is still up (pid ${stale.pid}, ${stale.url}). ` +
                        `Stop it with live_session {"action":"stop"} first.`
                );
            }
            staleSweep = `pid ${stale.pid} is alive but is not the browser that recorded it, so its session file was cleared`;
        }
        if (stale && !this.current) {
            this.clearStateFile();
        }

        const browser = findBrowser(options.browser);
        const { server, port } = await listenOn(options.gamePort ?? 8080, projectDir);
        // The plugin reads its server port from the URL when it is there, so the
        // project's own parameters never have to move to run a playtest.
        const url = `http://127.0.0.1:${port}/index.html?rmmzBridgePort=${liveBridge.port}`;
        // A browser that was killed rather than stopped can still hold the profile
        // directory; that is not a reason to refuse a new session.
        removeDirectory(profileDir);
        mkdirSync(profileDir, { recursive: true });


        const launchedAt = Date.now();
        const child = spawn(
            browser.path,
            [
                "--headless=new",
                `--user-data-dir=${profileDir}`,
                "--no-first-run",
                "--no-default-browser-check",
                "--mute-audio",
                "--disable-background-timer-throttling",
                "--disable-renderer-backgrounding",
                "--disable-backgrounding-occluded-windows",
                "--autoplay-policy=no-user-gesture-required",
                "--window-size=900,700",
                url
            ],
            { stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32" }
        );
        const stderr: string[] = [];
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", chunk => {
            for (const line of String(chunk).split(/\r?\n/)) {
                if (line.trim()) {
                    stderr.push(line.trim());
                }
            }
            stderr.splice(0, Math.max(0, stderr.length - 40));
        });
        child.on("error", error => stderr.push(`spawn failed: ${error.message}`));
        if (!child.pid) {
            server.close();
            throw new Error(`Could not start ${browser.path}.`);
        }
        this.current = {
            server,
            child,
            pid: child.pid,
            port,
            url,
            browser,
            profileDir,
            startedAt: new Date().toISOString(),
            stderr
        };
        this.persist();

        const bridgeConnected = await this.waitForBridge(options.waitForBridgeMs ?? 45_000, launchedAt);
        if (!bridgeConnected) {
            const note =
                `The browser is up at ${url} but nothing has polled the live bridge on port ${liveBridge.port} within ` +
                `${options.waitForBridgeMs ?? 45_000}ms, which a cold browser can need. The session is left running: ` +
                `live_session {"action":"boot"} walks it into a new game as soon as it reports, and {"action":"status"} says ` +
                `whether it has.` +
                (pluginHint ? ` ${pluginHint}` : " The plugin is enabled with this server's token, so if it stays quiet the page itself is not running.");
            return { session: this.report()!, bridgeConnected, boot: { scenes: [], final: "not started", note } };
        }
        // A page in a headless browser is not focused, and MZ only updates the
        // scene when document.hasFocus() is true, so keepAwake has to be on for the
        // game to actually run. Report it instead of letting the caller guess why
        // nothing moves.
        const focusedWarning =
            (this.bridgeView().state as any).focused === false
                ? "The engine reports the page is not focused, so scene updates are skipped: set the bridge plugin's keepAwake parameter to true."
                : undefined;
        const boot = options.newGame === false ? { scenes: [], final: "on the title screen" } : await this.walkToMap(options.bootMs ?? 45_000);
        const note = [focusedWarning, staleSweep].filter(Boolean).join(" ") || undefined;
        return {
            session: this.report()!,
            bridgeConnected,
            boot: note ? { ...boot, note: [note, boot.note].filter(Boolean).join(" ") } : boot,
            note
        };
    }

    status(): { session: SessionReport | null; stale: unknown; bridge: SessionReport["bridge"]; note: string } {
        const session = this.report();
        const stale = session ? null : this.readStateFile();
        const bridge = this.bridgeView();
        const note = bridge.listenError
            ? `${bridge.listenError} No game can reach this server's bridge until the port is free.`
            : session
              ? bridge.ageMs === null
                  ? "The browser is running but the game has never polled the bridge."
                  : bridge.ageMs > 5000
                    ? "The bridge has gone quiet; the game page may have been closed or crashed."
                    : "Session is live."
              : stale
                ? `No session in this process; a record of ${stale.url} (pid ${stale.pid}) is on disk and that pid ${pidAlive(stale.pid) ? "is still running" : "is gone"}.`
                : "No session started from this server.";
        return { session, stale, bridge, note };
    }

    /**
     * Drive whatever the session's page is showing into a new game. Separate from
     * `start` because the walk can take half a minute and an MCP client may give a
     * tool call sixty seconds in total.
     */
    async boot(timeoutMs = 45_000): Promise<{ boot: StartResult["boot"]; session: SessionReport }> {
        if (!this.current) {
            throw new Error("No session is running. Start one with live_session {\"action\":\"start\"}.");
        }
        return { boot: await this.walkToMap(timeoutMs), session: this.report()! };
    }

    /** Reload the page, which is what a newly written plugin file needs. */
    async reload(options: { newGame?: boolean; waitForBridgeMs?: number } = {}): Promise<{ reloaded: boolean; boot: StartResult["boot"]; session: SessionReport }> {
        if (!this.current) {
            throw new Error("No session to reload. Start one with live_session {\"action\":\"start\"}.");
        }
        const polled = liveBridge.status();
        const polledBefore = polled.lastSeenAt ?? 0;
        const frameBefore = Number((polled.state as any)?.frame ?? 0);
        const answer = await liveBridge.send({ type: "eval", code: "location.reload(); \"reloading\"" }, 8000);
        if (!answer.ok) {
            throw new Error(`The game would not reload its page: ${answer.error ?? "eval refused"}. Allow Eval has to be on.`);
        }
        // The reload takes the page back to the splash and title, so wait for the new
        // page's first poll — the old one gets a poll in on its way out, which is why
        // the frame counter has to have started over — and walk it to a map again.
        const reloaded = await this.waitForBridge(options.waitForBridgeMs ?? 30_000, polledBefore + 1, {
            page: String((polled.state as any)?.page ?? ""),
            belowFrame: frameBefore
        });
        const boot = options.newGame === false || !reloaded ? { scenes: [], final: "on the title screen" } : await this.walkToMap(45_000);
        return { reloaded, boot, session: this.report()! };
    }

    /** Until the bridge has gone quiet, which is how a caller knows the page it
     *  just killed is really finished reporting. */
    private async waitForQuiet(timeoutMs: number): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const age = liveBridge.status().ageMs;
            if (age === null || age > 3000) {
                return true;
            }
            await new Promise(done => setTimeout(done, 400));
        }
        return false;
    }

    async stop(): Promise<{
        stopped: { pid: number; how: string; killed: boolean; note: string; remaining: number[] } | null;
        profileDirRemoved: boolean;
        wentQuiet: boolean;
        bridge: SessionReport["bridge"];
        note: string;
    }> {
        const target = this.current ? { pid: this.current.pid, profileDir: this.current.profileDir } : this.readStateFile();
        if (!target) {
            const age = liveBridge.status().ageMs;
            return {
                stopped: null,
                profileDirRemoved: false,
                wentQuiet: age === null || age > 3000,
                bridge: this.bridgeView(),
                note: "There is no session, running or recorded."
            };
        }
        const outcome = await killTree(target.pid, target.profileDir);
        if (this.current) {
            const server = this.current.server;
            this.current = null;
            await new Promise<void>(done => server.close(() => done()));
        }
        this.clearStateFile();
        // A renderer process outlives its browser by a moment and can get one more
        // report in, so stop does not return until the bridge has gone quiet: a
        // caller that starts again right after must not read that as a live game.
        const wentQuiet = await this.waitForQuiet(8000);
        this.stoppedAt = Date.now();
        liveBridge.noteStopped();
        // Files a killed browser still holds open are left behind rather than turned
        // into a failure: the browser is gone and the port is released either way.
        const profileDirRemoved = removeDirectory(target.profileDir);
        const note = outcome.killed
            ? `The browser is gone and the game server port is released.${profileDirRemoved ? "" : " The browser profile directory is still locked and was left for the next start to remove."}${
                  wentQuiet ? "" : " Something is still polling the bridge, so it is not this browser."
              }`
            : "Nothing was killed. If the browser really is gone, this record was stale and it has been cleared.";
        return { stopped: { pid: target.pid, how: "headless browser tree", ...outcome }, profileDirRemoved, wentQuiet, bridge: this.bridgeView(), note };
    }
}

export { PlaytestSession };
