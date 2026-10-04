/**
 * Derive the editor's autotile edge rule from data instead of from memory.
 *
 * For every autotile cell in a corpus of maps (the installation's own sample
 * maps plus any project given on the command line), the eight neighbours on the
 * same layer are either the same autotile kind or not, which is a 8-bit mask. If
 * the editor is a consistent painter, mask -> shape is a function. This script
 * measures how true that is and writes the table the painting tools use.
 *
 *   node scripts/extract-autotile.mjs "<install>/data/corescript" [more map dirs...]
 *
 * Writes src/codebook/autotiles.json and prints the measured numbers.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTilemapStatics, resolveCoreScript } from "../dist/render/corescript.js";
import { pickVersion } from "../dist/render/corescript.js";

const here = resolve(fileURLToPath(import.meta.url), "..", "..");
const coreRoot = process.argv[2];
if (!coreRoot) {
    console.error("usage: node scripts/extract-autotile.mjs <corescript root> [map dir ...]");
    process.exit(1);
}
const core = resolveCoreScript(coreRoot);
const version = pickVersion(core, process.argv[3] && /^\d+\.\d/.test(process.argv[3]) ? process.argv[3] : undefined);
const Tilemap = loadTilemapStatics(core, version).Tilemap;

/** Neighbour order used for the mask bits. */
const OFFSETS = [
    [0, -1, "N"],
    [1, 0, "E"],
    [0, 1, "S"],
    [-1, 0, "W"],
    [1, -1, "NE"],
    [1, 1, "SE"],
    [-1, 1, "SW"],
    [-1, -1, "NW"]
];

const families = ["A1", "A2", "A3", "A4"];
const shapeCount = { A1: 48, A2: 48, A3: 48, A4: 48 };

/**
 * A diagonal neighbour only changes the shape when the two orthogonal ones
 * beside it are different too: the sheet has no piece for "the north is grass but
 * the north-east is not". Reducing the raw 8-bit mask this way is what makes the
 * relation between neighbours and shape small enough to be a table.
 */
const ORTHO = { N: 0, E: 1, S: 2, W: 3 };
const CORNERS = [
    ["NW", ORTHO.N, ORTHO.W],
    ["NE", ORTHO.N, ORTHO.E],
    ["SW", ORTHO.S, ORTHO.W],
    ["SE", ORTHO.S, ORTHO.E]
];
const CORNER_BIT = { NW: 7, NE: 4, SW: 6, SE: 5 };

function reduceMask(sameBits) {
    let mask = sameBits;
    for (const [corner, a, b] of CORNERS) {
        if ((sameBits & (1 << CORNER_BIT[corner])) === 0) {
            continue;
        }
        const edgesDiffer = ((mask >> a) & 1) === 1 && ((mask >> b) & 1) === 1;
        if (!edgesDiffer) {
            mask &= ~(1 << CORNER_BIT[corner]);
        }
    }
    return mask;
}


/** family -> mask -> Map(shape -> count), and family -> layer -> count */
const tables = new Map(families.map(family => [family, new Map()]));
const layers = new Map(families.map(family => [family, new Map()]));
const kindsSeen = new Map(families.map(family => [family, new Set()]));
let cells = 0;
let maps = 0;

function firstId(family) {
    return Tilemap[`TILE_ID_${family}`];
}
function familyOf(tileId) {
    for (const family of families) {
        if (Tilemap[`isTile${family}`](tileId)) {
            return family;
        }
    }
    return null;
}

