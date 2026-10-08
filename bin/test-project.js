import fs from "node:fs/promises";
import path from "node:path";
import { testWork } from "./local-config.js";

// Integration tests always mutate disposable task-owned copies, never the
// supplied source project. No journals or credentials are copied.
export async function copyTestProject(source, label, { runtime = false } = {}) {
  const work = testWork;
  await fs.mkdir(work, { recursive: true });
  const target = await fs.mkdtemp(path.join(work, `mz-${label}-`));
  for (const folder of ["data", "img", "js", ...(runtime ? ["audio", "effects", "fonts", "css", "icon"] : [])]) {
    await fs.cp(path.join(source, folder), path.join(target, folder), { recursive: true, force: false, errorOnExist: true });
  }
  if (runtime) for (const file of ["index.html", "package.json"]) {
    await fs.copyFile(path.join(source, file), path.join(target, file));
  }
  return target;
}
