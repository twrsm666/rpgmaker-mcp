/**
 * Paint each candidate tile id as a 3x3 block (so an autotile resolves to its
 * own centre shape), render it, and report the server's own passability verdict.
 * This is how a tile id gets recognised without the editor.
 *
 *   node scripts/tile-sheet.mjs            # sheets for the tilesets listed below
 *   node scripts/tile-sheet.mjs --keep     # leave the scratch maps in place
 */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withRegisteredServer } from "./mcp-client.mjs";

const here = resolve(fileURLToPath(import.meta.url), "..", "..");
const keep = process.argv.includes("--keep");

/** Ids the engine's own sample maps lean on, per tileset. */
const SHEETS = {
    3: { tag: "inside", ids: [1552, 1563, 1564, 2816, 2862, 3246, 4064, 4084, 4110, 4158, 6784, 6798, 6880, 6881, 7234, 7240, 7552, 7906, 7912] },
    4: { tag: "dungeon", ids: [1536, 1538, 1556, 1560, 2240, 3556, 3564, 4016, 6990, 6992, 7024, 7025, 7378, 7384, 2816, 2832, 3008, 7712, 7520] }
};

withRegisteredServer(async call => {
    for (const [tilesetId, spec] of Object.entries(SHEETS)) {
        const columns = 4;
        const blocks = spec.ids.length;
        const rowsNeeded = Math.ceil(blocks / columns);
        const width = columns * 4;
        const height = rowsNeeded * 4;
        const map = await call("create_map", { name: `LR SHEET ${tilesetId}`, width, height, tilesetId: Number(tilesetId), parentId: 1 });
        const cells = [];
        const where = [];
        spec.ids.forEach((tileId, index) => {
            const bx = (index % columns) * 4;
            const by = Math.floor(index / columns) * 4;
            where.push({ tileId, x: bx + 1, y: by + 1 });
            for (let dy = 0; dy < 3; dy++) {
                for (let dx = 0; dx < 3; dx++) {
                    cells.push({ x: bx + dx, y: by + dy, layer: 0, tileId });
                }
            }
        });
        await call("set_tiles", { mapId: map.id, cells });
        const file = join(here, "samples", "lightrun", `${spec.tag}-sheet.png`);
        await call("render_map", { mapId: map.id, scale: 1, showEvents: false, saveTo: file });
        await call("render_map", { mapId: map.id, scale: 1, showEvents: false, overlay: "passage", saveTo: join(here, "samples", "lightrun", `${spec.tag}-passage.png`) });
        const verdict = [];
        for (const spot of where) {
            const cell = await call("inspect_cell", { mapId: map.id, x: spot.x, y: spot.y });
            const layer = cell.layers[0];
            verdict.push(`${spot.tileId}:${layer.kind}/${layer.passable ? "open" : "BLOCKED"}`);
        }
        console.log(`tileset ${tilesetId} map ${map.id} (${width}x${height}) -> ${file}`);
        for (let row = 0; row < rowsNeeded; row++) {
            console.log(`   ${verdict.slice(row * columns, row * columns + columns).join("   ")}`);
        }
    }
    if (!keep) {
        const history = await call("write_history", { limit: 200 });
        const undone = await call("undo_writes", { steps: Math.min(50, history.listed) });
        console.log("undone", (undone.next ?? []).join(" "));
        console.log("maps now:", (await call("list_maps")).maps.map(map => map.name).join(" | "));
    }
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
