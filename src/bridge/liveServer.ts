import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface LiveCommand {
    id: string;
    type: "eval" | "state" | "reload" | "screenshot" | "diagnostics" | "pause" | "step" | "key" | "move";
    code?: string;
    since?: number;
    limit?: number;
    clear?: boolean;
    full?: boolean;
    paused?: boolean;
    frames?: number;
    /** live_key: which key, how long each press is held, how many times. */
    keyCode?: number;
    button?: string;
    holdFrames?: number;
    pulses?: number;
    gapMs?: number;
    /** live_move: the arrow to hold and how many cells to arrive. */
    direction?: number;
    cells?: number;
    /** How long the game may take over a key or a walk before it says so. */
    timeoutMs?: number;
}

export interface LiveResult {
    id: string;
    ok: boolean;
    value?: unknown;
    error?: string;
}

export interface LiveStatus {
    /** That *this* process owns the port: the socket reported `listening`. Another
     *  copy of the server answering the same port is a `listenError` here, not a true. */
    listening: boolean;
    host: string;
    port: number;
    tokenConfigured: boolean;
    lastSeenAt: number | null;
    ageMs: number | null;
    listenError: string | null;
    state: any | null;
    /** Every document that has polled since the server started, so two games on one
     *  port is visible instead of silently stealing each other's commands. */
    pollers: { page: string; seenAt: number; scene: string; frame: number }[];
    /** The page commands are delivered to, once a session has claimed one. */
    targetPage: string | null;
    /** Frames per second measured from the plugin's own reports, or null while the
     *  reports have not yet covered a whole frame. Everything timed in engine frames
     *  converts with this. */
    measuredFps: number | null;
    /** The page that reports are coming from has not advanced a frame. Its tab is
     *  hidden or its game is paused, so `live_key` and `live_wait` cannot work. */
    stalled: boolean;
    /** Why the game's polls were turned away, and how many were. Without this a
     *  token mismatch reads as a healthy `live_status` over commands that never ran. */
    authError: string | null;
    rejectedPolls: number;
}

interface Waiter {
    resolve: (result: LiveResult) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

/** A queued command carries who it was handed to: popping it on the poll that
 *  received it would lose the command outright whenever that response never comes
 *  back, and the caller would only ever see a timeout. */
interface QueuedCommand extends LiveCommand {
    deliveredTo?: string | null;
    deliveredAt?: number;
}

const HOST = "127.0.0.1";

/** Re-send a command the target page has not answered after this long. The plugin
 *  polls on its own timer, so one missed response must not stall the queue. */
const REDELIVER_MS = 2500;

/** How far back the frame-rate measurement looks. Shorter than this and a page that polls
 *  faster than it draws cannot be measured at all. */
const FPS_WINDOW_MS = 1500;

/**
 * Browsers block the plugin's cross-port POST unless the page origin is granted
 * here. A playtest run in a browser is a normal workflow, so loopback origins are
 * accepted; anything else is not.
 */
function allowedOrigin(origin: string | undefined): string | null {
    if (!origin) {
        return null;
    }
    return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) || origin === "null" ? origin : null;
}

function corsHeaders(origin: string | undefined): Record<string, string> {
    const allowed = allowedOrigin(origin);
    return allowed
        ? {
              "access-control-allow-origin": allowed,
              "access-control-allow-headers": "content-type, x-rmmz-token",
              "access-control-allow-methods": "POST, GET, OPTIONS",
              "access-control-max-age": "600"
          }
        : {};
}

/**
 * Local HTTP endpoint that the RMMZLiveBridge game plugin polls. The game is the
 * client, which keeps this side free of any WebSocket implementation and means
 * an unreachable server never blocks playtesting.
 */
class LiveBridge {
    private server: Server | null = null;
    /** True only once the socket has reported `listening` for this process. */
    private listening = false;
    private listenError: string | null = null;
    private lastAttemptAt = 0;
    private lastState: { payload: unknown; seenAt: number } | null = null;
    private pages = new Map<string, { seenAt: number; scene: string; frame: number }>();
    private targetPage: string | null = null;
    private queue: QueuedCommand[] = [];
    private waiters = new Map<string, Waiter>();
    private counter = 0;
    /** The command the page is working on. One at a time: results come back on a
     *  different request than the poll that carried the command, so handing out the
     *  next command on the next poll lets two expressions run interleaved in the game,
     *  and an agent that wrote a variable in one and read it in the other gets the
     *  reads before the writes. */
    private inFlight: { id: string; page: string; at: number } | null = null;
    private recent: { frame: number; at: number }[] = [];
    private measuredFps: number | null = null;
    private stalled = false;
    private rejectedPolls = 0;
    private lastRejectedAt = 0;
    private rejectedPage = "";
    readonly port = Number(process.env["RMMZ_LIVE_PORT"] || 3789);
    readonly token = process.env["RMMZ_LIVE_TOKEN"] ?? randomBytes(12).toString("hex");

