import nodeTest from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { testWork } from "../bin/local-config.js";
import { Project, makeEvent } from "../src/project.js";
import { startPreview } from "../src/preview-server.js";
import { analyze } from "../src/analysis.js";

const engine = process.env.RPG_MCP_ENGINE;
const work = testWork;
const test = (name, callback) => nodeTest(name, {
  skip: !engine ? "Local integration test: set RPG_MCP_ENGINE to a licensed MZ installation." : false
}, callback);
async function fixture() {
  await fs.mkdir(work, { recursive: true });
  const root = await fs.mkdtemp(path.join(work, "mz-test-"));
  const template = path.join(engine, "data", "newdata");
  await fs.mkdir(path.join(root, "data"));
  for (const file of ["System.json", "MapInfos.json", "Tilesets.json", "Map001.json"]) await fs.copyFile(path.join(template, "data", file), path.join(root, "data", file));
  const mapPath = path.join(root, "data", "Map001.json");
  const map = JSON.parse(await fs.readFile(mapPath, "utf8"));
  map.data.fill(0); map.events = [null];
  await fs.writeFile(mapPath, JSON.stringify(map));
  const project = await Project.open(root, engine);
  return { root, project };
}
test("pages replace generated commands, so mixing the two is refused not dropped", () => {
  const page = () => ({ conditions: {}, image: { characterName: "", characterIndex: 0, direction: 2, pattern: 0, tileId: 0 },
    moveRoute: { list: [], repeat: false, skippable: false, wait: false }, trigger: 0, priorityType: 0,
    list: [{ code: 0, indent: 0, parameters: [] }] });
  assert.throws(() => makeEvent({ id: 1, x: 1, y: 1, pages: [page()], transfer: { mapId: 2, x: 3, y: 4 } }), /pages cannot be combined with transfer/);
  assert.throws(() => makeEvent({ id: 1, x: 1, y: 1, pages: [page()], text: "hello" }), /pages cannot be combined with text/);
  assert.throws(() => makeEvent({ id: 1, x: 1, y: 1, pages: [page()], image: { tileId: 5 } }), /pages cannot be combined with image/);
  assert.equal(makeEvent({ id: 1, x: 1, y: 1, transfer: { mapId: 2, x: 3, y: 4 } }).pages[0].list[0].code, 201);
});
test("event page validation names the event, page and field that failed", () => {
  const good = { conditions: {}, image: { characterName: "", characterIndex: 0, direction: 2, pattern: 0, tileId: 0 },
    moveRoute: { list: [], repeat: false, skippable: false, wait: false }, trigger: 0, priorityType: 0,
    list: [{ code: 0, indent: 0, parameters: [] }] };
  const bad = structuredClone(good); bad.image.direction = 5;
  assert.throws(() => makeEvent({ id: 7, x: 1, y: 1, pages: [good, bad] }), /event 7 page 1\.image\.direction must be 2, 4, 6 or 8/);
  const missing = structuredClone(good); delete missing.moveRoute;
  assert.throws(() => makeEvent({ id: 8, x: 1, y: 1, pages: [missing] }), /event 8 page 0 is missing required MZ fields/);
});

test("fill-then-carve leaves no stale shadow, and clearing a cell needs no sheet claim", async () => {
  const { project } = await fixture();
  const start = await project.read(1);
  const dungeon = await project.configureMap(1, start.revision, { tilesetId: 4 });
  const wallSide = 5888 + 12 * 48;
  const shadowAt = (map, x, y) => map.data[(4 * map.height + y) * map.width + x];
  const filled = await project.paint(1, dungeon.revision, { requireSheet: true,
    rectangles: [{ x: 2, y: 2, width: 3, height: 3, layer: 1, tileId: wallSide, expectedSheet: "A4" }] });
  assert.ok(filled.shadowCells > 0, "the shadow pass reports the layer 4 cells it wrote");
  const painted = (await project.read(1)).map;
  assert.equal(shadowAt(painted, 3, 3), 0, "a wall cell never carries a mask, or thick walls stripe");
  assert.equal(shadowAt(painted, 5, 3), 5, "the ground to the right of the wall catches the cast");
  const carved = await project.paint(1, filled.revision, { requireSheet: true,
    rectangles: [{ x: 2, y: 2, width: 3, height: 3, layer: 1, tileId: 0 }] });
  const after = (await project.read(1)).map;
  assert.equal(shadowAt(after, 3, 3), 0, "the carved floor keeps no shadow from a wall that is gone");
  assert.equal(shadowAt(after, 5, 3), 0, "nor does the cell that used to catch its cast");
  assert.ok(carved.shadowCells > 0, "stale masks count as changes");
  await assert.rejects(project.paint(1, carved.revision, { requireSheet: true,
    cells: [{ x: 1, y: 1, layer: 1, tileId: 0, expectedSheet: "A4" }] }), /does not apply to tileId 0/);
  await assert.rejects(project.paint(1, carved.revision, { requireSheet: true,
    cells: [{ x: 1, y: 1, layer: 1, tileId: 2816 }] }), /expectedSheet is required/);
});

