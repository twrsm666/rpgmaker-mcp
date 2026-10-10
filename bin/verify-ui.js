import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createService } from "../src/server.js";
import { copyTestProject } from "./test-project.js";
import { requiredEngine } from "./local-config.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const projectPath = await copyTestProject(path.join(root, "demo-project"), "ui");
const enginePath = requiredEngine();
const service = await createService({ projectPath, enginePath });
const report = [];
try {
  const browser = await service.capture.open();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(service.preview.previewUrl);
  await page.waitForFunction(() => document.getElementById("connection").textContent.includes("实时连接"));
  const tileSize = (await service.project.info()).tileSize;
  const cameraState = () => page.evaluate(() => ({ ...window.__mzPreview.camera }));
  const cellCenter = (x, y) => page.evaluate(([cx, cy, size]) => {
    const camera = window.__mzPreview.camera;
    return { x: (cx * size - camera.x) * camera.scale + size * camera.scale / 2,
      y: (cy * size - camera.y) * camera.scale + size * camera.scale / 2 };
  }, [x, y, tileSize]);
  await page.locator("#map").click({ position: await cellCenter(16, 17) });
  await page.waitForFunction(() => document.getElementById("selection").textContent.includes("(16, 17)"));
  assert.ok((await page.locator("#detail").textContent()).includes("layers"));
  report.push({ test: "map click selects the real six-layer cell under the cursor", passed: true });
  // Continuous wheel zoom anchored at the cursor: the world point under the
  // pointer must stay fixed while the scale changes by a non-preset factor.
  const fit = await cameraState();
  const rect = await page.evaluate(() => {
    const box = document.getElementById("map").getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  });
  const mouse = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  const anchorWorld = await page.evaluate(({ x, y }) => {
    const camera = window.__mzPreview.camera;
    return { x: camera.x + x / camera.scale, y: camera.y + y / camera.scale };
  }, { x: mouse.x - rect.left, y: mouse.y - rect.top });
  await page.mouse.move(mouse.x, mouse.y);
  await page.mouse.wheel(0, -240);
  await page.mouse.wheel(0, -110);
  const zoomed = await page.waitForFunction(async () => {
    const camera = window.__mzPreview.camera;
    return camera.scale;
  }, undefined, { timeout: 5000 }).then(handle => handle.jsonValue());
  assert.ok(zoomed > fit.scale * 1.2, `wheel zoom must increase scale continuously (${fit.scale} → ${zoomed})`);
  const afterZoom = await cameraState();
  const drift = Math.hypot(afterZoom.x + (mouse.x - rect.left) / afterZoom.scale - anchorWorld.x,
    afterZoom.y + (mouse.y - rect.top) / afterZoom.scale - anchorWorld.y);
  assert.ok(drift < 1, `zoom anchor must stay under the cursor (drift ${drift.toFixed(2)}px)`);
  report.push({ test: "wheel zoom is continuous and cursor-anchored", passed: true });
  // Left-button drag pans the map; a drag must not fire a cell selection.
  const beforeDrag = await cameraState();
  await page.mouse.move(mouse.x, mouse.y);
  await page.mouse.down();
  await page.mouse.move(mouse.x + 120, mouse.y + 80, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(expected => window.__mzPreview.camera.x < expected, beforeDrag.x);
  assert.equal(await page.locator("#selection").textContent(), "格子 (16, 17)", "dragging must not change the selection");
  report.push({ test: "left-button drag pans the camera without selecting", passed: true });
  await page.locator("#zoom-fit").click();
  await page.locator("#grid").check();
  await page.locator("#immersive").click();
  await page.waitForFunction(() => document.body.classList.contains("immersive"));
  const visibility = await page.evaluate(() => {
    // getComputedStyle on descendants of a display:none subtree still reports
    // their own display, so visibility is checked through checkVisibility().
    const panels = [...document.querySelectorAll("header, footer, aside, .bar, .step-toolbar, #current-step, .palette-wrap")]
      .filter(element => element.isConnected);
    const map = document.getElementById("map");
    const box = map.getBoundingClientRect();
    return { panels: panels.map(element => !element.checkVisibility()),
      mapVisible: map.checkVisibility(),
      mapBox: { width: box.width, height: box.height },
      viewport: { width: window.innerWidth, height: window.innerHeight } };
  });
  assert.ok(visibility.panels.length >= 8 && visibility.panels.every(Boolean),
    "immersive mode must hide every non-map panel");
  assert.ok(visibility.mapVisible && visibility.mapBox.width >= visibility.viewport.width - 2 &&
    visibility.mapBox.height >= visibility.viewport.height - 2,
    `immersive map must fill the viewport (${visibility.mapBox.width}x${visibility.mapBox.height} in ${visibility.viewport.width}x${visibility.viewport.height})`);
  report.push({ test: "immersive mode shows only the map, filling the viewport", passed: true });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.body.classList.contains("immersive"));
  report.push({ test: "Escape leaves immersive mode", passed: true });
  const diskBefore = await service.project.read(1);
  await service.project.paint(1, diskBefore.revision, { cells: [{ x: 16, y: 18, layer: 5, tileId: 11 }] });
  const revision = (await service.project.read(1)).revision;
  await page.waitForFunction(expected => document.getElementById("revision").textContent === expected, revision.slice(0, 12));
  report.push({ test: "MCP disk update triggers live browser revision refresh", passed: true });
  await page.locator("#sheet").selectOption("B");
  await page.waitForFunction(() => document.getElementById("palette").height > 1000);
  await page.locator("#palette").click({ position: { x: 2 * (tileSize + 8) + (tileSize + 8) / 2, y: 12 * (tileSize + 25) + (tileSize + 25) / 2 } });
  await page.waitForFunction(() => document.getElementById("selection").textContent.includes("tile ID 98"));
  report.push({ test: "actual palette cell selects matching MZ ID", passed: true });
  await page.locator("#map").click({ position: await cellCenter(16, 17) });
  await page.screenshot({ path: path.join(root, "verification", "observer-panel.png"), fullPage: false });
  assert.deepEqual(errors, []);
  const width = 360;
  await page.setViewportSize({ width, height: 850 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false);
  report.push({ test: "360px responsive panel has no document overflow", passed: true });
  await fs.writeFile(path.join(root, "verification", "ui-report.json"), JSON.stringify({ verified: true, report }, null, 2));
  console.log(JSON.stringify({ verified: true, passed: report.length }, null, 2));
} finally { await service.close(); }
