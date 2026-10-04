#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Project, databaseNames, isDatabaseName } from "./core/project.js";
import {
    LAYER_COUNT,
    LAYER_REGION,
    addEvent,
    appendCommands,
    assertCommandWellFormed,
    blankPage,
    blockStructureWarnings,
    classifyTileId,
    eventAt,
    findBlockEnd,
    getEvent,
    isPassable,
    removeEvent,
    setTileAt,
    showTextCommands,
    tileAt
} from "./core/map.js";
import { describeCell, listPlacableTiles, openRenderContext, renderMap, type Overlay, type RenderContext } from "./render/renderer.js";
import { describeCommand, loadCodebook, unknownCodeWarnings, type Codebook } from "./core/codebook.js";
import { checkAssets, importAsset } from "./core/assets.js";
import { createDatabaseEntry } from "./core/rows.js";
import { enablePlugin, findPlugin, listPlugins, pluginPath, readPluginDoc, readPluginsFile, writePluginEntry } from "./core/plugins.js";
import { liveBridge } from "./bridge/liveServer.js";
import { PlaytestSession } from "./bridge/session.js";
import { registerHighLevelTools } from "./tools/highlevel.js";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const EDITOR_NOTICE =
    "If the RPG Maker MZ editor currently has this project open it will overwrite these changes on its next save: reload the project (or close the editor) before continuing in the editor.";

/**
 * The command dictionary is derived from a licensed installation, so it is not published —
 * which means a fresh install starts without it, and three tools quietly do less. Say so at
 * the moment an agent would notice, in the reply that looks thin.
 */
const CODEBOOK_HINT =
    "no command dictionary here: `decode_commands` can only print \"code N\", `command_catalog` returns nothing, and a code the engine does not have goes unflagged. Run `npm run extract:commands <install>/data/corescript` once — it reads `Game_Interpreter` out of your own installation, which is why the result is not shipped — then restart the server.";

/**
 * The version of the bridge plugin this server ships, read from the file rather than
 * repeated as a second constant. A project keeps whatever copy was last put into
 * `js/plugins/`, so upgrading the server alone leaves a game answering an older
 * protocol — and that reads as a broken tool rather than a stale file.
 */
function shippedBridgeVersion(): string | null {
    try {
        return /const BRIDGE_VERSION = "([\d.]+)"/.exec(readFileSync(join(PACKAGE_ROOT, "plugin", "RMMZLiveBridge.js"), "utf8"))?.[1] ?? null;
    } catch {
        // Packaged without the plugin folder, or an unreadable file: nothing to compare.
        return null;
    }
}

/**
 * Movement in keypad direction codes (2 down, 4 left, 6 right, 8 up) with the
 * delta each one means, and the reverse of each. `map_connectivity` walks these
 * because the engine's `Game_Map.canPass` asks two tiles: the one leaving and the
 * one arriving must each allow the step. Treating a cell as walkable only when it
 * is open in all four directions instead makes every cell beside a wall read as
 * unreachable.
 */
const MOVE_STEPS: [number, number, number][] = [
    [2, 0, 1],
    [8, 0, -1],
    [4, -1, 0],
    [6, 1, 0]
];
const MOVE_DIRS = MOVE_STEPS.map(([direction]) => direction);
const REVERSE_DIR: Record<number, number> = { 2: 8, 8: 2, 4: 6, 6: 4 };

interface ServerState {
    project: Project | null;
    projectError: string | null;
    render: RenderContext | null;
    renderError: string | null;
    codebook: Codebook;
}

const state: ServerState = {
    project: null,
    projectError: null,
    render: null,
    renderError: null,
    codebook: loadCodebook(PACKAGE_ROOT)
};

function projectDirFromEnv(): string | null {
    const argIndex = process.argv.indexOf("--project");
    const fromArg = argIndex >= 0 ? process.argv[argIndex + 1] : undefined;
    const value = fromArg ?? process.env["RMMZ_PROJECT"] ?? "";
    return value ? value : null;
}

function requireProject(): Project {
    if (!state.project) {
        const dir = projectDirFromEnv();
        if (!dir) {
            throw new Error("No project configured. Set RMMZ_PROJECT to an RPG Maker MZ project folder.");
        }
        state.project = new Project({ projectDir: dir });
        state.projectError = null;
    }
    return state.project;
}

function requireRender(): RenderContext {
    if (!state.render) {
        state.render = openRenderContext({
            corescriptRoot: process.env["RMMZ_CORESCRIPT_ROOT"] || undefined,
            engineVersion: process.env["RMMZ_ENGINE_VERSION"] || undefined
        });
        state.renderError = null;
    }
    return state.render;
}

