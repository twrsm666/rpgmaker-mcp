import { getBundle, drawMap, drawPalette } from "/renderer.js";
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
async function redraw() {
  if (!bundle) return;
  const fit = Math.max(.1, Math.min(1, ($("map-wrap").clientWidth - 40) / (bundle.map.width * bundle.tileSize)));
  const meta = await drawMap($("map"), bundle, token, {
    scale: $("zoom").value === "fit" ? fit : Number($("zoom").value),
    grid: $("grid").checked, events: $("events").checked, eventMarkers: $("markers").checked,
    regions: $("regions").checked
  });
  if (meta.warnings.length) $("error").textContent = meta.warnings.join("\n");
  const canvas = $("map"), ctx = canvas.getContext("2d"), size = bundle.tileSize * meta.scale;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const [focus, color] of [[lastFocus?.from, "#81b6c6"], [lastFocus?.focus, "#ffcf70"]]) if (focus) {
    ctx.strokeStyle = color; ctx.lineWidth = 3;
    ctx.strokeRect(focus.x * size + 1.5, focus.y * size + 1.5, size - 3, size - 3);
  }
  canvas.dataset.revision = bundle.revision;
  canvas.dataset.changeId = currentFrame?.changeId || "";
  canvas.dataset.displayedSteps = String(displayed);
  updateDetails();
}
async function redrawPalette() {
  if (!bundle) return;
  try { palette = await drawPalette($("palette"), bundle, token, { sheet: $("sheet").value }); }
  catch (error) { palette = null; $("palette").width = 1; $("palette").height = 1; $("status").textContent = error.message; }
}
async function load(mapId = Number($("maps").value)) {
  $("error").textContent = ""; bundle = await getBundle(mapId, token);
  $("maps").value = String(mapId); currentFrame = null; lastFocus = null;
  await redraw(); await redrawPalette(); await ackView();
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
async function gate() {
  while (paused && permits === 0) await wait(40);
  if (paused) permits--;
}
async function showFrame(frame, replay = false) {
  await gate();
  pending = Math.max(0, pending - 1);
  if (bundle?.mapId !== frame.mapId) { counts(); return; }
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
  counts(); await redraw();
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
      displayed = 0; $("edit-log").replaceChildren(); lastFocus = null; currentFrame = null; await redraw();
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
  $("play-panel").hidden = true; $("design-panel").hidden = false; enqueue(redraw);
});
for (const id of ["zoom", "grid", "events", "markers", "regions"]) $(id).addEventListener("change", () => enqueue(redraw));
$("maps").addEventListener("change", () => { selection = null; enqueue(() => load()); });
$("refresh").addEventListener("click", () => {
  if (pending) { $("current-step").textContent = "仍有等待显示的步骤，请继续或单步完成后重新读取。"; return; }
  enqueue(() => load());
});
$("sheet").addEventListener("change", () => enqueue(redrawPalette));
$("map").addEventListener("click", event => {
  if (!bundle) return;
  const rect = $("map").getBoundingClientRect();
  inspect(Math.floor((event.clientX - rect.left) / rect.width * bundle.map.width),
    Math.floor((event.clientY - rect.top) / rect.height * bundle.map.height));
});
$("palette").addEventListener("click", event => {
  if (!palette) return;
  const rect = $("palette").getBoundingClientRect(), size = bundle.tileSize;
  const column = Math.floor((event.clientX - rect.left) / (size + 8));
  const row = Math.floor((event.clientY - rect.top) / (size + 25));
  const tile = palette.tiles.find(t => t.column === column && t.row === row);
  if (tile) { $("selection").textContent = `${palette.sheet} · tile ID ${tile.tileId}`; $("detail").textContent = JSON.stringify(tile, null, 2); }
});
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
        counts(); await redraw(); await redrawPalette(); await ackView();
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
  window.addEventListener("resize", () => { if ($("zoom").value === "fit") enqueue(redraw); });
} catch (error) { $("connection").textContent = "未连接"; $("error").textContent = error.message; }
