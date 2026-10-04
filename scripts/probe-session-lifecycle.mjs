/**
 * Diagnostic: does live_session stop really leave nothing polling?
 * start -> report -> stop -> watch the bridge for late polls -> start again.
 * Run from the rpgmaker-mcp folder: node scripts/probe-session-lifecycle.mjs
 */
import { execSync } from "node:child_process";
import { PACKAGE_ROOT, liveToken, projectDir } from "./local-env.mjs";

const here = PACKAGE_ROOT;
const bridgePort = Number(process.env.PROBE_BRIDGE_PORT ?? 3795);
const gamePort = Number(process.env.PROBE_GAME_PORT ?? 8095);
const token = liveToken();
process.env.RMMZ_PROJECT = projectDir;
process.env.RMMZ_LIVE_TOKEN = token;
process.env.RMMZ_LIVE_PORT = String(bridgePort);

function ourBrowsers() {
    const out = execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='msedge.exe' OR Name='chrome.exe'\\" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"`,
        { encoding: "utf8", maxBuffer: 60_000_000 }
    );
    const rows = out.trim().startsWith("[") ? JSON.parse(out) : [JSON.parse(out)];
    return rows
        .filter(row => (row.CommandLine ?? "").includes("rpgmaker-mcp"))
        .map(row => ({ pid: row.ProcessId, ppid: row.ParentProcessId, type: /--type=(\w+)/.exec(row.CommandLine ?? "")?.[1] ?? "browser" }));
}

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { server } = await import("../dist/index.js");
const client = new Client({ name: "probe", version: "1.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(b);
await client.connect(a);

const call = async (name, args = {}, timeoutMs) => {
    const result = await client.callTool({ name, arguments: args }, undefined, timeoutMs ? { timeout: timeoutMs } : undefined);
    const text = result.content?.find(part => part.type === "text")?.text ?? "";
    if (result.isError) {
        return { error: JSON.parse(text).error };
    }
    try {
        return JSON.parse(text);
    } catch {
        return { text };
    }
};

console.log(`== bridge ${bridgePort}, game ${gamePort}; our browser processes before: ${ourBrowsers().length}`);
const started = await call("live_session", { action: "start", gamePort, newGame: false, waitForBridgeMs: 45_000 }, 90_000);
console.log(`== start -> error=${started.error ?? "none"} running=${started.session?.running} bridgeConnected=${started.bridgeConnected}`);
if (started.error) {
    process.exit(1);
}
const boot = await call("live_session", { action: "boot", bootMs: 60_000 }, 90_000);
console.log(`== boot -> final=${boot.boot?.final} map=${boot.boot?.map} error=${boot.error ?? ""}`);
const live = ourBrowsers();
console.log(`== running: ${live.length} processes (${live.map(p => `${p.pid}:${p.type}`).join(", ")})`);

const stopped = await call("live_session", { action: "stop" }, 60_000);
console.log(`== stop -> killed=${stopped.stopped?.killed} wentQuiet=${stopped.wentQuiet} remaining=${JSON.stringify(stopped.stopped?.remaining)}`);

let fresh = 0;
const frames = new Set();
for (let i = 0; i < 24; i++) {
    const status = await call("live_status");
    if (status.ageMs !== null && status.ageMs < 1200) {
        fresh++;
        frames.add(`${status.state?.page}:${status.state?.frame}`);
    }
    await new Promise(r => setTimeout(r, 500));
}
console.log(`== after stop: ${fresh}/24 samples were fresh, distinct page:frame = ${frames.size ? [...frames].join(" ") : "none"}`);
console.log(`== our browser processes after stop: ${ourBrowsers().length}`);

const again = await call("live_session", { action: "start", gamePort, newGame: false, waitForBridgeMs: 45_000 }, 90_000);
console.log(`== start again -> ${again.error ? `REFUSED: ${again.error}` : `ok running=${again.session?.running} connected=${again.bridgeConnected}`}`);
if (!again.error) {
    const final = await call("live_session", { action: "stop" }, 60_000);
    console.log(`== final stop -> killed=${final.stopped?.killed} wentQuiet=${final.wentQuiet}`);
}
console.log(`== our browser processes at exit: ${ourBrowsers().length}`);
await client.close();
process.exit(0);
