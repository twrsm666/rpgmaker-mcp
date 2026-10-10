import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createService } from "../src/server.js";
import { copyTestProject } from "./test-project.js";
import { requiredEngine } from "./local-config.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const projectPath = await copyTestProject(path.join(root, "demo-project"), "modes");
const service = await createService({ projectPath, enginePath: requiredEngine() });
const report = [];
try {
  const browser = await service.capture.open();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(service.preview.previewUrl);
  await page.waitForFunction(() => document.getElementById("connection").textContent.includes("实时连接"));
  assert.equal(await page.evaluate(() => window.__mzPreview.mode()), "chunked", "default mode is chunked");
  assert.equal(await page.locator("#render-mode").textContent(), "分块渲染");
  report.push({ test: "defaults to chunked rendering", passed: true });
  // Switch to whole mode: one bitmap build, then a drag and a wheel zoom must
  // never rebuild it — settle is a pure blit.
  await page.locator("#render-mode").click();
  await page.waitForFunction(() => window.__mzPreview.mode() === "whole" && window.__mzPreview.wholeReady());
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("整图位图"));
  report.push({ test: "toggle builds the whole-map bitmap", passed: true });
  const beforeDrag = await page.evaluate(() => ({ ...window.__mzPreview.camera }));
  await page.mouse.move(700, 450);
  await page.mouse.down();
  await page.mouse.move(820, 520, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(expected => window.__mzPreview.camera.x < expected, beforeDrag.x);
  await page.waitForTimeout(400);
  assert.ok(await page.evaluate(() => window.__mzPreview.wholeReady()), "drag must not drop the bitmap");
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -150);
  await page.waitForTimeout(400);
  const zoomed = await page.evaluate(() => window.__mzPreview.camera.scale);
  assert.ok(zoomed > beforeDrag.scale, "wheel zoom works in whole mode");
  assert.ok(await page.evaluate(() => window.__mzPreview.wholeReady()), "zoom must not drop the bitmap");
  report.push({ test: "whole mode pans and zooms by pure blit", passed: true });
  // A small edit patches the bitmap instead of rebuilding.
  const before = await service.project.read(1);
  await service.project.paint(1, before.revision, { cells: [{ x: 5, y: 5, layer: 5, tileId: 9 }] });
  const revision = (await service.project.read(1)).revision;
  await page.waitForFunction(expected => document.getElementById("revision").textContent === expected, revision.slice(0, 12));
  assert.ok(await page.evaluate(() => window.__mzPreview.wholeReady()), "a step edit must patch, not drop, the bitmap");
  report.push({ test: "whole mode patches edits into the bitmap", passed: true });
  await page.locator("#render-mode").click();
  await page.waitForFunction(() => window.__mzPreview.mode() === "chunked");
  assert.equal(await page.locator("#render-mode").textContent(), "分块渲染");
  report.push({ test: "toggle returns to chunked rendering", passed: true });
  // The choice persists across a reload.
  await page.reload();
  await page.waitForFunction(() => document.getElementById("connection").textContent.includes("实时连接"));
  assert.equal(await page.evaluate(() => window.__mzPreview.mode()), "chunked");
  await page.evaluate(() => localStorage.setItem("mz-render-mode", "whole"));
  await page.reload();
  await page.waitForFunction(() => document.getElementById("connection").textContent.includes("实时连接"));
  await page.waitForFunction(() => window.__mzPreview.mode() === "whole");
  report.push({ test: "mode choice persists via localStorage", passed: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ verified: true, passed: report.length }, null, 2));
} finally { await service.close(); }
