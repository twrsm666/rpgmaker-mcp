import { createCanvas, loadImage, type Canvas, type SKRSContext2D, type Image } from "@napi-rs/canvas";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "../core/project.js";
import { DIR, LAYER_REGION, LAYER_SHADOW, TILE_SIZE, inBounds, passageBitForDirection, regionId, terrainTag, tileAt, type Command } from "../core/map.js";
import { loadTilemapStatics, pickVersion, resolveCoreScript, type TilemapStatics } from "./corescript.js";

export type Overlay = "none" | "passage" | "region" | "terrain" | "shadow";

export interface RenderOptions {
    scale?: number;
    overlay?: Overlay;
    showEvents?: boolean;
    showGrid?: boolean;
    /** 0..3, matching `Tilemap.animationFrame` so water can be frozen on a frame. */
    animationFrame?: number;
    /** Restrict the tile layers drawn, e.g. [2, 3] to see only the upper layers. */
    onlyLayers?: number[];
    /** Draw `map.parallaxName` behind the tiles (default true). */
    showParallax?: boolean;
}

interface Rect {
    set: number;
    sx: number;
    sy: number;
    dx: number;
    dy: number;
    w: number;
    h: number;
}

export interface RenderResult {
    png: Uint8Array;
    canvas: Canvas;
    pixelWidth: number;
    pixelHeight: number;
    stats: {
        lowerRects: number;
        upperRects: number;
        skippedRects: number;
        engine: string;
        tilesetId: number;
        mapSize: [number, number];
    };
    warnings: string[];
}

/**
 * Port of `Tilemap.prototype._addSpot` and friends. Every branch here mirrors
 * the engine implementation so the exported PNG matches what the editor and the
 * running game composite.
 */
class TileRectBuilder {
    lower: Rect[] = [];
    upper: Rect[] = [];
    private readonly tile = TILE_SIZE;
    private readonly flags: number[];
    private readonly Tilemap: any;
    private readonly frame: number;
    private readonly onlyLayers: number[] | null;

    constructor(statics: TilemapStatics, flags: number[], frame: number, onlyLayers: number[] | null) {
        this.Tilemap = statics.Tilemap;
        this.flags = flags;
        this.frame = frame;
        this.onlyLayers = onlyLayers;
    }

    read(map: any, x: number, y: number, z: number): number {
        if (this.onlyLayers && !this.onlyLayers.includes(z)) {
            return 0;
        }
        if (x < 0 || x >= map.width || y < 0 || y >= map.height) {
            return 0;
        }
        return map.data[(z * map.height + y) * map.width + x] || 0;
    }

    build(map: any): void {
        for (let y = 0; y < map.height; y++) {
            for (let x = 0; x < map.width; x++) {
                this.addSpot(map, x, y);
            }
        }
    }

    private addSpot(map: any, mx: number, my: number): void {
        const dx = mx * this.tile;
        const dy = my * this.tile;
        const tileId0 = this.read(map, mx, my, 0);
        const tileId1 = this.read(map, mx, my, 1);
        const tileId2 = this.read(map, mx, my, 2);
        const tileId3 = this.read(map, mx, my, 3);
        const shadowBits = this.read(map, mx, my, LAYER_SHADOW);
        const upperTileId1 = this.read(map, mx, my - 1, 1);

        this.addSpotTile(tileId0, dx, dy);
        this.addSpotTile(tileId1, dx, dy);
        this.addShadow(shadowBits, dx, dy);
        if (this.isTableTile(upperTileId1) && !this.isTableTile(tileId1)) {
            if (!this.Tilemap.isShadowingTile(tileId0)) {
                this.addTableEdge(upperTileId1, dx, dy);
            }
        }
        // The base engine returns false for every tile: `_isOverpassPosition`.
        this.addSpotTile(tileId2, dx, dy);
        this.addSpotTile(tileId3, dx, dy);
    }

    private addSpotTile(tileId: number, dx: number, dy: number): void {
        if (this.isHigherTile(tileId)) {
            this.addTile(this.upper, tileId, dx, dy);
        } else {
            this.addTile(this.lower, tileId, dx, dy);
        }
    }

