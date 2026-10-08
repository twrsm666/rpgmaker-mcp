#!/usr/bin/env node
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Project, integer, point, makeEvent } from "./project.js";
import { tileInfo } from "./tile-info.js";
import { tileDescription, tileSheet, retile, validateTile } from "./engine.js";
import { startPreview } from "./preview-server.js";
import { Capture } from "./capture.js";
import { analyze } from "./analysis.js";
import { RuntimeBridge } from "./runtime.js";
import { Playtest } from "./playtest.js";
import { NativePlaytest } from "./native-playtest.js";
import { registerEditorTools } from "./editor-tools.js";
import { registerEventTools } from "./event-commands.js";

const mapIdSchema = z.number().int().min(1).max(999);
const directionSchema = z.union([2, 4, 6, 8].map(value => z.literal(value)));
const xy = z.object({ x: z.number().int().min(0).max(255), y: z.number().int().min(0).max(255) });
const regionSchema = xy.extend({ width: z.number().int().min(1).max(256), height: z.number().int().min(1).max(256) });
const imageSchema = z.object({ characterName: z.string().max(128).optional(), characterIndex: z.number().int().min(0).max(7).optional(),
  direction: directionSchema.optional(), pattern: z.number().int().min(0).max(2).optional(), tileId: z.number().int().min(0).max(1023).optional() });
const editSchema = { mapId: mapIdSchema, expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  screenshot: z.boolean().default(true).describe("Return the edited map as image. Full-map rendering fits within 1600px.") };
const textResult = value => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

// Tool failures must tell the agent what happened, where, and what to do next:
// zod issues as readable lines, cause chains, system error codes, and the top
// stack frames for engine-level errors that lack context in their message.
function describeError(error) {
  if (error && Array.isArray(error.issues)) {
    const lines = error.issues.map(issue => {
      const path = Array.isArray(issue.path) && issue.path.length ? issue.path.join(".") : "(value)";
      const expected = issue.expected !== undefined ? ` (expected ${issue.expected})` : "";
      return `- ${path}: ${issue.message}${expected}`;
    });
    return `Invalid arguments (${lines.length} issue${lines.length > 1 ? "s" : ""}):\n${lines.join("\n")}`;
  }
  const parts = [];
  let current = error, depth = 0;
  while (current && depth < 4) {
    const code = current.code && current.code !== error.message ? ` [${current.code}]` : "";
    parts.push(`${depth ? "Caused by: " : ""}${current.message ?? String(current)}${code}`);
    current = current.cause; depth++;
  }
  if (!parts.length) parts.push(String(error));
  if ((error instanceof TypeError || error instanceof ReferenceError) && error.stack) {
    const frames = error.stack.split("\n").slice(1, 4).filter(line => line.trim());
    if (frames.length) parts.push(frames.join("\n"));
  }
  return parts.join("\n");
}

