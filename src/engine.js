import fs from "node:fs/promises";
import path from "node:path";

// Read from the user's licensed local installation/project; no engine assets
// or proprietary source are included in the bridge distribution.
export async function loadTilemap(projectPath, enginePath) {
  const candidates = [
    ...(enginePath ? [path.join(enginePath, "data", "newdata", "js", "rmmz_core.js")] : []),
    path.join(projectPath, "js", "rmmz_core.js")
  ];
  let source;
  for (const file of candidates) {
    try { source = await fs.readFile(file, "utf8"); break; } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  if (!source) throw new Error("Cannot find local js/rmmz_core.js. Supply --engine or use a complete MZ project.");
  const start = source.indexOf("function Tilemap()");
  const end = source.indexOf("Tilemap.Layer = function", start);
  if (start < 0 || end < 0) throw new Error("Unrecognized MZ Tilemap source; supported baseline: MZ 1.8.x.");
  const tilemapSource = source.slice(start, end);
  // Never evaluate project JavaScript inside the privileged Node server.
  // Parse only JSON-compatible engine lookup tables for topology calculations.
  const Tilemap = {
    isAutotile: id => id >= 2048,
    getAutotileKind: id => Math.floor((id - 2048) / 48),
    getAutotileShape: id => (id - 2048) % 48,
    makeAutotileId: (kind, shape) => 2048 + kind * 48 + shape,
    isTileA1: id => id >= 2048 && id < 2816,
    isTileA2: id => id >= 2816 && id < 4352,
    isTileA3: id => id >= 4352 && id < 5888,
    isTileA4: id => id >= 5888 && id < 8192,
    isTileA5: id => id >= 1536 && id < 2048
  };
  Tilemap.isSameKindTile = (a, b) => Tilemap.isAutotile(a) && Tilemap.isAutotile(b) ? Tilemap.getAutotileKind(a) === Tilemap.getAutotileKind(b) : a === b;
  Tilemap.isWaterfallTypeAutotile = id => id >= 2240 && id < 2816 && Tilemap.getAutotileKind(id) % 2 === 1;
  Tilemap.isWallTypeAutotile = id => (Tilemap.isTileA3(id) && Tilemap.getAutotileKind(id) % 16 < 8) ||
    ((Tilemap.isTileA3(id) || Tilemap.isTileA4(id)) && Tilemap.getAutotileKind(id) % 16 >= 8);
  // Ported from rmmz_core.js Tilemap statics (wall composition predicates):
  // isWallTopTile: A4 with kind %% 16 < 8; isWallSideTile: (A3 or A4) with
  // kind %% 16 >= 8; isWallTile: either. Used by stampWallShadow below.
  Tilemap.isWallTopTile = id => Tilemap.isTileA4(id) && Tilemap.getAutotileKind(id) % 16 < 8;
  Tilemap.isWallSideTile = id => (Tilemap.isTileA3(id) || Tilemap.isTileA4(id)) && Tilemap.getAutotileKind(id) % 16 >= 8;
  Tilemap.isWallTile = id => Tilemap.isWallTopTile(id) || Tilemap.isWallSideTile(id);
  for (const name of ["FLOOR", "WALL", "WATERFALL"]) {
    const match = new RegExp(`Tilemap\\.${name}_AUTOTILE_TABLE\\s*=\\s*(\\[[\\s\\S]*?\\]);`).exec(tilemapSource);
    if (!match) throw new Error(`Missing ${name} autotile table`);
    Tilemap[`${name}_AUTOTILE_TABLE`] = JSON.parse(match[1]);
  }
  return { Tilemap, source: tilemapSource };
}

export function tileSheet(tileId) {
  if (!Number.isInteger(tileId) || tileId < 0 || tileId >= 8192) return null;
  if (tileId < 1024) return ["B", "C", "D", "E"][Math.floor(tileId / 256)];
  if (tileId < 1536) return null;
  if (tileId < 2048) return "A5";
  if (tileId < 2816) return "A1";
  if (tileId < 4352) return "A2";
  if (tileId < 5888) return "A3";
  return "A4";
}

export function tileDescription(Tilemap, tileId, flags = []) {
  const sheet = tileSheet(tileId) || "invalid";
  const flag = flags[tileId] || 0;
  return {
    tileId, sheet,
    ...(Tilemap.isAutotile(tileId) ? { kind: Tilemap.getAutotileKind(tileId), shape: Tilemap.getAutotileShape(tileId) } : {}),
    star: Boolean(flag & 0x10), passageBits: flag & 15,
    ladder: Boolean(flag & 0x20), bush: Boolean(flag & 0x40),
    counter: Boolean(flag & 0x80), damage: Boolean(flag & 0x100),
    terrainTag: flag >> 12
  };
}

export function validateTile(Tilemap, id) {
  if (!Number.isInteger(id) || id < 0 || id >= 8192 || (id >= 1024 && id < 1536)) {
    throw new Error(`Invalid MZ tile ID: ${id}`);
  }
  if (Tilemap.isAutotile(id)) {
    const maxShape = Tilemap.isWaterfallTypeAutotile(id) ? 4 : Tilemap.isWallTypeAutotile(id) ? 16 : 48;
    if (Tilemap.getAutotileShape(id) >= maxShape) throw new Error(`Invalid autotile shape: ${id}`);
  }
}

export function retile(map, Tilemap, layers = [0, 1, 2, 3]) {
  const idx = (x, y, z) => (z * map.height + y) * map.width + x;
  const at = (x, y, z) => {
    if (map.scrollType === 2 || map.scrollType === 3) x = (x % map.width + map.width) % map.width;
    if (map.scrollType === 1 || map.scrollType === 3) y = (y % map.height + map.height) % map.height;
    return x >= 0 && y >= 0 && x < map.width && y < map.height ? map.data[idx(x, y, z)] : null;
  };
  for (const z of layers) for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
    const id = at(x, y, z);
    if (!Tilemap.isAutotile(id)) continue;
    const same = (dx, dy) => {
      const neighbor = at(x + dx, y + dy, z);
      // MZ editor joins an autotile to the edge of the map.
      return neighbor === null || Tilemap.isSameKindTile(id, neighbor);
    };
    const l = same(-1, 0), u = same(0, -1), r = same(1, 0), d = same(0, 1);
    let shape;
    if (Tilemap.isWaterfallTypeAutotile(id)) shape = (!l ? 1 : 0) | (!r ? 2 : 0);
    else if (Tilemap.isWallTypeAutotile(id)) shape = (!l ? 1 : 0) | (!u ? 2 : 0) | (!r ? 4 : 0) | (!d ? 8 : 0);
    else {
      const desired = [
        !l && !u ? [0, 2] : !l ? [0, 4] : !u ? [2, 2] : !same(-1, -1) ? [2, 0] : [2, 4],
        !r && !u ? [3, 2] : !r ? [3, 4] : !u ? [1, 2] : !same(1, -1) ? [3, 0] : [1, 4],
        !l && !d ? [0, 5] : !l ? [0, 3] : !d ? [2, 5] : !same(-1, 1) ? [2, 1] : [2, 3],
        !r && !d ? [3, 5] : !r ? [3, 3] : !d ? [1, 5] : !same(1, 1) ? [3, 1] : [1, 3]
      ];
      shape = Tilemap.FLOOR_AUTOTILE_TABLE.findIndex(table =>
        table.every((pair, i) => pair[0] === desired[i][0] && pair[1] === desired[i][1]));
      if (shape < 0) throw new Error(`Unable to resolve autotile at ${x},${y},${z}`);
    }
    map.data[idx(x, y, z)] = Tilemap.makeAutotileId(Tilemap.getAutotileKind(id), shape);
  }
}

