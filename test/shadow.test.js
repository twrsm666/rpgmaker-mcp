import nodeTest from "node:test";
import assert from "node:assert/strict";
import { loadTilemap, stampWallShadow } from "../src/engine.js";

const engine = process.env.RPG_MCP_ENGINE;
const test = (name, callback) => nodeTest(name, {
  skip: !engine ? "Local integration test: set RPG_MCP_ENGINE to a licensed MZ installation." : false
}, callback);

test("stampWallShadow mirrors the runtime/editor wall shadow quadrants", async () => {
  const { Tilemap } = await loadTilemap(process.cwd(), engine);
  const w = 4, h = 4;
  const data = new Array(5 * w * h).fill(0);
  const idx = (x, y, z) => (z * h + y) * w + x;
  const kind = k => 5888 + k * 48; // piece 0 of autotile kind k
  data[idx(1, 1, 1)] = kind(4);  // white wall-top
  data[idx(1, 2, 1)] = kind(12); // white wall-side
  data[idx(1, 3, 1)] = kind(12); // white wall-side
  data[idx(2, 2, 1)] = kind(12); // adjacent wall column: nothing is shadowed between walls
  const map = { width: w, height: h, data, scrollType: 0 };
  const changed = stampWallShadow(map, Tilemap);
  assert.equal(changed, 2);
  assert.equal(map.data[idx(1, 2, 4)], 0, "a wall side carries no mask of its own");
  assert.equal(map.data[idx(1, 3, 4)], 0, "nor does the wall side below it");
  assert.equal(map.data[idx(2, 2, 4)], 0, "a wall buried in a thick wall stays clean");
  assert.equal(map.data[idx(2, 3, 4)], 5, "left half on the ground right of the lower side cell");
  assert.equal(map.data[idx(3, 2, 4)], 5, "the adjacent column casts right too");
  assert.equal(map.data[idx(2, 1, 4)], 0, "a wall top casts nothing");
});

// A wall two or more tiles thick used to alternate 10 (wall) / 5 (ground) / 10
// (next wall) down the row, which is the striped banding visible in the real
// engine. Every wall cell must stay at 0 for a thick wall to read as one face.
test("a thick wall gets no alternating stripes", async () => {
  const { Tilemap } = await loadTilemap(process.cwd(), engine);
  const w = 6, h = 3, data = new Array(5 * w * h).fill(0);
  const idx = (x, y, z) => (z * h + y) * w + x;
  const wallSide = 5888 + 12 * 48;
  for (let y = 0; y < h; y++) for (let x = 0; x < 4; x++) data[idx(x, y, 1)] = wallSide;
  const map = { width: w, height: h, data, scrollType: 0 };
  stampWallShadow(map, Tilemap);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < 4; x++) assert.equal(map.data[idx(x, y, 4)], 0, `wall cell ${x},${y}`);
    assert.equal(map.data[idx(4, y, 4)], 5, `the exposed ground right of the wall ${y}`);
    assert.equal(map.data[idx(5, y, 4)], 0, "only the first ground cell is darkened");
  }
  assert.equal(stampWallShadow(map, Tilemap), 0, "the pass is idempotent");
});

// The add-only version left 10/5 behind when a wall was later erased, so filling
// a map with walls and carving rooms afterwards striped every carved cell.
test("stampWallShadow reclaims the shadow of a wall that was removed", async () => {
  const { Tilemap } = await loadTilemap(process.cwd(), engine);
  const w = 4, h = 3, data = new Array(5 * w * h).fill(0);
  const idx = (x, y, z) => (z * h + y) * w + x;
  const wallSide = 5888 + 12 * 48;
  data[idx(1, 1, 1)] = wallSide;
  const map = { width: w, height: h, data, scrollType: 0 };
  assert.equal(stampWallShadow(map, Tilemap), 1);
  assert.equal(map.data[idx(1, 1, 4)], 0, "the wall itself is never masked");
  assert.equal(map.data[idx(2, 1, 4)], 5);
  data[idx(1, 1, 1)] = 0;
  assert.equal(stampWallShadow(map, Tilemap), 1, "the stale cast is reclaimed");
  assert.equal(map.data[idx(1, 1, 4)], 0, "no shadow left where the wall used to be");
  assert.equal(map.data[idx(2, 1, 4)], 0);
});

// Masks an earlier buggy build stamped on wall cells are reclaimed too, so a
// map authored before this fix repairs itself on the next default paint.
test("stampWallShadow repairs a wall cell masked by an older build", async () => {
  const { Tilemap } = await loadTilemap(process.cwd(), engine);
  const w = 3, h = 1, data = new Array(5 * w * h).fill(0);
  const idx = (x, y, z) => (z * h + y) * w + x;
  data[idx(1, 0, 1)] = 5888 + 12 * 48;
  data[idx(1, 0, 4)] = 10;
  const map = { width: w, height: h, data, scrollType: 0 };
  assert.equal(stampWallShadow(map, Tilemap), 2, "the stale mask goes and the correct cast arrives");
  assert.equal(map.data[idx(1, 0, 4)], 0);
  assert.equal(map.data[idx(2, 0, 4)], 5);
});

test("stampWallShadow leaves hand-painted shadow masks alone", async () => {
  const { Tilemap } = await loadTilemap(process.cwd(), engine);
  const w = 3, h = 3, data = new Array(5 * w * h).fill(0);
  const idx = (x, y, z) => (z * h + y) * w + x;
  data[idx(0, 0, 4)] = 15; data[idx(2, 2, 4)] = 1;
  const map = { width: w, height: h, data, scrollType: 0 };
  assert.equal(stampWallShadow(map, Tilemap), 0, "only 10 and 5 are this function's vocabulary");
  assert.equal(map.data[idx(0, 0, 4)], 15);
  assert.equal(map.data[idx(2, 2, 4)], 1);
});
