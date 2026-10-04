/**
 * Smoke-test the server the way an agent actually reaches it: spawn the command, args
 * and environment recorded in the user's Qoder settings — not an in-process import of
 * `dist/index.js` — and drive a breadth-first slice of the registry through it.
 *
 *   node scripts/smoke-registered.mjs
 *
 * This is the "does the chain work" gate: registry shape, the read surface, a write
 * surface that is then taken back with `undo_writes`, and what the live bridge says when
 * another process already holds its port. Per-call timings are printed, because a tool
 * that takes nine seconds is a different answer from one that takes nine milliseconds.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { withRegisteredServer } from "./mcp-client.mjs";

const HIGH_LEVEL = ["make_npc", "make_chest", "make_shop", "make_choice_scene", "make_encounter_zone", "link_maps", "set_tileset_flags", "validate_game"];

let failures = 0;
const timings = [];
const findings = [];
const check = (name, condition, detail) => {
    if (!condition) {
        failures++;
    }
    console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}${condition || detail === undefined ? "" : ` -> ${JSON.stringify(detail).slice(0, 300)}`}`);
};

const report = await withRegisteredServer(async (call, client) => {
    const lines = [];
    /**
     * One call, timed, with the answer handed back for assertions. `expect: "failure"`
     * inverts it, for the checks that are about the server refusing something, and
     * `expect: "either"` records which way a call that has no right answer went.
     */
    const step = async (name, tool, args = {}, timeoutMs, expect) => {
        const started = Date.now();
        let value;
        let error;
        try {
            value = await call(tool, args, timeoutMs);
        } catch (caught) {
            error = caught;
        }
        const ms = Date.now() - started;
        const message = String(error?.message ?? value?.error ?? "");
        const refused = Boolean(error) || value?.error !== undefined;
        if (expect === "either") {
            timings.push({ name, tool, ms, failed: false });
            lines.push(`  ok    ${refused ? "refused" : "accepted"}  ${name} (${tool}) ${ms}ms${refused ? ` -> ${message.slice(0, 200)}` : ""}`);
            return { refused, message, value };
        }
        timings.push({ name, tool, ms, failed: expect === "failure" ? !refused : refused });
        if (expect === "failure") {
            lines.push(`  ${refused ? "ok    refused" : "FAIL  accepted"}  ${name} (${tool}) ${ms}ms${refused ? ` -> ${message.slice(0, 220)}` : ""}`);
            if (!refused) {
                failures++;
            }
            return refused ? { refused: true, message } : null;
        }
        if (refused) {
            lines.push(`  FAIL  ${name} (${tool}) ${ms}ms -> ${message.slice(0, 220)}`);
            failures++;
            return null;
        }
        lines.push(`  ok    ${name} (${tool}) ${ms}ms`);
        return value;
    };

    // --- the registry the chain exposes ---------------------------------------
    const listed = await client.listTools();
    const names = listed.tools.map(tool => tool.name);
    lines.push(`\n== registry`);
    check(`the registered command answers tools/list with ${names.length} tools`, names.length >= 50, names.length);
    check(`and all ${HIGH_LEVEL.length} high-level tools are on it`, HIGH_LEVEL.every(name => names.includes(name)), HIGH_LEVEL.filter(name => !names.includes(name)));
    const declared = listed.tools.filter(tool => (tool.description ?? "").length < 40);
    check("every tool carries a description worth reading", declared.length === 0, declared.map(tool => tool.name));

    // --- the read surface -----------------------------------------------------
    lines.push("\n== reading");
    const info = await step("project_info", "project_info");
    const maps = await step("list_maps", "list_maps");
    const village = maps?.maps.find(map => map.name === "SR Village");
    if (!village) {
        // Everything below reads the acceptance game's own doors, troop and road tile, and the
        // write section paints with the tile ids its tilesets carry. A project that has never
        // held that game is not a failing project: say what was skipped rather than dereference
        // `village.id` and hand the reader a TypeError that looks like the server crashed.
        lines.push(`  n/a   the acceptance game is not in this project (no map named "SR Village"), so the read and write sections are skipped`);
        lines.push(`        what did run: the registered command answered tools/list, every description was read, project_info and list_maps came back`);
        lines.push(`        to get this suite's coverage on your own project: npm run verify:newdata, npm run verify:input, npm run census`);
        return lines;
    }
    check("the acceptance game's village is in the project", Boolean(village), maps?.maps?.map(map => map.name));
    const map = await step("get_map", "get_map", { mapId: village.id });
    const cell = await step("inspect_cell", "inspect_cell", { mapId: village.id, x: 15, y: 9 });
    const slots = await step("tileset_slots", "tileset_slots", { tilesetId: village.tilesetId });
    const events = await step("find_events", "find_events", { mapId: village.id, name: "Cave Mouth" });
    const decoded = await step("decode_commands", "decode_commands", { mapId: village.id, eventId: events.hits[0].eventId, pageIndex: 0 });
    const catalog = await step("command_catalog", "command_catalog", { query: "transfer" });
    check("the codebook that decodes and catalogues commands is loaded", decoded?.codebookLoaded === true && Boolean(catalog?.source), { decoded: decoded?.codebookLoaded, source: catalog?.source });
    const database = await step("read_database", "read_database", { table: "Troops" });
    const plugins = await step("list_plugins", "list_plugins");
    const reach = await step("map_connectivity", "map_connectivity", { mapId: village.id, x: 15, y: 9 });
    const assets = await step("check_assets", "check_assets");
    const health = await step("validate_game", "validate_game", {}, 120000);
    const rendered = await step("render_map", "render_map", { mapId: village.id, overlay: "passage", scale: 0.5 });
    check("the passage overlay came back as a PNG", rendered?.image?.mimeType === "image/png", rendered?.image?.mimeType);
    check("the walk from the road reaches the cave mouth", reach?.portals?.some(portal => portal.name === "Cave Mouth"), reach?.portals);
    check("no portal in the project drops the player on an impassable tile", (reach?.traps ?? []).length === 0, reach?.traps);
    check("every image and audio name the data mentions is on disk", assets?.ok === true, assets?.missing?.slice(0, 4));
    check("and the whole game validates without an error", health?.ok === true, health?.problems?.filter(problem => problem.severity === "error").slice(0, 4));
    check("the troop the zone rolls is a real row", database?.entries?.some(row => row.name === "SR Cave Bats"), database?.entries?.length);
    check("the live bridge plugin is enabled in the project", plugins?.plugins?.some(plugin => plugin.name === "RMMZLiveBridge" && plugin.status), plugins?.plugins?.map(plugin => `${plugin.name}:${plugin.status}`).slice(0, 6));
    const transfer = decoded?.raw?.find(command => command.code === 201);
    check(
        "the decoder reads the door's transfer and it points at an open cell, not a wall",
        transfer?.parameters?.[0] === 0 && transfer.parameters[1] > 0 && transfer.parameters[2] >= 0,
        transfer
    );
    check(
        "and the door turns the player to face away from it",
        [8, 6, 4, 2].includes(transfer?.parameters?.[4]),
        { direction: transfer?.parameters?.[4] }
    );
    check(`the catalog answers a query with ${catalog?.matches?.length ?? 0} command(s)`, (catalog?.matches ?? []).length > 0, catalog?.matches?.slice(0, 3));
    check("inspect_cell says what the road tile is", cell?.layers?.some(layer => layer.tileId > 0), cell?.layers);
    check("the tileset reports its nine slots", slots?.slots?.length === 9, slots?.slots?.length);

    // --- the live surface, as the chain sees it -------------------------------
    lines.push("\n== live bridge");
    const live = await step("live_status", "live_status");
    console.log(
        `        note  this spawned server says: listening ${live?.listening}, port ${live?.port}, ` +
            `bind ${live?.listenError ? `refused (${String(live.listenError).slice(0, 80)})` : "ok"}, ` +
            `a game is reporting to it: ${live?.state ? live.state.gameTitle : "none"} ` +
            `(the process Qoder keeps alive holds port ${live?.port}, so two servers on one port is what this line is for)`
    );
    check("live_status answers with the port, token and bridge shape it is listening on", typeof live?.port === "number" && typeof live?.tokenConfigured === "boolean", live);

    // --- the write surface, taken back again ----------------------------------
    lines.push("\n== writing, then undoing");
    const openJournal = await step("write_history before any writing", "write_history", { limit: 1 });
    const created = await step("create_map", "create_map", { name: "SMOKE-MAP", width: 10, height: 8, tilesetId: 3 });
    const mapFile = join(info.projectDir, "data", `Map${String(created.id).padStart(3, "0")}.json`);
    check("the new map file exists", existsSync(mapFile), mapFile);
    await step("set_tiles", "set_tiles", { mapId: created.id, rect: { x: 1, y: 1, width: 8, height: 6, layer: 1, tileId: 3246 } });
    await step("make_npc", "make_npc", { mapId: created.id, x: 3, y: 3, name: "SMOKE Keeper", say: ["Smoke test."] });
    await step("make_chest", "make_chest", { mapId: created.id, x: 5, y: 3, name: "SMOKE Chest", contents: { gold: 10 } });
    const linked = await step("link_maps", "link_maps", { a: { mapId: created.id, x: 8, y: 3 }, b: { mapId: created.id, x: 2, y: 6 } });
    const written = await step("get_map after four writes", "get_map", { mapId: created.id });
    check("the scratch map holds the npc, the chest and one door at each end", (written?.events ?? []).length === 4, written?.events?.map(event => event.name));
    check(
        "and the reply names two doors, each landing beside the other",
        (linked?.doors ?? []).length === 2 && linked.doors.every(door => door.landed.x !== door.to.x || door.landed.y !== door.to.y),
        linked?.doors?.map(door => ({ at: door.at, landed: [door.landed.x, door.landed.y], how: door.landed.how }))
    );
    const firstDoor = linked?.doors?.[0];
    const decodedDoor = await step("decode_commands on the new door", "decode_commands", { mapId: created.id, eventId: firstDoor.eventId, pageIndex: 0 });
    const doorTransfer = decodedDoor?.raw?.find(command => command.code === 201);
    check(
        "the file says the same landing the reply promised",
        doorTransfer?.parameters?.[2] === firstDoor.landed.x &&
            doorTransfer?.parameters?.[3] === firstDoor.landed.y &&
            doorTransfer?.parameters?.[4] === firstDoor.landed.direction,
        { inFile: doorTransfer?.parameters, replied: firstDoor.landed }
    );
    const landingCell = await step("inspect_cell on the landing", "inspect_cell", { mapId: created.id, x: firstDoor.landed.x, y: firstDoor.landed.y });
    check(
        "and that landing is a cell the player can stand on, with nothing in it",
        linked?.checked?.every(step => step.standableAtBothEnds === true) && landingCell?.event === null,
        { checked: linked?.checked, landing: landingCell && { at: [landingCell.x, landingCell.y], event: landingCell.event, terrainTag: landingCell.terrainTag } }
    );

    const tileBefore = await step("inspect_cell before the batch", "inspect_cell", { mapId: created.id, x: 2, y: 2 });
    check("the cell the batch is about to ruin starts out painted", tileBefore?.layers?.[1]?.tileId === 3246, tileBefore?.layers?.[1]);
    const batch = await step("batch (a write, then a step its own schema refuses)", "batch", {
        steps: [
            { tool: "set_tiles", args: { mapId: created.id, cells: [{ x: 2, y: 2, layer: 1, tileId: 0 }] } },
            { tool: "place_event", args: { mapId: created.id, x: -1, y: 4, name: "SMOKE Bad" } }
        ]
    });
    check(
        "a batch whose second step is refused rolls the first back",
        batch?.ok === false &&
            batch?.applied === 1 &&
            (batch?.rolledBack ?? []).length > 0 &&
            (batch?.rolledBack ?? []).every(entry => entry.file === `Map${String(created.id).padStart(3, "0")}.json`) &&
            batch?.failures?.[0]?.index === 1 &&
            /x: Too small/.test(batch?.failures?.[0]?.error ?? ""),
        { ok: batch?.ok, applied: batch?.applied, rolledBack: batch?.rolledBack, failures: batch?.failures }
    );
    const afterBatch = await step("get_map after the rolled-back batch", "get_map", { mapId: created.id });
    const tileAfter = await step("inspect_cell after the rolled-back batch", "inspect_cell", { mapId: created.id, x: 2, y: 2 });
    check(
        "nothing the batch wrote survived: same events, same tile",
        (afterBatch?.events ?? []).length === 4 && JSON.stringify(tileAfter?.layers) === JSON.stringify(tileBefore?.layers),
        { events: afterBatch?.events?.map(event => event.name), before: tileBefore?.layers, after: tileAfter?.layers }
    );

    // Two mistakes an agent makes with a command list: a real code with the wrong
    // parameter shape, and a code the engine has no method for. Both are asked of
    // `set_commands` on the scratch map, and both are taken back with the rest.
    const keeper = written.events.find(event => event.name === "SMOKE Keeper");
    const wrongShape = await step(
        "set_commands with a known code, wrong parameters",
        "set_commands",
        { mapId: created.id, eventId: keeper.id, list: [{ code: 101, indent: 0, parameters: [0, 0, 0, "Still here."] }, { code: 0, indent: 0, parameters: [] }] },
        undefined,
        "failure"
    );
    check("the refusal says which command is wrong", /Command 101 parameters/.test(wrongShape?.message ?? ""), wrongShape?.message);

    const unknownCode = await step(
        "set_commands with a code the engine does not have",
        "set_commands",
        { mapId: created.id, eventId: keeper.id, list: [{ code: 9999, indent: 0, parameters: [1, "x"] }, { code: 0, indent: 0, parameters: [] }] },
        undefined,
        "either"
    );
    if (unknownCode.refused) {
        check("the refusal names the code it has no method for", /9999/.test(unknownCode.message), unknownCode.message);
    } else {
        const kept = (await step("read that page back", "decode_commands", { mapId: created.id, eventId: keeper.id, pageIndex: 0 }))
            ?.raw?.some(command => command.code === 9999);
        findings.push(
            `set_commands accepted command code 9999${kept ? " and it is sitting in the map file now" : " but did not keep it"}: the write path checks each known code's parameter shape, not that the code exists. The editor refuses to write such a command, so a project can pick up a command this server will not flag. validate_game does not either.`
        );
    }

    const history = await step("write_history", "write_history", { limit: 200 });
    check("the journal lists this process's writes", (history?.entries ?? []).length > 0, history?.entries?.length);
    const undone = await step("undo_writes back to where this section started", "undo_writes", { since: openJournal.index });
    check(
        "undo_writes steps back through every file this run wrote",
        (undone?.reverted ?? []).length >= 5 && undone?.remaining === openJournal.index,
        { reverted: undone?.reverted?.length, remaining: undone?.remaining, next: undone?.next?.slice(0, 4) }
    );
    check("and it deleted the map file create_map made", !existsSync(mapFile), mapFile);
    const stillThere = await step("list_maps after the undo", "list_maps");
    check("the scratch map is gone from the project too", !stillThere.maps.some(entry => entry.name === "SMOKE-MAP"), stillThere.maps.map(entry => entry.name));

    return lines;
});

console.log(report.join("\n"));
console.log(`\n== timings (slowest first)`);
for (const entry of [...timings].sort((a, b) => b.ms - a.ms).slice(0, 8)) {
    console.log(`   ${String(entry.ms).padStart(6)}ms  ${entry.tool}${entry.failed ? "  (failed)" : ""}`);
}
console.log(`\n${timings.length} calls through the registered chain, ${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}`);
if (findings.length) {
    console.log(`\n== findings (measured, not asserted)`);
    for (const finding of findings) {
        console.log(`   · ${finding}`);
    }
}
process.exitCode = failures === 0 ? 0 : 1;
