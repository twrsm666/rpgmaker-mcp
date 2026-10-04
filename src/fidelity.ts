import { readFileSync } from "node:fs";
import { loadImage } from "@napi-rs/canvas";
import { createCanvas } from "@napi-rs/canvas";
import { Project } from "./core/project.js";
import { openRenderContext, renderMap } from "./render/renderer.js";

/**
 * Fidelity check against a reference PNG the editor produced for the same map
 * (RPG Maker MZ ships `data/samplemaps/MapNNN.png` previews next to the sample
 * maps). Compares each cell's average colour rather than raw pixels: the
 * reference is a downscaled preview, so its exact resampling filter is unknown,
 * while per-cell averages isolate whether the *content* matches.
 *
 * Usage: node dist/fidelity.js <project-dir> <map.json> <reference.png> [mapId]
 */
const [projectDir, mapPath, referencePath, mapIdArg] = process.argv.slice(2);
if (!projectDir || !mapPath || !referencePath) {
    console.error("usage: node dist/fidelity.js <project-dir> <map.json> <reference.png> [imported-map-id]");
    process.exit(1);
}

const project = new Project({ projectDir });
const context = openRenderContext();
const sample = JSON.parse(readFileSync(mapPath, "utf8"));

const existingId = mapIdArg && /^\d+$/.test(mapIdArg) ? Number(mapIdArg) : undefined;
const mapId = existingId ?? project.createMap({ name: "FIDELITY", width: sample.width, height: sample.height, tilesetId: sample.tilesetId }).id;
if (!existingId) {
    project.writeMap(mapId, sample);
}

const withEvents = process.argv.includes("--with-events");
const rendered = await renderMap(project, mapId, { scale: 1, showEvents: withEvents }, context);
const reference = await loadImage(readFileSync(referencePath));

const TILE = 48;
const mineCanvas = createCanvas(rendered.pixelWidth, rendered.pixelHeight);
mineCanvas.getContext("2d").drawImage(await loadImage(rendered.png), 0, 0);
const mine = mineCanvas.getContext("2d").getImageData(0, 0, rendered.pixelWidth, rendered.pixelHeight).data;

const referenceCanvas = createCanvas(reference.width, reference.height);
referenceCanvas.getContext("2d").drawImage(reference, 0, 0);
const referenceData = referenceCanvas.getContext("2d").getImageData(0, 0, reference.width, reference.height).data;

const referenceTile = reference.width / sample.width;
if (Math.abs(referenceTile - Math.round(referenceTile)) > 0.01) {
    console.error(`Reference ${reference.width}x${reference.height} is not a whole number of pixels per tile for a ${sample.width}x${sample.height} map`);
    process.exit(1);
}

let total = 0;
let cells = 0;
let worst = { diff: 0, x: 0, y: 0 };
for (let cy = 0; cy < sample.height; cy++) {
    for (let cx = 0; cx < sample.width; cx++) {
        let mineSum = [0, 0, 0];
        for (let y = 0; y < TILE; y++) {
            for (let x = 0; x < TILE; x++) {
                const i = ((cy * TILE + y) * rendered.pixelWidth + cx * TILE + x) * 4;
                mineSum = [mineSum[0] + mine[i], mineSum[1] + mine[i + 1], mineSum[2] + mine[i + 2]];
            }
        }
        let refSum = [0, 0, 0];
        for (let y = 0; y < referenceTile; y++) {
            for (let x = 0; x < referenceTile; x++) {
                const i = ((cy * referenceTile + y) * reference.width + cx * referenceTile + x) * 4;
                refSum = [refSum[0] + referenceData[i], refSum[1] + referenceData[i + 1], refSum[2] + referenceData[i + 2]];
            }
        }
        const area = TILE * TILE;
        const small = referenceTile * referenceTile;
        const diff =
            (Math.abs(mineSum[0] / area - refSum[0] / small) +
                Math.abs(mineSum[1] / area - refSum[1] / small) +
                Math.abs(mineSum[2] / area - refSum[2] / small)) /
            3;
        total += diff;
        cells++;
        if (diff > worst.diff) {
            worst = { diff, x: cx, y: cy };
        }
    }
}

const mean = total / cells;
console.log(`map ${mapId} vs ${referencePath}`);
console.log(`cells=${cells} mean per-cell colour diff=${mean.toFixed(2)} / 255, worst=(${worst.x},${worst.y}) ${worst.diff.toFixed(2)}`);
console.log(`warnings: ${rendered.warnings.length ? rendered.warnings.join("; ") : "none"}`);
if (mean > 6) {
    console.log("RESULT: renderer diverges from the editor preview");
    process.exit(1);
}
console.log("RESULT: renderer matches the editor preview");