    private isHigherTile(tileId: number): boolean {
        return ((this.flags[tileId] ?? 0) & 0x10) !== 0;
    }

    private isTableTile(tileId: number): boolean {
        return this.Tilemap.isTileA2(tileId) && ((this.flags[tileId] ?? 0) & 0x80) !== 0;
    }

    private addTile(layer: Rect[], tileId: number, dx: number, dy: number): void {
        if (!this.Tilemap.isVisibleTile(tileId)) {
            return;
        }
        if (this.Tilemap.isAutotile(tileId)) {
            this.addAutotile(layer, tileId, dx, dy);
        } else {
            this.addNormalTile(layer, tileId, dx, dy);
        }
    }

    private addNormalTile(layer: Rect[], tileId: number, dx: number, dy: number): void {
        const setNumber = this.Tilemap.isTileA5(tileId) ? 4 : 5 + Math.floor(tileId / 256);
        const w = this.tile;
        const h = this.tile;
        const sx = ((Math.floor(tileId / 128) % 2) * 8 + (tileId % 8)) * w;
        const sy = (Math.floor((tileId % 256) / 8) % 16) * h;
        layer.push({ set: setNumber, sx, sy, dx, dy, w, h });
    }

    private addAutotile(layer: Rect[], tileId: number, dx: number, dy: number): void {
        const Tilemap = this.Tilemap;
        const kind = Tilemap.getAutotileKind(tileId);
        const shape = Tilemap.getAutotileShape(tileId);
        const tx = kind % 8;
        const ty = Math.floor(kind / 8);
        let setNumber = 0;
        let bx = 0;
        let by = 0;
        let autotileTable = Tilemap.FLOOR_AUTOTILE_TABLE;
        let isTable = false;

        if (Tilemap.isTileA1(tileId)) {
            const waterSurfaceIndex = [0, 1, 2, 1][this.frame % 4];
            setNumber = 0;
            if (kind === 0) {
                bx = waterSurfaceIndex * 2;
                by = 0;
            } else if (kind === 1) {
                bx = waterSurfaceIndex * 2;
                by = 3;
            } else if (kind === 2) {
                bx = 6;
                by = 0;
            } else if (kind === 3) {
                bx = 6;
                by = 3;
            } else {
                bx = Math.floor(tx / 4) * 8;
                by = ty * 6 + (Math.floor(tx / 2) % 2) * 3;
                if (kind % 2 === 0) {
                    bx += waterSurfaceIndex * 2;
                } else {
                    bx += 6;
                    autotileTable = Tilemap.WATERFALL_AUTOTILE_TABLE;
                    by += this.frame % 3;
                }
            }
        } else if (Tilemap.isTileA2(tileId)) {
            setNumber = 1;
            bx = tx * 2;
            by = (ty - 2) * 3;
            isTable = this.isTableTile(tileId);
        } else if (Tilemap.isTileA3(tileId)) {
            setNumber = 2;
            bx = tx * 2;
            by = (ty - 6) * 2;
            autotileTable = Tilemap.WALL_AUTOTILE_TABLE;
        } else if (Tilemap.isTileA4(tileId)) {
            setNumber = 3;
            bx = tx * 2;
            by = Math.floor((ty - 10) * 2.5 + (ty % 2 === 1 ? 0.5 : 0));
            if (ty % 2 === 1) {
                autotileTable = Tilemap.WALL_AUTOTILE_TABLE;
            }
        }

        const table = autotileTable[shape];
        if (!table) {
            return;
        }
        const w1 = this.tile / 2;
        const h1 = this.tile / 2;
        for (let i = 0; i < 4; i++) {
            const qsx = table[i][0];
            const qsy = table[i][1];
            const sx1 = (bx * 2 + qsx) * w1;
            const sy1 = (by * 2 + qsy) * h1;
            const dx1 = dx + (i % 2) * w1;
            const dy1 = dy + Math.floor(i / 2) * h1;
            if (isTable && (qsy === 1 || qsy === 5)) {
                const qsx2 = qsy === 1 ? (4 - qsx) % 4 : qsx;
                const qsy2 = 3;
                const sx2 = (bx * 2 + qsx2) * w1;
                const sy2 = (by * 2 + qsy2) * h1;
                layer.push({ set: setNumber, sx: sx2, sy: sy2, dx: dx1, dy: dy1, w: w1, h: h1 });
                layer.push({ set: setNumber, sx: sx1, sy: sy1, dx: dx1, dy: dy1 + h1 / 2, w: w1, h: h1 / 2 });
            } else {
                layer.push({ set: setNumber, sx: sx1, sy: sy1, dx: dx1, dy: dy1, w: w1, h: h1 });
            }
        }
    }

