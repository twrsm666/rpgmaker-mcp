import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { copyTestProject } from "./test-project.js";
import { requiredEngine } from "./local-config.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceProject = process.env.RPG_MCP_PROJECT || path.join(root, "demo-project");
const projectPath = await copyTestProject(sourceProject, "integration");
const enginePath = requiredEngine();
const client = new Client({ name: "mz-bridge-verification", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath, args: [path.join(root, "src", "server.js"), "--project", projectPath, "--engine", enginePath],
  stderr: "pipe"
});
const results = [];
const images = path.join(root, "verification");
await fs.mkdir(images, { recursive: true });
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  results.push({ tool: name, success: true });
  return result;
};
const saveImage = async (result, filename) => {
  const image = result.content.find(c => c.type === "image");
  assert.ok(image, "Tool must return an image");
  const buffer = Buffer.from(image.data, "base64");
  assert.equal(buffer.subarray(1, 4).toString(), "PNG");
  await fs.writeFile(path.join(images, filename), buffer);
};
const text = result => JSON.parse(result.content.find(c => c.type === "text").text);
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.length >= 15);
  await call("project_info", {});
  await call("list_maps", {});
  const initial = text(await call("read_map", { mapId: 1 }));
  await saveImage(await call("tile_palette", { mapId: 1, sheet: "A3" }), "palette-a3.png");
  await saveImage(await call("tile_palette", { mapId: 1, sheet: "A2" }), "palette-a2.png");
  await saveImage(await call("tile_palette", { mapId: 1, sheet: "C" }), "palette-c.png");
  await saveImage(await call("tile_palette", { mapId: 1, sheet: "B", start: 0, count: 128 }), "palette-b.png");
  await saveImage(await call("render_map", { mapId: 1, scale: .75, grid: true }), "map-before.png");
  const edit = await call("paint_tiles", { mapId: 1, expectedRevision: initial.revision,
    cells: [{ x: 16, y: 18, layer: 5, tileId: 7 }], screenshot: true });
  await saveImage(edit, "map-after.png");
  const revision = text(edit).revision;
  const detail = text(await call("inspect_cell", { mapId: 1, x: 16, y: 18 }));
  assert.equal(detail.region, 7);
  const conflict = await client.callTool({ name: "paint_tiles", arguments: { mapId: 1, expectedRevision: initial.revision,
    cells: [{ x: 16, y: 18, layer: 5, tileId: 8 }] } });
  assert.equal(conflict.isError, true);
  results.push({ test: "stale revision rejected", success: true });
  await saveImage(await call("render_map", { mapId: 1, region: { x: 4, y: 5, width: 12, height: 12 }, scale: 1.5 }), "detail.png");
  await call("analyze_map", { mapId: 1, from: { x: 14, y: 16 }, to: { x: 18, y: 16 } });
  await call("undo_map_edit", { mapId: 1, expectedRevision: revision, screenshot: false });
  const restored = text(await call("inspect_cell", { mapId: 1, x: 16, y: 18 }));
  assert.equal(restored.region, 0);
  results.push({ test: "undo restores original region", success: true });
  const building = text(await call("place_building", { mapId: 1, expectedRevision: restored.revision,
    area: { x: 2, y: 19, width: 4, height: 4 }, roofRows: 2, roofTileId: 4448, wallTileId: 4832,
    expectedRoofSheet: "A3", expectedWallSheet: "A3", screenshot: false }));
  assert.equal(building.changed, true, "Building test must produce a real change");
  const stamped = text(await call("stamp_region", { mapId: 1, expectedRevision: building.revision, sourceMapId: 1, sourceRevision: building.revision,
    source: { x: 2, y: 19, width: 4, height: 4 }, destination: { x: 23, y: 19 }, screenshot: false }));
  const event = text(await call("upsert_event", { mapId: 1, expectedRevision: stamped.revision, name: "验证事件", x: 12, y: 18,
    text: "MCP 事件创建测试", image: { characterName: "People1", characterIndex: 1 }, screenshot: false }));
  const inspected = text(await call("inspect_cell", { mapId: 1, x: 12, y: 18 }));
  assert.equal(inspected.events[0].pages[0].list[1].parameters[0], "MCP 事件创建测试");
  const deleted = text(await call("delete_event", { mapId: 1, expectedRevision: event.revision, eventId: event.eventId, screenshot: false }));
  let revisionToUndo = deleted.revision;
  for (let i = 0; i < 4; i++) revisionToUndo = text(await call("undo_map_edit", { mapId: 1, expectedRevision: revisionToUndo, screenshot: false })).revision;
  const final = text(await call("read_map", { mapId: 1 }));
  assert.deepEqual(final.events, initial.events);
  await call("edit_history", { mapId: 1 });
  await call("preview_focus", { mapId: 1, x: 15, y: 14 });
  await call("runtime_status", {});
  await fs.writeFile(path.join(images, "report.json"), JSON.stringify({ timestamp: new Date().toISOString(), isolatedProject: projectPath, toolCount: tools.tools.length, results }, null, 2));
  console.log(JSON.stringify({ toolCount: tools.tools.length, passed: results.length, screenshots: images }, null, 2));
} finally { await client.close(); }
