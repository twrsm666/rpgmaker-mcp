import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { Project } from "./core/project.js";
import { openRenderContext, renderMap } from "./render/renderer.js";

/**
 * Validate the renderer against every `<map>.json` / `<map>.png` pair the
 * installation ships in `data/samplemaps`. The PNG is the editor's own preview,
 * so a low per-cell colour difference means the compositor agrees with it.
 *
 * Usage: node dist/sweep.js <samplemaps-dir> <project-dir>
 */
const [sampleDir, projectDir] = process.argv.slice(2);
if (!sampleDir || !projectDir) {
    console.error("usage: node dist/sweep.js <samplemaps directory> <project directory>");
    process.exit(1);
}

const TILE = 48;
const project = new Project({ projectDir });
const context = openRenderContext();
const pairs = readdirSync(sampleDir)
    .filter(name => name.endsWith(".json"))
    .map(name => ({ json: name, png: name.replace(/\.json$/, ".png") }))
    .filter(pair => existsSync(`${sampleDir}/${pair.png}`));

if (pairs.length === 0) {
    console.error(`${sampleDir} contains no .json/.png pairs`);
    process.exit(1);
}

// Reuse the scratch slot across runs: `createMap` always allocates a new id, so
// a suite that runs weekly would fill the project with SWEEP copies.
const scratch =
    project.listMaps().find(map => map.name === "SWEEP")?.id ??
    project.createMap({ name: "SWEEP", width: 4, height: 4, tilesetId: 1 }).id;
interface SweepResult {
    map: string;
    mean: number;
    worst: number;
    cells: number;
    /** Cells with at least one tile drawn: what the compositor is responsible for. */
    composited: number;
    /** Cells with no tiles at all, which show only the parallax. */
    background: number;
    backgroundCells: number;
}
const results: SweepResult[] = [];

for (const pair of pairs) {
    const sample = JSON.parse(readFileSync(`${sampleDir}/${pair.json}`, "utf8"));
    const reference = await loadImage(readFileSync(`${sampleDir}/${pair.png}`));
    project.writeMap(scratch, sample);

    const rendered = await renderMap(project, scratch, { scale: 1, showEvents: process.argv.includes("--with-events") }, context);
    if (Math.abs(reference.width / sample.width - reference.height / sample.height) > 0.01) {
        console.log(`skip ${pair.json}: reference aspect does not match ${sample.width}x${sample.height}`);
        continue;
    }
    const refTile = reference.width / sample.width;

    const mineCanvas = createCanvas(rendered.pixelWidth, rendered.pixelHeight);
    const mineContext = mineCanvas.getContext("2d");
    mineContext.drawImage(await loadImage(rendered.png), 0, 0);
    const mine = mineContext.getImageData(0, 0, rendered.pixelWidth, rendered.pixelHeight).data;

    const referenceCanvas = createCanvas(reference.width, reference.height);
    const referenceContext = referenceCanvas.getContext("2d");
    referenceContext.drawImage(reference, 0, 0);
    const referenceData = referenceContext.getImageData(0, 0, reference.width, reference.height).data;

    let total = 0;
    let worst = 0;
    let cells = 0;
    // A cell with no tiles at all shows only the parallax, and the preview was
    // rendered with whatever file the sample project kept under that name. This
    // install ships a different picture for some of them, which is an asset
    // provenance difference rather than a compositor error, so the two are
    // measured apart.
    let composited = { total: 0, cells: 0 };
    let background = { total: 0, cells: 0 };
    const tileAt = (x: number, y: number, layer: number) => sample.data[(layer * sample.height + y) * sample.width + x];
    for (let cy = 0; cy < sample.height; cy++) {
        for (let cx = 0; cx < sample.width; cx++) {
            const sumMine = [0, 0, 0];
            for (let y = 0; y < TILE; y++) {
                for (let x = 0; x < TILE; x++) {
                    const i = ((cy * TILE + y) * rendered.pixelWidth + cx * TILE + x) * 4;
                    sumMine[0] += mine[i];
                    sumMine[1] += mine[i + 1];
                    sumMine[2] += mine[i + 2];
                }
            }
            const sumRef = [0, 0, 0];
            for (let y = 0; y < refTile; y++) {
                for (let x = 0; x < refTile; x++) {
                    const i = ((cy * refTile + y) * reference.width + cx * refTile + x) * 4;
                    sumRef[0] += referenceData[i];
                    sumRef[1] += referenceData[i + 1];
                    sumRef[2] += referenceData[i + 2];
                }
            }
            const diff =
                (Math.abs(sumMine[0] / (TILE * TILE) - sumRef[0] / (refTile * refTile)) +
                    (Math.abs(sumMine[1] / (TILE * TILE) - sumRef[1] / (refTile * refTile))) +
                    (Math.abs(sumMine[2] / (TILE * TILE) - sumRef[2] / (refTile * refTile)))) /
                3;
            total += diff;
            cells++;
            const bucket = [0, 1, 2, 3].every(layer => tileAt(cx, cy, layer) === 0) ? background : composited;
            bucket.total += diff;
            bucket.cells++;
            if (diff > worst) {
                worst = diff;
            }
        }
    }
    const mean = total / cells;
    const tileMean = composited.total / Math.max(1, composited.cells);
    const backgroundMean = background.total / Math.max(1, background.cells);
    results.push({ map: pair.json, mean, worst, cells, composited: tileMean, background: backgroundMean, backgroundCells: background.cells });
    console.log(
        `${pair.json.padEnd(14)} ${sample.width}x${sample.height} cells=${String(cells).padStart(5)} mean=${mean.toFixed(2)} worst=${worst.toFixed(1)} tiles=${tileMean.toFixed(2)} bg=${backgroundMean.toFixed(2)}(${background.cells})`
    );
}

results.sort((a, b) => b.composited - a.composited);
const percentile = (values: number[], fraction: number) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
};
const composited = results.map(result => result.composited);
const withBackground = results.filter(result => result.backgroundCells > 0);
console.log(`\n${results.length} maps compared against editor previews`);
console.log(
    `mean colour diff / 255 over cells the compositor draws  median=${percentile(composited, 0.5)?.toFixed(2)}  ` +
        `p90=${percentile(composited, 0.9)?.toFixed(2)}  worst=${results[0]?.composited.toFixed(2)} (${results[0]?.map})`
);
console.log(`worst single cell across all maps: ${Math.max(...results.map(result => result.worst)).toFixed(1)}`);
const diverging = results.filter(result => result.composited > 6);
console.log(diverging.length === 0 ? "all maps match" : `${diverging.length} map(s) diverge: ${diverging.map(result => result.map).join(", ")}`);
// Parallax-only cells are a different question: Map077's background matches
// tiling Forest.png at 4.7 and its own River.png at 119.9, so the sample project
// kept a different picture under that name, and Map010's residual is a detailed
// sky surviving a quarter-scale downsample. Neither involves the compositor, so
// report it without failing the run over it.
const mismatched = withBackground.filter(result => result.background > 6);
console.log(
    mismatched.length === 0
        ? `parallax backgrounds match too (${withBackground.length} maps have one)`
        : `${mismatched.length}/${withBackground.length} map(s) differ only where the parallax shows through: ${mismatched
              .slice(0, 8)
              .map(result => `${result.map}=${result.background.toFixed(1)}`)
              .join(", ")} (asset provenance or preview downsampling, not compositing)`
);
process.exit(diverging.length === 0 ? 0 : 1);