    private addTableEdge(tileId: number, dx: number, dy: number): void {
        if (!this.Tilemap.isTileA2(tileId)) {
            return;
        }
        const Tilemap = this.Tilemap;
        const autotileTable = Tilemap.FLOOR_AUTOTILE_TABLE;
        const kind = Tilemap.getAutotileKind(tileId);
        const shape = Tilemap.getAutotileShape(tileId);
        const tx = kind % 8;
        const ty = Math.floor(kind / 8);
        const setNumber = 1;
        const bx = tx * 2;
        const by = (ty - 2) * 3;
        const table = autotileTable[shape];
        if (!table) {
            return;
        }
        const w1 = this.tile / 2;
        const h1 = this.tile / 2;
        for (let i = 0; i < 2; i++) {
            const qsx = table[2 + i][0];
            const qsy = table[2 + i][1];
            const sx1 = (bx * 2 + qsx) * w1;
            const sy1 = (by * 2 + qsy) * h1 + h1 / 2;
            const dx1 = dx + (i % 2) * w1;
            const dy1 = dy + Math.floor(i / 2) * h1;
            this.lower.push({ set: setNumber, sx: sx1, sy: sy1, dx: dx1, dy: dy1, w: w1, h: h1 / 2 });
        }
    }

    /** `textureId < 0` in the engine shader is a flat 50% black quad. */
    private addShadow(shadowBits: number, dx: number, dy: number): void {
        if (!(shadowBits & 0x0f)) {
            return;
        }
        const w1 = this.tile / 2;
        const h1 = this.tile / 2;
        for (let i = 0; i < 4; i++) {
            if (shadowBits & (1 << i)) {
                const dx1 = dx + (i % 2) * w1;
                const dy1 = dy + Math.floor(i / 2) * h1;
                this.lower.push({ set: -1, sx: 0, sy: 0, dx: dx1, dy: dy1, w: w1, h: h1 });
            }
        }
    }
}

interface TilesetImages {
    images: (Image | null)[];
    warnings: string[];
}

async function loadTilesetImages(project: Project, tileset: any): Promise<TilesetImages> {
    const images: (Image | null)[] = [];
    const warnings: string[] = [];
    const names: string[] = tileset.tilesetNames ?? [];
    for (const name of names) {
        if (!name) {
            images.push(null);
            continue;
        }
        const path = join(project.dir, "img", "tilesets", `${name}.png`);
        if (!existsSync(path)) {
            warnings.push(`Tileset image missing: img/tilesets/${name}.png`);
            images.push(null);
            continue;
        }
        try {
            images.push(await loadImage(readFileSync(path)));
        } catch (error) {
            warnings.push(`Tileset image unreadable: ${name} (${String(error)})`);
            images.push(null);
        }
    }
    return { images, warnings };
}

/**
 * MZ marks character sheets with a leading run of `!` and `$`: `!` means "object
 * character" (no shadow) and `$` means one big character filling the sheet. Both
 * stay part of the file name on disk, so only the layout depends on them.
 * See ImageManager.isBigCharacter and Sprite_Character.patternWidth.
 */
export function characterLayout(name: string) {
    const signs = /^[!$]+/.exec(name)?.[0] ?? "";
    const big = signs.includes("$");
    return {
        big,
        objectCharacter: signs.includes("!"),
        columns: big ? 3 : 12,
        rows: big ? 4 : 8
    };
}

