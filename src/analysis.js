import { point } from "./project.js";

export async function analyze(project, mapId, from, to) {
  const { map, revision } = await project.read(mapId);
  const tileset = await project.tileset(map);
  const width = map.width, height = map.height;
  const at = (x, y, z) => map.data[(z * height + y) * width + x];
  const blockedEvents = new Set(map.events.filter(e => e && e.pages.length === 1 && e.pages[0].priorityType === 1 && !e.pages[0].through)
    .map(e => `${e.x},${e.y}`));
  const pass = (x, y, bit) => {
    if (x < 0 || y < 0 || x >= width || y >= height || blockedEvents.has(`${x},${y}`)) return false;
    for (const z of [3, 2, 1, 0]) {
      const flag = tileset.flags[at(x, y, z)] || 0;
      if (flag & 0x10) continue;
      return (flag & bit) === 0;
    }
    return false;
  };
  const step = (x, y, dx, dy, outBit, inBit) => {
    let nx = x + dx, ny = y + dy;
    if (map.scrollType === 2 || map.scrollType === 3) nx = (nx + width) % width;
    if (map.scrollType === 1 || map.scrollType === 3) ny = (ny + height) % height;
    return pass(x, y, outBit) && pass(nx, ny, inBit) ? { x: nx, y: ny } : null;
  };
  const neighbors = (x, y) => [[0, 1, 1, 8], [-1, 0, 2, 4], [1, 0, 4, 2], [0, -1, 8, 1]]
    .map(args => step(x, y, ...args)).filter(Boolean);
  const warnings = [];
  for (const event of map.events.filter(Boolean)) for (const page of event.pages) {
    if (page.trigger === 3) warnings.push(`E${event.id} autorun may lock player movement until its condition changes.`);
    for (const command of page.list) if (command.code === 201 && command.parameters[0] === 0) {
      const [, targetId, x, y] = command.parameters;
      try { const target = await project.read(targetId); point(target.map, x, y); }
      catch (e) { warnings.push(`E${event.id} transfer invalid: ${e.message}`); }
    }
  }
  let route = null;
  if (from && to) {
    point(map, from.x, from.y); point(map, to.x, to.y);
    const key = p => p.y * width + p.x;
    const queue = [from], previous = new Map([[key(from), null]]);
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i];
      if (key(current) === key(to)) break;
      for (const next of neighbors(current.x, current.y)) if (!previous.has(key(next))) {
        previous.set(key(next), current); queue.push(next);
      }
    }
    if (previous.has(key(to))) {
      route = [];
      for (let p = to; p; p = previous.get(key(p))) route.unshift(p);
    }
  }
  let walkable = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (neighbors(x, y).length) walkable++;
  return { mapId, revision, size: { width, height }, eventCount: map.events.filter(Boolean).length,
    walkableCells: walkable, warnings, ...(from && to ? { reachable: route !== null, path: route } : {}),
    caveat: "Static approximation: stock directional flags and single-page blocking events only. Plugin passage rules, vehicles, and conditional event state require playtesting." };
}
