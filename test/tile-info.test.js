import assert from "node:assert/strict";
import { test } from "node:test";
import { tileInfo } from "../src/tile-info.js";
import { tileSheet } from "../src/engine.js";

test("tileSheet identifies MZ graphic slots without confusing them with map layers", () => {
  assert.equal(tileSheet(0), "B");
  assert.equal(tileSheet(256), "C");
  assert.equal(tileSheet(768), "E");
  assert.equal(tileSheet(1200), null);
  assert.equal(tileSheet(1536), "A5");
  assert.equal(tileSheet(2048), "A1");
  assert.equal(tileSheet(2816), "A2");
  assert.equal(tileSheet(4352), "A3");
  assert.equal(tileSheet(5888), "A4");
  assert.equal(tileSheet(8192), null);
});

test("tile_info classifies B-E normal tiles with composition warning", () => {
  const info = tileInfo(53);
  assert.equal(info.kind, "normal");
  assert.equal(info.sheet, "B");
  assert.equal(info.autotile, false);
  assert.match(info.compositionWarning, /组合体/);
});

test("tile_info classifies A5 normal tiles", () => {
  const info = tileInfo(1562);
  assert.equal(info.kind, "normal");
  assert.equal(info.sheet, "A5");
  assert.equal(info.sheetX, 2);
  assert.equal(info.sheetY, 3);
});

test("tile_info pairs A4 wall-top with wall-side (shadow side)", () => {
  const top = tileInfo(6113); // A4 kind 4, white wall-top
  assert.equal(top.kind, "A4");
  assert.equal(top.autotileKind, 4);
  assert.match(top.role, /wall-top/);
  assert.equal(top.pairedKind, 12);
  assert.equal(top.pairedBaseTileId, 6464);
  assert.match(top.warning, /影子/);
  assert.match(top.warning, /layer 4|影子层/);
});

test("tile_info pairs A4 wall-side back with wall-top", () => {
  const side = tileInfo(6464 + 5); // kind 12, some piece
  assert.match(side.role, /wall-side/);
  assert.equal(side.pairedKind, 4);
  assert.equal(side.pairedBaseTileId, 6080);
  assert.match(side.warning, /tileId 5/); // shadow bit hint (left half)
});

test("tile_info wraps kinds into 16-groups: kind 16 is a top again", () => {
  const top = tileInfo(6656 + 3); // kind 16 -> 16 % 16 = 0 < 8 -> top
  assert.match(top.role, /wall-top/);
  assert.equal(top.pairedKind, 24);
});

test("tile_info classifies A3 roof/side and A1/A2", () => {
  assert.match(tileInfo(4352 + 7 * 48).role, /roof-top/);
  assert.match(tileInfo(4352 + 15 * 48).role, /building-side/);
  assert.match(tileInfo(2816).role, /ground/);
  assert.match(tileInfo(2048).role, /water/);
});

test("tile_info rejects out-of-range ids", () => {
  assert.throws(() => tileInfo(-1));
  assert.throws(() => tileInfo(8192));
  assert.throws(() => tileInfo(1.5));
});