async function loadCharacterImage(project: Project, name: string): Promise<Image | null> {
    const path = join(project.dir, "img", "characters", `${name}.png`);
    if (!existsSync(path)) {
        return null;
    }
    try {
        return await loadImage(readFileSync(path));
    } catch {
        return null;
    }
}

function drawRects(ctx: SKRSContext2D, rects: Rect[], images: (Image | null)[], scale: number): number {
    let skipped = 0;
    for (const rect of rects) {
        const dx = rect.dx * scale;
        const dy = rect.dy * scale;
        const w = rect.w * scale;
        const h = rect.h * scale;
        if (rect.set < 0) {
            ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
            ctx.fillRect(dx, dy, w, h);
            continue;
        }
        const image = images[rect.set];
        if (!image) {
            skipped++;
            continue;
        }
        ctx.drawImage(image, rect.sx, rect.sy, rect.w, rect.h, dx, dy, w, h);
    }
    return skipped;
}

function overlayCell(ctx: SKRSContext2D, x: number, y: number, scale: number, style: string): void {
    ctx.fillStyle = style;
    ctx.fillRect(x * TILE_SIZE * scale, y * TILE_SIZE * scale, TILE_SIZE * scale, TILE_SIZE * scale);
}

function drawPassageOverlay(ctx: SKRSContext2D, map: any, flags: number[], scale: number): void {
    const tile = TILE_SIZE * scale;
    ctx.strokeStyle = "rgba(255, 60, 60, 0.95)";
    ctx.lineWidth = Math.max(2, Math.round(3 * scale));
    for (let y = 0; y < map.height; y++) {
        for (let x = 0; x < map.width; x++) {
            const tiles: number[] = [];
            for (let z = 3; z >= 0; z--) {
                tiles.push(map.data[(z * map.height + y) * map.width + x] || 0);
            }
            let blockedCount = 0;
            for (const direction of [DIR.DOWN, DIR.LEFT, DIR.UP, DIR.RIGHT]) {
                const bit = passageBitForDirection(direction);
                let blocked = false;
                for (const tileId of tiles) {
                    const flag = flags[tileId] ?? 0;
                    if (flag & 0x10) {
                        continue;
                    }
                    if ((flag & bit) === 0) {
                        break;
                    }
                    if ((flag & bit) === bit) {
                        blocked = true;
                        break;
                    }
                }
                if (!blocked) {
                    continue;
                }
                blockedCount++;
                const px = x * tile;
                const py = y * tile;
                ctx.beginPath();
                if (direction === DIR.DOWN) {
                    ctx.moveTo(px, py + tile);
                    ctx.lineTo(px + tile, py + tile);
                } else if (direction === DIR.UP) {
                    ctx.moveTo(px, py);
                    ctx.lineTo(px + tile, py);
                } else if (direction === DIR.LEFT) {
                    ctx.moveTo(px, py);
                    ctx.lineTo(px, py + tile);
                } else {
                    ctx.moveTo(px + tile, py);
                    ctx.lineTo(px + tile, py + tile);
                }
                ctx.stroke();
            }
            if (blockedCount === 4) {
                overlayCell(ctx, x, y, scale, "rgba(255, 0, 0, 0.35)");
            }
        }
    }
}

function drawRegionOverlay(ctx: SKRSContext2D, map: any, scale: number): void {
    const tile = TILE_SIZE * scale;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${Math.round(20 * scale)}px sans-serif`;
    for (let y = 0; y < map.height; y++) {
        for (let x = 0; x < map.width; x++) {
            const region = map.data[(LAYER_REGION * map.height + y) * map.width + x] || 0;
            if (region <= 0) {
                continue;
            }
            overlayCell(ctx, x, y, scale, "rgba(80, 120, 255, 0.28)");
            ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
            ctx.fillText(String(region), x * tile + tile / 2, y * tile + tile / 2);
        }
    }
}

function drawTerrainOverlay(ctx: SKRSContext2D, map: any, flags: number[], scale: number): void {
    const tile = TILE_SIZE * scale;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${Math.round(18 * scale)}px sans-serif`;
    for (let y = 0; y < map.height; y++) {
        for (let x = 0; x < map.width; x++) {
            let tag = 0;
            for (let z = 3; z >= 0; z--) {
                const tileId = map.data[(z * map.height + y) * map.width + x] || 0;
                tag = (flags[tileId] ?? 0) >> 12;
                if (tag > 0) {
                    break;
                }
            }
            if (tag <= 0) {
                continue;
            }
            ctx.fillStyle = "rgba(255, 220, 0, 0.9)";
            ctx.fillText(String(tag), x * tile + tile / 2, y * tile + tile / 2);
        }
    }
}