function ok(payload: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function fail(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

function wrap<A extends Record<string, unknown>>(handler: (args: A) => unknown | Promise<unknown>) {
    return async (args: A) => {
        try {
            return ok(await handler(args));
        } catch (error) {
            return fail(error);
        }
    };
}

// The handshake should not carry a version that rots on every release: `initialize` is the
// first thing a client reads, and a 0.1.0 there while `package.json` says otherwise reads as
// a package nobody maintains.
const PACKAGE_VERSION: string = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;

const server = new McpServer({ name: "rpgmaker-mcp", version: PACKAGE_VERSION });

/**
 * The tools this server has, with the schema their surface declares. `batch` runs
 * a step by name and has to reject a bad argument list before the first write
 * lands, exactly the way the surface would, so the shape is kept next to the
 * handler instead of left inside the SDK.
 */
const registry = new Map<string, { schema: any; run: (args: any) => Promise<any> }>();

function registerTool(name: string, config: any, handler: (args: any) => Promise<any>): void {
    registry.set(name, { schema: config.inputSchema ?? {}, run: handler });
    server.registerTool(name, config, handler);
}

registerTool(
    "project_info",
    {
        title: "Project overview",
        description:
            "Summarize the configured RPG Maker MZ project: maps, tilesets, database tables, switch and variable names, and which engine version the renderer uses.",
        inputSchema: {}
    },
    wrap(() => {
        const project = requireProject();
        const system = project.readData("System");
        const maps = project.listMaps();
        const tilesets: any[] = project.readData("Tilesets");
        let render: { engine: string; source: string } | null = null;
        try {
            const context = requireRender();
            render = { engine: context.statics.version, source: context.statics.sourcePath };
        } catch (error) {
            state.renderError = error instanceof Error ? error.message : String(error);
        }
        return {
            projectDir: project.dir,
            gameTitle: system.gameTitle ?? "",
            mapCount: maps.length,
            maps: maps.map(map => ({ id: map.id, name: map.name })),
            tilesets: tilesets
                .filter(Boolean)
                .map(tileset => ({ id: tileset.id, name: tileset.name, mode: tileset.mode })),
            switches: (system.switches ?? []).map((name: string, index: number) => ({ id: index, name })).filter((item: any) => item.name),
            variables: (system.variables ?? []).map((name: string, index: number) => ({ id: index, name })).filter((item: any) => item.name),
            startMap: { id: system.startMapId, x: system.startX, y: system.startY },
            renderer: render,
            rendererError: state.renderError,
            codebook: state.codebook.source ? { loaded: true, commands: state.codebook.byCode.size } : { loaded: false, howToFix: CODEBOOK_HINT }
        };
    })
);

registerTool(
    "list_maps",
    {
        title: "List maps",
        description: "List every map with its size, tileset, event count and encounter settings.",
        inputSchema: {}
    },
    wrap(() => {
        const project = requireProject();
        return {
            maps: project.listMaps().map(info => {
                const map = project.readMap(info.id);
                return {
                    id: info.id,
                    name: info.name,
                    width: map.width,
                    height: map.height,
                    tilesetId: map.tilesetId,
                    eventCount: map.events.filter(Boolean).length,
                    parallaxName: map.parallaxName,
                    displayName: map.displayName,
                    encounterStep: map.encounterStep,
                    encounters: (map.encounterList ?? []).length
                };
            })
        };
    })
);

registerTool(
    "get_map",
    {
        title: "Inspect a map",
        description:
            "Read a map's structure: dimensions, tileset, every event with position, graphic, trigger and page conditions. Optionally dump a rectangular slice of one tile layer as ids.",
        inputSchema: {
            mapId: z.number().int().describe("Map id, e.g. 1 for Map001.json"),
            layerDump: z
                .object({
                    layer: z.number().int().min(0).max(LAYER_COUNT - 1),
                    x: z.number().int().min(0),
                    y: z.number().int().min(0),
                    width: z.number().int().min(1).max(64),
                    height: z.number().int().min(1).max(64)
                })
                .optional()
                .describe("Return a grid slice of one layer (0-3 tiles, 4 shadow bits, 5 region id)"),
            includeCommands: z.boolean().optional().describe("Include decoded event command lists (default false)")
        }
    },
    wrap((args: any) => {
        const project = requireProject();
        const map = project.readMap(args.mapId);
        const result: any = {
            id: args.mapId,
            name: project.listMaps().find(item => item.id === args.mapId)?.name ?? "",
            width: map.width,
            height: map.height,
            tilesetId: map.tilesetId,
            autoplayBgm: map.autoplayBgm,
            bgm: map.bgm,
            bgs: map.bgs,
            disableDashing: map.disableDashing,
            parallaxName: map.parallaxName,
            encounterStep: map.encounterStep,
            encounterList: map.encounterList,
            events: map.events.filter(Boolean).map((event: any) => ({
                id: event.id,
                name: event.name,
                x: event.x,
                y: event.y,
                note: event.note || undefined,
                pages: event.pages.map((page: any, index: number) => ({
                    index,
                    trigger: page.trigger,
                    priorityType: page.priorityType,
                    image: page.image,
                    conditions: Object.entries(page.conditions ?? {})
                        .filter(([key, value]) => (key.endsWith("Valid") ? value === true : false))
                        .map(([key]) => key),
                    moveType: page.moveType,
                    moveSpeed: page.moveSpeed,
                    moveFrequency: page.moveFrequency,
                    // The custom route is the only movement an author can see in the editor and
                    // not in the file's page settings, so a patrol NPC could be written and never
                    // read back. Its codes are short enough to show inline.
                    ...(page.moveType === 1 ? { moveRoute: (page.moveRoute?.list ?? []).map((step: any) => (step.parameters?.length ? `${step.code}:${JSON.stringify(step.parameters)}` : String(step.code))) } : {}),
                    stepAnime: page.stepAnime,
                    through: page.through,
                    commandCount: page.list.filter((command: any) => command.code !== 0).length
                }))
            }))
        };
        if (args.layerDump) {
            const { layer, x, y, width, height } = args.layerDump;
            const grid: number[][] = [];
            for (let row = 0; row < height; row++) {
                const line: number[] = [];
                for (let column = 0; column < width; column++) {
                    line.push(tileAt(map, x + column, y + row, layer));
                }
                grid.push(line);
            }
            result.layerDump = { layer, x, y, grid };
        }
        if (args.includeCommands) {
            result.decodedCommands = map.events.filter(Boolean).map((event: any) => ({
                id: event.id,
                pages: event.pages.map((page: any) => page.list.map((command: any) => describeCommand(state.codebook, command)))
            }));
        }
        return result;
    })
);

registerTool(
    "inspect_cell",
    {
        title: "Inspect one map cell",
        description: "Read every tile layer, shadow bits, region id, terrain tag and the event standing on a single cell.",
        inputSchema: {
            mapId: z.number().int(),
            x: z.number().int().min(0),
            y: z.number().int().min(0)
        }
    },
    wrap((args: any) => {
        const project = requireProject();
        return describeCell(project, args.mapId, args.x, args.y, requireRender().statics);
    })
);

registerTool(
    "tileset_slots",
    {
        title: "List tileset slots",
        description:
            "Show which image is bound to each A1-A5/B-E slot of a tileset and the first tile id of each slot, so tile ids can be chosen without guessing.",
        inputSchema: { tilesetId: z.number().int() }
    },
    wrap((args: any) => {
        const project = requireProject();
        return { tilesetId: args.tilesetId, slots: listPlacableTiles(project, args.tilesetId, requireRender().statics) };
    })
);

registerTool(
    "render_map",
    {
        title: "Render a map to PNG",
        description:
            "Composite a map exactly the way the engine does (autotiles, shadow bits, higher-tile z-order) and return it as an image, so layout can be verified visually. Overlays can show passability, region ids or terrain tags.",
        inputSchema: {
            mapId: z.number().int(),
            overlay: z.enum(["none", "passage", "region", "terrain", "shadow"]).optional().describe("Default none"),
            showEvents: z.boolean().optional().describe("Draw event markers and event graphics (default true)"),
            showGrid: z.boolean().optional(),
            scale: z.number().min(0.1).max(4).optional().describe("Pixels per tile / 48. Defaults to fitting a 2048px side"),
            animationFrame: z.number().int().min(0).max(3).optional().describe("A1 water/waterfall animation frame to freeze"),
            onlyLayers: z.array(z.number().int().min(0).max(3)).optional().describe("Restrict to these tile layers"),
            saveTo: z.string().optional().describe("Also write the PNG to this absolute path")
        }
    },
    async (args: any) => {
        try {
            const project = requireProject();
            const map = project.readMap(args.mapId);
            const fitScale = Math.min(4, Math.max(0.1, 2048 / (Math.max(map.width, map.height) * 48)));
            const result = await renderMap(
                project,
                args.mapId,
                {
                    overlay: (args.overlay ?? "none") as Overlay,
                    showEvents: args.showEvents,
                    showGrid: args.showGrid,
                    scale: args.scale ?? Number(fitScale.toFixed(3)),
                    animationFrame: args.animationFrame,
                    onlyLayers: args.onlyLayers
                },
                requireRender()
            );
            let savedTo: string | null = null;
            if (args.saveTo) {
                mkdirSync(dirname(args.saveTo), { recursive: true });
                writeFileSync(args.saveTo, result.png);
                savedTo = args.saveTo;
            }
            return {
                content: [
                    { type: "image" as const, data: Buffer.from(result.png).toString("base64"), mimeType: "image/png" },
                    {
                        type: "text" as const,
                        text: JSON.stringify(
                            {
                                mapId: args.mapId,
                                pixels: [result.pixelWidth, result.pixelHeight],
                                scale: args.scale ?? Number(fitScale.toFixed(3)),
                                stats: result.stats,
                                warnings: result.warnings,
                                savedTo
                            },
                            null,
                            2
                        )
                    }
                ]
            };
        } catch (error) {
            return fail(error);
        }
    }
);

registerTool(
    "create_map",
    {
        title: "Create a map",
        description: "Create an empty map file plus its MapInfos entry.",
        inputSchema: {
            name: z.string().optional(),
            width: z.number().int().min(1).max(250),
            height: z.number().int().min(1).max(250),
            tilesetId: z.number().int(),
            parentId: z.number().int().optional()
        }
    },
    wrap((args: any) => {
        const project = requireProject();
        const created = project.createMap(args);
        return { ...created, notice: EDITOR_NOTICE };
    })
);

registerTool(
    "delete_map",
    {
        title: "Delete a map and its entry in the tree",
        description:
            "Remove `data/MapNNN.json` and clear its `MapInfos` slot — the other half of `create_map`, and the call that lets a build script tidy the prototypes it made on the way to the version it wanted. It refuses while some event on another map still transfers the player there, because that is a door into a map that is gone, and it lists those events so the caller can decide; `force` deletes anyway and still lists them. Both files are backed up first, so `undo_writes` puts the map file and its tree entry back together.",
        inputSchema: {
            mapId: z.number().int().min(1),
            force: z.boolean().optional().describe("Delete even though events lead here; the reply names them"),
            dryRun: z.boolean().optional().describe("Report what would go, and what points here, without writing")
        },
        annotations: { title: "Delete a map", destructiveHint: true, idempotentHint: false }
    },
    wrap((args: any) => {
        const project = requireProject();
        const infos: any[] = project.readData("MapInfos");
        const info = infos[args.mapId];
        if (!info) {
            throw new Error(`Map ${args.mapId} is not registered in MapInfos, so there is nothing to delete. \`list_maps\` shows what is there.`);
        }
        if (Number(project.readData("System").startMapId) === args.mapId && !args.force) {
            throw new Error(`map ${args.mapId} is the start map, so deleting it leaves New Game nowhere. Move System.startMapId first, or pass force.`);
        }
        const leads = project.transfersTo(args.mapId);
        if (leads.length && !args.force) {
            throw new Error(
                `${leads.length} event(s) still transfer the player to map ${args.mapId}: ${leads
                    .slice(0, 6)
                    .map(entry => `map ${entry.mapId} event ${entry.eventId} "${entry.name}"`)
                    .join(", ")}. Either move those doors, or pass force to delete the map and take the warnings on the chin.`
            );
        }
        if (args.dryRun) {
            return { mapId: args.mapId, name: info.name, wouldRemove: `data/Map${String(args.mapId).padStart(3, "0")}.json`, leadsTo: leads, dryRun: true };
        }
        const removed = project.deleteMap(args.mapId);
        return {
            ...removed,
            name: info.name,
            ...(leads.length ? { leadsStillHere: leads } : {}),
            notice: `The editor shows map ${args.mapId} as gone on its next open; ${leads.length ? `${leads.length} event(s) still point at it. ` : ""}${EDITOR_NOTICE}`
        };
    })
);

registerTool(
    "set_map_properties",
    {
        title: "Change a map's own settings",
        description:
            "Set the map-level fields that are not tiles and not events: display name, tileset, the map-name banner, dashing, battlebacks, parallax (name, loop, auto-scroll, start offset), the map's own BGM/BGS and whether they autoplay, and the encounter table. Encounters are the reason this exists — `list_maps` reports them, and without a writer a playtest can be built that never meets a monster. Pass `encounters` as [{regionId, troopId, appearances}]: `regionId` 0 means the whole map, otherwise it matches the region ids painted on layer 5 with set_tiles, and `appearances` is the weight against the other rows. Omit `clearEncounters` to replace the list, set it true to empty it. Size is not here on purpose: resizing means rebuilding the tile array, and a wrong array length corrupts the map, so create the map at the size you want.",
        inputSchema: {
            mapId: z.number().int(),
            name: z.string().optional().describe("Name in the map tree (MapInfos), not the in-game title"),
            displayName: z.string().optional().describe("Map name shown on screen; empty falls back to the tree name"),
            tilesetId: z.number().int().optional(),
            disableDashing: z.boolean().optional(),
            scrollType: z.number().int().min(0).max(1).optional().describe("0 screen, 1 continuous"),
            specifyBattleback: z.boolean().optional(),
            battleback1Name: z.string().optional(),
            battleback2Name: z.string().optional(),
            parallaxName: z.string().optional(),
            parallaxShow: z.boolean().optional(),
            parallaxLoopX: z.boolean().optional(),
            parallaxLoopY: z.boolean().optional(),
            parallaxSx: z.number().int().min(-10000).max(10000).optional(),
            parallaxSy: z.number().int().min(-10000).max(10000).optional(),
            autoplayBgm: z.boolean().optional(),
            bgm: z.object({ name: z.string(), volume: z.number(), pitch: z.number(), pan: z.number() }).optional(),
            autoplayBgs: z.boolean().optional(),
            bgs: z.object({ name: z.string(), volume: z.number(), pitch: z.number(), pan: z.number() }).optional(),
            encounterStep: z.number().int().min(1).max(200).optional(),
            encounters: z
                .array(
                    z.object({
                        troopId: z.number().int().min(1),
                        weight: z.number().int().min(1).max(100).optional().describe("MZ's own relative frequency; the row is drawn with this weight among the rows whose regions match"),
                        appearances: z.number().int().min(1).max(100).optional().describe("Accepted as the MV name for weight"),
                        regionSet: z.array(z.number().int().min(1).max(255)).optional().describe("MZ's own field: the regions this row rolls on, empty for the whole map"),
                        regionId: z.number().int().min(0).max(255).optional().describe("Accepted as a one-region shorthand for regionSet")
                    })
                )
                .optional(),
            clearEncounters: z.boolean().optional(),
            note: z.string().optional()
        },
        annotations: { destructiveHint: true, idempotentHint: true }
    },
    wrap((args: any) => {
        const project = requireProject();
        const map = project.readMap(args.mapId);
        const changed: string[] = [];
        const set = (key: string, value: unknown) => {
            if (value !== undefined) {
                map[key] = value;
                changed.push(key);
            }
        };
        if (args.tilesetId !== undefined) {
            const tilesets: any[] = project.readData("Tilesets");
            if (!tilesets[args.tilesetId]) {
                throw new Error(`Tileset ${args.tilesetId} does not exist`);
            }
        }
        if (args.bgm && !args.autoplayBgm) {
            throw new Error("A bgm without autoplayBgm never plays: pass autoplayBgm too, or the field is inert");
        }
        if (args.bgs && !args.autoplayBgs) {
            throw new Error("A bgs without autoplayBgs never plays: pass autoplayBgs too, or the field is inert");
        }
        if (args.parallaxName) {
            if (!existsSync(join(project.dir, "img", "parallaxes", `${args.parallaxName}.png`))) {
                throw new Error(`img/parallaxes/${args.parallaxName}.png is not in the project, so the map would show no background`);
            }
        }
        set("displayName", args.displayName);
        set("tilesetId", args.tilesetId);
        set("disableDashing", args.disableDashing);
        set("scrollType", args.scrollType);
        set("specifyBattleback", args.specifyBattleback);
        set("battleback1Name", args.battleback1Name);
        set("battleback2Name", args.battleback2Name);
        set("parallaxName", args.parallaxName);
        set("parallaxShow", args.parallaxShow);
        set("parallaxLoopX", args.parallaxLoopX);
        set("parallaxLoopY", args.parallaxLoopY);
        set("parallaxSx", args.parallaxSx);
        set("parallaxSy", args.parallaxSy);
        set("autoplayBgm", args.autoplayBgm);
        set("bgm", args.bgm);
        set("autoplayBgs", args.autoplayBgs);
        set("bgs", args.bgs);
        set("encounterStep", args.encounterStep);
        set("note", args.note);
        let encounterWarning: string | null = null;
        let encountersFromShorthand = 0;
        let encountersRenamed = 0;
        if (args.clearEncounters) {
            map.encounterList = [];
            changed.push("encounterList");
        }
        if (args.encounters) {
            const troops: any[] = project.readData("Troops");
            const missing = args.encounters.filter((row: any) => !troops[row.troopId] || !troops[row.troopId].name).map((row: any) => row.troopId);
            if (missing.length) {
                throw new Error(`Troop ${missing.join(", ")} does not exist (or is an unnamed slot), so the encounter would silently fail`);
            }
            // MZ reads `encounter.regionSet` unconditionally in
            // Game_Player.meetsEncounterConditions, so an entry without that array is
            // not merely inert: it throws inside Scene_Map.updateScene, the engine
            // stops the game loop, and the map freezes mid-walk. And the weight field
            // is `weight` here, not MV's `appearances` — a row without it adds NaN to
            // the weight sum, which silently means the troop never appears.
            const rows = args.encounters.map((row: any) => {
                const weight = row.weight ?? row.appearances;
                if (weight === undefined) {
                    throw new Error(`The encounter row for troop ${row.troopId} has no weight; pass weight (MZ) or appearances (MV's name for it).`);
                }
                if (row.weight === undefined) {
                    encountersRenamed++;
                }
                if (!row.regionSet && row.regionId) {
                    encountersFromShorthand++;
                }
                return {
                    regionSet: row.regionSet ?? (row.regionId ? [row.regionId] : []),
                    troopId: row.troopId,
                    weight
                };
            });
            map.encounterList = rows;
            changed.push("encounterList");
            const regions = new Set<number>(rows.flatMap((row: any) => row.regionSet));
            const painted = new Set<number>();
            for (let index = 0; index < map.width * map.height; index++) {
                const region = map.data[LAYER_REGION * map.width * map.height + index];
                if (region) {
                    painted.add(region);
                }
            }
            const unused = [...regions].filter(region => region !== 0 && !painted.has(region));
            if (unused.length) {
                encounterWarning = `Region ${unused.join(", ")} has no encounter rows painted on it — paint it with set_tiles on layer 5, or the row never fires`;
            }
        }
        project.writeMap(args.mapId, map);
        let renamed = false;
        if (args.name !== undefined) {
            const infos: any[] = project.readData("MapInfos");
            if (infos[args.mapId]) {
                infos[args.mapId].name = args.name;
                project.writeData("MapInfos", infos);
                renamed = true;
            }
        }
        return {
            mapId: args.mapId,
            changed,
            renamed,
            encounterCount: (map.encounterList ?? []).length,
            ...(encountersFromShorthand || encountersRenamed
                ? {
                      notice:
                          `Encounter rows were stored the way MZ reads them: ` +
                          `${encountersFromShorthand ? `${encountersFromShorthand} regionId became regionSet:[id]; ` : ""}` +
                          `${encountersRenamed ? `${encountersRenamed} appearances became weight.` : ""} ` +
                          `A row without regionSet throws inside Scene_Map.updateScene on its first roll, and a row without weight never rolls at all.`
                  }
                : { notice: EDITOR_NOTICE }),
            ...(encounterWarning ? { warning: encounterWarning } : {})
        };
    })
);

/**
 * MZ keeps each tile family on its own layer of the map: the ground autotiles
 * (A1, A2) on 1, A3 on 2, the upper wall autotiles (A4) on 3, and the plain
 * tiles (A5, B, C, D, E) on 0. The engine draws a tile that sits on another
 * layer all the same, just at that layer's depth, which is how a wall painted on
 * layer 0 ends up behind the player walking through it.
 */
function layerAdvice(tileId: number, layer: number): { kind: string; want: number } | null {
    if (tileId <= 0 || layer > 3) {
        return null;
    }
    const kind = slotOf(tileId);
    const want: Record<string, number> = { A1: 1, A2: 1, A3: 2, A4: 3, A5: 0, B: 0, C: 0, D: 0, E: 0 };
    return want[kind] === layer ? null : { kind, want: want[kind] };
}

/** Which slot a tile id belongs to: A1..A5 by the engine's own boundaries, else B..E. */
function slotOf(tileId: number): string {
    const Tilemap = (requireRender().statics as any).Tilemap;
    return classifyTileId(tileId, {
        A1: Tilemap.TILE_ID_A1,
        A2: Tilemap.TILE_ID_A2,
        A3: Tilemap.TILE_ID_A3,
        A4: Tilemap.TILE_ID_A4,
        A5: Tilemap.TILE_ID_A5
    });
}

/** The layer MZ draws this tile id on, which is what `layer` defaults to. */
function preferredLayer(tileId: number): number {
    return ({ A1: 1, A2: 1, A3: 2, A4: 3, A5: 0, B: 0, C: 0, D: 0, E: 0 } as Record<string, number>)[slotOf(tileId)] ?? 0;
}

registerTool(
    "set_tiles",
    {
        title: "Paint tiles",
        description:
            "Write tile ids on one map. Pass explicit cells, or a rectangle to fill. Layer 0-3 are tile layers, 4 holds shadow bits 0-15, 5 holds region ids. MZ puts A1/A2 ground on layer 1, A3 on 2, A4 upper walls on 3 and A5/B/C/D/E on 0 — leave `layer` out and each tile goes to the layer its own slot belongs to, which is the difference between a forest and a field of trees buried under the grass. Pass it to override, and painting a tile on a layer it does not belong to still renders, only at the wrong depth, so the reply says so.",
        inputSchema: {
            mapId: z.number().int(),
            cells: z
                .array(
                    z.object({
                        x: z.number().int().min(0),
                        y: z.number().int().min(0),
                        layer: z
                            .number()
                            .int()
                            .min(0)
                            .max(LAYER_COUNT - 1)
                            .optional()
                            .describe("Omit to use the layer this tile id's own slot belongs to"),
                        tileId: z.number().int().min(0).max(8191)
                    })
                )
                .optional(),
            rect: z
                .object({
                    x: z.number().int().min(0),
                    y: z.number().int().min(0),
                    width: z.number().int().min(1).max(250),
                    height: z.number().int().min(1).max(250),
                    layer: z.number().int().min(0).max(LAYER_COUNT - 1).optional(),
                    tileId: z.number().int().min(0).max(8191)
                })
                .optional()
                .describe("Fill a rectangle with one tile id; autotile ids keep their shape ids, so a filled area becomes one contiguous autotile region")
        }
    },
    wrap((args: any) => {
        const project = requireProject();
        const map = project.readMap(args.mapId);
        const misplaced = new Map<string, string>();
        const autoLayered = new Set<string>();
        let written = 0;
        /** `layer` is optional now, and what it defaults to is the whole point. */
        const layerFor = (tileId: number, layer: number | undefined): number => {
            if (layer !== undefined) {
                return layer;
            }
            const chosen = preferredLayer(tileId);
            autoLayered.add(`${slotOf(tileId)}→${chosen}`);
            return chosen;
        };
        if (args.rect) {
            const { x, y, width, height, tileId } = args.rect;
            const layer = layerFor(tileId, args.rect.layer);
            for (let row = y; row < y + height; row++) {
                for (let column = x; column < x + width; column++) {
                    setTileAt(map, column, row, layer, tileId);
                    written++;
                }
            }
            const off = layerAdvice(tileId, layer);
            if (off) {
                misplaced.set(`${off.kind} on ${layer}`, `${off.kind} tiles belong on layer ${off.want}, not ${layer}`);
            }
        }
        for (const cell of args.cells ?? []) {
            const layer = layerFor(cell.tileId, cell.layer);
            setTileAt(map, cell.x, cell.y, layer, cell.tileId);
            written++;
            const off = layerAdvice(cell.tileId, layer);
            if (off) {
                misplaced.set(`${off.kind} on ${layer}`, `${off.kind} tiles belong on layer ${off.want}, not ${layer}`);
            }
        }
        if (written === 0) {
            throw new Error("Provide cells and/or rect");
        }
        project.writeMap(args.mapId, map);
        return {
            mapId: args.mapId,
            cellsWritten: written,
            ...(autoLayered.size ? { layersUsed: [...autoLayered].sort().join(", ") } : {}),
            ...(misplaced.size
                ? {
                      warning:
                          `${[...misplaced.values()].join("; ")}. MZ reads the ground autotiles (A1, A2) on layer 1, A3 on 2 and A4 on 3, ` +
                          `and the plain tiles (A5, B, C, D, E) on 0; the shapes still resolve on the layer you used, but the engine draws ` +
                          `that layer below the characters, so a wall painted on 0 will have the player standing in front of it.`
                  }
                : {}),
            notice: EDITOR_NOTICE
        };
    })
);

registerTool(
    "place_event",
    {
        title: "Place or update an event",
        description: "Create an event at a cell, or move and rename an existing one by id.",
        inputSchema: {
            mapId: z.number().int(),
            x: z.number().int().min(0),
            y: z.number().int().min(0),
            id: z.number().int().optional().describe("Existing event id to move; omit to create"),
            name: z.string().optional(),
            note: z.string().optional()
        }
    },
    wrap((args: any) => {
        const project = requireProject();
        const map = project.readMap(args.mapId);
        if (args.id) {
            const event = getEvent(map, args.id);
            if (!event) {
                throw new Error(`Event ${args.id} not found on map ${args.mapId}`);
            }
            const blocker = eventAt(map, args.x, args.y);
            if (blocker && blocker.id !== args.id) {
                throw new Error(`Cell (${args.x},${args.y}) is occupied by event ${blocker.id}`);
            }
            event.x = args.x;
            event.y = args.y;
            if (args.name !== undefined) {
                event.name = args.name;
            }
            if (args.note !== undefined) {
                event.note = args.note;
            }
            project.writeMap(args.mapId, map);
            return { id: event.id, moved: true, notice: EDITOR_NOTICE };
        }
        const created = addEvent(map, args);
        project.writeMap(args.mapId, map);
        return { id: created.id, created: true, name: created.event.name, notice: EDITOR_NOTICE };
    })
);

registerTool(
    "remove_event",
    {
        title: "Delete an event",
        description: "Delete an event from a map, leaving a null hole in the events array as the editor does.",
        inputSchema: { mapId: z.number().int(), eventId: z.number().int() }
    },
    wrap((args: any) => {
        const project = requireProject();
        const map = project.readMap(args.mapId);
        if (!removeEvent(map, args.eventId)) {
            throw new Error(`Event ${args.eventId} not found on map ${args.mapId}`);
        }
        project.writeMap(args.mapId, map);
        return { removed: args.eventId, notice: EDITOR_NOTICE };
    })
);

registerTool(
    "copy_event",
    {
        title: "Copy an event, whole",
        description:
            "Duplicate an event onto another cell or another map: every page with its conditions, graphic, trigger and full command list, deep-cloned, plus the note. The copy gets a fresh id and its own self switches (those are keyed by event id at runtime), so a chest copy starts closed even if the original is open. Both copies are live afterwards, which matters for an autorun or parallel-process event. The source is not modified.",
        inputSchema: {
            mapId: z.number().int(),
            eventId: z.number().int(),
            toMapId: z.number().int().optional().describe("Defaults to the map the source is on"),
            x: z.number().int().min(0),
            y: z.number().int().min(0),
            name: z.string().optional().describe("Defaults to the source's name")
        }
    },
    wrap((args: any) => {
        const project = requireProject();
        const source = project.readMap(args.mapId);
        const original = getEvent(source, args.eventId);
        if (!original) {
            throw new Error(`Event ${args.eventId} not found on map ${args.mapId}`);
        }
        const targetMapId = args.toMapId ?? args.mapId;
        const target = targetMapId === args.mapId ? source : project.readMap(targetMapId);
        const created = addEvent(target, { x: args.x, y: args.y, name: args.name ?? original.name });
        created.event.pages = JSON.parse(JSON.stringify(original.pages));
        created.event.note = original.note ?? "";
        project.writeMap(targetMapId, target);
        return {
            id: created.id,
            from: { mapId: args.mapId, eventId: args.eventId, name: original.name },
            to: { mapId: targetMapId, x: args.x, y: args.y },
            pages: created.event.pages.length,
            commands: created.event.pages.reduce((total: number, page: any) => total + page.list.filter((command: any) => command.code !== 0).length, 0),
            notice: EDITOR_NOTICE
        };
    })
);

registerTool(
    "set_event_page",
    {
        title: "Configure an event page",
        description:
            "Set a page's graphic, trigger, priority, movement and conditions. Adds the page when it does not exist yet. trigger: 0 action button, 1 player touch, 2 event touch, 3 autorun, 4 parallel. priorityType: 0 below tiles, 1 same as tiles, 2 above tiles.",
        inputSchema: {
            mapId: z.number().int(),
            eventId: z.number().int(),
            pageIndex: z.number().int().min(0).optional().describe("Default 0"),
            image: z
                .object({
                    characterName: z.string(),
                    characterIndex: z.number().int().min(0).max(7),
                    direction: z.union([z.literal(2), z.literal(4), z.literal(6), z.literal(8)]),
                    pattern: z.number().int().min(0).max(2),
                    tileId: z.number().int().min(0).max(8191)
                })
                .optional(),
            trigger: z.number().int().min(0).max(4).optional(),
            priorityType: z.number().int().min(0).max(2).optional(),
            moveType: z.number().int().min(0).max(4).optional(),
            moveSpeed: z.number().int().min(0).max(6).optional(),
            moveFrequency: z.number().int().min(0).max(4).optional(),
            walkAnime: z.boolean().optional(),
            stepAnime: z.boolean().optional(),
            through: z.boolean().optional(),
            directionFix: z.boolean().optional(),
            conditions: z
                .object({
                    switch1Id: z.number().int().optional(),
                    switch2Id: z.number().int().optional(),
                    selfSwitch: z.enum(["A", "B", "C", "D"]).optional(),
                    variableId: z.number().int().optional(),
                    variableValue: z.number().int().optional(),
                    actorId: z.number().int().optional(),
                    itemId: z.number().int().optional()
                })
                .optional()
                .describe("Setting a condition also enables its *Valid flag; pass an empty object to clear all conditions")
        }
    },
    wrap((args: any) => {
        const project = requireProject();
        const map = project.readMap(args.mapId);
        const event = getEvent(map, args.eventId);
        if (!event) {
            throw new Error(`Event ${args.eventId} not found on map ${args.mapId}`);
        }
        const pageIndex = args.pageIndex ?? 0;
        if (!event.pages[pageIndex]) {
            if (pageIndex !== event.pages.length) {
                throw new Error(`Cannot create page ${pageIndex}: the event has ${event.pages.length} page(s)`);
            }
            event.pages.push(blankPage());
        }
        const page = event.pages[pageIndex];
        if (args.image) {
            page.image = { ...page.image, ...args.image };
        }
        for (const key of ["trigger", "priorityType", "moveType", "moveSpeed", "moveFrequency", "walkAnime", "stepAnime", "through", "directionFix"] as const) {
            if (args[key] !== undefined) {
                page[key] = args[key];
            }
        }
        if (args.conditions) {
            // An empty object means "this page has no conditions", which is the
            // only way to take a condition back off; a partial object is additive.
            const conditions =
                Object.keys(args.conditions).length > 0
                    ? { ...page.conditions }
                    : blankPage().conditions;
            const enable = (validKey: string, idKey?: string, id?: number) => {
                conditions[validKey] = true;
                if (idKey && id !== undefined) {
                    conditions[idKey] = id;
                }
            };
            if (args.conditions.switch1Id !== undefined) {
                enable("switch1Valid", "switch1Id", args.conditions.switch1Id);
            }
            if (args.conditions.switch2Id !== undefined) {
                enable("switch2Valid", "switch2Id", args.conditions.switch2Id);
            }
            if (args.conditions.selfSwitch) {
                enable("selfSwitchValid", "selfSwitchCh", undefined);
                conditions.selfSwitchCh = args.conditions.selfSwitch;
            }
            if (args.conditions.variableId !== undefined) {
                enable("variableValid", "variableId", args.conditions.variableId);
                if (args.conditions.variableValue !== undefined) {
                    conditions.variableValue = args.conditions.variableValue;
                }
            }
            if (args.conditions.actorId !== undefined) {
                enable("actorValid", "actorId", args.conditions.actorId);
            }
            if (args.conditions.itemId !== undefined) {
                enable("itemValid", "itemId", args.conditions.itemId);
            }
            page.conditions = conditions;
        }
        project.writeMap(args.mapId, map);
        return { mapId: args.mapId, eventId: args.eventId, pageIndex, page, notice: EDITOR_NOTICE };
    })
);

registerTool(
    "add_commands",
    {
        title: "Append event commands",
        description:
            "Append raw {code, indent, parameters} commands to a page, keeping the terminating code-0 entry last. Use `command_catalog` first to learn the parameter layout of a code. The page's block structure is re-read after the append, and anything whose indent does not match the branch it sits under comes back in `warnings`.",
        inputSchema: {
            mapId: z.number().int(),
            eventId: z.number().int(),
            pageIndex: z.number().int().min(0).optional(),
            commands: z.array(z.object({ code: z.number().int(), indent: z.number().int().min(0).max(6), parameters: z.array(z.any()) })),
            at: z.number().int().min(0).optional().describe("Insert before this list index instead of appending before the terminator")
        }
    },
    wrap((args: any) => {
        const project = requireProject();
        const map = project.readMap(args.mapId);
        const event = getEvent(map, args.eventId);
        if (!event) {
            throw new Error(`Event ${args.eventId} not found on map ${args.mapId}`);
        }
        const page = event.pages[args.pageIndex ?? 0];
        if (!page) {
            throw new Error(`Event ${args.eventId} has no page ${args.pageIndex ?? 0}`);
        }
        const commands = args.commands.map((command: any) => {
            const normalized = { ...command, parameters: command.parameters ?? [] };
            assertCommandWellFormed(normalized);
            return normalized;
        });
        if (args.at !== undefined) {
            page.list.splice(args.at, 0, ...commands);
        } else {
            appendCommands(page, commands);
        }
        project.writeMap(args.mapId, map);
        const warnings = [...blockStructureWarnings(page.list), ...unknownCodeWarnings(state.codebook, page.list)];
        return {
            mapId: args.mapId,
            eventId: args.eventId,
            appended: commands.length,
            decoded: commands.map((command: any) => describeCommand(state.codebook, command)),
            ...(warnings.length ? { warnings } : {}),
            notice: EDITOR_NOTICE
        };
    })
);

registerTool(
    "set_commands",
    {
        title: "Replace a page's command list",
        description:
            "Overwrite an event page's whole command list, terminator included. Block levels are read the way the engine reads them: a body written at the same indent as its Conditional Branch or Loop is reported in `warnings` instead of being quietly kept.",
        inputSchema: {
            mapId: z.number().int(),
            eventId: z.number().int(),
            pageIndex: z.number().int().min(0).optional(),
            list: z.array(z.object({ code: z.number().int(), indent: z.number().int().min(0).max(6), parameters: z.array(z.any()) }))
        }
    },
    wrap((args: any) => {
        const project = requireProject();
        const map = project.readMap(args.mapId);
        const event = getEvent(map, args.eventId);
        if (!event) {
            throw new Error(`Event ${args.eventId} not found on map ${args.mapId}`);
        }
        const page = event.pages[args.pageIndex ?? 0];
        if (!page) {
            throw new Error(`Event ${args.eventId} has no page ${args.pageIndex ?? 0}`);
        }
        const list = args.list.map((command: any) => {
            const normalized = { ...command, parameters: command.parameters ?? [] };
            assertCommandWellFormed(normalized);
            return normalized;
        });
        if (!list.some((command: any) => command.code === 0)) {
            list.push({ code: 0, indent: 0, parameters: [] });
        }
        page.list = list;
        project.writeMap(args.mapId, map);
        const warnings = [...blockStructureWarnings(list), ...unknownCodeWarnings(state.codebook, list)];
        return {
            mapId: args.mapId,
            eventId: args.eventId,
            commands: list.length,
            decoded: list.map((command: any) => describeCommand(state.codebook, command)),
            ...(warnings.length ? { warnings } : {}),
            notice: EDITOR_NOTICE
        };
    })
);

registerTool(
    "show_text",
    {
        title: "Append a Show Text dialog",
        description:
            "Add a Show Text dialog to an event page. MZ stores a dialog as one command 101 carrying [faceName, faceIndex, background, positionType, speakerName] followed by one command 401 per text line, each holding its line in parameters[0]; this tool builds that shape so lines can never end up as null in $gameMessage._texts.",
        inputSchema: {
            mapId: z.number().int(),
            eventId: z.number().int(),
            pageIndex: z.number().int().min(0).optional(),
            lines: z.array(z.string()).min(1).describe("One entry per dialog line; escape codes like \\N[1] work"),
            faceName: z.string().optional().describe("Face image name from img/faces, default empty"),
            faceIndex: z.number().int().min(0).max(3).optional(),
            background: z.number().int().min(0).max(2).optional().describe("0 window, 1 dim, 2 transparent"),
            positionType: z.number().int().min(0).max(2).optional().describe("Engine default is 2"),
            speakerName: z.string().optional(),
            indent: z.number().int().min(0).max(6).optional().describe("Use the surrounding block's indent when inserting inside a branch")
        }
    },
    wrap((args: any) => {
        const project = requireProject();
        const map = project.readMap(args.mapId);
        const event = getEvent(map, args.eventId);
        if (!event) {
            throw new Error(`Event ${args.eventId} not found on map ${args.mapId}`);
        }
        const page = event.pages[args.pageIndex ?? 0];
        if (!page) {
            throw new Error(`Event ${args.eventId} has no page ${args.pageIndex ?? 0}`);
        }
        const commands = showTextCommands(args);
        appendCommands(page, commands);
        project.writeMap(args.mapId, map);
        return {
            mapId: args.mapId,
            eventId: args.eventId,
            commandsAdded: commands.length,
            decoded: commands.map(command => describeCommand(state.codebook, command)),
            notice: EDITOR_NOTICE
        };
    })
);

registerTool(
    "decode_commands",
    {
        title: "Decode an event's commands",
        description: "Render a page's command list as readable lines using the engine-derived command dictionary.",
        inputSchema: {
            mapId: z.number().int(),
            eventId: z.number().int(),
            pageIndex: z.number().int().min(0).optional()
        }
    },
    wrap((args: any) => {
        const project = requireProject();
        const map = project.readMap(args.mapId);
        const event = getEvent(map, args.eventId);
        if (!event) {
            throw new Error(`Event ${args.eventId} not found on map ${args.mapId}`);
        }
        const pageIndex = args.pageIndex ?? 0;
        const page = event.pages[pageIndex];
        if (!page) {
            throw new Error(`Event ${args.eventId} has no page ${pageIndex}`);
        }
        return {
            eventId: event.id,
            name: event.name,
            pageIndex,
            lines: page.list.map((command: any) => describeCommand(state.codebook, command)),
            raw: page.list,
            codebookLoaded: Boolean(state.codebook.source),
            ...(state.codebook.source ? {} : { codebookHint: CODEBOOK_HINT })
        };
    })
);

registerTool(
    "command_catalog",
    {
        title: "Look up event command codes",
        description:
            "Search the command dictionary derived from the engine's Game_Interpreter. Returns each code's parameter names in order, so event commands can be built without guessing. Ask for exact `codes` to also get the engine body, which shows how each parameter is consumed (a name like `operateValueArg1` alone does not say whether the amount is params[1] or params[2]).",
        inputSchema: {
            codes: z.array(z.number().int()).optional().describe("Exact codes to fetch, e.g. [125] — note this is plural and takes an array"),
            query: z.string().optional().describe("Substring match against labels, method names and parameter names")
        }
    },
    wrap((args: any) => {
        const all = [...state.codebook.byCode.values()];
        const exact = Boolean(args.codes?.length);
        const selected = exact
            ? args.codes.map((code: number) => state.codebook.byCode.get(code) ?? { code, known: false })
            : args.query
              ? all.filter(
                    spec =>
                        spec.label?.toLowerCase().includes(args.query.toLowerCase()) ||
                        (spec.method ?? "").toLowerCase().includes(args.query.toLowerCase()) ||
                        spec.params?.some((param: any) => param.name.toLowerCase().includes(args.query.toLowerCase()))
                )
              : all;
        return {
            source: state.codebook.source,
            total: all.length,
            ...(state.codebook.source ? {} : { codebookHint: CODEBOOK_HINT }),
            matches: selected.map((spec: any) => ({
                code: spec.code,
                label: spec.label,
                method: spec.method ?? null,
                confidence: spec.confidence,
                params: spec.params?.map((param: any) => `${param.index}:${param.name}`) ?? [],
                // Only for exact lookups: a filtered list of these would be huge.
                ...(exact && args.codes.length <= 8 ? { body: spec.body } : {})
            }))
        };
    })
);

registerTool(
    "read_database",
    {
        title: "Read a database table",
        description:
            "Read data/<table>.json. Returns entries compactly, or one entry in full. Covers Actors, Classes, Skills, Items, Weapons, Armors, Enemies, Troops, States, Animations, Tilesets, CommonEvents, System, MapInfos. Every table answers `count` and `entries`, so a caller can read one shape; System is a single object rather than a row table, so it answers `value` as well and `entries` holds that object as its one row.",
        inputSchema: {
            table: z.string(),
            id: z.number().int().optional().describe("Return one entry instead of the whole table"),
            fields: z.array(z.string()).optional().describe("Restrict the summary to these fields")
        }
    },
    wrap((args: any) => {
        const project = requireProject();
        if (!isDatabaseName(args.table)) {
            throw new Error(`Unknown table "${args.table}". Available: ${databaseNames().join(", ")}`);
        }
        const table = project.readData(args.table);
        if (args.id !== undefined) {
            if (args.table === "System") {
                throw new Error("System.json is a single object; omit id to read it whole or pass fields");
            }
            return { table: args.table, id: args.id, entry: table[args.id] ?? null };
        }
        if (args.table === "System") {
            // One object, not a row table — but `entries` still answers, holding that
            // object as the single row, so `.entries.find(...)` means the same thing here
            // as it does on every other table instead of throwing.
            const value = args.fields?.length ? Object.fromEntries(args.fields.map((key: string) => [key, table[key]])) : table;
            return { table: args.table, count: 1, entries: [value], value };
        }
        const entries = (table as any[]).filter(Boolean).map((entry: any) => {
            if (!args.fields?.length) {
                return { id: entry.id, name: entry.name ?? "", note: entry.note || undefined };
            }
            return Object.fromEntries(args.fields.map((field: string) => [field, entry[field]]));
        });
        return { table: args.table, count: entries.length, entries };
    })
);

/**
 * MZ keeps the switch and variable name tables as arrays whose index is the id, and
 * Game_Switches/Game_Variables drop any write at or past `length` without complaining,
 * so a System.json that carries an object here boots into a game that remembers
 * nothing at all. Accept the object an agent naturally writes; store the array.
 */
function nameTable(value: unknown, field: string): string[] {
    let rows: [string, unknown][];
    if (Array.isArray(value)) {
        rows = value.map((name: unknown, index: number) => [String(index), name]);
    } else if (value && typeof value === "object") {
        rows = Object.entries(value as Record<string, unknown>);
    } else {
        throw new Error(`System.${field} has to be an array of names or an object keyed by id, not ${JSON.stringify(value)}.`);
    }
    const names: string[] = [];
    for (const [key, name] of rows) {
        const id = Number(key);
        if (!Number.isInteger(id) || id < 0) {
            throw new Error(`System.${field} has a key "${key}" that is not a switch or variable id.`);
        }
        names[id] = name === null || name === undefined ? "" : String(name);
    }
    return names.map((name: string | undefined) => name ?? "");
}

/** A nested object in a patch replaces the object that is there, so the keys the patch
 *  does not mention are the keys that disappear. Both this tool's own description and the
 *  README name that as the trap; naming the lost keys is how the tool catches it instead
 *  of leaving it for a playtest to find. */
function droppedNestedKeys(existing: any, patch: Record<string, any>): { field: string; missing: string[] }[] {
    const isObject = (value: any) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
    const out: { field: string; missing: string[] }[] = [];
    for (const [field, value] of Object.entries(patch)) {
        const before = existing?.[field];
        if (isObject(value) && isObject(before)) {
            const missing = Object.keys(before).filter(key => !(key in (value as object)));
            if (missing.length) {
                out.push({ field, missing });
            }
        }
    }
    return out;
}

registerTool(
    "patch_database_entry",
    {
        title: "Patch a database entry",
        description:
            "Apply a shallow field patch to one entry of a database table (or to System.json's top-level keys). Nested objects and arrays must be passed complete, because MZ has no partial-update semantics on them — a nested object that arrives without a key the entry already had loses that key, and the reply names the keys it lost so the caller can read the entry first. System's `switches` and `variables` are the exception: pass either an array of names or an object keyed by id, and the array the engine needs is what gets written.",
        inputSchema: {
            table: z.string(),
            id: z.number().int().optional().describe("Entry id; ignored for System"),
            patch: z.record(z.string(), z.any())
        }
    },
    wrap((args: any) => {
        const project = requireProject();
        if (!isDatabaseName(args.table)) {
            throw new Error(`Unknown table "${args.table}". Available: ${databaseNames().join(", ")}`);
        }
        const table = project.readData(args.table);
        if (args.table === "System") {
            const patch = { ...args.patch };
            const normalized: string[] = [];
            for (const field of ["switches", "variables"]) {
                if (patch[field] !== undefined) {
                    const asArray = nameTable(patch[field], field);
                    if (!Array.isArray(patch[field])) {
                        normalized.push(field);
                    }
                    patch[field] = asArray;
                }
            }
            project.writeData("System", { ...table, ...patch });
            // MZ's System.json has a fixed key set, and an MV-era key (startActors,
            // switchIds) parses fine but is read by nothing, which is how a party that
            // never changes gets shipped.
            const unknown = Object.keys(args.patch).filter(key => !(key in table));
            const dropped = droppedNestedKeys(table, args.patch);
            const lost = dropped.map(({ field, missing }) => `${field}.${missing.join(", ")}`).join("; ");
            return {
                table: "System",
                patched: Object.keys(args.patch),
                ...(dropped.length ? { droppedKeys: dropped } : {}),
                ...(normalized.length ? { normalized, notice: `${normalized.join(" and ")} arrived keyed by id and ${normalized.length > 1 ? "were" : "was"} stored as the array the engine reads.` } : {}),
                ...(unknown.length
                    ? {
                          warning:
                              `${unknown.join(", ")} ${unknown.length > 1 ? "are" : "is"} not a key MZ's System.json has, so the engine will ` +
                              `read it as absent. Starting party is \`partyMembers\`, the starting map is \`startMapId\`/\`startX\`/\`startY\`, ` +
                              `and the switch and variable names are \`switches\`/\`variables\`.` +
                              (lost ? ` It also replaced ${lost}, which the entry had before.` : "")
                      }
                    : lost
                      ? {
                            warning:
                                `${dropped.map(({ field }) => field).join(", ")} ${dropped.length > 1 ? "are" : "is"} nested object${dropped.length > 1 ? "s" : ""}, which a patch replaces rather than merges, so this write dropped ${lost}. ` +
                                `Read the entry and send it back whole, or use set_startup for the opening keys of System.`
                        }
                      : { notice: EDITOR_NOTICE })
            };
        }
        const entry = table[args.id];
        if (!entry) {
            throw new Error(
                `${args.table}[${args.id}] does not exist (${args.table}.json has ${table.length} slots). ` +
                    "Add a row with create_database_entry, or patch one that is there."
            );
        }
        const dropped = droppedNestedKeys(entry, args.patch);
        const lost = dropped.map(({ field, missing }) => `${field}.${missing.join(", ")}`).join("; ");
        table[args.id] = { ...entry, ...args.patch };
        project.writeData(args.table, table);
        return {
            table: args.table,
            id: args.id,
            patched: Object.keys(args.patch),
            entry: table[args.id],
            ...(dropped.length
                ? {
                      droppedKeys: dropped,
                      warning:
                          `${dropped.map(({ field }) => field).join(", ")} ${dropped.length > 1 ? "are" : "is"} nested object${dropped.length > 1 ? "s" : ""}, which a patch replaces rather than merges, so this write dropped ${lost} from ${args.table}[${args.id}]. ` +
                          `Read the row with read_database and send the object back whole.`
                  }
                : {}),
            notice: EDITOR_NOTICE
        };
    })
);

registerTool(
    "create_database_entry",
    {
        title: "Add a database row",
        description:
            "Claim a row in a database table the way the editor does. MZ keeps these as 1-based arrays in which the row's `id` is its array index, and it never removes one: a fresh project ships unused slots as complete rows with an empty name, and those names are what keeps an id from being reused under a saved game. So this takes the first blank slot, and only grows the table when none is left — pass no `id` and it behaves like the editor's add button. The field shape comes from the blank slot itself, else from a blank sibling, else from `copyFrom` (or the last row, which the reply reports as `basedOn` because you have just copied a real entry's stats, icon and all). `fields` is then merged over that, shallowly, exactly as patch_database_entry does. System.json has no rows and MapInfos is the map tree, so those two refuse; use patch_database_entry and create_map. There is no delete: blanking a name is what removal means here, and it is a patch.",
        inputSchema: {
            table: z.string().describe("Actors, Classes, Skills, Items, Weapons, Armors, Enemies, Troops, States, Animations, Tilesets or CommonEvents"),
            id: z.number().int().min(1).optional().describe("Row to claim (default: the first blank slot, else a new one at the end)"),
            copyFrom: z.number().int().min(1).optional().describe("Copy this existing row's fields as the starting point"),
            fields: z.record(z.string(), z.any()).optional().describe("Fields to set on the new row, e.g. {name, iconIndex, description}")
        },
        annotations: { destructiveHint: true, idempotentHint: false }
    },
    wrap((args: any) => {
        const project = requireProject();
        const created = createDatabaseEntry(project, args.table, { id: args.id, copyFrom: args.copyFrom, fields: args.fields });
        return { ...created, notice: EDITOR_NOTICE };
    })
);

registerTool(
    "find_events",
    {
        title: "Search events across maps",
        description:
            "Find events by name, by command code used, or by graphic. Answers questions like 'which events call common event 12' without reading every map by hand.",
        inputSchema: {
            name: z.string().optional().describe("Substring of the event name"),
            commandCode: z.number().int().optional(),
            characterName: z.string().optional(),
            mapId: z.number().int().optional().describe("Restrict the search to one map"),
            limit: z.number().int().min(1).max(500).optional()
        }
    },
    wrap((args: any) => {
        const project = requireProject();
        const ids = args.mapId ? [args.mapId] : project.listMaps().map(map => map.id);
        const hits: any[] = [];
        for (const mapId of ids) {
            const map = project.readMap(mapId);
            for (const event of map.events.filter(Boolean)) {
                const pages = event.pages ?? [];
                const matchesName = !args.name || String(event.name).toLowerCase().includes(args.name.toLowerCase());
                const matchesGraphic = !args.characterName || pages.some((page: any) => page.image?.characterName === args.characterName);
                const matchingCodes = new Set<number>();
                for (const page of pages) {
                    for (const command of page.list ?? []) {
                        if (args.commandCode === undefined || command.code === args.commandCode) {
                            matchingCodes.add(command.code);
                        }
                    }
                }
                const matchesCode = args.commandCode === undefined || matchingCodes.has(args.commandCode);
                if (matchesName && matchesGraphic && matchesCode) {
                    hits.push({
                        mapId,
                        eventId: event.id,
                        name: event.name,
                        x: event.x,
                        y: event.y,
                        pages: pages.length,
                        codes: args.commandCode === undefined ? [...matchingCodes].sort((a, b) => a - b).slice(0, 12) : [args.commandCode]
                    });
                }
                if (hits.length >= (args.limit ?? 100)) {
                    return { hits, truncated: true };
                }
            }
        }
        return { hits, truncated: false };
    })
);

registerTool(
    "map_connectivity",
    {
        title: "Map reachability, across portals",
        description:
            "Flood-fill walkable cells from a start position and report which events the player can actually reach. Answers 'can the player get there' instead of trusting tile placement. An event blocks a cell only when one of its pages is *same as tiles* (the engine's `isNormalPriority`), which is why a chest stops you and a floor decal does not; conditions are not evaluated, so a page that only applies later still counts as blocking. An event is `standable` when its own cell is reachable and `touchable` when a neighbour is, which is all an action-button event needs; an event with an autorun or parallel page is `automatic` and needs no path at all. Transfer Player commands found on standable events are followed into their destination maps, so a game whose rooms are joined only by portals reads as one connected space instead of a pile of isolated cells — and a portal that lands on an impassable tile is called out, because that is a trap the player cannot escape. `reports` carries one entry per map walked, in the order they were reached.",
        inputSchema: {
            mapId: z.number().int(),
            x: z.number().int().min(0),
            y: z.number().int().min(0),
            includeEventBlocking: z.boolean().optional().describe("Treat events that block the tile as walls (default true)"),
            followTransfers: z.boolean().optional().describe("Walk the maps that transfers on this one lead to (default true)"),
            maxMaps: z.number().int().min(1).max(200).optional()
        },
        annotations: { readOnlyHint: true }
    },
    wrap((args: any) => {
        const project = requireProject();
        const context = requireRender();
        const tilesets: any[] = project.readData("Tilesets");
        const infos: any[] = project.readData("MapInfos");
        const entryKey = (mapId: number, x: number, y: number) => `${mapId}:${x},${y}`;
        const starts = new Map<string, { mapId: number; x: number; y: number }>([[entryKey(args.mapId, args.x, args.y), { mapId: args.mapId, x: args.x, y: args.y }]]);
        const queue: string[] = [entryKey(args.mapId, args.x, args.y)];
        const walked = new Set<string>(queue);
        const reports: any[] = [];
        const traps: any[] = [];
        const limit = args.maxMaps ?? 40;
        while (queue.length && reports.length < limit) {
            const start = starts.get(queue.shift()!)!;
            const mapId = start.mapId;
            const map = project.readMap(mapId);
            const flags: number[] = tilesets[map.tilesetId]?.flags ?? [];
            const blocking = new Set<string>();
            if (args.includeEventBlocking !== false) {
                for (const event of map.events.filter(Boolean)) {
                    if ((event.pages ?? []).some((page: any) => page.priorityType === 1 && !page.through)) {
                        blocking.add(`${event.x},${event.y}`);
                    }
                }
            }
            const canStep = (x: number, y: number, direction: number, dx: number, dy: number): boolean => {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height || blocking.has(`${nx},${ny}`)) {
                    return false;
                }
                return isPassable(map, flags, x, y, direction) && isPassable(map, flags, nx, ny, REVERSE_DIR[direction]);
            };
            const openCell = (x: number, y: number): boolean => {
                if (x < 0 || y < 0 || x >= map.width || y >= map.height || blocking.has(`${x},${y}`)) {
                    return false;
                }
                return MOVE_DIRS.some(direction => isPassable(map, flags, x, y, direction));
            };
            const seen = new Set<string>([`${start.x},${start.y}`]);
            const todo: [number, number][] = [[start.x, start.y]];
            while (todo.length) {
                const [x, y] = todo.shift()!;
                for (const [direction, dx, dy] of MOVE_STEPS) {
                    const key = `${x + dx},${y + dy}`;
                    if (!seen.has(key) && canStep(x, y, direction, dx, dy)) {
                        seen.add(key);
                        todo.push([x + dx, y + dy]);
                    }
                }
            }
            const totalWalkable = Array.from({ length: map.width * map.height }, (_, index) => [index % map.width, Math.floor(index / map.width)]).filter(
                ([x, y]) => openCell(x, y)
            ).length;
            const portals: any[] = [];
            for (const event of map.events.filter(Boolean)) {
                if (!seen.has(`${event.x},${event.y}`)) {
                    continue;
                }
                for (const page of event.pages ?? []) {
                    for (const command of page.list ?? []) {
                        if (command.code === 201 && command.parameters?.[0] === 0) {
                            const [, toMapId, toX, toY] = command.parameters;
                            portals.push({ eventId: event.id, name: event.name, from: [event.x, event.y], to: { mapId: toMapId, x: toX, y: toY } });
                        }
                    }
                }
            }
            const classify = (event: any): string => {
                // An autorun or parallel page runs wherever it stands, so it needs
                // no path to it and must not be reported as stranded.
                if ((event.pages ?? []).some((page: any) => page.trigger >= 3)) {
                    return "automatic";
                }
                if (seen.has(`${event.x},${event.y}`)) {
                    return "standable";
                }
                const near = [[0, -1], [0, 1], [-1, 0], [1, 0]].some(([dx, dy]) => seen.has(`${event.x + dx},${event.y + dy}`));
                return near ? "touchable" : "unreachable";
            };
            const events = map.events.filter(Boolean).map((event: any) => ({ id: event.id, name: event.name, x: event.x, y: event.y, how: classify(event) }));
            reports.push({
                mapId,
                name: (infos[mapId] as any)?.name ?? "",
                start,
                reachableCells: seen.size,
                walkableCells: totalWalkable,
                isolatedWalkableCells: totalWalkable - seen.size,
                portals,
                events,
                unreachableEvents: events.filter((event: any) => event.how === "unreachable").map((event: any) => `${event.name}@${event.x},${event.y}`)
            });
            if (args.followTransfers === false) {
                break;
            }
            for (const portal of portals) {
                if (!infos[portal.to.mapId]) {
                    traps.push({ mapId, event: portal.name, error: `map ${portal.to.mapId} does not exist` });
                    continue;
                }
                const key = entryKey(portal.to.mapId, portal.to.x, portal.to.y);
                if (!walked.has(key)) {
                    walked.add(key);
                    starts.set(key, { mapId: portal.to.mapId, x: portal.to.x, y: portal.to.y });
                    queue.push(key);
                }
            }
        }
        // A portal that drops the player on an impassable cell is a trap, so check
        // every landing cell against the map it lands on.
        for (const report of reports) {
            for (const portal of report.portals) {
                if (!walked.has(entryKey(portal.to.mapId, portal.to.x, portal.to.y))) {
                    continue;
                }
                const target = project.readMap(portal.to.mapId);
                const targetFlags: number[] = tilesets[target.tilesetId]?.flags ?? [];
                const targetBlocked = new Set<string>();
                for (const event of target.events.filter(Boolean)) {
                    if ((event.pages ?? []).some((page: any) => page.priorityType === 1 && !page.through)) {
                        targetBlocked.add(`${event.x},${event.y}`);
                    }
                }
                // Trapped means the player cannot take a single step from where the
                // transfer put them, judged the way the engine judges a step.
                const stuck = !MOVE_STEPS.some(([direction, dx, dy]) => {
                    const nx = portal.to.x + dx;
                    const ny = portal.to.y + dy;
                    if (nx < 0 || ny < 0 || nx >= target.width || ny >= target.height || targetBlocked.has(`${nx},${ny}`)) {
                        return false;
                    }
                    return (
                        isPassable(target, targetFlags, portal.to.x, portal.to.y, direction) &&
                        isPassable(target, targetFlags, nx, ny, REVERSE_DIR[direction])
                    );
                });
                const occupied = targetBlocked.has(`${portal.to.x},${portal.to.y}`);
                if (stuck || occupied) {
                    traps.push({
                        mapId: report.mapId,
                        event: portal.name,
                        error: `lands on (${portal.to.x},${portal.to.y}) of map ${portal.to.mapId}, which is ${
                            occupied ? "the cell of an event that blocks the tile" : "a cell with no step the engine would allow, so the player is trapped there"
                        }`
                    });
                }
            }
        }
        const first = reports[0];
        const standing = first.events.filter((event: any) => event.how === "standable");
        return {
            start: { x: args.x, y: args.y, cell: describeCell(project, args.mapId, args.x, args.y, context.statics) },
            reachableCells: first.reachableCells,
            walkableCells: first.walkableCells,
            isolatedWalkableCells: first.isolatedWalkableCells,
            reachableEvents: standing.map((event: any) => ({ id: event.id, name: event.name, x: event.x, y: event.y })),
            unreachableEventCount: first.events.length - standing.length,
            touchableEvents: first.events.filter((event: any) => event.how === "touchable").map((event: any) => event.name),
            portals: first.portals,
            mapsWalked: reports.map((report: any) => `${report.mapId}@${report.start.x},${report.start.y}`),
            // One report per arrival point, so a map two doors lead into appears twice
            // above — which is right, because the two doors can reach different cells.
            // `maps` is the deduplicated set the caller usually wants.
            maps: [...new Set(reports.map((report: any) => report.mapId))].sort((a, b) => a - b),
            reports,
            traps,
            ...(reports.length >= limit ? { note: `Stopped after ${limit} maps; pass a larger maxMaps to walk the whole tree.` } : {})
        };
    })
);

registerTool(
    "list_backups",
    {
        title: "List write backups",
        description:
            "Every write copies the previous file into .rpgmaker-mcp/backups. List them for a data file, or pass a project-relative path like `js/plugins.js` for one of the few files outside data/ that the tools also write.",
        inputSchema: { table: z.string().optional() }
    },
    wrap((args: any) => {
        const project = requireProject();
        if (args.table) {
            return { table: args.table, backups: project.listBackups(args.table) };
        }
        const result: Record<string, number> = {};
        for (const name of [...databaseNames(), "js/plugins.js", ...project.listMaps().map(map => project.mapFileName(map.id))]) {
            const count = project.listBackups(name).length;
            if (count) {
                result[name] = count;
            }
        }
        return { backupDir: project.backupDir, byFile: result };
    })
);

registerTool(
    "rollback_data",
    {
        title: "Roll back a data file",
        description:
            "Restore a backed-up copy of one file. `table` takes the same identifier `list_backups` prints: a database name like `System`, a map as `Map037` or `37`, or a project-relative path like `js/plugins.js`. Without `to` this reverts the newest change (or the one before it, when the newest already matches what is on disk); with `to` it restores a specific backup number from list_backups, where 0 is the oldest. For undoing several of *your own* recent edits across files, prefer `undo_writes`.",
        inputSchema: {
            table: z.string(),
            to: z.number().int().min(-1000).optional().describe("Backup number from list_backups (0 = oldest); omit for the newest change")
        },
        annotations: { destructiveHint: true, idempotentHint: false }
    },
    wrap((args: any) => {
        const project = requireProject();
        // Accept both spellings the rest of the surface uses, so the natural
        // list_backups -> rollback_data pair does not trip over the `Map` prefix.
        const asMap = /^Map0*(\d+)$/i.exec(args.table);
        const pathLike = args.table.includes("/") || /\.(json|js|mjs)$/i.test(args.table);
        const name = isDatabaseName(args.table) || pathLike
            ? args.table
            : project.mapFileName(Number(asMap ? asMap[1] : args.table));
        if (args.to !== undefined) {
            return { target: name, ...project.rollbackTo(name, args.to), notice: EDITOR_NOTICE };
        }
        return { target: name, ...project.rollback(name), notice: EDITOR_NOTICE };
    })
);

registerTool(
    "write_history",
    {
        title: "List this session's writes",
        description:
            "Every file this server process has written, newest first, with the backup each one can be reverted to. This is the ledger `undo_writes` steps through; it lives in memory, so it starts empty when the server restarts even though the backup files are still on disk (list_backups sees those).",
        inputSchema: { limit: z.number().int().min(1).max(200).optional() },
        annotations: { readOnlyHint: true }
    },
    wrap((args: any) => {
        const project = requireProject();
        const entries = project.history(args.limit ?? 25);
        return {
            listed: entries.length,
            index: project.journalLength(),
            entries,
            note: entries.length
                ? "Undoing one entry restores only the file it touched. One tool call can write several files (create_map writes the map and MapInfos), so undoing an operation may take several steps. Pass `index` to undo_writes to step back to exactly here."
                : "Nothing has been written by this server process yet."
        };
    })
);

registerTool(
    "undo_writes",
    {
        title: "Undo recent writes",
        description:
            "Step the last writes back, newest first, each file restored to the bytes it had before that write — which is what `Ctrl+Z` stands in for here, since the editor keeps its undo stack in a process this server cannot reach. A write that created a file removes it again. Pass `steps` to undo several, or `since` with the `index` a previous `write_history` reported to land exactly back at that point whatever was written in between; check `write_history` first, because one tool call can touch more than one file and a half-undone operation is worse than the mistake you meant to take back.",
        inputSchema: {
            steps: z.number().int().min(1).max(50).optional(),
            since: z.number().int().min(0).optional().describe("Undo back to this journal length, the `index` write_history reported, instead of counting steps")
        },
        annotations: { destructiveHint: true, idempotentHint: false }
    },
    wrap((args: any) => {
        const project = requireProject();
        const result =
            args.since !== undefined ? project.undoSince(args.since) : project.undo(args.steps ?? 1);
        return {
            ...result,
            next: result.reverted.map(step => `${step.name} -> ${step.to}`),
            notice: "The running game still holds what it loaded; call live_reload (or start a new game) after undoing map edits, and the editor needs a project reload too."
        };
    })
);

registerTool(
    "check_assets",
    {
        title: "Find asset references that do not resolve",
        description:
            "Scan every image and audio name the project data mentions — database fields (character, face, battler, title1/title2, battlebacks, tileset names, animation effect), map parallax/bgm/bgs fields, and Play BGM/BGS/ME/SE, Show Picture and Play Movie commands inside events — and report the ones with no file on disk plus the ones whose spelling differs from the file only in case. This is the cheap way to find both before a playtest does: a missing image stops the engine's game loop and paints an error into a DOM panel that a canvas screenshot cannot see, and a missing audio file says nothing at all. Icons are not covered: MZ draws them by index from img/system/IconSet.png rather than by name.",
        inputSchema: { limit: z.number().int().min(1).max(500).optional() },
        annotations: { readOnlyHint: true }
    },
    wrap((args: any) => checkAssets(requireProject(), args.limit ?? 60))
);

registerTool(
    "import_asset",
    {
        title: "Put a file where the engine will load it",
        description:
            "MZ has no importer and no per-asset metadata: the folder and the base name are the whole registration. This copies a file into one of the folders the engine's own loaders read (img/characters, img/faces, img/sv_actors, img/sv_enemies, img/enemies, img/battlebacks1/2, img/titles1/2, img/tilesets, img/parallaxes, img/pictures, img/animations, img/system, audio/bgm, audio/bgs, audio/me, audio/se, movies), checks the extension belongs there, refuses a name that differs from an existing file only by case (the filesystem folds those together and the second one would never load), and writes through the same backup journal as every other write, so `undo_writes` takes it back — including deleting a file that did not exist before. The reply gives the value to put in the data field (the name without extension) and which fields already name it, which is the half of `check_assets` that was missing a file. Overwriting needs `overwrite: true`; the bytes being replaced stay recoverable in the backup list.",
        inputSchema: {
            source: z.string().describe("File to bring in: an absolute path, or project-relative when moving between folders"),
            folder: z.string().describe("Target folder, with or without its img/ or audio/ prefix"),
            name: z.string().optional().describe("Asset name without extension (default: the source file's own base name)"),
            overwrite: z.boolean().optional().describe("Replace the file that is already there")
        },
        annotations: { destructiveHint: true, idempotentHint: false }
    },
    wrap((args: any) => importAsset(requireProject(), args))
);

registerTool(
    "list_plugins",
    {
        title: "List configured plugins",
        description:
            "Read `js/plugins.js` and report every entry in load order: enabled or not, its description, and the parameter values the editor stored. Each entry is cross-checked against the `@param` blocks in the plugin's own file, so `undeclared` names a key the plugin never mentions (a typo, or a leftover from an older version) and `unset` lists declared parameters that are running on their `@default`. `fileExists: false` means the plugin is switched on but its script is not in js/plugins/, which stops the game at boot.",
        inputSchema: {},
        annotations: { readOnlyHint: true }
    },
    wrap(() => {
        const plugins = listPlugins(requireProject());
        return {
            path: "js/plugins.js",
            count: plugins.length,
            enabled: plugins.filter(plugin => plugin.status).length,
            missingFiles: plugins.filter(plugin => !plugin.fileExists).map(plugin => plugin.name),
            plugins
        };
    })
);

registerTool(
    "patch_plugin",
    {
        title: "Change a plugin's switch or parameters",
        description:
            "Set one plugin's enabled status, description, or parameter values in `js/plugins.js` — the same edit as the editor's plugin manager, without reformatting the file: only the touched entry's object literal is rewritten. Parameter values are stored the way MZ stores them, so scalars become strings and struct or array values stay JSON. `PluginManager.parameters` is read once at boot, so a running playtest needs a restart to see this, and an editor with the plugin manager open will overwrite the file on save.",
        inputSchema: {
            name: z.string(),
            status: z.boolean().optional(),
            description: z.string().optional(),
            parameters: z.record(z.string(), z.unknown()).optional().describe("Merged over the existing keys; pass null to drop one")
        },
        annotations: { destructiveHint: true, idempotentHint: false }
    },
    wrap((args: any) => {
        const project = requireProject();
        const { file, index, entry } = findPlugin(project, args.name);
        const updated: any = { ...entry };
        const changed: Record<string, unknown> = {};
        if (args.status !== undefined) {
            updated.status = Boolean(args.status);
            changed.status = updated.status;
        }
        if (args.description !== undefined) {
            updated.description = args.description;
            changed.description = args.description;
        }
        if (args.parameters) {
            const parameters: Record<string, unknown> = { ...(entry.parameters ?? {}) };
            for (const [key, value] of Object.entries(args.parameters)) {
                if (value === null) {
                    delete parameters[key];
                } else {
                    // MZ writes every scalar as a string; objects and arrays are
                    // struct and file parameters, which stay as JSON.
                    parameters[key] = value === undefined ? "" : typeof value === "string" || typeof value === "object" ? value : String(value);
                }
            }
            updated.parameters = parameters;
            changed.parameters = parameters;
        }
        if (!Object.keys(changed).length) {
            throw new Error("Nothing to change: pass status, description, or parameters.");
        }
        const { backupPath } = writePluginEntry(project, file, index, updated);
        return {
            name: args.name,
            loadOrder: index,
            changed,
            backupPath,
            notice: "A running playtest will not see this until it restarts, and the editor overwrites js/plugins.js when its plugin manager closes."
        };
    })
);

registerTool(
    "read_plugin_source",
    {
        title: "Read a plugin's source",
        description:
            "Return a window of lines from `js/plugins/<name>.js`, the only way to see what a plugin actually hooks before editing around it. Defaults to the first 200 lines; pass `fromLine` to page through a long file. `declared` carries the parsed `@param` blocks so a parameter name can be matched to the code that reads it.",
        inputSchema: {
            name: z.string(),
            fromLine: z.number().int().min(1).optional(),
            lineCount: z.number().int().min(1).max(2000).optional()
        },
        annotations: { readOnlyHint: true }
    },
    wrap((args: any) => {
        const project = requireProject();
        const path = pluginPath(project, args.name);
        if (!path) {
            throw new Error(
                `js/plugins/${args.name}.js is not in the project. list_plugins shows what is installed; a plugin that was never added through the editor has no file or entry here.`
            );
        }
        const lines = readFileSync(path, "utf8").split(/\r?\n/);
        const from = Math.min(Math.max(1, args.fromLine ?? 1), lines.length);
        const count = args.lineCount ?? 200;
        const slice = lines.slice(from - 1, from - 1 + count);
        return {
            name: args.name,
            file: `js/plugins/${args.name}`,
            totalLines: lines.length,
            fromLine: from,
            toLine: from + slice.length - 1,
            text: slice.join("\n")
        };
    })
);

registerTool(
    "enable_plugin",
    {
        title: "Switch a plugin file on",
        description:
            "Put a plugin that is already sitting in `js/plugins/` into `js/plugins.js` — the same edit the editor's plugin manager makes, and the step `patch_plugin` cannot do because it only reaches entries that are already listed. The parameters come from the file's own `@param`/`@default` header, so nothing runs on a value the plugin never declares, and `parameters` overrides single keys on top of that. Re-running it on a plugin that is already listed switches it on and merges your parameters instead of adding a second entry. A game already running read `js/plugins.js` at boot, so it needs a restart — and an editor with the plugin manager open overwrites this file on save.",
        inputSchema: {
            name: z.string().describe("The plugin's name, which is the file name in js/plugins without .js"),
            file: z.string().optional().describe("Set when the file is not <name>.js. A trailing .js is accepted and stripped, so either spelling works"),
            parameters: z.record(z.string(), z.unknown()).optional().describe("Values to put on top of the header's @default ones"),
            status: z.boolean().optional().describe("Pass false to switch it off without removing the entry")
        },
        annotations: { title: "Enable a plugin", destructiveHint: true, idempotentHint: true }
    },
    wrap((args: any) => {
        const project = requireProject();
        // The name of a plugin in js/plugins.js is its file without the extension, so an
        // agent that hands over the file name it can see on disk means the same thing.
        const file = String(args.file ?? args.name).replace(/\.js$/i, "");
        const path = pluginPath(project, file);
        if (!path) {
            throw new Error(
                `js/plugins/${file}.js is not in this project, so there is nothing to enable. ` +
                    `Copy the file in first — import_asset takes a file from disk into the project.`
            );
        }
        const source = readFileSync(path, "utf8");
        const entry = enablePlugin(project, args.name, source, (args.parameters ?? {}) as Record<string, unknown>);
        if (args.status === false) {
            const found = findPlugin(project, args.name);
            writePluginEntry(project, found.file, found.index, { ...found.entry, status: false });
        }
        return {
            name: args.name,
            file: `js/plugins/${file}.js`,
            enabled: args.status !== false,
            added: entry.added,
            loadOrder: entry.loadOrder,
            parameters: entry.parameters,
            notice:
                entry.added || args.status !== false
                    ? "js/plugins.js now lists it, so the next game start loads it. A playtest already running will not pick it up."
                    : "Listed but switched off, which is what the editor's unticked box looks like."
        };
    })
);

registerTool(
    "write_plugin_source",
    {
        title: "Write a plugin's source",
        description:
            "Create or replace `js/plugins/<name>.js`. This is Unity's manage_script equivalent, with one difference that matters for the loop: MZ plugins are plain JavaScript loaded at boot, so there is no compile step to wait for — the file is live the moment a game starts. The write is journaled, so `undo_writes` takes it back, and `js/plugins.js` is not touched unless `enable` is set. With `enable` the plugin is added to the editor's list (or switched on if it is already there) and its parameters filled from the `@default` values in the header it was just given, which means the header has to be written first for the parameters to be anything. A game already running will not pick any of this up: restart it.",
        inputSchema: {
            name: z.string().regex(/^[A-Za-z0-9_\-]{1,64}$/).describe("File name without extension; no path separators"),
            text: z.string(),
            enable: z.boolean().optional(),
            parameters: z.record(z.string(), z.unknown()).optional().describe("Parameter values to store when enabling, overriding the header defaults")
        },
        annotations: { destructiveHint: true, idempotentHint: false }
    },
    wrap((args: any) => {
        const project = requireProject();
        const relative = `js/plugins/${args.name}.js`;
        const written = project.writeText(relative, args.text);
        const entry = args.enable
            ? enablePlugin(project, args.name, args.text, (args.parameters ?? {}) as Record<string, unknown>)
            : null;
        return {
            file: relative,
            created: written.backupPath === null,
            bytes: Buffer.byteLength(args.text, "utf8"),
            backupPath: written.backupPath,
            entry,
            notice: entry
                ? "js/plugins.js now lists it, so the next game start loads it. An editor with the plugin manager open overwrites that file on save."
                : "Written but not listed in js/plugins.js, so no game will load it until it is enabled."
        };
    })
);

registerTool(
    "block_structure",
    {
        title: "Explain event block structure",
        description:
            "Report the engine-verified rules for nested command lists: which codes take a deeper indent, which continuation codes repeat, and where a block ends. Given a page it also returns the same `warnings` the writers return — the places where this list's indents will not do what they look like they mean.",
        inputSchema: {
            mapId: z.number().int().optional(),
            eventId: z.number().int().optional(),
            pageIndex: z.number().int().min(0).optional()
        }
    },
    wrap((args: any) => {
        const rules = {
            indentation: "Blocks are indent-based. skipBranch() walks past every command deeper than the current one, so Conditional Branch (111) and Show Choices (102) have no closing command.",
            loopCloser: "Loop (112) is closed by Repeat Above (413); Break Loop (113) counts 112/413 pairs to find its exit.",
            continuations: "These codes repeat at the same indent as their opener and have no interpreter handler: 101 Show Text -> 401 per line, 105 Show H/G Text -> 405, 108 Comment -> 408, 355 Script -> 655.",
            terminator: "Every page list ends with { code: 0, indent: 0, parameters: [] }."
        };
        if (args.mapId && args.eventId) {
            const project = requireProject();
            const map = project.readMap(args.mapId);
            const event = getEvent(map, args.eventId);
            if (!event) {
                throw new Error(`Event ${args.eventId} not found on map ${args.mapId}`);
            }
            const page = event.pages[args.pageIndex ?? 0];
            const blocks = page.list
                .map((command: any, index: number) => ({ command, index }))
                .filter(({ command }: any) => command.indent > 0 || command.code === 0 || command.code === 413)
                .slice(0, 60);
            return {
                ...rules,
                warnings: blockStructureWarnings(page.list),
                structure: blocks.map(({ command, index }: any) => ({
                    index,
                    code: command.code,
                    indent: command.indent,
                    blockEndsAt: command.indent > 0 ? findBlockEnd(page.list, index) : undefined
                }))
            };
        }
        return rules;
    })
);

registerTool(
    "live_status",
    {
        title: "Live game status",
        description:
            "Report what the running game last sent through the RMMZLiveBridge plugin: scene, map, player position, switches, variables and party. `listening` is about *this* process's own socket, and the call waits for the bind to report, so a port another copy of this server already holds reads as a `listenError` here rather than as health. Also explains how to enable the bridge.",
        inputSchema: {}
    },
    wrap(async () => {
        await liveBridge.ensure();
        const status = liveBridge.status();
        const warnings: string[] = [];
        if (status.listenError) {
            warnings.push(`NOT LISTENING: ${status.listenError}`);
        }
        if (status.stalled) {
            warnings.push(
                `STALLED: a page is reporting but has not advanced a frame in over 1.5s (last frame ${String((status.state as any)?.frame ?? "?")}). ` +
                    `Its browser tab is hidden or background-throttled, or the game is paused, so live_key, live_wait and any scene change will time out. ` +
                    `Start a session with live_session, which keeps its page awake, or live_step to drive frames by hand.`
            );
        }
        if (status.authError) {
            warnings.push(`AUTH: ${status.authError} (${status.rejectedPolls} poll(s) turned away).`);
        }
        if (status.pollers.length > 1) {
            warnings.push(
                `${status.pollers.length} documents are polling this port${status.targetPage ? ` and commands only go to ${status.targetPage}` : ""}. ` +
                    `A playtest left over from another window reads as a live game but is not the one you are driving.`
            );
        }
        const shipped = shippedBridgeVersion();
        const running = (status.state as any)?.bridge;
        if (running && shipped && String(running) !== shipped) {
            warnings.push(
                `STALE BRIDGE: the game is running RMMZLiveBridge v${running} and this server ships v${shipped}. ` +
                    `Copy plugin/RMMZLiveBridge.js over <project>/js/plugins/RMMZLiveBridge.js and restart the playtest — ` +
                    `a live tool that answers for the older file is otherwise indistinguishable from a broken one.`
            );
        }
        if (status.listening && !status.pollers.length && !status.lastSeenAt) {
            warnings.push(
                `Listening on ${status.host}:${status.port} with nothing polling it. Either no game is running, or its bridge plugin points at a ` +
                    `different port — check the plugin's "port" parameter, or the ?rmmzBridgePort= the page URL carries. Another copy of this server ` +
                    `holding the port would have shown a listenError instead.`
            );
        }
        return {
            ...status,
            connect: {
                pluginFile: "plugin/RMMZLiveBridge.js",
                install:
                    "Copy plugin/RMMZLiveBridge.js into <project>/js/plugins/, enable it in the editor's plugin manager, set its `token` parameter to the same value as RMMZ_LIVE_TOKEN, and set `Allow Eval` to true if you want live_eval to work.",
                url: `http://${status.host}:${status.port}`,
                tokenEnvSet: status.tokenConfigured
            },
            note: warnings.length
                ? warnings.join(" ")
                : status.lastSeenAt
                  ? `Last report ${status.ageMs}ms ago${status.measuredFps ? `, ${status.measuredFps} frames/s` : ""}.`
                  : "No game has connected yet. The bridge is polled by the game, so nothing to do server side until a playtest starts."
        };
    })
);

registerTool(
    "live_eval",
    {
        title: "Evaluate in the running game",
        description:
            "Run a JavaScript expression inside the live game and return its value. Requires the plugin's Allow Eval parameter, a configured RMMZ_LIVE_TOKEN, and a running playtest. Anything the engine exposes works: $gameVariables.value(3), $gamePlayer._x, $gameSwitches.value(12). An expression that returns a promise is waited for and the settled value comes back, so one call can watch a frame counter, a transfer or a scene change instead of polling for it. The game gives a promise 20000ms to settle and the call waits for the same 20000ms by default, so a promise that needs 15s is answered, not cut off; raise `timeoutMs` to 60000 for a longer wait, but the plugin still abandons the promise itself at 20s. " +
            "Two engine behaviors bite here, so they are worth knowing before a result looks wrong. Calling an API that moves the character directly (`$gamePlayer.moveStraight(6)`) reaches some of what a key does and not the rest: the party step count and the touch triggers happen inside the step itself, but the encounter counter only ticks in `Game_Player.updateNonmoving`, which is a frame or two later, so a fast scripted walk can outrun it — `live_move` holds the arrow instead and gets all of it. And `$gamePlayer.performTransfer()` run by hand rebuilds the map from the *previous* map's `$dataMap`, because loading the new file is `Scene_Map`'s job: the player then stands \"on\" the new map with the old map's events running under them. `reserveTransfer(...)` and wait is the way.",
        inputSchema: {
            expression: z.string().describe("A single expression; wrap statements in (() => { ... })()"),
            timeoutMs: z
                .number()
                .int()
                .min(100)
                .max(60000)
                .optional()
                .describe("How long to wait (default 20000, the same ceiling the plugin gives a promise)")
        }
    },
    wrap(async (args: any) => {
        const result = await liveBridge.send({ type: "eval", code: String(args.expression) }, args.timeoutMs ?? 20000);
        if (!result.ok) {
            throw new Error(result.error ?? "command failed");
        }
        return { value: result.value };
    })
);

registerTool(
    "live_wait",
    {
        title: "Wait for a game condition",
        description:
            "Poll an expression in the running game until it is truthy, so a sequence (menu open, battle over, message finished) can be followed instead of guessed at.",
        inputSchema: {
            expression: z.string().describe("Polled about every 250ms until truthy or timeout"),
            timeoutMs: z.number().int().min(500).max(180000).optional(),
            pollMs: z.number().int().min(50).max(5000).optional()
        }
    },
    wrap(async (args: any) => {
        const timeoutMs = args.timeoutMs ?? 15000;
        const pollMs = args.pollMs ?? 250;
        const deadline = Date.now() + timeoutMs;
        let last: unknown = null;
        while (Date.now() < deadline) {
            try {
                const result = await liveBridge.send({ type: "eval", code: String(args.expression) }, Math.max(1000, pollMs * 4));
                last = result.value;
                if (result.ok && result.value) {
                    return { satisfied: true, value: result.value, waitedMs: timeoutMs - (deadline - Date.now()) };
                }
            } catch (error) {
                last = error instanceof Error ? error.message : String(error);
            }
            await new Promise(resolve => setTimeout(resolve, pollMs));
        }
        return { satisfied: false, last, timeoutMs };
    })
);

registerTool(
    "live_key",
    {
        title: "Send a key to the running game",
        description:
            "Press a game key in the live game (Ok=13/32, Cancel=27, Shift=16, arrow keys 37-40) to advance dialogs or drive input. Each press is held for a counted number of engine frames and re-asserted on every one of them, and the call answers once the game has run them all, so a slow or headless frame rate cannot swallow it and neither can the browser taking focus. The reply carries the measured frame rate it was sized with and whether the player's cell actually changed. To walk somewhere, prefer live_move: one press is one step only if the player happens to be standing still when it lands. Needs the RMMZLiveBridge plugin, not Allow Eval.",
        inputSchema: {
            keyCode: z.number().int().min(1).max(255),
            pulses: z.number().int().min(1).max(20).optional().describe("How many short presses to send (default 3)"),
            holdFrames: z.number().int().min(1).max(30).optional().describe("Engine frames each press is held for (default 2)")
        }
    },
    wrap(async (args: any) => {
        const requestedPulses = args.pulses ?? 3;
        const holdFrames = args.holdFrames ?? 2;
        const gapMs = 120;
        // Because the hold is counted in frames, the wall-clock cost of a pulse is
        // `holdFrames / fps`, and a page is measured rather than assumed: 20 presses x
        // 30 frames is over a minute of real time at 9 frames/s. The press list is
        // clipped to what fits the budget, the game stops on the same deadline, and the
        // reply is either the presses or a reason - never a bare timeout 66s later.
        const fps = liveBridge.frameRate() ?? 20;
        const perPulseMs = (1000 / fps) * holdFrames + gapMs;
        const budgetMs = 45000;
        const pulses = Math.max(1, Math.min(requestedPulses, Math.floor(budgetMs / perPulseMs)));
        const estimatedMs = Math.round(pulses * perPulseMs);
        const timeoutMs = Math.min(60000, Math.max(8000, Math.round(estimatedMs * 2.5 + 4000)));
        const result = await liveBridge.send({ type: "key", keyCode: Number(args.keyCode), pulses, holdFrames, gapMs, timeoutMs: timeoutMs - 2000 }, timeoutMs);
        if (!result.ok) {
            const why =
                pulses < requestedPulses
                    ? `asked for ${requestedPulses} presses, sent ${pulses}: ${requestedPulses} x ${holdFrames} frames does not fit ${budgetMs}ms at ${fps} frames/s`
                    : `${pulses} press(es) of ${holdFrames} frames at the measured ${fps} frames/s, wait ${timeoutMs}ms`;
            throw new Error(`${result.error ?? "key command failed"} (${why})`);
        }
        return {
            sent: args.keyCode,
            ...(result.value as Record<string, unknown>),
            timing: {
                measuredFps: fps,
                estimatedMs,
                timeoutMs,
                ...(pulses < requestedPulses ? { clampedPulses: `asked for ${requestedPulses}, sent ${pulses}: ${pulses} presses at ${fps}fps does not fit ${budgetMs}ms` } : {})
            }
        };
    })
);

registerTool(
    "live_move",
    {
        title: "Walk the player the way a key does",
        description:
            "Hold an arrow key until the player has arrived `cells` cells away, and answer with where they really got to and what stopped them. Use this instead of live_key whenever the intent is go-there rather than press-this: a direction press only moves the player on a frame when they are standing still, so a key press is not one step, and this waits for the steps themselves. Because it drives the engine's own input path, the things that only happen when a person walks happen here too - the party's step count, the encounter roll, an event set to player-touch. A wall, a dialog, a running event or a scene change ends the walk early and says which. Needs the RMMZLiveBridge plugin, not Allow Eval.",
        inputSchema: {
            direction: z.union([z.literal(2), z.literal(4), z.literal(6), z.literal(8)]).describe("Numpad direction: 2 down, 4 left, 6 right, 8 up"),
            cells: z.number().int().min(1).max(30).optional().describe("How many cells to walk (default 1)"),
            timeoutMs: z.number().int().min(500).max(20000).optional().describe("Give up after this long (default 8000)")
        }
    },
    wrap(async (args: any) => {
        const timeoutMs = args.timeoutMs ?? 8000;
        const result = await liveBridge.send({ type: "move", direction: args.direction, cells: args.cells ?? 1, timeoutMs: Math.max(500, timeoutMs - 1000) }, timeoutMs + 2000);
        if (!result.ok) {
            throw new Error(result.error ?? "move command failed");
        }
        return result.value;
    })
);

registerTool(
    "live_reload",
    {
        title: "Hot-reload the map the game is standing on",
        description:
            "Make the running playtest re-read the current map file and rebuild itself around it: tiles, autotiles, events and map size, with the player left where they are. This is the author-then-look loop — after set_tiles / place_event / set_event_page, call it instead of booting a new game and transferring. It returns once the reloaded map is actually live, so the next live_eval or live_screenshot sees the change. Event interpreters restart from the top and database tables (System, Actors, Items, Tilesets) are not re-read, so a new game is still the answer for those. Does not need Allow Eval.",
        inputSchema: {}
    },
    wrap(async () => {
        const before = Number((liveBridge.status().state as any)?.reloads ?? 0);
        const result = await liveBridge.send({ type: "reload" }, 15000);
        if (!result.ok) {
            throw new Error(result.error ?? "reload failed");
        }
        // Scene_Map.create() sets $dataMap to null and reads the file again
        // asynchronously, so the command can answer while the game is still holding the
        // map it had. Wait for the bridge to report the reload landed.
        let landed = false;
        for (let attempt = 0; attempt < 40 && !landed; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 250));
            const state = liveBridge.status().state as any;
            landed = Boolean(state?.map) && state?.reloadPending === false && Number(state?.reloads ?? 0) > before;
        }
        return {
            ...(result.value as object),
            mapReady: landed,
            ...(landed
                ? {}
                : {
                      note:
                          "The game had not finished the scene change within 10s. A paused game never does: the change happens inside " +
                          "the update loop, so lift live_pause first. Otherwise read live_diagnostics for what stopped it."
                  })
        };
    })
);