export async function createService({ projectPath, enginePath, port = 0, browserPath, readOnly = false, liveBridge = false }) {
  const project = await Project.open(projectPath, enginePath, { readOnly });
  const runtime = liveBridge ? new RuntimeBridge(project) : null;
  const preview = await startPreview(project, port, runtime);
  if (runtime) await runtime.activate(preview);
  const capture = new Capture(preview, browserPath);
  const playtest = runtime ? new Playtest(preview, runtime, browserPath) : null;
  const nativePlaytest = runtime ? new NativePlaytest(project, runtime) : null;
  const server = new McpServer({ name: "rpg-maker-mz-visual", version: "0.4.0" }, {
    instructions: "Visual map iteration: project_info → list_maps → render_map and tile_palette → inspect_cell → edits with expectedRevision → examine returned image. Coordinates zero-based. Four tile layers 0..3, shadow 4, region 5. Close native MZ project before MCP writes; reopen afterward. Never infer a tile's appearance from its number; use tile_palette. Every edit backs up and checks revision. Design rendering uses stock MZ; custom plugins are not executed. Preview HTTP has no write API. Event logic: create the event with upsert_event/put_event, then append behavior with event_show_text, event_show_choices, event_input_number, event_battle, event_give_items, event_give_gold, event_switches, event_self_switch, event_variables, event_if, event_move_route, event_play_se, event_transfer_player, event_wait, event_change_party, event_change_actor_hp, event_change_actor_mp, event_change_actor_level, event_change_actor_state, event_recover_all, event_change_actor_skill, event_change_actor_images, event_change_enemy_hp, event_enemy_appear, event_enemy_transform, event_screen_fade, event_tint_screen, event_flash_screen, event_shake_screen, event_set_weather, event_show_animation, event_set_event_location, event_show_picture, event_move_picture, event_erase_picture, event_comment, event_exit_event, event_erase_event, event_call_common_event, event_label, event_jump_to_label, event_name_input, event_shop, event_control_timer and event_change_access; chain several for complex flows and fall back to event_raw_commands for anything else. Close an open editor session before calling event_* tools, or refresh the revision."
  });
  // Unknown keys used to be stripped silently, so a typo'd or unsupported argument
  // (put_event's `transfer`, for one) produced a successful-looking write that quietly
  // dropped what the caller asked for. Reject at the boundary instead of losing intent.
  const strictInput = schema => typeof schema?.parse === "function" ? schema : z.object(schema || {}).strict();
  const register = (name, description, inputSchema, callback, write = false) => server.registerTool(name, {
    description, inputSchema: strictInput(inputSchema),
    annotations: { readOnlyHint: !write, destructiveHint: write, idempotentHint: !write, openWorldHint: false }
  }, async args => {
    try { return await callback(args); }
    catch (error) { return { isError: true, content: [{ type: "text", text: describeError(error) }] }; }
  });
  registerEditorTools({ project, preview, register, textResult });
  const fitScale = async id => {
    const { map } = await project.read(id);
    const { tileSize } = await project.info();
    return Math.max(.25, Math.min(1, 1600 / (Math.max(map.width, map.height) * tileSize)));
  };
  const picture = async options => {
    const { buffer, ...meta } = await capture.render(options);
    return { content: [{ type: "text", text: JSON.stringify(meta, null, 2) }, { type: "image", data: buffer.toString("base64"), mimeType: "image/png" }] };
  };
  const afterEdit = async (result, screenshot) => {
    preview.focus({ mapId: result.mapId });
    if (!screenshot) return textResult(result);
    try {
      const image = await picture({ mapId: result.mapId, scale: await fitScale(result.mapId), eventMarkers: true });
      return { content: [...textResult(result).content, ...image.content] };
    } catch (error) {
      // A rendering failure must never misrepresent a successful disk write.
      return textResult({ ...result, screenshotError: error.message, editSucceeded: true });
    }
  };
  registerEventTools({ project, register, afterEdit });
  register("project_info", "Inspect the configured project, engine renderer, and synchronization limitations.", {}, async () =>
    textResult({ ...(await project.info()), previewUrl: preview.previewUrl, runtimeBridgeEnabled: liveBridge }));
  register("list_maps", "List map IDs and the MZ map tree.", {}, async () => textResult(await project.maps()));
  register("create_map", "Create a new empty map and register it in MapInfos. Requires catalogRevision from project_info; refuses to overwrite existing files.", {
    mapId: mapIdSchema, expectedCatalogRevision: z.string().regex(/^[a-f0-9]{64}$/),
    name: z.string().min(1).max(256), parentId: z.number().int().min(0).max(999).default(0),
    width: regionSchema.shape.width, height: regionSchema.shape.height, tilesetId: z.number().int().min(1).max(999)
  }, async args => textResult(await project.createMap(args)), true);
  register("configure_map", "Update map properties or grow its six-layer grid. Shrinking refuses to discard nonempty cells or events. Requires map revision.", {
    ...editSchema, properties: z.object({
      width: regionSchema.shape.width.optional(), height: regionSchema.shape.height.optional(),
      tilesetId: z.number().int().min(1).max(999).optional(), displayName: z.string().max(256).optional(),
      note: z.string().max(65536).optional(), scrollType: z.number().int().min(0).max(3).optional(),
      disableDashing: z.boolean().optional(), specifyBattleback: z.boolean().optional(),
      battleback1Name: z.string().max(128).optional(), battleback2Name: z.string().max(128).optional(),
      encounterList: z.array(z.object({ troopId: z.number().int().min(1), weight: z.number().int().min(1), regionSet: z.array(z.number().int().min(1).max(255)) })).optional(),
      autoplayBgm: z.boolean().optional(), bgm: z.object({ name: z.string().max(128), pan: z.number().min(-100).max(100),
        pitch: z.number().min(50).max(150), volume: z.number().min(0).max(100) }).optional()
    }).strict()
  }, async args => afterEdit(await project.configureMap(args.mapId, args.expectedRevision, args.properties), args.screenshot), true);
  register("read_map", "Read map metadata/revision and events. Include tile data only when needed.", {
    mapId: mapIdSchema, includeData: z.boolean().default(false), region: regionSchema.optional()
  }, async ({ mapId, includeData, region }) => {
    const { map, revision } = await project.read(mapId), metadata = { ...map };
    delete metadata.data;
    let data;
    if (includeData) {
      if (!region) data = map.data;
      else {
        point(map, region.x, region.y); point(map, region.x + region.width - 1, region.y + region.height - 1);
        data = Array.from({ length: 6 }, (_, z) => Array.from({ length: region.height }, (_, y) =>
          Array.from({ length: region.width }, (_, x) => map.data[(z * map.height + region.y + y) * map.width + region.x + x])));
      }
    }
    return textResult({ mapId, revision, ...metadata, ...(includeData ? { data, dataFormat: region ? "[layer][y][x]" : "(layer*height+y)*width+x" } : {}) });
  });
  register("inspect_cell", "Inspect all tile layers, region, shadow, flags, and full events at one coordinate.", {
    mapId: mapIdSchema, x: xy.shape.x, y: xy.shape.y
  }, async ({ mapId, x, y }) => textResult(await project.inspect(mapId, x, y)));
  register("render_map", "Return a genuine PNG image of local MZ tiles and event sprites. Use region and scale for detailed iteration.", {
    mapId: mapIdSchema, region: regionSchema.optional(), scale: z.number().min(.25).max(4).optional(),
    grid: z.boolean().default(false), events: z.boolean().default(true), eventMarkers: z.boolean().default(true),
    regions: z.boolean().default(false), animationFrame: z.number().int().min(0).max(11).default(0),
    state: z.object({ switches: z.record(z.string(), z.boolean()).optional(), variables: z.record(z.string(), z.number()).optional(),
      selfSwitches: z.record(z.string(), z.boolean()).optional(), actors: z.array(z.number().int()).optional(),
      items: z.array(z.number().int()).optional() }).optional()
  }, async args => {
    preview.focus({ mapId: args.mapId });
    return picture({ ...args, scale: args.scale ?? (args.region ? 1 : await fitScale(args.mapId)) });
  });
  register("tile_info", "Probe a tile id BEFORE building composition-dependent structures. Returns its sheet, autotile kind and role; for A4/A3 the paired wall-top/wall-side base tile ids (the side carries the shadow, a lone top has none, and raw painting must stamp shadow bits z=4 value 10 right of side cells), and for B-E/A5 a multi-piece-composite warning.", { tileId: z.number().int().min(0).max(8191) }, async ({ tileId }) => textResult(tileInfo(tileId)));
  register("tile_palette", "Return a labeled PNG contact sheet of actual tiles, with their paintable IDs and flags. Autotile IDs use base shape; paint_tiles joins edges.", {
    mapId: mapIdSchema, sheet: z.enum(["A1", "A2", "A3", "A4", "A5", "B", "C", "D", "E"]),
    start: z.number().int().min(0).max(255).default(0), count: z.number().int().min(1).max(256).optional()
  }, async args => {
    const rendered = await capture.render({ ...args, mode: "palette" });
    const { map } = await project.read(args.mapId), tileset = await project.tileset(map);
    const metadata = { ...rendered, tiles: rendered.tiles.map(tile => ({ ...tile,
      ...tileDescription(project.Tilemap, tile.tileId, tileset.flags),
      tilesetName: tileset.tilesetNames[["A1", "A2", "A3", "A4", "A5", "B", "C", "D", "E"].indexOf(args.sheet)] || null
    })) };
    delete metadata.buffer;
    return { content: [...textResult(metadata).content, { type: "image", data: rendered.buffer.toString("base64"), mimeType: "image/png" }] };
  });
  register("tileset_catalog", "Inspect the active map tileset mode and the actual graphic assigned to each MZ sheet slot. Layers 0..3 are visual draw-order planes, not semantic ground/interior/dungeon categories.", {
    mapId: mapIdSchema
  }, async ({ mapId }) => textResult(await project.tilesetCatalog(mapId)));
  const sheetSchema = z.enum(["A1", "A2", "A3", "A4", "A5", "B", "C", "D", "E"]);
  const visualLayer = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
  const paintCell = z.union([
    xy.extend({ layer: visualLayer, tileId: z.number().int().min(0).max(8191), expectedSheet: sheetSchema.optional() }).strict(),
    xy.extend({ layer: z.literal(4), tileId: z.number().int().min(0).max(15) }).strict(),
    xy.extend({ layer: z.literal(5), tileId: z.number().int().min(0).max(255) }).strict()
  ]);
  const paintRectangle = z.union([
    regionSchema.extend({ layer: visualLayer, tileId: z.number().int().min(0).max(8191), expectedSheet: sheetSchema.optional() }).strict(),
    regionSchema.extend({ layer: z.literal(4), tileId: z.number().int().min(0).max(15) }).strict(),
    regionSchema.extend({ layer: z.literal(5), tileId: z.number().int().min(0).max(255) }).strict()
  ]);
  register("paint_tiles", "Paint cells or rectangles. Layers 0..3 are visual draw order, not ground/interior/dungeon categories. Every visual cell/rectangle with a non-zero tileId must include expectedSheet from tileset_catalog/tile_palette; mismatched tile IDs are rejected. tileId 0 clears the cell and must NOT carry expectedSheet (0 belongs to no sheet). Layers 4/5 use shadow/region values and omit expectedSheet. autoShadow (on by default) reconciles layer 4 to the editor convention: wall cells hold mask 0 and the first ground cell right of a wall holds mask 5 - masking the wall itself is what makes thick walls look striped. A layer 4 write that reconciliation would revert is refused; pass autoShadow:false to own the shadow layer. The result reports shadowCells: how many layer 4 cells the wall-shadow pass rewrote, including stale shadows it cleared after a wall was removed.", {
    ...editSchema, cells: z.array(paintCell).max(65536).default([]),
    rectangles: z.array(paintRectangle).max(1024).default([]),
    autoTile: z.boolean().default(true),
    autoShadow: z.boolean().default(true)
  }, async args => afterEdit(await project.paint(args.mapId, args.expectedRevision, { ...args, requireSheet: true }), args.screenshot), true);
  register("stamp_region", "Copy a rectangular layout from one map to another (or the same map), optionally including event copies; source revision also required.", {
    ...editSchema, sourceMapId: mapIdSchema, sourceRevision: z.string().regex(/^[a-f0-9]{64}$/), source: regionSchema,
    destination: xy, layers: z.array(z.number().int().min(0).max(5)).min(1).max(6).default([0, 1, 2, 3, 4, 5]),
    includeEvents: z.boolean().default(false), autoTile: z.boolean().default(true)
  }, async args => {
    const source = await project.read(args.sourceMapId);
    if (source.revision !== args.sourceRevision) throw new Error("Source revision conflict");
    if (source.map.tilesetId !== (await project.read(args.mapId)).map.tilesetId)
      throw new Error("Cannot stamp raw tile IDs between maps with different tilesets. Use the same tileset or explicitly map source tile IDs to destination tile IDs.");
    point(source.map, args.source.x, args.source.y); point(source.map, args.source.x + args.source.width - 1, args.source.y + args.source.height - 1);
    const result = await project.edit(args.mapId, args.expectedRevision, async map => {
      if ((await project.read(args.sourceMapId)).revision !== args.sourceRevision) throw new Error("Source changed during stamp");
      point(map, args.destination.x, args.destination.y); point(map, args.destination.x + args.source.width - 1, args.destination.y + args.source.height - 1);
      for (const z of args.layers) for (let y = 0; y < args.source.height; y++) for (let x = 0; x < args.source.width; x++)
        map.data[(z * map.height + args.destination.y + y) * map.width + args.destination.x + x] =
          source.map.data[(z * source.map.height + args.source.y + y) * source.map.width + args.source.x + x];
      if (args.includeEvents) for (const original of source.map.events.filter(Boolean)) {
        if (original.x < args.source.x || original.y < args.source.y || original.x >= args.source.x + args.source.width || original.y >= args.source.y + args.source.height) continue;
        let id = 1; while (map.events[id]) id++;
        map.events[id] = { ...structuredClone(original), id, x: original.x - args.source.x + args.destination.x, y: original.y - args.source.y + args.destination.y };
      }
      if (args.autoTile) retile(map, project.Tilemap, args.layers.filter(z => z < 4));
    }, "stamp");
    return afterEdit(result, args.screenshot);
  }, true);
  register("place_building", "Place a simple rectangular roof/facade building. Layers 0..3 are visual draw order; provide expectedRoofSheet and expectedWallSheet from tileset_catalog/tile_palette so mismatched tile IDs are rejected.", {
    ...editSchema, area: regionSchema, roofTileId: z.number().int().min(0).max(8191), wallTileId: z.number().int().min(0).max(8191),
    expectedRoofSheet: z.enum(["A1", "A2", "A3", "A4", "A5", "B", "C", "D", "E"]),
    expectedWallSheet: z.enum(["A1", "A2", "A3", "A4", "A5", "B", "C", "D", "E"]),
    roofRows: z.number().int().min(1).max(255), layer: z.number().int().min(0).max(3).default(1),
    clearUpperLayers: z.boolean().default(false)
  }, async args => {
    if (tileSheet(args.roofTileId) !== args.expectedRoofSheet)
      throw new Error(`roofTileId belongs to sheet ${tileSheet(args.roofTileId) || "none"}, not expectedRoofSheet ${args.expectedRoofSheet}`);
    if (tileSheet(args.wallTileId) !== args.expectedWallSheet)
      throw new Error(`wallTileId belongs to sheet ${tileSheet(args.wallTileId) || "none"}, not expectedWallSheet ${args.expectedWallSheet}`);
    const { map } = await project.read(args.mapId);
    const tileset = await project.tileset(map);
    const sheets = ["A1", "A2", "A3", "A4", "A5", "B", "C", "D", "E"];
    for (const [field, sheet] of [["expectedRoofSheet", args.expectedRoofSheet], ["expectedWallSheet", args.expectedWallSheet]]) {
      if (!tileset.tilesetNames[sheets.indexOf(sheet)])
        throw new Error(`The active tileset ${map.tilesetId} has no graphic assigned to ${field} ${sheet}`);
    }
    const result = await project.edit(args.mapId, args.expectedRevision, map => {
      point(map, args.area.x, args.area.y); point(map, args.area.x + args.area.width - 1, args.area.y + args.area.height - 1);
      if (args.roofRows >= args.area.height) throw new Error("roofRows must leave at least one facade row");
      validateTile(project.Tilemap, args.roofTileId); validateTile(project.Tilemap, args.wallTileId);
      for (let y = 0; y < args.area.height; y++) for (let x = 0; x < args.area.width; x++) {
        map.data[(args.layer * map.height + args.area.y + y) * map.width + args.area.x + x] = y < args.roofRows ? args.roofTileId : args.wallTileId;
        if (args.clearUpperLayers) for (let z = args.layer + 1; z < 4; z++) map.data[(z * map.height + args.area.y + y) * map.width + args.area.x + x] = 0;
      }
      retile(map, project.Tilemap, [args.layer]);
    }, "building");
    return afterEdit(result, args.screenshot);
  }, true);
  register("upsert_event", "Create/update a full MZ event or generate valid dialogue/transfer commands. Existing ID replaces the whole event; read it first to preserve pages.", {
    ...editSchema, eventId: z.number().int().min(1).max(9999).optional(), name: z.string().max(256).optional(),
    x: xy.shape.x, y: xy.shape.y, note: z.string().max(65536).default(""),
    text: z.string().max(65536).optional(), image: imageSchema.optional(), trigger: z.number().int().min(0).max(4).default(0),
    transfer: xy.extend({ mapId: mapIdSchema, direction: z.union([z.literal(0), directionSchema]).optional() }).optional(),
    pages: z.array(z.record(z.string(), z.unknown())).min(1).max(20).optional()
  }, async args => {
    let eventId;
    const result = await project.edit(args.mapId, args.expectedRevision, async map => {
      point(map, args.x, args.y);
      if (args.transfer) point((await project.read(args.transfer.mapId)).map, args.transfer.x, args.transfer.y);
      eventId = args.eventId || 1;
      if (!args.eventId) while (map.events[eventId]) eventId++;
      map.events[eventId] = makeEvent({ ...args, id: eventId });
    }, "event-upsert");
    return afterEdit({ ...result, eventId }, args.screenshot);
  }, true);
  register("delete_event", "Remove one event (backed up, reversible). Requires the map revision.", {
    ...editSchema, eventId: z.number().int().min(1).max(9999)
  }, async args => afterEdit(await project.edit(args.mapId, args.expectedRevision, map => {
    if (!map.events[args.eventId]) throw new Error("Event does not exist");
    map.events[args.eventId] = null;
  }, "event-delete"), args.screenshot), true);
  register("analyze_map", "Check static passage, transfers, autorun warnings, and optional path reachability. Not a substitute for playtesting.", {
    mapId: mapIdSchema, from: xy.optional(), to: xy.optional()
  }, async ({ mapId, from, to }) => {
    if (Boolean(from) !== Boolean(to)) throw new Error("from and to must be supplied together");
    return textResult(await analyze(project, mapId, from, to));
  });
  register("edit_history", "Read revision history and backup locations for the map.", { mapId: mapIdSchema },
    async ({ mapId }) => textResult(await project.historyFor(mapId)));
  register("undo_map_edit", "Restore the matching previous backup as a new revision, retaining backups of both states.", editSchema,
    async args => afterEdit(await project.undo(args.mapId, args.expectedRevision), args.screenshot), true);
  register("preview_focus", "Select map/cell in the live browser observation panel and return its private localhost URL.", {
    mapId: mapIdSchema, x: xy.shape.x.optional(), y: xy.shape.y.optional()
  }, async args => {
    const { map, revision } = await project.read(args.mapId);
    if (args.x !== undefined || args.y !== undefined) point(map, args.x, args.y);
    preview.focus(args);
    return textResult({ previewUrl: preview.previewUrl, revision });
  });
  register("runtime_status", "Inspect live MZ test-play sessions including player, events and scene. Requires --live-bridge and optional MZVisualBridge plugin.", {},
    async () => textResult({ enabled: liveBridge, sessions: runtime?.status() || [] }));
  register("playtest_start", "Start the complete MZ game in installed headless Chromium and connect safe runtime tools. Executes project game scripts in a browser, blocks external network, and does not modify project plugins.js.", {},
    async () => {
      if (!playtest) throw new Error("Start server with --live-bridge");
      try { return textResult(await playtest.start()); }
      catch (error) { await playtest.close(); throw error; }
    }, true);
  register("playtest_stop", "Close the browser game started by playtest_start; does not stop user-started native MZ test play.", {},
    async () => { await playtest?.close(); return textResult({ stopped: true }); }, true);
  register("native_playtest_start", "Start native desktop NW.js test play from a private copy of the licensed local runtime. Requires enabled MZVisualBridge. Keeps original installation permissions unchanged; returns sessionId for runtime tools.", {},
    async () => {
      if (!nativePlaytest) throw new Error("Start server with --live-bridge");
      return textResult(await nativePlaytest.start());
    }, true);
  register("native_playtest_stop", "Close only the native NW.js process tree started by native_playtest_start.", {},
    async () => { await nativePlaytest?.close(); return textResult({ stopped: true }); }, true);
  register("runtime_capture", "Return a PNG of the actual game engine framebuffer, including enabled project plugins and runtime effects.", {
    sessionId: z.string().regex(/^[a-f0-9]{32}$/)
  }, async ({ sessionId }) => {
    if (!runtime) throw new Error("Start server with --live-bridge and install the optional plugin");
    const result = await runtime.request(sessionId, "capture");
    if (!result?.png || !/^data:image\/png;base64,/.test(result.png)) throw new Error("Runtime did not return a PNG");
    const state = result.state;
    return { content: [...textResult(state).content, { type: "image", data: result.png.split(",")[1], mimeType: "image/png" }] };
  });
  register("runtime_control", "Control local test play: reload edited map, move player, teleport, interact, or change switch/variable. Never runs arbitrary JavaScript. Runtime only; does not save a game.", {
    sessionId: z.string().regex(/^[a-f0-9]{32}$/),
    action: z.enum(["start_new_game", "reload_map", "move", "teleport", "interact", "input", "set_switch", "set_variable"]),
    button: z.enum(["ok", "cancel", "up", "down", "left", "right", "pageup", "pagedown"]).optional(),
    direction: directionSchema.optional(), steps: z.number().int().min(1).max(30).optional(),
    mapId: mapIdSchema.optional(), x: xy.shape.x.optional(), y: xy.shape.y.optional(),
    id: z.number().int().min(1).max(9999).optional(), value: z.union([z.boolean(), z.number()]).optional()
  }, async args => {
    if (!runtime) throw new Error("Live bridge is not enabled");
    if (args.action === "input" && !args.button) throw new Error("input requires button");
    if (args.action === "move" && args.direction === undefined) throw new Error("move requires direction");
    if (args.action === "teleport") {
      if (!args.mapId || args.x === undefined || args.y === undefined) throw new Error("teleport requires mapId,x,y");
      point((await project.read(args.mapId)).map, args.x, args.y);
    }
    if (args.action === "set_switch" && (!args.id || typeof args.value !== "boolean")) throw new Error("set_switch needs id and boolean value");
    if (args.action === "set_variable" && (!args.id || typeof args.value !== "number")) throw new Error("set_variable needs id and numeric value");
    if (["set_switch", "set_variable"].includes(args.action)) {
      const system = await project.json("data/System.json");
      if (args.id >= (args.action === "set_switch" ? system.switches : system.variables).length) throw new Error("Switch/variable ID is outside project database");
    }
    return textResult(await runtime.request(args.sessionId, args.action, args));
  }, true);
  server.registerResource("project-summary", "rpgmz://project", { mimeType: "application/json" }, async uri => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ ...(await project.info()), maps: await project.maps() }) }]
  }));
  return { server, project, preview, capture, runtime, playtest, nativePlaytest,
    async close() { runtime?.close(); await server.close(); await nativePlaytest?.close(); await playtest?.close(); await capture.close(); await preview.close(); } };
}

async function main() {
  const { values } = parseArgs({ options: {
    project: { type: "string" }, engine: { type: "string" }, port: { type: "string", default: "0" },
    browser: { type: "string" }, "read-only": { type: "boolean", default: false }, "preview-only": { type: "boolean", default: false },
    "live-bridge": { type: "boolean", default: false }
  } });
  if (!values.project) throw new Error("Usage: node src/server.js --project <MZ project directory> [--engine <MZ installation>] [--port 0] [--browser <Chrome/Edge>] [--read-only] [--preview-only]");
  const port = integer(Number(values.port), "port", 0, 65535);
  const service = await createService({ projectPath: values.project, enginePath: values.engine, port, browserPath: values.browser,
    readOnly: values["read-only"], liveBridge: values["live-bridge"] });
  // stdout exclusively belongs to MCP JSON-RPC. Diagnostics/private preview address go to stderr.
  console.error(`MZ visual bridge ready: ${service.preview.previewUrl}`);
  if (!values["preview-only"]) {
    await service.server.connect(new StdioServerTransport());
    process.stdin.on("end", () => service.close().then(() => process.exit(0)));
  }
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => service.close().then(() => process.exit(0)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