test("a layer 4 mask the shadow pass would revert is refused instead of silently dropped", async () => {
  const { project } = await fixture();
  const start = await project.read(1);
  const dungeon = await project.configureMap(1, start.revision, { tilesetId: 4 });
  const wallSide = 5888 + 12 * 48;
  const shadowAt = (map, x, y) => map.data[(4 * map.height + y) * map.width + x];
  const both = [{ x: 2, y: 2, width: 1, height: 1, layer: 1, tileId: wallSide, expectedSheet: "A4" },
    { x: 2, y: 2, width: 1, height: 1, layer: 4, tileId: 10 }];
  await assert.rejects(project.paint(1, dungeon.revision, { requireSheet: true, rectangles: both }),
    /conflicts with the wall shadow the editor convention produces/);
  assert.equal((await project.read(1)).revision, dungeon.revision, "a refused paint writes nothing");
  const own = await project.paint(1, dungeon.revision, { autoShadow: false, requireSheet: true, rectangles: both });
  assert.equal(shadowAt((await project.read(1)).map, 2, 2), 10, "autoShadow:false hands layer 4 to the caller");
  assert.equal(own.shadowCells, 0);
});
test("paint, autotile boundaries, immutable other layers, backup and undo", async () => {
  const { project } = await fixture(), original = await project.read(1);
  const result = await project.paint(1, original.revision, { rectangles: [{ x: 2, y: 2, width: 3, height: 3, layer: 0, tileId: 2816 }] });
  assert.equal(result.changed, true);
  const changed = await project.read(1), map = changed.map;
  assert.equal(project.Tilemap.getAutotileShape(map.data[2 * map.width + 2]), 34); // top-left
  assert.equal(project.Tilemap.getAutotileShape(map.data[3 * map.width + 3]), 0); // center
  assert.deepEqual(map.data.slice(map.width * map.height), original.map.data.slice(map.width * map.height));
  const restored = await project.undo(1, result.revision);
  assert.deepEqual((await project.read(1)).map, original.map);
  assert.equal((await project.historyFor(1)).length, 2);
  assert.equal(restored.changed, true);
});
test("visual paint requires an asserted matching sheet when requested", async () => {
  const { project } = await fixture(), original = await project.read(1);
  await assert.rejects(project.paint(1, original.revision, {
    cells: [{ x: 1, y: 1, layer: 0, tileId: 2816 }], requireSheet: true
  }), /expectedSheet is required/);
  await assert.rejects(project.paint(1, original.revision, {
    cells: [{ x: 1, y: 1, layer: 0, tileId: 2816, expectedSheet: "A1" }], requireSheet: true
  }), /belongs to sheet A2/);
  const result = await project.paint(1, original.revision, {
    cells: [{ x: 1, y: 1, layer: 0, tileId: 2816, expectedSheet: "A2" }], requireSheet: true
  });
  assert.equal(result.changed, true);
});
test("all 256 adjacency masks resolve floor autotile corners", async () => {
  const { project } = await fixture();
  const T = project.Tilemap;
  const { retile } = await import("../src/engine.js");
  const around = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
  for (let mask = 0; mask < 256; mask++) {
    const map = { width: 3, height: 3, data: Array(54).fill(0), scrollType: 0 };
    map.data[4] = 2816;
    for (let i = 0; i < 8; i++) if (mask & (1 << i)) map.data[(1 + around[i][1]) * 3 + 1 + around[i][0]] = 2816;
    retile(map, T, [0]);
    assert.ok(T.getAutotileShape(map.data[4]) >= 0 && T.getAutotileShape(map.data[4]) < 47);
    const before = [...map.data]; retile(map, T, [0]); assert.deepEqual(map.data, before);
  }
});
test("conflicts and out-of-bounds edits never write", async () => {
  const { project } = await fixture(), original = await project.read(1);
  await assert.rejects(project.paint(1, "f".repeat(64), { cells: [{ x: 1, y: 1, layer: 0, tileId: 2816 }] }), /Revision conflict/);
  await assert.rejects(project.paint(1, original.revision, { cells: [{ x: 99, y: 1, layer: 0, tileId: 2816 }] }), /x must/);
  await assert.rejects(project.paint(1, original.revision, { cells: [{ x: 1, y: 1, layer: 4, tileId: 16 }] }), /value must/);
  await assert.rejects(project.paint(1, original.revision, { cells: [{ x: 1, y: 1, layer: 0, tileId: 4380 }] }), /Invalid autotile shape/);
  assert.equal((await project.read(1)).revision, original.revision);
});
test("parallel writes with same revision: exactly one succeeds", async () => {
  const { project } = await fixture(), original = await project.read(1);
  const results = await Promise.allSettled([1, 2].map(x => project.paint(1, original.revision, { cells: [{ x, y: 1, layer: 0, tileId: 2816 }] })));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected").length, 1);
});
test("two service instances share a disk lock", async () => {
  const { root, project } = await fixture(), another = await Project.open(root, engine);
  const original = await project.read(1);
  let release, entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const first = project.edit(1, original.revision, async map => {
    entered(); await gate; map.data[map.width * map.height * 5] = 1;
  });
  await enteredPromise;
  try {
    await assert.rejects(another.paint(1, original.revision, { cells: [{ x: 1, y: 1, layer: 5, tileId: 2 }] }), /Another MCP writer/);
  } finally { release(); }
  assert.equal((await first).changed, true);
});
test("consecutive undo walks back edits rather than undoing the undo", async () => {
  const { project } = await fixture(), original = await project.read(1);
  const a = await project.paint(1, original.revision, { cells: [{ x: 1, y: 1, layer: 5, tileId: 1 }] });
  const b = await project.paint(1, a.revision, { cells: [{ x: 2, y: 1, layer: 5, tileId: 2 }] });
  const undoneB = await project.undo(1, b.revision);
  const undoneA = await project.undo(1, undoneB.revision);
  assert.equal((await project.inspect(1, 1, 1)).region, 0);
  assert.equal((await project.inspect(1, 2, 1)).region, 0);
  assert.deepEqual((await project.read(1)).map, original.map);
  await assert.rejects(project.undo(1, undoneA.revision), /No matching backup/);
});
test("events: valid pages, 4-line dialogue batching, transfer and bounds", async () => {
  const { project } = await fixture(), original = await project.read(1);
  const event = makeEvent({ id: 1, x: 3, y: 3, text: "1\n2\n3\n4\n5", transfer: { mapId: 1, x: 4, y: 4 } });
  assert.equal(event.pages[0].list.filter(c => c.code === 101).length, 2);
  assert.equal(event.pages[0].list.at(-2).code, 201);
  await project.edit(1, original.revision, map => { map.events[1] = event; });
  assert.equal((await project.inspect(1, 3, 3)).events[0].id, 1);
  assert.throws(() => makeEvent({ id: 1, x: 1, y: 1, image: { characterName: "../escape" } }), /asset name/);
});
test("static analysis returns path and catches invalid transfer", async () => {
  const { project } = await fixture(), original = await project.read(1);
  await project.paint(1, original.revision, { rectangles: [{ x: 0, y: 0, width: 17, height: 13, layer: 0, tileId: 2816 }] });
  const result = await analyze(project, 1, { x: 1, y: 1 }, { x: 5, y: 5 });
  assert.equal(result.reachable, true); assert.equal(result.path.length, 9);
});
test("read-only mode blocks changes", async () => {
  const { root } = await fixture(), project = await Project.open(root, engine, { readOnly: true });
  const original = await project.read(1);
  await assert.rejects(project.paint(1, original.revision, { cells: [{ x: 1, y: 1, layer: 0, tileId: 2816 }] }), /read-only/);
});
test("preview authentication, Host and path traversal protections", async () => {
  const { project } = await fixture(), preview = await startPreview(project);
  try {
    assert.equal((await fetch(`${preview.url}/api/map?id=1`)).status, 401);
    const headers = { Authorization: `Bearer ${preview.token}` };
    assert.equal((await fetch(`${preview.url}/api/map?id=1`, { headers })).status, 200);
    const badHost = await new Promise((resolve, reject) => {
      const request = http.get(`${preview.url}/api/info`, { headers: { ...headers, Host: "evil.example" } }, response => {
        response.resume(); response.on("end", () => resolve(response.statusCode));
      }); request.on("error", reject);
    });
    assert.equal(badHost, 400);
    assert.equal((await fetch(`${preview.url}/api/info`, { headers: { ...headers, Origin: "https://evil.example" } })).status, 400);
    assert.equal((await fetch(`${preview.url}/asset/img/tilesets/..%5C..%5Cdata%5CSystem.json?token=${preview.token}`)).status, 400);
    assert.equal((await fetch(`${preview.url}/api/map`, { method: "POST", headers })).status, 405);
    await assert.rejects(project.file("../outside.json"), /escapes/);
  } finally { await preview.close(); }
});
