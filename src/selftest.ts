import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Project } from "./core/project.js";
import { LAYER_REGION, LAYER_SHADOW, addEvent, appendCommands, setTileAt } from "./core/map.js";
import { openRenderContext, renderMap } from "./render/renderer.js";

const projectDir = process.argv[2];
if (!projectDir) {
    console.error("usage: node dist/selftest.js <project-dir>");
    process.exit(1);
}

const project = new Project({ projectDir });
const context = openRenderContext();
const TILESET = 2;

// Reuse the map from an earlier run: `createMap` always allocates a new id, so
// without this the demo project grows a fresh MCP-SELFTEST every time it runs.
const created = {
    id:
        project.listMaps().find(map => map.name === "MCP-SELFTEST")?.id ??
        project.createMap({ name: "MCP-SELFTEST", width: 24, height: 16, tilesetId: TILESET }).id
};
const map = project.readMap(created.id);
// Tiles get repainted across the whole map, but events would pile up on a rerun.
map.events = [null];

// Ground: A2 autotile everywhere, then carve a water lake (A1) so autotile
// borders, a wall band (A4), a roof band (A3) and fixed tiles (B/C/D/E) overlap.
for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
        setTileAt(map, x, y, 0, 2816);
    }
}
for (let y = 6; y < 11; y++) {
    for (let x = 3; x < 9; x++) {
        setTileAt(map, x, y, 0, 2048);
    }
}
for (let x = 12; x < 20; x++) {
    setTileAt(map, x, 2, 0, 5888);
    setTileAt(map, x, 3, 0, 4352);
}
for (let x = 12; x < 20; x++) {
    setTileAt(map, x, 12, 1, 260);
    setTileAt(map, x, 13, 2, 520);
}
setTileAt(map, 20, 6, 1, 1536);
setTileAt(map, 21, 6, 1, 770);
// Impassable-marked tile on layer 1 to exercise the higher-tile (0x10) routing.
setTileAt(map, 10, 3, 1, 288);
setTileAt(map, 11, 3, 1, 288);

for (const [x, y, bits] of [[9, 6, 0x03], [9, 7, 0x0f], [10, 6, 0x01]] as const) {
    map.data[(LAYER_SHADOW * map.height + y) * map.width + x] = bits;
}
for (let y = 14; y < 16; y++) {
    for (let x = 0; x < 6; x++) {
        map.data[(LAYER_REGION * map.height + y) * map.width + x] = 7;
    }
}

const characterEvent = addEvent(map, { x: 2, y: 3, name: "NPC" }).event;
characterEvent.pages[0].image = { tileId: 0, characterName: "Actor1", direction: 8, pattern: 1, characterIndex: 0 };
appendCommands(characterEvent.pages[0], [
    { code: 101, indent: 0, parameters: ["Actor1", 0, 0, 0, "Reid"] },
    { code: 401, indent: 0, parameters: ["selftest line"] }
]);
const tileEvent = addEvent(map, { x: 22, y: 9 }).event;
tileEvent.pages[0].image = { tileId: 300, characterName: "", direction: 2, pattern: 0, characterIndex: 0 };
tileEvent.pages[0].priorityType = 2;
addEvent(map, { x: 5, y: 12, name: "Invisible" });

project.writeMap(created.id, map);

const outDir = join(projectDir, "..", "rpgmaker-mcp", "samples");
mkdirSync(outDir, { recursive: true });
const variants: { name: string; options: Parameters<typeof renderMap>[2] }[] = [
    { name: "plain", options: {} },
    { name: "passage", options: { overlay: "passage" } },
    { name: "region", options: { overlay: "region" } },
    { name: "no-events", options: { showEvents: false, animationFrame: 2 } }
];
for (const variant of variants) {
    const result = await renderMap(project, created.id, variant.options, context);
    const file = join(outDir, `map-${variant.name}.png`);
    writeFileSync(file, result.png);
    console.log(`${variant.name}: ${result.pixelWidth}x${result.pixelHeight} lower=${result.stats.lowerRects} upper=${result.stats.upperRects} skipped=${result.stats.skippedRects} engine=${result.stats.engine} -> ${file}`);
    for (const warning of result.warnings) {
        console.log(`   warn: ${warning}`);
    }
}
console.log(`test map id = ${created.id}`);
writeFileSync(join(outDir, "selftest-map-id.txt"), String(created.id));
