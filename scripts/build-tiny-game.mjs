/**
 * Build a small complete game inside the demo project using only the registered
 * MCP tools, then render it so the result can be looked at rather than guessed.
 *
 *   node scripts/build-tiny-game.mjs probe    # what the project and tilesets offer
 *   node scripts/build-tiny-game.mjs build    # maps, tiles, events, System.json
 *   node scripts/build-tiny-game.mjs render   # PNG previews into samples/
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withRegisteredServer } from "./mcp-client.mjs";

const here = resolve(fileURLToPath(import.meta.url), "..", "..");
const phase = process.argv[2] ?? "all";

const VILLAGE = "MCP Village";
const CAVE = "MCP Cave";

/** Tile ids the project's own maps use most, taken from the harvest step. */
const TILES = {
    grass: 2816, // A2 autotile, the common ground in these maps
    road: 3968, // A2 autotile, the path table
    floor: 1536 // A5 plain tile, used as cave floor
};

/**
 * Find where the project's own maps use plain B/C/D/E tiles (houses, trees, props)
 * and report the bounding boxes, so a pattern can be copied rather than invented.
 */
const locate = async call => {
    const tilesets = await call("read_database", { table: "Tilesets" });
    const overworld = tilesets.entries.find(entry => /overworld/i.test(entry.name)) ?? tilesets.entries[0];
    const maps = (await call("list_maps")).maps.filter(map => map.tilesetId === overworld.id && map.width >= 12);
    for (const map of maps) {
        const layers = [];
        for (let layer = 0; layer < 4; layer++) {
            const dump = await call("get_map", { mapId: map.id, layerDump: { layer, x: 0, y: 0, width: Math.min(map.width, 64), height: Math.min(map.height, 64) } });
            layers.push(dump.layerDump.grid);
        }
        // A single connected-ish cluster of non-autotile tiles is what a house or
        // a prop patch looks like; report the box that contains them all.
        const rows = layers[0].length;
        const cols = layers[0][0].length;
        let minX = cols;
        let minY = rows;
        let maxX = -1;
        let maxY = -1;
        let hits = 0;
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                const id = layers[3][y][x] || layers[2][y][x] || layers[1][y][x] || layers[0][y][x];
                if (id > 0 && id < 1536) {
                    hits++;
                    minX = Math.min(minX, x);
                    minY = Math.min(minY, y);
                    maxX = Math.max(maxX, x);
                    maxY = Math.max(maxY, y);
                }
            }
        }
        if (hits > 4) {
            console.log(`map ${map.id} "${map.name}": ${hits} plain tiles in box (${minX},${minY})..(${maxX},${maxY}) = ${maxX - minX + 1}x${maxY - minY + 1}`);
        }
    }
};

/** Copy a rectangle of all four tile layers from one map to another. */
const pasteFrom = async (call, srcMapId, src, dstMapId, dstX, dstY) => {
    const cells = [];
    for (let layer = 0; layer < 4; layer++) {
        const dump = await call("get_map", { mapId: srcMapId, layerDump: { layer, x: src.x, y: src.y, width: Math.min(src.width, 64), height: Math.min(src.height, 64) } });
        dump.layerDump.grid.forEach((row, dy) => {
            row.forEach((tileId, dx) => {
                if (tileId > 0) {
                    cells.push({ x: dstX + dx, y: dstY + dy, layer, tileId });
                }
            });
        });
    }
    if (cells.length === 0) {
        throw new Error(`nothing to copy from map ${srcMapId} at that rectangle`);
    }
    const written = await call("set_tiles", { mapId: dstMapId, cells });
    return { cells: cells.length, written: written.written };
};

/** Maps the test suites leave behind; never useful as a source of patterns. */
const isScratch = map => /^(FID|FIDELITY|MCP-|McpBridge|E2E)/.test(map.name ?? "");

/**
 * Best w x h window in a map by how many plain (non-autotile) tiles it holds, i.e.
 * where the editor author actually put houses and props.
 */