registerTool(
    "live_screenshot",
    {
        title: "See the frame the game is drawing",
        description:
            "Grab the running game's own composited frame as a PNG: message windows, face graphics, fonts, weather, character sprites, tile blending. `render_map` shows what the data says; this shows what the player sees. It re-runs the engine's render pass (`Graphics._app.render()`) and reads the canvas in the same task, so it works without MZ enabling `preserveDrawingBuffer`. Video playback is a separate DOM element and is not part of the frame. Needs a running playtest.",
        inputSchema: {
            saveTo: z.string().optional().describe("Also write the PNG to this absolute path")
        },
        annotations: { readOnlyHint: true }
    },
    async (args: any) => {
        try {
            const result = await liveBridge.send({ type: "screenshot" }, 12000);
            const frame = result.value as
                | { png?: string; width?: number; height?: number; scene?: string; litSamples?: number; totalSamples?: number }
                | undefined;
            if (!result.ok || typeof frame?.png !== "string" || !frame.png.startsWith("data:image/png")) {
                throw new Error(result.error ?? "the game returned no frame");
            }
            const base64 = frame.png.slice(frame.png.indexOf(",") + 1);
            const png = Buffer.from(base64, "base64");
            let savedTo: string | null = null;
            if (args.saveTo) {
                mkdirSync(dirname(args.saveTo), { recursive: true });
                writeFileSync(args.saveTo, png);
                savedTo = args.saveTo;
            }
            return {
                content: [
                    { type: "image" as const, data: base64, mimeType: "image/png" },
                    {
                        type: "text" as const,
                        text: JSON.stringify(
                            {
                                scene: frame.scene,
                                pixels: [frame.width, frame.height],
                                litSamples: `${frame.litSamples}/${frame.totalSamples}`,
                                bytes: png.length,
                                savedTo
                            },
                            null,
                            2
                        )
                    }
                ]
            };
        } catch (error) {
            return fail(error);
        }
    }
);