// Editor-parity wall shadows, ported from the engine's own definitions:
// Tilemap.isWallSideTile (A3/A4 autotileKind % 16 >= 8) picks the cells that
// cast shadows, and Tilemap._addShadow defines the quadrant bitmap rendered
// from data layer 4 (bit1=TL, bit2=TR, bit4=BL, bit8=BR). A wall darkens the
// ground tile to its right with the left half (bits 1|4 = 5) and carries no
// mask of its own — verified against maps drawn by hand in the MZ editor,
// where every A4 wall cell has layer 4 = 0.
export function stampWallShadow(map, Tilemap) {
  const idx = (x, y, z) => (z * map.height + y) * map.width + x;
  // A cell counts as wall-side / wall if either visual plane 0 or 1 carries it,
  // because walls are commonly drawn on layer 1 above a ground autotile.
  const has = (x, y, test) => x >= 0 && y >= 0 && x < map.width && y < map.height &&
    [0, 1].some(z => test(map.data[idx(x, y, z)]));
  let changed = 0;
  // The shadow belongs to the ground the wall falls on, never to the wall
  // itself. Stamping the wall cell too (10) is what produced alternating dark
  // stripes on every multi-tile wall, in the preview and in the real engine.
  //
  // This is a reconcile, not a paint-over: the previous add-only version left
  // 10/5 behind when a wall was later erased, so filling a map with walls and
  // carving rooms afterwards produced a dark stripe over every carved cell.
  // Only the two values this function owns are ever reset, so hand-painted
  // masks (any other layer 4 value) survive untouched.
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
    const side = has(x, y, tile => Tilemap.isWallSideTile(tile));
    const want = !side && !has(x, y, tile => Tilemap.isWallTile(tile)) &&
      has(x - 1, y, tile => Tilemap.isWallSideTile(tile)) ? 5 : 0;
    const cell = idx(x, y, 4);
    if (want === 0 && map.data[cell] !== 10 && map.data[cell] !== 5) continue;
    if (map.data[cell] !== want) { map.data[cell] = want; changed++; }
  }
  return changed;
}
