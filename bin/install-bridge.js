import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { Project } from "../src/project.js";

const { values } = parseArgs({ options: { project: { type: "string" }, engine: { type: "string" }, enable: { type: "boolean", default: false } } });
if (!values.project) throw new Error("Usage: node bin/install-bridge.js --project <MZ project> [--engine <MZ installation>]");
const project = await Project.open(values.project, values.engine);
await fs.mkdir(path.join(project.root, "js", "plugins"), { recursive: true });
const target = await project.file("js/plugins/MZVisualBridge.js", true);
const source = await fs.readFile(fileURLToPath(new URL("../plugin/MZVisualBridge.js", import.meta.url)));
await project.journalDirectory();
const suffix = Date.now().toString();
try {
  const previous = await fs.readFile(target);
  if (!source.equals(previous)) {
    await fs.writeFile(path.join(project.journal, `MZVisualBridge-${suffix}.js.bak`), previous, { flag: "wx" });
    await fs.writeFile(target, source);
  }
} catch (e) { if (e.code !== "ENOENT") throw e; await fs.writeFile(target, source, { flag: "wx" }); }
if (values.enable) {
  const pluginsFile = await project.file("js/plugins.js");
  const previous = await fs.readFile(pluginsFile);
  const match = /((?:var|let|const)\s+\$plugins\s*=\s*)(\[[\s\S]*\])(\s*;?\s*)$/.exec(previous.toString());
  if (!match) throw new Error("Custom js/plugins.js cannot be safely rewritten; enable MZVisualBridge manually in Plugin Manager.");
  const plugins = JSON.parse(match[2]);
  const existing = plugins.find(plugin => plugin.name === "MZVisualBridge");
  if (existing) existing.status = true;
  else plugins.push({ name: "MZVisualBridge", status: true, description: "Local visual MCP test-play bridge", parameters: {} });
  const next = previous.toString().slice(0, match.index) + match[1] + JSON.stringify(plugins, null, 2) + match[3];
  if (next !== previous.toString()) {
    await fs.writeFile(path.join(project.journal, `plugins-${suffix}.js.bak`), previous, { flag: "wx" });
    await fs.writeFile(pluginsFile, next);
  }
  console.log("Bridge enabled; previous files backed up in .rpg-mcp. Start the MCP service with --live-bridge.");
} else console.log("Bridge plugin installed/updated with backup; js/plugins.js unchanged. Enable it in Plugin Manager or use --enable.");
