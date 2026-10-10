import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createService } from "../src/server.js";
import { copyTestProject } from "./test-project.js";
import { requiredEngine } from "./local-config.js";

// Positive control for the unlimited-size work: every step below was rejected
// or errored by the 0.5.0 code paths (255/256 schema caps, 16M canvas guard).
const root = fileURLToPath(new URL("../", import.meta.url));
const projectPath = await copyTestProject(path.join(root, "demo-project"), "large");
const service = await createService({ projectPath, enginePath: requiredEngine() });
const report = [];
const verify = path.join(root, "verification");
try {
  const catalogRevision = (await service.project.info()).catalogRevision;
  // 300x280 exceeds the old 256x256 cap in both dimensions.
  await service.project.createMap({ mapId: 2, expectedCatalogRevision: catalogRevision,
    name: "超大验证图", width: 300, height: 280, tilesetId: 2 });
  report.push({ test: "create_map accepts 300x280 (was capped at 256x256)", passed: true });
  const { revision } = await service.project.read(2);
  await service.project.paint(2, revision, {
    // Coordinates past 255 in both axes; A2 ground autotile, retiled by paint.
    rectangles: [
      { x: 250, y: 240, width: 50, height: 40, layer: 0, tileId: 2816, expectedSheet: "A2" },
      { x: 296, y: 276, width: 4, height: 4, layer: 1, tileId: 4352, expectedSheet: "A3" }
    ]
  });
  report.push({ test: "paint_tiles writes cells at x/y >= 250 (was capped at 255)", passed: true });
  const painted = await service.project.inspect(2, 299, 279);
  assert.ok(painted.layers.some(layer => layer.tileId !== 0), "far corner cell must hold a tile");
  const { revision: revision2 } = await service.project.read(2);
  await service.project.edit(2, revision2, map => {
    const event = { id: 1, name: "边陲哨兵", x: 288, y: 264, note: "",
      pages: [{ conditions: { actorId: 1, actorValid: false, itemId: 1, itemValid: false, selfSwitchCh: "A", selfSwitchValid: false,
        switch1Id: 1, switch1Valid: false, switch2Id: 1, switch2Valid: false, variableId: 1, variableValid: false, variableValue: 0 },
        directionFix: false, image: { characterIndex: 0, characterName: "", direction: 2, pattern: 1, tileId: 0 },
        list: [{ code: 0, indent: 0, parameters: [] }],
        moveFrequency: 3, moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
        moveSpeed: 3, moveType: 0, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: true }] };
    map.events[1] = event;
  }, "far-event");
  report.push({ test: "event placed at (288, 264) beyond the old 255 bound", passed: true });
  // Whole-map render: 300x280 tiles was a hard "Render too large" error before;
  // now the overview auto-fits and the compositor works in blocks.
  const overview = await service.capture.render({ mapId: 2, eventMarkers: true });
  assert.ok(overview.buffer.length > 1000, "overview PNG must have content");
  assert.ok(Math.max(overview.pixelWidth, overview.pixelHeight) <= 16384, "fitted overview stays inside the canvas budget");
  assert.ok((overview.warnings || []).some(line => /fitted/.test(line)), `auto-fit must announce itself: ${JSON.stringify(overview.warnings)}`);
  await fs.writeFile(path.join(verify, "large-overview.png"), overview.buffer);
  report.push({ test: `whole-map render auto-fits 300x280 (scale ${overview.scale.toFixed(3)})`, passed: true });
  const detail = await service.capture.render({ mapId: 2, region: { x: 270, y: 249, width: 30, height: 30 }, scale: 4 });
  assert.ok(detail.buffer.length > 1000, "far-corner detail PNG must have content");
  await fs.writeFile(path.join(verify, "large-detail.png"), detail.buffer);
  report.push({ test: `far-corner region render at x=270 (scale ${detail.scale.toFixed(3)})`, passed: true });
  // Live observer: the browser must browse the big map through the camera
  // without ever allocating a full-map canvas.
  const browser = await service.capture.open();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(service.preview.previewUrl);
  await page.waitForFunction(() => document.getElementById("connection").textContent.includes("实时连接"));
  await page.evaluate(() => window.__mzPreview && window.__mzPreview.camera);
  const focus = await service.preview.focus({ mapId: 2 });
  await page.waitForFunction(() => document.getElementById("map-label").textContent.includes("300 × 280"));
  const canvasSize = await page.evaluate(() => ({ w: document.getElementById("map").width, h: document.getElementById("map").height,
    scale: window.__mzPreview.camera.scale }));
  assert.ok(canvasSize.w <= 2000 && canvasSize.h <= 1400,
    `browser canvas stays viewport-sized on a 300x280 map (${canvasSize.w}x${canvasSize.h})`);
  assert.ok(canvasSize.scale < 1, "big map must fit-zoom below 100% on load");
  const mapWrap = await page.locator("#map-wrap").boundingBox();
  await page.mouse.move(mapWrap.x + mapWrap.width / 2, mapWrap.y + mapWrap.height / 2);
  // From fit (~0.05 on a 300x280 map) past 100%: each wheel multiplies by
  // exp(200*0.00125) ≈ 1.284, so fourteen notches cross scale 1.
  for (let i = 0; i < 14; i++) await page.mouse.wheel(0, -200);
  await page.waitForFunction(() => window.__mzPreview.camera.scale > 1);
  await page.locator("#immersive").click();
  await page.waitForFunction(() => document.body.classList.contains("immersive"));
  await page.screenshot({ path: path.join(verify, "large-immersive.png") });
  assert.deepEqual(errors, []);
  report.push({ test: "observer browses 300x280 via camera; zoom-in and immersive stay error-free", passed: true });
  await fs.writeFile(path.join(verify, "large-report.json"), JSON.stringify({ verified: true, report }, null, 2));
  console.log(JSON.stringify({ verified: true, passed: report.length }, null, 2));
} finally { await service.close(); }
