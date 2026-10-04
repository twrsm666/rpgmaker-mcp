import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { join, basename, resolve, sep } from "node:path";
import { dumpMzJson, isExpandedStyle, parseMzJson } from "./json.js";
import { normalizeEventIds } from "./map.js";

export interface MapInfo {
    id: number;
    name: string;
    order: number;
    parentId: number;
    expanded: boolean;
}

export interface ProjectOptions {
    /** Directory that contains `data/MapInfos.json`. */
    projectDir: string;
    /** Where backups of overwritten files go. Defaults to `<projectDir>/.rpgmaker-mcp/backups`. */
    backupDir?: string;
    maxBackupsPerFile?: number;
}

const DATABASE_FILES = [
    "Actors",
    "Classes",
    "Skills",
    "Items",
    "Weapons",
    "Armors",
    "Enemies",
    "Troops",
    "States",
    "Animations",
    "Tilesets",
    "CommonEvents",
    "System",
    "MapInfos"
] as const;

export type DatabaseName = (typeof DATABASE_FILES)[number];

/** What a revert did, newest write first, plus how many journal entries are left. */
export interface UndoReport {
    reverted: { name: string; file: string; at: string; to: string | "deleted" }[];
    remaining: number;
}

export function isDatabaseName(name: string): name is DatabaseName {
    return (DATABASE_FILES as readonly string[]).includes(name);
}

export function databaseNames(): readonly string[] {
    return DATABASE_FILES;
}

/**
 * A handle on an MZ project on disk. All reads/writes go through `data/*.json`,
 * which is the authoritative store the editor itself uses.
 */
export class Project {
    readonly dir: string;
    readonly backupDir: string;
    private readonly maxBackups: number;
    private readonly cache = new Map<string, { mtimeMs: number; value: any }>();

    constructor(options: ProjectOptions) {
        // Absolute, so a relative RMMZ_PROJECT still contains the paths built
        // against it when something checks for containment.
        this.dir = resolve(options.projectDir);
        this.backupDir = options.backupDir ?? join(this.dir, ".rpgmaker-mcp", "backups");
        this.maxBackups = options.maxBackupsPerFile ?? 20;
        const mapInfos = this.dataPath("MapInfos");
        if (!existsSync(mapInfos)) {
            throw new ProjectError(
                `Not an RPG Maker MZ project: ${this.dir} has no data/MapInfos.json. ` +
                    `Point RMMZ_PROJECT at the folder that contains data/, img/, js/.`
            );
        }
    }

    dataPath(name: string): string {
        return join(this.dir, "data", `${name}.json`);
    }

    /**
     * Where a write goes for a name that is not a `data/*.json` table — a path
     * like `js/plugins.js`, which the editor also writes and which deserves the
     * same backup discipline. Anything carrying a slash or an extension is taken
     * literally; a bare word stays a table name.
     */
    resolveFile(name: string): string {
        if (!name.includes("/") && !/\.(json|js|mjs)$/i.test(name)) {
            return this.dataPath(name);
        }
        const path = resolve(this.dir, name);
        if (path !== this.dir && !path.startsWith(this.dir + sep)) {
            throw new ProjectError(`"${name}" points outside the project folder`);
        }
        return path;
    }

    readText(name: string): string {
        const path = this.resolveFile(name);
        if (!existsSync(path)) {
            throw new ProjectError(`${name} not found in the project (${path})`);
        }
        return readFileSync(path, "utf8");
    }

    writeText(name: string, text: string): { backupPath: string | null } {
        const path = this.resolveFile(name);
        const backupPath = existsSync(path) ? this.backup(path, readFileSync(path, "utf8")) : null;
        this.ensureParent(path);
        this.atomicWrite(path, text);
        this.record(name, backupPath);
        return { backupPath };
    }

    /**
     * Same journaling as `writeText` for a file whose bytes are not text — an image
     * or an audio clip brought in by `import_asset`. Read and restored as bytes, so
     * a undo of a binary write is byte-exact the way a map write is.
     */
    writeFile(name: string, data: Buffer): { backupPath: string | null } {
        const path = this.resolveFile(name);
        const backupPath = existsSync(path) ? this.backup(path, readFileSync(path)) : null;
        this.ensureParent(path);
        this.atomicWrite(path, data);
        this.record(name, backupPath);
        return { backupPath };
    }

    private ensureParent(path: string): void {
        const dir = path.slice(0, path.lastIndexOf(sep));
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
    }

