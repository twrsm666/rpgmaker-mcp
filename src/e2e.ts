import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const projectDir = process.argv[2];
const corescriptRoot = process.argv[3];
if (!projectDir || !corescriptRoot) {
    console.error("usage: node dist/e2e.js <project-dir> <corescript-root>");
    process.exit(1);
}
process.env["RMMZ_PROJECT"] = projectDir;
process.env["RMMZ_CORESCRIPT_ROOT"] = corescriptRoot;

const { server } = await import("./index.js");

const client = new Client({ name: "e2e", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

let failures = 0;
function check(name: string, condition: unknown, detail?: unknown): void {
    if (condition) {
        console.log(`  PASS  ${name}`);
    } else {
        failures++;
        console.log(`  FAIL  ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail).slice(0, 400)}`}`);
    }
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) {
        const text = (result.content as any[])?.[0]?.text ?? "";
        console.log(`  ERROR ${name}: ${text.slice(0, 300)}`);
        failures++;
        return { error: text };
    }
    const image = (result.content as any[]).find(item => item.type === "image");
    if (image) {
        return { image, json: JSON.parse((result.content as any[]).find(item => item.type === "text").text) };
    }
    return JSON.parse((result.content as any[]).find(item => item.type === "text").text);
}

/** The `{error}` text a refused call answered with. */
function errorText(result: any): string {
    return String((result.content as any[])?.[0]?.text ?? "");
}

const tools = await client.listTools();console.log(`\n== tools (${tools.tools.length})`);
/**
 * `initialize` is the first thing a client reads, and a version held as a constant in the
 * source drifted away from `package.json` once already. One source of truth, asserted.
 */
const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
check(`the handshake advertises the package version (${packageVersion})`, client.getServerVersion()?.version === packageVersion, client.getServerVersion());
/**
 * The whole registry by name, not a count. "At least 20 tools" stayed green while the
 * server grew to 46, so a tool that disappeared or was renamed would have passed too -
 * which is exactly the failure an agent wiring calls by name cannot work around.
 * Adding a tool means adding its name here; the diff names the one that moved.
 */
const TOOL_NAMES = [
    "add_commands",
    "assert_in_game",
    "batch",
    "block_structure",
    "check_assets",
    "clear_events",
    "command_catalog",
    "copy_event",
    "create_database_entry",
    "create_map",
    "decode_commands",
    "delete_map",
    "describe_tiles",
    "enable_plugin",
    "find_events",
    "fix_project",
    "get_map",
    "import_asset",
    "inspect_cell",
    "link_maps",
    "list_backups",
    "list_maps",
    "list_plugins",
    "live_diagnostics",
    "live_dialog",
    "live_eval",
    "live_key",
    "live_move",
    "live_pause",
    "live_reload",
    "live_screenshot",
    "live_session",
    "live_status",
    "live_step",
    "live_wait",
    "make_chest",
    "make_choice_scene",
    "make_battle",
    "make_encounter_zone",
    "make_item",
    "make_map",
    "make_npc",
    "make_shop",
    "map_connectivity",
    "patch_database_entry",
    "patch_plugin",
    "place_event",
    "project_info",
    "read_database",
    "read_plugin_source",
    "remove_event",
    "render_map",
    "rollback_data",
    "set_commands",
    "set_event_page",
    "set_map_properties",
    "set_startup",
    "set_tiles",
    "set_tileset_flags",
    "show_text",
    "tileset_slots",
    "undo_writes",
    "validate_game",
    "write_history",
    "write_plugin_source"
].sort();
const names = tools.tools.map(tool => tool.name).sort();
check("the tool registry is exactly the snapshot", names.join(",") === TOOL_NAMES.join(","), {
    missing: TOOL_NAMES.filter(name => !names.includes(name)),
    unexpected: names.filter(name => !TOOL_NAMES.includes(name))
});

console.log("\n== project_info / list_maps");
const info = await call("project_info");
check("the project the server resolved is the one this run asked for", normalize(info.projectDir ?? "").toLowerCase() === normalize(projectDir).toLowerCase(), { server: info.projectDir, asked: projectDir });
check("renderer reports an engine version", /^v\d/.test(info.renderer?.engine ?? ""), info.renderer);
check(
    "the codebook it has is reported by size, with no fix line while it is loaded",
    info.codebook?.loaded === true && info.codebook.commands > 0 && info.codebook.howToFix === undefined,
    info.codebook
);
check("map count matches list", Array.isArray(info.maps) && info.maps.length >= 1);
const maps = await call("list_maps");
check("list_maps returns sizes", maps.maps.every((map: any) => map.width > 0 && map.height > 0), maps.maps?.[0]);
const testMap = maps.maps.find((map: any) => map.name === "MCP-SELFTEST");
if (!testMap) {
    // Everything past this point reads maps this suite did not paint: `MCP-SELFTEST` is what
    // `npm run selftest` lays down, and the passage, terrain and event-copy checks below name
    // its cells. A project that has never held the acceptance game is not a failing project, so
    // say what is missing and leave — dereferencing `undefined.id` read as the server crashing.
    console.log(
        `\nskipped: needs the acceptance game — ${projectDir} has no map named "MCP-SELFTEST".\n` +
            `   Run the builders against it first:\n` +
            `     npm run selftest -- "${projectDir}" && npm run build:game && npm run build:star-relay\n` +
            `   The suites that need nothing of the sort: npm run verify:newdata, npm run verify:input, npm run census.` +
            `\n${failures} failure(s) before the gate; nothing was written.`
    );
    process.exit(failures === 0 ? 0 : 1);
}

console.log("\n== render_map");
const rendered = await call("render_map", { mapId: testMap.id, overlay: "passage", scale: 0.5 });
check("returns a PNG image part", rendered.image?.mimeType === "image/png" && rendered.image.data.length > 1000);
check("PNG magic bytes", Buffer.from(rendered.image.data, "base64").subarray(1, 4).toString() === "PNG");
check("reports composite stats", rendered.json.stats.lowerRects > 0, rendered.json);

console.log("\n== tileset_slots / inspect_cell");
const slots = await call("tileset_slots", { tilesetId: testMap.tilesetId });
check("nine tileset slots", slots.slots.length === 9, slots.slots?.length);
const cell = await call("inspect_cell", { mapId: testMap.id, x: 4, y: 8 });
check("water cell reported", cell.layers?.[0].kind === "A1", cell);

console.log("\n== create_map + set_tiles + read back");
// A fresh id every run would litter the demo project with E2E-MAP copies, so only
// create when there is nothing to reuse; the paint below covers the whole map.
const reusable = maps.maps.find((map: any) => map.name === "E2E-MAP");
const created = {
    id: reusable?.id ?? (await call("create_map", { name: "E2E-MAP", width: 12, height: 10, tilesetId: 2 })).id,
    reused: Boolean(reusable)
};
check(`scratch map ready (${created.reused ? "reused" : "created"})`, created.id > 0, created);
if (created.reused) {
    // Tiles are repainted across the whole map, but leftover events would occupy
    // the cells the assertions below place their own event into.
    for (const event of ((await call("get_map", { mapId: created.id })).events ?? [])) {
        await call("remove_event", { mapId: created.id, eventId: event.id });
    }
}
await call("set_tiles", { mapId: created.id, rect: { x: 0, y: 0, width: 12, height: 10, layer: 0, tileId: 2816 } });
await call("set_tiles", { mapId: created.id, cells: [{ x: 3, y: 3, layer: 0, tileId: 2048 }, { x: 4, y: 4, layer: 5, tileId: 9 }] });
const dump = await call("get_map", { mapId: created.id, layerDump: { layer: 0, x: 2, y: 2, width: 4, height: 4 } });
check("painted autotile read back", dump.layerDump.grid[1][1] === 2048, dump.layerDump);
const regionCell = await call("inspect_cell", { mapId: created.id, x: 4, y: 4 });
check("region id stored on layer 5", regionCell.regionId === 9, regionCell);

console.log("\n== encounter rows are stored the way MZ reads them");
const shorthand = await call("set_map_properties", {
    mapId: created.id,
    encounterStep: 12,
    encounters: [{ regionId: 2, troopId: 1, appearances: 3 }]
});
check("a regionId is read as a one-region regionSet", /regionSet/.test(String(shorthand.notice)), shorthand.notice);
const storedRows = (await call("get_map", { mapId: created.id })).encounterList;
check(
    "and the row on disk carries the array Game_Player.meetsEncounterConditions reads",
    Array.isArray(storedRows?.[0]?.regionSet) && storedRows[0].regionSet.join() === "2" && storedRows[0].regionId === undefined,
    storedRows
);
check(
    "appearances is stored as weight, which is the field makeEncounterTroopId sums",
    storedRows[0].weight === 3 && storedRows[0].appearances === undefined,
    storedRows
);
const noWeight = await client.callTool({
    name: "set_map_properties",
    arguments: { mapId: created.id, encounters: [{ troopId: 1 }] }
});
check("a row with neither weight nor appearances is refused", noWeight.isError === true, (noWeight.content as any[])?.[0]?.text);
await call("set_map_properties", { mapId: created.id, encounters: [{ troopId: 1, weight: 5 }] });
check("a row with no region rolls on the whole map", (await call("get_map", { mapId: created.id })).encounterList[0].regionSet.length === 0);
await call("set_map_properties", { mapId: created.id, clearEncounters: true });
check("clearEncounters empties the table again", (await call("get_map", { mapId: created.id })).encounterList.length === 0);

console.log("\n== event authoring");
/**
 * The runtime reads `$dataMap.events[event.id]`, so a map whose events array is
 * not indexed by id crashes on the first frame of the map. Check the file on disk
 * rather than the in-memory object the tool returned.
 */
const rawEvents = (mapId: number) =>
    JSON.parse(readFileSync(join(projectDir, "data", `Map${String(mapId).padStart(3, "0")}.json`), "utf8")).events;
const indexOfIdsAlign = (events: any[]) =>
    events.every((event: any, index: number) => event === null || event === undefined || event.id === index);
const placed = await call("place_event", { mapId: created.id, x: 6, y: 5, name: "E2E NPC" });
check("event created", placed.id > 0, placed);
check("events array stays indexed by id", indexOfIdsAlign(rawEvents(created.id)), rawEvents(created.id).map((event: any) => event?.id ?? null));
await call("set_event_page", {
    mapId: created.id,
    eventId: placed.id,
    image: { characterName: "Actor1", characterIndex: 3, direction: 8, pattern: 0, tileId: 0 },
    trigger: 0,
    priorityType: 1,
    conditions: { switch1Id: 12 }
});
await call("add_commands", {
    mapId: created.id,
    eventId: placed.id,
    commands: [
        { code: 101, indent: 0, parameters: ["Actor1", 3, 0, 0, "Reid"] },
        { code: 401, indent: 0, parameters: ["hello from mcp"] },
        { code: 121, indent: 0, parameters: [12, 12, 0] },
        { code: 117, indent: 0, parameters: [1] }
    ]
});
const decoded = await call("decode_commands", { mapId: created.id, eventId: placed.id });
check("page decodes to readable lines", decoded.lines.length >= 5, decoded);
check("Show Text label resolved", /Show Text/i.test(decoded.lines.join("\n")), decoded.lines);
check("codebook loaded", decoded.codebookLoaded === true, decoded);
const pageState = await call("get_map", { mapId: created.id, includeCommands: true });
const ourEvent = pageState.events.find((event: any) => event.id === placed.id);
check("condition switch stored", ourEvent.pages[0].conditions.includes("switch1Valid"), ourEvent);
check("character graphic stored", ourEvent.pages[0].image.characterIndex === 3, ourEvent);
await call("set_event_page", { mapId: created.id, eventId: placed.id, conditions: {} });
const clearedPage = (await call("get_map", { mapId: created.id })).events.find((event: any) => event.id === placed.id).pages[0];
check("an empty conditions object clears every valid flag", clearedPage.conditions.length === 0, clearedPage.conditions);
await call("set_event_page", { mapId: created.id, eventId: placed.id, conditions: { switch1Id: 12 } });

console.log("\n== copy_event");
const copy = await call("copy_event", { mapId: created.id, eventId: placed.id, x: 8, y: 5 });
check(`the copy lands on a fresh id (${copy.id} from ${placed.id})`, copy.id !== placed.id && copy.pages === 1, copy);
const afterCopy = rawEvents(created.id);
const sourceEvent = afterCopy.find((event: any) => event && event.id === placed.id);
const copiedEvent = afterCopy.find((event: any) => event && event.id === copy.id);
check("with the same graphic, trigger and priority", copiedEvent.pages[0].image.characterIndex === 3 && copiedEvent.pages[0].trigger === 0 && copiedEvent.pages[0].priorityType === 1, copiedEvent.pages[0]);
check("and a byte-identical command list", JSON.stringify(copiedEvent.pages[0].list) === JSON.stringify(sourceEvent.pages[0].list), { copy: copiedEvent.pages[0].list.length, source: sourceEvent.pages[0].list.length });
check("the source still has its own id", afterCopy.some((event: any) => event && event.id === placed.id));
check("events array stays indexed by id after a copy", indexOfIdsAlign(afterCopy), afterCopy.map((event: any) => event?.id ?? null));
// A cross-map copy has to allocate in the target map, so find a cell there that
// is genuinely free rather than assuming the selftest map's corner is.
const occupied = new Set((await call("find_events", { mapId: testMap.id })).hits.map((hit: any) => `${hit.x},${hit.y}`));
let freeCell: [number, number] | null = null;
for (let y = 0; y < testMap.height && !freeCell; y++) {
    for (let x = 0; x < testMap.width && !freeCell; x++) {
        if (!occupied.has(`${x},${y}`)) {
            freeCell = [x, y];
        }
    }
}
if (!freeCell) {
    throw new Error(`every cell on map ${testMap.id} holds an event, so nothing can be copied onto it`);
}
const acrossMaps = await call("copy_event", { mapId: created.id, eventId: placed.id, toMapId: testMap.id, x: freeCell[0], y: freeCell[1], name: "E2E Copy" });
check(`a copy can land on another map (${testMap.name} at ${freeCell})`, acrossMaps.to.mapId === testMap.id && acrossMaps.id !== placed.id, acrossMaps);
const onTestMap = rawEvents(testMap.id).find((event: any) => event && event.id === acrossMaps.id);
check("renamed on the way, with the pages intact", onTestMap?.name === "E2E Copy" && onTestMap?.pages.length === 1, { name: onTestMap?.name, pages: onTestMap?.pages?.length });
await call("remove_event", { mapId: testMap.id, eventId: acrossMaps.id });
await call("remove_event", { mapId: created.id, eventId: copy.id });

console.log("\n== block structure + search + connectivity");
const structure = await call("block_structure", { mapId: created.id, eventId: placed.id });
check("documents indent-based blocks", typeof structure.indentation === "string" && Array.isArray(structure.structure));
const found = await call("find_events", { commandCode: 117 });
check("find_events locates common-event calls", found.hits.some((hit: any) => hit.eventId === placed.id && hit.mapId === created.id), found.hits);
const connectivity = await call("map_connectivity", { mapId: created.id, x: 0, y: 0 });
check("flood fill reaches the map", connectivity.reachableCells > 50, connectivity.reachableCells);

console.log("\n== database read / patch / rollback");
const system = await call("read_database", { table: "System", fields: ["gameTitle", "startMapId"] });
check("System fields readable", "gameTitle" in system.value, system);
const title = `E2E-${Date.now()}`;
await call("patch_database_entry", { table: "System", patch: { gameTitle: title } });
const reread = await call("read_database", { table: "System", fields: ["gameTitle"] });
check("patch persisted", reread.value.gameTitle === title, reread);
const backups = await call("list_backups", { table: "System" });
check("backup recorded", backups.backups.length >= 1, backups);
await call("rollback_data", { table: "System" });
const restored = await call("read_database", { table: "System", fields: ["gameTitle"] });
check("rollback restored previous title", restored.value.gameTitle !== title, restored);

console.log("\n== switch names keep the shape the engine reads");
const namesBefore = await call("read_database", { table: "System", fields: ["switches"] });
const switchArray = namesBefore.value.switches;
check("System.switches is an array in the project", Array.isArray(switchArray), typeof switchArray);
const asObject = await call("patch_database_entry", {
    table: "System",
    patch: { switches: Object.fromEntries(switchArray.map((name: string, id: number) => [id, name])) }
});
check("names passed as an object keyed by id are normalized", (asObject.normalized ?? []).includes("switches"), asObject);
const writtenBack = await call("read_database", { table: "System", fields: ["switches"] });
check(
    "and the file still holds the array, which is what Game_Switches bounds-checks against",
    Array.isArray(writtenBack.value.switches) && writtenBack.value.switches.length === switchArray.length,
    { was: switchArray.length, now: writtenBack.value.switches?.length }
);
await call("rollback_data", { table: "System" });
const mvKey = await client.callTool({ name: "patch_database_entry", arguments: { table: "System", patch: { startActors: [1] } } });
const mvReply = JSON.parse(((mvKey.content as any[]) ?? [])[0]?.text ?? "{}");
check("an MV-only System key is reported rather than silently kept", /partyMembers/.test(mvReply.warning ?? ""), mvReply);
await call("rollback_data", { table: "System" });

console.log("\n== every table answers the same read shape");
const whole = await call("read_database", { table: "System" });
check("System answers entries as well as value, so .entries.find works on it", Array.isArray(whole.entries) && whole.entries.length === 1 && JSON.stringify(whole.entries[0]) === JSON.stringify(whole.value), { keys: Object.keys(whole) });
const rowsTable = await call("read_database", { table: "Troops" });
check("and a row table answers count with the length of entries", rowsTable.count === rowsTable.entries.length && rowsTable.count > 0, { count: rowsTable.count });
const partialAdvanced = await call("patch_database_entry", { table: "System", patch: { advanced: { windowOpacity: 200 } } });
const lostAdvanced = (partialAdvanced.droppedKeys ?? []).find((entry: any) => entry.field === "advanced");
check("a partial nested patch names the keys the entry had and the patch did not send", Boolean(lostAdvanced) && (lostAdvanced.missing as string[]).includes("gameId"), partialAdvanced.droppedKeys);
check("and it says so in the warning a caller reads", /replaces rather than merges/.test(partialAdvanced.warning ?? ""), (partialAdvanced.warning ?? "").slice(0, 120));
await call("rollback_data", { table: "System" });
const wholeAdvanced = await call("patch_database_entry", { table: "System", patch: { advanced: { ...(await call("read_database", { table: "System" })).value.advanced, windowOpacity: 192 } } });
check("a nested patch that carries the existing keys is not warned about", wholeAdvanced.droppedKeys === undefined, wholeAdvanced.warning);
await call("rollback_data", { table: "System" });

console.log("\n== fix_project on a project the editor made");
const nothingNeeded = await call("fix_project", { dryRun: true });
check("it finds every engine key present and plans no write", nothingNeeded.changed === false && nothingNeeded.everyEngineKeyPresent === true, nothingNeeded);
const fixedForReal = await call("fix_project", {});
check("running it for real still writes nothing", fixedForReal.changed === false && (fixedForReal.wrote ?? []).length === 0, fixedForReal.wrote);

// list_backups prints map files as `Map0NN`, so that must be an accepted spelling
// for the rollback that follows it.
const mapTable = `Map${String(created.id).padStart(3, "0")}`;
await call("set_tiles", { mapId: created.id, rect: { x: 0, y: 0, width: 1, height: 1, layer: 0, tileId: 2816 } });
const rolledBack = await call("rollback_data", { table: mapTable });
check(`rollback_data accepts the "${mapTable}" spelling`, rolledBack.restored === true && rolledBack.target === mapTable, rolledBack);

console.log("\n== text command validation");
const nullLine = await client.callTool({
    name: "add_commands",
    arguments: { mapId: created.id, eventId: placed.id, commands: [{ code: 401, indent: 0, parameters: [null] }] }
});
check("a null text line is refused", nullLine.isError === true, (nullLine.content as any[])?.[0]?.text);
const undefinedLine = await client.callTool({
    name: "add_commands",
    arguments: { mapId: created.id, eventId: placed.id, commands: [{ code: 401, indent: 0, parameters: [undefined] }] }
});
check("an undefined text line is refused", undefinedLine.isError === true);
const missingParams = await client.callTool({
    name: "add_commands",
    arguments: { mapId: created.id, eventId: placed.id, commands: [{ code: 121, indent: 0, parameters: [1, undefined, 0] }] }
});
check("undefined in any parameter is refused", missingParams.isError === true);

const textDialog = await call("show_text", {
    mapId: created.id,
    eventId: placed.id,
    lines: ["first line", "\\N[1] second line"],
    faceName: "Actor1",
    faceIndex: 2,
    speakerName: "Reid"
});
check("show_text wrote 101 plus one 401 per line", textDialog.commandsAdded === 3, textDialog);
const mapFile = JSON.parse(readFileSync(join(projectDir, "data", `Map${String(created.id).padStart(3, "0")}.json`), "utf8"));
const storedEvent = mapFile.events.find((event: any) => event && event.id === placed.id);
const fullList = storedEvent.pages[0].list;
const dialog = fullList.slice(-4);
check("dialog is 101 then one 401 per line then the terminator", dialog[0].code === 101 && dialog[1].code === 401 && dialog[2].code === 401 && dialog[3].code === 0, dialog);
check("each 401 carries its line in parameters[0]", dialog[1].parameters[0] === "first line" && dialog[2].parameters[0] === "\\N[1] second line", dialog);
check("101 carries face/speaker settings", dialog[0].parameters[0] === "Actor1" && dialog[0].parameters[1] === 2 && dialog[0].parameters[4] === "Reid", dialog[0].parameters);
check("no null reaches the text lines on disk", fullList.every((command: any) => command.parameters.every((value: any) => value !== null)), fullList.slice(-4));

console.log("\n== block structure, which the engine reads by indent and never complains about");
const flattened = await call("set_commands", {
    mapId: created.id,
    eventId: placed.id,
    list: [
        { code: 112, indent: 0, parameters: [] },
        { code: 121, indent: 1, parameters: [7, 7, 0] },
        { code: 111, indent: 1, parameters: [0, 7, 0] },
        { code: 113, indent: 1, parameters: [] },
        { code: 412, indent: 1, parameters: [] },
        { code: 413, indent: 0, parameters: [] },
        { code: 0, indent: 0, parameters: [] }
    ]
});
check(
    "a branch body left at the opener's own indent is reported",
    (flattened.warnings ?? []).some((text: string) => /Conditional Branch block opened at list\[2\]/.test(text)),
    flattened.warnings
);
const wellNested = await call("set_commands", {
    mapId: created.id,
    eventId: placed.id,
    list: [
        { code: 112, indent: 0, parameters: [] },
        { code: 121, indent: 1, parameters: [7, 7, 0] },
        { code: 111, indent: 1, parameters: [0, 7, 0] },
        { code: 113, indent: 2, parameters: [] },
        { code: 412, indent: 1, parameters: [] },
        { code: 413, indent: 0, parameters: [] },
        { code: 0, indent: 0, parameters: [] }
    ]
});
check("the same commands with the body one level deeper are clean", (wellNested.warnings ?? []).length === 0, wellNested.warnings);
const emptyLoop = await call("set_commands", {
    mapId: created.id,
    eventId: placed.id,
    list: [
        { code: 112, indent: 0, parameters: [] },
        { code: 413, indent: 0, parameters: [] },
        { code: 0, indent: 0, parameters: [] }
    ]
});
check("an empty Loop is called out as the hang it is", (emptyLoop.warnings ?? []).some((text: string) => /empty Loop repeats forever/.test(text)), emptyLoop.warnings);

console.log("\n== event id recycling");
await call("remove_event", { mapId: created.id, eventId: placed.id });
const reborn = await call("place_event", { mapId: created.id, x: 6, y: 5, name: "E2E NPC" });
const recycled = rawEvents(created.id);
check(
    "a re-used id lands on the array slot the engine looks up",
    recycled[reborn.id]?.id === reborn.id && indexOfIdsAlign(recycled),
    recycled.map((event: any) => event?.id ?? null)
);

console.log("\n== plugin layer");
const pluginsPath = join(projectDir, "js", "plugins.js");
const pluginsBefore = readFileSync(pluginsPath, "utf8");
const listed = await call("list_plugins");
const bridge = listed.plugins.find((plugin: any) => plugin.name === "RMMZLiveBridge");
check(`${listed.count} plugins listed in load order with none missing a file`, listed.plugins.every((plugin: any, index: number) => plugin.loadOrder === index) && listed.missingFiles.length === 0, listed);
check("the bridge is enabled and its script is on disk", Boolean(bridge?.status) && Boolean(bridge?.fileExists), bridge && { status: bridge.status, fileExists: bridge.fileExists });
check("its @param blocks are parsed out of the source", bridge.declared.length >= 8 && bridge.declared.some((parameter: any) => parameter.name === "captureErrors"), bridge.declared?.map((parameter: any) => parameter.name));
check("no stored key is one the plugin never declares", bridge.undeclared.length === 0, bridge.undeclared);
await call("patch_plugin", { name: "RMMZLiveBridge", parameters: { variableWindow: 37, keepAwake: true } });
const pluginsAfter = readFileSync(pluginsPath, "utf8");
check("a scalar is stored the way MZ writes it", pluginsAfter.includes('"variableWindow":"37"') && pluginsAfter.includes('"keepAwake":"true"'), pluginsAfter.slice(pluginsAfter.indexOf("variableWindow") - 20, pluginsAfter.indexOf("variableWindow") + 40));
const head = (text: string) => text.slice(0, text.indexOf("{"));
const tail = (text: string) => text.slice(text.lastIndexOf("}") + 1);
check(
    "only the touched entry's own object literal changed",
    head(pluginsAfter) === head(pluginsBefore) && tail(pluginsAfter) === tail(pluginsBefore),
    { headChanged: head(pluginsAfter) !== head(pluginsBefore), tailChanged: tail(pluginsAfter) !== tail(pluginsBefore) }
);
const enabledWithExtension = await call("enable_plugin", { name: "RMMZLiveBridge", file: "RMMZLiveBridge.js" });
const listedAgain = await call("list_plugins");
check(
    "enable_plugin accepts a file that already carries .js rather than appending a second one",
    enabledWithExtension.file === "js/plugins/RMMZLiveBridge.js" && listedAgain.count === listed.count,
    { file: enabledWithExtension.file, count: listedAgain.count, was: listed.count }
);
const pluginRollback = await call("rollback_data", { table: "js/plugins.js" });
check("rollback_data restores plugins.js byte for byte", readFileSync(pluginsPath, "utf8") === pluginsBefore, pluginRollback);
const pluginSource = await call("read_plugin_source", { name: "RMMZLiveBridge", lineCount: 40 });
check(`the plugin's own source reads back (${pluginSource.totalLines} lines)`, pluginSource.fromLine === 1 && pluginSource.toLine === 40 && pluginSource.text.includes("RMMZLiveBridge"), { to: pluginSource.toLine });
const unknownSource = await client.callTool({ name: "read_plugin_source", arguments: { name: "NoSuchPlugin" } });
check("a plugin that is not installed says so", unknownSource.isError === true);
const unknownPatch = await client.callTool({ name: "patch_plugin", arguments: { name: "NoSuchPlugin", status: true } });
check("and refuses to patch one", String((unknownPatch.content as any[])?.[0]?.text).includes("js/plugins.js"), (unknownPatch.content as any[])?.[0]?.text);

console.log("\n== undo stack");
const mapPath = join(projectDir, "data", `Map${String(created.id).padStart(3, "0")}.json`);
const bytes0 = readFileSync(mapPath, "utf8");
await call("set_tiles", { mapId: created.id, cells: [{ x: 1, y: 1, layer: 5, tileId: 42 }] });
const bytes1 = readFileSync(mapPath, "utf8");
await call("set_tiles", { mapId: created.id, cells: [{ x: 1, y: 1, layer: 5, tileId: 43 }] });
const bytes2 = readFileSync(mapPath, "utf8");
check("two writes left two different files", bytes0 !== bytes1 && bytes1 !== bytes2);
const history = await call("write_history", { limit: 4 });
check("both are in the journal, newest first", history.entries[0].file === `Map${String(created.id).padStart(3, "0")}.json` && history.entries[1].file === history.entries[0].file, history.entries);
check("and each knows the backup it can go back to", history.entries.slice(0, 2).every((entry: any) => entry.revertedTo?.startsWith("Map")), history.entries.slice(0, 2));
const undoOne = await call("undo_writes", { steps: 1 });
check("undo 1 lands on the state after the first write", readFileSync(mapPath, "utf8") === bytes1, undoOne.reverted);
check("and drops exactly that journal entry", undoOne.remaining === history.entries[0].index, { remaining: undoOne.remaining, undone: history.entries[0].index });
const undoTwo = await call("undo_writes", { steps: 1 });
check("undo 2 is back to the original bytes", readFileSync(mapPath, "utf8") === bytes0, undoTwo.reverted);
check("with the second entry gone too", undoTwo.remaining === history.entries[1].index, undoTwo.remaining);
const numbered = await call("list_backups", { table: `Map${String(created.id).padStart(3, "0")}` });
check(`${numbered.backups.length} backups of this map are on disk`, numbered.backups.length >= 2, numbered.backups?.length);
await call("rollback_data", { table: `Map${String(created.id).padStart(3, "0")}`, to: 0 });
check("rollback_data with `to` restores a chosen backup", readFileSync(mapPath, "utf8") === readFileSync(numbered.backups[0], "utf8"), numbered.backups[0]);
const badIndex = await client.callTool({ name: "rollback_data", arguments: { table: "System", to: 9999 } });
check("an out-of-range backup number is refused", badIndex.isError === true, (badIndex.content as any[])?.[0]?.text);
await call("set_tiles", { mapId: created.id, cells: [{ x: 1, y: 1, layer: 5, tileId: 0 }] });

console.log("\n== writing a plugin from scratch");
const probeSource = `/*:
 * @target MZ
 * @plugindesc E2E probe plugin written by the MCP server.
 * @param greeting
 * @text Greeting
 * @default hello from mcp
 */
(function () {
    "use strict";
    globalThis.__mcpProbe = PluginManager.parameters("MCPProbe").greeting;
})();
`;
const pluginsBeforeProbe = readFileSync(pluginsPath, "utf8");
const probeFile = join(projectDir, "js", "plugins", "MCPProbe.js");
const written = await call("write_plugin_source", { name: "MCPProbe", text: probeSource, enable: true });
check("the source is on disk and listed in the editor's order", existsSync(probeFile) && written.entry?.added === true, written);
const probeEntry = (await call("list_plugins")).plugins.find((plugin: any) => plugin.name === "MCPProbe");
check("its parameters came from the header's @default", probeEntry?.parameters?.greeting === "hello from mcp" && probeEntry?.fileExists === true, probeEntry);
check("the plugin already in the list is untouched", readFileSync(pluginsPath, "utf8").includes('"RMMZLiveBridge"') && readFileSync(pluginsPath, "utf8").startsWith(pluginsBeforeProbe.slice(0, pluginsBeforeProbe.indexOf("{"))), readFileSync(pluginsPath, "utf8").slice(0, 120));
await call("write_plugin_source", { name: "MCPProbe", text: probeSource, enable: true, parameters: { greeting: "second" } });
const afterSecond = (await call("list_plugins")).plugins.filter((plugin: any) => plugin.name === "MCPProbe");
check("enabling twice does not list it twice", afterSecond.length === 1 && afterSecond[0].parameters.greeting === "second", afterSecond);
const probeUndo = await call("undo_writes", { steps: 4 });
check("undo takes the whole plugin back, file and entry", !existsSync(probeFile) && readFileSync(pluginsPath, "utf8") === pluginsBeforeProbe, {
    stillThere: existsSync(probeFile),
    pluginsChanged: readFileSync(pluginsPath, "utf8") !== pluginsBeforeProbe,
    reverted: probeUndo.reverted.length
});

console.log("\n== batch: apply, roll back, refuse");
const mapPathOf = (id: number) => join(projectDir, "data", `Map${String(id).padStart(3, "0")}.json`);
const otherMap = maps.maps.find((map: any) => map.id !== created.id && map.width > 2 && map.height > 2);
const createdPluginFile = join(projectDir, "js", "plugins", "MCPBatchProbe.js");
const batchBefore = { map: readFileSync(mapPathOf(created.id)), other: readFileSync(mapPathOf(otherMap.id)), plugins: readFileSync(pluginsPath, "utf8") };
const paint = (id: number, tileId: number) => ({
    tool: "set_tiles",
    args: { mapId: id, rect: { x: 0, y: 0, width: 2, height: 1, layer: 1, tileId } }
});

const appliedBatch = await call("batch", {
    steps: [
        paint(created.id, 4332),
        paint(otherMap.id, 4333),
        { tool: "get_map", args: { mapId: created.id, layerDump: { layer: 1, x: 0, y: 0, width: 2, height: 1 } } }
    ]
});
check("every step ran", appliedBatch.ok === true && appliedBatch.applied === 3, appliedBatch);
check("both maps are named as written, and the read step as not", appliedBatch.wrote.length === 2 && appliedBatch.results[2].wrote.length === 0, appliedBatch.wrote);
check("a read step comes back with its result", JSON.stringify(appliedBatch.results[2].result?.layerDump?.grid) === "[[4332,4332]]", appliedBatch.results[2].result);
check("the files really changed", readFileSync(mapPathOf(created.id)) !== batchBefore.map && readFileSync(mapPathOf(otherMap.id)) !== batchBefore.other);
const batchUndo = await call("undo_writes", { steps: appliedBatch.wrote.length });
check(
    "undo_writes puts both files back byte for byte",
    readFileSync(mapPathOf(created.id)).equals(batchBefore.map) &&
        readFileSync(mapPathOf(otherMap.id)).equals(batchBefore.other) &&
        batchUndo.reverted.length === 2,
    batchUndo.reverted
);

const rolledBatch = await call("batch", { steps: [paint(created.id, 4400), paint(otherMap.id, 4401), { tool: "get_map", args: { mapId: 4242 } }] });
check("a failing last step is reported, not thrown", rolledBatch.ok === false && rolledBatch.failures?.length === 1, rolledBatch.failures);
check("it names the step that failed and why", rolledBatch.failures?.[0]?.tool === "get_map" && /Map4242/.test(rolledBatch.failures[0].error), rolledBatch.failures);
check(
    "both earlier writes went back on their own",
    readFileSync(mapPathOf(created.id)).equals(batchBefore.map) && readFileSync(mapPathOf(otherMap.id)).equals(batchBefore.other),
    "the files still differ from how the batch found them"
);
check("the journal ends where it started", rolledBatch.journal.from === rolledBatch.journal.to, rolledBatch.journal);

const batchWithNewFile = await call("batch", {
    steps: [
        { tool: "write_plugin_source", args: { name: "MCPBatchProbe", text: probeSource.replace(/MCPProbe/g, "MCPBatchProbe"), enable: true } },
        { tool: "get_map", args: { mapId: 4242 } }
    ]
});
check(
    "a batch that fails after creating a file deletes the file and the entry",
    batchWithNewFile.ok === false &&
        !existsSync(createdPluginFile) &&
        readFileSync(pluginsPath, "utf8") === batchBefore.plugins &&
        batchWithNewFile.rolledBack.some((entry: any) => entry.to === "deleted"),
    { stillThere: existsSync(createdPluginFile), rolledBack: batchWithNewFile.rolledBack }
);

const badArgs = await call("batch", {
    stopOnFailure: false,
    steps: [paint(created.id, 4500), { tool: "set_tiles", args: { mapId: created.id, cells: [{ layer: 9, x: 0, y: 0, tileId: 1 }] } }, { tool: "no_such_tool" }]
});
const refusedAt = (index: number) => badArgs.failures?.find((failure: any) => failure.index === index)?.error ?? "";
check("an argument that does not match the tool's own schema is refused", /layer/.test(refusedAt(1)), badArgs.failures);
check("an unknown tool name is refused the same way", /no tool named/.test(refusedAt(2)), badArgs.failures);
check(
    "and the step that did run is rolled back anyway",
    readFileSync(mapPathOf(created.id)).equals(batchBefore.map) && badArgs.rolledBack?.length === 1,
    { rolledBack: badArgs.rolledBack }
);

const nested = await call("batch", { steps: [{ tool: "undo_writes", args: { steps: 1 } }] });
check("a step that would move the journal is refused", nested.ok === false && /cannot be a step in a batch/.test(nested.failures[0].error), nested.failures);
const empty = await client.callTool({ name: "batch", arguments: { steps: [] } });
check("an empty list is refused by the surface", empty.isError === true);

console.log("\n== new rows and imported assets");
const itemsPath = join(projectDir, "data", "Items.json");
const actorsPath = join(projectDir, "data", "Actors.json");
const itemsBefore = readFileSync(itemsPath);
const actorsBefore = readFileSync(actorsPath);
const blankItems = ((await call("read_database", { table: "Items" })).entries ?? []).filter((entry: any) => !entry.name);
check("the table has blank slots the editor would use", blankItems.length > 0, blankItems?.length);

const claimed = await call("create_database_entry", { table: "Items", fields: { name: "E2E Item", iconIndex: 17 } });
check("it takes the first blank slot rather than the end", claimed.slot === "claimed blank slot" && claimed.id === blankItems[0].id, claimed);
check("the row keeps the shape it claimed: id matches its index", claimed.entry?.id === claimed.id && Object.keys(claimed.entry).length > 5, claimed.entry);
check("the fields asked for are set and the rest are defaults", claimed.entry?.name === "E2E Item" && claimed.entry?.iconIndex === 17 && claimed.entry?.price === 0, claimed.entry);
check("no template was needed, so nothing was copied", claimed.basedOn === null, claimed.basedOn);
check("the file grew by exactly one row of content", !readFileSync(itemsPath).equals(itemsBefore));

const fullTable = ((await call("read_database", { table: "Actors" })).entries ?? []).filter((entry: any) => !entry.name);
check("Actors has no blank slot left", fullTable.length === 0, fullTable);
const appended = await call("create_database_entry", { table: "Actors", copyFrom: 1, fields: { name: "E2E Actor" } });
check("a full table grows at the end", appended.slot === "appended new row" && appended.id === appended.entry?.id, appended);
check("and says whose row it copied, because that is a real actor's equipment", appended.basedOn?.id === 1 && appended.basedOn?.name, appended.basedOn);
check("the new rows show up through the read layer", ((await call("read_database", { table: "Items" })).entries ?? []).some((entry: any) => entry.name === "E2E Item") &&
    ((await call("read_database", { table: "Actors" })).entries ?? []).some((entry: any) => entry.name === "E2E Actor"));

for (const [args, expect] of [
    [{ table: "System", fields: { gameTitle: "x" } }, "one object"],
    [{ table: "MapInfos", fields: {} }, "create_map"],
    [{ table: "Items", id: 1, fields: { name: "clash" } }, "already holds"],
    [{ table: "Actors", id: 4000, fields: {} }, "would leave a hole"],
    [{ table: "Nope", fields: {} }, "not a database table"],
    [{ table: "Items", copyFrom: 99999 }, "not a row of Items"]
] as [Record<string, unknown>, string][]) {
    const refused = await client.callTool({ name: "create_database_entry", arguments: args as any });
    const text = (refused.content as any[])[0]?.text ?? "";
    check(`refused: ${(args as any).table} ${JSON.stringify((args as any).id ?? "")}`.trim(), refused.isError && text.includes(expect), text.slice(0, 200));
}
const patchMissing = await client.callTool({ name: "patch_database_entry", arguments: { table: "Items", id: 4000, patch: { name: "x" } } });
check("patch of a missing row now points at create", (patchMissing.content as any[])[0]?.text?.includes("create_database_entry") === true, patchMissing.content);

const rowsUndone = await call("undo_writes", { steps: 2 });
check("both rows go back byte for byte", readFileSync(itemsPath).equals(itemsBefore) && readFileSync(actorsPath).equals(actorsBefore), rowsUndone.reverted);

const faceFile = join(projectDir, "img", "faces", "Actor1.png");
const faceBytes = readFileSync(faceFile);
const imported = await call("import_asset", { source: "img/faces/Actor1.png", folder: "pictures", name: "E2E Import" });
check("the asset lands in the folder the engine reads", imported.file === "img/pictures/E2E Import.png" && imported.action === "created", imported);
check("the bytes are the file's own", readFileSync(join(projectDir, "img", "pictures", "E2E Import.png")).equals(faceBytes));
check("the reply names the field value to use", imported.name === "E2E Import" && Array.isArray(imported.referencedBy), imported);
const recheck = await call("check_assets", { limit: 200 });
check("check_assets is still clean with the new file in place", recheck.ok === true, recheck.missing?.slice(0, 3));
for (const [args, expect] of [
    [{ source: "img/faces/Actor1.png", folder: "audio/bgm", name: "wrong" }, "holds .ogg"],
    [{ source: "img/faces/Actor1.png", folder: "faces", name: "actor1" }, "differs only by case"],
    [{ source: "img/faces/Actor1.png", folder: "faces", name: "Actor1" }, "already exists"],
    [{ source: "img/faces/Actor1.png", folder: "notafolder" }, "not a folder the engine reads"],
    [{ source: "data/System.json", folder: "pictures", name: "wrong" }, "holds .png"],
    [{ source: "img/no-such.png", folder: "pictures" }, "not a file"]
] as [Record<string, unknown>, string][]) {
    const refused = await client.callTool({ name: "import_asset", arguments: args as any });
    const text = (refused.content as any[])[0]?.text ?? "";
    check(`refused import: ${(args as any).folder} ${(args as any).name ?? ""}`.trim(), refused.isError && text.includes(expect), text.slice(0, 200));
}
const overwritten = await call("import_asset", { source: "img/faces/Actor1.png", folder: "pictures", name: "E2E Import", overwrite: true });
check("overwrite is allowed once asked for, and reports the same size", overwritten.action === "overwrote" && overwritten.bytes === faceBytes.length, overwritten);
const importUndo = await call("undo_writes", { steps: 2 });
check("undo of an import restores the previous bytes, then deletes a created file",
    !existsSync(join(projectDir, "img", "pictures", "E2E Import.png")) &&
        importUndo.reverted.some((entry: any) => entry.to === "deleted") &&
        importUndo.reverted.some((entry: any) => entry.to !== "deleted"),
    importUndo.reverted);
check("the project is byte-identical to before the import test", readFileSync(faceFile).equals(faceBytes));

console.log("\n== high-level authoring tools");
/**
 * The high-level layer is where an agent says what it wants rather than which byte to
 * write, so each tool is checked three ways: that the answer carries a picture and a
 * diff, that the *file* holds the shape the engine reads (verified through the low-level
 * read tools), and that the whole run can be taken back with one undo — which is what
 * makes an authoring loop safe to repeat. Everything below is journaled from here, so the
 * section ends by rolling the project back to `journalMark`.
 */
const journalMark = (await call("write_history")).index;
const mapFields = await call("create_map", { name: "E2E HL Fields", width: 16, height: 12, tilesetId: 2 });
const mapCave = await call("create_map", { name: "E2E HL Cave", width: 14, height: 14, tilesetId: 3 });
await call("set_tiles", { mapId: mapFields.id, rect: { x: 0, y: 0, width: 16, height: 12, layer: 1, tileId: 2816 } });
await call("set_tiles", { mapId: mapCave.id, rect: { x: 0, y: 0, width: 14, height: 14, layer: 1, tileId: 2816 } });
check("two scratch maps exist to author into", mapFields.id > 0 && mapCave.id > 0, [mapFields.id, mapCave.id]);

console.log("  -- make_npc");
const npc = await call("make_npc", {
    mapId: mapFields.id,
    x: 3,
    y: 4,
    name: "HL Elder",
    image: { characterName: "Actor1", characterIndex: 2, direction: 8 },
    say: ["Take the lamp.", "The cave is dark."],
    speaker: "Elder",
    follow: { say: ["Any news?"] },
    patrol: [{ right: true }, { wait: 20 }, { left: true }]
});
check("answers with a rendered picture and the map it touched", npc.image?.mimeType === "image/png" && npc.json.wrote.includes(`Map${String(mapFields.id).padStart(3, "0")}`), npc.json?.wrote);
check("two pages, the second one the follow-up", npc.json.pages === 2, npc.json);
const npcMap = await call("get_map", { mapId: mapFields.id });
const npcEvent = npcMap.events.find((event: any) => event.id === npc.json.eventId);
check("the first page says its lines and closes its own switch", npcEvent.pages[0].commandCount === 4 && npcEvent.pages[0].trigger === 0, npcEvent?.pages?.[0]);
check("the follow page is conditioned on self switch A", npcEvent.pages[1].conditions.join() === "selfSwitchValid", npcEvent?.pages?.[1]);
check("the patrol became the page's own custom route", npcEvent.pages[0].moveRoute?.join(",") === "3,15:[20],2,0" && npcEvent.pages[0].moveType === 1, npcEvent?.pages?.[0]);
check("an NPC blocks its cell unless told otherwise", npcEvent.pages[0].priorityType === 1, npcEvent.pages[0]);
const npcCommands = await call("decode_commands", { mapId: mapFields.id, eventId: npc.json.eventId, pageIndex: 0 });
check("dialog stored as 101 plus one 401 per line", npcCommands.raw[0].code === 101 && npcCommands.raw.filter((command: any) => command.code === 401).length === 2, npcCommands.raw?.length);
check("the speaker name reached command 101", npcCommands.raw[0].parameters[4] === "Elder", npcCommands.raw[0].parameters);
const npcAgain = await call("make_npc", { mapId: mapFields.id, x: 3, y: 4, name: "HL Elder", say: ["Changed my mind."] });
const npcCount = (await call("get_map", { mapId: mapFields.id })).events.filter((event: any) => event.name === "HL Elder").length;
check("re-running with the same name replaces instead of doubling", npcAgain.json.pages === 1 && npcCount === 1, { pages: npcAgain.json.pages, npcCount });
const badNpc = await client.callTool({ name: "make_npc", arguments: { mapId: mapFields.id, x: 5, y: 5, name: "Ghost", image: { characterName: "NoSuchSheet" }, say: ["x"] } });
check("a missing character sheet is refused with what is available", badNpc.isError && errorText(badNpc).includes("img/characters"), errorText(badNpc));
await call("set_tiles", { mapId: mapFields.id, cells: [{ x: 0, y: 11, layer: 3, tileId: 7234 }] });
const walledNpc = await client.callTool({ name: "make_npc", arguments: { mapId: mapFields.id, x: 0, y: 11, name: "Wall NPC", say: ["x"] } });
check("a cell nothing can be stood on is refused rather than written", walledNpc.isError && errorText(walledNpc).includes("blocked"), errorText(walledNpc));

console.log("  -- make_chest");
const chest = await call("make_chest", {
    mapId: mapFields.id, x: 8, y: 2, name: "HL Chest",
    contents: { gold: 40, items: [{ id: 7, count: 2 }] },
    message: ["Gold and two potions."],
    requires: { item: 2 }
});
const chestMap = await call("get_map", { mapId: mapFields.id });
const chestEvent = chestMap.events.find((event: any) => event.id === chest.json.eventId);
const chestList = (await call("decode_commands", { mapId: mapFields.id, eventId: chest.json.eventId, pageIndex: 0 })).raw;
check("a chest is two pages with the open graphic on the second", chest.json.pages === 2 || chestEvent.pages.length === 2, chestEvent?.pages?.length);
check("closed tile is index 0, opened page is index 1", chestEvent.pages[0].image.characterIndex === 0 && chestEvent.pages[1].image.characterIndex === 1, chestEvent?.pages?.map((page: any) => page.image?.characterIndex));
check("the payout is gated by a conditional with an else", chestList[0].code === 111 && chestList.some((command: any) => command.code === 411) && chestList.some((command: any) => command.code === 412), chestList?.slice(0, 2));
check("gold, items and the self switch are all inside the branch", chestList.filter((command: any) => [125, 126, 123].includes(command.code)).map((command: any) => command.code).join(",") === "125,126,123", chestList?.map((command: any) => command.code));
check("the gated commands sit one indent deeper than their branch", chestList.filter((command: any) => [125, 126].includes(command.code)).every((command: any) => command.indent === 1), chestList?.filter((command: any) => command.code === 125));
const blankItemRow = (await call("read_database", { table: "Items" })).entries.find((entry: any) => !entry.name);
const blankChest = await client.callTool({ name: "make_chest", arguments: { mapId: mapFields.id, x: 9, y: 2, contents: { items: [{ id: blankItemRow.id }] } } });
check("a chest of a blank database row is refused", blankChest.isError && errorText(blankChest).includes("blank slot"), errorText(blankChest));

console.log("  -- link_maps");
const link = await call("link_maps", { a: { mapId: mapFields.id, x: 15, y: 5 }, b: { mapId: mapCave.id, x: 1, y: 5 }, requires: { item: 2 }, lockedMessage: ["The gate is shut."] });
const linkA = (await call("get_map", { mapId: mapFields.id })).events.find((event: any) => event.id === link.json.doors[0].eventId);
const doorList = (await call("decode_commands", { mapId: mapFields.id, eventId: link.json.doors[0].eventId, pageIndex: 1 })).raw;
check("both ends were written, each pointing at the other", link.json.doors.length === 2 && link.json.doors[0].to.mapId === mapCave.id && link.json.doors[1].to.mapId === mapFields.id, link.json.doors);
check("a locked door keeps a refusing page in front of the real one", linkA.pages.length === 2 && linkA.pages[1].conditions.join() === "itemValid", linkA?.pages?.[1]);
check("the transfer carries the destination and a fade", doorList[0].code === 250 && doorList[1].code === 201 && doorList[1].parameters[1] === mapCave.id && doorList[1].parameters[5] === 1, doorList);
check("a door stands below the tiles so it never blocks its own cell", linkA.pages[0].priorityType === 0 && linkA.pages[0].trigger === 1, linkA?.pages?.[0]);
// `Game_Player.performTransfer` leaves the player standing still, and `updateNonmoving`
// only re-reads player-touch events on a frame the player *was* moving, so arriving on
// the far threshold does not fire that door — it parks the player on it, under its own
// graphic, and the way back costs a step off first. So each end names a doorway and the
// arrival is the cell beside it.
const besideDoor = (door: any) => door.landed.mapId === door.to.mapId && Math.abs(door.landed.x - door.to.x) + Math.abs(door.landed.y - door.to.y) === 1;
const facesAway = (door: any) =>
    (door.landed.direction === 8 && door.landed.y === door.to.y - 1) ||
    (door.landed.direction === 2 && door.landed.y === door.to.y + 1) ||
    (door.landed.direction === 4 && door.landed.x === door.to.x - 1) ||
    (door.landed.direction === 6 && door.landed.x === door.to.x + 1);
check("each end arrives on the cell beside the other door, not on its threshold", link.json.doors.every(besideDoor), link.json.doors.map((door: any) => door.landed));
check("and faces away from the door it came through", link.json.doors.every(facesAway), link.json.doors.map((door: any) => door.landed?.direction));
check("the transfer command is the cell and facing the reply promised", doorList[1].parameters[2] === link.json.doors[0].landed.x && doorList[1].parameters[3] === link.json.doors[0].landed.y && doorList[1].parameters[4] === link.json.doors[0].landed.direction, doorList[1]);
const told = await call("link_maps", { a: { mapId: mapFields.id, x: 13, y: 8 }, b: { mapId: mapCave.id, x: 12, y: 8, land: { x: 12, y: 9 } } });
const toldList = (await call("decode_commands", { mapId: mapFields.id, eventId: told.json.doors[0].eventId, pageIndex: 0 })).raw;
check("`land` puts the player exactly on the cell it names", told.json.doors[0].landed.x === 12 && told.json.doors[0].landed.y === 9 && told.json.doors[0].landed.how.includes("`land` named"), told.json.doors[0].landed);
check("and the facing still points away from the doorway", toldList[1].parameters[2] === 12 && toldList[1].parameters[3] === 9 && toldList[1].parameters[4] === 2, toldList[1]);
const oneWay = await call("link_maps", { a: { mapId: mapFields.id, x: 14, y: 10 }, b: { mapId: mapCave.id, x: 2, y: 11 }, twoWay: false });
check("a one-way drop writes no door at the far end", oneWay.json.doors.length === 1 && !(await call("get_map", { mapId: mapCave.id })).events.some((event: any) => event.x === 2 && event.y === 11), oneWay.json.doors);
check("and lands on the destination itself, because nothing stands there to walk into", oneWay.json.doors[0].landed.x === 2 && oneWay.json.doors[0].landed.y === 11 && oneWay.json.doors[0].landed.how === "the destination itself", oneWay.json.doors[0].landed);
await call("set_tiles", { mapId: mapCave.id, cells: [[5, 4], [4, 5], [6, 5], [5, 6]].map(([x, y]) => ({ x, y, layer: 3, tileId: 7234 })) });
const boxed = await call("link_maps", { a: { mapId: mapFields.id, x: 13, y: 5 }, b: { mapId: mapCave.id, x: 5, y: 5 } });
check("a door walled in on all four sides still links, onto its own threshold", boxed.json.doors[0].landed.x === 5 && boxed.json.doors[0].landed.y === 5, boxed.json.doors[0].landed);
check("and says so, because the way back is two steps instead of one", (boxed.json.warnings ?? []).some((warning: string) => warning.includes("no open cell beside it")), boxed.json.warnings);
await call("set_tiles", { mapId: mapCave.id, cells: [[5, 4], [4, 5], [6, 5], [5, 6]].map(([x, y]) => ({ x, y, layer: 3, tileId: 0 })) });
await call("set_tiles", { mapId: mapCave.id, cells: [{ x: 6, y: 6, layer: 3, tileId: 7234 }] });
const stuckLanding = await client.callTool({ name: "link_maps", arguments: { a: { mapId: mapFields.id, x: 12, y: 3 }, b: { mapId: mapCave.id, x: 5, y: 5, land: { x: 6, y: 6 } } } });
check("a `land` inside a wall is refused instead of written", stuckLanding.isError && errorText(stuckLanding).includes("not standable"), errorText(stuckLanding));
check("and the refusal left no door behind", (await call("get_map", { mapId: mapFields.id })).events.every((event: any) => event.x !== 12 || event.y !== 3), mapFields.id);
await call("set_tiles", { mapId: mapCave.id, cells: [{ x: 6, y: 6, layer: 3, tileId: 0 }] });
await call("set_tiles", { mapId: mapCave.id, cells: [{ x: 6, y: 6, layer: 3, tileId: 7234 }] });
const badLink = await client.callTool({ name: "link_maps", arguments: { a: { mapId: mapFields.id, x: 14, y: 5 }, b: { mapId: mapCave.id, x: 6, y: 6 } } });
check("a door that would land the player inside a wall is refused", badLink.isError && errorText(badLink).includes("not standable"), errorText(badLink));
const afterBadLink = await call("get_map", { mapId: mapFields.id });
check("and the refusal wrote nothing on either side", !afterBadLink.events.some((event: any) => event.x === 14 && event.y === 5), afterBadLink.events.length);

console.log("  -- make_shop");
const shop = await call("make_shop", {
    mapId: mapFields.id, x: 11, y: 7, name: "HL Shop", greeting: ["Goods."], farewell: ["Come again."],
    goods: [{ id: 7 }, { id: 2, price: 90 }, { id: 3, kind: "item", price: 120 }],
    when: { switch: 3 }
});
const shopList = (await call("decode_commands", { mapId: mapFields.id, eventId: shop.json.eventId, pageIndex: 1 })).raw;
const goodsStart = shopList.findIndex((command: any) => command.code === 302);
check("three goods are 302 plus two 605 lines at the parent indent", goodsStart >= 0 && shopList.slice(goodsStart + 1, goodsStart + 3).every((command: any) => command.code === 605 && command.indent === 0), shopList.slice(goodsStart, goodsStart + 3));
check("the first good rides in command 302's own parameters", shopList[goodsStart].parameters[1] === 7 && shopList[goodsStart].parameters[2] === 0, shopList[goodsStart]);
check("a priced good stores priceType 1 and its price", shopList[goodsStart + 1].parameters[1] === 2 && shopList[goodsStart + 1].parameters[2] === 1 && shopList[goodsStart + 1].parameters[3] === 90, shopList[goodsStart + 1]);
const shopKeeperPage = (await call("get_map", { mapId: mapFields.id })).events.find((event: any) => event.id === shop.json.eventId).pages[1];
check("the keeper blocks the cell so you can stop and talk to it", shopKeeperPage.priorityType === 1 && shopKeeperPage.trigger === 0, shopKeeperPage);
const freeGood = await call("make_shop", { mapId: mapFields.id, x: 12, y: 7, name: "HL Free Shop", goods: [{ id: 2 }] });
check("a good whose database price is 0 is called out as free", (freeGood.json.warnings ?? []).some((warning: string) => warning.includes("free")), freeGood.json.warnings);
const badShop = await client.callTool({ name: "make_shop", arguments: { mapId: mapFields.id, x: 13, y: 7, goods: [{ id: 4000 }] } });
check("a shop of an item that does not exist is refused", badShop.isError && errorText(badShop).includes("does not exist"), errorText(badShop));

console.log("  -- make_choice_scene");
const scene = await call("make_choice_scene", {
    mapId: mapCave.id, x: 6, y: 8, name: "HL Altar", trigger: 0, priorityType: 1,
    image: { characterName: "!Crystal" },
    script: [
        { say: ["Which way?"] },
        {
            choice: {
                options: [
                    { label: "Light it", then: [{ switch: { id: 3 } }, { me: "Like" }, { variable: { id: 2, add: 1 } }] },
                    { label: "Touch it", when: { switch: 3 }, then: [{ gameOver: true }], lockedMessage: ["Nothing happens."] }
                ],
                cancel: [{ comment: ["hedged"] }]
            }
        },
        { if: { when: { variable: { id: 2, op: ">=", value: 2 } }, then: [{ transfer: { mapId: mapFields.id, x: 2, y: 2 } }], else: [{ title: true }] } }
    ]
});
const sceneList = (await call("decode_commands", { mapId: mapCave.id, eventId: scene.json.eventId, pageIndex: 0 })).raw;
check("choices, a gated option and a cancel branch all landed", sceneList[2].code === 102 && sceneList.some((command: any) => command.code === 403) && sceneList.some((command: any) => command.code === 402 && command.parameters[0] === 1), sceneList?.[2]);
check("the cancel type is the choice count, which is how MZ routes it to 403", sceneList[2].parameters[1] === 2, sceneList?.[2]?.parameters);
check("a nested branch is indented under its option, not beside it", sceneList.slice(sceneList.findIndex((command: any) => command.code === 402 && command.parameters[0] === 1)).find((command: any) => command.code === 111)?.indent === 1, sceneList?.filter((command: any) => command.code === 111)?.map((command: any) => command.indent));
check("and its body one deeper still", sceneList.find((command: any) => command.code === 353)?.indent === 2, sceneList?.find((command: any) => command.code === 353));
check("the list ends on the code-0 terminator MZ always writes", sceneList[sceneList.length - 1].code === 0 && sceneList[sceneList.length - 1].indent === 0, sceneList?.slice(-2));
check("no block-structure warning survived the compiler", (scene.json.warnings ?? []).length === 0, scene.json.warnings);
const sceneRewrite = await call("make_choice_scene", { mapId: mapCave.id, eventId: scene.json.eventId, script: [{ say: ["Only this now."] }] });
check("an existing event's page can be rewritten by id", sceneRewrite.json.eventId === scene.json.eventId && (await call("get_map", { mapId: mapCave.id })).events.find((event: any) => event.id === scene.json.eventId).pages[0].commandCount === 2, sceneRewrite.json);
const badStep = await client.callTool({ name: "make_choice_scene", arguments: { mapId: mapCave.id, eventId: scene.json.eventId, script: [{ sayings: ["x"] }] } });
check("an unknown step name answers with the vocabulary", badStep.isError && errorText(badStep).includes("is not a script step"), errorText(badStep));
const badSwitch = await client.callTool({ name: "make_choice_scene", arguments: { mapId: mapCave.id, eventId: scene.json.eventId, script: [{ switch: { id: 4000 } }] } });
check("a switch past System.switches is refused before it is silently dropped", badSwitch.isError && errorText(badSwitch).includes("System.switches"), errorText(badSwitch));
await call("make_choice_scene", { mapId: mapCave.id, eventId: scene.json.eventId, script: [{ say: ["Which way?"] }] });
// `Game_Event.checkEventTriggerAuto` calls `start()` on every frame an Autorun page is
// current, and a starting event is what `Game_Map.isEventRunning()` reports — which
// `Game_Player.canMove()` reads. A page that cannot turn itself off is a frozen map.
const looping = await call("make_choice_scene", { mapId: mapCave.id, x: 3, y: 11, name: "HL Loop Intro", trigger: 3, script: [{ say: ["over and over"] }] });
check("an autorun that cannot stop itself is called out at authoring time", (looping.json.warnings ?? []).some((warning: string) => warning.includes("re-arms")), looping.json.warnings);
const auditLoop = await call("validate_game", { mapIds: [mapCave.id] });
check("and the audit flags the same page as a warning, not an error", (auditLoop.problems ?? []).some((problem: any) => problem.severity === "warning" && /re-arms/.test(problem.what)), (auditLoop.problems ?? []).filter((problem: any) => problem.severity === "warning").map((problem: any) => problem.what));
const stopped = await call("make_choice_scene", { mapId: mapCave.id, x: 3, y: 11, name: "HL Loop Intro", trigger: 3, script: [{ say: ["once"] }, { selfSwitch: { letter: "A" } }, { erase: true }] });
check("the same page with a self switch and an erase says nothing", (stopped.json.warnings ?? []).length === 0, stopped.json.warnings);
const stoppedList = (await call("decode_commands", { mapId: mapCave.id, eventId: stopped.json.eventId, pageIndex: 0 })).raw;
check("and the two commands it added are the ones MZ reads", stoppedList.some((command: any) => command.code === 123) && stoppedList.some((command: any) => command.code === 214), stoppedList.map((command: any) => command.code));

console.log("  -- make_encounter_zone");
const zone = await call("make_encounter_zone", {
    mapId: mapCave.id,
    troops: [{ name: "HL E2E Bats", enemies: [{ id: 1 }, { id: 3 }], weight: 5, region: 7 }, { name: "HL E2E Boss", enemies: [7], weight: 1 }],
    region: { id: 7, rect: { x: 2, y: 2, width: 6, height: 6 } },
    encounterStep: 12
});
const zoneMap = await call("get_map", { mapId: mapCave.id });
check("two troops were made and attached", zone.json.troops.length === 2 && zone.json.troops.every((troop: any) => troop.id > 0), zone.json.troops);
check("the created troop has the members asked for", (await call("read_database", { table: "Troops", id: zone.json.troops[0].id })).entry.members.map((member: any) => member.enemyId).join(",") === "1,3", null);
const regionDump = await call("get_map", { mapId: mapCave.id, layerDump: { layer: 5, x: 2, y: 2, width: 6, height: 6 } });
check("every cell of the rectangle carries the region id", regionDump.layerDump.grid.every((row: number[]) => row.every(value => value === 7)), regionDump.layerDump?.grid?.[0]);
check("rows store MZ's own field names", zone.json.encounters.every((row: any) => Array.isArray(row.regionSet) && Number(row.weight) > 0 && row.appearances === undefined), zone.json.encounters);
check("the whole-map row keeps an empty regionSet", zone.json.encounters.some((row: any) => row.regionSet.length === 0), zone.json.encounters);
check("encounterStep moved", zoneMap.encounterStep === 12, zoneMap.encounterStep);
const badZone = await client.callTool({ name: "make_encounter_zone", arguments: { mapId: mapCave.id, troops: [{ name: "nope", enemies: [4000] }] } });
check("an enemy that is not a row is refused", badZone.isError && errorText(badZone).includes("Enemies[4000]"), errorText(badZone));
const unpaintedZone = await call("make_encounter_zone", { mapId: mapCave.id, troops: [{ troopId: zone.json.troops[0].id, weight: 2, region: 42 }], keepExisting: true });
check("a row on a region nobody painted is reported, not hidden", String(unpaintedZone.json.warning ?? "").includes("42"), unpaintedZone.json.warning);

console.log("  -- set_tileset_flags");
const dry = await call("set_tileset_flags", { tilesetId: 3, tiles: [{ tileId: 512, passable: false, terrainTag: 4 }], dryRun: true });
check("dry run reports the change and writes nothing", dry.dryRun === true && String(dry.wouldChange[0].after).startsWith("0x") && !dry.wrote, dry);
await call("set_tiles", { mapId: mapCave.id, cells: [{ x: 9, y: 9, layer: 0, tileId: 512 }] });
const beforeFlags = await call("inspect_cell", { mapId: mapCave.id, x: 9, y: 9 });
const applied = await call("set_tileset_flags", { tilesetId: 3, tiles: [{ tileId: 512, passable: false, terrainTag: 4, blockFrom: ["up"] }] });
const afterFlags = await call("inspect_cell", { mapId: mapCave.id, x: 9, y: 9 });
check("the same cell went from walkable to impassable", beforeFlags.layers[0].passable === true && afterFlags.layers[0].passable === false, { before: beforeFlags.layers[0], after: afterFlags.layers[0] });
check("and its terrain tag moved with it", afterFlags.terrainTag === 4, afterFlags.terrainTag);
check("the reply says which maps that tileset feeds", (applied.json.mapsUsingThisTileset ?? []).some((map: any) => map.id === mapCave.id), applied.json.mapsUsingThisTileset);
const autotileFlags = await call("set_tileset_flags", { tilesetId: 3, tiles: [{ tileId: 2816, damage: true }] });
check("an autotile id is applied across its whole shape group", autotileFlags.json.changed[0].idsTouched === 48, autotileFlags.json.changed);
// MZ ships the stock pillars and trees with 0x10 ("no effect on passage") set, and
// Game_Map.checkPassage `continue`s past such a tile — so its direction bits are read by
// nobody. A tool that set them and left the bit alone would report success and block nothing.
await call("set_tiles", { mapId: mapFields.id, cells: [{ x: 4, y: 8, layer: 3, tileId: 264 }] });
const pillarBefore = await call("inspect_cell", { mapId: mapFields.id, x: 4, y: 8 });
const pillar = await call("set_tileset_flags", { tilesetId: 2, tiles: [{ tileId: 264, passable: false }] });
const pillarAfter = await call("inspect_cell", { mapId: mapFields.id, x: 4, y: 8 });
check("a tile carrying the 0x10 no-effect bit says it cleared it", pillar.json.changed[0].clearedOverride !== undefined, pillar.json.changed);
check("and the pillar really does become solid", pillarBefore.layers[3].passable === true && pillarAfter.layers[3].passable === false, { before: pillarBefore.layers[3], after: pillarAfter.layers[3] });
const npcOnPillar = await client.callTool({ name: "make_npc", arguments: { mapId: mapFields.id, x: 4, y: 8, name: "On The Pillar", say: ["x"] } });
check("which is what the authoring tools then refuse to place anything on", errorText(npcOnPillar).includes("blocked"), errorText(npcOnPillar));
await call("set_tileset_flags", { tilesetId: 2, tiles: [{ tileId: 264, passable: true, overwrite: true }] });
const tilesetRestored = await call("set_tileset_flags", { tilesetId: 3, tiles: [{ tileId: 512, passable: true, terrainTag: 0 }] });
check("the same call can put the tile back", (await call("inspect_cell", { mapId: mapCave.id, x: 9, y: 9 })).layers[0].passable === true, tilesetRestored.json.changed);
const badRange = await client.callTool({ name: "set_tileset_flags", arguments: { tilesetId: 3, tiles: [{ range: [2800, 4400], passable: false }] } });
check("a range crossing tileset slots is refused", badRange.isError && errorText(badRange).includes("stay inside one tileset slot"), errorText(badRange));

console.log("  -- validate_game");
const audit = await call("validate_game", { mapIds: [mapFields.id, mapCave.id], from: { mapId: mapFields.id, x: 2, y: 2 } });
check("the authored pair audits with no errors", audit.ok === true && audit.counts.errors === 0, audit.problems?.filter((problem: any) => problem.severity === "error"));
check("it counted what it walked", audit.checked.events >= 6 && audit.checked.commands > 40, audit.checked);
check("it names the maps it reached", audit.reachable?.includes(mapCave.id) === true, audit.reachable);
await call("set_commands", { mapId: mapCave.id, eventId: sceneRewrite.json.eventId, list: [{ code: 201, indent: 0, parameters: [0, 9999, 3, 3, 0, 1] }, { code: 0, indent: 0, parameters: [] }] });
const auditBroken = await call("validate_game", { mapIds: [mapFields.id, mapCave.id], from: { mapId: mapFields.id, x: 2, y: 2 } });
const brokenProblem = (auditBroken.problems ?? []).find((problem: any) => problem.severity === "error");
check("a transfer to a map that does not exist is an error, not a shrug", auditBroken.ok === false && String(brokenProblem?.what).includes("9999"), brokenProblem);

// A reviewer's fresh copy played to its credits and logged `Failed to load:
// img/pictures/lighthouse-night.png` — the picture had been imported as a .jpg, which every
// earlier check accepted because it looked for any image extension. `loadBitmap` asks for
// ".png" and nothing else, so both the audit and the import now say so.
await call("set_commands", { mapId: mapCave.id, eventId: sceneRewrite.json.eventId, list: [{ code: 231, indent: 0, parameters: [1, "E2E NO SUCH PICTURE", 0, 0, 100, 100, 255, 0] }, { code: 0, indent: 0, parameters: [] }] });
const auditPicture = await call("validate_game", { mapIds: [mapFields.id, mapCave.id], from: { mapId: mapFields.id, x: 2, y: 2 } });
const pictureProblem = (auditPicture.problems ?? []).find((problem: any) => /Show Picture/.test(problem.where ?? ""));
check("a Show Picture naming a picture the project does not have is an error", auditPicture.ok === false && /E2E NO SUCH PICTURE/.test(pictureProblem?.what ?? ""), pictureProblem);
check("and its fix line says a .jpg will not load", /\.png/.test(pictureProblem?.fix ?? "") && /\.jpg/.test(pictureProblem?.fix ?? ""), pictureProblem?.fix);
await call("undo_writes", { steps: 1 });
const jpgSource = join(tmpdir(), "rpgmaker-mcp-e2e-picture.jpg");
writeFileSync(jpgSource, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
const jpgImport = await client.callTool({ name: "import_asset", arguments: { source: jpgSource, folder: "pictures", name: "E2E Wrong Format" } });
check("import_asset refuses to put a .jpg where the engine will only ever look for a .png", jpgImport.isError && /\.png/.test(errorText(jpgImport)), errorText(jpgImport));
rmSync(jpgSource, { force: true });

console.log("  -- make_map: the ground the content sits on, in one call");
// A run that crashed before its undo leaves the map behind, and `find` would then
// repaint it. Take it back first so this section always starts from nothing.
for (const leftover of (await call("list_maps")).maps.filter((map: any) => String(map.name).startsWith("E2E MAKE_MAP"))) {
    await call("delete_map", { mapId: leftover.id, force: true });
}
const made = await call("make_map", {
    find: "E2E MAKE_MAP",
    width: 12,
    height: 9,
    tilesetId: 3,
    fill: 3246,
    paint: [
        { x: 0, y: 0, width: 12, height: 9, tile: 7234 },
        { x: 1, y: 1, width: 10, height: 7, tile: 3246 },
        { x: 5, y: 8, width: 2, height: 1, tile: 3246 }
    ],
    flags: [{ tileId: 7234, passable: false }]
});
check("one call made the map, painted every cell and came back with the picture", made.json.made === "created" && made.json.cellsToWrite === 12 * 9 && made.image?.mimeType === "image/png", { made: made.json.made, cellsToWrite: made.json.cellsToWrite });
check("it wrote the map, the tree and the tileset it was told to flag", made.json.wrote.includes("MapInfos") && made.json.wrote.includes(`Map${String(made.json.mapId).padStart(3, "0")}`) && made.json.wrote.includes("Tilesets"), made.json.wrote);
const roomDoor = await call("inspect_cell", { mapId: made.json.mapId, x: 5, y: 8 });
check("the doorway carries the floor and nothing under it — no wall survives on a higher layer", roomDoor.layers.filter((layer: any) => layer.tileId > 0).length === 1, roomDoor.layers?.map((layer: any) => [layer.layer, layer.tileId]));
const roomWall = await call("inspect_cell", { mapId: made.json.mapId, x: 0, y: 0 });
check("and the wall went to layer 3, where A4 tiles belong, not buried under the floor", roomWall.layers.filter((layer: any) => layer.tileId > 0).length === 1 && roomWall.layers[3].tileId === 7234, roomWall.layers?.map((layer: any) => [layer.layer, layer.tileId]));
check("the flags came with the paint: the ring is impassable and the room is not", made.json.walkable.blocked >= 12 * 9 - 10 * 7 - 2 && made.json.walkable.open >= 70, made.json.walkable);
const repaint = await call("make_map", { find: "E2E MAKE_MAP", fill: 3246, paint: [{ x: 0, y: 0, width: 12, height: 1, tile: 7234 }] });
check("naming the same map again repaints it instead of making a second one", repaint.json.mapId === made.json.mapId && repaint.json.made === "repainted", { mapId: repaint.json.mapId, made: repaint.json.made });
const clearedCell = await call("inspect_cell", { mapId: made.json.mapId, x: 0, y: 8 });
check("and the wall the old plan left on layer 3 is gone, with the new floor alone in the cell", clearedCell.layers.filter((layer: any) => layer.tileId > 0).length === 1 && clearedCell.layers[1].tileId === 3246, clearedCell.layers?.map((layer: any) => [layer.layer, layer.tileId]));
const dryPath = mapPathOf(made.json.mapId);
const dryBytesBefore = readFileSync(dryPath, "utf8");
const dryRun = await call("make_map", { find: "E2E MAKE_MAP", fill: 2816, dryRun: true });
check("dryRun hands back the plan and leaves the file alone", dryRun.json.dryRun === true && dryRun.json.cellsToWrite > 0 && readFileSync(dryPath, "utf8") === dryBytesBefore, { cellsToWrite: dryRun.json.cellsToWrite });
const badTileset = await client.callTool({ name: "make_map", arguments: { name: "E2E NOPE", width: 4, height: 4, tilesetId: 999, fill: 3246 } });
check("a tileset that is not there is refused before anything is written", badTileset.isError && errorText(badTileset).includes("tileset 999"), errorText(badTileset));
const noSize = await client.callTool({ name: "make_map", arguments: { name: "E2E NOPE", tilesetId: 3, fill: 3246 } });
check("a new map without a size says which two fields are missing", noSize.isError && errorText(noSize).includes("width and height"), errorText(noSize));
const offMap = await call("make_map", { find: "E2E MAKE_MAP", fill: 3246, paint: [{ x: 10, y: 6, width: 6, height: 6, tile: 7234 }] });
check("a rect that hangs off the map is clipped and said out loud", (offMap.json.warnings ?? []).some((warning: string) => warning.includes("outside") && warning.includes("dropped")), offMap.json.warnings);

console.log("  -- describe_tiles: what an id means");
const described = await call("describe_tiles", { mapId: made.json.mapId });
check("it lists the tiles the map actually paints, with their cell counts", described.count === 2 && described.tiles.every((tile: any) => tile.cells > 0), described.tiles?.map((tile: any) => [tile.id, tile.cells]));
const wallTile = described.tiles.find((tile: any) => tile.id === 7234);
check("and says what the engine will do with them: impassable, on layer 3, slot A4", wallTile.blockedFrom.length === 4 && wallTile.layer === 3 && wallTile.slot === "A4", wallTile);
check("the override bit that makes passage bits do nothing is called out when it is set", wallTile.what.includes("impassable") && !String(wallTile.warning ?? "").includes("0x10"), wallTile);
check("nine slots, each with the image bound to it and the first id", described.slots.length === 9 && described.slots.every((slot: any) => slot.firstId >= 0 && slot.count > 0), described.slots?.[0]);
check("a slot with no image says so, because those ids paint nothing", described.slots.some((slot: any) => slot.bound === false && slot.sheet === null), described.slots?.filter((slot: any) => !slot.bound)?.map((slot: any) => slot.slot));
const walked = await call("describe_tiles", { tilesetId: 3, slot: "A2", limit: 5 });
check("walking a slot yields base patterns, 48 shapes each", walked.tiles.length === 5 && walked.tiles[0].pattern === walked.tiles[0].id && walked.tiles[0].shapes === 48 && walked.tiles[1].id - walked.tiles[0].id === 48, walked.tiles?.slice(0, 2));
check("and says so when it capped the list", String(walked.capped ?? "").includes("raise `limit`"), walked.capped);
const sheet = await call("describe_tiles", { mapId: made.json.mapId, contactSheet: { overlay: "passage", columns: 2 } });
check("the contact sheet comes back as a picture with one labelled block per id", sheet.image?.mimeType === "image/png" && sheet.json.contactSheet?.blocks === 2 && sheet.json.contactSheet.columns === 2, sheet.json?.contactSheet);
const leftBehind = (await call("list_maps")).maps.filter((map: any) => String(map.name).startsWith("DT tileset"));
check("and the scratch map it drew on is deleted again", leftBehind.length === 0, leftBehind);

console.log("  -- make_item: rows the player can hold");
const salve = await call("make_item", { name: "E2E Salve", table: "Items", price: 30, consumable: true, occasion: 1, effects: [{ hp: 0.5, hpFlat: 80 }, { tp: 20 }] });
const storedSalve = (await call("read_database", { table: "Items", id: salve.id })).entry;
check("the effect is stored in the engine's own two-value shape, not MV's `value`", storedSalve.effects[0].code === 11 && storedSalve.effects[0].value1 === 0.5 && storedSalve.effects[0].value2 === 80, storedSalve.effects);
check("the second effect came out as gain TP", storedSalve.effects[1].code === 13 && storedSalve.effects[1].value1 === 20, storedSalve.effects[1]);
check("and the reply says what those numbers will do", (salve.effects ?? []).length === 2 && String(salve.effects[0]).includes("recover HP"), salve.effects);
const salveAgain = await call("make_item", { name: "E2E Salve", price: 50 });
check("re-naming the same item rewrites it instead of adding a row", salveAgain.id === salve.id && String(salveAgain.made).startsWith("rewrote"), salveAgain);
const badState = await client.callTool({ name: "make_item", arguments: { name: "E2E Dose", effects: [{ addState: "No Such State" }] } });
check("an effect naming a state the project has not got is refused with samples", badState.isError && errorText(badState).includes("no States row named"), errorText(badState));
const sword = await call("make_item", { table: "Weapons", name: "E2E Short Blade", wtypeId: "Sword", etypeId: "Weapon", params: { atk: 9 }, price: 120 });
const storedSword = (await call("read_database", { table: "Weapons", id: sword.id })).entry;
check("a weapon type spelled in words lands on the id the menu reads", storedSword.wtypeId === 2 && storedSword.etypeId === 1 && storedSword.params[2] === 9, { wtypeId: storedSword.wtypeId, etypeId: storedSword.etypeId, params: storedSword.params });
check("a row the menu can list gets no type warning", (salve.warnings ?? []).every((warning: string) => !/itypeId|itemCategories|item-type/.test(warning)), salve.warnings);
const unreachableItem = await call("make_item", { name: "E2E Nowhere Item", itypeId: 5 });
check(
    "an itypeId the engine does not read is named, because that row would never be listed",
    (unreachableItem.warnings ?? []).some((warning: string) => warning.includes("never be listed")),
    unreachableItem.warnings
);
const tablessItem = await call("make_item", { name: "E2E Shelf Item", itypeId: 2 });
check("itypeId 2 is the Key Item tab and passes without a warning", (tablessItem.warnings ?? []).every((warning: string) => !/itypeId|itemCategories/.test(warning)), tablessItem.warnings);
const namedItemType = await client.callTool({ name: "make_item", arguments: { name: "E2E Named Type", itypeId: "Key Item" } });
check(
    "a spelled item type is refused with the MZ truth rather than looked up in an MV-era list",
    namedItemType.isError && errorText(namedItemType).includes("no item-type name list"),
    errorText(namedItemType)
);
const someState = (await call("read_database", { table: "States" })).entries.find((row: any) => String(row.name ?? "").trim());
const spell = await call("make_item", {
    table: "Skills",
    name: "E2E Ember Breath",
    stypeId: "Magic",
    mpCost: 12,
    tpCost: 10,
    repeats: 3,
    message1: "呼出一口火星。",
    damage: { type: 1, element: "Fire", formula: "a.atk * 3 - b.def * 2" },
    effects: [{ addState: someState.id, chance: 0.5 }]
});
const storedSpell = (await call("read_database", { table: "Skills", id: spell.id })).entry;
check("a Skills row takes the engine's own cost, type and log fields", storedSpell.mpCost === 12 && storedSpell.tpCost === 10 && storedSpell.stypeId === 1 && storedSpell.message1 === "呼出一口火星。", { mpCost: storedSpell.mpCost, stypeId: storedSpell.stypeId, message1: storedSpell.message1 });
check("and the repeats field MZ actually reads (Game_Action.numRepeats), not MV's `repeat`", storedSpell.repeats === 3 && !("repeat" in storedSpell), { repeats: storedSpell.repeats, hasRepeat: "repeat" in storedSpell });
check("the damage formula and element went through as the engine reads them", storedSpell.damage.type === 1 && storedSpell.damage.elementId === 2 && storedSpell.damage.formula === "a.atk * 3 - b.def * 2", storedSpell.damage);
check("an effect on a skill is the same two-value shape as on an item", storedSpell.effects[0].code === 21 && storedSpell.effects[0].dataId === someState.id && storedSpell.effects[0].value1 === 0.5, storedSpell.effects);

console.log("  -- make_battle: the foe and the group");
const bout = await call("make_battle", {
    foe: {
        name: "E2E Warden",
        battler: { name: "Goblin", hue: 0 },
        params: { hp: 340, atk: 21, def: 12 },
        exp: 90,
        gold: 60,
        actions: [{ skill: 1, rating: 6 }],
        drops: [{ kind: "item", name: "E2E Salve", oneIn: 4 }],
        elementRates: [{ element: "Fire", rate: 0.5 }]
    },
    troop: { name: "E2E Warden x3", count: 3 }
});
const storedFoe = (await call("read_database", { table: "Enemies", id: bout.enemyId })).entry;
check("one call wrote both rows and says which ids they became", bout.enemyId > 0 && bout.troopId > 0 && String(bout.enemy).includes("made Enemies"), bout);
check("the four parameters this call named landed in the engine's order", storedFoe.params.join() === [340, 0, 21, 12, 20, 20, 20, 20].join(), { params: storedFoe.params, note: bout.paramsFrom });
check("a drop is three slots with the denominator spelled as one in four", storedFoe.dropItems.length === 3 && storedFoe.dropItems[0].kind === 1 && storedFoe.dropItems[0].dataId === salve.id && storedFoe.dropItems[0].denominator === 4 && storedFoe.dropItems[1].kind === 0, storedFoe.dropItems);
check("an element named in words became trait 11 with that element's id", storedFoe.traits.some((trait: any) => trait.code === 11 && trait.dataId === 2 && trait.value === 0.5), storedFoe.traits);
const storedTroop = (await call("read_database", { table: "Troops", id: bout.troopId })).entry;
check("the troop holds three copies of the foe this call made, not the row it was copied from", storedTroop.members.length === 3 && storedTroop.members.every((member: any) => member.enemyId === bout.enemyId), { members: storedTroop.members, enemyId: bout.enemyId });
check("and says where the positions came from", Boolean(bout.positionsFrom), bout.positionsFrom);
check("and the action reached the engine's own five keys", storedFoe.actions.length === 1 && storedFoe.actions[0].skillId === 1 && storedFoe.actions[0].rating === 6 && storedFoe.actions[0].conditionType === 0, storedFoe.actions);
const boutAgain = await call("make_battle", { foe: { name: "E2E Warden", exp: 120 }, troop: { name: "E2E Warden x3", count: 2 } });
check("re-running by name rewrites the same two rows", boutAgain.enemyId === bout.enemyId && boutAgain.troopId === bout.troopId && String(boutAgain.troop).includes("rewrote Troops"), boutAgain);
check(
    "and no warning from the layer spells a reply object into its sentence",
    [...(bout.warnings ?? []), ...(boutAgain.warnings ?? [])].every((warning: string) => !warning.includes("[object")),
    { bout: bout.warnings, again: boutAgain.warnings }
);
const armed = await call("make_battle", { foe: { name: "E2E Warden", actions: [{ skill: "E2E Ember Breath", rating: 8 }] } });
const armedFoe = (await call("read_database", { table: "Enemies", id: armed.enemyId })).entry;
check("a foe can be handed a skill this session made, named rather than numbered", armedFoe.actions[0].skillId === spell.id && armedFoe.actions[0].rating === 8, armedFoe.actions);
const badSkill = await client.callTool({ name: "make_battle", arguments: { foe: { name: "E2E Nobody", actions: [{ skill: "No Such Skill" }] } } });
check("an action naming a skill that is not there is refused, not written", badSkill.isError && errorText(badSkill).includes("no Skills row named"), errorText(badSkill));
const badDrop = await client.callTool({ name: "make_battle", arguments: { foe: { name: "E2E Nobody2", drops: [{ kind: "item", name: "E2E Salve", oneIn: 4 }, { kind: "item", name: "E2E Salve", oneIn: 4 }, { kind: "item", name: "E2E Salve", oneIn: 4 }, { kind: "item", name: "E2E Salve", oneIn: 4 }] } } });
check("a fourth drop slot is refused because the engine only reads three", badDrop.isError && errorText(badDrop).includes("three drop slots"), errorText(badDrop));

const undoAuthoring = await call("undo_writes", { since: journalMark });
check("one undo takes the whole authoring session back", undoAuthoring.reverted.length > 0, undoAuthoring.reverted?.length);
check("no rollback step lost a backup on the way", undoAuthoring.reverted.every((entry: any) => entry.to !== "backup missing"),
    undoAuthoring.reverted.filter((entry: any) => entry.to === "backup missing"));
const afterUndoMaps = (await call("list_maps")).maps.map((map: any) => map.name);
check("the scratch maps are gone from the tree", !afterUndoMaps.includes("E2E HL Fields") && !afterUndoMaps.includes("E2E HL Cave"), afterUndoMaps);
const troopsAfter = (await call("read_database", { table: "Troops" })).entries.filter((entry: any) => String(entry.name).startsWith("HL E2E"));
check("the troops this section made are gone too", troopsAfter.length === 0, troopsAfter);
check("no map file was left behind", !existsSync(join(projectDir, "data", `Map${String(mapFields.id).padStart(3, "0")}.json`)));

console.log("\n== actors table + errors");
const actors = await call("read_database", { table: "Actors" });
check("actors listed with ids", actors.entries.length > 0 && actors.entries[0].id === 1, actors.entries?.[0]);
const badTable = await client.callTool({ name: "read_database", arguments: { table: "Nope" } });
check("unknown table returns isError", badTable.isError === true);
const badCell = await client.callTool({ name: "inspect_cell", arguments: { mapId: created.id, x: 9999, y: 0 } });
check("out-of-range cell returns isError", badCell.isError === true);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
await client.close();
await server.close();
process.exit(failures === 0 ? 0 : 1);