const bestWindow = async (call, mapId, width, height) => {
    const layers = [];
    for (let layer = 0; layer < 4; layer++) {
        const dump = await call("get_map", { mapId, layerDump: { layer, x: 0, y: 0, width: 64, height: 64 } });
        layers.push(dump.layerDump.grid);
    }
    const rows = layers[0].length;
    const cols = layers[0][0].length;
    let best = { x: 0, y: 0, score: -1 };
    for (let y = 0; y + height <= rows; y++) {
        for (let x = 0; x + width <= cols; x++) {
            let score = 0;
            for (let dy = 0; dy < height; dy++) {
                for (let dx = 0; dx < width; dx++) {
                    const id = layers[3][y + dy][x + dx] || layers[2][y + dy][x + dx] || layers[1][y + dy][x + dx] || layers[0][y + dy][x + dx];
                    if (id > 0 && id < 1536) score++;
                }
            }
            if (score > best.score) {
                best = { x, y, score };
            }
        }
    }
    return { ...best, mapId, width, height };
};

const findMap = async (call, name) => (await call("list_maps")).maps.find(map => map.name === name) ?? null;

const fill = (call, mapId, x, y, width, height, tileId, layer = 0) =>
    call("set_tiles", { mapId, rect: { x, y, width, height, layer, tileId } });

/** Which tile ids the project's own maps actually use, so nothing is guessed. */
const harvest = async call => {
    const tilesets = await call("read_database", { table: "Tilesets" });
    const overworld = tilesets.entries.find(entry => /overworld/i.test(entry.name)) ?? tilesets.entries[0];
    const maps = (await call("list_maps")).maps.filter(map => map.width >= 12 && map.height >= 12 && map.tilesetId === overworld.id && !isScratch(map));
    console.log(`scanning ${maps.length} maps on tileset ${overworld.id} "${overworld.name}"`);
    const counts = new Map();
    for (const map of maps.slice(0, 12)) {
        for (let layer = 0; layer < 4; layer++) {
            const dump = await call("get_map", {
                mapId: map.id,
                layerDump: { layer, x: 0, y: 0, width: Math.min(map.width, 40), height: Math.min(map.height, 40) }
            });
            for (const row of dump.layerDump.grid) {
                for (const tileId of row) {
                    if (tileId > 0) {
                        counts.set(tileId, (counts.get(tileId) ?? 0) + 1);
                    }
                }
            }
        }
    }
    const segment = tileId => {
        if (tileId >= 5888) return "A4";
        if (tileId >= 4352) return "A3";
        if (tileId >= 2816) return "A2";
        if (tileId >= 2048) return "A1";
        if (tileId >= 1536) return "A5";
        if (tileId >= 768) return "E";
        if (tileId >= 512) return "D";
        if (tileId >= 256) return "C";
        return "B";
    };
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const bySegment = new Map();
    for (const [tileId, used] of top) {
        const key = segment(tileId);
        const list = bySegment.get(key) ?? [];
        list.push([tileId, used]);
        bySegment.set(key, list);
    }
    for (const [key, list] of [...bySegment.entries()].sort()) {
        console.log(`  ${key}: ${list.slice(0, 6).map(([tileId, used]) => `${tileId}(${used})`).join("  ")}`);
    }
    return top.slice(0, 24).map(([tileId]) => tileId);
};

const probe = async call => {
    const info = await call("project_info");
    console.log("project:", JSON.stringify({ base: info.projectDir, engine: info.engine, maps: info.mapCount }).slice(0, 300));
    const slots = await call("tileset_slots", { tilesetId: 1 });
    console.log("tileset 1 slots:", JSON.stringify(slots.slots ?? slots).slice(0, 700));
    const tilesets = await call("read_database", { table: "Tilesets" });
    console.log("tilesets:", (tilesets.entries ?? []).map(entry => `${entry.id}=${entry.name}`).join(" "));
    const systems = await call("read_database", { table: "System", fields: ["gameTitle", "startMapId", "startX", "startY"] });
    console.log("system start:", JSON.stringify(systems.value ?? systems.entries?.[0]));
};

