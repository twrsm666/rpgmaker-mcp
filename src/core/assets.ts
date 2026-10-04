import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { Project, ProjectError, databaseNames } from "./project.js";

/**
 * Find asset references that do not resolve to a file.
 *
 * The engine reports a missing image by stopping the game loop and painting a
 * DOM error panel, and reports a missing audio file by saying nothing at all, so
 * neither shows up in anything a file-layer tool reads. This walks the same
 * reference fields the engine walks.
 */

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];
const AUDIO_EXTENSIONS = [".ogg", ".m4a", ".mp3", ".wav", ".opus"];
const MOVIE_EXTENSIONS = [".webm", ".mp4", ".ogv"];
/** MZ's animation effects: `EffectManager.makeUrl` appends this and nothing else. */
const EFFECT_EXTENSIONS = [".efkefc"];

/** Folders the engine's own loaders read. `img/gameover`, `img/icons` and a per-item
 *  `iconName` belong to MV: MZ draws icons from `img/system/IconSet.png` by index and
 *  its Game Over screen from `System.gameoverMe` plus a black fill. */
const IMAGE_FOLDERS = [
    "animations",
    "battlebacks1",
    "battlebacks2",
    "characters",
    "enemies",
    "faces",
    "parallaxes",
    "pictures",
    "sv_actors",
    "sv_enemies",
    "system",
    "tilesets",
    "titles1",
    "titles2"
];
const AUDIO_FOLDERS = ["bgm", "bgs", "me", "se"];

/** Folder per database field, keyed by file then field. */
const IMAGE_FIELDS: Record<string, Record<string, string>> = {
    System: {
        title1Name: "img/titles1",
        title2Name: "img/titles2",
        battleback1Name: "img/battlebacks1",
        battleback2Name: "img/battlebacks2",
        battlerName: "img/sv_enemies"
    },
    Actors: { characterName: "img/characters", faceName: "img/faces", battlerName: "img/sv_actors" },
    Enemies: { battlerName: "img/sv_enemies" },
    Tilesets: { tilesetNames: "img/tilesets" },
    // MZ plays an animation through `EffectManager.load(animation.effectName)`, and
    // `EffectManager.makeUrl` builds `effects/<name>.efkefc` (rmmz_managers.js:1028,
    // rmmz_sprites.js:1244). `img/animations/` is the MV folder: the engine still carries
    // `Sprite_AnimationMV`, which reads the MV-only `animation1Name`, and the files sitting
    // there in a project copied from the template are read by nothing.
    Animations: { effectName: "effects" }
};

const AUDIO_FIELDS: Record<string, Record<string, string>> = {
    System: {
        titleBgm: "audio/bgm",
        battleBgm: "audio/bgm",
        victoryMe: "audio/me",
        escapeMe: "audio/me",
        defeatMe: "audio/me",
        gameoverMe: "audio/me",
        sounds: "audio/se"
    }
};

/** The three vehicles carry both an image and a boarding BGM. */
const VEHICLE_FIELDS = { characterName: "img/characters", bgm: "audio/bgm" };

/** Commands whose first parameter is an AudioFile, by interpreter code. */
const AUDIO_COMMANDS: Record<number, string> = {
    241: "audio/bgm",
    242: "audio/bgm",
    245: "audio/bgs",
    246: "audio/bgs",
    249: "audio/me",
    250: "audio/se"
};

/** Commands whose named asset sits at a known parameter index. */
const IMAGE_COMMANDS: Record<number, { folder: string; index: number }> = {
    231: { folder: "img/pictures", index: 1 },
    351: { folder: "img/pictures", index: 1 },
    // Video.play() builds "movies/" + name, not img/movies.
    261: { folder: "movies", index: 0 }
};

export interface AssetRef {
    folder: string;
    name: string;
    /** Where the reference came from, in the same shape the editor shows it. */
    from: string;
}

export interface AssetIssue extends AssetRef {
    reason: "missing" | "case-mismatch" | "not-png";
    /** The file that was found instead, for a case mismatch or a wrong-format hit. */
    found?: string;
}

interface FolderIndex {
    exists: boolean;
    /** lowercased base name without extension -> the name on disk */
    files: Map<string, string>;
    /**
     * Image folders only: a name that is on disk in a format the engine will not ask for.
     * `ImageManager.loadBitmap` builds `folder + name + ".png"` and nothing else (v1.8.0's
     * rmmz_managers.js:919), so a `.jpg` of the same name is a file that never loads.
     */
    other: Map<string, string>;
}