async function drawEvents(ctx: SKRSContext2D, project: Project, map: any, statics: TilemapStatics, scale: number, warnings: string[]): Promise<void> {
    const tile = TILE_SIZE * scale;
    const colors = ["#4fd1c5", "#f6ad55", "#f687b3"];
    const Tilemap = statics.Tilemap;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    for (const event of map.events) {
        if (!event) {
            continue;
        }
        const page = event.pages?.[0];
        if (!page) {
            continue;
        }
        const image = page.image ?? {};
        const x = event.x * tile;
        const y = event.y * tile;
        let drawn = false;
        if (image.tileId > 0 && !Tilemap.isAutotile(image.tileId)) {
            ctx.strokeStyle = colors[page.priorityType] ?? colors[0];
            ctx.lineWidth = Math.max(1, Math.round(scale));
            ctx.strokeRect(x + 2, y + 2, tile - 4, tile - 4);
            ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
            ctx.fillRect(x + 2, y + tile - Math.round(16 * scale), Math.round(30 * scale), Math.round(14 * scale));
            ctx.fillStyle = "#ffffff";
            ctx.font = `${Math.round(11 * scale)}px sans-serif`;
            ctx.fillText(`T${image.tileId}`, x + 4, y + tile - Math.round(15 * scale));
            drawn = true;
        }
        if (image.characterName) {
            const bitmap = await loadCharacterImage(project, image.characterName);
            if (!bitmap) {
                warnings.push(`Event ${event.id} character missing: img/characters/${image.characterName}.png`);
            } else {
                const layout = characterLayout(image.characterName);
                const pw = bitmap.width / layout.columns;
                const ph = bitmap.height / layout.rows;
                const blockX = layout.big ? 0 : (image.characterIndex % 4) * 3;
                const blockY = layout.big ? 0 : Math.floor(image.characterIndex / 4) * 4;
                const sx = (blockX + image.pattern) * pw;
                const sy = (blockY + (image.direction - 2) / 2) * ph;
                const drawW = pw * scale;
                const drawH = ph * scale;
                ctx.drawImage(bitmap, sx, sy, pw, ph, x + (tile - drawW) / 2, y + tile - drawH, drawW, drawH);
                drawn = true;
            }
        }
        if (!drawn) {
            ctx.fillStyle = "rgba(79, 209, 197, 0.25)";
            ctx.fillRect(x + Math.round(6 * scale), y + Math.round(6 * scale), tile - Math.round(12 * scale), tile - Math.round(12 * scale));
            ctx.strokeStyle = colors[page.priorityType] ?? colors[0];
            ctx.lineWidth = Math.max(1, Math.round(scale));
            ctx.strokeRect(x + Math.round(6 * scale), y + Math.round(6 * scale), tile - Math.round(12 * scale), tile - Math.round(12 * scale));
        }
        ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
        ctx.fillRect(x, y, Math.min(tile, Math.round((6 + String(event.id).length * 7) * scale)), Math.round(14 * scale));
        ctx.fillStyle = "#ffffff";
        ctx.font = `bold ${Math.round(11 * scale)}px sans-serif`;
        ctx.fillText(`EV${event.id}`, x + Math.round(2 * scale), y + Math.round(1 * scale));
    }
}

function drawGrid(ctx: SKRSContext2D, map: any, scale: number): void {
    const tile = TILE_SIZE * scale;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= map.width; x++) {
        ctx.beginPath();
        ctx.moveTo(x * tile, 0);
        ctx.lineTo(x * tile, map.height * tile);
        ctx.stroke();
    }
    for (let y = 0; y <= map.height; y++) {
        ctx.beginPath();
        ctx.moveTo(0, y * tile);
        ctx.lineTo(map.width * tile, y * tile);
        ctx.stroke();
    }
}