const build = async call => {
    const tilesets = await call("read_database", { table: "Tilesets" });
    const overworld = (tilesets.entries ?? []).find(entry => entry.name && /overworld/i.test(entry.name)) ?? tilesets.entries[0];
    console.log(`building on tileset ${overworld.id} "${overworld.name}"`);

    let village = await findMap(call, VILLAGE);
    let cave = await findMap(call, CAVE);
    if (!village) {
        village = await call("create_map", { name: VILLAGE, width: 20, height: 15, tilesetId: overworld.id });
        console.log("created village map", village.id);
    }
    if (!cave) {
        cave = await call("create_map", { name: CAVE, width: 14, height: 12, tilesetId: overworld.id });
        console.log("created cave map", cave.id);
    }
    const v = village.id ?? village.mapId;
    const c = cave.id ?? cave.mapId;

    // The village and the cave are built from the project's own artwork: find the
    // map on the same tileset with the densest patch of houses and props, and copy
    // that window, rather than inventing tile ids that render as noise.
    const candidates = (await call("list_maps")).maps.filter(
        map => map.tilesetId === overworld.id && map.id !== v && map.id !== c && map.width >= 20 && map.height >= 15
    );
    let source = null;
    let sourceWindow = null;
    for (const map of candidates) {
        const window = await bestWindow(call, map.id, 20, 15);
        if (!source || window.score > sourceWindow.score) {
            source = map;
            sourceWindow = window;
        }
    }
    if (!source) {
        throw new Error(
            `no other map on tileset ${overworld.id} is at least 20x15. This builder borrows house and prop ` +
                "tiles from artwork the project already contains instead of inventing tile ids, so point " +
                "RMMZ_PROJECT at a project with real maps (or paint one map first) and run it again."
        );
    }
    console.log(`copying artwork from map ${source.id} "${source.name}" window (${sourceWindow.x},${sourceWindow.y}) score ${sourceWindow.score}`);

    await fill(call, v, 0, 0, 20, 15, TILES.grass);
    console.log("village base:", JSON.stringify(await pasteFrom(call, source.id, sourceWindow, v, 0, 0)));
    await fill(call, v, 0, 7, 20, 1, TILES.road);

    await fill(call, c, 0, 0, 14, 12, TILES.floor);
    console.log("cave walls:", JSON.stringify(await pasteFrom(call, source.id, await bestWindow(call, source.id, 14, 12), c, 0, 0)));
    await fill(call, c, 1, 1, 12, 10, 15, 4);

    await authorEvents(call, v, c);
    await configureSystem(call, v);
    console.log(`village map ${v}, cave map ${c}`);
    return { v, c };
};




/** Delete every event on a map so re-running the build does not stack duplicates. */
const clearEvents = async (call, mapId) => {
    const events = ((await call("get_map", { mapId })).events ?? []).filter(event => event);
    for (const event of events) {
        await call("remove_event", { mapId, eventId: event.id });
    }
    return events.length;
};

const authorEvents = async (call, villageId, caveId) => {
    console.log(`cleared ${await clearEvents(call, villageId) + await clearEvents(call, caveId)} old events`);
    // Villager: action button, four lines of dialog, portrait from the starter faces.
    const npc = await call("place_event", { mapId: villageId, x: 8, y: 9, name: "MCP Villager" });
    const npcId = npc.id;
    await call("set_event_page", {
        mapId: villageId,
        eventId: npcId,
        image: { characterName: "Actor3", characterIndex: 0, direction: 2, pattern: 1, tileId: 0 },
        trigger: 0,
        priorityType: 1,
        walkAnime: true
    });
    await call("show_text", {
        mapId: villageId,
        eventId: npcId,
        lines: ["欢迎来到这座小镇。", "", "西边有间小屋,东边有条洞窟。", "\\N[1] 是你吗?"],
        faceName: "Actor3",
        faceIndex: 0,
        background: 0,
        positionType: 1,
        speakerName: "村民"
    });

    // Treasure chest in the village: one-shot, gated by self switch A.
    const chest = await call("place_event", { mapId: villageId, x: 12, y: 4, name: "MCP Chest" });
    await configureChest(call, villageId, chest.id, 200);

    // Chest inside the cave too.
    const caveChest = await call("place_event", { mapId: caveId, x: 7, y: 6, name: "MCP Cave Chest" });
    await configureChest(call, caveId, caveChest.id, 500);

    // Two-way portals between village and cave.
    const toCave = await call("place_event", { mapId: villageId, x: 19, y: 8, name: "To Cave" });
    await call("set_event_page", { mapId: villageId, eventId: toCave.id, trigger: 1, priorityType: 0 });
    await call("add_commands", {
        mapId: villageId,
        eventId: toCave.id,
        commands: [{ code: 201, indent: 0, parameters: [0, caveId, 2, 6, 4, 2, 0] }]
    });
    const backToVillage = await call("place_event", { mapId: caveId, x: 1, y: 6, name: "To Village" });
    await call("set_event_page", { mapId: caveId, eventId: backToVillage.id, trigger: 1, priorityType: 0 });
    await call("add_commands", {
        mapId: caveId,
        eventId: backToVillage.id,
        commands: [{ code: 201, indent: 0, parameters: [0, villageId, 17, 8, 6, 2, 0] }]
    });

    // Signpost next to the house, showing how comments and choices look on disk.
    const sign = await call("place_event", { mapId: villageId, x: 6, y: 9, name: "MCP Sign" });
    await call("set_event_page", { mapId: villageId, eventId: sign.id, trigger: 0, priorityType: 1, image: { characterName: "!Other2", characterIndex: 0, direction: 2, pattern: 0, tileId: 0 } });
    await call("add_commands", {
        mapId: villageId,
        eventId: sign.id,
        commands: [
            { code: 108, indent: 0, parameters: ["A signpost written by the MCP server."] },
            { code: 101, indent: 0, parameters: ["", 0, 2, 2, ""] },
            { code: 401, indent: 0, parameters: ["洞窟里有更值钱的箱子。"] }
        ]
    });
    console.log(`events: villager ${npcId}, village chest ${chest.id}, cave chest ${caveChest.id}, portals ${toCave.id}/${backToVillage.id}, sign ${sign.id}`);
};

