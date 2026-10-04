import type { Project } from "./project.js";

/**
 * Layer meanings, taken from the shipped engine (rmmz_core.js
 * `Tilemap.prototype._addSpot` and rmmz_objects.js `Game_Map`):
 *   0..3  tile layers, composited in that order
 *   4     shadow bits, 0x0f per quadrant, never a tile id
 *   5     region id, read by `Game_Map.prototype.regionId`
 */
export const LAYER_TILE_MIN = 0;
export const LAYER_TILE_MAX = 3;
export const LAYER_SHADOW = 4;
export const LAYER_REGION = 5;
export const LAYER_COUNT = 6;

export const TILE_SIZE = 48;

export const FLAG_PASSAGE_BITS = [0x01, 0x02, 0x04, 0x08];
export const FLAG_NO_PASSAGE_EFFECT = 0x10;
export const FLAG_LADDER = 0x20;
export const FLAG_BUSH = 0x40;
export const FLAG_COUNTER = 0x80;
export const FLAG_DAMAGE_FLOOR = 0x100;
export const FLAG_BOAT_OK = 0x200;
export const FLAG_SHIP_OK = 0x400;
export const FLAG_AIRSHIP_OK = 0x800;
export const FLAG_TERRAIN_SHIFT = 12;

/**
 * RPG Maker direction codes are keypad numbers: 2 down, 4 left, 6 right, 8 up,
 * and the diagonals 1/3/7/9. `Game_Map.checkPassage` is called with
 * `1 << (dir / 2 - 1)`, so 2->0x01, 4->0x02, 6->0x04, 8->0x08 — which is why the
 * passage bits in a tileset are listed Down, Left, Right, Up.
 */
export const DIR = { DOWN: 2, LEFT: 4, RIGHT: 6, UP: 8 } as const;

export const DIRS_FOUR = [DIR.DOWN, DIR.LEFT, DIR.RIGHT, DIR.UP];

export function dataIndex(map: { width: number; height: number }, x: number, y: number, z: number): number {
    return (z * map.height + y) * map.width + x;
}

export function inBounds(map: { width: number; height: number }, x: number, y: number): boolean {
    return x >= 0 && x < map.width && y >= 0 && y < map.height;
}

export function tileAt(map: any, x: number, y: number, z: number): number {
    if (!inBounds(map, x, y)) {
        return 0;
    }
    return map.data[dataIndex(map, x, y, z)] || 0;
}

export function setTileAt(map: any, x: number, y: number, z: number, tileId: number): void {
    if (!inBounds(map, x, y)) {
        throw new Error(`Tile (${x},${y}) is outside the ${map.width}x${map.height} map`);
    }
    if (z < 0 || z >= LAYER_COUNT) {
        throw new Error(`Layer must be 0..${LAYER_COUNT - 1}, got ${z}`);
    }
    if (!Number.isInteger(tileId) || tileId < 0 || tileId >= 8192) {
        throw new Error(`Tile id must be an integer 0..8191, got ${tileId}`);
    }
    if (z === LAYER_SHADOW && tileId > 0x0f) {
        throw new Error(`Shadow layer stores bit flags 0..15, got ${tileId}`);
    }
    map.data[dataIndex(map, x, y, z)] = tileId;
}

/**
 * Port of `Tilemap.isTileA1`..`isTileA5` boundaries. Kept here only to
 * classify a tile id for callers; the renderer uses the real constants loaded
 * from the engine.
 */
export type TileKind = "empty" | "B" | "C" | "D" | "E" | "A5" | "A1" | "A2" | "A3" | "A4";

export function classifyTileId(tileId: number, ranges: Record<string, number>): TileKind {
    if (tileId <= 0) {
        return "empty";
    }
    if (tileId >= ranges.A1) {
        if (tileId < ranges.A2) {
            return "A1";
        }
        if (tileId < ranges.A3) {
            return "A2";
        }
        if (tileId < ranges.A4) {
            return "A3";
        }
        return "A4";
    }
    if (tileId >= ranges.A5) {
        return "A5";
    }
    const index = Math.floor(tileId / 256);
    const letters = ["B", "C", "D", "E"] as const;
    return index >= 0 && index < 4 ? letters[index] : "empty";
}

