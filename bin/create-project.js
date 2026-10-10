#!/usr/bin/env node
// Create a fresh, empty RPG Maker MZ project from the local engine's newdata
// template. The native editor's own "New Project" does the same copy; this
// script makes it scriptable for agents. Refuses to overwrite an existing
// directory.
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { Project } from "../src/project.js";

const { values } = parseArgs({ options: {
  engine: { type: "string" }, output: { type: "string" }, title: { type: "string" } } });
if (!values.engine || !values.output) throw new Error("Usage: node bin/create-project.js --engine <local MZ installation> --output <new directory> [--title <game title>]");
const output = path.resolve(values.output);
try { await fs.access(output); throw new Error(`Refusing to overwrite existing directory: ${output}`); } catch (e) { if (e.code !== "ENOENT") throw e; }
const template = path.join(path.resolve(values.engine), "data", "newdata");
await fs.cp(template, output, { recursive: true, errorOnExist: true, force: false });
await fs.writeFile(path.join(output, "Game.rmmzproject"), "RPGMZ 1.0.0");
// The template ships no NW.js manifest; the native editor writes one like this.
const title = values.title || path.basename(output);
await fs.writeFile(path.join(output, "package.json"),
  JSON.stringify({ name: path.basename(output).toLowerCase().replace(/[^a-z0-9-]+/g, "-"), main: "index.html",
    window: { title, width: 1000, height: 740, icon: "icon/icon.png" } }, null, 2));
if (values.title) {
  const systemFile = path.join(output, "data", "System.json");
  const system = JSON.parse(await fs.readFile(systemFile, "utf8"));
  system.gameTitle = values.title;
  // The 1.8.1 template omits these; Project.open would repair windowOpacity,
  // but a complete project should not need repairs in the first place.
  system.advanced = { ...system.advanced, windowOpacity: system.advanced?.windowOpacity ?? 192,
    screenScale: system.advanced?.screenScale ?? 1 };
  system.tileSize ??= 48;
  await fs.writeFile(systemFile, JSON.stringify(system) + "\n");
}
// Opening through Project validates the whole template and leaves the journal
// directory in place, exactly as the MCP server will find it on first start.
await Project.open(output, values.engine);
console.log(output);
