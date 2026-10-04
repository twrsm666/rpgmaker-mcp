import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

/**
 * The autotile pattern tables and tile id boundaries live in the engine file
 * `rmmz_core.js`, shipped inside the RPG Maker MZ installation. They are read
 * from the user's own installation at runtime rather than vendored into this
 * package, which keeps the repository free of engine sources and guarantees the
 * renderer matches the exact engine version the project uses.
 */
export interface TilemapStatics {
    version: string;
    sourcePath: string;
    /** The `Tilemap` statics object, straight out of the engine. */
    Tilemap: any;
}

const START_MARKER = "// Tile type checkers";
const END_MARKER = "// Internal classes";

export interface CoreScript {
    root: string;
    versions: string[];
}

function versionSortKey(dirName: string): number {
    const parts = /^v(\d+)\.(\d+)\.(\d+)$/.exec(dirName);
    if (!parts) {
        return -1;
    }
    return Number(parts[1]) * 1_000_000 + Number(parts[2]) * 1_000 + Number(parts[3]);
}

/** Locate `<install>/data/corescript` containing `v<version>/rmmz_core.js`. */
export function resolveCoreScript(explicitRoot?: string, wantedVersion?: string): CoreScript {
    const candidates = explicitRoot ? [explicitRoot] : defaultCoreScriptCandidates();
    const found = candidates.find(candidate => existsSync(candidate));
    if (!found) {
        throw new Error(
            "Could not find an RPG Maker MZ engine (corescript) folder. Set RMMZ_CORESCRIPT_ROOT to a " +
                "directory that contains v1.x.x subfolders, e.g. " +
                '"<RPG Maker MZ install>/data/corescript". Searched: ' +
                candidates.join(" | ")
        );
    }
    const versions = readdirSync(found)
        .filter(name => versionSortKey(name) >= 0 && existsSync(join(found, name, "rmmz_core.js")))
        .sort((a, b) => versionSortKey(a) - versionSortKey(b));
    if (versions.length === 0) {
        throw new Error(`${found} has no v<version>/rmmz_core.js subfolders`);
    }
    if (wantedVersion && !versions.includes(`v${wantedVersion}`)) {
        throw new Error(`Engine version v${wantedVersion} not found in ${found}. Available: ${versions.join(", ")}`);
    }
    return { root: found, versions };
}

function defaultCoreScriptCandidates(): string[] {
    const home = homedir();
    const programFiles = process.env["ProgramFiles(x86)"] ?? process.env["ProgramFiles"] ?? "C:/Program Files";
    const roots = [
        join(home, "Downloads"),
        join(home, "Documents"),
        join(programFiles, "Steam", "steamapps", "common"),
        programFiles
    ];
    const found: string[] = [];
    const coreScriptOf = (dir: string) => join(dir, "data", "corescript");
    const looksLikeInstall = (name: string) => /^RPG Maker M/i.test(name);
    for (const root of roots) {
        if (!existsSync(root)) {
            continue;
        }
        let entries: string[];
        try {
            entries = readdirSync(root);
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (!looksLikeInstall(entry)) {
                continue;
            }
            const base = join(root, entry);
            found.push(coreScriptOf(base));
            // Installs are often nested one level, e.g. "RPG Maker MZ (1.8.1)/RPG Maker MZ".
            try {
                for (const inner of readdirSync(base)) {
                    if (existsSync(join(base, inner, "data", "corescript"))) {
                        found.push(coreScriptOf(join(base, inner)));
                    }
                }
            } catch {
                // Not a directory tree we can read; nothing to add.
            }
        }
    }
    return [process.env["RMMZ_CORESCRIPT_ROOT"] ?? "", ...found].filter(Boolean);
}

/** Pick the engine version matching a project, falling back to the newest. */
export function pickVersion(core: CoreScript, wantedVersion?: string): string {
    if (wantedVersion) {
        const match = core.versions.find(v => v === `v${wantedVersion}`);
        if (!match) {
            throw new Error(`Engine version ${wantedVersion} is not installed (have: ${core.versions.join(", ")})`);
        }
        return match;
    }
    return core.versions[core.versions.length - 1];
}

export function loadTilemapStatics(core: CoreScript, version: string): TilemapStatics {
    const sourcePath = join(core.root, version, "rmmz_core.js");
    const source = readFileSync(sourcePath, "utf8");
    const start = source.indexOf(START_MARKER);
    const end = source.indexOf(END_MARKER);
    if (start < 0 || end < 0 || end <= start) {
        throw new Error(
            `${sourcePath} does not contain the expected Tilemap statics section ` +
                `(markers "${START_MARKER}" / "${END_MARKER}")`
        );
    }
    const section = source.slice(start, end);
    const sandbox = createContext({ Tilemap: {} as any });
    // The section assigns only data and pure helpers on `Tilemap`, so evaluating
    // it against a bare object reproduces the engine behaviour exactly.
    runInContext(`(function(Tilemap){\n${section}\n})(Tilemap);`, sandbox, { filename: sourcePath });
    const tilemap = sandbox.Tilemap;
    if (typeof tilemap.isTileA1 !== "function" || !Array.isArray(tilemap.FLOOR_AUTOTILE_TABLE)) {
        throw new Error(`Extracted Tilemap statics from ${sourcePath} look incomplete`);
    }
    return { version, sourcePath, Tilemap: tilemap };
}

/** `setNumber` -> index into a tileset's `tilesetNames`, per `_addNormalTile`. */
export function setNumberForTileId(Tilemap: any, tileId: number): number {
    if (Tilemap.isTileA5(tileId)) {
        return 4;
    }
    return 5 + Math.floor(tileId / 256);
}