async function loadParallaxImage(project: Project, name: string): Promise<Image | null> {
    const path = join(project.dir, "img", "parallaxes", `${name}.png`);
    if (!existsSync(path)) {
        return null;
    }
    try {
        return await loadImage(readFileSync(path));
    } catch {
        return null;
    }
}

/**
 * The engine draws the parallax as a `TilingSprite` whose origin is
 * `parallaxOx % bitmap.width`. A whole-map preview has no camera, so the map
 * origin stands in for it and the image is tiled across the canvas.
 */
async function drawParallax(ctx: SKRSContext2D, project: Project, map: any, scale: number, warnings: string[]): Promise<void> {
    if (!map.parallaxShow || !map.parallaxName) {
        return;
    }
    const image = await loadParallaxImage(project, map.parallaxName);
    if (!image) {
        warnings.push(`Parallax image missing: img/parallaxes/${map.parallaxName}.png`);
        return;
    }
    const width = map.width * TILE_SIZE * scale;
    const height = map.height * TILE_SIZE * scale;
    const iw = image.width * scale;
    const ih = image.height * scale;
    const normalize = (offset: number, size: number) => ((offset % size) + size) % size;
    const ox = normalize(map.parallaxSx * scale, iw);
    const oy = normalize(map.parallaxSy * scale, ih);
    for (let y = -oy; y < height; y += ih) {
        for (let x = -ox; x < width; x += iw) {
            ctx.drawImage(image, x, y, iw, ih);
        }
    }
}

export interface RenderContext {
    statics: TilemapStatics;
}

export function openRenderContext(options: { corescriptRoot?: string; engineVersion?: string } = {}): RenderContext {
    const core = resolveCoreScript(options.corescriptRoot);
    const version = pickVersion(core, options.engineVersion);
    return { statics: loadTilemapStatics(core, version) };
}

export async function renderMap(project: Project, mapId: number, options: RenderOptions = {}, context?: RenderContext): Promise<RenderResult> {
    const ctx = context ?? openRenderContext();
    const map = project.readMap(mapId);
    const tilesets: any[] = project.readData("Tilesets");
    const tileset = tilesets[map.tilesetId];
    const warnings: string[] = [];
    if (!tileset) {
        warnings.push(`Map ${mapId} references tileset ${map.tilesetId}, which does not exist`);
    }
    const flags: number[] = tileset?.flags ?? new Array(8192).fill(0);
    const { images, warnings: imageWarnings } = await loadTilesetImages(project, tileset ?? { tilesetNames: [] });
    warnings.push(...imageWarnings);

    const scale = options.scale ?? 1;
    const builder = new TileRectBuilder(ctx.statics, flags, options.animationFrame ?? 0, options.onlyLayers ?? null);
    builder.build(map);

    const canvas = createCanvas(map.width * TILE_SIZE * scale, map.height * TILE_SIZE * scale);
    const g = canvas.getContext("2d");
    g.imageSmoothingEnabled = false;
    if (options.showParallax !== false) {
        await drawParallax(g, project, map, scale, warnings);
    }
    const skipped = drawRects(g, [...builder.lower, ...builder.upper], images, scale);

    if (options.showGrid) {
        drawGrid(g, map, scale);
    }
    if (options.showEvents !== false) {
        await drawEvents(g, project, map, ctx.statics, scale, warnings);
    }
    const overlay = options.overlay ?? "none";
    if (overlay === "passage") {
        drawPassageOverlay(g, map, flags, scale);
    } else if (overlay === "region") {
        drawRegionOverlay(g, map, scale);
    } else if (overlay === "terrain") {
        drawTerrainOverlay(g, map, flags, scale);
    }

    const png = new Uint8Array(canvas.toBuffer("image/png"));
    return {
        png,
        canvas,
        pixelWidth: canvas.width,
        pixelHeight: canvas.height,
        stats: {
            lowerRects: builder.lower.length,
            upperRects: builder.upper.length,
            skippedRects: skipped,
            engine: ctx.statics.version,
            tilesetId: map.tilesetId,
            mapSize: [map.width, map.height]
        },
        warnings
    };
}

