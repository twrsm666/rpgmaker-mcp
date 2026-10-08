import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const runtimeRoot = fileURLToPath(new URL("../runtime/", import.meta.url));
export async function prepareNativeRuntime(enginePath) {
  if (process.platform !== "win32") throw new Error("Native runtime preparation currently supports Windows only.");
  if (!enginePath) throw new Error("Supply --engine for the local licensed NW.js runtime.");
  const source = await fs.realpath(path.join(enginePath, "data", "nwjs-win"));
  const original = await fs.readFile(path.join(source, "nw.exe"));
  const hash = crypto.createHash("sha256").update(original).digest("hex");
  await fs.mkdir(runtimeRoot, { recursive: true });
  const destination = path.join(runtimeRoot, `nwjs-${hash.slice(0, 12)}`);
  const executable = path.join(destination, "nw.exe");
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(destination, "local-copy.json"), "utf8"));
    if (manifest.sha256 === hash && crypto.createHash("sha256").update(await fs.readFile(executable)).digest("hex") === hash)
      return { executable, directory: destination, source, reused: true };
    throw new Error("Existing private runtime checksum does not match. Refusing to overwrite it.");
  } catch (e) { if (e.code !== "ENOENT") throw e; }
  // Copies file contents into a newly created task-owned directory, inheriting
  // that directory's default security. Never changes source ACLs/integrity,
  // disables Windows controls, or upgrades/downloads an executable.
  await fs.cp(source, destination, { recursive: true, force: false, errorOnExist: true,
    filter: filename => !["debug.log", "chromedriver.exe", "nwjc.exe"].includes(path.basename(filename)) });
  const copyHash = crypto.createHash("sha256").update(await fs.readFile(executable)).digest("hex");
  if (copyHash !== hash) throw new Error("Copied NW.js executable checksum mismatch.");
  await fs.writeFile(path.join(destination, "local-copy.json"), JSON.stringify({
    source, sha256: hash, created: new Date().toISOString(), note: "Private copy from local licensed installation; not a distributable service asset."
  }, null, 2), { flag: "wx" });
  return { executable, directory: destination, source, reused: false };
}
