import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { copyTestProject } from "./test-project.js";
import { requiredEngine, serviceRoot } from "./local-config.js";
import { Capture } from "../src/capture.js";

const engine = requiredEngine();
const projectPath = await copyTestProject(path.join(serviceRoot, "demo-project"), "steps");
const client = new Client({ name: "step-observer-test", version: "1.0.0" });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [path.join(serviceRoot, "src/server.js"), "--project", projectPath, "--engine", engine], stderr: "pipe" });
const report = [];
let capture;
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${result.content[0].text}`);
  return JSON.parse(result.content.find(c => c.type === "text").text);
};
try {
  await client.connect(transport);
  const info = await call("project_info");
  const url = new URL(info.previewUrl);
  capture = new Capture({ url: url.origin, token: new URLSearchParams(url.hash.slice(1)).get("token") });
  const browser = await capture.open();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(info.previewUrl);
  await page.waitForFunction(() => document.getElementById("connection").textContent.includes("逐步显示"));
  const editor = await call("open_editor", { mapId: 1, holdMs: 160, awaitVisible: true });
  const first = await call("putground", { editorId: editor.editorId, x: 1, y: 1, high: 5, num: 1 });
  assert.equal(first.presentation.status, "rendered");
  assert.equal(await page.locator("#map").getAttribute("data-revision"), first.revision);
  report.push({ test: "one call commits one cell and waits for exact rendered revision", passed: true });

  await page.locator("#pause-steps").click();
  let resolved = false;
  const next = call("putground", { editorId: editor.editorId, x: 2, y: 1, high: 5, num: 2 })
    .then(result => { resolved = true; return result; });
  await page.waitForFunction(() => document.getElementById("step-count").textContent.includes("等待 1 步"));
  assert.equal(resolved, false);
  assert.equal((await call("inspect_cell", { mapId: 1, x: 2, y: 1 })).region, 2);
  assert.equal(await page.locator("#map").getAttribute("data-revision"), first.revision);
  await page.locator("#next-step").click();
  const second = await next;
  assert.equal(second.presentation.status, "rendered");
  assert.equal(await page.locator("#map").getAttribute("data-revision"), second.revision);
  await page.locator("#pause-steps").click();
  report.push({ test: "paused step is saved but not displayed until single-step", passed: true });

  const event = await call("put_event", { editorId: editor.editorId, x: 2, y: 2, name: "Step Guide",
    text: "Commands must survive moving and changing the sprite.", image: { characterName: "People1", characterIndex: 0 } });
  const prior = (await call("inspect_cell", { mapId: 1, x: 2, y: 2 })).events[0];
  await call("move_event", { editorId: editor.editorId, eventId: event.eventId, x: 3, y: 2 });
  await call("set_event_image", { editorId: editor.editorId, eventId: event.eventId,
    image: { characterName: "People1", characterIndex: 1, direction: 4 } });
  const moved = (await call("inspect_cell", { mapId: 1, x: 3, y: 2 })).events[0];
  assert.deepEqual(moved.pages[0].list, prior.pages[0].list);
  assert.equal(moved.pages[0].image.direction, 4);
  await call("close_editor", { editorId: editor.editorId });
  await page.waitForFunction(() => document.getElementById("current-step").textContent.includes("会话结束"));
  report.push({ test: "event add/move/image steps preserve logic and render sequentially", passed: true });

  const revision = (await call("read_map", { mapId: 1 })).revision;
  await page.locator("#step-speed").selectOption("0");
  await page.locator("#replay-steps").click();
  await page.waitForFunction(() => document.getElementById("current-step").textContent.includes("本轮回放完成"));
  assert.equal((await call("read_map", { mapId: 1 })).revision, revision);
  assert.equal(await page.locator("#map").getAttribute("data-revision"), revision);
  assert.equal(await page.locator("#map").getAttribute("data-displayed-steps"), "5");
  report.push({ test: "replay shows all five exact revisions without writing map", passed: true });
  assert.deepEqual(errors, []);
  const out = path.join(serviceRoot, "verification");
  await fs.mkdir(out, { recursive: true });
  await page.screenshot({ path: path.join(out, "step-observer.png") });
  await fs.writeFile(path.join(out, "step-report.json"), JSON.stringify({ verified: true, report }, null, 2));
  console.log(JSON.stringify({ verified: true, passed: report.length }));
} finally { await capture?.close(); await client.close(); }
