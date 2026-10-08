import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { loadTilemap, validateTile, retile, tileDescription, tileSheet, stampWallShadow } from "./engine.js";
import { diffMap } from "../preview/changes.js";

export const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const clone = value => structuredClone(value);
export const mapFile = id => `Map${String(id).padStart(3, "0")}.json`;
export function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be integer ${min}..${max}`);
  return value;
}
export function point(map, x, y) {
  integer(x, "x", 0, map.width - 1); integer(y, "y", 0, map.height - 1);
}

export class Project {
  static async open(root, engine, { readOnly = false } = {}) {
    const project = new Project();
    project.root = await fs.realpath(root);
    project.engine = engine;
    project.readOnly = readOnly;
    project.queue = Promise.resolve();
    project.listeners = new Set();
    project.history = [];
    project.journal = path.join(project.root, ".rpg-mcp");
    // Resolving each used file later also rejects links escaping the project.
    await project.file("data/System.json");
    await project.file("data/Tilesets.json");
    await project.file("data/MapInfos.json");
    project.systemRepair = await project.ensureSystemDefaults();
    const loaded = await loadTilemap(project.root, engine);
    project.Tilemap = loaded.Tilemap;
    project.tilemapSource = loaded.source;
    return project;
  }
  // Stock MZ 1.8.1 newdata projects omit System.json advanced.windowOpacity;
  // Window_Base.updateBackOpacity then crashes the title screen with
  // "Cannot read properties of undefined (reading 'clamp')" — a recurring trap
  // for projects assembled outside the native editor. Repair with a backup, or
  // in read-only mode fail with the exact remediation.
  async ensureSystemDefaults() {
    const file = await this.file("data/System.json");
    const system = JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
    if (Number.isFinite(system.advanced?.windowOpacity)) return null;
    if (this.readOnly)
      throw new Error('data/System.json is missing advanced.windowOpacity (a stock 1.8.1 newdata template omission). Window_Base.updateBackOpacity calls .clamp on it, so the title screen dies with "Cannot read properties of undefined (reading \'clamp\')". Add "advanced": { "windowOpacity": 192 } to data/System.json, or reopen the project without --read-only to let the MCP repair it.');
    await this.journalDirectory();
    const backup = path.join(this.journal, `open-${Date.now()}-System.json.bak`);
    await fs.writeFile(backup, JSON.stringify(system), { flag: "wx" });
    system.advanced = { ...system.advanced, windowOpacity: 192 };
    await fs.writeFile(file, JSON.stringify(system) + "\n");
    return { field: "advanced.windowOpacity", value: 192, backup };
  }
  async file(relative, allowMissing = false) {
    const resolved = path.resolve(this.root, relative);
    if (!resolved.startsWith(this.root + path.sep)) throw new Error("Path escapes project root");
    let real;
    try { real = await fs.realpath(resolved); }
    catch (e) {
      if (e.code !== "ENOENT" || !allowMissing) throw e;
      real = path.join(await fs.realpath(path.dirname(resolved)), path.basename(resolved));
    }
    if (!real.startsWith(this.root + path.sep)) throw new Error("Symlink escapes project root");
    return real;
  }
  async json(relative) { return JSON.parse((await fs.readFile(await this.file(relative), "utf8")).replace(/^\uFEFF/, "")); }
  async read(id) {
    integer(id, "mapId", 1, 999);
    const filename = await this.file(`data/${mapFile(id)}`);
    const bytes = await fs.readFile(filename);
    const map = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
    this.validate(map);
    return { map, revision: digest(bytes), filename };
  }
  validate(map) {
    integer(map.width, "map.width", 1, 256); integer(map.height, "map.height", 1, 256);
    if (!Array.isArray(map.data) || map.data.length !== map.width * map.height * 6) throw new Error("Map must contain six complete layers");
    if (!Array.isArray(map.events)) throw new Error("Map.events must be an array");
    for (const [id, event] of map.events.entries()) {
      if (!event) continue;
      if (id !== event.id) throw new Error(`Event ID/index mismatch: ${id}`);
      point(map, event.x, event.y);
      validateEvent(event);
    }
  }
  async info() {
    const system = await this.json("data/System.json");
    return { root: this.root, title: system.gameTitle, tileSize: system.tileSize || 48, readOnly: this.readOnly,
      catalogRevision: digest(await fs.readFile(await this.file("data/MapInfos.json"))),
      renderer: "local MZ Tilemap methods → Canvas 2D", nativeEditorSync: "save/close/reopen required",
      ...(this.systemRepair ? { systemRepair: this.systemRepair } : {}),
      warning: "Do not edit the same map in native MZ and MCP simultaneously. Custom plugins are not executed in design preview." };
  }
  async maps() {
    const infos = await this.json("data/MapInfos.json");
    return infos.filter(Boolean).map(({ id, name, parentId, order }) => ({ id, name, parentId, order }));
  }
  async createMap({ mapId, expectedCatalogRevision, name, parentId = 0, width, height, tilesetId }) {
    if (this.readOnly) throw new Error("Server is read-only");
    integer(mapId, "mapId", 1, 999); integer(width, "width", 1, 256); integer(height, "height", 1, 256);
    return this.lock(() => this.diskLock(async () => {
      const catalogFile = await this.file("data/MapInfos.json");
      const bytes = await fs.readFile(catalogFile);
      if (digest(bytes) !== expectedCatalogRevision) throw new Error("Map catalog revision conflict; read project_info again.");
      const catalog = JSON.parse(bytes);
      if (catalog[mapId]) throw new Error(`Map ${mapId} already exists`);
      if (parentId && !catalog[parentId]) throw new Error("Unknown parent map");
      const tilesets = await this.json("data/Tilesets.json");
      if (!tilesets[tilesetId]) throw new Error("Unknown tileset");
      const map = {
        autoplayBgm: false, autoplayBgs: false, battleback1Name: "", battleback2Name: "",
        bgm: { name: "", pan: 0, pitch: 100, volume: 90 }, bgs: { name: "", pan: 0, pitch: 100, volume: 90 },
        disableDashing: false, displayName: name, encounterList: [], encounterStep: 30, height, width,
        note: "", parallaxLoopX: false, parallaxLoopY: false, parallaxName: "", parallaxShow: true,
        parallaxSx: 0, parallaxSy: 0, scrollType: 0, specifyBattleback: false, tilesetId,
        data: Array(width * height * 6).fill(0), events: [null]
      };
      this.validate(map);
      const target = await this.file(`data/${mapFile(mapId)}`, true);
      const changeId = `${Date.now()}-${crypto.randomBytes(5).toString("hex")}`;
      const backup = path.join(this.journal, `${changeId}-MapInfos.json.bak`);
      await fs.writeFile(backup, bytes, { flag: "wx" });
      while (catalog.length <= mapId) catalog.push(null);
      catalog[mapId] = { id: mapId, expanded: true, name, order: Math.max(0, ...catalog.filter(Boolean).map(m => m.order)) + 1,
        parentId, scrollX: 0, scrollY: 0 };
      const mapBytes = Buffer.from(JSON.stringify(map) + "\n");
      await fs.writeFile(target, mapBytes, { flag: "wx" });
      const temp = `${catalogFile}.${changeId}.tmp`;
      try {
        await fs.writeFile(temp, JSON.stringify(catalog) + "\n", { flag: "wx" });
        if (digest(await fs.readFile(catalogFile)) !== expectedCatalogRevision) throw new Error("External catalog edit detected");
        await fs.rename(temp, catalogFile);
      } catch (e) {
        await fs.unlink(temp).catch(() => {});
        // Delete only our exclusively-created, unchanged map on failed creation.
        if (digest(await fs.readFile(target)) === digest(mapBytes)) await fs.unlink(target);
        throw e;
      }
      for (const listener of this.listeners) { try { listener({ type: "catalog", mapId }); } catch {} }
      return { mapId, revision: digest(mapBytes), changed: true, catalogRevision: digest(Buffer.from(JSON.stringify(catalog) + "\n")), backup };
    }));
  }
  async configureMap(mapId, revision, properties) {
    return this.edit(mapId, revision, async map => {
      if (properties.tilesetId && !(await this.json("data/Tilesets.json"))[properties.tilesetId]) throw new Error("Unknown tileset");
      const width = properties.width ?? map.width, height = properties.height ?? map.height;
      if (width !== map.width || height !== map.height) {
        if (map.events.filter(Boolean).some(e => e.x >= width || e.y >= height)) throw new Error("Resize would remove an event; move/delete it first.");
        const resized = Array(width * height * 6).fill(0);
        for (let z = 0; z < 6; z++) for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
          const value = map.data[(z * map.height + y) * map.width + x];
          if ((x >= width || y >= height) && value) throw new Error("Resize would discard nonempty cells.");
          if (x < width && y < height) resized[(z * height + y) * width + x] = value;
        }
        map.data = resized;
      }
      Object.assign(map, properties, { width, height });
    }, "map-configure");
  }
  async tileset(map) {
    const all = await this.json("data/Tilesets.json");
    if (!all[map.tilesetId]) throw new Error(`Missing tileset ${map.tilesetId}`);
    return all[map.tilesetId];
  }
  async tilesetCatalog(mapId) {
    const { map, revision } = await this.read(mapId);
    const tileset = await this.tileset(map);
    const sheets = ["A1", "A2", "A3", "A4", "A5", "B", "C", "D", "E"];
    const modeNames = ["world", "area", "interior", "dungeon"];
    return {
      mapId,
      mapName: (await this.maps()).find(item => item.id === mapId)?.name || "",
      revision,
      tilesetId: map.tilesetId,
      tilesetName: tileset.name || "",
      mode: tileset.mode,
      modeName: modeNames[tileset.mode] || "unknown",
      slots: sheets.map((sheet, index) => ({
        sheet,
        tilesetName: tileset.tilesetNames[index] || "",
        available: Boolean(tileset.tilesetNames[index])
      })),
      visualLayers: "Map data layers 0..3 are draw-order planes, not ground/interior/dungeon categories. Tile IDs select sheets in this map's active tileset.",
      specialLayers: { 4: "shadow mask 0..15", 5: "region ID 0..255" }
    };
  }
  async bundle(id) {
    const { map, revision } = await this.read(id);
    const tileset = await this.tileset(map);
    const system = await this.json("data/System.json");
    return { mapId: id, map, revision, tileset, tileSize: system.tileSize || 48 };
  }
  lock(fn) {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  async journalDirectory() {
    await fs.mkdir(this.journal, { recursive: true });
    if (await fs.realpath(this.journal) !== this.journal) throw new Error("Backup directory must not be a symlink");
  }
  async diskLock(fn) {
    await this.journalDirectory();
    const filename = await this.file(".rpg-mcp/write.lock", true);
    let handle;
    try { handle = await fs.open(filename, "wx"); }
    catch (e) { if (e.code === "EEXIST") throw new Error("Another MCP writer holds .rpg-mcp/write.lock. Run only one bridge per project."); throw e; }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, created: new Date().toISOString() }));
      return await fn();
    } finally {
      await handle.close();
      await fs.unlink(filename);
    }
  }
  async edit(id, expectedRevision, mutate, label = "edit", presentation = {}) {
    if (this.readOnly) throw new Error("Server is read-only");
    if (!expectedRevision) throw new Error("expectedRevision is required. Read/render the map first.");
    return this.lock(() => this.diskLock(async () => {
      const current = await this.read(id);
      if (expectedRevision !== current.revision) throw new Error("Revision conflict. Map changed; read/render again before editing.");
      const next = clone(current.map);
      await mutate(next);
      this.validate(next);
      for (let i = 0; i < next.width * next.height * 4; i++) validateTile(this.Tilemap, next.data[i]);
      for (let i = next.width * next.height * 4; i < next.width * next.height * 5; i++) integer(next.data[i], "shadow", 0, 15);
      for (let i = next.width * next.height * 5; i < next.data.length; i++) integer(next.data[i], "region", 0, 255);
      if (JSON.stringify(current.map) === JSON.stringify(next)) return { mapId: id, revision: current.revision, changed: false };
      const bytes = await fs.readFile(current.filename);
      if (digest(bytes) !== current.revision) throw new Error("External edit detected before backup");
      await this.journalDirectory();
      const changeId = `${Date.now()}-${crypto.randomBytes(5).toString("hex")}`;
      const backup = path.join(this.journal, `${changeId}-${mapFile(id)}.bak`);
      await fs.writeFile(backup, bytes, { flag: "wx" });
      const output = Buffer.from(JSON.stringify(next) + "\n");
      const temporary = `${current.filename}.${changeId}.tmp`;
      await fs.writeFile(temporary, output, { flag: "wx" });
      try {
        // Optimistic guard against external editors (not a shared native-editor lock).
        if (digest(await fs.readFile(current.filename)) !== current.revision) throw new Error("External edit detected; not overwriting");
        await fs.rename(temporary, current.filename);
      } catch (e) {
        await fs.unlink(temporary).catch(() => {});
        throw e;
      }
      const entry = { changeId, mapId: id, label, before: current.revision, after: digest(output), backup, timestamp: new Date().toISOString() };
      let journalWarning;
      try { await fs.appendFile(await this.file(".rpg-mcp/history.jsonl", true), JSON.stringify(entry) + "\n"); }
      catch (e) { journalWarning = `Map saved and backup exists, but history could not be recorded: ${e.message}`; }
      this.history.push(entry);
      const change = { type: "edit", mapId: id, beforeRevision: current.revision, revision: entry.after,
        changeId, label, timestamp: entry.timestamp, delta: diffMap(current.map, next), presentation: structuredClone(presentation) };
      for (const listener of this.listeners) { try { listener(change); } catch {} }
      return { mapId: id, revision: entry.after, changed: true, changeId, backup, ...(journalWarning ? { journalWarning } : {}) };
    }));
  }
  async undo(id, expectedRevision) {
    const records = await this.historyFor(id);
    const undone = new Set(records.filter(record => record.label.startsWith("undo:")).map(record => record.label.slice(5)));
    const entry = [...records].reverse().find(record =>
      record.after === expectedRevision && !record.label.startsWith("undo:") && !undone.has(record.changeId));
    if (!entry) throw new Error("No matching backup for this revision");
    const backupPath = await this.file(path.relative(this.root, entry.backup));
    const bytes = await fs.readFile(backupPath);
    if (digest(bytes) !== entry.before) throw new Error("Backup checksum mismatch");
    const old = JSON.parse(bytes);
    return this.edit(id, expectedRevision, map => {
      for (const key of Object.keys(map)) delete map[key];
      Object.assign(map, old);
    }, `undo:${entry.changeId}`);
  }
  async historyFor(id) {
    try {
      const data = await fs.readFile(await this.file(".rpg-mcp/history.jsonl"), "utf8");
      return data.trim().split("\n").filter(Boolean).map(JSON.parse).filter(item => item.mapId === id);
    } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  }
  async paint(id, revision, { cells = [], rectangles = [], autoTile = true, autoShadow = true, requireSheet = false, presentation = {}, label = "paint" }) {
    if (cells.length + rectangles.length === 0) throw new Error("No paint operations");
    let shadowCells = 0;
    const result = await this.edit(id, revision, async map => {
      const tileset = await this.tileset(map);
      const layers = new Set();
      const shadowWrites = new Map();
      const put = ({ x, y, layer, tileId, expectedSheet }) => {
        point(map, x, y); integer(layer, "layer", 0, 5);
        if (layer < 4) {
          validateTile(this.Tilemap, tileId); layers.add(layer);
          // tileId 0 means "no tile": it belongs to no sheet, so clearing a cell
          // must not require a sheet claim and must not accept a false one.
          if (tileId === 0 && expectedSheet)
            throw new Error(`expectedSheet does not apply to tileId 0 (clearing layer ${layer} at ${x},${y})`);
          if (requireSheet && !expectedSheet && tileId !== 0)
            throw new Error(`expectedSheet is required for visual layer ${layer}; inspect tileset_catalog and tile_palette first`);
          if (expectedSheet && tileSheet(tileId) !== expectedSheet)
            throw new Error(`Tile ${tileId} belongs to sheet ${tileSheet(tileId) || "none"}, not expectedSheet ${expectedSheet}`);
          if (expectedSheet) {
            const sheetIndex = ["A1", "A2", "A3", "A4", "A5", "B", "C", "D", "E"].indexOf(expectedSheet);
            if (!tileset.tilesetNames[sheetIndex])
              throw new Error(`The active tileset ${map.tilesetId} has no graphic assigned to sheet ${expectedSheet}`);
          }
        } else {
          if (expectedSheet) throw new Error(`expectedSheet only applies to visual layers 0..3, not layer ${layer}`);
          integer(tileId, "value", 0, layer === 4 ? 15 : 255);
          if (layer === 4) shadowWrites.set((4 * map.height + y) * map.width + x, tileId);
        }
        map.data[(layer * map.height + y) * map.width + x] = tileId;
      };
      for (const cell of cells) put(cell);
      for (const rect of rectangles) {
        integer(rect.width, "width", 1, map.width); integer(rect.height, "height", 1, map.height);
        point(map, rect.x, rect.y); point(map, rect.x + rect.width - 1, rect.y + rect.height - 1);
        for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) put({ ...rect, x, y });
      }
      if (autoTile) retile(map, this.Tilemap, [...layers]);
      if (autoShadow) {
        shadowCells = stampWallShadow(map, this.Tilemap);
        // A layer 4 write that the reconcile pass immediately reverts is a silent
        // no-op, which is how masked wall cells reached real maps. Say so instead.
        for (const [cell, value] of shadowWrites) if (map.data[cell] !== value) {
          const x = cell % map.width, y = ((cell / map.width) | 0) - 4 * map.height;
          throw new Error(`Layer 4 mask ${value} at ${x},${y} conflicts with the wall shadow the editor convention produces there (mask ${map.data[cell]}), so autoShadow would erase it in the same call. Drop that layer 4 write, or pass autoShadow:false to own the whole shadow layer yourself.`);
        }
      }
    }, label, presentation);
    // The shadow pass rewrites layer 4 even when the caller only touched visual
    // layers, so say how many cells it changed instead of hiding it.
    return { ...result, shadowCells };
  }
  async inspect(id, x, y) {
    const { map, revision } = await this.read(id);
    point(map, x, y);
    const tileset = await this.tileset(map);
    return { mapId: id, revision, x, y,
      layers: [0, 1, 2, 3].map(z => ({ layer: z, ...tileDescription(this.Tilemap, map.data[(z * map.height + y) * map.width + x], tileset.flags) })),
      shadow: map.data[(4 * map.height + y) * map.width + x],
      region: map.data[(5 * map.height + y) * map.width + x],
      events: map.events.filter(event => event && event.x === x && event.y === y) };
  }
}

export function emptyPage() {
  return {
    conditions: { actorId: 1, actorValid: false, itemId: 1, itemValid: false, selfSwitchCh: "A", selfSwitchValid: false,
      switch1Id: 1, switch1Valid: false, switch2Id: 1, switch2Valid: false, variableId: 1, variableValid: false, variableValue: 0 },
    directionFix: false,
    image: { characterIndex: 0, characterName: "", direction: 2, pattern: 1, tileId: 0 },
    list: [{ code: 0, indent: 0, parameters: [] }],
    moveFrequency: 3, moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 3, moveType: 0, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: true
  };
}
export function makeEvent({ id, name, x, y, note = "", pages, text, transfer, image, trigger = 0 }) {
  const event = { id, name: name || `EV${String(id).padStart(3, "0")}`, x, y, note };
  if (pages) {
    // pages replaces the whole page, so the generated-command inputs below would vanish.
    const dropped = [transfer && "transfer", text !== undefined && "text", image && "image"].filter(Boolean);
    if (dropped.length) throw new Error(`pages cannot be combined with ${dropped.join(", ")}: pages replaces the command list, so ${dropped.length > 1 ? "those inputs" : "that input"} would be silently dropped. Send pages alone, or omit pages and let the tool generate the commands.`);
    event.pages = pages;
  } else {
    const page = emptyPage();
    page.trigger = trigger;
    if (image) Object.assign(page.image, image);
    const commands = [];
    if (text !== undefined) {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i += 4) {
        commands.push({ code: 101, indent: 0, parameters: ["", 0, 0, 2, ""] });
        for (const line of lines.slice(i, i + 4)) commands.push({ code: 401, indent: 0, parameters: [line] });
      }
    }
    if (transfer) {
      integer(transfer.mapId, "transfer.mapId", 1, 999);
      integer(transfer.x, "transfer.x", 0, 255); integer(transfer.y, "transfer.y", 0, 255);
      if (![0, 2, 4, 6, 8].includes(transfer.direction ?? 2)) throw new Error("Invalid transfer direction");
      commands.push({ code: 201, indent: 0, parameters: [0, transfer.mapId, transfer.x, transfer.y, transfer.direction ?? 2, 0] });
    }
    page.list = [...commands, { code: 0, indent: 0, parameters: [] }];
    event.pages = [page];
  }
  validateEvent(event);
  return event;
}
export function validateEvent(event) {
  integer(event.id, "event.id", 1, 9999);
  if (!Array.isArray(event.pages) || !event.pages.length || event.pages.length > 20) throw new Error("Event needs 1..20 pages");
  for (const [index, page] of event.pages.entries()) {
    const at = `event ${event.id} page ${index}`;
    if (!page.conditions || !page.image || !page.moveRoute || !Array.isArray(page.moveRoute.list))
      throw new Error(`${at} is missing required MZ fields (conditions, image, moveRoute.list)`);
    integer(page.trigger, `${at}.trigger`, 0, 4); integer(page.priorityType, `${at}.priorityType`, 0, 2);
    integer(page.image.characterIndex, `${at}.image.characterIndex`, 0, 7); integer(page.image.pattern, `${at}.image.pattern`, 0, 2);
    integer(page.image.tileId, `${at}.image.tileId`, 0, 1023);
    if (typeof page.image.characterName !== "string") throw new Error(`${at}.image.characterName must be a string (use "" for none)`);
    if (![2, 4, 6, 8].includes(page.image.direction)) throw new Error(`${at}.image.direction must be 2, 4, 6 or 8`);
    if (page.image.characterName && !/^[^/\\:\0]+$/.test(page.image.characterName)) throw new Error(`${at}.image.characterName is not a valid asset name`);
    if (!Array.isArray(page.list) || page.list.length > 10000 || page.list.at(-1)?.code !== 0) throw new Error(`${at}.list must be an array of commands ending with code 0`);
    for (const [position, command] of page.list.entries()) {
      integer(command.code, `${at}.list[${position}].code`, 0, 999); integer(command.indent, `${at}.list[${position}].indent`, 0, 100);
      if (!Array.isArray(command.parameters)) throw new Error(`${at}.list[${position}].parameters must be an array`);
    }
  }
}