registerTool(
    "live_diagnostics",
    {
        title: "Read the running game's errors and console",
        description:
            "Return what the live game has logged: uncaught exceptions, entries from the engine's own error screen, failed image/audio/data loads, and console.warn/error output. The plugin keeps a rolling 200-entry buffer and merges repeats, so a per-frame throw arrives once with a repeat count. Pass the `cursor` from a previous reply as `since` to fetch only what is new, or `clear` before an action so whatever appears afterwards was caused by it, or `full` to get the recorded call stack with each entry. This keeps answering after the game has crashed (SceneManager.stop() freezes the render loop; `stopped` reports it), which is exactly when the file layer cannot tell you what went wrong.",
        inputSchema: {
            since: z.number().int().min(0).optional().describe("Only return entries newer than this cursor (default 0)"),
            limit: z.number().int().min(1).max(200).optional(),
            clear: z.boolean().optional().describe("Empty the buffer after reading it"),
            full: z.boolean().optional().describe("Include each error's call stack, up to 24 frames. Off by default to keep the reply small.")
        },
        annotations: { readOnlyHint: true }
    },
    wrap(async (args: any) => {
        const result = await liveBridge.send(
            { type: "diagnostics", since: args.since ?? 0, limit: args.limit ?? 50, clear: args.clear ?? false, full: args.full ?? false },
            10000
        );
        if (!result.ok) {
            throw new Error(result.error ?? "diagnostics failed");
        }
        return result.value;
    })
);