    /**
     * Start listening, and do not answer until the bind has either happened or
     * failed. `listening` is a claim about *this* process, and the old code made it
     * before `listen()` had reported anything back: a port two copies of this server
     * fight over therefore read as healthy on the one call an agent looks at first,
     * and the EADDRINUSE only surfaced on the first command sent. Retried on the next
     * call rather than latched forever, because the other window may quit.
     */
    async ensure(): Promise<void> {
        if (this.listening) {
            return;
        }
        if (this.listenError && Date.now() - this.lastAttemptAt < 1000) {
            return;
        }
        this.lastAttemptAt = Date.now();
        this.listenError = null;
        const server = createServer((request, response) => {
            this.handle(request, response).catch(() => {
                response.writeHead(500).end("{}");
            });
        });
        server.on("error", error => {
            if (this.server !== server) {
                return;
            }
            this.server = null;
            this.listenError = `Live bridge could not listen on ${HOST}:${this.port}: ${(error as Error).message}. Another process has that port, most likely another copy of this server.`;
        });
        this.server = server;
        const bound = new Promise<void>(resolve => {
            server.once("listening", () => {
                if (this.server === server) {
                    this.listening = true;
                }
                resolve();
            });
        });
        server.listen(this.port, HOST);
        // A bind that has not reported in two seconds is not going to, and a live_status
        // that hangs is worse than one that says the port is not provably ours.
        await Promise.race([bound, new Promise<void>(resolve => setTimeout(resolve, 2000))]);
        if (!this.listening && !this.listenError) {
            this.listenError = `Live bridge is not listening on ${HOST}:${this.port}: the bind had not reported within 2s.`;
            this.server = null;
        }
    }

    /** Which document the live tools are talking to, once a session knows it. */
    claimPage(page: string | null): void {
        this.targetPage = page;
        this.inFlight = null;
    }

    /**
     * Forget the page this process was driving. Without it a stopped session would
     * keep a claim on a document id that no longer exists, and the next playtest -
     * this tool's own or a human's in the editor - would poll a bridge that hands out
     * no commands to it.
     */
    noteStopped(): void {
        this.targetPage = null;
        this.inFlight = null;
        this.pages.clear();
        this.recent = [];
        this.measuredFps = null;
        this.stalled = false;
    }

    status(): LiveStatus {
        return {
            listening: this.listening,
            host: HOST,
            port: this.port,
            tokenConfigured: Boolean(process.env["RMMZ_LIVE_TOKEN"]),
            lastSeenAt: this.lastState?.seenAt ?? null,
            ageMs: this.lastState ? Date.now() - this.lastState.seenAt : null,
            listenError: this.listenError,
            state: this.lastState?.payload ?? null,
            pollers: [...this.pages.entries()].map(([page, entry]) => ({ page, ...entry })).sort((a, b) => b.seenAt - a.seenAt),
            targetPage: this.targetPage,
            measuredFps: this.measuredFps,
            stalled: this.stalled,
            authError: this.authHint(),
            rejectedPolls: this.rejectedPolls
        };
    }

    /**
     * Why a page on this port is being turned away, for the last few seconds only: a
     * token mismatch is otherwise invisible, because the state it pushes is refused and
     * the commands it never receives just time out somewhere else.
     */
    authHint(): string | null {
        if (!process.env["RMMZ_LIVE_TOKEN"]) {
            return "no RMMZ_LIVE_TOKEN is configured, so commands cannot be authenticated and none are delivered";
        }
        if (this.lastRejectedAt && Date.now() - this.lastRejectedAt < 5000) {
            return `a page ("${this.rejectedPage}") polled the bridge in the last 5s with a missing or wrong x-rmmz-token, so its commands are refused`;
        }
        return null;
    }

    /** Frames per second measured from the reports, or null until one has landed.
     *  `live_key` sizes its hold and its timeout with this instead of guessing 60. */
    frameRate(): number | null {
        return this.measuredFps;
    }

