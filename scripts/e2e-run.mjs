/**
 * `npm run e2e` with the paths your environment already declares.
 *
 *   npm run e2e                              # project and corescript from env or settings
 *   npm run e2e -- <project-dir> <corescript-root>
 *
 * `dist/e2e.js` itself still wants both paths as argv, because it is what
 * `npm run verify:full` calls with them. Every other suite reads the same three values
 * from the environment (`scripts/local-env.mjs`), so having this one print a usage line
 * at a reader who followed the README was a trap, not a requirement.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { PACKAGE_ROOT, corescriptRoot, projectDir } from "./local-env.mjs";

const [given, givenCore] = process.argv.slice(2);
let core = givenCore;
if (!core) {
    try {
        core = corescriptRoot();
    } catch (error) {
        console.error(String(error.message ?? error));
        console.error("or pass both paths: npm run e2e -- <project-dir> <corescript-root>");
        process.exit(1);
    }
}

const run = spawnSync(process.execPath, [join(PACKAGE_ROOT, "dist", "e2e.js"), given ?? projectDir, core], { stdio: "inherit", cwd: PACKAGE_ROOT });
process.exitCode = run.status ?? 1;
