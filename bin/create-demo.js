#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { Project, makeEvent } from "../src/project.js";
import { retile } from "../src/engine.js";

const { values } = parseArgs({ options: { engine: { type: "string" }, output: { type: "string" } } });
if (!values.engine) throw new Error("Usage: node bin/create-demo.js --engine <local MZ installation> [--output <new directory>]");
const output = path.resolve(values.output || fileURLToPath(new URL("../demo-project", import.meta.url)));
try { await fs.access(output); throw new Error("Refusing to overwrite existing demo directory"); } catch (e) { if (e.code !== "ENOENT") throw e; }
const template = path.join(path.resolve(values.engine), "data", "newdata");
await fs.cp(template, output, { recursive: true, errorOnExist: true, force: false });
await fs.writeFile(path.join(output, "Game.rmmzproject"), "RPGMZ 1.0.0");
await fs.writeFile(path.join(output, "package.json"), JSON.stringify({ name: "mz-mcp-demo", main: "index.html", window: { title: "MZ MCP Demo", width: 1000, height: 740, icon: "icon/icon.png" } }, null, 2));
const project = await Project.open(output, values.engine);
const { map, revision } = await project.read(1);
await project.edit(1, revision, next => {
  next.width = 32; next.height = 24; next.tilesetId = 2; next.displayName = "溪畔工坊";
  next.data = Array(32 * 24 * 6).fill(0); next.events = [null];
  const fill = (x, y, w, h, tile, z = 0) => {
    for (let dy = y; dy < y + h; dy++) for (let dx = x; dx < x + w; dx++) next.data[(z * next.height + dy) * next.width + dx] = tile;
  };
  fill(0, 0, 32, 24, 2816); // all selections must later be inspected using actual local palette
  fill(2, 2, 7, 4, 2048);
  fill(14, 0, 4, 24, 2912);
  fill(0, 15, 32, 3, 2912);
  fill(6, 7, 7, 4, 4352, 1); fill(6, 11, 7, 3, 4736, 1);
  fill(21, 6, 6, 4, 4448, 1); fill(21, 10, 6, 3, 4832, 1);
  next.events[1] = makeEvent({ id: 1, name: "工坊向导", x: 15, y: 14, image: { characterName: "People1", characterIndex: 0 },
    text: "欢迎来到溪畔工坊。\n这里的地图可以通过 MCP 观察并迭代修改。" });
  next.events[2] = makeEvent({ id: 2, name: "建筑入口标记", x: 9, y: 13, text: "这里可以设置传送到室内地图的事件。" });
  retile(next, project.Tilemap);
}, "demo-layout");
const systemFile = path.join(output, "data", "System.json");
const system = JSON.parse(await fs.readFile(systemFile, "utf8"));
system.gameTitle = "溪畔工坊 · MZ MCP 演示"; system.startMapId = 1; system.startX = 16; system.startY = 17;
// This local installation ships an older data template alongside 1.8.1 core.
// MZ's native project creator normally fills these fields.
system.advanced.windowOpacity ??= 192;
system.advanced.screenScale ??= 1;
system.tileSize ??= 48;
await fs.writeFile(systemFile, JSON.stringify(system) + "\n");
console.log(output);
