import { Tilemap } from "/engine.js";
const imageCache = new Map();
export function asset(name, token) { return `/asset/${name.split("/").map(encodeURIComponent).join("/")}?token=${encodeURIComponent(token)}`; }
export async function image(name, token) {
  const key = asset(name, token);
  if (!imageCache.has(key)) imageCache.set(key, new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => { imageCache.delete(key); reject(new Error(`Cannot load ${name}. Encrypted assets are unsupported.`)); };
    img.src = key;
  }));
  return imageCache.get(key);
}
export async function getBundle(mapId, token) {
  const response = await fetch(`/api/map?id=${mapId}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error((await response.json()).error || "Unauthorized");
  return response.json();
}
export function context(canvas, width, height) {
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  return ctx;
}
export async function bitmaps(bundle, token) {
  return Promise.all(bundle.tileset.tilesetNames.map(name => name ? image(`img/tilesets/${name}.png`, token) : null));
}
function layer(ctx, images, originX = 0, originY = 0) {
  return { addRect(set, sx, sy, dx, dy, w, h) {
    if (set < 0) { ctx.fillStyle = "rgba(0,0,0,.5)"; ctx.fillRect(dx - originX, dy - originY, w, h); }
    else if (images[set]) ctx.drawImage(images[set], sx, sy, w, h, dx - originX, dy - originY, w, h);
  } };
}
function renderer(bundle, images, lower, upper, animationFrame = 0) {
  const tm = Object.create(Tilemap.prototype);
  Object.assign(tm, { tileWidth: bundle.tileSize, tileHeight: bundle.tileSize,
    flags: bundle.tileset.flags, animationFrame,
    _mapWidth: bundle.map.width, _mapHeight: bundle.map.height, _mapData: bundle.map.data,
    horizontalWrap: false, verticalWrap: false, _lowerLayer: lower, _upperLayer: upper });
  // Engine's original _readMapData uses Number.mod for looping.
  tm._readMapData = function(x, y, z) {
    if (bundle.map.scrollType === 2 || bundle.map.scrollType === 3) x = (x % this._mapWidth + this._mapWidth) % this._mapWidth;
    if (bundle.map.scrollType === 1 || bundle.map.scrollType === 3) y = (y % this._mapHeight + this._mapHeight) % this._mapHeight;
    return x >= 0 && y >= 0 && x < this._mapWidth && y < this._mapHeight ? this._mapData[(z * this._mapHeight + y) * this._mapWidth + x] || 0 : 0;
  };
  return tm;
}
function activePage(event, state = {}) {
  const switches = state.switches || {}, variables = state.variables || {}, self = state.selfSwitches || {};
  return [...event.pages].reverse().find(page => {
    const c = page.conditions;
    return (!c.switch1Valid || switches[c.switch1Id]) && (!c.switch2Valid || switches[c.switch2Id]) &&
      (!c.variableValid || (variables[c.variableId] || 0) >= c.variableValue) &&
      (!c.selfSwitchValid || self[`${event.id}:${c.selfSwitchCh}`]) &&
      (!c.actorValid || (state.actors || []).includes(c.actorId)) && (!c.itemValid || (state.items || []).includes(c.itemId));
  });
}
// One _addSpot pass writes into both planes (the engine routes star tiles to
// the upper layer), so the lower and upper planes are collected in separate
// passes to keep event sprites between them. _addSpot resolves map cells from
// its own start arguments, so a block is addressed by shifting the start,
// never the destination. Compositing through a small scratch canvas keeps the
// intermediate bitmaps bounded no matter how large the map is.
const BLOCK_PX = 2048;
const sink = { addRect() {} };
function renderTiles(tm, images, ctx, region, size, upper) {
  const cells = Math.max(1, Math.floor(BLOCK_PX / size));
  const cols = Math.min(region.width, cells), rows = Math.min(region.height, cells);
  const scratch = document.createElement("canvas");
  const sctx = context(scratch, cols * size, rows * size);
  const paint = layer(sctx, images);
  for (let by = 0; by < region.height; by += rows) for (let bx = 0; bx < region.width; bx += cols) {
    const w = Math.min(cols, region.width - bx) * size, h = Math.min(rows, region.height - by) * size;
    sctx.clearRect(0, 0, scratch.width, scratch.height);
    tm._lowerLayer = upper ? sink : paint;
    tm._upperLayer = upper ? paint : sink;
    for (let y = 0; y < h / size; y++) for (let x = 0; x < w / size; x++) tm._addSpot(region.x + bx, region.y + by, x, y);
    ctx.drawImage(scratch, 0, 0, w, h, bx * size, by * size, w, h);
  }
}
export async function drawMap(canvas, bundle, token, options = {}) {
  const { map, tileSize: size } = bundle;
  const region = options.region || { x: 0, y: 0, width: map.width, height: map.height };
  for (const key of ["x", "y", "width", "height"]) if (!Number.isInteger(region[key])) throw new Error("Region requires integer coordinates");
  if (region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1 ||
      region.x + region.width > map.width || region.y + region.height > map.height) throw new Error("Region outside map");
  const width = region.width * size, height = region.height * size;
  const warnings = [];
  let scale = Math.max(.1, Math.min(4, options.scale || 1));
  const view = options.view || null;
  if (!view) {
    // 16384 per side is the hard 2D-canvas ceiling in Chromium; instead of
    // failing, fit the requested scale to the budget and say so. Maps of any
    // size therefore always render; the browser observer never hits this path
    // because it renders viewport-sized.
    const side = Math.max(width, height) * scale;
    if (side > 16384 || width * height * scale * scale > 16_777_216) {
      const fitted = Math.min(16384 / Math.max(width, height), Math.sqrt(16_777_216 / (width * height)));
      warnings.push(`scale ${scale} needs ${Math.ceil(side)}px, above the canvas budget; fitted to scale ${fitted.toFixed(3)}`);
      scale = fitted;
    }
  }
  const outputWidth = view ? view.width : Math.ceil(width * scale);
  const outputHeight = view ? view.height : Math.ceil(height * scale);
  const ctx = context(canvas, outputWidth, outputHeight);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = view ? "#0c1218" : "#192129";
  ctx.fillRect(0, 0, outputWidth, outputHeight);
  if (view) ctx.setTransform(scale, 0, 0, scale, view.offsetX, view.offsetY);
  else ctx.scale(scale, scale);
  ctx.fillStyle = "#192129"; ctx.fillRect(0, 0, width, height);
  if (map.parallaxName) {
    const background = await image(`img/parallaxes/${map.parallaxName}.png`, token);
    if (map.parallaxName.startsWith("!")) ctx.drawImage(background, -region.x * size, -region.y * size);
    else {
      const pattern = ctx.createPattern(background, "repeat");
      pattern.setTransform(new DOMMatrix().translate(-region.x * size, -region.y * size));
      ctx.fillStyle = pattern; ctx.fillRect(0, 0, width, height);
    }
  }
  const images = await bitmaps(bundle, token);
  const tm = renderer(bundle, images, sink, sink, options.animationFrame || 0);
  renderTiles(tm, images, ctx, region, size, false);
  const sprites = [];
  if (options.events !== false) for (const event of map.events.filter(Boolean)) {
    const page = activePage(event, options.state);
    if (!page) continue;
    const px = (event.x - region.x) * size, py = (event.y - region.y) * size;
    if (px < -size * 2 || py < -size * 2 || px > width + size * 2 || py > height + size * 2) continue;
    const draw = () => {
      if (page.image.tileId) tm._addTile(layer(ctx, images), page.image.tileId, px, py);
      else if (page.image.characterName) {
        const img = sprites.find(item => item.event === event)?.img;
        if (!img) return;
        const big = page.image.characterName.includes("$"), obj = page.image.characterName.includes("!");
        const pw = img.width / (big ? 3 : 12), ph = img.height / (big ? 4 : 8);
        const col = (big ? 0 : page.image.characterIndex % 4 * 3) + page.image.pattern;
        const row = (big ? 0 : Math.floor(page.image.characterIndex / 4) * 4) + (page.image.direction - 2) / 2;
        ctx.drawImage(img, col * pw, row * ph, pw, ph, px + (size - pw) / 2, py + size - ph - (obj ? 0 : 6), pw, ph);
      }
    };
    let img = null;
    if (page.image.characterName) {
      try { img = await image(`img/characters/${page.image.characterName}.png`, token); }
      catch (error) { warnings.push(error.message); }
    }
    sprites.push({ event, img, draw, priority: page.priorityType });
  }
  sprites.sort((a, b) => a.priority - b.priority || a.event.y - b.event.y || a.event.id - b.event.id);
  for (const sprite of sprites.filter(s => s.priority < 2)) sprite.draw();
  renderTiles(tm, images, ctx, region, size, true);
  for (const sprite of sprites.filter(s => s.priority === 2)) sprite.draw();
  if (options.regions) for (let y = 0; y < region.height; y++) for (let x = 0; x < region.width; x++) {
    const id = map.data[(5 * map.height + y + region.y) * map.width + x + region.x];
    if (id) { ctx.fillStyle = `hsla(${id * 43 % 360},75%,50%,.25)`; ctx.fillRect(x * size, y * size, size, size);
      ctx.fillStyle = "white"; ctx.font = "bold 14px sans-serif"; ctx.fillText(String(id), x * size + 5, y * size + 20); }
  }
  if (options.grid) {
    ctx.strokeStyle = "rgba(255,255,255,.25)"; ctx.lineWidth = 1 / scale; ctx.beginPath();
    for (let x = 0; x <= region.width; x++) { ctx.moveTo(x * size, 0); ctx.lineTo(x * size, height); }
    for (let y = 0; y <= region.height; y++) { ctx.moveTo(0, y * size); ctx.lineTo(width, y * size); }
    ctx.stroke();
    ctx.font = "12px monospace";
    for (let x = 0; x < region.width; x++) { ctx.fillStyle = "rgba(0,0,0,.7)"; ctx.fillRect(x * size, 0, size, 16); ctx.fillStyle = "white"; ctx.fillText(String(x + region.x), x * size + 3, 12); }
    for (let y = 1; y < region.height; y++) { ctx.fillStyle = "rgba(0,0,0,.7)"; ctx.fillRect(0, y * size, 25, 16); ctx.fillStyle = "white"; ctx.fillText(String(y + region.y), 3, y * size + 12); }
  }
  if (options.eventMarkers) for (const event of map.events.filter(Boolean)) {
    const x = (event.x - region.x) * size, y = (event.y - region.y) * size;
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    ctx.strokeStyle = "#ffcf70"; ctx.lineWidth = 2 / scale; ctx.strokeRect(x + 2, y + 2, size - 4, size - 4);
    ctx.fillStyle = "rgba(0,0,0,.8)"; ctx.fillRect(x + 3, y + size - 18, size - 6, 15);
    ctx.fillStyle = "#ffe8b8"; ctx.font = "12px monospace"; ctx.fillText(`E${event.id}`, x + 5, y + size - 6);
  }
  return { mapId: bundle.mapId, revision: bundle.revision, region, scale, pixelWidth: canvas.width, pixelHeight: canvas.height,
    warnings, note: "Design preview: stock MZ tiles/parallax/condition-selected event sprites; plugins, effects, and event logic are not executed." };
}
// Terrain-only and event-only draws for the observer's chunked viewport passes.
// The observer canvas is viewport-sized and addressed in world pixels through
// `view` (setTransform scale/offset), so a map of any size is painted as many
// small region draws instead of one giant bitmap. Events are drawn between the
// two plane sweeps, which is what keeps sprites stacked between the lower and
// upper tile planes without a second full-canvas pass.
export async function drawTerrain(canvas, bundle, token, options = {}) {
  const { map, tileSize: size } = bundle;
  const region = options.region || { x: 0, y: 0, width: map.width, height: map.height };
  for (const key of ["x", "y", "width", "height"]) if (!Number.isInteger(region[key])) throw new Error("Region requires integer coordinates");
  if (region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1 ||
      region.x + region.width > map.width || region.y + region.height > map.height) throw new Error("Region outside map");
  const width = region.width * size, height = region.height * size;
  const view = options.view || null;
  const warnings = [];
  const ctx = canvas.getContext("2d");
  let scale;
  if (view) {
    scale = view.scale;
    ctx.setTransform(scale, 0, 0, scale, view.offsetX, view.offsetY);
    // Heavy minification aliases into noise with nearest-neighbour, while
    // pixel-art upscale must stay crisp, so smoothing follows scale direction.
    // Whole-mode bitmap patches force smoothing off to match drawMap output.
    ctx.imageSmoothingEnabled = options.smoothing ?? scale < 1;
    if (options.background !== false) { ctx.fillStyle = "#192129"; ctx.fillRect(0, 0, width, height); }
    // Chunked viewport passes do not tile parallax patterns; maps that need a
    // parallax preview use the full-canvas drawMap path.
  } else {
    scale = Math.max(.1, Math.min(4, options.scale || 1));
    const side = Math.max(width, height) * scale;
    if (side > 16384 || width * height * scale * scale > 16_777_216) {
      const fitted = Math.min(16384 / Math.max(width, height), Math.sqrt(16_777_216 / (width * height)));
      warnings.push(`scale ${scale} needs ${Math.ceil(side)}px, above the canvas budget; fitted to scale ${fitted.toFixed(3)}`);
      scale = fitted;
    }
    canvas.width = Math.ceil(width * scale); canvas.height = Math.ceil(height * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#192129"; ctx.fillRect(0, 0, width, height);
  }
  const images = await bitmaps(bundle, token);
  const tm = renderer(bundle, images, sink, sink, options.animationFrame || 0);
  const plane = options.plane || "both";
  if (plane !== "upper") renderTiles(tm, images, ctx, region, size, false);
  if (plane !== "lower") renderTiles(tm, images, ctx, region, size, true);
  return { region, scale, warnings };
}
export async function drawEvents(ctx, bundle, token, options = {}) {
  const { map, tileSize: size } = bundle;
  const view = options.view;
  if (!view) throw new Error("drawEvents requires a view transform");
  const warnings = [];
  const images = await bitmaps(bundle, token);
  const tm = renderer(bundle, images, sink, sink, options.animationFrame || 0);
  ctx.setTransform(view.scale, 0, 0, view.scale, view.offsetX, view.offsetY);
  ctx.imageSmoothingEnabled = view.scale < 1;
  const cull = options.cull || null;
  const skirt = size * 2;
  const sprites = [];
  if (options.events !== false) for (const event of map.events.filter(Boolean)) {
    const page = activePage(event, options.state);
    if (!page) continue;
    const px = event.x * size, py = event.y * size;
    if (cull && (px < cull.x - skirt || py < cull.y - skirt ||
        px > cull.x + cull.width + skirt || py > cull.y + cull.height + skirt)) continue;
    let img = null;
    if (page.image.characterName) {
      try { img = await image(`img/characters/${page.image.characterName}.png`, token); }
      catch (error) { warnings.push(error.message); }
    }
    sprites.push({ event, page, img, px, py, priority: page.priorityType });
  }
  sprites.sort((a, b) => a.priority - b.priority || a.event.y - b.event.y || a.event.id - b.event.id);
  const group = options.priority === "above" ? s => s.priority === 2 : s => s.priority < 2;
  for (const sprite of sprites.filter(group)) {
    const { page, px, py } = sprite;
    if (page.image.tileId) tm._addTile(layer(ctx, images), page.image.tileId, px, py);
    else if (page.image.characterName && sprite.img) {
      const img = sprite.img;
      const big = page.image.characterName.includes("$"), obj = page.image.characterName.includes("!");
      const pw = img.width / (big ? 3 : 12), ph = img.height / (big ? 4 : 8);
      const col = (big ? 0 : page.image.characterIndex % 4 * 3) + page.image.pattern;
      const row = (big ? 0 : Math.floor(page.image.characterIndex / 4) * 4) + (page.image.direction - 2) / 2;
      ctx.drawImage(img, col * pw, row * ph, pw, ph, px + (size - pw) / 2, py + size - ph - (obj ? 0 : 6), pw, ph);
    }
  }
  return { warnings };
}
// Whole-mode incremental patch: repaint one region of a full-map bitmap in the
// engine's stacking order (clear → lower → below-events → upper → above).
// Events are culled on the region expanded by two cells so tall sprites
// anchored just below the patch still paint their tops into it. Maps with a
// parallax cannot be patched (the pattern is not re-tiled here) — rebuild.
export async function paintRegion(bitmap, bundle, token, region, options = {}) {
  const { map, tileSize: size } = bundle;
  for (const key of ["x", "y", "width", "height"]) if (!Number.isInteger(region[key])) throw new Error("Region requires integer coordinates");
  if (region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1 ||
      region.x + region.width > map.width || region.y + region.height > map.height) throw new Error("Region outside map");
  const scale = options.scale || 1;
  const warnings = [];
  const ctx = bitmap.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(region.x * size * scale, region.y * size * scale, region.width * size * scale, region.height * size * scale);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = "#192129";
  ctx.fillRect(region.x * size, region.y * size, region.width * size, region.height * size);
  const images = await bitmaps(bundle, token);
  const tm = renderer(bundle, images, sink, sink, options.animationFrame || 0);
  const cull = { x: region.x - 2, y: region.y - 2, width: region.width + 4, height: region.height + 4 };
  const view = { width: bitmap.width, height: bitmap.height, scale, offsetX: 0, offsetY: 0 };
  ctx.save();
  ctx.translate(region.x * size, region.y * size);
  renderTiles(tm, images, ctx, region, size, false);
  ctx.restore();
  if (options.events !== false)
    warnings.push(...(await drawEvents(ctx, bundle, token, { view, cull, priority: "below" })).warnings);
  ctx.save();
  ctx.translate(region.x * size, region.y * size);
  renderTiles(tm, images, ctx, region, size, true);
  ctx.restore();
  if (options.events !== false)
    warnings.push(...(await drawEvents(ctx, bundle, token, { view, cull, priority: "above" })).warnings);
  return { warnings };
}
export async function drawPalette(canvas, bundle, token, options = {}) {
  const { Tilemap: T } = { Tilemap };
  const sheet = options.sheet || "A2", size = bundle.tileSize;
  const images = await bitmaps(bundle, token);
  const base = { A1: 2048, A2: 2816, A3: 4352, A4: 5888, A5: 1536, B: 0, C: 256, D: 512, E: 768 }[sheet];
  const count = { A1: 16, A2: 32, A3: 32, A4: 48, A5: 128, B: 256, C: 256, D: 256, E: 256 }[sheet];
  if (base === undefined) throw new Error("Unknown sheet");
  const auto = ["A1", "A2", "A3", "A4"].includes(sheet);
  const sourceIndex = ["A1", "A2", "A3", "A4", "A5", "B", "C", "D", "E"].indexOf(sheet);
  if (!images[sourceIndex]) throw new Error(`Tileset has no ${sheet} sheet`);
  const start = Math.max(0, Math.min(count - 1, options.start || 0));
  const length = Math.min(count - start, options.count || count);
  const cols = 8, cellWidth = size + 8, cellHeight = size + 25;
  const ctx = context(canvas, cols * cellWidth, Math.ceil(length / cols) * cellHeight);
  ctx.fillStyle = "#1e2630"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const target = layer(ctx, images);
  const tm = renderer(bundle, images, target, target);
  const tiles = [];
  for (let i = 0; i < length; i++) {
    const id = base + (start + i) * (auto ? 48 : 1);
    const x = i % cols * cellWidth, y = Math.floor(i / cols) * cellHeight;
    const displayId = auto && T.isFloorTypeAutotile(id) ? id + 46 : auto && T.isWallTypeAutotile(id) ? id + 15 : id;
    tm._addTile(target, displayId, x + 4, y + 3);
    ctx.fillStyle = "#eef4fa"; ctx.font = "12px monospace"; ctx.fillText(String(id), x + 4, y + size + 18);
    ctx.strokeStyle = "#3b4b59"; ctx.strokeRect(x, y, cellWidth, cellHeight);
    tiles.push({ tileId: id, column: i % cols, row: Math.floor(i / cols) });
  }
  return { mapId: bundle.mapId, revision: bundle.revision, sheet, tiles, pixelWidth: canvas.width, pixelHeight: canvas.height };
}
