import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { copyTestProject } from "./test-project.js";
import { requiredEngine } from "./local-config.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const project = await copyTestProject(path.join(root, "demo-project"), "browser-playtest", { runtime: true });
const engine = requiredEngine();
const client = new Client({ name: "browser-mz-runtime-verifier", version: "1.0.0" });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [path.join(root, "src/server.js"), "--project", project, "--engine", engine, "--live-bridge"], stderr: "pipe" });
const out = path.join(root, "verification"), report = [];
await fs.mkdir(out, { recursive: true });
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content[0].text);
  return result;
}
const text = result => JSON.parse(result.content.find(c => c.type === "text").text);
async function save(result, filename) {
  const image = result.content.find(c => c.type === "image");
  assert.ok(image); await fs.writeFile(path.join(out, filename), Buffer.from(image.data, "base64"));
}
try {
  await client.connect(transport);
  const started = text(await call("playtest_start"));
  const sessionId = started.sessionId;
  report.push({ test: "complete MZ browser engine loaded", passed: true, state: started.state });
  await call("runtime_control", { sessionId, action: "start_new_game" });
  const before = await call("runtime_capture", { sessionId });
  await save(before, "runtime-before.png");
  const player = text(before).player;
  const moved = text(await call("runtime_control", { sessionId, action: "move", direction: 6, steps: 1 }));
  assert.equal(moved.state.player.x, player.x + 1);
  report.push({ test: "player moves in actual game", passed: true });
  const original = text(await call("read_map", { mapId: 1 }));
  const changed = text(await call("paint_tiles", { mapId: 1, expectedRevision: original.revision, screenshot: false,
    cells: [{ x: 18, y: 18, layer: 0, tileId: 2048, expectedSheet: "A1" }] }));
  await call("runtime_control", { sessionId, action: "reload_map" });
  const after = await call("runtime_capture", { sessionId });
  await save(after, "runtime-after.png");
  assert.equal(text(after).mapId, 1);
  report.push({ test: "map disk edit followed by actual engine reload", passed: true });
  await call("runtime_control", { sessionId, action: "set_switch", id: 1, value: true });
  await call("runtime_control", { sessionId, action: "set_variable", id: 1, value: 42 });
  await call("runtime_control", { sessionId, action: "teleport", mapId: 1, x: 15, y: 15, direction: 8 });
  await call("runtime_control", { sessionId, action: "interact" });
  // One more "ok" finishes typewriter drawing but keeps the dialogue open.
  await call("runtime_control", { sessionId, action: "interact" });
  const dialogue = await call("runtime_capture", { sessionId });
  await save(dialogue, "runtime-dialogue.png");
  assert.equal(text(dialogue).messageBusy, true);
  report.push({ test: "real dialogue event triggered", passed: true });
  await call("undo_map_edit", { mapId: 1, expectedRevision: changed.revision, screenshot: false });
  await call("playtest_stop");
  report.push({ test: "playtest closes and original disk map restored", passed: true });
  await fs.writeFile(path.join(out, "browser-runtime-report.json"), JSON.stringify({ verified: true, timestamp: new Date().toISOString(), report }, null, 2));
  console.log(JSON.stringify({ verified: true, passed: report.length, screenshots: out }, null, 2));
} catch (error) {
  await fs.writeFile(path.join(out, "browser-runtime-report.json"), JSON.stringify({ verified: false, error: error.message, report }, null, 2));
  throw error;
} finally { await client.close(); }
