import nodeTest from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { testWork } from "../bin/local-config.js";
import { createService } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const engine = process.env.RPG_MCP_ENGINE;
const test = (name, callback) => nodeTest(name, {
  skip: !engine ? "Local integration test: set RPG_MCP_ENGINE to a licensed MZ installation." : false
}, callback);

async function session() {
  await fs.mkdir(testWork, { recursive: true });
  const root = await fs.mkdtemp(path.join(testWork, "mz-surface-"));
  const template = path.join(engine, "data", "newdata");
  await fs.mkdir(path.join(root, "data"));
  for (const file of ["System.json", "MapInfos.json", "Tilesets.json", "Map001.json"])
    await fs.copyFile(path.join(template, "data", file), path.join(root, "data", file));
  const mapPath = path.join(root, "data", "Map001.json");
  const map = JSON.parse(await fs.readFile(mapPath, "utf8"));
  map.data.fill(0); map.events = [null];
  await fs.writeFile(mapPath, JSON.stringify(map));
  const service = await createService({ projectPath: root, enginePath: engine, port: 0 });
  const client = new Client({ name: "surface-test", version: "1.0.0" });
  const [mine, theirs] = InMemoryTransport.createLinkedPair();
  await service.server.connect(mine);
  await client.connect(theirs);
  // Tool results are JSON text on success and a human-readable failure report on error.
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    const text = response.content?.[0]?.text ?? "";
    let value = null;
    try { value = JSON.parse(text); } catch { /* an error report is not JSON */ }
    return { error: Boolean(response.isError), text, value };
  };
  const open = async () => (await call("open_editor", { mapId: 1, awaitVisible: false })).value.editorId;
  return { client, call, open, close: async () => { await client.close(); await service.close(); } };
}

test("every advertised tool schema refuses unknown arguments instead of stripping them", async () => {
  const { client, call, open, close } = await session();
  try {
    const tools = (await client.listTools()).tools;
    const loose = tools.filter(tool => tool.inputSchema?.additionalProperties !== false).map(tool => tool.name);
    assert.deepEqual(loose, [], "these tools still accept unrecognized keys");
    const editorId = await open();
    const typo = await call("put_event", { editorId, x: 1, y: 1, name: "门", tileId: 42 });
    assert.equal(typo.error, true);
    assert.match(typo.text, /Unrecognized key/i);
    assert.match(typo.text, /tileId/);
  } finally { await close(); }
});

test("visual paint requires the tile's declared sheet and catalog reports active slots", async () => {
  const { call, close } = await session();
  try {
    const catalog = await call("tileset_catalog", { mapId: 1 });
    assert.equal(catalog.error, false, catalog.text);
    assert.equal(catalog.value.slots.length, 9);
    assert.ok(catalog.value.slots.some(slot => slot.sheet === "A2"));
    assert.match(catalog.value.visualLayers, /draw-order/);

    const original = await call("read_map", { mapId: 1 });
    const base = { mapId: 1, expectedRevision: original.value.revision, screenshot: false };
    const missing = await call("paint_tiles", { ...base,
      cells: [{ x: 1, y: 1, layer: 0, tileId: 2816 }] });
    assert.equal(missing.error, true);

    const mismatched = await call("paint_tiles", { ...base,
      cells: [{ x: 1, y: 1, layer: 0, tileId: 2816, expectedSheet: "A1" }] });
    assert.equal(mismatched.error, true);
    assert.match(mismatched.text, /belongs to sheet A2/);

    const correct = await call("paint_tiles", { ...base,
      cells: [{ x: 1, y: 1, layer: 0, tileId: 2816, expectedSheet: "A2" }] });
    assert.equal(correct.error, false, correct.text);

    const graphicAsShadow = await call("paint_tiles", {
      ...base, cells: [{ x: 1, y: 1, layer: 4, tileId: 2048 }]
    });
    assert.equal(graphicAsShadow.error, true);

    const largeRegionId = await call("paint_tiles", {
      ...base, cells: [{ x: 1, y: 1, layer: 5, tileId: 256 }]
    });
    assert.equal(largeRegionId.error, true);
  } finally { await close(); }
});

test("put_event generates a real 201 transfer and validates the destination cell", async () => {
  const { call, open, close } = await session();
  try {
    const editorId = await open();
    const created = await call("put_event", { editorId, x: 3, y: 4, name: "酒馆门",
      transfer: { mapId: 1, x: 6, y: 7, direction: 2 } });
    assert.equal(created.error, false, created.text);
    assert.equal(created.value.changed, true);
    const read = await call("read_map", { mapId: 1 });
    const event = read.value.events.find(item => item?.name === "酒馆门");
    assert.deepEqual(event.pages[0].list[0], { code: 201, indent: 0, parameters: [0, 1, 6, 7, 2, 0] });
    const outside = await call("put_event", { editorId, x: 5, y: 5, name: "坏门", transfer: { mapId: 1, x: 999, y: 999 } });
    assert.equal(outside.error, true);
  } finally { await close(); }
});
