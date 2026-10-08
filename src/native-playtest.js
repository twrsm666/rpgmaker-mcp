import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareNativeRuntime } from "./native-runtime.js";
const execute = promisify(execFile);

export async function stopNativeProcess(game) {
  if (!game) return;
  if (process.platform === "win32" && game.exitCode === null) {
    // Stop only the exact process tree started by this launcher. Killing just
    // its parent leaves NW.js renderers holding stdout/stderr pipes open.
    await execute("taskkill.exe", ["/PID", String(game.pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
  } else if (game.exitCode === null) game.kill();
  game.stdout?.destroy(); game.stderr?.destroy();
}

export class NativePlaytest {
  constructor(project, runtime) {
    this.project = project; this.runtime = runtime; this.game = null;
  }
  async start() {
    if (this.game && this.game.exitCode === null) throw new Error("Native playtest already running.");
    const pluginsSource = await fs.readFile(await this.project.file("js/plugins.js"), "utf8");
    const match = /(?:var|let|const)\s+\$plugins\s*=\s*(\[[\s\S]*\])\s*;?\s*$/.exec(pluginsSource);
    if (!match || !JSON.parse(match[1]).some(plugin => plugin.name === "MZVisualBridge" && plugin.status)) {
      throw new Error("Enable MZVisualBridge first: node bin/install-bridge.js --project <project> --enable. Existing files are backed up; custom plugin registration requires manual enablement.");
    }
    await this.project.file("js/plugins/MZVisualBridge.js");
    const prepared = await prepareNativeRuntime(this.project.engine);
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), "mz-native-playtest-"));
    const before = new Set(this.runtime.status().map(item => item.sessionId));
    this.game = spawn(prepared.executable,
      [this.project.root, "test", `--user-data-dir=${profile}`, `--log-file=${path.join(profile, "nw.log")}`, "--enable-logging"],
      { cwd: this.project.root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let diagnostic = "";
    this.game.stdout.on("data", chunk => { diagnostic = (diagnostic + chunk).slice(-12000); });
    this.game.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk).slice(-12000); });
    this.game.on("error", e => { diagnostic += e.message; });
    const started = Date.now();
    try {
      while (Date.now() - started < 30000) {
        const session = this.runtime.status().find(item => item.online && !before.has(item.sessionId) &&
          ["Scene_Title", "Scene_Map"].includes(item.state?.scene));
        if (session) return { ...session, transport: "nwjs", executable: prepared.executable, profile,
          note: "Native desktop test play; runtime_copy inherits service-directory permissions, original installation unchanged." };
        if (this.game.exitCode !== null) throw new Error(`Native NW.js exited with ${this.game.exitCode}: ${diagnostic}`);
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw new Error(`Native plugin did not register in 30 seconds. Check ${path.join(profile, "nw.log")}`);
    } catch (e) { await this.close(); throw e; }
  }
  async close() { await stopNativeProcess(this.game); this.game = null; }
}