registerTool(
    "live_pause",
    {
        title: "Freeze or resume the running game",
        description:
            "Stop the engine's update loop without leaving the scene, the way Unity's pause works: `SceneManager.updateMain` is skipped, so nothing moves, no event interpreter advances and no input is sampled, while the last frame stays on screen and live_screenshot / live_eval / live_diagnostics keep answering. Keys sent with live_key while paused are dropped, because Input is only sampled inside the update loop. Resume with `paused: false`.",
        inputSchema: { paused: z.boolean() },
        annotations: { idempotentHint: true }
    },
    wrap(async (args: any) => {
        const result = await liveBridge.send({ type: "pause", paused: Boolean(args.paused) }, 8000);
        if (!result.ok) {
            throw new Error(result.error ?? "pause failed");
        }
        return result.value;
    })
);

registerTool(
    "live_step",
    {
        title: "Advance the running game by exact frames",
        description:
            "Run N engine frames and stop again, for watching an animation cycle, a message window page by page, or a battle sequence frame by frame. Pauses first if the game is running, then calls `SceneManager.updateMain` exactly N times (1..600), so the reported `advanced` is the frame delta to compare against. A frame that throws is handed to the engine's own catchException, so the error shows up in live_diagnostics rather than killing the session silently.",
        inputSchema: { frames: z.number().int().min(1).max(600).optional() },
        annotations: { idempotentHint: false }
    },
    wrap(async (args: any) => {
        const result = await liveBridge.send({ type: "step", frames: args.frames ?? 1 }, 20000);
        if (!result.ok) {
            throw new Error(result.error ?? "step failed");
        }
        return result.value;
    })
);