export function flagsOf(project: Project, tilesetId: number): number[] {
    const tilesets: any[] = project.readData("Tilesets");
    const tileset = tilesets[tilesetId];
    if (!tileset) {
        throw new Error(`Tileset ${tilesetId} does not exist`);
    }
    return tileset.flags;
}

/**
 * Port of `Game_Map.prototype.checkPassage`: event tile ids take precedence,
 * then layers 3 down to 0, and any tile flagged 0x10 is skipped entirely.
 */
export function checkPassage(map: any, flags: number[], x: number, y: number, bit: number, eventTileIds: number[] = []): boolean {
    const tiles = [...eventTileIds];
    for (let i = 0; i < 4; i++) {
        tiles.push(tileAt(map, x, y, 3 - i));
    }
    for (const tile of tiles) {
        const flag = flags[tile] ?? 0;
        if ((flag & FLAG_NO_PASSAGE_EFFECT) !== 0) {
            continue;
        }
        if ((flag & bit) === 0) {
            return true;
        }
        if ((flag & bit) === bit) {
            return false;
        }
    }
    return false;
}

export function passageBitForDirection(direction: number): number {
    if (![DIR.DOWN, DIR.LEFT, DIR.RIGHT, DIR.UP].includes(direction as any)) {
        throw new Error(
            `Direction must be an RPG Maker keypad code (2 down, 4 left, 6 right, 8 up), got ${direction}. ` +
                "Passage bits 0x01/0x02/0x04/0x08 are Down/Left/Right/Up."
        );
    }
    return (1 << (direction / 2 - 1)) & 0x0f;
}

export function isPassable(map: any, flags: number[], x: number, y: number, direction: number, eventTileIds: number[] = []): boolean {
    if (!inBounds(map, x, y)) {
        return false;
    }
    return checkPassage(map, flags, x, y, passageBitForDirection(direction), eventTileIds);
}

export function terrainTag(map: any, flags: number[], x: number, y: number): number {
    for (let i = 0; i < 4; i++) {
        const tile = tileAt(map, x, y, 3 - i);
        const tag = (flags[tile] ?? 0) >> FLAG_TERRAIN_SHIFT;
        if (tag > 0) {
            return tag;
        }
    }
    return 0;
}