/**
 * Chest pages: page 1 is the closed chest and sets self switch A after the money,
 * page 2 is the opened graphic shown once that switch is on.
 */
const configureChest = async (call, mapId, eventId, amount) => {
    await call("set_event_page", {
        mapId,
        eventId,
        pageIndex: 0,
        image: { characterName: "!Chest", characterIndex: 0, direction: 8, pattern: 0, tileId: 0 },
        trigger: 0,
        priorityType: 1
    });
    await call("show_text", { mapId, eventId, lines: [`打开了箱子,得到 ${amount} 金币。`], background: 2, positionType: 1 });
    await call("add_commands", {
        mapId,
        eventId,
        commands: [
            // operateValue(operation, operandType, operand): increase by a constant.
            { code: 125, indent: 0, parameters: [0, 0, amount] },
            // Control Self Switch, not Control Switches: (letter, 0 = ON).
            { code: 123, indent: 0, parameters: ["A", 0] }
        ]
    });
    await call("set_event_page", {
        mapId,
        eventId,
        pageIndex: 1,
        image: { characterName: "!Chest", characterIndex: 1, direction: 8, pattern: 0, tileId: 0 },
        trigger: 0,
        priorityType: 1,
        conditions: { selfSwitch: "A" }
    });
};

const configureSystem = async (call, villageId) => {
    await call("patch_database_entry", {
        table: "System",
        patch: { gameTitle: "MCP 小屋试验", startMapId: villageId, startX: 8, startY: 9 }
    });
    const after = await call("read_database", { table: "System", fields: ["gameTitle", "startMapId", "startX", "startY"] });
    console.log("system now:", JSON.stringify(after.value ?? after.entries?.[0]));
};

const render = async call => {
    mkdirSync(join(here, "samples"), { recursive: true });
    for (const [name, mapName] of [["village", VILLAGE], ["cave", CAVE]]) {
        const map = await findMap(call, mapName);
        if (!map) {
            console.log(`${mapName}: not built yet`);
            continue;
        }
        const file = join(here, "samples", `tiny-${name}.png`);
        const shot = await call("render_map", { mapId: map.id, scale: 1.5, showEvents: true, saveTo: file });
        console.log(`wrote ${file} (${shot.savedTo ?? shot.pixels?.join("x")}, engine ${shot.stats?.engine}, rects ${shot.stats?.lowerRects}, warnings ${(shot.warnings ?? []).length})`);
        if (shot.warnings?.length) {
            console.log("  warnings:", JSON.stringify(shot.warnings).slice(0, 300));
        }
    }
};

await withRegisteredServer(async call => {
    if (phase === "probe" || phase === "all") {
        await probe(call);
    }
    if (phase === "harvest") {
        await harvest(call);
    }
    if (phase === "locate") {
        await locate(call);
    }
    if (phase === "build" || phase === "all") {
        await build(call);
    }
    if (phase === "render" || phase === "all") {
        await render(call);
    }
});