function extensionsFor(folder: string): string[] {
    if (folder.startsWith("audio/")) {
        return AUDIO_EXTENSIONS;
    }
    if (folder === "movies") {
        return MOVIE_EXTENSIONS;
    }
    if (folder === "effects") {
        return EFFECT_EXTENSIONS;
    }
    return IMAGE_EXTENSIONS;
}

/** The folders `ImageManager.loadBitmap` serves, and therefore the ones that are .png only. */
function isBitmapFolder(folder: string): boolean {
    return folder.startsWith("img/");
}

function indexFolder(projectDir: string, folder: string): FolderIndex {
    const dir = join(projectDir, folder);
    if (!existsSync(dir)) {
        return { exists: false, files: new Map(), other: new Map() };
    }
    const extensions = extensionsFor(folder);
    const files = new Map<string, string>();
    const other = new Map<string, string>();
    for (const entry of readdirSync(dir)) {
        const lower = entry.toLowerCase();
        for (const extension of extensions) {
            if (lower.endsWith(extension)) {
                const base = lower.slice(0, -extension.length);
                if (isBitmapFolder(folder) && extension !== ".png") {
                    if (!files.has(base)) {
                        other.set(base, entry);
                    }
                } else {
                    files.set(base, entry);
                }
                break;
            }
        }
    }
    return { exists: true, files, other };
}

function isAudioFile(value: unknown): value is { name: string } {
    const candidate = value as { name?: unknown; volume?: unknown; pitch?: unknown };
    return Boolean(candidate) && typeof candidate.name === "string" && typeof candidate.volume === "number" && typeof candidate.pitch === "number";
}

function entryLabel(value: unknown, id: number): string {
    const name = (value as { name?: unknown })?.name;
    return typeof name === "string" && name ? `${id} "${name}"` : `${id}`;
}