    private authorized(request: IncomingMessage): boolean {
        if (!process.env["RMMZ_LIVE_TOKEN"]) {
            // Without a configured token the plugin cannot authenticate, so nothing it
            // sends back can be trusted enough to act on. State is still recorded, so
            // `live_status` works out of the box for a read-only look.
            return false;
        }
        return request.headers["x-rmmz-token"] === this.token;
    }

    private async readJson(request: IncomingMessage, limitBytes: number): Promise<any> {
        const chunks: Buffer[] = [];
        let size = 0;
        let overflow = false;
        // Drain the whole body even past the limit: throwing mid-stream leaves the
        // socket half-read, and the game's XHR then sees a connection error rather
        // than the answer, which is the wrong diagnosis for an oversized screenshot.
        for await (const chunk of request) {
            size += chunk.length;
            if (!overflow && size <= limitBytes) {
                chunks.push(chunk as Buffer);
            } else if (!overflow) {
                overflow = true;
            }
        }
        if (overflow) {
            throw new Error(`payload of ${size} bytes is over the ${limitBytes} byte limit`);
        }
        return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    }

    private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const url = request.url ?? "";
        const cors = corsHeaders(request.headers.origin);
        if (request.method === "OPTIONS") {
            response.writeHead(204, cors).end();
            return;
        }
        if (request.method === "GET" && url === "/health") {
            response.writeHead(200, { "content-type": "application/json", ...cors });
            response.end(JSON.stringify({ ok: true, waiting: this.queue.length }));
            return;
        }
        if (request.method !== "POST") {
            response.writeHead(405, cors).end();
            return;
        }
        // A screenshot is a base64 PNG travelling through this same door, so the
        // result route needs room; a state poll never does.
        const limit = url === "/result" ? 48_000_000 : 2_000_000;
        let payload: any;
        try {
            payload = await this.readJson(request, limit);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            response.writeHead(200, { "content-type": "application/json", ...cors }).end(JSON.stringify({ ok: false, error: message }));
            return;
        }
        // State used to be accepted from anyone on loopback, which meant any local
        // process could dress `live_status` up as a game that does not exist. Once a
        // token is configured every route needs it, and the answer says so instead of
        // the caller finding out by watching commands never run.
        const authed = this.authorized(request);
        if (process.env["RMMZ_LIVE_TOKEN"] && !authed) {
            this.rejectedPolls++;
            this.lastRejectedAt = Date.now();
            this.rejectedPage = typeof payload?.page === "string" ? payload.page : "unknown-page";
            response.writeHead(401, { "content-type": "application/json", ...cors }).end(JSON.stringify({ ok: false, error: "x-rmmz-token is missing or wrong" }));
            return;
        }
        if (url === "/state") {
            const page = typeof payload?.page === "string" ? payload.page : "unknown-page";
            this.pages.set(page, { seenAt: Date.now(), scene: String(payload?.scene ?? ""), frame: Number(payload?.frame ?? 0) });
            this.noteReport(payload);
            this.lastState = { payload, seenAt: Date.now() };
            const command = authed ? this.takeCommandFor(page) : null;
            response.writeHead(200, { "content-type": "application/json", ...cors });
            response.end(JSON.stringify({ command }));
            return;
        }
        if (url === "/result") {
            const result = payload as LiveResult;
            const waiter = this.waiters.get(result.id);
            if (waiter) {
                this.waiters.delete(result.id);
                clearTimeout(waiter.timer);
                this.queue = this.queue.filter(item => item.id !== result.id);
                if (this.inFlight?.id === result.id) {
                    this.inFlight = null;
                }
                waiter.resolve(result);
            }
            response.writeHead(200, { "content-type": "application/json", ...cors });
            response.end(JSON.stringify({ ok: true }));
            return;
        }
        response.writeHead(404, cors).end();
    }

    /**
     * The plugin's reports carry `Graphics.frameCount`, so the frame numbers over a
     * window of them measure the real frame rate without an extra round trip. Two
     * adjacent reports are not enough: polls land on whatever moment they happen, so a
     * 9fps game polled every 40ms reads as 25fps half the time. The window is a
     * second and a half, which also says when a page has stopped advancing frames at
     * all - a hidden tab or a paused game, where every timed tool would otherwise end
     * in a bare timeout.
     */
    private noteReport(payload: any): void {
        const frame = Number(payload?.frame ?? 0);
        const now = Date.now();
        this.recent.push({ frame, at: now });
        // Drop the oldest sample only while the one behind it still spans the window:
        // pruning to "everything inside the window" leaves a span shorter than the
        // window, which never satisfies the lookback below and freezes the number.
        while (this.recent.length > 2 && now - this.recent[1].at > FPS_WINDOW_MS) {
            this.recent.shift();
        }
        const oldest = this.recent[0];
        if (this.recent.length < 2 || now - oldest.at < FPS_WINDOW_MS) {
            return;
        }
        const advanced = frame - oldest.frame;
        if (advanced > 0) {
            this.measuredFps = Math.round(((advanced * 1000) / (now - oldest.at)) * 100) / 100;
            this.stalled = false;
        } else {
            this.stalled = true;
        }
    }

    /**
     * The next command this page should run. Once a session has claimed a page, that
     * page is the only one that may receive commands: a second game polling the same
     * port with the same token would otherwise answer for a game nobody is watching,
     * and every live tool would report its numbers with no hint that it is not the
     * playtest the tools launched.
     */
    private takeCommandFor(page: string): QueuedCommand | null {
        if (this.targetPage && page !== this.targetPage) {
            return null;
        }
        const now = Date.now();
        if (this.inFlight) {
            if (this.inFlight.page !== page) {
                // Something is already running in another document; a second command
                // landing there while the first is unresolved is the ordering loss this
                // gate exists to stop.
                return null;
            }
            if (now - this.inFlight.at < REDELIVER_MS) {
                return null;
            }
            const stuck = this.queue.find(item => item.id === this.inFlight!.id);
            if (stuck) {
                this.inFlight = { id: stuck.id, page, at: now };
                stuck.deliveredAt = now;
                return stuck;
            }
            this.inFlight = null;
        }
        for (const item of this.queue) {
            if (!item.deliveredTo) {
                item.deliveredTo = page;
                item.deliveredAt = now;
                this.inFlight = { id: item.id, page, at: now };
                return item;
            }
            if (item.deliveredTo === page && now - (item.deliveredAt ?? 0) > REDELIVER_MS) {
                item.deliveredAt = now;
                this.inFlight = { id: item.id, page, at: now };
                return item;
            }
        }
        return null;
    }

    /**
     * Queue a command for the running game and wait for its result. The command
     * is only delivered when the plugin presents the shared token.
     */
    async send(command: Omit<LiveCommand, "id">, timeoutMs = 8000): Promise<LiveResult> {
        await this.ensure();
        if (this.listenError) {
            throw new Error(this.listenError);
        }
        if (!process.env["RMMZ_LIVE_TOKEN"]) {
            return Promise.reject(
                new Error(
                    "No shared token configured. Set RMMZ_LIVE_TOKEN for the MCP server and give the same value " +
                        "to the RMMZLiveBridge plugin's `token` parameter."
                )
            );
        }
        const id = `cmd-${++this.counter}-${Date.now()}`;
        return new Promise<LiveResult>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiters.delete(id);
                this.queue = this.queue.filter(item => item.id !== id);
                if (this.inFlight?.id === id) {
                    this.inFlight = null;
                }
                const pages = [...this.pages.entries()].map(([page, entry]) => `${page} (${Math.round((Date.now() - entry.seenAt) / 1000)}s ago, ${entry.scene})`);
                const why = this.stalled
                    ? " The page is reporting but not advancing a frame, so it is hidden, background-throttled or paused - a session started with live_session is what fixes that."
                    : this.authHint()
                      ? ` ${this.authHint()}.`
                      : "";
                reject(
                    new Error(
                        `No answer from the running game within ${timeoutMs}ms.` +
                            (pages.length
                                ? ` ${this.targetPage ? `The page this session drives is ${this.targetPage}; polling: ${pages.join(", ")}.` : `Polling the bridge: ${pages.join(", ")}.`}${why}`
                                : " Is it in playtest with RMMZLiveBridge enabled?")
                    )
                );
            }, timeoutMs);
            this.waiters.set(id, { resolve, reject, timer });
            this.queue.push({ ...command, id, deliveredTo: null, deliveredAt: 0 });
        });
    }

    async close(): Promise<void> {
        for (const waiter of this.waiters.values()) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error("server closing"));
        }
        this.waiters.clear();
        await new Promise<void>(resolve => {
            if (!this.server) {
                resolve();
                return;
            }
            // A playtest page polls this socket every few frames and keeps the
            // connection alive, so `close()` alone waits for a client that is still
            // there on purpose.
            this.server.closeAllConnections?.();
            this.server.close(() => resolve());
        });
        this.server = null;
        this.listening = false;
    }
}

export const liveBridge = new LiveBridge();
