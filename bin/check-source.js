import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
let count = 0;
for (const directory of ["src", "preview", "bin", "test", "plugin"]) {
  for (const file of await fs.readdir(path.join(root, directory))) {
    if (!file.endsWith(".js")) continue;
    execFileSync(process.execPath, ["--check", path.join(root, directory, file)], { stdio: "pipe", windowsHide: true });
    count++;
  }
}
console.log(`Syntax checks passed: ${count} JavaScript files.`);