export function regionId(map: any, x: number, y: number): number {
    return tileAt(map, x, y, LAYER_REGION);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export function blankPage(): any {
    return {
        conditions: {
            actorId: 1,
            actorValid: false,
            itemId: 1,
            itemValid: false,
            selfSwitchCh: "A",
            selfSwitchValid: false,
            switch1Id: 1,
            switch1Valid: false,
            switch2Id: 1,
            switch2Valid: false,
            variableId: 1,
            variableValid: false,
            variableValue: 0
        },
        directionFix: false,
        image: { tileId: 0, characterName: "", direction: 2, pattern: 0, characterIndex: 0 },
        list: [{ code: 0, indent: 0, parameters: [] }],
        moveFrequency: 3,
        moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
        moveSpeed: 3,
        moveType: 0,
        priorityType: 0,
        stepAnime: false,
        through: false,
        trigger: 0,
        walkAnime: true
    };
}

export function blankEvent(id: number): any {
    return {
        id,
        x: 0,
        y: 0,
        name: `EV${String(id).padStart(3, "0")}`,
        note: "",
        pages: [blankPage()]
    };
}

export function eventAt(map: any, x: number, y: number): any | null {
    return (
        map.events.find((event: any) => event && event.x === x && event.y === y) ?? null
    );
}

export function getEvent(map: any, id: number): any | null {
    return map.events.find((event: any) => event && event.id === id) ?? null;
}

export function nextEventId(map: any): number {
    const ids = map.events.filter(Boolean).map((event: any) => event.id);
    return ids.length > 0 ? Math.max(...ids) + 1 : 1;
}

/**
 * MZ stores events in an array indexed by their id: Game_Map.setupEvents does
 * `this._events[event.id] = new Game_Event(mapId, event.id)` and Game_Event reads
 * its data back with `$dataMap.events[this._eventId]`. So index and id have to
 * agree, and nulls are the holes left by deleted events; if they do not agree the
 * runtime dies in Game_Event.initialize with "Cannot read properties of null
 * (reading 'x')".
 */
export function normalizeEventIds(map: any): void {
    const events = map.events.filter(Boolean) as any[];
    if (events.length === 0) {
        return;
    }
    const highestId = events.reduce((max, event) => Math.max(max, Number(event.id)), 0);
    const aligned: any[] = new Array(Math.max(map.events.length, highestId + 1)).fill(null);
    for (const event of events) {
        aligned[event.id] = event;
    }
    map.events = aligned;
}

export function addEvent(map: any, options: { x: number; y: number; name?: string; note?: string }): { id: number; event: any } {
    if (!inBounds(map, options.x, options.y)) {
        throw new Error(`Event position (${options.x},${options.y}) is outside the map`);
    }
    const existing = eventAt(map, options.x, options.y);
    if (existing) {
        throw new Error(`Cell (${options.x},${options.y}) already holds event ${existing.id} ("${existing.name}")`);
    }
    const id = nextEventId(map);
    const event = blankEvent(id);
    event.x = options.x;
    event.y = options.y;
    if (options.name) {
        event.name = options.name;
    }
    if (options.note) {
        event.note = options.note;
    }
    map.events[id] = event;
    normalizeEventIds(map);
    return { id, event };
}

export function removeEvent(map: any, id: number): boolean {
    const index = map.events.findIndex((event: any) => event && event.id === id);
    if (index < 0) {
        return false;
    }
    map.events[index] = null;
    return true;
}

// ---------------------------------------------------------------------------
// Event command lists
// ---------------------------------------------------------------------------

export interface Command {
    code: number;
    indent: number;
    parameters: any[];
}

/**
 * Continuation codes that repeat at the *same indent* as their opener, read by
 * the engine with `while (this.nextEventCode() === N)`:
 *   101 Show Text          -> 401 per text line
 *   105 Show H/G Text      -> 405 per text line
 *   108 Comment            -> 408 per comment line
 *   355 Script             -> 655 per script line
 * Codes outside this map have no `Game_Interpreter` handler: `executeCommand`
 * skips them, which is exactly why the text bodies above are separate commands.
 */
export const CONTINUATION_CODES: Record<number, number> = {
    101: 401,
    105: 405,
    108: 408,
    355: 655
};

export const TEXT_LINE_CODES = [401, 405, 408, 655];

/**
 * Block structure is indent-based, not closer-based: `skipBranch` simply walks
 * past every command whose indent exceeds the current one, so Conditional
 * Branch (111) and Show Choices (102) have no "end" command. Only Loop has an
 * explicit closer pair, which `command113` counts: 112 opens, 413 closes.
 */
export const LOOP_OPENER = 112;
export const LOOP_CLOSER = 413;
export const BREAK_LOOP = 113;
export const ELSE_BRANCH = 411;
export const CHOICE_WHEN = 402;
export const CHOICE_WHEN_CANCEL = 403;

/** Openers whose following indented commands form a branch of the parent. */
export const BRANCHING_COMMANDS = [102, 111, 301, 302];

/** True when `code` makes the commands after it sit one indent deeper. */
export function opensBlock(code: number): boolean {
    return BRANCHING_COMMANDS.includes(code) || code === LOOP_OPENER || code === ELSE_BRANCH ||
        code === CHOICE_WHEN || code === CHOICE_WHEN_CANCEL;
}

export function insertCommands(list: Command[], at: number, commands: Command[]): void {
    list.splice(at, 0, ...commands);
}

/** Branch markers that sit at their opener's indent and own the block below them. */
export const BLOCK_MARKERS: Record<number, number[]> = {
    102: [402, 403], // Show Choices
    111: [411, 412], // Conditional Branch / Else / End If
    112: [413], // Loop / Repeat Above
    301: [601, 602, 603], // Battle Processing: win / escape / lose
    302: [605, 606] // Shop Processing: purchase / no purchase
};

const MARKER_OWNER: Record<number, number> = Object.fromEntries(
    Object.entries(BLOCK_MARKERS).flatMap(([opener, markers]) => markers.map(marker => [marker, Number(opener)]))
);

const BLOCK_NAME: Record<number, string> = {
    102: "Show Choices",
    111: "Conditional Branch",
    112: "Loop",
    301: "Battle Processing",
    302: "Shop Processing"
};

/**
 * MZ reads a block by indent alone: `skipBranch` walks over the commands deeper than
 * the marker it is on, so a body written at the *same* indent as its Conditional
 * Branch is simply not inside it, and a Loop with no indented body repeats forever.
 * Nothing in the engine or the file complains about either, and the game just behaves
 * strangely three maps later. These are the shapes worth saying out loud when a list
 * is written, so they come back as warnings rather than a rejected call.
 */
export function blockStructureWarnings(list: Command[]): string[] {
    const warnings: string[] = [];
    const frameOf = (code: number, indent: number, index: number) => ({ code, indent, index, body: 0 });
    const emptyBodyWarning = (frame: ReturnType<typeof frameOf>, index: number) => {
        // Only the two blocks whose whole meaning is the indented body under them.
        // A choice branch or a battle result branch with nothing in it is legal, and
        // shop goods are sub-lines at the parent indent rather than a body.
        if (frame.body > 0 || (frame.code !== 111 && frame.code !== LOOP_OPENER)) {
            return;
        }
        warnings.push(
            `list[${index}]: the ${BLOCK_NAME[frame.code]} block opened at list[${frame.index}] has nothing indented under it, ` +
                "so the engine runs those commands outside the block" +
                (frame.code === LOOP_OPENER ? " — and an empty Loop repeats forever" : "") +
                "."
        );
    };
    const stack: ReturnType<typeof frameOf>[] = [];
    list.forEach((command, index) => {
        // MZ writes a code-0 line at the parent indent to end one choice or battle
        // branch, and again at the end of the list. Neither closes a block.
        if (command.code === 0) {
            return;
        }
        const markerOwner = MARKER_OWNER[command.code];
        while (stack.length > 0 && command.indent <= stack[stack.length - 1].indent) {
            const top = stack[stack.length - 1];
            // A marker at its own opener's indent is part of that block, not a
            // command after it, so the block is still open.
            if (markerOwner !== undefined && top.code === markerOwner && top.indent === command.indent) {
                break;
            }
            stack.pop();
            emptyBodyWarning(top, index);
        }
        if (markerOwner !== undefined) {
            const owner = stack.find(frame => frame.code === markerOwner && frame.indent === command.indent);
            if (!owner) {
                warnings.push(
                    `list[${index}]: command ${command.code} has no matching ${BLOCK_NAME[markerOwner] ?? markerOwner} opener at ` +
                        `indent ${command.indent}, so it changes nothing about which commands run.`
                );
            } else if (command.code === 412 || command.code === 413) {
                // End If and Repeat Above are the only closers MZ writes.
                stack.splice(stack.indexOf(owner), 1);
                emptyBodyWarning(owner, index);
            }
            return;
        }
        if (command.indent > stack.length) {
            warnings.push(
                `list[${index}]: indent ${command.indent} is deeper than any block open here (only ${stack.length}), so those ` +
                    "commands belong to no branch."
            );
        }
        if (opensBlock(command.code)) {
            stack.push(frameOf(command.code, command.indent, index));
            return;
        }
        if (command.code !== 0 && command.code !== 401 && stack.length > 0) {
            stack[stack.length - 1].body++;
        }
    });
    for (const frame of stack) {
        emptyBodyWarning(frame, list.length - 1);
    }
    return warnings;
}

/**
 * Append commands to a page, keeping MZ's invariant that the terminating
 * `{ code: 0 }` stays last.
 */
export function appendCommands(page: any, commands: Command[]): void {
    const list: Command[] = page.list;
    const terminatorIndex = list.findIndex(command => command.code === 0);
    if (terminatorIndex < 0) {
        list.push({ code: 0, indent: 0, parameters: [] });
        list.splice(list.length - 1, 0, ...commands);
        return;
    }
    list.splice(terminatorIndex, 0, ...commands);
}


/** Reverse map: continuation code -> the opener that consumes it. */
export const CONTINUATION_OF: Record<number, number> = Object.fromEntries(
    Object.entries(CONTINUATION_CODES).map(([opener, continuation]) => [continuation, Number(opener)])
);

/**
 * `Game_Interpreter` hands `parameters[0]` of a text line straight to
 * `Game_Message.add`, which pushes it without any coercion, so a `null` there
 * becomes a `null` entry in `$gameMessage._texts` and breaks the dialog window.
 * `JSON.stringify` also silently turns `undefined` into `null`, which is how a
 * caller building parameters from a missing field produces exactly that.
 */
export function assertCommandWellFormed(command: Command): void {
    const { code, parameters } = command;
    if (!Array.isArray(parameters)) {
        throw new Error(`Command ${code} must carry a parameters array, got ${typeof parameters}`);
    }
    if (parameters.some(value => value === undefined)) {
        throw new Error(
            `Command ${code} has an undefined parameter; it would be written to disk as null. ` +
                `Pass explicit values for every parameter.`
        );
    }
    if (CONTINUATION_OF[code] !== undefined && typeof parameters[0] !== "string") {
        throw new Error(
            `Command ${code} is the continuation line of command ${CONTINUATION_OF[code]} and its ` +
                `parameters[0] must be a string (the engine pushes it into $gameMessage._texts unchanged), ` +
                `got ${JSON.stringify(parameters[0] ?? null)}`
        );
    }
    if (code === 101 && parameters.length > 0) {
        const [faceName, faceIndex, background, positionType, speakerName] = parameters;
        if (typeof faceName !== "string" || typeof faceIndex !== "number" || typeof background !== "number" ||
            typeof positionType !== "number" || (speakerName !== undefined && typeof speakerName !== "string")) {
            throw new Error(
                `Command 101 parameters must be [faceName:string, faceIndex:number, background:number, ` +
                    `positionType:number, speakerName:string], got ${JSON.stringify(parameters)}`
            );
        }
    }
}

/**
 * Build the command list for a Show Text dialog: one settings command plus one
 * `401` line per text line, all at the same indent, as the engine expects.
 */
export function showTextCommands(options: {
    lines: string[];
    faceName?: string;
    faceIndex?: number;
    background?: number;
    positionType?: number;
    speakerName?: string;
    indent?: number;
}): Command[] {
    if (!options.lines?.length) {
        throw new Error("show_text needs at least one line");
    }
    const indent = options.indent ?? 0;
    const commands: Command[] = [
        {
            code: 101,
            indent,
            parameters: [
                options.faceName ?? "",
                options.faceIndex ?? 0,
                options.background ?? 0,
                options.positionType ?? 2,
                options.speakerName ?? ""
            ]
        }
    ];
    for (const line of options.lines) {
        if (typeof line !== "string") {
            throw new Error(`Every Show Text line must be a string, got ${JSON.stringify(line)}`);
        }
        commands.push({ code: 401, indent, parameters: [line] });
    }
    return commands;
}

/**
 * Find where a block opened at `startIndex` ends, i.e. the first following
 * command whose indent drops back to the opener's indent.
 */
export function findBlockEnd(list: Command[], startIndex: number): number {
    const baseIndent = list[startIndex].indent;
    for (let i = startIndex + 1; i < list.length; i++) {
        if (list[i].indent <= baseIndent) {
            return i;
        }
    }
    return list.length;
}