registerTool(
    "assert_in_game",
    {
        title: "Run a list of assertions in the running game",
        description:
            "Hand over a list of `{label, expression}` and get a pass/fail report back, the way a test runner does it, instead of writing a throwaway script for every playtest. Each expression is evaluated in game scope and has to be truthy; give one a `timeoutMs` to poll it until it holds, which is what a dialog opening, a transfer landing or a battle ending needs. A failing assertion does not stop the rest unless `stopOnFailure` is set, and whatever the game logged while the list ran comes back with the result, so a failure arrives with its own reason attached. Needs Allow Eval on the plugin.",
        inputSchema: {
            assertions: z
                .array(
                    z.object({
                        label: z.string().describe("Shown verbatim in the report"),
                        expression: z.string().describe("Evaluated in game scope; truthy passes"),
                        timeoutMs: z
                            .number()
                            .int()
                            .min(0)
                            .max(120000)
                            .optional()
                            .describe("Poll until truthy for this long; 0 or omitted evaluates once")
                    })
                )
                .min(1)
                .max(60),
            pollMs: z.number().int().min(50).max(5000).optional(),
            stopOnFailure: z.boolean().optional()
        },
        annotations: { idempotentHint: false }
    },
    wrap(async (args: any) => {
        const pollMs = args.pollMs ?? 250;
        const cursorOf = async () => {
            const seen = await liveBridge.send({ type: "diagnostics", since: 0, limit: 1 }, 8000);
            return Number((seen.value as { cursor?: number })?.cursor ?? 0);
        };
        let started = 0;
        try {
            started = await cursorOf();
        } catch {
            // A game that cannot answer this will fail the assertions as well,
            // and their errors say so. Do not mask that with a log error.
        }
        const results: any[] = [];
        for (const assertion of args.assertions) {
            const deadline = Date.now() + (assertion.timeoutMs ?? 0);
            const began = Date.now();
            let value: unknown = null;
            let problem: string | null = null;
            for (;;) {
                try {
                    const answer = await liveBridge.send({ type: "eval", code: assertion.expression }, Math.max(6000, pollMs * 8));
                    value = answer.value ?? null;
                    problem = answer.ok ? null : (answer.error ?? "the expression failed");
                } catch (error) {
                    problem = error instanceof Error ? error.message : String(error);
                    value = null;
                }
                if (problem === null && value) {
                    break;
                }
                if (Date.now() >= deadline) {
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, pollMs));
            }
            const ok = problem === null && Boolean(value);
            results.push({
                label: assertion.label,
                ok,
                value,
                ...(problem ? { error: problem } : {}),
                ...(assertion.timeoutMs ? { waitedMs: Date.now() - began } : {})
            });
            if (!ok && args.stopOnFailure) {
                break;
            }
        }
        let logged: unknown[] = [];
        try {
            const seen = await liveBridge.send({ type: "diagnostics", since: started, limit: 50 }, 8000);
            logged = ((seen.value as { entries?: unknown[] })?.entries ?? []) as unknown[];
        } catch {
            // reported by the assertions themselves
        }
        const failed = results.filter(result => !result.ok);
        return {
            ok: failed.length === 0 && results.length === args.assertions.length,
            passed: results.length - failed.length,
            failed: failed.length,
            results,
            loggedWhileRunning: logged.map(entry => `${(entry as any).kind}: ${(entry as any).message}`)
        };
    })
);

