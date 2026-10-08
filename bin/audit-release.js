import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const excluded = new Set(["node_modules", "runtime", "demo-project", "verification", ".work", ".git", "dist"]);
const allowed = new Set([".js", ".cjs", ".json", ".md", ".html", ".css", ".yml", ".yaml", ".png"]);
const required = [
  "package.json", "package-lock.json", "README.md", "LICENSE",
  "src/server.js", "src/preview-server.js", "preview/index.html",
  "plugin/MZVisualBridge.js", "bin/local-config.js", "bin/audit-release.js"
];
const violations = [];
let count = 0;
async function walk(directory) {
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, item.name), relative = path.relative(root, full);
    if (item.isSymbolicLink()) { violations.push(`${relative}: symbolic link not allowed in source release`); continue; }
    if (item.isDirectory()) {
      if (!excluded.has(item.name)) {
        if (item.name === ".rpg-mcp") violations.push(`${relative}: project connection directory`);
        else await walk(full);
      }
      continue;
    }
    count++;
    if (!allowed.has(path.extname(item.name)) && !["LICENSE", ".gitignore", ".gitattributes"].includes(item.name))
      violations.push(`${relative}: unapproved extension`);
    if (/^(rmmz_.*\.js|nw\.exe|Map\d+\.json|Tilesets\.json|System\.json|connection\.json)$/i.test(item.name))
      violations.push(`${relative}: engine/project artifact`);
    const text = await fs.readFile(full, "utf8");
    if (/[A-Z]:\\(?:Users|Documents and Settings)\\[^\\"]+/i.test(text) ||
        /\/(?:home|Users)\/[^/"']+\//.test(text))
      violations.push(`${relative}: local-machine path`);
    if (/(?:[#?&]token=)[a-f0-9]{64}|"(?:token|clientId|sessionId)"\s*:\s*"[a-f0-9-]{32,64}"/i.test(text))
      violations.push(`${relative}: runtime credential/identity`);
  }
}
await walk(root);
for (const file of required) {
  if (!await fs.stat(path.join(root, file)).then(stat => stat.isFile(), () => false))
    violations.push(`${file}: required release file missing`);
}
if (violations.length) { console.error(violations.join("\n")); process.exitCode = 1; }
else console.log(`Release audit passed: ${count} source/document files; no bundled assets, private paths or runtime tokens.`);
