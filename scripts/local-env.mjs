/**
 * The three things every scripted suite needs and none of them can be committed: the
 * RPG Maker MZ project folder, the engine's `data/corescript` folder, and the live
 * bridge token. Each one resolves in the same order — an environment variable, then
 * the MCP server's own registered entry in the client's settings file, then
 * `.rpgmaker-mcp/live.env` for a token made by hand — so a fresh clone can run
 * `npm run verify:full` after setting env vars (or registering the server) without
 * editing a line of script.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

/** `RMMZ_SETTINGS` wins; otherwise this client's own settings file, wherever it is. */
export function settingsPath() {
    const candidates = [
        process.env.RMMZ_SETTINGS,
        join(homedir(), ".qoder-cn", "settings.json"),
        join(homedir(), ".qoder", "settings.json")
    ].filter(Boolean);
    return candidates.find(path => existsSync(path)) ?? candidates[0];
}

/** The `mcpServers.rpgmaker` entry: `{command, args, env}`. `{}` when there is none. */
export function registeredServer() {
    try {
        return JSON.parse(readFileSync(settingsPath(), "utf8")).mcpServers?.rpgmaker ?? {};
    } catch {
        return {};
    }
}

function registeredEnv() {
    return registeredServer().env ?? {};
}

function fromLiveEnv(name) {
    const file = join(PACKAGE_ROOT, ".rpgmaker-mcp", "live.env");
    if (!existsSync(file)) {
        return undefined;
    }
    return new RegExp(`${name}=(\\w+)`).exec(readFileSync(file, "utf8"))?.[1];
}

/** The project folder, once, as a value: every script uses it as a path. */
export const projectDir = resolve(
    process.env.RMMZ_PROJECT ?? registeredEnv().RMMZ_PROJECT ?? join(PACKAGE_ROOT, "..", "demo-project")
);

/**
 * Which project that is, and who said so. An independent reviewer set `RMMZ_PROJECT` to a
 * fresh copy of the engine's template and the build scripts wrote the registered project
 * instead, silently, because a spawned server's environment was assembled the other way
 * round — so a suite can now ask, and say out loud when the answer came from somewhere
 * other than the caller.
 */
export function projectSource() {
    const fromCaller = process.env.RMMZ_PROJECT;
    const fromRegistration = registeredEnv().RMMZ_PROJECT;
    return {
        dir: projectDir,
        asked: Boolean(fromCaller),
        source: fromCaller ? "RMMZ_PROJECT in the environment" : fromRegistration ? "the registered server's env" : "the default, ../demo-project",
        registered: fromRegistration ? resolve(fromRegistration) : undefined,
        overrodeRegistration: Boolean(fromCaller && fromRegistration && resolve(fromCaller) !== resolve(fromRegistration))
    };
}

/** One line a suite prints before it writes anything, so nobody debugs the wrong project. */
export function describeProjectChoice() {
    const chosen = projectSource();
    const lines = [`project ${chosen.dir}  (from ${chosen.source})`];
    if (chosen.overrodeRegistration) {
        lines.push(`   the registered server in ${settingsPath()} names ${chosen.registered}; this run uses the caller's RMMZ_PROJECT instead.`);
    }
    return lines.join("\n");
}

export function corescriptRoot() {
    const root = process.env.RMMZ_CORESCRIPT_ROOT ?? registeredEnv().RMMZ_CORESCRIPT_ROOT;
    if (!root) {
        throw new Error(
            `no RPG Maker MZ corescript folder. Set RMMZ_CORESCRIPT_ROOT to <install>/data/corescript, ` +
                `or register the server in ${settingsPath()} so the scripts can read it from there.`
        );
    }
    return root;
}

export function liveToken() {
    const token = process.env.RMMZ_LIVE_TOKEN ?? registeredEnv().RMMZ_LIVE_TOKEN ?? fromLiveEnv("RMMZ_LIVE_TOKEN");
    if (!token) {
        throw new Error(
            `no live bridge token. Set RMMZ_LIVE_TOKEN (or put it in the registered server's env, or in ` +
                `${join(PACKAGE_ROOT, ".rpgmaker-mcp", "live.env")}). The same value must be the Token parameter of ` +
                `plugin/RMMZLiveBridge.js as it is enabled in the project, or every live command is refused with 401.`
        );
    }
    return token;
}