/** Compact one tool result for a batch report: no base64, bounded size. */
function stepResult(result: any): { ok: boolean; value: unknown; error: string | null } {
    const parts: any[] = result?.content ?? [];
    const text = parts.find(part => part?.type === "text")?.text ?? "";
    const image = parts.find(part => part?.type === "image");
    let value: unknown = text;
    try {
        value = JSON.parse(text);
    } catch {
        // A tool that answers with plain text keeps it as text.
    }
    if (image) {
        value = { ...(typeof value === "object" && value ? (value as object) : {}), imageBytes: Buffer.from(String(image.data ?? ""), "base64").length };
    }
    if (value && typeof value === "object") {
        const json = JSON.stringify(value);
        if (json.length > 1500) {
            value = { note: "result too long for a batch report", keys: Object.keys(value as object), chars: json.length };
        }
    } else if (typeof value === "string" && value.length > 1500) {
        value = `${value.slice(0, 1500)}…`;
    }
    return result?.isError
        ? { ok: false, value, error: String((value as any)?.error ?? text ?? "the step reported a failure") }
        : { ok: true, value, error: null };
}

/** Steps that move the write journal, which a transaction is defined against. */
const NESTED_REFUSAL = new Set(["batch", "undo_writes", "rollback_data"]);

registerTool(
    "batch",
    {
        title: "Apply several tool calls or none of them",
        description:
            "Run a list of `{tool, args}` calls in order as one transaction. If a step fails — or is rejected before it runs, " +
            "because the arguments do not match what that tool declares — every file the batch wrote goes back to the bytes it " +
            "had before, so a bad argument on step four never leaves a half-built map behind. Each step's arguments are validated " +
            "against that tool's own schema first, so the whole list is checked for the obvious mistakes before anything is written. " +
            "Reading tools may be included and their results come back per step. `undo_writes`, `rollback_data` and a nested `batch` " +
            "are refused as steps: they move the write journal this transaction rolls back against. Steps that talked to the running " +
            "game are named in the reply, because a file rollback cannot un-press a key — follow it with live_reload or a new game.",
        inputSchema: {
            steps: z
                .array(
                    z.object({
                        tool: z.string().describe("A tool name this server registers"),
                        args: z.record(z.string(), z.unknown()).optional().describe("Arguments for that tool, exactly as it declares them")
                    })
                )
                .min(1)
                .max(25),
            stopOnFailure: z.boolean().optional().describe("Stop at the first failing step (default), or run the rest and still roll everything back")
        },
        annotations: { title: "Transaction", destructiveHint: true, idempotentHint: true }
    },
    wrap(async (args: any) => {
        const project = requireProject();
        const from = project.journalLength();
        const report: any[] = [];
        const failures: { index: number; tool: string; error: string }[] = [];
        for (let index = 0; index < args.steps.length; index++) {
            const step = args.steps[index];
            const entry = registry.get(step.tool);
            let problem: string | null = null;
            let parsed: any = null;
            if (!entry) {
                problem = `this server has no tool named "${step.tool}"`;
            } else if (NESTED_REFUSAL.has(step.tool)) {
                problem = `"${step.tool}" cannot be a step in a batch: it moves the journal the batch would roll back`;
            } else {
                const checked = z.object(entry.schema).safeParse(step.args ?? {});
                if (!checked.success) {
                    problem = checked.error.issues
                        .map(issue => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
                        .join("; ");
                } else {
                    parsed = checked.data;
                }
            }
            if (problem) {
                failures.push({ index, tool: step.tool, error: problem });
                if (args.stopOnFailure !== false) {
                    break;
                }
                continue;
            }
            const before = project.journalLength();
            const outcome = stepResult(await entry!.run(parsed));
            report.push({
                index,
                tool: step.tool,
                ok: outcome.ok,
                wrote: project.writesSince(before).map(write => write.name),
                ...(outcome.ok ? { result: outcome.value } : { error: outcome.error })
            });
            if (!outcome.ok) {
                failures.push({ index, tool: step.tool, error: outcome.error ?? "the step reported a failure" });
                if (args.stopOnFailure !== false) {
                    break;
                }
            }
        }
        const wrote = project.writesSince(from).map(write => write.name);
        if (failures.length === 0) {
            return {
                ok: true,
                applied: report.length,
                wrote,
                results: report,
                journal: { from, to: project.journalLength() }
            };
        }
        const rolledBack = project.undoSince(from);
        const live = report.filter(step => step.tool.startsWith("live_") || step.tool === "assert_in_game").map(step => step.tool);
        return {
            ok: false,
            failures,
            applied: report.length,
            rolledBack: rolledBack.reverted,
            journal: { from, to: project.journalLength() },
            ...(live.length
                ? {
                      note:
                          `These steps reached the running game, and a file rollback does not reach it back: ${live.join(", ")}. ` +
                          `live_reload, or a new game, is what makes it match the reverted files.`
                  }
                : {})
        };
    })
);

const playtest = new PlaytestSession(join(PACKAGE_ROOT, ".rpgmaker-mcp"), () => requireProject().dir);

registerTool(
    "live_session",
    {
        title: "Start or stop a headless playtest",
        description:
            "Own the whole loop from the tool surface: `start` serves the project on a loopback port, launches a windowless Chromium-family " +
            "browser on it and waits for the RMMZLiveBridge plugin to report, so live_status / live_screenshot / assert_in_game have a game to " +
            "answer from without anyone opening the editor. By default it then walks the title screen into a new game with the engine's own " +
            "`commandNewGame`; a client that allows only sixty seconds per call should pass `newGame: false` and call `boot` afterwards, because a " +
            "cold boot plus that walk can exceed sixty seconds. `boot` alone drives whatever the page is showing into a map, `status` reports what " +
            "is running, `reload` reloads the page (what a freshly written plugin file needs), `stop` closes the browser and releases the port. The " +
            "browser is the only process this tool starts, it is recorded in .rpgmaker-mcp/session.json, and `stop` kills that pid's tree only after " +
            "confirming the recorded profile directory is still on its command line, so a recycled pid is never touched. It refuses to start a " +
            "second browser while a game is already reporting, because two games on one bridge cannot be told apart. Reaching a map needs the plugin " +
            "params Allow Eval and keepAwake: without the first the session comes up on the title screen and says so, without the second a headless " +
            "page never has focus and MZ skips scene updates.",
        inputSchema: {
            action: z.enum(["start", "status", "boot", "reload", "stop"]),
            gamePort: z.number().int().min(1024).max(65535).optional().describe("Loopback port for the project files (default 8080; moves on if busy)"),
            browser: z.string().optional().describe("Absolute path to a browser executable; otherwise RMMZ_BROWSER, then Edge/Chrome/Chromium"),
            newGame: z.boolean().optional().describe("Walk to the starting map as part of this call (default true)"),
            waitForBridgeMs: z.number().int().min(2000).max(180000).optional().describe("How long to wait for the plugin to report (default 45000)"),
            bootMs: z.number().int().min(1000).max(120000).optional().describe("How long the walk to the starting map may take (default 45000)"),
            force: z.boolean().optional().describe("start even though a game is already reporting to the bridge")
        },
        annotations: { title: "Headless playtest session", destructiveHint: true, openWorldHint: false }
    },
    wrap(async (args: any) => {
        switch (args.action) {
            case "start":
                return playtest.start({
                    gamePort: args.gamePort,
                    browser: args.browser,
                    newGame: args.newGame,
                    waitForBridgeMs: args.waitForBridgeMs,
                    bootMs: args.bootMs,
                    force: args.force
                });
            case "boot":
                return playtest.boot(args.bootMs ?? 45_000);
            case "reload":
                return playtest.reload({ newGame: args.newGame, waitForBridgeMs: args.waitForBridgeMs });
            case "stop":
                return playtest.stop();
            case "status":
            default:
                return playtest.status();
        }
    })
);

/**
 * The high-level tools are additive: the 46 primitives above stay, because an authoring
 * shape this layer does not cover still needs *something* to be written with. They run on
 * the same registry, so `batch` can call them and their own writes land in the same journal.
 */
function unwrapToolResult(name: string, result: any): { payload: any; image: { data: string; mimeType: string } | null } {
    const parts: any[] = result?.content ?? [];
    const text = parts.find(part => part?.type === "text")?.text ?? "";
    let payload: any = text;
    try {
        payload = JSON.parse(text);
    } catch {
        // A tool that answers with plain text keeps it as text.
    }
    if (result?.isError) {
        throw new Error(`${name}: ${payload?.error ?? text ?? "the call failed"}`);
    }
    const image = parts.find(part => part?.type === "image");
    return { payload, image: image ? { data: image.data, mimeType: image.mimeType } : null };
}

async function runTool(name: string, args: Record<string, unknown>) {
    const entry = registry.get(name);
    if (!entry) {
        throw new Error(`this server has no tool named "${name}"`);
    }
    return entry.run(args);
}

registerHighLevelTools({
    register: registerTool,
    guarded: handler => async (args: any) => {
        try {
            return await handler(args);
        } catch (error) {
            return fail(error);
        }
    },
    project: requireProject,
    statics: () => requireRender().statics,
    async call(name, args) {
        return unwrapToolResult(name, await runTool(name, args)).payload;
    },
    async callWithImage(name, args) {
        const { payload, image } = unwrapToolResult(name, await runTool(name, args));
        return { payload, image };
    },
    liveActive: () => {
        const status = liveBridge.status();
        return Boolean(status.state) && status.ageMs !== null && status.ageMs < 5000;
    },
    codebook: () => state.codebook,
    async transaction<T>(run: () => Promise<T>): Promise<{ value: T; wrote: string[] }> {
        const project = requireProject();
        const from = project.journalLength();
        try {
            const value = await run();
            // One entry per file, not per write: an event rebuild touches the same map
            // half a dozen times, and a caller reading the diff wants to know which files moved.
            return { value, wrote: [...new Set(project.writesSince(from).map(write => write.name))] };
        } catch (error) {
            const rolled = project.undoSince(from);
            const restored = rolled.reverted.map(write => write.name);
            throw new Error(
                `${(error as Error).message}` +
                    (restored.length
                        ? ` Nothing half-written was left behind: ${restored.join(", ")} ${restored.length > 1 ? "were" : "was"} restored to the bytes from before this call.`
                        : "")
            );
        }
    }
});

async function main(): Promise<void> {
    try {
        state.project = new Project({ projectDir: projectDirFromEnv() ?? '' });
    } catch (error) {
        state.project = null;
        state.projectError = projectDirFromEnv()
            ? (error instanceof Error ? error.message : String(error))
            : 'RMMZ_PROJECT is not set; tools that need a project will report this until it is configured.';
    }
    await server.connect(new StdioServerTransport());
}

const isEntrypoint = typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
    main().catch(error => {
        console.error(error);
        process.exit(1);
    });
}

export { server, state };