function scanDir(dir, tilesetPattern = /^Map\d+\.json$/) {
    if (!existsSync(dir)) {
        console.warn(`  skipping ${dir}: not found`);
        return;
    }
    for (const file of readdirSync(dir).filter(name => tilesetPattern.test(name)).sort()) {
        const map = JSON.parse(readFileSync(join(dir, file), "utf8"));
        const { width, height, data } = map;
        if (!Array.isArray(data) || data.length !== width * height * 6) {
            console.warn(`  skipping ${file}: ${data?.length} ints for ${width}x${height}`);
            continue;
        }
        maps++;
        const at = (layer, x, y) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : data[(layer * height + y) * width + x]);
        for (let layer = 0; layer < 4; layer++) {
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const tileId = at(layer, x, y);
                    const family = familyOf(tileId);
                    if (!family) {
                        continue;
                    }
                    cells++;
                    const kind = Tilemap.getAutotileKind(tileId);
                    const shape = Tilemap.getAutotileShape(tileId);
                    kindsSeen.get(family).add(kind);
                    const byLayer = layers.get(family);
                    byLayer.set(layer, (byLayer.get(layer) ?? 0) + 1);
                    let mask = 0;
                    OFFSETS.forEach(([dx, dy, _], index) => {
                        const neighbour = at(layer, x + dx, y + dy);
                        if (neighbour > 0 && Tilemap.getAutotileKind(neighbour) === kind && Tilemap[`isTile${family}`](neighbour)) {
                            mask |= 1 << index;
                        }
                    });
                    const table = tables.get(family);
                    const key = reduceMask(mask);
                    if (!table.has(key)) {
                        table.set(key, new Map());
                    }
                    const counts = table.get(key);
                    counts.set(shape, (counts.get(shape) ?? 0) + 1);
                }
            }
        }
    }
}

scanDir(join(core.root, "..", "samplemaps"));
for (const dir of process.argv.slice(3)) {
    scanDir(resolve(dir), undefined);
    scanDir(join(resolve(dir), "data"));
}

console.log(`engine ${version}: scanned ${maps} maps, ${cells} autotile cells\n`);

const output = { comment: "mask -> autotile shape, measured from the installation's own maps", engine: version, bits: OFFSETS.map(o => o[2]), families: {} };
for (const family of families) {
    const table = tables.get(family);
    const layerVotes = [...layers.get(family).entries()].sort((a, b) => b[1] - a[1]);
    let observed = 0;
    let ambiguous = 0;
    let agreement = 0;
    const maskToShape = new Map();
    for (const [mask, counts] of table) {
        const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
        const [bestShape, bestCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
        observed += total;
        agreement += bestCount;
        if (counts.size > 1) {
            ambiguous++;
        }
        maskToShape.set(mask, bestShape);
    }
    const shapes = [...maskToShape.values()].sort((a, b) => a - b);
    console.log(
        `${family}: ${observed} cells, ${maskToShape.size} distinct masks, ${new Set(shapes).size} shapes used, ` +
            `${ambiguous} masks ambiguous, majority agreement ${(100 * agreement) / Math.max(1, observed)}%` +
            (layerVotes.length ? `, layers ${layerVotes.map(([l, n]) => `${l}:${n}`).join(" ")}` : "")
    );
    // How much of the corpus is explained by masks the data agrees on? Confident
    // entries are what a fill tool can use; the rest is hand-painted noise.
    const ranked = [...table.entries()]
        .map(([mask, counts]) => {
            const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
            const [bestShape, bestCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
            return { mask, total, shape: bestShape, rate: bestCount / total };
        })
        .sort((a, b) => b.total - a.total);
    const confident = ranked.filter(entry => entry.rate >= 0.97 && entry.total >= 30);
    const covered = confident.reduce((sum, entry) => sum + entry.total, 0);
    console.log(
        `   confident masks (>=97% agree, >=30 cells): ${confident.length} of ${ranked.length}, ` +
            `covering ${covered}/${observed} cells = ${(100 * covered) / Math.max(1, observed)}%`
    );
    const top = ranked.slice(0, 12).map(entry => `${entry.mask.toString(2).padStart(8, "0")}:${entry.shape}(n=${entry.total},${Math.round(entry.rate * 100)}%)`);
    console.log(`   busiest masks: ${top.join(" ")}`);
    output.families[family] = {
        firstTileId: firstId(family),
        shapeCount: shapeCount[family],
        layer: layerVotes[0]?.[0] ?? null,
        masks: Object.fromEntries([...maskToShape.entries()].sort((a, b) => a[0] - b[0]))
    };
}

const out = join(here, "src", "codebook", "autotiles.json");
writeFileSync(out, JSON.stringify(output, null, 1));
console.log(`\nwrote ${out}`);