/** Every place the project data names an image or an audio file. */
export function collectAssetRefs(project: Project): AssetRef[] {
    const refs: AssetRef[] = [];
    const push = (folder: string, name: unknown, from: string) => {
        if (typeof name === "string" && name.length) {
            refs.push({ folder, name, from });
        }
    };
    const scanCommands = (list: unknown, from: string) => {
        for (const command of (Array.isArray(list) ? list : []) as any[]) {
            const audioFolder = AUDIO_COMMANDS[command?.code];
            if (audioFolder && isAudioFile(command.parameters?.[0])) {
                push(audioFolder, command.parameters[0].name, `${from} code ${command.code}`);
            }
            const image = IMAGE_COMMANDS[command?.code];
            if (image) {
                push(image.folder, command.parameters?.[image.index], `${from} code ${command.code}`);
            }
        }
    };

    for (const table of databaseNames()) {
        const raw = project.readData(table);
        // System.json is one object rather than a list of entries.
        const rows: any[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
        const imageFields = IMAGE_FIELDS[table] ?? {};
        const audioFields = AUDIO_FIELDS[table] ?? {};
        rows.forEach((row: any, index: number) => {
            if (!row) {
                return;
            }
            const label = Array.isArray(raw) ? `${table}[${entryLabel(row, index)}]` : table;
            for (const [field, folder] of Object.entries(imageFields)) {
                if (Array.isArray(row[field])) {
                    row[field].forEach((name: unknown) => push(folder, name, `${label}.${field}`));
                } else {
                    push(folder, row[field], `${label}.${field}`);
                }
            }
            for (const [field, folder] of Object.entries(audioFields)) {
                if (Array.isArray(row[field])) {
                    row[field].forEach((audio: unknown) => isAudioFile(audio) && push(folder, audio.name, `${label}.${field}`));
                } else if (isAudioFile(row[field])) {
                    push(folder, row[field].name, `${label}.${field}`);
                }
            }
            if (table === "System") {
                for (const vehicle of ["boat", "ship", "airship"]) {
                    const entry = row[vehicle];
                    if (entry) {
                        push(VEHICLE_FIELDS.characterName, entry.characterName, `${label}.${vehicle}`);
                        if (isAudioFile(entry.bgm)) {
                            push(VEHICLE_FIELDS.bgm, entry.bgm.name, `${label}.${vehicle}.bgm`);
                        }
                    }
                }
            }
            if (table === "CommonEvents") {
                scanCommands(row.list, label);
            }
        });
    }

    for (const info of project.listMaps()) {
        const map = project.readMap(info.id);
        const file = `Map${String(info.id).padStart(3, "0")}`;
        push("img/parallaxes", map.parallaxName, `${file}.parallaxName`);
        push("img/battlebacks1", map.battleback1Name, `${file}.battleback1Name`);
        push("img/battlebacks2", map.battleback2Name, `${file}.battleback2Name`);
        if (isAudioFile(map.bgm)) {
            push("audio/bgm", map.bgm.name, `${file}.bgm`);
        }
        if (isAudioFile(map.bgs)) {
            push("audio/bgs", map.bgs.name, `${file}.bgs`);
        }
        for (const event of (map.events ?? []).filter(Boolean)) {
            const label = `${file} event ${event.id} "${event.name}"`;
            for (const page of event.pages ?? []) {
                scanCommands(page.list, label);
            }
        }
    }

    return refs;
}

export interface AssetReport {
    projectDir: string;
    refsChecked: number;
    distinctFiles: number;
    folders: string[];
    missing: AssetIssue[];
    caseMismatch: AssetIssue[];
    emptyFolders: string[];
    truncated: boolean;
    ok: boolean;
    note: string;
}

/**
 * `limit` caps each issue list, because a project with a pruned asset folder can
 * have hundreds of dead references and the caller needs the shape, not the flood.
 */
export function checkAssets(project: Project, limit = 60): AssetReport {
    const refs = collectAssetRefs(project);
    const indexes = new Map<string, FolderIndex>();
    const emptyFolders = new Set<string>();
    const missing: AssetIssue[] = [];
    const caseMismatch: AssetIssue[] = [];
    const seen = new Set<string>();

    for (const ref of refs) {
        let index = indexes.get(ref.folder);
        if (!index) {
            index = indexFolder(project.dir, ref.folder);
            indexes.set(ref.folder, index);
            if (!index.exists) {
                emptyFolders.add(ref.folder);
            }
        }
        const extensionless = ref.name.replace(/\.[a-z0-9]+$/i, "").toLowerCase();
        const exact = index.files.get(extensionless);
        if (exact === undefined) {
            const wrongFormat = index.other.get(extensionless);
            if (wrongFormat && missing.length < limit) {
                missing.push({ ...ref, reason: "not-png", found: `${ref.folder}/${wrongFormat}` });
                continue;
            }
            if (missing.length < limit) {
                missing.push({ ...ref, reason: "missing" });
            }
            continue;
        }
        // MZ serves a browser build over http, where file names are case-sensitive
        // even though the editor on Windows never notices. Compare the name the
        // reference spells against the name on disk, ignoring the extension the
        // reference does not carry.
        const onDisk = exact.replace(/\.[a-z0-9]+$/i, "");
        if (onDisk !== ref.name.replace(/\.[a-z0-9]+$/i, "") && caseMismatch.length < limit) {
            caseMismatch.push({ ...ref, reason: "case-mismatch", found: `${ref.folder}/${exact}` });
        }
        seen.add(`${ref.folder}/${exact}`);
    }

    return {
        projectDir: project.dir,
        refsChecked: refs.length,
        distinctFiles: seen.size,
        folders: [...indexes.keys()].sort(),
        missing,
        caseMismatch,
        emptyFolders: [...emptyFolders].sort(),
        truncated: missing.length >= limit || caseMismatch.length >= limit,
        ok: missing.length === 0 && caseMismatch.length === 0,
        note:
            "Only references the engine itself resolves are checked: database image and audio fields, map audio/parallax/battleback fields, and the Play BGM/BGS/ME/SE, Show Picture and Play Movie event commands. Files a plugin names in its own source are not covered."
    };
}

export interface ImportedAsset {
    /** Project-relative path the file was written to. */
    file: string;
    folder: string;
    /** What a data field has to say to load it: the name without extension. */
    name: string;
    bytes: number;
    action: "created" | "overwrote";
    /** Where the project already names this asset, if anywhere. */
    referencedBy: string[];
    note: string;
}

/**
 * `characters`, `img/characters`, `audio/bgm`, `bgm` and `movies` all mean one
 * folder. Only the folders the engine's own loaders read are accepted, because
 * anything else is a file no data field can reach.
 */
function normalizeFolder(requested: string): string {
    const lower = requested.trim().replace(/^\.?\//, "").replace(/\/+$/, "").toLowerCase();
    for (const folder of IMAGE_FOLDERS) {
        if (lower === folder || lower === `img/${folder}`) {
            return `img/${folder}`;
        }
    }
    for (const folder of AUDIO_FOLDERS) {
        if (lower === folder || lower === `audio/${folder}`) {
            return `audio/${folder}`;
        }
    }
    if (lower === "movies" || lower === "movie") {
        return "movies";
    }
    if (lower === "effects" || lower === "effect") {
        return "effects";
    }
    throw new ProjectError(
        `"${requested}" is not a folder the engine reads. Choose one of: ${[
            ...IMAGE_FOLDERS.map(folder => `img/${folder}`),
            ...AUDIO_FOLDERS.map(folder => `audio/${folder}`),
            "movies",
            "effects"
        ].join(", ")}`
    );
}

/**
 * Put a file where the engine will find it. MZ has no importer and no per-asset
 * metadata: the folder and the base name are the whole registration, so this is a
 * copy with the checks that make a hand-placed file work — right folder, right
 * extension, no second name differing only by case (which the filesystem would fold
 * onto the first and make unreachable), and an undoable overwrite.
 */
export function importAsset(
    project: Project,
    options: { source: string; folder: string; name?: string; overwrite?: boolean }
): ImportedAsset {
    const folder = normalizeFolder(options.folder);
    // Relative sources resolve against the project, so moving a file from one folder
    // to another uses the same call.
    const source = resolve(project.dir, options.source);
    if (!existsSync(source) || !statSync(source).isFile()) {
        throw new ProjectError(`${options.source} is not a file this process can read`);
    }
    const extension = extname(source).toLowerCase();
    const allowed = extensionsFor(folder);
    if (!allowed.includes(extension)) {
        throw new ProjectError(`${folder} holds ${allowed.join(", ")}; ${options.source} is ${extension || "extensionless"}.`);
    }
    if (isBitmapFolder(folder) && extension !== ".png") {
        throw new ProjectError(
            `${folder}/${extension} will never load: ImageManager.loadBitmap asks the engine's folders for "<name>.png" and nothing ` +
                `else, so this file is dead weight the audit has to call missing. Convert it to .png and import that.`
        );
    }
    const base = String(options.name ?? basename(source).replace(/\.[^.]+$/, "")).trim();
    if (!base) {
        throw new ProjectError("the asset name is empty");
    }
    if (/[\\/:*?"<>|]/.test(base) || base.includes("..")) {
        throw new ProjectError(`"${base}" is not one file name; an asset name carries no path`);
    }
    if (base.length > 100) {
        throw new ProjectError(`"${base}" is ${base.length} characters; keep asset names under 100 so they survive every platform`);
    }

    const target = `${folder}/${base}${extension}`;
    const onDisk = indexFolder(project.dir, folder).files.get(base.toLowerCase());
    if (onDisk && onDisk !== `${base}${extension}`) {
        throw new ProjectError(
            `${folder}/${onDisk} already exists and differs only by case. This filesystem folds them together, ` +
                `so the second name would never load: import as "${onDisk.replace(/\.[^.]+$/, "")}" instead.`
        );
    }
    if (onDisk && !options.overwrite) {
        throw new ProjectError(
            `${folder}/${onDisk} already exists. Pass overwrite: true to replace it; the bytes that are there now go ` +
                "to a backup, so undo_writes gives them back."
        );
    }
    if (resolve(join(project.dir, target)) === source) {
        throw new ProjectError("the source is already the file at that path");
    }

    const data = readFileSync(source);
    project.writeFile(target, data);
    const referencedBy = collectAssetRefs(project)
        .filter(ref => ref.folder === folder && ref.name.toLowerCase() === base.toLowerCase())
        .map(ref => ref.from);
    return {
        file: target,
        folder,
        name: base,
        bytes: data.length,
        action: onDisk ? "overwrote" : "created",
        referencedBy,
        note: referencedBy.length
            ? `${referencedBy.length} field(s) already name "${base}", so the engine will load it: live_reload picks up a map ` +
              "parallax, battleback or picture, and a new game is needed for the database tables and the title screen."
            : `Nothing references "${base}" yet. Put it in the field that should show it, e.g. Actors[].characterName = "${base}".`
    };
}
