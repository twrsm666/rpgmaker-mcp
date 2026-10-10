import { getBundle, drawMap, drawPalette, drawTerrain, drawEvents, paintRegion } from "/renderer.js";
import { applyChange, summarizeChange } from "/changes.js";
const $ = id => document.getElementById(id);
const token = new URLSearchParams(location.hash.slice(1)).get("token") || sessionStorage.getItem("mz-token");
if (token) sessionStorage.setItem("mz-token", token);
history.replaceState(null, "", "/");
let bundle, palette, selection, clientId, initializedGame = false;
let paused = false, permits = 0, pending = 0, displayed = 0;
let chain = Promise.resolve(), lastFocus = null, currentFrame = null, replaying = false;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const enqueue = fn => {
  const task = chain.then(fn);
  chain = task.catch(error => { $("error").textContent = error.message; });
  return task;
};
function counts() {
  $("step-count").textContent = `已显示 ${displayed} 步 · 等待 ${pending} 步${paused ? " · 已暂停" : ""}`;
}
async function api(url, payload) {
  const response = await fetch(url, { method: payload ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, ...(payload ? { "Content-Type": "application/json" } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}) });
  if (!response.ok) throw new Error((await response.json()).error || "需要带 token 的预览地址");
  return response.json();
}
async function ackView() {
  if (clientId && bundle) await api("/api/ack", { clientId, mapId: bundle.mapId, status: "view" }).catch(() => {});
}
async function refreshMaps() {
  const selected = $("maps").value, maps = await api("/api/maps");
  $("maps").replaceChildren(...maps.map(map => {
    const option = document.createElement("option"); option.value = map.id; option.textContent = `#${map.id} ${map.name}`; return option;
  }));
  if (maps.some(m => String(m.id) === selected)) $("maps").value = selected;
}
function updateDetails() {
  if (!bundle) return;
  $("map-label").textContent = `#${bundle.mapId} · ${bundle.map.width} × ${bundle.map.height}`;
  $("revision").textContent = bundle.revision.slice(0, 12);
  $("revision").dataset.fullRevision = bundle.revision;
  $("event-list").replaceChildren(...bundle.map.events.filter(Boolean).map(event => {
    const row = document.createElement("div"); row.className = "event";
    row.textContent = `E${event.id} ${event.name} (${event.x}, ${event.y}) · ${event.pages.length} 页`; return row;
  }));
  if (selection) inspect(selection.x, selection.y);
}
// ---- Render mode: chunked viewport passes vs one whole-map bitmap ----
// chunked (default): the canvas is viewport-sized and tiles are drawn per
// visible chunk, so maps of any size browse instantly.
// whole: one full-map bitmap is composited once (auto-fitted to the canvas
// budget), then pan/zoom is a pure image blit with zero tile redraws; steps
// patch only their changed region into the bitmap.
let renderMode = localStorage.getItem("mz-render-mode") === "whole" ? "whole" : "chunked";
let whole = null; // { canvas, scale, mapId, revision }
function renderModeLabel() {
  $("render-mode").textContent = renderMode === "whole" ? "整体渲染" : "分块渲染";
  $("render-mode").title = renderMode === "whole"
    ? "当前：整体渲染 · 一次合成整图位图，平移缩放零重绘；点击切回分块渲染"
    : "当前：分块渲染 · 视口逐块绘制，任意大小即时；点击切换整体渲染";
}
function wholeKey() {
  return `${bundle.mapId}:${bundle.map.width}x${bundle.map.height}:${bundle.revision}:${$("events").checked}`;
}
// ---- Camera ----
// Camera coordinates are world pixels of the viewport's top-left corner. The
// canvas always stays viewport-sized, so browsing a map of any dimensions
// composites only the visible cells and never allocates a full-map bitmap.
const MAX_ZOOM = 32;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const camera = { scale: 1, x: 0, y: 0 };
let camMin = .01;
// Read-only handle for the repository's UI verification scripts: they click
// world coordinates through the camera instead of assuming a canvas layout.
window.__mzPreview = { camera, invalidate: region => invalidate(region), refresh: () => refresh(),
  mode: () => renderMode, wholeReady: () => Boolean(whole) };