    /**
     * One entry per write this process made, so `undo` can walk them backwards.
     * The editor has no undo API to reach, so this stack is the only one there is,
     * and it is deliberately in memory: a restart must not offer to revert files
     * nobody has touched from here.
     */
    private readonly journal: { name: string; file: string; backupPath: string | null; at: string }[] = [];

    private record(name: string, backupPath: string | null): void {
        const path = this.resolveFile(name);
        this.journal.push({ name, file: basename(path), backupPath, at: new Date().toISOString() });
    }

    /**
     * How many writes this process has made. A caller that wants to undo exactly
     * its own changes takes this before it starts and passes it back to
     * `undoSince`, so it never touches writes somebody else made in between.
     */
    journalLength(): number {
        return this.journal.length;
    }

    /** The writes recorded at or after `index`, oldest first, up to `to`. */
    writesSince(index: number, to = this.journal.length): { name: string; file: string; at: string }[] {
        return this.journal
            .slice(Math.max(0, index), Math.max(0, to))
            .map(entry => ({ name: entry.name, file: entry.file, at: entry.at }));
    }

    history(limit = 25): { index: number; name: string; file: string; at: string; revertedTo: string | null }[] {
        const entries = this.journal.map((entry, index) => ({
            index,
            name: entry.name,
            file: entry.file,
            at: entry.at,
            revertedTo: entry.backupPath ? basename(entry.backupPath) : null
        }));
        return entries.slice(Math.max(0, entries.length - limit)).reverse();
    }

    /**
     * Revert the last `steps` writes, newest first, each back to the bytes that
     * were there before it. A write that created a file removes it again.
     */
    undo(steps = 1): UndoReport {
        const count = Math.max(1, Math.min(steps, this.journal.length));
        return this.revertFrom(this.journal.length - count);
    }

    /**
     * Revert every write made after `index` — the shape a transaction needs: the
     * marker was taken before the first step, so whatever the batch wrote goes
     * away and nothing that was there before it moves.
     */
    undoSince(index: number): UndoReport {
        const from = Math.max(0, Math.min(index, this.journal.length));
        return this.revertFrom(from);
    }

    private revertFrom(from: number): UndoReport {
        const chosen = this.journal.slice(from).reverse();
        const reverted: { name: string; file: string; at: string; to: string | "deleted" }[] = [];
        for (const entry of chosen) {
            if (!entry.backupPath) {
                rmSync(this.resolveFile(entry.name), { force: true });
                reverted.push({ name: entry.name, file: entry.file, at: entry.at, to: "deleted" });
                continue;
            }
            // A backup that is not there any more is reported, not fatal: stopping here
            // would leave the files after this one in the journal unrestored, which is a
            // worse state than one the caller can still see and fix by hand.
            if (!existsSync(entry.backupPath)) {
                reverted.push({ name: entry.name, file: entry.file, at: entry.at, to: "backup missing" });
                continue;
            }
            this.writeFileRaw(entry.name, readFileSync(entry.backupPath));
            reverted.push({ name: entry.name, file: entry.file, at: entry.at, to: basename(entry.backupPath) });
        }
        this.journal.length = from;
        return { reverted, remaining: this.journal.length };
    }

    mapFileName(id: number): string {
        if (!Number.isInteger(id) || id < 1 || id > 9999) {
            throw new ProjectError(`Map id must be an integer 1..9999, got ${id}`);
        }
        return `Map${String(id).padStart(3, "0")}`;
    }

    /** Read `data/<name>.json`, memoized on file mtime. */
    readData(name: string): any {
        const path = this.dataPath(name);
        if (!existsSync(path)) {
            throw new ProjectError(`Missing data file: data/${name}.json`);
        }
        const mtimeMs = statSync(path).mtimeMs;
        const cached = this.cache.get(name);
        if (cached && cached.mtimeMs === mtimeMs) {
            return cached.value;
        }
        const value = parseMzJson(readFileSync(path, "utf8"));
        this.cache.set(name, { mtimeMs, value });
        return value;
    }

    readMap(id: number): any {
        return this.readData(this.mapFileName(id));
    }

    /**
     * Write `data/<name>.json` atomically, backing up the previous bytes first.
     * Drops the memoization entry so a later read sees the new content.
     */
    writeData(name: string, value: unknown): { backupPath: string | null } {
        const path = this.dataPath(name);
        let backupPath: string | null = null;
        if (existsSync(path)) {
            const original = readFileSync(path, "utf8");
            backupPath = this.backup(path, original);
            const text = dumpMzJson(value, isExpandedStyle(original));
            this.atomicWrite(path, text);
        } else {
            this.atomicWrite(path, dumpMzJson(value, false));
        }
        this.cache.delete(name);
        this.record(name, backupPath);
        return { backupPath };
    }