/** Tile ids a caller can actually place, grouped by tileset slot. */
export function listPlacableTiles(project: Project, tilesetId: number, statics: TilemapStatics): { slot: string; name: string; firstId: number; count: number }[] {
    const tilesets: any[] = project.readData("Tilesets");
    const tileset = tilesets[tilesetId];
    if (!tileset) {
        throw new Error(`Tileset ${tilesetId} does not exist`);
    }
    const ranges = statics.Tilemap;
    const slots: { slot: string; firstId: number; count: number }[] = [
        { slot: "A1", firstId: ranges.TILE_ID_A1, count: 768 },
        { slot: "A2", firstId: ranges.TILE_ID_A2, count: 1536 },
        { slot: "A3", firstId: ranges.TILE_ID_A3, count: 1536 },
        { slot: "A4", firstId: ranges.TILE_ID_A4, count: 2304 },
        { slot: "A5", firstId: ranges.TILE_ID_A5, count: 48 },
        { slot: "B", firstId: ranges.TILE_ID_B, count: 256 },
        { slot: "C", firstId: ranges.TILE_ID_C, count: 256 },
        { slot: "D", firstId: ranges.TILE_ID_D, count: 256 },
        { slot: "E", firstId: ranges.TILE_ID_E, count: 256 }
    ];
    return slots.map((entry, index) => ({
        slot: entry.slot,
        name: tileset.tilesetNames[index] ?? "",
        firstId: entry.firstId,
        count: entry.count
    }));
}

export function describeCell(project: Project, mapId: number, x: number, y: number, statics: TilemapStatics): any {
    const map = project.readMap(mapId);
    if (!inBounds(map, x, y)) {
        throw new Error(`(${x},${y}) is outside map ${mapId} (${map.width}x${map.height})`);
    }
    const tilesets: any[] = project.readData("Tilesets");
    const flags: number[] = tilesets[map.tilesetId]?.flags ?? [];
    const layers = [0, 1, 2, 3].map(z => ({
        layer: z,
        tileId: tileAt(map, x, y, z),
        kind: kindOfTile(tileAt(map, x, y, z), statics),
        passable: [DIR.DOWN, DIR.LEFT, DIR.UP, DIR.RIGHT].filter(direction => {
            const bit = passageBitForDirection(direction);
            const flag = flags[tileAt(map, x, y, z)] ?? 0;
            if (flag & 0x10) {
                return true;
            }
            return (flag & bit) === 0;
        }).length === 4
    }));
    const event = map.events.find((item: any) => item && item.x === x && item.y === y) ?? null;
    return {
        mapId,
        x,
        y,
        regionId: regionId(map, x, y),
        terrainTag: terrainTag(map, flags, x, y),
        shadowBits: tileAt(map, x, y, LAYER_SHADOW),
        layers,
        event: event ? { id: event.id, name: event.name, pages: event.pages.length } : null
    };
}

function kindOfTile(tileId: number, statics: TilemapStatics): string {
    const Tilemap = statics.Tilemap;
    if (tileId <= 0) {
        return "empty";
    }
    if (Tilemap.isTileA1(tileId)) {
        return "A1";
    }
    if (Tilemap.isTileA2(tileId)) {
        return "A2";
    }
    if (Tilemap.isTileA3(tileId)) {
        return "A3";
    }
    if (Tilemap.isTileA4(tileId)) {
        return "A4";
    }
    if (Tilemap.isTileA5(tileId)) {
        return "A5";
    }
    return ["B", "C", "D", "E"][Math.floor(tileId / 256)] ?? "?";
}

export function commandListForCell(project: Project, mapId: number, x: number, y: number): Command[] {
    const map = project.readMap(mapId);
    const event = map.events.find((item: any) => item && item.x === x && item.y === y);
    if (!event) {
        throw new Error(`No event at (${x},${y}) on map ${mapId}`);
    }
    return event.pages[0].list;
}