function viewport() {
  const wrap = $("map-wrap");
  return { width: Math.max(1, wrap.clientWidth), height: Math.max(1, wrap.clientHeight) };
}
function worldSize() {
  return { width: bundle.map.width * bundle.tileSize, height: bundle.map.height * bundle.tileSize };
}
function fitCamera() {
  if (!bundle) return;
  const view = viewport(), world = worldSize();
  camera.scale = Math.min(1, view.width / world.width, view.height / world.height);
  camMin = Math.min(.01, camera.scale / 4);
  camera.x = (world.width - view.width / camera.scale) / 2;
  camera.y = (world.height - view.height / camera.scale) / 2;
}
function clampCamera() {
  const view = viewport(), world = worldSize();
  const spanX = view.width / camera.scale, spanY = view.height / camera.scale;
  camera.x = clamp(camera.x, -spanX / 2, world.width - spanX / 2);
  camera.y = clamp(camera.y, -spanY / 2, world.height - spanY / 2);
}
function zoomAt(factor, anchorX, anchorY) {
  if (!bundle) return;
  const worldX = camera.x + anchorX / camera.scale, worldY = camera.y + anchorY / camera.scale;
  camera.scale = clamp(camera.scale * factor, camMin, MAX_ZOOM);
  camera.x = worldX - anchorX / camera.scale;
  camera.y = worldY - anchorY / camera.scale;
  clampCamera();
}
// ---- Viewport passes: chunked terrain draws on a viewport-sized canvas ----
const CHUNK_CELLS = 32;
let passChain = Promise.resolve();
let passGeneration = 0;
function visibleRegion(margin = 2) {
  const size = bundle.tileSize, map = bundle.map, view = viewport();
  const left = clamp(Math.floor(camera.x / size) - margin, 0, map.width);
  const top = clamp(Math.floor(camera.y / size) - margin, 0, map.height);
  const right = clamp(Math.ceil((camera.x + view.width / camera.scale) / size) + margin, 0, map.width);
  const bottom = clamp(Math.ceil((camera.y + view.height / camera.scale) / size) + margin, 0, map.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}
function chunkList(region) {
  const chunks = [];
  for (let y = region.y; y < region.y + region.height; y += CHUNK_CELLS)
    for (let x = region.x; x < region.x + region.width; x += CHUNK_CELLS)
      chunks.push({ x, y, width: Math.min(CHUNK_CELLS, region.x + region.width - x), height: Math.min(CHUNK_CELLS, region.y + region.height - y) });
  return chunks;
}
function screenTransform(dpr) {
  const scale = camera.scale * dpr;
  return { scale, sx: x => (x * bundle.tileSize - camera.x) * scale, sy: y => (y * bundle.tileSize - camera.y) * scale };
}
function renderOverlays(canvas, dpr, region) {
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const { scale, sx, sy } = screenTransform(dpr);
  const cellPx = bundle.tileSize * camera.scale * dpr;
  if ($("regions").checked && cellPx >= 8) {
    for (let y = region.y; y < region.y + region.height; y++) for (let x = region.x; x < region.x + region.width; x++) {
      const id = bundle.map.data[(5 * bundle.map.height + y) * bundle.map.width + x];
      if (id) {
        ctx.fillStyle = `hsla(${id * 43 % 360},75%,50%,.25)`;
        ctx.fillRect(sx(x), sy(y), cellPx, cellPx);
        if (cellPx >= 24) {
          ctx.fillStyle = "white"; ctx.font = `bold ${Math.max(10, cellPx * .3)}px sans-serif`;
          ctx.fillText(String(id), sx(x) + cellPx * .1, sy(y) + cellPx * .42);
        }
      }
    }
  }
  if ($("grid").checked && camera.scale >= .2) {
    ctx.strokeStyle = "rgba(255,255,255,.25)"; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = region.x; x <= region.x + region.width; x++) { ctx.moveTo(sx(x), 0); ctx.lineTo(sx(x), canvas.height); }
    for (let y = region.y; y <= region.y + region.height; y++) { ctx.moveTo(0, sy(y)); ctx.lineTo(canvas.width, sy(y)); }
    ctx.stroke();
    if (cellPx >= 30) {
      ctx.font = `${12 * dpr}px monospace`;
      for (let x = region.x; x < region.x + region.width; x++) {
        if (x % 5 && cellPx < 34) continue;
        ctx.fillStyle = "rgba(0,0,0,.7)"; ctx.fillRect(sx(x), 0, cellPx, 16 * dpr);
        ctx.fillStyle = "white"; ctx.fillText(String(x), sx(x) + 3, 12 * dpr);
      }
      for (let y = region.y; y < region.y + region.height; y++) {
        if (y % 5 && cellPx < 34) continue;
        ctx.fillStyle = "rgba(0,0,0,.7)"; ctx.fillRect(0, sy(y), 25 * dpr, 16 * dpr);
        ctx.fillStyle = "white"; ctx.fillText(String(y), 3, sy(y) + 12 * dpr);
      }
    }
  }
  if ($("markers").checked && camera.scale >= .15) {
    ctx.lineWidth = 2;
    ctx.font = `${12 * dpr}px monospace`;
    for (const event of bundle.map.events.filter(Boolean)) {
      const ex = sx(event.x), ey = sy(event.y);
      if (ex < -cellPx || ey < -cellPx || ex > canvas.width || ey > canvas.height) continue;
      ctx.strokeStyle = "#ffcf70"; ctx.strokeRect(ex + 2, ey + 2, cellPx - 4, cellPx - 4);
      ctx.fillStyle = "rgba(0,0,0,.8)"; ctx.fillRect(ex + 3, ey + cellPx - 18 * dpr, cellPx - 6, 15 * dpr);
      ctx.fillStyle = "#ffe8b8"; ctx.fillText(`E${event.id}`, ex + 5, ey + cellPx - 6 * dpr);
    }
  }
  for (const [focus, color] of [[lastFocus?.from, "#81b6c6"], [lastFocus?.focus, "#ffcf70"]]) if (focus) {
    ctx.strokeStyle = color; ctx.lineWidth = 3;
    ctx.strokeRect(sx(focus.x) + 1.5, sy(focus.y) + 1.5, cellPx - 3, cellPx - 3);
  }
}
function finishPass(canvas) {
  canvas.dataset.revision = bundle.revision;
  canvas.dataset.changeId = currentFrame?.changeId || "";
  canvas.dataset.displayedSteps = String(displayed);
  $("zoom-level").textContent = `${Math.round(camera.scale * 100)}%`;
  updateDetails();
}
function blitWhole(canvas, dpr) {
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#0c1218"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const k = camera.scale * dpr / whole.scale;
  ctx.imageSmoothingEnabled = camera.scale < whole.scale;
  ctx.setTransform(k, 0, 0, k, -camera.x * camera.scale * dpr, -camera.y * camera.scale * dpr);
  ctx.drawImage(whole.canvas, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
async function renderPass(area) {
  const gen = ++passGeneration;
  const canvas = $("map"), dpr = window.devicePixelRatio || 1;
  const view = viewport();
  canvas.width = Math.max(1, Math.round(view.width * dpr));
  canvas.height = Math.max(1, Math.round(view.height * dpr));
  const warnings = [];
  if (renderMode === "whole") {
    const key = wholeKey();
    // Rebuild the bitmap on load/resize/parallax/big edits; patch small ones.
    const needFull = !whole || whole.key !== key || bundle.map.parallaxName ||
      !area || area.width * area.height > 2500;
    if (needFull) {
      if (!whole || whole.key !== key) $("status").textContent = "整体渲染中……";
      const bitmap = document.createElement("canvas");
      const meta = await drawMap(bitmap, bundle, token, {
        scale: 1, events: $("events").checked, eventMarkers: false, animationFrame: 0 });
      if (gen !== passGeneration) return;
      whole = { canvas: bitmap, scale: meta.scale, key };
      whole.mapId = bundle.mapId; whole.revision = bundle.revision;
      warnings.push(...meta.warnings);
      $("status").textContent = `整图位图 ${bitmap.width}×${bitmap.height}（${Math.round(meta.scale * 100)}%）已就绪 · 平移缩放零重绘`;
    } else {
      warnings.push(...(await paintRegion(whole.canvas, bundle, token, area, {
        scale: whole.scale, events: $("events").checked })).warnings);
      if (gen !== passGeneration) return;
      whole.key = wholeKey(); whole.revision = bundle.revision;
    }
    blitWhole(canvas, dpr);
    renderOverlays(canvas, dpr, visibleRegion());
    finishPass(canvas);
    if (warnings.length) $("error").textContent = warnings.join("\n");
    return;
  }
  const size = bundle.tileSize;
  const region = area || visibleRegion();
  if (!area) {
    const bg = canvas.getContext("2d");
    bg.setTransform(1, 0, 0, 1, 0, 0);
    bg.fillStyle = "#0c1218"; bg.fillRect(0, 0, canvas.width, canvas.height);
  }
  const scale = camera.scale * dpr;
  if (region.width > 0 && region.height > 0) {
    const chunks = chunkList(region);
    const terrain = (chunk, plane, background) => drawTerrain(canvas, bundle, token, {
      region: chunk, plane, background,
      view: { width: canvas.width, height: canvas.height, scale,
        offsetX: (chunk.x * size - camera.x) * scale, offsetY: (chunk.y * size - camera.y) * scale } });
    const yieldFrames = chunks.length > 4;
    for (const chunk of chunks) {
      if (gen !== passGeneration) return;
      warnings.push(...(await terrain(chunk, "lower", true)).warnings);
      if (yieldFrames) await new Promise(resolve => requestAnimationFrame(resolve));
    }
    if ($("events").checked) {
      const cull = { x: camera.x, y: camera.y, width: view.width / camera.scale, height: view.height / camera.scale };
      warnings.push(...(await drawEvents(canvas.getContext("2d"), bundle, token, {
        view: { width: canvas.width, height: canvas.height, scale, offsetX: -camera.x * scale, offsetY: -camera.y * scale },
        priority: "below", cull })).warnings);
    }
    for (const chunk of chunks) {
      if (gen !== passGeneration) return;
      warnings.push(...(await terrain(chunk, "upper", false)).warnings);
      if (yieldFrames) await new Promise(resolve => requestAnimationFrame(resolve));
    }
    if ($("events").checked) {
      const cull = { x: camera.x, y: camera.y, width: view.width / camera.scale, height: view.height / camera.scale };
      warnings.push(...(await drawEvents(canvas.getContext("2d"), bundle, token, {
        view: { width: canvas.width, height: canvas.height, scale, offsetX: -camera.x * scale, offsetY: -camera.y * scale },
        priority: "above", cull })).warnings);
    }
  }
  if (gen !== passGeneration) return;
  renderOverlays(canvas, dpr, area ? visibleRegion() : region);
  finishPass(canvas);
  if (warnings.length) $("error").textContent = warnings.join("\n");
}
function invalidate(region = null) {
  const gen = ++passGeneration;
  const task = passChain.then(async () => {
    if (!bundle || gen !== passGeneration) return;
    await renderPass(region);
  });
  passChain = task.catch(error => { $("error").textContent = error.message; });
  return task;
}
// Camera- or overlay-only redraw: whole mode re-blits the bitmap (no tile
// work at all); chunked mode still needs a full sweep because tiles were
// never cached. Falls back to a rebuild when the bitmap is stale.
function refresh() {
  if (renderMode === "whole" && whole && whole.mapId === bundle?.mapId &&
    whole.revision === bundle?.revision && whole.key === wholeKey()) {
    const gen = ++passGeneration;
    const canvas = $("map"), dpr = window.devicePixelRatio || 1;
    const view = viewport();
    canvas.width = Math.max(1, Math.round(view.width * dpr));
    canvas.height = Math.max(1, Math.round(view.height * dpr));
    blitWhole(canvas, dpr);
    renderOverlays(canvas, dpr, visibleRegion());
    finishPass(canvas);
    return Promise.resolve();
  }
  return invalidate(null);
}
// ---- Gestures: snapshot + transform blit for instant pan and zoom ----
// During a drag or a wheel burst the last completed frame is re-blitted with
// the camera delta instead of re-rendering tiles; a true pass runs once the
// gesture settles. In whole mode settling is only a bitmap blit.
const gesture = { active: false, snap: null, scale: 1, x: 0, y: 0, timer: 0 };
function captureSnapshot() {
  const canvas = $("map");
  if (!canvas.width) return;
  const snap = document.createElement("canvas");
  snap.width = canvas.width; snap.height = canvas.height;
  snap.getContext("2d").drawImage(canvas, 0, 0);
  gesture.snap = snap; gesture.scale = camera.scale; gesture.x = camera.x; gesture.y = camera.y;
}
function blitSnapshot() {
  const snap = gesture.snap, canvas = $("map");
  if (!snap) return;
  const dpr = window.devicePixelRatio || 1;
  const now = camera.scale * dpr, was = gesture.scale * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#0c1218"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = now < was;
  ctx.setTransform(now / was, 0, 0, now / was, (gesture.x - camera.x) * now, (gesture.y - camera.y) * now);
  ctx.drawImage(snap, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  $("zoom-level").textContent = `${Math.round(camera.scale * 100)}%`;
}
function settle(delay = 140) {
  clearTimeout(gesture.timer);
  gesture.timer = setTimeout(() => { gesture.active = false; gesture.snap = null; refresh(); }, delay);
}
function beginGesture() {
  if (!gesture.active) { gesture.active = true; captureSnapshot(); }
}
async function redrawPalette() {
  if (!bundle) return;
  try { palette = await drawPalette($("palette"), bundle, token, { sheet: $("sheet").value }); }
  catch (error) { palette = null; $("palette").width = 1; $("palette").height = 1; $("status").textContent = error.message; }
}
async function load(mapId = Number($("maps").value)) {
  $("error").textContent = ""; bundle = await getBundle(mapId, token);
  $("maps").value = String(mapId); currentFrame = null; lastFocus = null; selection = null;
  fitCamera(); await invalidate(); await redrawPalette(); await ackView();
  $("status").textContent = `已读取磁盘 · ${new Date().toLocaleTimeString()} · ${bundle.tileSize}px / 格`;
}
function inspect(x, y) {
  if (!bundle || x < 0 || y < 0 || x >= bundle.map.width || y >= bundle.map.height) return;
  selection = { x, y };
  const index = z => (z * bundle.map.height + y) * bundle.map.width + x;
  $("selection").textContent = `格子 (${x}, ${y})`;
  $("detail").textContent = JSON.stringify({
    mapId: bundle.mapId, revision: bundle.revision, x, y,
    layers: [0, 1, 2, 3].map(z => ({ layer: z, tileId: bundle.map.data[index(z)] })),
    shadow: bundle.map.data[index(4)], region: bundle.map.data[index(5)],
    events: bundle.map.events.filter(event => event && event.x === x && event.y === y)
  }, null, 2);
}
// A step that touched only a few cells is repainted as its bounding box;
// anything structural falls back to a full pass. In whole mode the box is
// not clipped to the viewport — the bitmap covers the whole map, so changes
// outside the view must still be patched into it.
function frameRegion(frame, before) {
  const delta = frame.delta;
  if (delta.reset || Object.keys(delta.properties).length) return null;
  const map = bundle.map;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  const add = (x, y) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; };
  for (const cell of delta.tiles) add(cell.index % map.width, Math.floor(cell.index / map.width) % map.height);
  for (const change of delta.events) {
    const old = before?.map.events[change.id];
    if (old) add(old.x, old.y);
    if (change.value) add(change.value.x, change.value.y);
  }
  const focus = frame.presentation?.focus; if (focus) add(focus.x, focus.y);
  const from = frame.presentation?.from; if (from) add(from.x, from.y);
  if (maxX < 0) return null;
  const margin = 3;
  const x = Math.max(0, minX - margin), y = Math.max(0, minY - margin);
  const width = Math.min(map.width - x, maxX + margin - x + 1), height = Math.min(map.height - y, maxY + margin - y + 1);
  if (renderMode === "whole") return { x, y, width, height };
  const visible = visibleRegion();
  if (width * height > visible.width * visible.height * .4) return null;
  const ix = Math.max(x, visible.x), iy = Math.max(y, visible.y);
  const ix2 = Math.min(x + width, visible.x + visible.width), iy2 = Math.min(y + height, visible.y + visible.height);
  if (ix2 <= ix || iy2 <= iy) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: ix, y: iy, width: ix2 - ix, height: iy2 - iy };
}
async function gate() {
  while (paused && permits === 0) await wait(40);
  if (paused) permits--;
}
async function showFrame(frame, replay = false) {
  await gate();
  pending = Math.max(0, pending - 1);
  if (bundle?.mapId !== frame.mapId) { counts(); return; }
  const before = bundle;
  const oldTileset = bundle.map.tilesetId;
  bundle = applyChange(bundle, frame);
  if (oldTileset !== bundle.map.tilesetId) bundle.tileset = (await getBundle(bundle.mapId, token)).tileset;
  currentFrame = frame; lastFocus = frame.presentation || null; displayed++;
  if (frame.presentation?.focus) selection = frame.presentation.focus;
  $("current-step").textContent = `${replay ? "回放" : "实时"} · 第 ${displayed} 步 · ${summarizeChange(frame)}`;
  const row = document.createElement("li");
  row.textContent = `${displayed}. ${summarizeChange(frame)}`;
  row.dataset.changeId = frame.changeId; row.dataset.revision = frame.revision;
  $("edit-log").prepend(row); while ($("edit-log").children.length > 100) $("edit-log").lastElementChild.remove();
  counts(); await invalidate(frameRegion(frame, before));
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const override = $("step-speed").value;
  await wait(override === "server" ? frame.presentation?.holdMs ?? 80 : Number(override));
  if (!replay && clientId) await api("/api/ack", {
    clientId, changeId: frame.changeId, mapId: frame.mapId, revision: frame.revision, status: "rendered"
  });
  $("status").textContent = `${replay ? "回放不写磁盘" : "本步已保存并绘制"} · ${frame.changeId}`;
}
function queueFrame(frame, replay = false) {
  pending++; counts();
  return enqueue(() => showFrame(frame, replay));
}
$("pause-steps").addEventListener("click", () => {
  paused = !paused; $("pause-steps").textContent = paused ? "继续" : "暂停"; counts();
});
$("next-step").addEventListener("click", () => {
  paused = true; permits++; $("pause-steps").textContent = "继续"; counts();
});
$("replay-steps").addEventListener("click", async () => {
  try {
    const demo = await api("/api/demo");
    if (!demo?.steps?.length) { $("current-step").textContent = "当前还没有可回放的编辑步骤。"; return; }
    if (!demo.closed) { $("current-step").textContent = "请等当前编辑会话结束后再重播。"; return; }
    if (pending || replaying) { $("current-step").textContent = "请先完成当前步骤队列。"; return; }
    replaying = true; paused = false; $("pause-steps").textContent = "暂停";
    await enqueue(async () => {
      bundle = structuredClone(demo.initial); $("maps").value = String(bundle.mapId);
      displayed = 0; $("edit-log").replaceChildren(); lastFocus = null; currentFrame = null;
      fitCamera(); await invalidate();
    });
    for (const frame of demo.steps) queueFrame(frame, true);
    await enqueue(() => { replaying = false; $("current-step").textContent += demo.truncated ? " · 回放已达到记录上限" : " · 本轮回放完成"; });
  } catch (error) { replaying = false; $("error").textContent = error.message; }
});
$("play-view").addEventListener("click", () => {
  $("design-panel").hidden = true; $("play-panel").hidden = false;
  if (!initializedGame) { $("game-frame").src = `/game/launch?token=${encodeURIComponent(token)}`; initializedGame = true; }
});
$("design-view").addEventListener("click", () => {
  $("play-panel").hidden = true; $("design-panel").hidden = false; refresh();
});
// ---- Render-mode switch ----
$("render-mode").addEventListener("click", () => {
  renderMode = renderMode === "whole" ? "chunked" : "whole";
  localStorage.setItem("mz-render-mode", renderMode);
  whole = null; gesture.active = false; gesture.snap = null;
  // The previous mode's build warning (e.g. whole-mode auto-fit) is stale.
  $("error").textContent = "";
  renderModeLabel();
  invalidate(null);
});
renderModeLabel();
// ---- Camera input: wheel zoom anchored at the cursor, drag to pan, click to inspect ----
const pointer = { id: null, startX: 0, startY: 0, camX: 0, camY: 0, moved: false };
$("map").addEventListener("pointerdown", event => {
  if (!bundle || event.button !== 0) return;
  pointer.id = event.pointerId; pointer.startX = event.clientX; pointer.startY = event.clientY;
  pointer.camX = camera.x; pointer.camY = camera.y; pointer.moved = false;
  $("map").setPointerCapture(event.pointerId);
  document.body.classList.add("panning");
});
$("map").addEventListener("pointermove", event => {
  if (pointer.id !== event.pointerId || !bundle) return;
  const dx = event.clientX - pointer.startX, dy = event.clientY - pointer.startY;
  if (!pointer.moved && Math.hypot(dx, dy) < 4) return;
  pointer.moved = true;
  beginGesture();
  camera.x = pointer.camX - dx / camera.scale;
  camera.y = pointer.camY - dy / camera.scale;
  clampCamera(); blitSnapshot(); settle(160);
});
function endPan(event) {
  if (pointer.id !== event.pointerId) return;
  pointer.id = null; document.body.classList.remove("panning");
  if (!pointer.moved) {
    if (bundle) {
      const rect = $("map").getBoundingClientRect();
      inspect(Math.floor((camera.x + (event.clientX - rect.left) / camera.scale) / bundle.tileSize),
        Math.floor((camera.y + (event.clientY - rect.top) / camera.scale) / bundle.tileSize));
    }
    return;
  }
  settle(60);
}
$("map").addEventListener("pointerup", endPan);
$("map").addEventListener("pointercancel", event => {
  if (pointer.id !== event.pointerId) return;
  pointer.id = null; document.body.classList.remove("panning");
  if (gesture.active) settle(0);
});
// Continuous wheel zoom: a smooth exponential factor, not fixed steps, and the
// world point under the cursor stays put.
$("map-wrap").addEventListener("wheel", event => {
  if (!bundle) return;
  event.preventDefault();
  beginGesture();
  const rect = $("map").getBoundingClientRect();
  const perTick = event.deltaMode === 1 ? 0.05 : 0.00125;
  zoomAt(Math.exp(-event.deltaY * perTick), event.clientX - rect.left, event.clientY - rect.top);
  blitSnapshot(); settle();
}, { passive: false });
$("zoom-in").addEventListener("click", () => {
  if (!bundle) return;
  beginGesture(); const view = viewport(); zoomAt(1.25, view.width / 2, view.height / 2); blitSnapshot(); settle(80);
});
$("zoom-out").addEventListener("click", () => {
  if (!bundle) return;
  beginGesture(); const view = viewport(); zoomAt(.8, view.width / 2, view.height / 2); blitSnapshot(); settle(80);
});
$("zoom-fit").addEventListener("click", () => { if (bundle) { fitCamera(); gesture.active = false; gesture.snap = null; refresh(); } });
// ---- Immersive full-map view: hide every panel, keep only the map ----
function enterImmersive() {
  document.body.classList.add("immersive");
  $("immersive-exit").hidden = false;
  if ($("map-wrap").requestFullscreen) $("map-wrap").requestFullscreen().catch(() => {});
  refresh();
}
function exitImmersive() {
  document.body.classList.remove("immersive");
  $("immersive-exit").hidden = true;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  refresh();
}
$("immersive").addEventListener("click", enterImmersive);
$("immersive-exit").addEventListener("click", exitImmersive);
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && document.body.classList.contains("immersive")) {
    document.body.classList.remove("immersive"); $("immersive-exit").hidden = true;
  }
  refresh();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && document.body.classList.contains("immersive")) exitImmersive();
});
for (const id of ["markers", "grid", "regions"]) $(id).addEventListener("change", () => refresh());
$("events").addEventListener("change", () => invalidate(null));
$("maps").addEventListener("change", () => { selection = null; enqueue(() => load()); });
$("refresh").addEventListener("click", () => {
  if (pending) { $("current-step").textContent = "仍有等待显示的步骤，请继续或单步完成后重新读取。"; return; }
  enqueue(() => load());
});
$("sheet").addEventListener("change", () => enqueue(redrawPalette));
$("palette").addEventListener("click", event => {
  if (!palette) return;
  const rect = $("palette").getBoundingClientRect(), size = bundle.tileSize;
  const column = Math.floor((event.clientX - rect.left) / (size + 8));
  const row = Math.floor((event.clientY - rect.top) / (size + 25));
  const tile = palette.tiles.find(t => t.column === column && t.row === row);
  if (tile) { $("selection").textContent = `${palette.sheet} · tile ID ${tile.tileId}`; $("detail").textContent = JSON.stringify(tile, null, 2); }
});
window.addEventListener("resize", () => { if (!gesture.active) refresh(); });
try {
  if (!token) throw new Error("请使用 MCP 返回的带 token 的预览地址打开。");
  const [info, focus] = await Promise.all([api("/api/info"), api("/api/focus")]);
  $("project-title").textContent = info.title || "本地 MZ 项目";
  await refreshMaps(); await load(focus.mapId);
  const stream = new EventSource(`/api/events?mapId=${focus.mapId}&token=${encodeURIComponent(token)}`);
  stream.onopen = () => { $("connection").textContent = "● 实时连接 · 逐步显示"; };
  stream.onerror = () => { $("connection").textContent = "○ 重连中"; };
  stream.onmessage = event => {
    const data = JSON.parse(event.data);
    if (data.type === "connected") { clientId = data.clientId; enqueue(ackView); return; }
    if (data.type === "demo_begin") {
      enqueue(async () => {
        bundle = structuredClone(data.bundle); $("maps").value = String(bundle.mapId);
        displayed = 0; currentFrame = null; lastFocus = null; $("edit-log").replaceChildren();
        $("current-step").textContent = "逐格编辑已开始 · 正等待第一步";
        $("play-panel").hidden = true; $("design-panel").hidden = false;
        fitCamera(); counts(); await invalidate(); await redrawPalette(); await ackView();
      }); return;
    }
    if (data.type === "demo_end") {
      enqueue(() => { $("current-step").textContent += " · 会话结束，可重播"; }); return;
    }
    if (data.type === "edit") { queueFrame(data); return; }
    if (data.type === "catalog") { enqueue(refreshMaps); return; }
    if (data.type === "focus") {
      enqueue(async () => {
        if (bundle?.mapId !== data.mapId) await load(data.mapId);
        if (data.x !== undefined) { selection = { x: data.x, y: data.y }; inspect(data.x, data.y); }
        await ackView();
      }); return;
    }
    if (data.type === "external" && data.mapId === bundle?.mapId) {
      enqueue(async () => {
        if (bundle.revision !== data.revision) {
          await load(data.mapId); $("current-step").textContent = "检测到外部文件编辑，已同步磁盘；外部写入不承诺保留中间帧。";
        }
      });
    }
    if (data.type === "playtest_step") $("connection").textContent = `试玩脚本 ${data.index}/${data.total} · ${data.caption}`;
  };
} catch (error) { $("connection").textContent = "未连接"; $("error").textContent = error.message; }