    writeMap(id: number, value: unknown): { backupPath: string | null } {
        // The runtime reads an event as `$dataMap.events[event.id]`, so a map file
        // whose array slot and event id disagree crashes the map on its first
        // frame; align them on the way out even if the caller built the array
        // some other way.
        const map = value as any;
        if (map && Array.isArray(map.events)) {
            normalizeEventIds(map);
        }
        return this.writeData(this.mapFileName(id), value);
    }

    private atomicWrite(path: string, data: string | Buffer): void {
        const tmp = `${path}.tmp-${process.pid}`;
        writeFileSync(tmp, data, typeof data === "string" ? "utf8" : undefined);
        renameSync(tmp, path);
    }

    private backup(path: string, original: string | Buffer): string | null {
        try {
            mkdirSync(this.backupDir, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            const target = join(this.backupDir, `${basename(path)}.${stamp}`);
            writeFileSync(target, original, typeof original === "string" ? "utf8" : undefined);
            this.pruneBackups(basename(path));
            return target;
        } catch {
            // A failed backup must not block the write; the write itself is atomic.
            return null;
        }
    }

    /**
     * Cap the copies of one file, but never delete a copy the undo journal still points
     * at: one tool call writes a map several times over (place, page, commands, route), so
     * an ordinary authoring session outgrows the cap in minutes, and pruning a referenced
     * backup made `undo_writes` fail with ENOENT halfway through a rollback — leaving the
     * project in a state no undo can describe.
     */
    private pruneBackups(fileName: string): void {
        const referenced = new Set(this.journal.map(entry => entry.backupPath).filter(Boolean) as string[]);
        const entries = readdirSync(this.backupDir)
            .filter(name => name.startsWith(`${fileName}.`) && !referenced.has(join(this.backupDir, name)))
            .sort();
        while (entries.length > this.maxBackups) {
            const oldest = entries.shift();
            if (oldest) {
                rmSync(join(this.backupDir, oldest), { force: true });
            }
        }
    }

    listBackups(name: string): string[] {
        if (!existsSync(this.backupDir)) {
            return [];
        }
        const prefix = `${basename(this.resolveFile(name))}.`;
        return readdirSync(this.backupDir)
            .filter(file => file.startsWith(prefix))
            .sort()
            .map(file => join(this.backupDir, file));
    }

    /**
     * Restore a previously backed-up file verbatim. Returns nothing when the
     * newest backup already matches the current file content.
     */
    rollback(name: string): { restored: boolean; from: string; note?: string } {
        const backups = this.listBackups(name);
        const path = this.resolveFile(name);
        if (backups.length === 0) {
            throw new ProjectError(`No backups found for ${basename(path)}`);
        }
        const newest = backups[backups.length - 1];
        const current = existsSync(path) ? readFileSync(path) : null;
        const content = readFileSync(newest);
        if (current && current.equals(content)) {
            const previous = backups[backups.length - 2];
            if (!previous) {
                return { restored: false, from: newest, note: "Only one backup exists and it matches the current file." };
            }
            this.writeFileRaw(name, readFileSync(previous));
            return { restored: true, from: previous };
        }
        this.writeFileRaw(name, content);
        return { restored: true, from: newest };
    }

    /**
     * Restore one specific backup by number, oldest first. `rollback` above only
     * ever reaches the newest two; a map that has been written ten times needs the
     * rest to be addressable.
     */
    rollbackTo(name: string, index: number): { restored: boolean; from: string; backups: number } {
        const backups = this.listBackups(name);
        const target = backups.at(index);
        if (!target) {
            throw new ProjectError(
                `No backup number ${index} for ${basename(this.resolveFile(name))}; ${backups.length} exist (0 is the oldest, ${backups.length - 1} the newest).`
            );
        }
        this.writeFileRaw(name, readFileSync(target));
        return { restored: true, from: target, backups: backups.length };
    }

    private writeFileRaw(name: string, data: string | Buffer): void {
        const target = this.resolveFile(name);
        this.atomicWrite(target, data);
        this.cache.delete(basename(target, ".json"));
    }

    listMaps(): MapInfo[] {
        const infos: any[] = this.readData("MapInfos");
        const maps: MapInfo[] = [];
        for (const info of infos) {
            if (!info || typeof info.id !== "number") {
                continue;
            }
            const file = this.dataPath(this.mapFileName(info.id));
            if (existsSync(file)) {
                maps.push({
                    id: info.id,
                    name: info.name ?? "",
                    order: info.order ?? info.id,
                    parentId: info.parentId ?? 0,
                    expanded: Boolean(info.expanded)
                });
            }
        }
        return maps.sort((a, b) => a.order - b.order || a.id - b.id);
    }

    nextMapId(): number {
        const infos: any[] = this.readData("MapInfos");
        const ids = infos.filter(Boolean).map(info => info.id);
        for (const file of readdirSync(join(this.dir, "data"))) {
            const match = /^Map(\d{3,4})\.json$/.exec(file);
            if (match) {
                ids.push(Number(match[1]));
            }
        }
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    /** Create a new map plus its MapInfos entry. */
    createMap(options: { name?: string; width: number; height: number; tilesetId: number; parentId?: number }): { id: number } {
        const { width, height, tilesetId } = options;
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || width > 250 || height < 1 || height > 250) {
            throw new ProjectError("Map width and height must be integers between 1 and 250");
        }
        const tilesets: any[] = this.readData("Tilesets");
        if (!tilesets[tilesetId]) {
            throw new ProjectError(`Tileset ${tilesetId} does not exist`);
        }
        const id = this.nextMapId();
        const map = {
            autoplayBgm: false,
            autoplayBgs: false,
            battleback1Name: "",
            battleback2Name: "",
            bgm: { name: "", pan: 0, pitch: 100, volume: 90 },
            bgs: { name: "", pan: 0, pitch: 100, volume: 90 },
            disableDashing: false,
            displayName: "",
            encounterList: [],
            encounterStep: 32,
            height,
            note: "",
            parallaxLoopX: false,
            parallaxLoopY: false,
            parallaxName: "",
            parallaxShow: true,
            parallaxSx: 0,
            parallaxSy: 0,
            scrollType: 0,
            specifyBattleback: false,
            tilesetId,
            width,
            data: new Array(width * height * 6).fill(0),
            events: [null]
        };
        this.writeMap(id, map);

        const infos: any[] = this.readData("MapInfos");
        infos[id] = {
            id,
            expanded: false,
            name: options.name ?? `MAP${String(id).padStart(3, "0")}`,
            order: id,
            parentId: options.parentId ?? 0,
            scrollX: 0,
            scrollY: 0
        };
        this.writeData("MapInfos", infos);
        return { id };
    }

    /** Rename a map in MapInfos. */
    setMapName(id: number, name: string): void {
        const infos: any[] = this.readData("MapInfos");
        if (!infos[id]) {
            throw new ProjectError(`Map ${id} is not registered in MapInfos`);
        }
        infos[id].name = name;
        this.writeData("MapInfos", infos);
    }

    /**
     * Remove `data/MapNNN.json` and its MapInfos entry, backing both up first so
     * `undo` puts the map file and the tree entry back together. The editor never
     * deletes a map from a script, which is why a project built over a hundred calls
     * keeps the prototypes; this is the other half of `createMap`.
     */
    deleteMap(id: number): { id: number; removedFile: string; backupPath: string | null } {
        const name = this.mapFileName(id);
        const path = this.dataPath(name);
        if (!existsSync(path)) {
            throw new ProjectError(`Map ${id} has no ${name}.json to remove`);
        }
        const backupPath = this.backup(path, readFileSync(path, "utf8"));
        rmSync(path);
        this.cache.delete(name);
        this.record(name, backupPath);
        const infos: any[] = this.readData("MapInfos");
        infos[id] = null;
        this.writeData("MapInfos", infos);
        return { id, removedFile: `${name}.json`, backupPath };
    }

    /**
     * Every event command that transfers the player to `mapId`, as {mapId, eventId,
     * name, code} — the map a caller is about to delete is usually a door somewhere
     * still opens onto.
     */
    transfersTo(mapId: number): { mapId: number; eventId: number; name: string }[] {
        const found: { mapId: number; eventId: number; name: string }[] = [];
        for (const info of this.listMaps()) {
            if (!info) {
                continue;
            }
            const map = this.readMap(info.id);
            for (const event of map.events ?? []) {
                if (!event) {
                    continue;
                }
                const leads = (event.pages ?? []).some((page: any) =>
                    // Code 201's first parameter is *what* transfers (0 the player, 1 a
                    // boat, 2 a ship, 3 the airship); the destination map is the second.
                    (page.list ?? []).some((command: any) => command.code === 201 && Number(command.parameters?.[1]) === mapId)
                );
                if (leads) {
                    found.push({ mapId: info.id, eventId: event.id, name: String(event.name ?? "") });
                }
            }
        }
        return found;
    }

}

export class ProjectError extends Error {}
