import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Project } from "../src/project.js";
import { copyTestProject } from "./test-project.js";
import { requiredEngine } from "./local-config.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const demo = await copyTestProject(path.join(root, "demo-project"), "runtime", { runtime: true });
const engine = requiredEngine();
const project = await Project.open(demo, engine);
const targetPlugin = await project.file("js/plugins/MZVisualBridge.js", true);
await fs.copyFile(path.join(root, "plugin", "MZVisualBridge.js"), targetPlugin);
const pluginsPath = await project.file("js/plugins.js");
const previousPlugins = await fs.readFile(pluginsPath);
// Only the generated demo is changed. Always restore the file after verification.
await fs.writeFile(pluginsPath, 'var $plugins = [{"name":"MZVisualBridge","status":true,"description":"Local MCP test bridge","parameters":{}}];\n');
const transport = new StdioClientTransport({
  command: process.execPath, args: [path.join(root, "src", "server.js"), "--project", demo, "--engine", engine, "--live-bridge"], stderr: "pipe"
});
const client = new Client({ name: "mz-runtime-verifier", version: "1.0.0" });
let nativeRuntime, profile, originalRevision, changedRevision;
const report = [];
async function tool(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content[0].text);
  return result;
}
const text = result => JSON.parse(result.content.find(c => c.type === "text").text);
const output = path.join(root, "verification");
await fs.mkdir(output, { recursive: true });
try {
  await client.connect(transport);
  const session = text(await tool("native_playtest_start", {}));
  nativeRuntime = { executable: session.executable, transport: session.transport };
  profile = session.profile;
  const sessionId = session.sessionId;
  report.push({ test: "local NW.js plugin connected", passed: true, state: session.state });
  const started = text(await tool("runtime_control", { sessionId, action: "start_new_game" }));
  assert.equal(started.state.mapId, 1);
  report.push({ test: "start new game through MCP", passed: true });
  const image = await tool("runtime_capture", { sessionId });
  await fs.writeFile(path.join(output, "native-runtime-before.png"), Buffer.from(image.content.find(c => c.type === "image").data, "base64"));
  const before = text(image).player;
  const moved = text(await tool("runtime_control", { sessionId, action: "move", direction: 6, steps: 1 }));
  assert.equal(moved.state.player.x, before.x + 1);
  report.push({ test: "move player through MCP", passed: true });
  const original = text(await tool("read_map", { mapId: 1 })); originalRevision = original.revision;
  const changed = text(await tool("paint_tiles", { mapId: 1, expectedRevision: originalRevision, screenshot: false,
    cells: [{ x: 18, y: 18, layer: 0, tileId: 2048, expectedSheet: "A1" }] }));
  changedRevision = changed.revision;
  await tool("runtime_control", { sessionId, action: "reload_map" });
  await tool("runtime_control", { sessionId, action: "set_switch", id: 1, value: true });
  await tool("runtime_control", { sessionId, action: "set_variable", id: 1, value: 42 });
  await tool("runtime_control", { sessionId, action: "teleport", mapId: 1, x: 18, y: 17 });
  const after = await tool("runtime_capture", { sessionId });
  await fs.writeFile(path.join(output, "native-runtime-after.png"), Buffer.from(after.content.find(c => c.type === "image").data, "base64"));
  report.push({ test: "disk edit and live map reload", passed: true });
  await tool("runtime_control", { sessionId, action: "teleport", mapId: 1, x: 15, y: 15, direction: 8 });
  await tool("runtime_control", { sessionId, action: "interact" });
  await tool("runtime_control", { sessionId, action: "interact" });
  const dialogue = await tool("runtime_capture", { sessionId });
  await fs.writeFile(path.join(output, "native-runtime-dialogue.png"), Buffer.from(dialogue.content.find(c => c.type === "image").data, "base64"));
  assert.equal(text(dialogue).messageBusy, true);
  report.push({ test: "native dialogue event triggered", passed: true });
  await tool("undo_map_edit", { mapId: 1, expectedRevision: changedRevision, screenshot: false });
  changedRevision = null;
  await tool("native_playtest_stop", {});
  report.push({ test: "native process tree closes via MCP", passed: true });
  await fs.writeFile(path.join(output, "runtime-report.json"), JSON.stringify({ timestamp: new Date().toISOString(), verified: true, nativeRuntime, profile, report }, null, 2));
  console.log(JSON.stringify({ verified: true, passed: report.length, screenshots: output }, null, 2));
} catch (error) {
  const log = profile ? await fs.readFile(path.join(profile, "nw.log"), "utf8").catch(() => "") : "";
  const usefulLog = log.split("\n").filter(line => /MZVisualBridge|CONSOLE|[Pp]ermission|[Uu]ncaught|SyntaxError/.test(line)).slice(-40);
  await fs.writeFile(path.join(output, "runtime-report.json"), JSON.stringify({ verified: false, error: error.message, nativeRuntime, profile, usefulLog, report }, null, 2));
  throw error;
} finally {
  if (changedRevision) await tool("undo_map_edit", { mapId: 1, expectedRevision: changedRevision, screenshot: false }).catch(() => {});
  await tool("native_playtest_stop", {}).catch(() => {});
  await client.close();
  await fs.writeFile(pluginsPath, previousPlugins);
}
