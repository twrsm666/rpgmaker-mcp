/**
 * The high-level authoring layer: one agent intent = one call.
 *
 * Every tool here composes the low-level primitives server-side, inside the same
 * journaled transaction `batch` uses, and answers with the picture the change made
 * plus a structured diff. The point is that "put a shopkeeper here" or "join these two
 * maps" is a single call rather than nine, and that the shapes the engine reads — a
 * chest's second page, an encounter row's `regionSet`, a shop's `605` goods lines —
 * are written correctly once here instead of re-guessed per project.
 *
 * Script steps (`say`/`choice`/`if`/`battle`/…) are compiled by `compileSteps` into
 * `{code, indent, parameters}` exactly as `Game_Interpreter` reads them: bodies one
 * indent deeper than their opener, branch markers at their opener's indent, every
 * continuation line (`401`/`405`/`408`/`655`) carrying its text in `parameters[0]`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { z } from "zod";
import type { Project } from "../core/project.js";
import {
    DIRS_FOUR,
    FLAG_BUSH,
    FLAG_COUNTER,
    FLAG_DAMAGE_FLOOR,
    FLAG_LADDER,
    FLAG_NO_PASSAGE_EFFECT,
    FLAG_TERRAIN_SHIFT,
    LAYER_REGION,
    appendCommands,
    assertCommandWellFormed,
    blockStructureWarnings,
    eventAt,
    getEvent,
    inBounds,
    isPassable,
    showTextCommands,
    tileAt,
    type Command
} from "../core/map.js";
import { unknownCodeWarnings, type Codebook } from "../core/codebook.js";

export interface ToolImage {
    data: string;
    mimeType: string;
}

/**
 * What `src/index.ts` hands these tools so they belong to the server without importing
 * it: the registry, the project, the engine constants, the two shapes a low-level call
 * comes back in, and the journal this layer's transactions roll back against.
 */
export interface HighLevelContext {
    register(name: string, config: Record<string, unknown>, handler: (args: any) => Promise<any>): void;
    /** Turn a thrown error into the `{error}` reply every other tool answers with. */
    guarded(handler: (args: any) => Promise<any>): (args: any) => Promise<any>;
    project(): Project;
    statics(): any;
    call(name: string, args: Record<string, unknown>): Promise<any>;
    callWithImage(name: string, args: Record<string, unknown>): Promise<{ payload: any; image: ToolImage | null }>;
    liveActive(): boolean;
    /** The engine's command dictionary, the same one decode_commands reads. */
    codebook(): Codebook;
    transaction<T>(run: () => Promise<T>): Promise<{ value: T; wrote: string[] }>;
}

// ---------------------------------------------------------------------------
// Command building
// ---------------------------------------------------------------------------

const c = (code: number, ...parameters: unknown[]): Command => ({ code, indent: 0, parameters });
const END: () => Command = () => c(0);
/** Push a block one level deeper. Relative, because a branch inside a loop has to gain
 *  a level rather than flatten onto its parent's — which `skipBranch` reads as an empty body. */
const indent_by = (indent: number, list: Command[]): Command[] => list.map(item => ({ ...item, indent: item.indent + indent }));

const STEP_KEYS = [
    "say", "scroll", "comment", "choice", "if", "loop", "break", "exit", "label", "goto",
    "switch", "selfSwitch", "variable", "gold", "item", "weapon", "armor", "heal",
    "transfer", "wait", "fade", "flash", "weather", "se", "me", "bgm", "stopBgm", "stopSe",
    "animate", "balloon", "moveRoute", "battle", "shop", "menu", "saveScreen", "gameOver", "title",
    "commonEvent", "erase", "script", "raw"
];

/** The vocabulary spelled out where a caller reads it: an unknown step name is the most
 *  likely mistake, and the list of what is legal answers it without another round trip. */
const STEP_DOC =
    "Each step is an object with exactly one key: " +
    "`say` (a string, a list of lines, or {lines, speaker?, faceName?, faceIndex?, background?, positionType?}), " +
    "`scroll` ({lines, fast?, wait?}), `comment`, " +
    "`choice` ({prompt?, options: [{label, then, when?, lockedMessage?}], cancel?: steps, defaultType?, positionType?, background?}), " +
    "`if` ({when, then, else?}), `loop` (steps, closed by `break` or `goto`), `break`, `exit`, `label`, `goto`, " +
    "`switch` ({id, value?}), `selfSwitch` ({letter, value?}), `variable` ({id, set?|add?|multiply?}), " +
    "`gold` (a number; negative takes), `item`/`weapon`/`armor` ({id, count?, take?}), `heal`, " +
    "`transfer` ({mapId, x, y, direction?, fade?}), `wait` (frames), `fade` (\"out\"|\"in\"), " +
    "`flash` ({color?, duration?, wait?}), `weather` ({type, power, duration?, wait?}), " +
    "`se`/`me`/`bgm` (a name or {name, volume?, pitch?, pan?}), `stopBgm`, `stopSe`, " +
    "`animate` ({target?, animationId, wait?}), `balloon` ({target?, balloonId, wait?}), " +
    "`moveRoute` ({target?, route: [route steps], repeat?, skippable?, wait?}), " +
    "`battle` ({troopId, canEscape?, canLose?, win?, escape?, lose?}), " +
    "`shop` ({goods: [{id, kind?, price?, purchaseOnly?}]}), `menu`, `saveScreen`, `gameOver`, `title`, " +
    "`commonEvent`, `erase`, `script` (engine code, stored as 355/655) and `raw` (verbatim {code, parameters, indent?}). " +
    "`script` and `raw` are escape hatches: they come back named in the reply, and a build that leans on them is reporting " +
    "a shape this layer does not cover yet.";

const CONDITION_DOC =
    "A condition is one of {switch: id, value?}, {selfSwitch: \"A\"..\"D\", value?}, " +
    "{variable: id, op?: \"==\"|\">=\"|\"<=\"|\">\"|\"<\"|\"!=\", value: n or {variable: id}} (op defaults to \">=\"), " +
    "{item: id}, {weapon: id}, {armor: id}, {gold: n} (at least n), {actor: id, state?|skill?}, {button: \"ok\", pressed?}, " +
    "or {code: 111, parameters: [...]} to write the engine's own shape.";

const ROUTE_DOC =
    "Route steps are {key: value}: down, left, right, up, lowerLeft, lowerRight, upperRight, upperLeft, random, " +
    "toward, away, forward, backward; jump {dx, dy}; wait n; turn (\"down\"|\"left\"|\"right\"|\"up\"|\"90right\"|\"90left\"|\"180\"|\"random90\"|\"random\"|\"toward\"|\"away\"); " +
    "switch {id, value}; speed 0..6; frequency 0..4; walkAnime, stepAnime, directionFix, through, transparent (true/false); " +
    "image {characterName, characterIndex}; opacity 0..255; blend 0..4; se {name}; script \"...\".";

function isRecord(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function linesOf(value: unknown, where: string): string[] {
    const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : null;
    if (!list || list.length === 0) {
        throw new Error(`${where}: needs at least one line of text`);
    }
    for (const line of list) {
        if (typeof line !== "string") {
            throw new Error(`${where}: every line must be a string, got ${JSON.stringify(line)}`);
        }
    }
    return list as string[];
}

/** Show Text as the engine stores it: one 101 and one 401 per line, same indent. */
function sayCommands(value: unknown, where: string): Command[] {
    if (typeof value === "string" || Array.isArray(value)) {
        return showTextCommands({ lines: linesOf(value, where) });
    }
    if (isRecord(value)) {
        const lines = Array.isArray(value.lines) || typeof value.lines === "string" ? linesOf(value.lines ?? value.lines, where) : null;
        if (!lines) {
            throw new Error(`${where}: say wants a string, a list of lines, or {lines, speaker?, faceName?, faceIndex?, background?, positionType?}, got ${JSON.stringify(value)}`);
        }
        return showTextCommands(
            stripUndefined({
                lines,
                faceName: value.faceName,
                faceIndex: value.faceIndex,
                background: value.background,
                positionType: value.positionType,
                speakerName: value.speaker ?? value.speakerName
            }) as any
        );
    }
    throw new Error(`${where}: say wants a string, a list of lines, or an object with lines, got ${JSON.stringify(value)}`);
}

/** Merge a tool-level speaker/face default into a per-page say value. */
function sayWithDefaults(value: unknown, defaults: Record<string, unknown>, where: string): Command[] {
    if (Object.keys(defaults).length === 0) {
        return sayCommands(value, where);
    }
    if (typeof value === "string" || Array.isArray(value)) {
        return sayCommands({ lines: value, ...defaults }, where);
    }
    if (isRecord(value)) {
        return sayCommands({ speaker: defaults.speakerName, faceName: defaults.faceName, ...stripUndefined(defaults), ...value }, where);
    }
    return sayCommands(value, where);
}

/** The `[name, volume, pitch, pan]` object every audio command carries. */
function audioParam(value: unknown, where: string, defaults: { volume: number; pitch: number }): { name: string; volume: number; pitch: number; pan: number } {
    if (typeof value === "string") {
        return { name: value, volume: defaults.volume, pitch: defaults.pitch, pan: 0 };
    }
    if (isRecord(value) && typeof value.name === "string") {
        return { name: value.name, volume: value.volume ?? defaults.volume, pitch: value.pitch ?? defaults.pitch, pan: value.pan ?? 0 };
    }
    throw new Error(`${where}: an audio step wants a name or {name, volume?, pitch?, pan?}, got ${JSON.stringify(value)}`);
}

const VARIABLE_OPERATIONS: Record<string, number> = { set: 0, add: 1, sub: 2, mul: 3, div: 4, mod: 5 };

function variableCommand(node: unknown, where: string): Command {
    if (!isRecord(node)) {
        throw new Error(`${where}: a variable step is {id, set?|add?|multiply?}, got ${JSON.stringify(node)}`);
    }
    const id = Number(node.id ?? node.var);
    if (!Number.isInteger(id) || id < 1) {
        throw new Error(`${where}: variable needs an integer id, got ${JSON.stringify(node.id)}`);
    }
    if (node.add !== undefined) {
        const amount = Number(node.add);
        return c(122, id, id, amount < 0 ? VARIABLE_OPERATIONS.sub : VARIABLE_OPERATIONS.add, 0, Math.abs(amount));
    }
    if (node.multiply !== undefined) {
        return c(122, id, id, VARIABLE_OPERATIONS.mul, 0, Number(node.multiply));
    }
    if (node.set !== undefined || node.value !== undefined) {
        return c(122, id, id, VARIABLE_OPERATIONS.set, 0, Number(node.set ?? node.value));
    }
    throw new Error(`${where}: a variable step needs set (or value), add, or multiply, got ${JSON.stringify(node)}`);
}

const COMPARISONS: Record<string, number> = { "==": 0, ">=": 1, "<=": 2, ">": 3, "<": 4, "!=": 5 };

/** A condition, as command 111's parameters. */
function conditionCommand(condition: unknown, where: string): Command {
    if (!isRecord(condition)) {
        throw new Error(`${where}: ${CONDITION_DOC}`);
    }
    if (condition.code !== undefined) {
        const command: Command = { code: Number(condition.code), indent: 0, parameters: (condition.parameters ?? []) as unknown[] };
        if (command.code !== 111) {
            throw new Error(`${where}: a condition written by hand has to be code 111 (Conditional Branch), got ${command.code}`);
        }
        return command;
    }
    if (condition.switch !== undefined) {
        return c(111, 0, Number(condition.switch), condition.value === false ? 1 : 0);
    }
    if (condition.selfSwitch !== undefined) {
        const letter = String(condition.selfSwitch).toUpperCase();
        if (!"ABCD".includes(letter)) {
            throw new Error(`${where}: selfSwitch is one of A, B, C, D, got ${JSON.stringify(condition.selfSwitch)}`);
        }
        return c(111, 2, letter, condition.value === false ? 1 : 0);
    }
    if (condition.variable !== undefined) {
        // The id form and the nested form both arrive: `variable` is an id here, but the
        // page-condition shape is {variable: {id, atLeast}}, so people write it that way.
        const nested = isRecord(condition.variable) ? condition.variable : {};
        const id = Number(nested.id ?? condition.variable);
        const op = condition.op ?? nested.op ?? ">=";
        if (COMPARISONS[op] === undefined) {
            throw new Error(`${where}: comparison "${op}" is not one of ${Object.keys(COMPARISONS).join(" ")}`);
        }
        const rawValue = condition.value ?? nested.value ?? nested.atLeast;
        const other = isRecord(rawValue) ? Number((rawValue as any).variable) : Number(rawValue);
        if (!Number.isFinite(other)) {
            throw new Error(`${where}: {variable: ${id}} also needs value (a number, or {variable: id}), got ${JSON.stringify(condition.value)}`);
        }
        return c(111, 1, id, isRecord(rawValue) ? 1 : 0, other, COMPARISONS[op]);
    }
    if (condition.item !== undefined) {
        return c(111, 8, Number(condition.item));
    }
    if (condition.weapon !== undefined) {
        return c(111, 9, Number(condition.weapon), condition.includeEquipped ?? false);
    }
    if (condition.armor !== undefined) {
        return c(111, 10, Number(condition.armor), condition.includeEquipped ?? false);
    }
    if (condition.gold !== undefined) {
        return c(111, 7, Number(condition.gold), 0);
    }
    if (condition.actor !== undefined) {
        if (condition.state !== undefined) {
            return c(111, 4, Number(condition.actor), 6, Number(condition.state));
        }
        if (condition.skill !== undefined) {
            return c(111, 4, Number(condition.actor), 3, Number(condition.skill));
        }
        return c(111, 4, Number(condition.actor), 0);
    }
    if (condition.button !== undefined) {
        return c(111, 11, String(condition.button), condition.pressed === false ? 1 : 0);
    }
    throw new Error(`${where}: unknown condition ${JSON.stringify(condition)}. ${CONDITION_DOC}`);
}

/**
 * The same idea for a page condition, which is narrower than command 111: a page can
 * only ask for things that are ON, so `value: false` is refused rather than quietly
 * dropped.
 */
function pageConditions(when: unknown, where: string): Record<string, unknown> {
    if (!isRecord(when)) {
        throw new Error(`${where}: a page's when is {switch?, switch2?, selfSwitch?, variable?: {id, atLeast}, item?, actor?}`);
    }
    const out: Record<string, unknown> = {};
    if (when.switch !== undefined) {
        if (when.value === false) {
            throw new Error(
                `${where}: a page condition can only test a switch that is ON. Test the OFF case inside the script with an if step, ` +
                    "or give the other case its own event."
            );
        }
        out.switch1Id = Number(when.switch);
    }
    if (when.switch2 !== undefined) {
        out.switch2Id = Number(when.switch2);
    }
    if (when.selfSwitch !== undefined) {
        const letter = String(when.selfSwitch).toUpperCase();
        if (!"ABCD".includes(letter)) {
            throw new Error(`${where}: selfSwitch is A, B, C or D, got ${JSON.stringify(when.selfSwitch)}`);
        }
        out.selfSwitch = letter;
    }
    if (when.variable !== undefined) {
        const node = isRecord(when.variable) ? when.variable : { id: when.variable, atLeast: 1 };
        if (node.op !== undefined && node.op !== ">=") {
            throw new Error(`${where}: a page's variable condition is only ever "greater than or equal to" in MZ; pass atLeast, or test it with an if step.`);
        }
        out.variableId = Number(node.id);
        out.variableValue = Number(node.atLeast ?? node.value ?? 1);
    }
    if (when.item !== undefined) {
        out.itemId = Number(when.item);
    }
    if (when.actor !== undefined) {
        out.actorId = Number(when.actor);
    }
    if (Object.keys(out).length === 0) {
        throw new Error(`${where}: when named none of switch, switch2, selfSwitch, variable, item, actor, so it would set no condition at all`);
    }
    return out;
}

const ROUTE_MOVES: Record<string, number> = {
    down: 1,
    left: 2,
    right: 3,
    up: 4,
    lowerLeft: 5,
    lowerRight: 6,
    upperRight: 7,
    upperLeft: 8,
    random: 9,
    toward: 10,
    away: 11,
    forward: 12,
    backward: 13
};

const ROUTE_TURNS: Record<string, number> = {
    down: 16,
    left: 17,
    right: 18,
    up: 19,
    "90right": 20,
    "90left": 21,
    "180": 22,
    random90: 23,
    random: 24,
    toward: 25,
    away: 26
};

type RouteCommand = { code: number; parameters: unknown[] };

/** `Game_Character`'s ROUTE_* codes, as `processMoveCommand` reads them. */
function compileRoute(steps: unknown[], where: string, escapes: string[]): RouteCommand[] {
    if (!Array.isArray(steps) || steps.length === 0) {
        throw new Error(`${where}: a route is a non-empty list of steps`);
    }
    const list: RouteCommand[] = [];
    steps.forEach((step, index) => {
        const at = `${where} step ${index}`;
        if (!isRecord(step)) {
            throw new Error(`${at}: each route step is {key: value}, got ${JSON.stringify(step)}`);
        }
        const keys = Object.keys(step);
        if (keys.length !== 1) {
            throw new Error(`${at}: a route step names one action, this names ${keys.join(", ")}`);
        }
        const key = keys[0];
        const value = step[key];
        if (ROUTE_MOVES[key] !== undefined) {
            list.push({ code: ROUTE_MOVES[key], parameters: [] });
            return;
        }
        switch (key) {
            case "jump":
                list.push({ code: 14, parameters: [Number(isRecord(value) ? value.dx ?? value.x ?? 0 : 0), Number(isRecord(value) ? value.dy ?? value.y ?? 0 : 0)] });
                return;
            case "wait":
                list.push({ code: 15, parameters: [Number(value)] });
                return;
            case "turn": {
                const code = ROUTE_TURNS[String(value)];
                if (code === undefined) {
                    throw new Error(`${at}: turn wants one of ${Object.keys(ROUTE_TURNS).join(", ")}, got ${JSON.stringify(value)}`);
                }
                list.push({ code, parameters: [] });
                return;
            }
            case "switch":
                list.push({ code: isRecord(value) && value.value === false ? 28 : 27, parameters: [Number(isRecord(value) ? value.id : value)] });
                return;
            case "speed":
                list.push({ code: 29, parameters: [Number(value)] });
                return;
            case "frequency":
                list.push({ code: 30, parameters: [Number(value)] });
                return;
            case "walkAnime":
                list.push({ code: value ? 31 : 32, parameters: [] });
                return;
            case "stepAnime":
                list.push({ code: value ? 33 : 34, parameters: [] });
                return;
            case "directionFix":
                list.push({ code: value ? 35 : 36, parameters: [] });
                return;
            case "through":
                list.push({ code: value ? 37 : 38, parameters: [] });
                return;
            case "transparent":
                list.push({ code: value ? 39 : 40, parameters: [] });
                return;
            case "image":
                list.push({ code: 41, parameters: [String(value?.characterName ?? ""), Number(value?.characterIndex ?? 0)] });
                return;
            case "opacity":
                list.push({ code: 42, parameters: [Number(value)] });
                return;
            case "blend":
                list.push({ code: 43, parameters: [Number(value)] });
                return;
            case "se":
                list.push({ code: 44, parameters: [audioParam(value, at, { volume: 90, pitch: 100 })] });
                return;
            case "script":
                escapes.push(`${at}: a movement route runs engine code`);
                list.push({ code: 45, parameters: [String(value)] });
                return;
            default:
                throw new Error(`${at}: route step "${key}" is not one the engine has. ${ROUTE_DOC}`);
        }
    });
    // ROUTE_END is what restarts a repeating route and finishes a one-shot one.
    list.push({ code: 0, parameters: [] });
    return list;
}

/** Compile script steps into an MZ command list, all at relative indent 0. */
function compileSteps(steps: unknown[], where: string, escapes: string[]): Command[] {
    if (!Array.isArray(steps)) {
        throw new Error(`${where}: expected a list of script steps, got ${JSON.stringify(steps)}`);
    }
    const out: Command[] = [];
    steps.forEach((step, index) => {
        const at = `${where} step ${index}`;
        if (!isRecord(step)) {
            throw new Error(`${at}: every script step is an object naming one action, got ${JSON.stringify(step)}`);
        }
        const keys = Object.keys(step);
        if (keys.length !== 1) {
            throw new Error(`${at}: this step names ${keys.length} actions (${keys.join(", ")}); a step names exactly one`);
        }
        const key = keys[0];
        const value = step[key];
        if (!STEP_KEYS.includes(key)) {
            throw new Error(`${at}: "${key}" is not a script step. ${STEP_DOC}`);
        }
        switch (key) {
            case "say":
                out.push(...sayCommands(value, at));
                return;
            case "scroll": {
                const node = isRecord(value) ? value : { lines: value };
                const lines = linesOf(node.lines, at);
                out.push(c(105, node.fast !== false, node.wait === false ? 0 : 1), ...lines.map(line => c(405, line)));
                return;
            }
            case "comment": {
                const lines = Array.isArray(value) ? value : [value];
                out.push(...lines.map((line, lineIndex) => c(lineIndex === 0 ? 108 : 408, String(line))));
                return;
            }
            case "choice": {
                const node = value as any;
                const options: any[] = Array.isArray(node?.options) ? node.options : [];
                if (options.length === 0) {
                    throw new Error(`${at}: a choice needs at least one option, each {label, then}`);
                }
                const labels = options.map((option, optionIndex) => {
                    if (typeof option?.label !== "string") {
                        throw new Error(`${at}: option ${optionIndex} has no label string`);
                    }
                    return option.label;
                });
                if (node.prompt) {
                    out.push(...sayCommands(node.prompt, `${at} prompt`));
                }
                // params[1] is the engine's cancel type: -1 disallows cancel, an index makes
                // cancel pick that option, and anything >= the choice count routes it to the
                // 403 branch — rmmz_objects.js setupChoices turns that into -2.
                out.push(c(102, labels, node.cancel ? labels.length : -1, node.defaultType ?? 0, node.positionType ?? 2, node.background ?? 0));
                options.forEach((option, optionIndex) => {
                    const body = compileSteps(option.then ?? [], `${at} "${option.label}"`, escapes);
                    out.push(c(402, optionIndex, option.label));
                    if (option.when) {
                        const blocked = option.lockedMessage
                            ? sayCommands(option.lockedMessage, `${at} option "${option.label}" lockedMessage`)
                            : [c(108, "Nothing happens: the option's condition was not met.")];
                        // The whole conditional sits at the branch's indent, with its own bodies
                        // one deeper: MZ writes a nested branch that way, and a marker left at the
                        // parent indent reads as belonging to the choice rather than the option.
                        const gate: Command[] = [
                            conditionCommand(option.when, `${at} option "${option.label}" when`),
                            ...indent_by(1, body),
                            c(411),
                            ...indent_by(1, blocked),
                            c(412)
                        ];
                        out.push(...indent_by(1, gate));
                    } else {
                        out.push(...indent_by(1, body));
                    }
                    // MZ closes a choice branch with a code-0 line of its own.
                    out.push(c(0));
                });
                if (node.cancel) {
                    out.push(c(403), ...indent_by(1, compileSteps(node.cancel, `${at} cancel`, escapes)), c(0));
                }
                return;
            }
            case "if": {
                const node = value as any;
                out.push(conditionCommand(node.when ?? node.condition, at));
                out.push(...indent_by(1, compileSteps(node.then ?? [], `${at} then`, escapes)));
                if (node.else) {
                    out.push(c(411), ...indent_by(1, compileSteps(node.else, `${at} else`, escapes)));
                }
                out.push(c(412));
                return;
            }
            case "loop":
                out.push(c(112), ...indent_by(1, compileSteps(Array.isArray(value) ? value : (value as any).then, at, escapes)), c(413));
                return;
            case "break":
                out.push(c(113));
                return;
            case "exit":
                out.push(c(115));
                return;
            case "label":
                out.push(c(118, String(value)));
                return;
            case "goto":
                out.push(c(119, String(value)));
                return;
            case "switch": {
                const node = isRecord(value) ? value : { id: value };
                const id = Number(node.id);
                if (!Number.isInteger(id) || id < 1) {
                    throw new Error(`${at}: a switch step needs an integer id, got ${JSON.stringify(value)}`);
                }
                out.push(c(121, id, id, node.value === false ? 1 : 0));
                return;
            }
            case "selfSwitch": {
                const node = isRecord(value) ? value : { letter: value };
                const letter = String(node.letter ?? node.ch ?? value).toUpperCase();
                if (!"ABCD".includes(letter)) {
                    throw new Error(`${at}: selfSwitch is A, B, C or D, got ${JSON.stringify(value)}`);
                }
                out.push(c(123, letter, node.value === false ? 1 : 0));
                return;
            }
            case "variable":
                out.push(variableCommand(value, at));
                return;
            case "gold": {
                const amount = isRecord(value) ? Number(value.amount) * (value.take || value.mode === "decrease" ? -1 : 1) : Number(value);
                if (!Number.isFinite(amount)) {
                    throw new Error(`${at}: gold wants a number or {amount, take?}, got ${JSON.stringify(value)}`);
                }
                out.push(c(125, amount < 0 ? 1 : 0, 0, Math.abs(amount)));
                return;
            }
            case "item":
            case "weapon":
            case "armor": {
                const code = key === "item" ? 126 : key === "weapon" ? 127 : 128;
                const node = isRecord(value) ? value : { id: value };
                const parameters: unknown[] = [Number(node.id), node.take ? 1 : 0, 0, Number(node.count ?? 1)];
                if (code !== 126) {
                    parameters.push(node.includeEquipped ?? false);
                }
                out.push(c(code, ...parameters));
                return;
            }
            case "heal":
                out.push(c(314, 0, 1));
                return;
            case "transfer": {
                const node = value as any;
                out.push(c(201, 0, Number(node.mapId), Number(node.x), Number(node.y), node.direction ?? 0, node.fade ?? node.fadeType ?? 0));
                return;
            }
            case "wait":
                out.push(c(230, Number(value)));
                return;
            case "fade":
                if (value !== "out" && value !== "in") {
                    throw new Error(`${at}: fade is "out" or "in", got ${JSON.stringify(value)}`);
                }
                out.push(c(value === "out" ? 221 : 222));
                return;
            case "flash": {
                const node = isRecord(value) ? value : {};
                out.push(c(224, node.color ?? [255, 255, 255], Number(node.duration ?? 30), node.wait ?? true));
                return;
            }
            case "weather": {
                const node = isRecord(value) ? value : {};
                out.push(c(236, node.type ?? "none", Number(node.power ?? 0), Number(node.duration ?? 60), node.wait ?? false));
                return;
            }
            case "se":
                out.push(c(250, audioParam(value, at, { volume: 90, pitch: 100 })));
                return;
            case "me":
                out.push(c(249, audioParam(value, at, { volume: 90, pitch: 100 })));
                return;
            case "bgm":
                out.push(c(241, audioParam(value, at, { volume: 70, pitch: 100 })));
                return;
            case "stopBgm":
                out.push(c(242, Number(isRecord(value) ? value.duration ?? 0 : value) || 0));
                return;
            case "stopSe":
                out.push(c(251));
                return;
            case "animate": {
                const node = isRecord(value) ? value : { animationId: value };
                out.push(c(212, Number(node.target ?? 0), Number(node.animationId ?? node.id), node.wait ?? false));
                return;
            }
            case "balloon": {
                const node = isRecord(value) ? value : { balloonId: value };
                out.push(c(213, Number(node.target ?? 0), Number(node.balloonId ?? node.id), node.wait ?? false));
                return;
            }
            case "moveRoute": {
                const node = value as any;
                const list = compileRoute(node.route ?? node.list, `${at} route`, escapes);
                out.push(c(205, Number(node.target ?? 0), { list, repeat: node.repeat ?? true, skippable: node.skippable ?? false, wait: node.wait ?? false }));
                return;
            }
            case "battle": {
                const node = value as any;
                out.push(c(301, 0, Number(node.troopId), node.canEscape ?? true, node.canLose ?? true));
                for (const [code, steps] of [[601, node.win], [602, node.escape], [603, node.lose]] as const) {
                    out.push(c(code));
                    if (steps) {
                        out.push(...indent_by(1, compileSteps(steps, `${at} branch ${code}`, escapes)));
                    }
                }
                return;
            }
            case "shop":
                out.push(...shopCommands(value, at));
                return;
            case "menu":
                out.push(c(351));
                return;
            case "saveScreen":
                out.push(c(352));
                return;
            case "gameOver":
                out.push(c(353));
                return;
            case "title":
                out.push(c(354));
                return;
            case "commonEvent":
                out.push(c(117, Number(isRecord(value) ? value.id : value)));
                return;
            case "erase":
                out.push(c(214));
                return;
            case "script": {
                escapes.push(`${at}: a step runs engine code through Show Scrolling Text's sibling, Script (355)`);
                const lines = Array.isArray(value) ? value : [value];
                out.push(c(355, String(lines[0])), ...lines.slice(1).map((line, lineIndex) => c(lineIndex === 0 ? 655 : 655, String(line))));
                return;
            }
            case "raw": {
                const list = Array.isArray(value) ? value : [value];
                escapes.push(`${at}: ${list.length} command(s) written verbatim as raw`);
                for (const item of list) {
                    out.push({ code: Number(item.code), indent: Number(item.indent ?? 0), parameters: item.parameters ?? [] });
                }
                return;
            }
            default:
                throw new Error(`${at}: "${key}" has no compiler. ${STEP_DOC}`);
        }
    });
    return out;
}

/**
 * MZ stores a shop as command 302 carrying the first good in its own parameters plus one
 * `605` line per further good, each `[kind, id, priceType, price, purchaseOnly]`. There is
 * no purchase branch — 605/606 as branches are MV's — so whatever follows the goods runs
 * when the shop window closes.
 */
function shopCommands(node: any, where: string): Command[] {
    const goods: any[] = Array.isArray(node?.goods) ? node.goods : [];
    if (goods.length === 0) {
        throw new Error(`${where}: a shop needs goods, each {id, kind?: "item"|"weapon"|"armor", price?, purchaseOnly?}`);
    }
    return goods.map((good, index) => {
        const kind = good.kind === "weapon" ? 1 : good.kind === "armor" ? 2 : 0;
        const id = Number(good.id);
        if (!Number.isInteger(id) || id < 1) {
            throw new Error(`${where} good ${index}: needs an integer id, got ${JSON.stringify(good.id)}`);
        }
        const price = good.price === undefined || good.price === null || good.price === "standard" ? null : Number(good.price);
        return c(index === 0 ? 302 : 605, kind, id, price === null ? 0 : 1, price ?? 0, good.purchaseOnly ?? false);
    });
}

// ---------------------------------------------------------------------------
// Validation on the way in
// ---------------------------------------------------------------------------

/**
 * `ImageManager.loadBitmap` builds its url as `folder + name + ".png"` and nothing else
 * (measured in v1.8.0's rmmz_managers.js:919), so a `.jpg` sitting in `img/pictures/` is a
 * file the engine will never read — and an audit that accepted it let a build pass whose
 * playtest then logged "Failed to load: img/pictures/lighthouse-night.png". Only the
 * spelling the engine asks for counts as present.
 */
function assetExists(project: Project, folder: string, name: string): boolean {
    if (!name) {
        return true;
    }
    const dir = join(project.dir, ...folder.split("/"));
    return existsSync(join(dir, `${name}.png`));
}

function audioExists(project: Project, folder: string, name: string): boolean {
    if (!name) {
        return true;
    }
    const dir = join(project.dir, ...folder.split("/"));
    return existsSync(join(dir, `${name}.ogg`)) || existsSync(join(dir, `${name}.m4a`));
}

function namesIn(project: Project, folder: string, limit: number): string[] {
    const dir = join(project.dir, folder);
    if (!existsSync(dir)) {
        return [];
    }
    try {
        return readdirSync(dir)
            .filter(entry => entry.endsWith(".png"))
            .slice(0, limit)
            .map(entry => entry.replace(/\.png$/, ""));
    } catch {
        return [];
    }
}

function assertCharacterName(context: HighLevelContext, name: unknown, where: string): void {
    if (typeof name !== "string" || name === "") {
        return;
    }
    if (assetExists(context.project(), "img/characters", name)) {
        return;
    }
    throw new Error(
        `${where}: img/characters/${name}.png is not in this project, so the event draws nothing. ` +
            `Sheets already here include ${namesIn(context.project(), "img/characters", 8).join(", ")} — or add one with import_asset.`
    );
}

/** A row the game can use: present, and not one of the editor's blank slots. */
function assertRow(project: Project, table: string, id: unknown, where: string): any {
    const numeric = Number(id);
    if (!Number.isInteger(numeric) || numeric < 1) {
        throw new Error(`${where}: ${table} id must be a positive integer, got ${JSON.stringify(id)}`);
    }
    const rows: any[] = project.readData(table);
    const row = rows[numeric];
    if (!row) {
        throw new Error(
            `${where}: ${table}[${numeric}] does not exist (${table}.json has rows up to ${rows.length - 1}). ` +
                `Add one with create_database_entry({table: "${table}"}), or name a row that is there.`
        );
    }
    if (String(row.name ?? "").trim() === "") {
        throw new Error(
            `${where}: ${table}[${numeric}] is a blank slot — the row exists but has no name, so the engine reads it and finds nothing. ` +
                `Name it with patch_database_entry or use a row that has one.`
        );
    }
    return row;
}

interface CellRef {
    mapId: number;
    x: number;
    y: number;
}

/** Can the player stand here? The engine's own passage rules, via the tileset flags. */
function standable(context: HighLevelContext, cell: CellRef): { ok: boolean; why: string } {
    const project = context.project();
    const map = project.readMap(cell.mapId);
    if (!inBounds(map, cell.x, cell.y)) {
        return { ok: false, why: `(${cell.x},${cell.y}) is outside map ${cell.mapId}, which is ${map.width}x${map.height}` };
    }
    const tilesets: any[] = project.readData("Tilesets");
    const tileset = tilesets[map.tilesetId];
    const flags: number[] = tileset?.flags ?? [];
    if (DIRS_FOUR.some(direction => isPassable(map, flags, cell.x, cell.y, direction))) {
        return { ok: true, why: "" };
    }
    const tiles = [0, 1, 2, 3].map(layer => map.data[(layer * map.height + cell.y) * map.width + cell.x] ?? 0).filter(id => id > 0);
    const named = tiles.map(id => `${id}(${kindOf(context.statics(), id)})`).join(", ");
    return {
        ok: false,
        why: `all four directions are blocked by the tileset flags of tile id(s) ${named || "nothing"} on map ${cell.mapId}`
    };
}

function assertStandy(context: HighLevelContext, cell: CellRef, where: string): void {
    const check = standable(context, cell);
    if (!check.ok) {
        throw new Error(`${where}: ${check.why}. Clear it with set_tiles, or move this to a cell on the floor.`);
    }
}

/** The four sides of a cell, in the order a doorway is offered them: into the room first. */
const LAND_ORDER = [8, 6, 4, 2];

function deltaFor(direction: number): [number, number] {
    return direction === 2 ? [0, 1] : direction === 4 ? [-1, 0] : direction === 6 ? [1, 0] : [0, -1];
}

/** The keypad code pointing from `from` to `to`, or 0 when they are not side by side. */
function directionBetween(from: CellRef, to: { x: number; y: number }): number {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (dx === 0 && dy === -1) return 8;
    if (dx === 0 && dy === 1) return 2;
    if (dx === -1 && dy === 0) return 4;
    if (dx === 1 && dy === 0) return 6;
    return 0;
}

/**
 * Where a player comes out of a door.
 *
 * Not on the doorway: `Game_Player.performTransfer` leaves the player standing still,
 * and `updateNonmoving` only re-reads player-touch events on a frame the player *was*
 * moving, so arriving on the far door does not fire it — it parks the player on top of
 * the portal they may want to use again, under its own graphic, one keypress from
 * having to step off and back on. So the default is the first open, uneventful cell
 * beside the far door, facing away from it. A door walled in on all four sides has no
 * such cell and keeps its own tile, which `how` reports so the reply can say so too.
 */
function arrivalFor(
    context: HighLevelContext,
    door: CellRef,
    options: { land?: { x: number; y: number }; shift: boolean; direction?: number }
): { ok: boolean; x: number; y: number; direction: number; how: string; why: string; warn: string | null } {
    const keep = options.direction;
    if (options.land) {
        const cell = { mapId: door.mapId, x: options.land.x, y: options.land.y };
        const check = standable(context, cell);
        return {
            ok: check.ok,
            x: cell.x,
            y: cell.y,
            direction: keep ?? directionBetween(door, cell),
            how: "the cell `land` named",
            why: check.why,
            warn: null
        };
    }
    if (!options.shift) {
        // A one-way drop writes no event at the far end, so those coordinates *are* the arrival.
        const check = standable(context, door);
        return { ok: check.ok, x: door.x, y: door.y, direction: keep ?? 0, how: "the destination itself", why: check.why, warn: null };
    }
    const map = context.project().readMap(door.mapId);
    for (const direction of LAND_ORDER) {
        const [dx, dy] = deltaFor(direction);
        const cell = { mapId: door.mapId, x: door.x + dx, y: door.y + dy };
        if (!inBounds(map, cell.x, cell.y)) {
            continue;
        }
        if (!standable(context, cell).ok || eventAt(map, cell.x, cell.y)) {
            continue;
        }
        return { ok: true, x: cell.x, y: cell.y, direction: keep ?? direction, how: `beside it, one cell ${offsetName(dx, dy)}`, why: "", warn: null };
    }
    return {
        ok: true,
        x: door.x,
        y: door.y,
        direction: keep ?? 0,
        how: "on the doorway, because every cell beside it is wall, the map edge or another event",
        why: "",
        warn:
            `link_maps: the door at map ${door.mapId} (${door.x},${door.y}) has no open cell beside it, so the player arrives on the doorway itself. ` +
            "They have to step off it and back on to use it again; `land` names a cell somewhere else, or clear a neighbour with set_tiles."
    };
}

function offsetName(dx: number, dy: number): string {
    return dy === -1 ? "above" : dy === 1 ? "below" : dx === -1 ? "to the left" : "to the right";
}

interface PageSpec {
    conditions?: Record<string, unknown>;
    image?: Record<string, unknown>;
    trigger?: number;
    priorityType?: number;
    moveType?: number;
    moveSpeed?: number;
    moveFrequency?: number;
    walkAnime?: boolean;
    stepAnime?: boolean;
    through?: boolean;
    directionFix?: boolean;
    moveRoute?: RouteCommand[];
    list: Command[];
}

function assertLists(pages: PageSpec[], where: string): string[] {
    const warnings: string[] = [];
    pages.forEach((page, index) => {
        if (page.list.length === 0) {
            throw new Error(`${where} page ${index}: would hold no commands at all, not even the code-0 terminator`);
        }
        for (const command of page.list) {
            try {
                assertCommandWellFormed(command);
            } catch (error) {
                throw new Error(`${where} page ${index}: ${(error as Error).message}`);
            }
        }
        for (const warning of blockStructureWarnings(page.list)) {
            warnings.push(`page ${index}: ${warning}`);
        }
    });
    return warnings;
}

/**
 * MZ always ends a command list with `{code: 0, indent: 0}`, and it *also* writes a
 * code-0 line inside a list to close one choice or battle branch — so "contains a 0" is
 * not the test. Only the last entry says whether the list itself is terminated.
 */
function withTerminator(steps: Command[]): Command[] {
    const list = steps.map(item => ({ ...item }));
    const last = list[list.length - 1];
    if (!last || last.code !== 0 || last.indent !== 0) {
        list.push(END());
    }
    return list;
}

/** Add commands before the terminator, which is where MZ puts them. */
function appendBeforeEnd(page: PageSpec, commands: Command[]): void {
    const list = page.list;
    const holder = { list } as any;
    appendCommands(holder, commands);
    page.list = holder.list;
}

/**
 * Create or rebuild one event and write its pages, in order: place, page settings,
 * commands, and finally the page's own movement route — `set_event_page` has no surface
 * for a route because it is part of the page, not a setting of it.
 */
async function writeEvent(
    context: HighLevelContext,
    spec: {
        mapId: number;
        x?: number;
        y?: number;
        name?: string;
        note?: string;
        eventId?: number;
        pageIndex?: number;
        replace?: boolean;
        pages: PageSpec[];
    }
): Promise<{ eventId: number; replaced: number | null; warnings: string[] }> {
    const project = context.project();
    let replaced: number | null = null;
    let eventId = spec.eventId ?? 0;
    if (spec.eventId) {
        const map = project.readMap(spec.mapId);
        if (!getEvent(map, spec.eventId)) {
            throw new Error(`Event ${spec.eventId} is not on map ${spec.mapId}`);
        }
    } else {
        if (spec.x === undefined || spec.y === undefined) {
            throw new Error("A new event needs x and y");
        }
        if (spec.replace !== false && spec.name) {
            const found = await context.call("find_events", { mapId: spec.mapId, name: spec.name, limit: 100 });
            for (const hit of found.hits ?? []) {
                // find_events matches by substring, so only a full-name match is this event.
                if (hit.name === spec.name) {
                    await context.call("remove_event", { mapId: spec.mapId, eventId: hit.eventId });
                    replaced = hit.eventId;
                }
            }
        }
        const placed = await context.call("place_event", stripUndefined({ mapId: spec.mapId, x: spec.x, y: spec.y, name: spec.name, note: spec.note }));
        eventId = Number(placed.id);
    }
    const startIndex = spec.eventId ? spec.pageIndex ?? 0 : 0;
    const warnings: string[] = [];
    for (const [offset, page] of spec.pages.entries()) {
        const pageIndex = startIndex + offset;
        const written = await context.call(
            "set_event_page",
            stripUndefined({
                mapId: spec.mapId,
                eventId,
                pageIndex,
                // A page keeps whatever the last write left unless it is told otherwise, and
                // the editor's own default for a new page is "same as tiles" — which is what
                // silently turns a walkable NPC into a wall. Priority is therefore explicit.
                priorityType: page.priorityType ?? 0,
                trigger: page.trigger ?? 0,
                image: page.image,
                conditions: page.conditions,
                moveType: page.moveType,
                moveSpeed: page.moveSpeed,
                moveFrequency: page.moveFrequency,
                walkAnime: page.walkAnime,
                stepAnime: page.stepAnime,
                through: page.through,
                directionFix: page.directionFix
            })
        );
        void written;
        const commands = await context.call("set_commands", { mapId: spec.mapId, eventId, pageIndex, list: page.list });
        for (const warning of commands.warnings ?? []) {
            warnings.push(`page ${pageIndex}: ${warning}`);
        }
        if (page.moveRoute) {
            const map = project.readMap(spec.mapId);
            const event = getEvent(map, eventId);
            if (!event) {
                throw new Error(`Event ${eventId} vanished while its movement route was being written`);
            }
            event.pages[pageIndex].moveRoute = {
                list: page.moveRoute,
                repeat: true,
                skippable: false,
                wait: false
            };
            // moveType 1 is "custom route"; nothing else makes the engine run it.
            event.pages[pageIndex].moveType = 1;
            project.writeMap(spec.mapId, map);
        }
    }
    return { eventId, replaced, warnings };
}

// ---------------------------------------------------------------------------
// Command auditing, shared by validate_game and the authoring tools' pre-write check
// ---------------------------------------------------------------------------

interface Problem {
    severity: "error" | "warning";
    what: string;
    fix: string;
}

/** Every database id an event command reads, straight out of Game_Interpreter. */
const REFERENCED_ROWS: { code: number; table: string; param: number; when?: (parameters: any[]) => boolean }[] = [
    { code: 117, table: "CommonEvents", param: 0 },
    { code: 126, table: "Items", param: 0 },
    { code: 127, table: "Weapons", param: 0 },
    { code: 128, table: "Armors", param: 0 },
    { code: 282, table: "Tilesets", param: 0 },
    { code: 303, table: "Actors", param: 0 },
    { code: 321, table: "Classes", param: 1 },
    { code: 301, table: "Troops", param: 1, when: parameters => parameters[0] === 0 },
    { code: 302, table: "Items", param: 1, when: parameters => (parameters[0] ?? 0) === 0 },
    { code: 302, table: "Weapons", param: 1, when: parameters => parameters[0] === 1 },
    { code: 302, table: "Armors", param: 1, when: parameters => parameters[0] === 2 },
    { code: 605, table: "Items", param: 1, when: parameters => (parameters[0] ?? 0) === 0 },
    { code: 605, table: "Weapons", param: 1, when: parameters => parameters[0] === 1 },
    { code: 605, table: "Armors", param: 1, when: parameters => parameters[0] === 2 }
];

const AUDIO_FOLDERS: Record<number, string> = { 241: "audio/bgm", 245: "audio/bgs", 249: "audio/me", 250: "audio/se" };

interface Limits {
    switches: number;
    variables: number;
}

function commandProblems(context: HighLevelContext, command: Command, limits: Limits): Problem[] {
    const parameters = command.parameters ?? [];
    const problems: Problem[] = [];
    for (const reference of REFERENCED_ROWS) {
        if (command.code !== reference.code || (reference.when && !reference.when(parameters))) {
            continue;
        }
        const id = Number(parameters[reference.param]);
        const rows: any[] = context.project().readData(reference.table);
        const row = rows[id];
        if (!Number.isInteger(id) || id < 1) {
            problems.push({ severity: "error", what: `command ${command.code} names ${reference.table}[${JSON.stringify(parameters[reference.param])}]`, fix: `use a real ${reference.table} id` });
        } else if (!row) {
            problems.push({
                severity: "error",
                what: `command ${command.code} reads ${reference.table}[${id}], which does not exist`,
                fix: `create_database_entry({table: "${reference.table}"}) or point it at a row that is there`
            });
        } else if (String(row.name ?? "").trim() === "" && reference.table !== "Tilesets" && reference.table !== "CommonEvents") {
            problems.push({
                severity: "error",
                what: `command ${command.code} reads ${reference.table}[${id}], a blank slot with no name, so the engine finds nothing there`,
                fix: `name ${reference.table}[${id}] with patch_database_entry, or use a row that has one`
            });
        }
    }
    if (command.code === 121) {
        const [first, last] = [Number(parameters[0]), Number(parameters[1])];
        if (first > last) {
            problems.push({ severity: "error", what: `Control Switches goes ${first}..${last}, which the engine reads as an empty range`, fix: "pass the lower id first" });
        }
        if (last >= limits.switches) {
            problems.push({
                severity: "error",
                what: `Control Switches writes switch ${last}, past the end of System.switches (${limits.switches} slots), so the value is dropped in silence`,
                fix: 'grow the table first: patch_database_entry({table: "System", patch: {switches: {"<id>": "<name>"}}}) accepts an object keyed by id'
            });
        }
    }
    if (command.code === 122) {
        const last = Number(parameters[1]);
        if (last >= limits.variables) {
            problems.push({
                severity: "error",
                what: `Control Variables writes variable ${last}, past the end of System.variables (${limits.variables} slots), so nothing is remembered`,
                fix: 'grow the table first: patch_database_entry({table: "System", patch: {variables: {"<id>": "<name>"}}})'
            });
        }
    }
    if (command.code === 111) {
        if (parameters[0] === 0 && Number(parameters[1]) >= limits.switches) {
            problems.push({ severity: "error", what: `a Conditional Branch tests switch ${parameters[1]}, past the end of System.switches, so it reads as always OFF`, fix: "name the switch before testing it" });
        }
        if (parameters[0] === 1 && Number(parameters[1]) >= limits.variables) {
            problems.push({ severity: "error", what: `a Conditional Branch tests variable ${parameters[1]}, past the end of System.variables, so it reads as always 0`, fix: "name the variable before testing it" });
        }
    }
    const audio = AUDIO_FOLDERS[command.code];
    if (audio) {
        const name = parameters[0]?.name;
        if (typeof name === "string" && name && !audioExists(context.project(), audio, name)) {
            problems.push({ severity: "warning", what: `command ${command.code} plays "${name}", which is not in ${audio}`, fix: `import_asset the file or correct the name (files live at ${audio}/<name>.ogg)` });
        }
    }
    if (command.code === 101 && typeof parameters[0] === "string" && parameters[0] && !assetExists(context.project(), "img/faces", parameters[0])) {
        problems.push({ severity: "warning", what: `the dialog names face "${parameters[0]}", which is not in img/faces`, fix: "import_asset it or clear faceName" });
    }
    return problems;
}

function limitsOf(project: Project): Limits {
    const system = project.readData("System");
    return {
        switches: Array.isArray(system.switches) ? system.switches.length : 0,
        variables: Array.isArray(system.variables) ? system.variables.length : 0
    };
}

/** An authoring tool refuses to write a command that names something the game does not have. */
function assertCommandsUsable(context: HighLevelContext, list: Command[], where: string): void {
    const limits = limitsOf(context.project());
    for (const [index, command] of list.entries()) {
        for (const problem of commandProblems(context, command, limits)) {
            if (problem.severity === "error") {
                throw new Error(`${where} step ${index} (code ${command.code}): ${problem.what}. Fix: ${problem.fix}`);
            }
        }
    }
}

/** A missing sound file is worth saying out loud at the moment it is written, but it is not
 *  a reason to refuse the call: projects add audio after the events are laid out. */
function warnMissingAudio(context: HighLevelContext, name: string | undefined, folder: string, warnings: string[]): void {
    if (name && !audioExists(context.project(), folder, name)) {
        warnings.push(`${folder}: "${name}" is not in this project, so that step is silent — look at what ${folder}/ holds, or add the file with import_asset`);
    }
}

// ---------------------------------------------------------------------------
// Proof
// ---------------------------------------------------------------------------

async function proofImages(context: HighLevelContext, mapIds: number[]): Promise<{ parts: any[]; note: string }> {
    const parts: any[] = [];
    const notes: string[] = [];
    for (const mapId of [...new Set(mapIds)]) {
        try {
            const { payload, image } = await context.callWithImage("render_map", { mapId, showEvents: true });
            if (image) {
                parts.push({ type: "image", data: image.data, mimeType: image.mimeType });
                notes.push(`render_map ${mapId} at ${(payload.pixels ?? []).join("x")}`);
            }
        } catch (error) {
            notes.push(`render_map ${mapId} failed: ${(error as Error).message}`);
        }
    }
    if (context.liveActive()) {
        try {
            const { payload, image } = await context.callWithImage("live_screenshot", {});
            if (image) {
                parts.push({ type: "image", data: image.data, mimeType: image.mimeType });
                notes.push(`live_screenshot of the running game in scene ${payload.scene}`);
            }
        } catch (error) {
            notes.push(`live_screenshot skipped: ${(error as Error).message}`);
        }
    }
    return { parts, note: notes.join("; ") || "no picture was produced" };
}

function reply(payload: unknown, parts: any[]): { content: any[] } {
    return { content: [...parts, { type: "text", text: JSON.stringify(payload, null, 2) }] };
}

/** The shape every write tool answers with: what changed, what was written, proof. */
async function done(
    context: HighLevelContext,
    tool: string,
    payload: Record<string, unknown>,
    mapIds: number[],
    wrote: string[],
    escapes: string[],
    warnings: string[] = []
): Promise<{ content: any[] }> {
    const { parts, note } = await proofImages(context, mapIds);
    return reply(
        {
            ok: true,
            tool,
            ...payload,
            wrote,
            proof: note,
            ...(warnings.length ? { warnings } : {}),
            ...(escapes.length ? { escapeHatches: [...new Set(escapes)] } : {})
        },
        parts
    );
}

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const imageSchema = z
    .object({
        characterName: z.string().optional().describe("A sheet in img/characters; the ! and $ prefixes mean the same as in the editor"),
        characterIndex: z.number().int().min(0).max(7).optional().describe("Which of the eight characters on the sheet"),
        direction: z.union([z.literal(2), z.literal(4), z.literal(6), z.literal(8)]).optional().describe("2 down, 4 left, 6 right, 8 up"),
        pattern: z.number().int().min(0).max(2).optional(),
        tileId: z.number().int().min(0).max(8191).optional().describe("A tileset tile instead of a character sheet — what chests, doors and signs use")
    })
    .describe("The event's graphic. A characterName that is not in img/characters fails the call");

const pageWhenSchema = z
    .object({
        switch: z.number().int().optional(),
        switch2: z.number().int().optional().describe("A page can ask for two switches at once"),
        selfSwitch: z.enum(["A", "B", "C", "D", "a", "b", "c", "d"]).optional().describe("This event's own switch, so a copied chest starts closed again"),
        variable: z
            .union([
                z.number().int(),
                z.object({ id: z.number().int(), atLeast: z.number().int().optional() }).optional()
            ])
            .optional()
            .describe("True when the variable is at or above the value; MZ has no other page comparison"),
        item: z.number().int().optional().describe("True while the party holds this item"),
        actor: z.number().int().optional().describe("True while this actor is in the party")
    })
    .describe("What turns this page on — only what a page can test: switches ON, a self switch, variable >= value, an item held, an actor in the party");

const saySchema = z.union([z.string(), z.array(z.string()), z.record(z.string(), z.unknown())]).describe("A line, a list of lines, or {lines, speaker?, faceName?, faceIndex?, background?, positionType?}");

function stepsSchema(extra: string) {
    return z.array(z.record(z.string(), z.unknown())).describe(`${extra} ${STEP_DOC}`);
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The engine keys a project has to carry
// ---------------------------------------------------------------------------

/**
 * Paths the engine dereferences without a fallback. The list is every
 * `$dataSystem.*` read in the corescript that reaches a property or a method on
 * what it got, taken from v1.8.0's source rather than guessed. They matter
 * because a project does not always come from the editor: `data/newdata` in the
 * installation is a third starting point, and its `advanced` block has no
 * `windowOpacity` — the game then dies on the title screen's first window, with
 * a stack that names `clamp` and nothing about the missing key.
 *
 * `defaultValue` is only carried where the shipped template does not have the key
 * either, which is the whole of why `fix_project` can fill it from your own
 * installation everywhere else: the values belong to a licensed engine, so this
 * package does not reproduce them.
 */
const ENGINE_READS: { path: string; why: string; fix: string; defaultValue?: unknown }[] = [
    { path: "locale", why: "TextManager and the windows call `.match()` on it", fix: 'patch_database_entry({table: "System", patch: {locale: "en"}})' },
    { path: "advanced.gameId", why: "it names the save files, so a missing one writes saves nothing can list", fix: 'patch_database_entry({table: "System", patch: {advanced: {gameId: 10000000}}})' },
    { path: "advanced.screenWidth", why: "Graphics.resize() is handed undefined and the canvas has no size", fix: "patch advanced.screenWidth — 816 is the MZ default" },
    { path: "advanced.screenHeight", why: "Graphics.resize() is handed undefined and the canvas has no size", fix: "patch advanced.screenHeight — 624 is the MZ default" },
    { path: "advanced.uiAreaWidth", why: "the box windows are laid out inside becomes NaN", fix: "patch advanced.uiAreaWidth — the same as screenWidth unless the game targets a phone" },
    { path: "advanced.uiAreaHeight", why: "the box windows are laid out inside becomes NaN", fix: "patch advanced.uiAreaHeight — the same as screenHeight unless the game targets a phone" },
    { path: "advanced.mainFontFilename", why: "FontManager.load() is handed undefined for the main font", fix: 'patch advanced.mainFontFilename — the woff the engine ships' },
    { path: "advanced.numberFontFilename", why: "FontManager.load() is handed undefined for the number font", fix: "patch advanced.numberFontFilename — the woff the engine ships" },
    { path: "advanced.fallbackFonts", why: 'every font family string becomes "rmmz-mainfont, undefined"', fix: 'patch advanced.fallbackFonts — "Verdana, sans-serif" is the MZ default' },
    { path: "advanced.fontSize", why: "windows size their text from it", fix: "patch advanced.fontSize — 26 is the MZ default" },
    {
        path: "advanced.windowOpacity",
        why: "Window_Base.updateBackOpacity calls `.clamp` on the value, which throws and stops the game on the title screen",
        fix: 'fix_project, or patch_database_entry({table: "System", patch: {advanced: {windowOpacity: 192}}}) — 192 is what the editor writes',
        defaultValue: 192
    },
    { path: "terms.basic", why: "the windows index it for the level/hp/mp words", fix: "patch terms.basic with the 10-entry array the editor writes" },
    { path: "terms.commands", why: "the menu and battle commands read it by index", fix: "patch terms.commands with the 26-entry array the editor writes" },
    { path: "terms.messages", why: "every built-in message string comes from it", fix: "patch terms.messages with the message groups the editor writes" },
    { path: "terms.params", why: "the status screens read 10 entries by index", fix: "patch terms.params with the 10-entry array the editor writes" }
];

/** Read `a.b.c` out of an object, or undefined as soon as a step is missing. */
function readPath(root: any, path: string): unknown {
    return path.split(".").reduce((node: any, key) => (node === null || node === undefined ? undefined : node[key]), root);
}

/** Write `a.b.c`, creating the object at `a` when the project does not have one. */
function writePath(root: any, path: string, value: unknown): void {
    const steps = path.split(".");
    let node = root;
    for (const key of steps.slice(0, -1)) {
        if (typeof node[key] !== "object" || node[key] === null) {
            node[key] = {};
        }
        node = node[key];
    }
    node[steps[steps.length - 1]] = value;
}

/** The switch and variable name tables as the array the engine indexes, from either shape. */
function namesAsArray(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.map(name => String(name ?? ""));
    }
    const names: string[] = [];
    if (value && typeof value === "object") {
        for (const [key, name] of Object.entries(value as Record<string, unknown>)) {
            const id = Number(key);
            if (Number.isInteger(id) && id >= 0) {
                names[id] = String(name ?? "");
            }
        }
    }
    return names.map(name => name ?? "");
}

/**
 * The engine's own starting project, next to the corescript the renderer was pointed at:
 * `<install>/data/newdata`. Same rule `verify:newdata` uses. Read-only — this is where the
 * values a copied project is missing come from, so that the package itself ships none of
 * them.
 */
function templateSystemPath(): string | null {
    const root = process.env.RMMZ_CORESCRIPT_ROOT;
    return root ? join(dirname(root), "newdata", "data", "System.json") : null;
}

export function registerHighLevelTools(context: HighLevelContext): void {
    const { register, guarded } = context;

    register(
        "make_npc",
        {
            title: "Add a character who talks",
            description:
                "Place a non-player character in one call: graphic, movement, what it says, and an optional second page that takes over once a switch or self switch is set. " +
                "The dialog compiles into the shapes the engine reads (Show Text 101 plus one 401 per line; a follow page conditioned on the self switch the first page then sets), " +
                "and the whole thing runs as one transaction — if any part fails, nothing is written. Answers with the map rendered around the new NPC. " +
                "The two defaults worth knowing: priorityType 1 (same as tiles), because a person should block their cell, and `replace` true, so re-running a build script updates this NPC instead of leaving a second copy of it. " +
                "`patrol` writes the page's own movement route, which the editor's moveType 1 runs. For more than talk — choices, gates, battles — use `script` here or make_choice_scene.",
            inputSchema: {
                mapId: z.number().int(),
                x: z.number().int().min(0),
                y: z.number().int().min(0),
                name: z.string().optional().describe("The event's name; also how replace finds this NPC again"),
                image: imageSchema.optional(),
                say: saySchema.optional().describe("What the first page says"),
                script: stepsSchema("The first page's steps instead of plain lines.").optional(),
                follow: z
                    .object({
                        say: saySchema.optional(),
                        script: stepsSchema("The second page's steps.").optional(),
                        when: pageWhenSchema.optional().describe("Defaults to self switch A, which the first page then sets for you")
                    })
                    .optional()
                    .describe("The page that replaces the first once its condition holds"),
                trigger: z.number().int().min(0).max(4).optional().describe("0 action button (an NPC's default), 1 player touch, 2 event touch, 3 autorun, 4 parallel process"),
                priorityType: z.number().int().min(0).max(2).optional().describe("0 below tiles (the player walks through), 1 same as tiles (blocks, the default), 2 above tiles"),
                moveType: z.number().int().min(0).max(4).optional().describe("0 static, 1 custom route (pass patrol), 2 random, 3 toward the player, 4 away"),
                moveSpeed: z.number().int().min(0).max(6).optional(),
                moveFrequency: z.number().int().min(0).max(4).optional(),
                walkAnime: z.boolean().optional(),
                directionFix: z.boolean().optional().describe("Stop the sprite turning as it moves — what a facing-specific shopkeeper needs"),
                through: z.boolean().optional(),
                patrol: z.array(z.record(z.string(), z.unknown())).optional().describe(`A custom movement route, e.g. [{right: true}, {right: true}, {left: true}, {left: true}]. ${ROUTE_DOC}`),
                pages: z
                    .array(
                        z.object({
                            when: pageWhenSchema.optional(),
                            say: saySchema.optional(),
                            script: stepsSchema("This page's steps.").optional(),
                            image: imageSchema.optional(),
                            trigger: z.number().int().min(0).max(4).optional(),
                            priorityType: z.number().int().min(0).max(2).optional(),
                            directionFix: z.boolean().optional(),
                            through: z.boolean().optional()
                        })
                    )
                    .optional()
                    .describe(
                        "Three or more pages, in engine order: the first whose condition holds is the one that runs. Given `pages`, it *is* the page list and every page carries its own say or script — a top-level say/script alongside `pages` is refused, because merging it into every page conditions page 0 on the last page's condition and leaves a mute NPC"
                    ),
                speaker: z.string().optional().describe("Name shown above the dialog box, for every page here"),
                faceName: z.string().optional().describe("Face image from img/faces, for every page here"),
                replace: z.boolean().optional().describe("Rebuild the NPC of this name on this map instead of adding a second one (default true)"),
                note: z.string().optional()
            },
            annotations: { title: "Make an NPC", destructiveHint: true, idempotentHint: true }
        },
        guarded(async (args: any) => {
            const project = context.project();
            const escapes: string[] = [];
            assertCharacterName(context, args.image?.characterName, "make_npc image");
            if (args.faceName && !assetExists(project, "img/faces", args.faceName)) {
                throw new Error(`make_npc: img/faces/${args.faceName}.png is not in this project, so the dialog would draw an empty face slot.`);
            }
            const speak = stripUndefined({ faceName: args.faceName, speaker: args.speaker });
            const shared = {
                image: args.image,
                trigger: args.trigger ?? 0,
                priorityType: args.priorityType ?? 1,
                moveType: args.patrol ? 1 : args.moveType,
                moveSpeed: args.moveSpeed,
                moveFrequency: args.moveFrequency,
                walkAnime: args.walkAnime,
                directionFix: args.directionFix,
                through: args.through,
                say: args.say,
                script: args.script
            };
            const route = args.patrol ? compileRoute(args.patrol, "make_npc patrol", escapes) : null;
            if (args.pages?.length && (args.say !== undefined || args.script?.length)) {
                throw new Error(
                    "make_npc: pages[] replaces the page list, so a top-level say/script has nowhere sensible to go. Merged into every page " +
                        "it conditions page 0 on the condition of the page it was merged with, and the NPC never fires and never says so. " +
                        "Put the first page's words in pages[0]."
                );
            }
            const compilePage = (page: any, index: number): PageSpec => {
                const merged: Record<string, any> = { ...shared, ...stripUndefined(page ?? {}) };
                // A page with neither say nor script keeps the top-level text and only changes
                // the graphic or the condition, which is exactly what an opened chest wants.
                let steps: Command[];
                if (merged.script?.length) {
                    steps = compileSteps(merged.script, `make_npc page ${index + 1}${page?.when ? " (later)" : ""}`, escapes);
                } else if (merged.say !== undefined) {
                    steps = sayWithDefaults(merged.say, speak, `make_npc page ${index + 1} say`);
                } else {
                    throw new Error(`make_npc: page ${index + 1} has neither say nor script, and there is no top-level text to fall back on, so it would be an empty page`);
                }
                return {
                    image: merged.image,
                    trigger: merged.trigger,
                    priorityType: merged.priorityType,
                    moveType: merged.moveType,
                    moveSpeed: merged.moveSpeed,
                    moveFrequency: merged.moveFrequency,
                    walkAnime: merged.walkAnime,
                    directionFix: merged.directionFix,
                    through: merged.through,
                    conditions: page?.when ? pageConditions(page.when, "make_npc when") : undefined,
                    moveRoute: route ?? undefined,
                    list: withTerminator(steps)
                };
            };
            const pages: PageSpec[] = args.pages?.length ? args.pages.map(compilePage) : [compilePage(undefined, 0)];
            if (args.follow) {
                const when = args.follow.when ?? { selfSwitch: "A" };
                const conditions = pageConditions(when, "make_npc follow.when");
                pages.push(compilePage({ ...args.follow, when }, pages.length));
                // The follow page only arrives if something sets its condition, so the first
                // page is made to set it — that is the whole convenience of `follow`.
                const closer: Command[] = conditions.selfSwitch
                    ? [c(123, String(conditions.selfSwitch), 0)]
                    : conditions.switch1Id
                      ? [c(121, Number(conditions.switch1Id), Number(conditions.switch1Id), 0)]
                      : [];
                if (closer.length) {
                    appendBeforeEnd(pages[0], closer);
                }
            }
            const warnings = assertLists(pages, "make_npc");
            // `script` is documented as the page's steps *instead of* plain lines, and it
            // wins. That is the right rule, but an author who passes both and gets a mute
            // NPC has no way to find the rule out, so the drop is named.
            for (const [index, page] of (args.pages?.length ? args.pages : [args]).entries()) {
                if (page?.say !== undefined && page.script?.length) {
                    warnings.push(
                        `page ${index + 1} carries both say and script, and the script is what the page runs — the say lines are dropped. ` +
                            `Say them from inside the script: [{ say: ... }, ...steps].`
                    );
                }
            }
            if (pages.length > 1 && pages.every(page => page.conditions)) {
                warnings.push(
                    "every page of this NPC is behind a condition, so it says nothing at all until one of them holds. That is a real design " +
                        "for a sequenced event, and it is also what a mute NPC looks like — page 1 usually wants no condition."
                );
            }
            assertCommandsUsable(context, pages[0].list, "make_npc");
            assertStandy(context, { mapId: args.mapId, x: args.x, y: args.y }, `make_npc's cell (${args.x},${args.y})`);
            const { value, wrote } = await context.transaction(async () => {
                const built = await writeEvent(context, { mapId: args.mapId, x: args.x, y: args.y, name: args.name, note: args.note, replace: args.replace, pages });
                const decoded = await context.call("decode_commands", { mapId: args.mapId, eventId: built.eventId, pageIndex: 0 });
                return { built, lines: (decoded.lines ?? []).slice(0, 14) };
            });
            return done(
                context,
                "make_npc",
                {
                    mapId: args.mapId,
                    eventId: value.built.eventId,
                    at: [args.x, args.y],
                    name: args.name ?? null,
                    pages: pages.length,
                    priorityType: pages[0].priorityType,
                    ...(value.built.replaced
                        ? {
                              replacedEventId: value.built.replaced,
                              // A fresh event takes the lowest free id, so a rebuild usually lands
                              // on the id the removed event had. Only say something when it moved.
                              ...(value.built.replaced !== value.built.eventId
                                  ? { notice: `An older event of this name (id ${value.built.replaced}) was removed and rebuilt as ${value.built.eventId}; anything that referenced the old id needs updating.` }
                                  : {})
                          }
                        : {}),
                    firstPage: value.lines
                },
                [args.mapId],
                wrote,
                escapes,
                [...warnings, ...value.built.warnings]
            );
        })
    );

    register(
        "make_choice_scene",
        {
            title: "Author an interactive beat in one call",
            description:
                "Write an event's whole script from a step list: dialog, `choice` branches (each option can carry its own `when` gate), `if` over switches, variables, items, gold and buttons, `loop` with `break`, `battle` with win/escape/lose branches, `shop`, transfers, audio, screen effects, `gameOver`. " +
                "This is the tool for a scene rather than a person: pass a cell to place a new event, or an existing eventId and pageIndex to rewrite that page. " +
                "The compiler produces the indentation and the branch markers (402/403, 411/412, 413, 601-603) the engine reads, so a body cannot land outside the branch it belongs to — the mistake that otherwise shows up as a choice that always takes the first option. " +
                "Checked before writing: unknown step names, conditions or commands that name a switch, variable or database row the game does not have, audio and face files the project lacks. One transaction, map rendered back.",
            inputSchema: {
                mapId: z.number().int(),
                script: stepsSchema("The page's whole script."),
                eventId: z.number().int().optional().describe("Rewrite this event instead of placing a new one"),
                pageIndex: z.number().int().min(0).optional().describe("With eventId: which page to replace (default 0)"),
                x: z.number().int().min(0).optional(),
                y: z.number().int().min(0).optional(),
                name: z.string().optional(),
                image: imageSchema.optional(),
                trigger: z.number().int().min(0).max(4).optional().describe("0 action button, 1 player touch, 2 event touch, 3 autorun (fires on entering the map), 4 parallel process. 0 and 1 are checked for a cell the player can stand on; 3 and 4 are not, so an opening cutscene can sit on a wall in the corner the way the editor's own do"),
                priorityType: z.number().int().min(0).max(2).optional().describe("0 below tiles (default: a zone or a cutscene should not block), 1 same as tiles, 2 above"),
                when: pageWhenSchema.optional().describe("Condition for the page this script goes to"),
                replace: z.boolean().optional().describe("With `name`: rebuild the event of that name instead of adding another (default true)")
            },
            annotations: { title: "Make a scripted scene", destructiveHint: true, idempotentHint: true }
        },
        guarded(async (args: any) => {
            const escapes: string[] = [];
            assertCharacterName(context, args.image?.characterName, "make_choice_scene image");
            if (!args.eventId && (args.x === undefined || args.y === undefined)) {
                throw new Error("make_choice_scene: pass x and y to place a new event, or eventId to rewrite one that exists");
            }
            const steps = compileSteps(args.script, "make_choice_scene", escapes);
            const list = withTerminator(steps);
            assertCommandsUsable(context, list, "make_choice_scene");
            const pages: PageSpec[] = [
                {
                    conditions: args.when ? pageConditions(args.when, "make_choice_scene when") : undefined,
                    image: args.image,
                    trigger: args.trigger ?? 0,
                    priorityType: args.priorityType ?? 0,
                    list
                }
            ];
            const warnings = assertLists(pages, "make_choice_scene");
            if ((args.trigger ?? 0) === 3 && !list.some(command => command.code === 123 || command.code === 214)) {
                warnings.push(
                    "make_choice_scene: this page is an autorun that takes no self switch (123) and does not erase itself (214), so it re-arms on every frame its conditions hold — " +
                        "while an event is starting `Game_Map.isEventRunning()` is true, which is what `Game_Player.canMove()` reads, so the player stops being able to walk on that map. " +
                        'End the page with {selfSwitch: {letter: "A"}} and {erase: true}, and give the event a later page conditioned on that self switch.'
                );
            }
            const trigger = args.trigger ?? 0;
            if (args.x !== undefined && args.y !== undefined && (trigger === 0 || trigger === 1)) {
                assertStandy(context, { mapId: args.mapId, x: args.x, y: args.y }, `make_choice_scene's cell (${args.x},${args.y})`);
            }
            const { value, wrote } = await context.transaction(async () => {
                const built = await writeEvent(context, {
                    mapId: args.mapId,
                    x: args.x,
                    y: args.y,
                    name: args.name,
                    eventId: args.eventId,
                    pageIndex: args.pageIndex,
                    replace: args.replace,
                    pages
                });
                const decoded = await context.call("decode_commands", { mapId: args.mapId, eventId: built.eventId, pageIndex: args.eventId ? args.pageIndex ?? 0 : 0 });
                return { built, decoded: (decoded.lines ?? []).slice(0, 30) };
            });
            return done(
                context,
                "make_choice_scene",
                {
                    mapId: args.mapId,
                    eventId: value.built.eventId,
                    pageIndex: args.eventId ? args.pageIndex ?? 0 : 0,
                    steps: args.script.length,
                    commands: list.length,
                    decoded: value.decoded,
                    ...(value.built.replaced ? { replacedEventId: value.built.replaced } : {})
                },
                [args.mapId],
                wrote,
                escapes,
                [...warnings, ...value.built.warnings]
            );
        })
    );

    register(
        "make_chest",
        {
            title: "Add a chest that pays out once",
            description:
                "Place a chest: the closed graphic, the line it says, what it gives, and the opened page that replaces it afterwards. MZ has no chest command, so this writes the two pages the engine does read — page 0 hands out the contents and sets self switch A, page 1 is conditioned on self switch A and shows the open chest. " +
                "Because a self switch is keyed to the event id, `copy_event` of this chest gives a second chest that is closed again. " +
                "`requires` gates the payout with a Conditional Branch rather than a page, so a locked chest stays openable once the key condition arrives instead of silently becoming an unlocked one. " +
                "The contents are checked before anything is written: an id that is a blank slot, or gold that would make this a tax, fails the call.",
            inputSchema: {
                mapId: z.number().int(),
                x: z.number().int().min(0),
                y: z.number().int().min(0),
                name: z.string().optional(),
                contents: z
                    .object({
                        gold: z.number().int().min(0).optional(),
                        items: z.array(z.object({ id: z.number().int(), count: z.number().int().min(1).max(99).optional() })).optional(),
                        weapons: z.array(z.object({ id: z.number().int(), count: z.number().int().min(1).max(99).optional() })).optional(),
                        armors: z.array(z.object({ id: z.number().int(), count: z.number().int().min(1).max(99).optional() })).optional()
                    })
                    .describe("What the chest gives when opened"),
                message: saySchema.optional().describe("Said as it is opened, e.g. \"Inside is a lantern and 40 gold.\""),
                lockedMessage: saySchema.optional().describe("Said when `requires` is not met; default \"It is locked.\""),
                requires: z.record(z.string(), z.unknown()).optional().describe(`What the player must have or have done first, e.g. {switch: 4} or {item: 3}. ${CONDITION_DOC}`),
                graphic: z
                    .object({
                        characterName: z.string().optional(),
                        tileId: z.number().int().min(0).max(8191).optional(),
                        closedIndex: z.number().int().min(0).max(7).optional(),
                        openIndex: z.number().int().min(0).max(7).optional()
                    })
                    .optional()
                    .describe("Defaults to the !Chest sheet every MZ project ships, closed at index 0 and open at index 1"),
                sound: z.string().optional().describe("SE played on opening; default Chest1"),
                replace: z.boolean().optional()
            },
            annotations: { title: "Make a chest", destructiveHint: true, idempotentHint: true }
        },
        guarded(async (args: any) => {
            const project = context.project();
            const escapes: string[] = [];
            const contents = args.contents ?? {};
            const gold = Number(contents.gold ?? 0);
            const items: any[] = contents.items ?? [];
            const weapons: any[] = contents.weapons ?? [];
            const armors: any[] = contents.armors ?? [];
            if (gold === 0 && items.length + weapons.length + armors.length === 0) {
                throw new Error("make_chest: contents is empty, which makes this a decoration — pass gold or at least one item");
            }
            for (const item of items) {
                assertRow(project, "Items", item.id, "make_chest contents.items");
            }
            for (const weapon of weapons) {
                assertRow(project, "Weapons", weapon.id, "make_chest contents.weapons");
            }
            for (const armor of armors) {
                assertRow(project, "Armors", armor.id, "make_chest contents.armors");
            }
            const graphic = args.graphic ?? {};
            const characterName = graphic.characterName ?? (graphic.tileId ? "" : "!Chest");
            assertCharacterName(context, characterName, "make_chest graphic");
            const closed = stripUndefined({ characterName, characterIndex: graphic.closedIndex ?? 0, direction: 2, pattern: 0, tileId: graphic.tileId ?? 0 });
            const opened = stripUndefined({ characterName, characterIndex: graphic.openIndex ?? 1, direction: 2, pattern: 0, tileId: graphic.tileId ?? 0 });
            const payout: Command[] = [
                ...(args.message ? sayCommands(args.message, "make_chest message") : []),
                c(250, audioParam(args.sound ?? "Chest1", "make_chest sound", { volume: 90, pitch: 100 }))
            ];
            if (gold > 0) {
                payout.push(c(125, 0, 0, gold));
            }
            for (const item of items) {
                payout.push(c(126, Number(item.id), 0, 0, Number(item.count ?? 1)));
            }
            for (const weapon of weapons) {
                payout.push(c(127, Number(weapon.id), 0, 0, Number(weapon.count ?? 1), false));
            }
            for (const armor of armors) {
                payout.push(c(128, Number(armor.id), 0, 0, Number(armor.count ?? 1), false));
            }
            // The gain animation and the self switch come last, so the chest closes on the
            // same frame the player sees the prize.
            payout.push(c(212, 0, 1, false), c(123, "A", 0));
            const body: Command[] = args.requires
                ? [
                      conditionCommand(args.requires, "make_chest requires"),
                      ...indent_by(1, payout),
                      c(411),
                      ...indent_by(1, sayCommands(args.lockedMessage ?? "It is locked.", "make_chest lockedMessage")),
                      c(412)
                  ]
                : payout;
            const pages: PageSpec[] = [
                { image: closed, trigger: 0, priorityType: 1, list: withTerminator(body) },
                { conditions: { selfSwitch: "A" }, image: opened, trigger: 0, priorityType: 1, list: [END()] }
            ];
            const warnings = assertLists(pages, "make_chest");
            assertCommandsUsable(context, body, "make_chest");
            assertStandy(context, { mapId: args.mapId, x: args.x, y: args.y }, `make_chest's cell (${args.x},${args.y})`);
            warnMissingAudio(context, args.sound ?? "Chest1", "audio/se", warnings);
            const { value, wrote } = await context.transaction(async () =>
                writeEvent(context, { mapId: args.mapId, x: args.x, y: args.y, name: args.name, replace: args.replace, pages })
            );
            return done(
                context,
                "make_chest",
                {
                    mapId: args.mapId,
                    eventId: value.eventId,
                    at: [args.x, args.y],
                    contents: { gold, items, weapons, armors },
                    ...(args.requires ? { requires: args.requires } : {}),
                    openedPage: "self switch A",
                    notice: "A chest is priorityType 1, so it blocks its own cell until the second page takes over — that is why a chest you can walk through is usually a chest whose page 2 never matched.",
                    ...(value.replaced ? { replacedEventId: value.replaced } : {})
                },
                [args.mapId],
                wrote,
                escapes,
                [...warnings, ...value.warnings]
            );
        })
    );

    register(
        "link_maps",
        {
            title: "Join two maps with doors",
            description:
                "Write both ends of a connection in one call: a door event on each map that transfers the player to the other, with a graphic (!Door1, a tile, or nothing for an invisible exit), the door sound, the fade, and the direction they arrive facing. " +
                "`a` and `b` are the doorway cells, and a player coming through one does not stop on it: they arrive at the first open cell beside the far door (above it, then right, left, below) facing away, and the reply's `landed` says which cell that was. Pass `land` on an end to choose it yourself — including the doorway cell itself, which is what the transfer onto the threshold used to do. A door walled in on all four sides has nowhere beside it, so it keeps the doorway and the answer carries a warning. " +
                "The reason it exists is the check it does first: a player-touch door only fires when the player can stand on its cell, and a destination cell that is blocked means the player arrives stuck inside a wall with no way back — both of which a transferred playtest surfaces minutes later as 'nothing happens'. " +
                "`requires` writes a locked pair of pages: page 0 refuses, page 1 (conditioned on the switch or item) does the transfer. " +
                "`twoWay: false` leaves the far end alone — no door is written there, so its coordinates are the destination itself and nothing shifts. Both maps come back rendered.",
            inputSchema: {
                a: z
                    .object({
                        mapId: z.number().int(),
                        x: z.number().int().min(0),
                        y: z.number().int().min(0),
                        name: z.string().optional(),
                        land: z.object({ x: z.number().int().min(0), y: z.number().int().min(0) }).optional().describe("Where the player ends up on this map when they come through the other door")
                    })
                    .describe("One end of the link"),
                b: z
                    .object({
                        mapId: z.number().int(),
                        x: z.number().int().min(0),
                        y: z.number().int().min(0),
                        name: z.string().optional(),
                        land: z.object({ x: z.number().int().min(0), y: z.number().int().min(0) }).optional().describe("Where the player ends up on this map when they come through the other door")
                    })
                    .describe("The other end"),
                twoWay: z.boolean().optional().describe("Default true: an event at each end, each leading to the other"),
                graphic: z
                    .union([
                        z.string(),
                        z.object({ characterName: z.string().optional(), characterIndex: z.number().int().optional(), direction: z.number().int().optional(), tileId: z.number().int().optional() }).optional(),
                        z.literal("none")
                    ])
                    .optional()
                    .describe("A sheet name (!Door1), {tileId: n}, or \"none\" for an invisible exit. Default !Door1"),
                sound: z.string().nullable().optional().describe("SE played on the way through; default Door1, pass null for silence"),
                direction: z
                    .union([z.literal(0), z.literal(2), z.literal(4), z.literal(6), z.literal(8)])
                    .optional()
                    .describe("Which way the player faces on arrival; by default they face away from the door they came through, and 0 keeps the direction they were walking (the engine ignores a 0 and leaves the facing alone)"),
                fade: z.number().int().min(0).max(2).optional().describe("0 none, 1 black (default), 2 white"),
                requires: z.record(z.string(), z.unknown()).optional().describe(`Gate both doors behind this condition. ${CONDITION_DOC}`),
                lockedMessage: saySchema.optional().describe("What the locked door says instead of transferring"),
                replace: z.boolean().optional()
            },
            annotations: { title: "Link two maps", destructiveHint: true, idempotentHint: true }
        },
        guarded(async (args: any) => {
            const escapes: string[] = [];
            const project = context.project();
            const ends = [args.a, args.b];
            for (const [index, end] of ends.entries()) {
                const map = project.readMap(end.mapId);
                if (!inBounds(map, end.x, end.y)) {
                    throw new Error(`link_maps: end ${index === 0 ? "a" : "b"} (${end.x},${end.y}) is outside map ${end.mapId}, which is ${map.width}x${map.height}`);
                }
            }
            const twoWay = args.twoWay !== false;
            const warnings: string[] = [];
            const checks: any[] = [];
            const arrivals: any[] = [];
            for (const [index, end] of ends.entries()) {
                const other = ends[1 - index];
                if (!twoWay && index === 1) {
                    continue;
                }
                const here = standable(context, { mapId: end.mapId, x: end.x, y: end.y });
                if (!here.ok) {
                    throw new Error(
                        `link_maps: the door at map ${end.mapId} (${end.x},${end.y}) is not standable — ${here.why}. ` +
                            "A player-touch door only fires when the player steps onto it, so move it one cell onto the floor."
                    );
                }
                const arrival = arrivalFor(context, { mapId: other.mapId, x: other.x, y: other.y }, {
                    land: other.land,
                    shift: twoWay,
                    direction: args.direction
                });
                if (!arrival.ok) {
                    throw new Error(
                        `link_maps: this door lands the player on map ${other.mapId} (${arrival.x},${arrival.y}), which is not standable — ${arrival.why}. ` +
                            "They would arrive stuck with no way back; clear that cell, or point `land` at one that is."
                    );
                }
                if (arrival.warn) {
                    warnings.push(arrival.warn);
                }
                arrivals[index] = arrival;
                checks.push({
                    from: `map ${end.mapId} (${end.x},${end.y})`,
                    to: `map ${other.mapId} (${other.x},${other.y})`,
                    lands: `map ${other.mapId} (${arrival.x},${arrival.y}), ${arrival.how}`,
                    standableAtBothEnds: true
                });
            }
            const graphic =
                args.graphic === "none"
                    ? undefined
                    : typeof args.graphic === "string"
                      ? { characterName: args.graphic, characterIndex: 0, direction: 2, pattern: 0, tileId: 0 }
                      : args.graphic
                        ? { characterIndex: 0, direction: 2, pattern: 0, tileId: 0, ...args.graphic }
                        : { characterName: "!Door1", characterIndex: 0, direction: 2, pattern: 0, tileId: 0 };
            assertCharacterName(context, graphic?.characterName, "link_maps graphic");
            warnMissingAudio(context, args.sound === null ? undefined : (args.sound ?? "Door1"), "audio/se", warnings);
            const { value, wrote } = await context.transaction(async () => {
                const built: any[] = [];
                for (const [index, end] of ends.entries()) {
                    if (index === 1 && args.twoWay === false) {
                        break;
                    }
                    const other = ends[1 - index];
                    const arrival = arrivals[index];
                    const through: Command[] = [
                        ...(args.sound === null ? [] : [c(250, audioParam(args.sound ?? "Door1", "link_maps sound", { volume: 90, pitch: 100 }))]),
                        c(201, 0, other.mapId, arrival.x, arrival.y, arrival.direction, args.fade ?? 1),
                        END()
                    ];
                    const name = end.name ?? `Door to ${other.mapId}:${other.x},${other.y}`;
                    const pages: PageSpec[] = args.requires
                        ? [
                              { image: graphic, trigger: 1, priorityType: 0, list: withTerminator(sayCommands(args.lockedMessage ?? "It will not open.", "link_maps lockedMessage")) },
                              { conditions: pageConditions(args.requires, "link_maps requires"), image: graphic, trigger: 1, priorityType: 0, list: through }
                          ]
                        : [{ image: graphic, trigger: 1, priorityType: 0, list: through }];
                    assertCommandsUsable(context, through, `link_maps door ${name}`);
                    const placed = await writeEvent(context, { mapId: end.mapId, x: end.x, y: end.y, name, replace: args.replace, pages });
                    warnings.push(...placed.warnings);
                    built.push({
                        mapId: end.mapId,
                        eventId: placed.eventId,
                        name,
                        at: [end.x, end.y],
                        to: { mapId: other.mapId, x: other.x, y: other.y },
                        landed: { mapId: other.mapId, x: arrival.x, y: arrival.y, direction: arrival.direction, how: arrival.how },
                        pages: pages.length,
                        ...(placed.replaced ? { replacedEventId: placed.replaced } : {})
                    });
                }
                return built;
            });
            return done(
                context,
                "link_maps",
                { doors: value, checked: checks, ...(args.requires ? { gatedBy: args.requires } : {}), notice: "A door is trigger 1 (player touch) at priorityType 0 (below tiles), so it never blocks the way it is standing in. Each end arrives beside the other door, facing away from it: `landed` says which cell and `land` on that end picks it instead." },
                ends.map((end: any) => end.mapId),
                wrote,
                escapes,
                warnings
            );
        })
    );

    register(
        "make_shop",
        {
            title: "Add a shopkeeper with goods",
            description:
                "One call for a working shop: the keeper's graphic, a greeting, the goods, and a line for after the window closes. " +
                "MZ stores a shop as command 302 carrying the first good in its own parameters plus one 605 line per further good, each [kind, id, priceType, price, purchaseOnly] with kind 0 item / 1 weapon / 2 armor and priceType 0 meaning the row's own price. " +
                "MZ has no purchase branch, so the commands after the goods run when the window closes whatever the player did — this says so in the reply instead of inventing a hook that does not exist. " +
                "Every good is checked first: the row must exist and must not be a blank slot, and a good with no price whose item price is 0 is reported, because that is a free item. " +
                "`when` adds the page that replaces the locked one, which is how a shop that opens after a quest is built.",
            inputSchema: {
                mapId: z.number().int(),
                x: z.number().int().min(0),
                y: z.number().int().min(0),
                name: z.string().optional(),
                image: imageSchema.optional().describe("Default Actor2 index 1 facing up, which is the merchant sheet MZ ships"),
                goods: z
                    .array(
                        z.object({
                            id: z.number().int().describe("The item, weapon or armor row the player buys"),
                            kind: z.enum(["item", "weapon", "armor"]).optional().describe("Which table the id is read from; default item"),
                            price: z.number().int().min(0).optional().describe("Omit to charge the row's own price from the database"),
                            purchaseOnly: z.boolean().optional().describe("true: the player can never sell this good back"),
                            name: z.string().optional().describe("Only to make this reply readable")
                        })
                    )
                    .min(1)
                    .describe("What is on the counter"),
                greeting: saySchema.optional(),
                farewell: saySchema.optional().describe("Said once the shop window closes"),
                when: pageWhenSchema.optional().describe("The shop opens only once this holds; the keeper still greets you before that"),
                denied: saySchema.optional().describe("What the keeper says while the shop is still closed"),
                speaker: z.string().optional(),
                faceName: z.string().optional(),
                replace: z.boolean().optional()
            },
            annotations: { title: "Make a shop", destructiveHint: true, idempotentHint: true }
        },
        guarded(async (args: any) => {
            const project = context.project();
            const escapes: string[] = [];
            assertCharacterName(context, args.image?.characterName, "make_shop image");
            const warnings: string[] = [];
            const goods = args.goods.map((good: any) => {
                const table = good.kind === "weapon" ? "Weapons" : good.kind === "armor" ? "Armors" : "Items";
                const row = assertRow(project, table, good.id, `make_shop goods (${table})`);
                if (good.price === undefined && !Number(row.price)) {
                    warnings.push(`good ${table} ${good.id} "${row.name}" costs ${row.price} in ${table}.json, so it is free at this shop — pass price to charge for it`);
                }
                return { ...good, kind: good.kind ?? "item", table, rowName: row.name };
            });
            const speak = stripUndefined({ faceName: args.faceName, speaker: args.speaker ?? args.name });
            const shopLines = shopCommands({ goods }, "make_shop goods");
            const openBody: Command[] = [
                ...(args.greeting ? sayWithDefaults(args.greeting, speak, "make_shop greeting") : []),
                ...shopLines,
                ...(args.farewell ? sayWithDefaults(args.farewell, speak, "make_shop farewell") : []),
                END()
            ];
            const keeper = {
                image: args.image ?? { characterName: "Actor2", characterIndex: 1, direction: 8, pattern: 0, tileId: 0 },
                trigger: 0,
                // A keeper you walk through is a shop you cannot open, so this one blocks.
                priorityType: 1,
                directionFix: true
            };
            const pages: PageSpec[] = args.when
                ? [
                      { ...keeper, list: withTerminator(sayWithDefaults(args.denied ?? args.greeting ?? "Not today.", speak, "make_shop denied")) },
                      { ...keeper, conditions: pageConditions(args.when, "make_shop when"), list: openBody }
                  ]
                : [{ ...keeper, list: openBody }];
            const structure = assertLists(pages, "make_shop");
            assertCommandsUsable(context, openBody, "make_shop");
            assertStandy(context, { mapId: args.mapId, x: args.x, y: args.y }, `make_shop's cell (${args.x},${args.y})`);
            const { value, wrote } = await context.transaction(async () =>
                writeEvent(context, { mapId: args.mapId, x: args.x, y: args.y, name: args.name, replace: args.replace, pages })
            );
            return done(
                context,
                "make_shop",
                {
                    mapId: args.mapId,
                    eventId: value.eventId,
                    at: [args.x, args.y],
                    goods: goods.map((good: any) => ({ id: good.id, kind: good.kind, name: good.rowName, price: good.price ?? "standard" })),
                    pages: pages.length,
                    ...(value.replaced ? { replacedEventId: value.replaced } : {}),
                    notice: "MZ's shop has no after-purchase branch: the goods are 302/605 lines and the commands after them run when the window closes. To react to one sale, gate a later page or another event on the item the player now holds."
                },
                [args.mapId],
                wrote,
                escapes,
                [...warnings, ...structure, ...value.warnings]
            );
        })
    );

    register(
        "make_encounter_zone",
        {
            title: "Turn a region into a battle zone",
            description:
                "Paint a region, make the troops, and attach the encounter rows in one call. A zone is three writes across two files (layer 5 of the map, then the map's encounter list) plus a Troops row per group, and the row shapes are exactly the ones that break a game when they are guessed: MZ reads `regionSet` unconditionally, so a row without that array throws inside Scene_Map on its first roll and freezes the map mid-walk, and a row without `weight` makes the weight sum NaN so that no row on the map ever rolls. " +
                "A troop entry either names an existing `troopId` or lists `enemies` (ids, or {id, level?, x?, y?}), and the row is cloned from a real troop so its member shape matches what the editor writes. " +
                "Region 0 means the whole map. The reply calls out any row whose region no cell carries, because that is the mistake that makes a zone feel empty rather than broken.",
            inputSchema: {
                mapId: z.number().int(),
                troops: z
                    .array(
                        z.object({
                            troopId: z.number().int().optional().describe("Use an existing Troops row instead of making one"),
                            name: z.string().optional().describe("Name for the row this call creates"),
                            enemies: z
                                .array(z.union([z.number().int(), z.object({ id: z.number().int(), level: z.number().int().optional(), x: z.number().int().optional(), y: z.number().int().optional() })]))
                                .optional()
                                .describe("Who is in the group; each needs a real Enemies row"),
                            weight: z.number().int().min(1).max(100).optional().describe("Frequency among this map's rows (default 3)"),
                            region: z.number().int().min(1).max(255).optional().describe("Only roll on cells carrying this region id; omit to roll anywhere on the map")
                        })
                    )
                    .min(1)
                    .describe("The battle groups that can appear here"),
                encounterStep: z.number().int().min(1).max(200).optional().describe("Steps the player walks between encounter rolls on this map (default 20; MZ's new maps use 30)"),
                region: z
                    .object({
                        id: z.number().int().min(1).max(255),
                        rect: z.object({ x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().min(1).max(250), height: z.number().int().min(1).max(250) }).optional().describe("Fill this block with the region id"),
                        cells: z.array(z.object({ x: z.number().int().min(0), y: z.number().int().min(0) })).optional().describe("Or exactly these cells")
                    })
                    .optional()
                    .describe("Paint the region on layer 5; omit to keep whatever is already painted"),
                clearRegion: z.number().int().min(1).max(255).optional().describe("Erase this region id from the whole map first, so a re-run does not leave the old paint behind"),
                keepExisting: z.boolean().optional().describe("Add to the map's current encounter rows instead of replacing them")
            },
            annotations: { title: "Make an encounter zone", destructiveHint: true, idempotentHint: true }
        },
        guarded(async (args: any) => {
            const project = context.project();
            const escapes: string[] = [];
            const map = project.readMap(args.mapId);
            const troops: any[] = project.readData("Troops");
            const template = troops.find((row: any) => row?.members?.length);
            if (!template && args.troops.some((entry: any) => entry.troopId === undefined)) {
                throw new Error("make_encounter_zone: Troops.json has no row with members to copy the member shape from, so a new troop cannot be built safely");
            }
            const rows: { troopId?: number; made: { name: string; members: any[]; weight: number; region?: number } }[] = [];
            for (const entry of args.troops) {
                if (entry.troopId !== undefined) {
                    const row = assertRow(project, "Troops", entry.troopId, "make_encounter_zone troops");
                    rows.push({ troopId: Number(entry.troopId), made: { name: row.name, members: row.members, weight: entry.weight ?? 3, region: entry.region } });
                    continue;
                }
                const enemies: any[] = entry.enemies ?? [];
                if (enemies.length === 0) {
                    throw new Error(`make_encounter_zone: the troop "${entry.name ?? "?"}" names neither troopId nor enemies`);
                }
                const members = enemies.map((enemy: any) => {
                    const id = Number(isRecord(enemy) ? enemy.id : enemy);
                    assertRow(project, "Enemies", id, "make_encounter_zone enemies");
                    const extra = isRecord(enemy) ? stripUndefined({ level: enemy.level, x: enemy.x, y: enemy.y }) : {};
                    return { ...template.members[0], enemyId: id, ...extra };
                });
                rows.push({ made: { name: entry.name ?? `${members.length} × enemy`, members, weight: entry.weight ?? 3, region: entry.region } });
            }
            let paintedCells = 0;
            const { value, wrote } = await context.transaction(async () => {
                const created: any[] = [];
                const encounters: any[] = [];
                for (const row of rows) {
                    let troopId = row.troopId;
                    let reused = false;
                    if (!troopId) {
                        // Same name means the same fight: a build script that runs twice
                        // should leave one "Cave Bats" troop rather than a list that grows
                        // by one row per run, which is what a re-rolled zone looks like in
                        // the editor's database.
                        const sameName = troops.find((one: any) => one?.name && String(one.name) === String(row.made.name) && Array.isArray(one.members));
                        if (sameName) {
                            troopId = Number(sameName.id);
                            reused = true;
                            if (JSON.stringify(sameName.members) !== JSON.stringify(row.made.members)) {
                                await context.call("patch_database_entry", { table: "Troops", id: troopId, patch: { members: row.made.members } });
                            }
                        }
                    }
                    if (!troopId) {
                        const made = await context.call("create_database_entry", {
                            table: "Troops",
                            copyFrom: template.id,
                            fields: { name: row.made.name, members: row.made.members }
                        });
                        troopId = Number(made.id);
                        created.push({ id: troopId, name: row.made.name, enemies: row.made.members.map((member: any) => member.enemyId) });
                    } else {
                        created.push({ id: troopId, name: row.made.name, existing: true, ...(reused ? { reused: true } : {}) });
                    }
                    encounters.push({ troopId, weight: row.made.weight, regionSet: row.made.region ? [row.made.region] : [] });
                }
                if (args.clearRegion) {
                    const cells: any[] = [];
                    for (let y = 0; y < map.height; y++) {
                        for (let x = 0; x < map.width; x++) {
                            if ((map.data[(LAYER_REGION * map.height + y) * map.width + x] ?? 0) === args.clearRegion) {
                                cells.push({ x, y, layer: LAYER_REGION, tileId: 0 });
                            }
                        }
                    }
                    paintedCells = -cells.length;
                    if (cells.length) {
                        await context.call("set_tiles", { mapId: args.mapId, cells });
                    }
                }
                const cells: any[] = [];
                if (args.region?.rect) {
                    const { x, y, width, height } = args.region.rect;
                    if (x + width > map.width || y + height > map.height) {
                        throw new Error(
                            `make_encounter_zone: the region rectangle at ${x},${y} sized ${width}x${height} hangs off map ${args.mapId} (${map.width}x${map.height}). ` +
                                "Maps are not resized here — a tile array of the wrong length corrupts the file — so create the map at the size you want."
                        );
                    }
                    for (let row = y; row < y + height; row++) {
                        for (let column = x; column < x + width; column++) {
                            cells.push({ x: column, y: row, layer: LAYER_REGION, tileId: args.region.id });
                        }
                    }
                }
                for (const cell of args.region?.cells ?? []) {
                    if (!inBounds(map, cell.x, cell.y)) {
                        throw new Error(`make_encounter_zone: region cell (${cell.x},${cell.y}) is outside map ${args.mapId} (${map.width}x${map.height})`);
                    }
                    cells.push({ x: cell.x, y: cell.y, layer: LAYER_REGION, tileId: args.region.id });
                }
                if (cells.length) {
                    await context.call("set_tiles", { mapId: args.mapId, cells });
                    paintedCells = cells.length;
                }
                const current = args.keepExisting ? ((project.readMap(args.mapId).encounterList ?? []) as any[]).filter((row: any) => !encounters.some(next => next.troopId === row.troopId)) : [];
                await context.call(
                    "set_map_properties",
                    stripUndefined({
                        mapId: args.mapId,
                        encounterStep: args.encounterStep ?? (current.length ? undefined : 20),
                        encounters: [...current, ...encounters]
                    })
                );
                const after = project.readMap(args.mapId);
                return { created, encounters: after.encounterList, encounterStep: after.encounterStep };
            });
            const paintedNow = new Set<number>();
            for (let index = 0; index < map.width * map.height; index++) {
                const region = map.data[(LAYER_REGION * map.height + Math.floor(index / map.width)) * map.width + (index % map.width)] ?? 0;
                if (region) {
                    paintedNow.add(region);
                }
            }
            const unpainted = (value.encounters ?? []).filter((row: any) => row.regionSet?.length && !row.regionSet.some((id: number) => paintedNow.has(id)));
            return done(
                context,
                "make_encounter_zone",
                {
                    mapId: args.mapId,
                    troops: value.created,
                    encounterStep: value.encounterStep,
                    encounters: value.encounters,
                    regionCellsPainted: Math.abs(paintedCells),
                    ...(paintedCells < 0 ? { regionCellsCleared: -paintedCells } : {}),
                    ...(unpainted.length
                        ? {
                              warning:
                                  `The rows for troop ${unpainted.map((row: any) => row.troopId).join(", ")} are limited to region ` +
                                  `${[...new Set(unpainted.flatMap((row: any) => row.regionSet))].join(", ")}, but no cell on map ${args.mapId} carries that id, so they never roll. ` +
                                  "Paint it with this tool's region option, or omit region and let the row roll anywhere on the map."
                          }
                        : { notice: "Encounters roll from steps walked and only after the first few, so proving a zone needs a playtest that moves." })
                },
                [args.mapId],
                wrote,
                escapes
            );
        })
    );

    register(
        "set_tileset_flags",
        {
            title: "Make a tile a wall, a ladder, a bush",
            description:
                "Edit what tiles do, without the editor. MZ keeps this as an 8192-entry `flags` array per tileset: 0x01/0x02/0x04/0x08 are impassable from Down/Left/Right/Up, 0x10 makes those four override the layers underneath, 0x20 ladder, 0x40 bush, 0x80 counter, 0x100 damage floor, 0x200/0x400/0x800 boat/ship/airship, and bits 12 up are the terrain tag. " +
                "Passage is per direction, so `passable: false` is a fence and `blockFrom: [\"up\"]` is a ledge you can step onto but not climb back off. " +
                "One bit has to be handled for you: MZ's 0x10 means \"no effect on passage\" — `Game_Map.checkPassage` skips the tile entirely — and much of the stock tileset (the pillars, trees and statues among others) ships with it set, so writing passage bits into one of those tiles without clearing it reports success and blocks nothing. Any passage change therefore clears 0x10 unless you pass `overwrite: true` on purpose, and the reply says when it did. " +
                "For an A1-A4 autotile the id a map stores is one of 48 shapes of a base pattern and the engine reads the flags of that stored id, so a change is applied across the whole shape group unless `shapes: false` says otherwise; the reply reports which ids moved and what each flag became. " +
                "This reaches every map that uses the tileset at once, which is the point and the danger: `dryRun` shows the before and after without writing, and `validate_game` re-checks the maps that now block.",
            inputSchema: {
                tilesetId: z.number().int(),
                tiles: z
                    .array(
                        z.object({
                            tileId: z.number().int().min(1).max(8191).optional(),
                            range: z.array(z.number().int().min(1).max(8191)).length(2).optional().describe("[first, last] inclusive, within one tileset slot"),
                            passable: z.boolean().optional().describe("true clears all four passage bits, false sets them"),
                            blockFrom: z.array(z.enum(["down", "left", "right", "up"])).optional().describe("Set only these directions, leaving the rest open"),
                            openFrom: z.array(z.enum(["down", "left", "right", "up"])).optional().describe("Clear only these directions"),
                            overwrite: z.boolean().optional().describe("0x10: these four bits win over the tiles under this one"),
                            ladder: z.boolean().optional().describe("0x20: you cannot pass, and the player's movement is not blocked by it either"),
                            bush: z.boolean().optional().describe("0x40: drawn semi-transparent over the player, who must pass through it"),
                            counter: z.boolean().optional().describe("0x80: the player can stand next to it and interact across it — what a shop counter is"),
                            damage: z.boolean().optional().describe("0x100: stepping here costs HP"),
                            boat: z.boolean().optional(),
                            ship: z.boolean().optional(),
                            airship: z.boolean().optional(),
                            terrainTag: z.number().int().min(0).max(15).optional().describe("Bits 12-15; 0 clears it. Affects footstep sounds and what the vehicle rules read"),
                            shapes: z.boolean().optional().describe("For an A1-A4 id, apply to its whole 48-shape group (default true)")
                        })
                    )
                    .min(1),
                dryRun: z.boolean().optional().describe("Report what would change and write nothing")
            },
            annotations: { title: "Set tile passability", destructiveHint: true, idempotentHint: true }
        },
        guarded(async (args: any) => {
            const project = context.project();
            const tilesets: any[] = project.readData("Tilesets");
            const tileset = tilesets[args.tilesetId];
            if (!tileset) {
                throw new Error(`set_tileset_flags: tileset ${args.tilesetId} does not exist (Tilesets.json has ${tilesets.length} slots)`);
            }
            const statics = context.statics();
            const BITS: Record<string, number> = { down: 0x01, left: 0x02, right: 0x04, up: 0x08 };
            const changes: { slot: string; from: number; to: number; before: number[]; after: number[]; clearsOverrideBit: boolean; set: Record<string, unknown> }[] = [];
            for (const entry of args.tiles) {
                if (entry.tileId === undefined && !entry.range) {
                    throw new Error(`set_tileset_flags: a tile entry needs tileId or range, got ${JSON.stringify(entry)}`);
                }
                const from = Number(entry.range ? entry.range[0] : entry.tileId);
                const to = Number(entry.range ? entry.range[1] : entry.tileId);
                if (from > to) {
                    throw new Error(`set_tileset_flags: the range ${from}..${to} counts down; pass [first, last]`);
                }
                const kindFrom = kindOf(statics, from);
                const kindTo = kindOf(statics, to);
                if (kindFrom !== kindTo) {
                    throw new Error(
                        `set_tileset_flags: ${from} is slot ${kindFrom} but ${to} is slot ${kindTo}, and a range has to stay inside one tileset slot ` +
                            "because only A1-A4 store their flags as shape groups. Pass one entry per slot."
                    );
                }
                let first = from;
                let last = to;
                const autotile = ["A1", "A2", "A3", "A4"].includes(kindFrom);
                let asShapes = false;
                if (autotile && entry.shapes !== false) {
                    const group = shapeGroup(statics, from);
                    first = Math.min(first, group.from);
                    last = Math.max(last, group.to);
                    asShapes = true;
                }
                const before: number[] = [];
                for (let id = first; id <= last; id++) {
                    before.push(tileset.flags[id] ?? 0);
                }
                const after = before.map(flag => {
                    let next = flag;
                    const set = (bit: number, on: boolean | undefined) => {
                        if (on === true) {
                            next |= bit;
                        } else if (on === false) {
                            next &= ~bit;
                        }
                    };
                    const touchesPassage =
                        entry.passable !== undefined || entry.blockFrom?.length || entry.openFrom?.length;
                    if (entry.passable === true) {
                        next &= ~0x0f;
                    } else if (entry.passable === false) {
                        next |= 0x0f;
                    }
                    for (const direction of entry.blockFrom ?? []) {
                        next |= BITS[direction];
                    }
                    for (const direction of entry.openFrom ?? []) {
                        next &= ~BITS[direction];
                    }
                    // 0x10 means "no effect on passage": Game_Map.checkPassage `continue`s
                    // past the tile, so its four direction bits are read by nobody. A tile
                    // shipped with that bit set (the pillars and trees in the stock sheets
                    // are) would otherwise accept the new passage bits and block nothing.
                    if (touchesPassage && entry.overwrite === undefined) {
                        next &= ~FLAG_NO_PASSAGE_EFFECT;
                    }
                    set(FLAG_NO_PASSAGE_EFFECT, entry.overwrite);
                    set(FLAG_LADDER, entry.ladder);
                    set(FLAG_BUSH, entry.bush);
                    set(FLAG_COUNTER, entry.counter);
                    set(FLAG_DAMAGE_FLOOR, entry.damage);
                    set(0x200, entry.boat);
                    set(0x400, entry.ship);
                    set(0x800, entry.airship);
                    if (entry.terrainTag !== undefined) {
                        next = (next & ~0xf000) | (Number(entry.terrainTag) << FLAG_TERRAIN_SHIFT);
                    }
                    return next;
                });
                changes.push({
                    slot: kindFrom,
                    from: first,
                    to: last,
                    before,
                    after,
                    clearsOverrideBit:
                        (entry.passable !== undefined || entry.blockFrom?.length || entry.openFrom?.length) &&
                        entry.overwrite === undefined,
                    set: { ...stripUndefined(entry), ...(asShapes ? { shapes: true } : {}) }
                });
            }
            const summarize = (change: (typeof changes)[number]) => ({
                slot: change.slot,
                ids: change.from === change.to ? [change.from] : [change.from, change.to],
                idsTouched: change.to - change.from + 1,
                before: change.before.length === 1 ? hex(change.before[0]) : `${hex(change.before[0])}..${hex(change.before[change.before.length - 1])}`,
                after: change.after.length === 1 ? hex(change.after[0]) : `${hex(change.after[0])}..${hex(change.after[change.after.length - 1])}`,
                flags: describeFlags(change.after[0]),
                ...(change.clearsOverrideBit
                    ? { clearedOverride: "the tile had MZ's 0x10 'no effect on passage' bit set, which makes its direction bits unread — it is cleared so the new passage actually applies" }
                    : {}),
                set: change.set
            });
            if (args.dryRun) {
                return reply(
                    {
                        ok: true,
                        tool: "set_tileset_flags",
                        dryRun: true,
                        tilesetId: args.tilesetId,
                        tilesetName: tileset.name,
                        wouldChange: changes.map(summarize),
                        notice: "Nothing was written. Drop dryRun to apply."
                    },
                    []
                );
            }
            const { value, wrote } = await context.transaction(async () => {
                const rows: any[] = project.readData("Tilesets");
                const target = rows[args.tilesetId];
                for (const change of changes) {
                    for (let offset = 0; offset <= change.to - change.from; offset++) {
                        target.flags[change.from + offset] = change.after[offset];
                    }
                }
                project.writeData("Tilesets", rows);
                const maps = project.listMaps().filter(info => project.readMap(info.id).tilesetId === args.tilesetId);
                return { maps: maps.map(info => ({ id: info.id, name: info.name })) };
            });
            return done(
                context,
                "set_tileset_flags",
                {
                    tilesetId: args.tilesetId,
                    tilesetName: tileset.name,
                    changed: changes.map(summarize),
                    mapsUsingThisTileset: value.maps,
                    notice: "Every map that uses this tileset changed at once. Which maps a tile now stops is what map_connectivity answers, and validate_game re-checks the whole game's reachability."
                },
                value.maps.map((map: any) => map.id),
                wrote,
                []
            );
        })
    );

    register(
        "fix_project",
        {
            title: "Make a project that did not come from the editor bootable",
            description:
                "Write the System.json keys the engine reads without a fallback and this project does not have. An installation ships `data/newdata` as a third way to start a project besides the editor, and that template has no `advanced.windowOpacity`: the game stops on the title screen's first window with a stack that names `clamp` and nothing about the missing key, and a project copied from the template is otherwise indistinguishable. The values come out of your own installation's template — they belong to the engine, so this package does not carry a copy of them; `advanced.windowOpacity` is the one key the template itself lacks, and 192 is what the editor writes. It also puts `switches` and `variables` back into the array shape the engine indexes, and writes only what is genuinely absent, so running it on a project the editor made changes nothing. It does not invent maps, events or a start position: validate_game reports those and set_startup writes them. `dryRun` answers with the plan alone.",
            inputSchema: {
                template: z.string().optional().describe("A System.json to take the missing values from. Default: <install>/data/newdata/data/System.json, found through RMMZ_CORESCRIPT_ROOT"),
                dryRun: z.boolean().optional().describe("Report what would be written and change nothing")
            },
            annotations: { title: "Repair the engine keys a project is missing", destructiveHint: true, idempotentHint: true }
        },
        guarded(async (args: any) => {
            const project = context.project();
            const system = project.readData("System");
            const path = args.template ?? templateSystemPath();
            let template: any = null;
            if (path && existsSync(path)) {
                template = JSON.parse(readFileSync(path, "utf8"));
            }
            const repairs: { path: string; value: unknown; source: string }[] = [];
            const cannotFix: { path: string; why: string }[] = [];
            for (const read of ENGINE_READS) {
                if (readPath(system, read.path) !== undefined) {
                    continue;
                }
                const fromTemplate = template ? readPath(template, read.path) : undefined;
                const value = fromTemplate !== undefined ? fromTemplate : read.defaultValue;
                if (value === undefined) {
                    cannotFix.push({
                        path: `System.${read.path}`,
                        why:
                            `the engine reads it without a fallback (${read.why}) and there is no value to copy: ` +
                            (path ? `${path} does not have it` : "no installation template to read — set RMMZ_CORESCRIPT_ROOT or pass `template`")
                    });
                    continue;
                }
                repairs.push({
                    path: read.path,
                    value,
                    source: fromTemplate !== undefined ? `the template in your installation (${path})` : "the value the editor writes, which the template does not carry"
                });
            }
            const reshaped = ["switches", "variables"].filter(field => !Array.isArray(system[field]));
            if (args.dryRun) {
                return done(
                    context,
                    "fix_project",
                    {
                        dryRun: true,
                        changed: false,
                        planned: repairs,
                        reshaped,
                        everyEngineKeyPresent: repairs.length === 0 && reshaped.length === 0,
                        ...(cannotFix.length ? { cannotFix } : {})
                    },
                    [],
                    [],
                    []
                );
            }
            if (!repairs.length && !reshaped.length) {
                return done(context, "fix_project", { changed: false, everyEngineKeyPresent: true, ...(cannotFix.length ? { cannotFix } : {}) }, [], [], []);
            }
            const { value, wrote } = await context.transaction(async () => {
                const next: any = { ...system };
                for (const repair of repairs) {
                    writePath(next, repair.path, repair.value);
                }
                for (const field of reshaped) {
                    next[field] = namesAsArray(system[field]);
                }
                project.writeData("System", next);
                return { repaired: repairs.map(repair => repair.path), reshaped };
            });
            const after = project.readData("System");
            const stillMissing = ENGINE_READS.filter(read => readPath(after, read.path) === undefined).map(read => `System.${read.path}`);
            return done(
                context,
                "fix_project",
                {
                    changed: true,
                    repaired: value.repaired.map(path => `System.${path}`),
                    tookValuesFrom: repairs[0]?.source,
                    ...(value.reshaped.length ? { normalizedToArrays: value.reshaped } : {}),
                    now: Object.fromEntries(repairs.map(repair => [`System.${repair.path}`, readPath(after, repair.path)])),
                    ...(cannotFix.length ? { cannotFix } : {}),
                    ...(stillMissing.length ? { stillMissing } : {}),
                    next: stillMissing.length ? undefined : "validate_game no longer reports a missing engine key here. It says nothing yet about maps, events or the start position.",
                    notice: "An editor with this project open overwrites these files on save, so reload it before continuing there."
                },
                [],
                wrote,
                []
            );
        })
    );

    register(
        "validate_game",
        {
            title: "Audit the game before playing it",
            description:
                "Read-only check of the things that only show up in play. System: the start position on a map that exists, inside it, on a cell the player can stand, with a party of at least one named actor; the switch and variable tables in the array shape the engine indexes, and every id an event names that is past their end; and the keys the engine dereferences without a fallback (`advanced.windowOpacity` and friends), which is how a project copied from the shipped `data/newdata` template turns out to die on its own title screen. Events: transfer destinations (checked against the destination map's own size and passability), every database id a command reads, encounter rows (a real troop, a `regionSet` that is painted, a non-zero `weight`), pages whose indent does not match the branch they sit under, and the graphics and audio the project does not have — including the picture a Show Picture command names, which nothing else reads, and which only ever loads as `<name>.png`. Also tile ids painted from a slot the tileset has no image for, and reachability from the start through the portals that exist. " +
                "Each problem comes back as {severity, where, what, fix} and `fix` names the call that clears it. This is the gate a build script should pass before a playtest starts, and it never writes.",
            inputSchema: {
                mapIds: z.array(z.number().int()).optional().describe("Restrict the walk to these maps (default: every map in the project)"),
                from: z.object({ mapId: z.number().int(), x: z.number().int().min(0), y: z.number().int().min(0) }).optional().describe("Where reachability starts; default System's start position"),
                audio: z.boolean().optional().describe("Also check referenced audio files (default true)"),
                limit: z.number().int().min(1).max(400).optional().describe("Cap on reported problems (default 120)")
            },
            annotations: { readOnlyHint: true }
        },
        guarded(async (args: any) => {
            const project = context.project();
            const statics = context.statics();
            const system = project.readData("System");
            const infos: any[] = project.readData("MapInfos");
            const tilesets: any[] = project.readData("Tilesets");
            const problems: { severity: "error" | "warning"; where: string; what: string; fix: string }[] = [];
            const limits = limitsOf(project);
            const add = (severity: "error" | "warning", where: string, what: string, fix: string) => {
                if (problems.length < (args.limit ?? 120)) {
                    problems.push({ severity, where, what, fix });
                }
            };
            const mapIds: number[] = args.mapIds ?? project.listMaps().map((info: any) => info.id);

            for (const field of ["switches", "variables"] as const) {
                if (!Array.isArray(system[field])) {
                    add(
                        "error",
                        `System.${field}`,
                        `is ${system[field] === null ? "null" : typeof system[field]}, but the engine indexes it as an array, so every write to a ${field.slice(0, -1)} is dropped`,
                        `patch_database_entry({table: "System", patch: {${field}: {}}}) writes back the array shape`
                    );
                }
            }

            // The table lives at module scope because fix_project repairs exactly what
            // this reports. See ENGINE_READS for why these keys are the ones that matter.
            for (const read of ENGINE_READS) {
                const steps = read.path.split(".");
                let node: any = system;
                for (const key of steps) {
                    node = node?.[key];
                    if (node === undefined) {
                        add("error", `System.${read.path}`, `is absent, and the engine reads it without a fallback: ${read.why}`, read.fix);
                        break;
                    }
                }
            }

            // The opening state of the whole game.
            const startMapId = Number(system.startMapId);
            let reachableFrom: CellRef | null = null;
            if (!infos[startMapId]) {
                add("error", "System.startMapId", `${startMapId} has no map file, so New Game goes nowhere`, "point startMapId at a map that exists, or create_map one");
            } else {
                const cell = { mapId: startMapId, x: Number(system.startX), y: Number(system.startY) };
                const check = standable(context, cell);
                if (!check.ok) {
                    add(
                        "error",
                        `the start position (${cell.x},${cell.y}) on map ${cell.mapId}`,
                        `is not somewhere the player can stand — ${check.why}`,
                        'move it with patch_database_entry({table: "System", patch: {startX, startY}})'
                    );
                } else {
                    reachableFrom = args.from ?? cell;
                }
            }
            const party: number[] = Array.isArray(system.partyMembers) ? system.partyMembers : [];
            if (!party.length) {
                add("error", "System.partyMembers", "is empty, so a new game starts with nobody in it", 'patch_database_entry({table: "System", patch: {partyMembers: [1]}})');
            }
            if (!Array.isArray(system.partyMembers) && system.startActors !== undefined) {
                add("error", "System.startActors", "is an MV key that MZ reads as absent", "use partyMembers instead");
            }
            for (const actorId of party) {
                const actor = project.readData("Actors")[actorId];
                if (!actor || String(actor.name ?? "").trim() === "") {
                    add("error", `the starting party's actor ${actorId}`, actor ? "is a blank slot: no name, no graphic, so the game opens with an invisible leader" : "does not exist", "patch Actors.json or change partyMembers");
                }
            }

            let events = 0;
            let pages = 0;
            let commands = 0;
            const transfers: { where: string; mapId: number; x: number; y: number }[] = [];
            const characters = new Set<string>();
            const pictures = new Set<string>();
            for (const mapId of mapIds) {
                if (!infos[mapId]) {
                    add("error", `map ${mapId}`, "was asked for but has no MapInfos entry", "drop it from mapIds, or create the map");
                    continue;
                }
                const map = project.readMap(mapId);
                const tileset = tilesets[map.tilesetId];
                if (!tileset) {
                    add("error", `map ${mapId}`, `points at tileset ${map.tilesetId}, which does not exist, so the map draws nothing`, "set_map_properties with a tilesetId that exists");
                    continue;
                }
                const paintedRegions = new Set<number>();
                for (let index = 0; index < map.width * map.height; index++) {
                    const region = map.data[(LAYER_REGION * map.height + Math.floor(index / map.width)) * map.width + (index % map.width)] ?? 0;
                    if (region) {
                        paintedRegions.add(region);
                    }
                }
                // A tile from a slot the tileset has no sheet for draws nothing at all.
                const unboundSeen = new Set<string>();
                for (let layer = 0; layer < 4; layer++) {
                    for (let index = 0; index < map.width * map.height; index++) {
                        const tileId = map.data[(layer * map.height + Math.floor(index / map.width)) * map.width + (index % map.width)] ?? 0;
                        if (tileId <= 0) {
                            continue;
                        }
                        const slot = kindOf(statics, tileId);
                        if (unboundSeen.has(slot)) {
                            continue;
                        }
                        if (!sheetBound(tileset, slot)) {
                            unboundSeen.add(slot);
                            add(
                                "warning",
                                `map ${mapId} layer ${layer}`,
                                `paints tile ${tileId}, which is slot ${slot}, but the tileset has no ${slot} image bound — the cell draws nothing and, if the slot's flags are clear, the player walks on air`,
                                "bind the sheet in the tileset or paint tiles from the slots it does have (tileset_slots lists them)"
                            );
                        }
                    }
                }
                for (const row of (map.encounterList ?? []) as any[]) {
                    const troop = project.readData("Troops")[row.troopId];
                    if (!troop || String(troop.name ?? "").trim() === "") {
                        add("error", `map ${mapId}'s encounter row for troop ${row.troopId}`, troop ? "names a blank slot, so the roll has no members" : "names a troop that does not exist", "make_encounter_zone with enemies, or point the row at a real troop");
                    }
                    if (!Array.isArray(row.regionSet)) {
                        add("error", `map ${mapId}'s encounter row for troop ${row.troopId}`, "has no regionSet array, which Scene_Map reads unconditionally and throws on its first roll, freezing the map", "set_map_properties with encounters: [{troopId, weight, regionSet}]");
                    } else if (row.regionSet.length && !row.regionSet.some((id: number) => paintedRegions.has(id))) {
                        add("warning", `map ${mapId}'s encounter row for troop ${row.troopId}`, `is limited to region ${row.regionSet.join("/")}, which no cell on this map carries, so it never rolls`, "paint the region (make_encounter_zone's region) or drop regionSet");
                    }
                    if (!Number(row.weight)) {
                        add("error", `map ${mapId}'s encounter row for troop ${row.troopId}`, `has weight ${JSON.stringify(row.weight)}, which makes the weight sum NaN and stops every row on the map from rolling`, "set weight to 1 or more");
                    }
                }
                for (const event of map.events.filter(Boolean)) {
                    events++;
                    if (!inBounds(map, event.x, event.y)) {
                        add("error", `event ${event.id} "${event.name}" on map ${mapId}`, `stands at (${event.x},${event.y}), outside the map`, "place_event somewhere inside it");
                    }
                    for (const [pageIndex, page] of (event.pages ?? []).entries()) {
                        pages++;
                        const where = `map ${mapId} event ${event.id} "${event.name}" page ${pageIndex}`;
                        if (page.image?.characterName) {
                            characters.add(page.image.characterName);
                        }
                        if ((page.trigger === 3 || page.trigger === 4) && page.priorityType === 1) {
                            add("warning", where, "is an autorun or parallel page at priorityType 1, so it blocks the cell it stands on while the player cannot see a reason", "set priorityType 0 unless the block is the point");
                        }
                        // An autorun re-arms on every frame its conditions hold, and a starting
                        // event is what Game_Map.isEventRunning() reports — the thing
                        // Game_Player.canMove() reads. A page that never turns itself off is a
                        // map the player cannot walk on, and it looks exactly like a frozen game.
                        if (page.trigger === 3 && !(page.list ?? []).some((command: any) => command.code === 123 || command.code === 214)) {
                            add(
                                "warning",
                                where,
                                "is an autorun whose page takes no self switch (123) and does not erase itself (214), so it re-arms every frame and the player cannot move on this map",
                                'end the page with {selfSwitch: {letter: "A"}} and {erase: true}, and condition a later page on that self switch'
                            );
                        }
                        if (!Array.isArray(page.list) || page.list.length === 0) {
                            add("error", where, "has an empty command list, so the page exists and does nothing", "make_choice_scene or set_commands");
                            continue;
                        }
                        if (page.list[page.list.length - 1]?.code !== 0) {
                            add("warning", where, "does not end with the code-0 terminator MZ always writes", "set_commands appends one when it is missing");
                        }
                        for (const warning of blockStructureWarnings(page.list)) {
                            add("error", where, warning, "rewrite the block with make_choice_scene, which indents the bodies for you");
                        }
                        for (const warning of unknownCodeWarnings(context.codebook(), page.list)) {
                            add("warning", where, warning, 'a command a plugin adds is fine; a mistyped code is not, and the editor is the only thing that can tell them apart here');
                        }
                        for (const command of page.list) {
                            commands++;
                            for (const problem of commandProblems(context, command, limits)) {
                                add(problem.severity, where, problem.what, problem.fix);
                            }
                            if (command.code === 201) {
                                transfers.push({ where, mapId: Number(command.parameters[1]), x: Number(command.parameters[2]), y: Number(command.parameters[3]) });
                            }
                            // Show Picture is `[pictureId, name, origin, x, y, ...]`:
                            // `command231` hands params 0..2 straight to
                            // `$gameScreen.showPicture(pictureId, name, origin, …)`, so the
                            // file name is the second parameter. It is the one place a
                            // picture is named, and nothing used to check it.
                            if (command.code === 231 && typeof command.parameters[1] === "string" && command.parameters[1]) {
                                pictures.add(command.parameters[1]);
                            }
                        }
                    }
                }
            }

            for (const transfer of transfers) {
                if (!infos[transfer.mapId]) {
                    add("error", transfer.where, `transfers the player to map ${transfer.mapId}, which does not exist`, "link_maps, or point the transfer at a real map");
                    continue;
                }
                const check = standable(context, transfer);
                if (!check.ok) {
                    add("error", transfer.where, `transfers the player to a cell they cannot stand on (${check.why}); they arrive stuck and cannot walk out`, "move the destination or clear the tile with set_tiles");
                }
            }

            for (const name of characters) {
                if (name && !assetExists(project, "img/characters", name)) {
                    add("error", "an event's graphic", `"${name}" is not in img/characters, so the event is invisible and the player walks into a blank space`, "import_asset the sheet, or fix the name");
                }
            }

            for (const name of pictures) {
                if (name && !assetExists(project, "img/pictures", name)) {
                    add("error", "a Show Picture command", `names "${name}", and no img/pictures/${name}.png is in this project, so the picture never appears`, "import_asset the file under that name — a .jpg will not load, the engine only asks for .png");
                }
            }

            let reachable: number[] | null = null;
            const scope = new Set(mapIds);
            if (reachableFrom && scope.has(reachableFrom.mapId)) {
                try {
                    const walk = await context.call("map_connectivity", {
                        mapId: reachableFrom.mapId,
                        x: reachableFrom.x,
                        y: reachableFrom.y,
                        followTransfers: true,
                        maxMaps: Math.min(200, Math.max(20, mapIds.length * 2))
                    });
                    const walked = (walk.reports ?? []).map((report: any) => report.mapId);
                    reachable = walked;
                    const stranded = mapIds.filter((mapId: number) => infos[mapId] && !walked.includes(mapId));
                    if (stranded.length) {
                        add("warning", "reachability", `nothing leads to map${stranded.length > 1 ? "s" : ""} ${stranded.join(", ")} from the start position`, "link_maps them in, or check the condition the door is gated behind");
                    }
                } catch (error) {
                    add("warning", "reachability", `could not be walked: ${(error as Error).message}`, "fix the start position first, then re-run");
                }
            }
            const reachabilityNote =
                !args.from && args.mapIds?.length
                    ? "reachability was measured from System's start position only when that map is inside the audited scope; pass `from` to walk a scope that excludes it"
                    : undefined;

            const errors = problems.filter(problem => problem.severity === "error");
            return reply(
                {
                    ok: errors.length === 0,
                    tool: "validate_game",
                    checked: {
                        maps: mapIds.length,
                        events,
                        pages,
                        commands,
                        transfers: transfers.length,
                        from: reachableFrom ? `map ${reachableFrom.mapId} (${reachableFrom.x},${reachableFrom.y})` : "not walkable from the start"
                    },
                    counts: { errors: errors.length, warnings: problems.length - errors.length },
                    problems,
                    ...(reachable ? { reachable } : {}),
                    ...(reachabilityNote ? { reachabilityNote } : {}),
                    ...(problems.length >= (args.limit ?? 120) ? { truncated: true } : {})
                },
                []
            );
        })
    );

    register(
        "clear_events",
        {
            title: "Take the events off a map",
            description:
                "Remove every event on a map in one transaction, or only the ones whose name or character sheet you name. This is the call that makes a rebuild script possible: without it, re-painting a map's event layer means one `remove_event` per event and a half-finished map if the script dies halfway, and a build that runs twice ends up with two of every NPC. `dryRun` answers with what would go, which is also the quickest way to see a map's cast. The map is rendered in the reply, so you can look at the empty room rather than trust the count.",
            inputSchema: {
                mapId: z.number().int(),
                name: z.string().optional().describe("Only events with this exact name"),
                characterName: z.string().optional().describe("Only events drawn from this character sheet, e.g. \"!Crystal\""),
                eventId: z.number().int().optional().describe("Only this one event"),
                dryRun: z.boolean().optional()
            },
            annotations: { title: "Clear a map's events", destructiveHint: true, idempotentHint: true }
        },
        guarded(async (args: any) => {
            const project = context.project();
            const map = project.readMap(args.mapId);
            const keeps: string[] = [];
            if (args.name === undefined && args.characterName === undefined && args.eventId === undefined) {
                keeps.push("every event on the map");
            }
            const matches = (map.events ?? []).filter((event: any) => {
                if (!event) {
                    return false;
                }
                if (args.eventId !== undefined && Number(event.id) !== args.eventId) {
                    return false;
                }
                if (args.name !== undefined && String(event.name) !== args.name) {
                    return false;
                }
                if (args.characterName !== undefined && String(event.pages?.[0]?.image?.characterName ?? "") !== args.characterName) {
                    return false;
                }
                return true;
            });
            const summary = matches.map((event: any) => ({ eventId: event.id, name: String(event.name ?? ""), at: [event.x, event.y], pages: (event.pages ?? []).length }));
            if (!matches.length) {
                return done(context, "clear_events", { mapId: args.mapId, removed: [], note: "nothing on this map matches, so nothing was written" }, [args.mapId], [], [], keeps);
            }
            if (args.dryRun) {
                return done(context, "clear_events", { mapId: args.mapId, dryRun: true, wouldRemove: summary }, [args.mapId], [], [], keeps);
            }
            const { value, wrote } = await context.transaction(async () => {
                for (const event of matches) {
                    await context.call("remove_event", { mapId: args.mapId, eventId: event.id });
                }
                return summary;
            });
            return done(context, "clear_events", { mapId: args.mapId, removed: value, count: value.length }, [args.mapId], wrote, [], keeps);
        })
    );

    register(
        "set_startup",
        {
            title: "Set how a new game opens",
            description:
                "Write the opening state of the game in one call: the title on the splash and in the window, where New Game puts the player (map, cell, facing), who starts in the party, and the switch and variable name tables. `patch_database_entry` can do all of it and has to be handed `advanced` whole to touch one key of it, which is the shape of mistake this exists to prevent — a partial nested patch drops the keys you did not send. Idempotent: re-running a build script sets the same opening rather than appending. Reads back the start cell through the engine's own passability rules and refuses to place the player inside a wall, because that is a game that boots and never moves.",
            inputSchema: {
                title: z.string().optional().describe("The game title the engine shows and the save files carry"),
                startMapId: z.number().int().optional(),
                startX: z.number().int().min(0).optional(),
                startY: z.number().int().min(0).optional(),
                startDirection: z.union([z.literal(2), z.literal(4), z.literal(6), z.literal(8)]).optional().describe("2 down, 4 left, 6 right, 8 up"),
                partyMembers: z.array(z.number().int().min(1)).optional().describe("Actor ids, in the order the engine lines them up"),
                switches: z
                    .union([z.array(z.string().nullable()), z.record(z.string(), z.string())])
                    .optional()
                    .describe("Names by index, or keyed by id — either way the array the engine indexes is what gets written"),
                variables: z
                    .union([z.array(z.string().nullable()), z.record(z.string(), z.string())])
                    .optional()
                    .describe("Names by index, or keyed by id"),
                testBattle: z.boolean().optional().describe("Also set the troop the editor's test battle uses"),
                troopId: z.number().int().min(1).optional()
            },
            annotations: { title: "Set the opening state", destructiveHint: true, idempotentHint: true }
        },
        guarded(async (args: any) => {
            const project = context.project();
            const system = project.readData("System");
            const patch: Record<string, unknown> = {};
            const notices: string[] = [];
            if (args.title !== undefined) {
                patch.gameTitle = args.title;
                patch.title = args.title;
            }
            const startMapId = args.startMapId ?? Number(system.startMapId);
            const startX = args.startX ?? Number(system.startX);
            const startY = args.startY ?? Number(system.startY);
            if (args.startMapId !== undefined || args.startX !== undefined || args.startY !== undefined || args.startDirection !== undefined) {
                const cell = { mapId: startMapId, x: startX, y: startY };
                const check = standable(context, cell);
                if (!check.ok) {
                    throw new Error(`set_startup: the player would open at (${cell.x},${cell.y}) on map ${cell.mapId}, which is not somewhere they can stand — ${check.why}`);
                }
                patch.startMapId = startMapId;
                patch.startX = startX;
                patch.startY = startY;
                if (args.startDirection !== undefined) {
                    patch.startDirection = args.startDirection;
                }
            }
            if (args.partyMembers !== undefined) {
                if (!args.partyMembers.length) {
                    throw new Error("set_startup: an empty partyMembers means New Game starts with nobody in it, which the engine survives badly. Name at least one actor.");
                }
                const actors = project.readData("Actors");
                for (const actorId of args.partyMembers) {
                    if (!actors[actorId] || String(actors[actorId].name ?? "").trim() === "") {
                        throw new Error(`set_startup: actor ${actorId} is not a row with a name in Actors.json, so the game would open with an invisible leader`);
                    }
                }
                patch.partyMembers = args.partyMembers;
            }
            for (const field of ["switches", "variables"] as const) {
                if (args[field] !== undefined) {
                    patch[field] = args[field];
                    notices.push(`${field} was rewritten whole; an id an event names past its end is what validate_game looks for`);
                }
            }
            if (args.troopId !== undefined || args.testBattle) {
                const troops = project.readData("Troops");
                const troopId = Number(args.troopId ?? 1);
                if (!troops[troopId]) {
                    throw new Error(`set_startup: troop ${troopId} is not a row in Troops.json, so the test battle has no members`);
                }
                patch.testTroopId = troopId;
                patch.testBattlers = (troops[troopId].members ?? []).map((member: any, index: number) => ({
                    actorId: Number(system.partyMembers?.[Math.min(index, (system.partyMembers?.length ?? 1) - 1)] ?? 1),
                    enemyId: Number(member.enemyId),
                    index: Number(member.index ?? 0),
                    type: Number(member.type ?? 0)
                }));
            }
            if (!Object.keys(patch).length) {
                throw new Error("set_startup: nothing to do — pass title, the start position, partyMembers, switches or variables");
            }
            const { value, wrote } = await context.transaction(async () => {
                const answer = await context.call("patch_database_entry", { table: "System", patch });
                return { patched: answer.patched ?? Object.keys(patch), normalized: answer.normalized ?? [] };
            });
            const after = project.readData("System");
            return done(
                context,
                "set_startup",
                {
                    patched: value.patched,
                    ...(value.normalized.length ? { normalizedToArrays: value.normalized } : {}),
                    now: {
                        gameTitle: after.gameTitle,
                        startMapId: Number(after.startMapId),
                        startX: Number(after.startX),
                        startY: Number(after.startY),
                        startDirection: Number(after.startDirection),
                        partyMembers: after.partyMembers ?? [],
                        switchNames: (after.switches ?? []).filter(Boolean).length,
                        variableNames: (after.variables ?? []).filter(Boolean).length
                    }
                },
                Number.isInteger(Number(after.startMapId)) ? [Number(after.startMapId)] : [],
                wrote,
                [],
                notices
            );
        })
    );

    register(
        "make_map",
        {
            title: "Build a whole map in one call",
            description:
                "One intent — \"a 26x18 field of grass, with a stone floor and a wall ring and a gap for the door\" — as one call. It makes or reuses the map, sets its tileset, resolves the entire paint plan, writes it in one pass, applies the passage flags the plan names, and answers with the rendered map. Before this the high-level layer stopped at content and every build script had to drop to `create_map` + `set_tiles` per map, which is where the depth mistakes came from.\n" +
                "The plan is resolved to **one tile per cell, the last stroke winning**, because that is how the engine decides passage: `Game_Map.checkPassage` reads tile layers 3 down to 0 and returns on the first tile whose flags say something, so a wall left on layer 3 underneath a floor tile still blocks the doorway — the map renders as a room and the player cannot walk out of it. Paint ground first, then what sits on it, and nothing is ever stacked. On a repaint the plan owns the cell's whole stack: every layer it does not name is zeroed, so last run's roof cannot survive under this run's floor.\n" +
                "Each tile still lands on the layer its own slot belongs to (A1/A2 → 1, A3 → 2, A4 → 3, A5/B–E → 0); that is `set_tiles` with `layer` omitted, so a forest is never buried under the grass again.\n" +
                "`flags` is handed to `set_tileset_flags` for this map's tileset in the same transaction, so \"these ids are walls\" is stated where the walls are painted. `regions` paints layer 5 for `make_encounter_zone` to roll on. The reply counts the walkable cells the finished terrain leaves, because a map with no walkable cell is not something the engine will report — it is a game that boots and never moves.",
            inputSchema: {
                name: z.string().optional().describe("The map's name in the map tree"),
                find: z.string().optional().describe("Reuse the map whose tree name equals this, making it if there is none — the idempotent form for a build script"),
                mapId: z.number().int().optional().describe("Re-paint this map instead of making one"),
                width: z.number().int().min(1).max(250).optional().describe("Required for a new map; ignored on a repaint (resizing means rebuilding the tile array)"),
                height: z.number().int().min(1).max(250).optional(),
                tilesetId: z.number().int().optional().describe("Required for a new map; changing it on a repaint re-reads every tile id against the new flags"),
                parentId: z.number().int().optional().describe("Map-tree parent for a new map (default 1)"),
                fill: z.number().int().min(1).max(8191).optional().describe("Tile id for every cell, under all the paint strokes"),
                paint: z
                    .array(
                        z.object({
                            tile: z.number().int().min(0).max(8191).describe("0 erases the cell"),
                            x: z.number().int().min(0).optional(),
                            y: z.number().int().min(0).optional(),
                            width: z.number().int().min(1).max(250).optional(),
                            height: z.number().int().min(1).max(250).optional(),
                            cells: z.array(z.object({ x: z.number().int().min(0), y: z.number().int().min(0) })).optional().describe("Or exactly these cells instead of a rectangle")
                        })
                    )
                    .optional()
                    .describe("Rectangles and cell lists, applied in order over `fill`; later strokes win"),
                regions: z
                    .array(
                        z.object({
                            id: z.number().int().min(1).max(255),
                            x: z.number().int().min(0).optional(),
                            y: z.number().int().min(0).optional(),
                            width: z.number().int().min(1).max(250).optional(),
                            height: z.number().int().min(1).max(250).optional(),
                            cells: z.array(z.object({ x: z.number().int().min(0), y: z.number().int().min(0) })).optional()
                        })
                    )
                    .optional()
                    .describe("Painted on layer 5, on top of whatever tile is there"),
                clearRegions: z.array(z.number().int().min(1).max(255)).optional().describe("Erase these region ids from the whole map first"),
                flags: z
                    .array(z.record(z.string(), z.unknown()))
                    .optional()
                    .describe("`set_tileset_flags`' own `tiles` entries ({tileId|range, passable, blockFrom, bush, counter, terrainTag, …}), applied to this map's tileset"),
                properties: z.record(z.string(), z.unknown()).optional().describe("`set_map_properties`' own fields: displayName, disableDashing, battlebacks, parallax, bgm/bgs, encounterStep, encounters…"),
                dryRun: z.boolean().optional().describe("Report the plan and write nothing")
            },
            annotations: { title: "Make a map", destructiveHint: true, idempotentHint: true }
        },
        guarded(async (args: any) => {
            const project = context.project();
            const statics = context.statics();
            const warnings: string[] = [];
            const tilesets: any[] = project.readData("Tilesets");

            let mapId: number | undefined = args.mapId === undefined ? undefined : Number(args.mapId);
            let existing: any = mapId === undefined ? null : project.readMap(mapId);
            if (mapId === undefined && args.find) {
                const listed = await context.call("list_maps", {});
                const hit = (listed.maps ?? []).find((entry: any) => String(entry.name) === String(args.find));
                if (hit) {
                    mapId = Number(hit.id);
                    existing = project.readMap(mapId);
                }
            }
            if (mapId !== undefined && existing?.error) {
                throw new Error(`make_map: map ${mapId} does not exist`);
            }

            const width = Number(existing?.width ?? args.width);
            const height = Number(existing?.height ?? args.height);
            if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 250 || height > 250) {
                throw new Error(
                    `make_map: ${existing ? `map ${mapId} is ${width}x${height}, and ` : ""}a new map needs width and height between 1 and 250 ` +
                        "(MZ caps a map at 250 cells per side). Pass them, or name an existing map with `find`/`mapId`."
                );
            }
            if (existing && (args.width !== undefined || args.height !== undefined) && (Number(args.width) !== width || Number(args.height) !== height)) {
                warnings.push(`make_map: map ${mapId} stays ${width}x${height} — resizing a map means rebuilding its tile array, which is what corrupts one; use \`delete_map\` and make it again to change the size`);
            }
            const tilesetId = Number(args.tilesetId ?? existing?.tilesetId);
            const tileset = tilesets[tilesetId];
            if (!tileset) {
                throw new Error(`make_map: tileset ${tilesetId} does not exist (Tilesets.json has ${tilesets.length} slots; \`list_maps\` reports which tileset each map uses)`);
            }

            const spotsFor = (spec: any, where: string): { x: number; y: number }[] => {
                if (Array.isArray(spec.cells) && spec.cells.length) {
                    return spec.cells.map((cell: any) => ({ x: Number(cell.x), y: Number(cell.y) }));
                }
                const x = Number(spec.x);
                const y = Number(spec.y);
                const w = Number(spec.width ?? 1);
                const h = Number(spec.height ?? 1);
                if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
                    throw new Error(`make_map ${where}: needs x/y with width/height, or a non-empty cells list — got ${JSON.stringify(spec)}`);
                }
                const spots: { x: number; y: number }[] = [];
                for (let row = y; row < y + h; row++) {
                    for (let column = x; column < x + w; column++) {
                        spots.push({ x: column, y: row });
                    }
                }
                return spots;
            };

            // One tile per cell, in the order the strokes were given.
            const plan = new Array<number>(width * height).fill(0);
            let dropped = 0;
            if (args.fill !== undefined) {
                plan.fill(Number(args.fill));
            }
            for (const [index, stroke] of ((args.paint ?? []) as any[]).entries()) {
                for (const spot of spotsFor(stroke, `paint[${index}]`)) {
                    if (spot.x < 0 || spot.y < 0 || spot.x >= width || spot.y >= height) {
                        dropped++;
                        continue;
                    }
                    plan[spot.y * width + spot.x] = Number(stroke.tile);
                }
            }
            if (dropped) {
                warnings.push(`make_map: ${dropped} painted cell(s) fell outside ${width}x${height} and were dropped — the map is not scrolled, so an off-map rect is a mistake, not a margin`);
            }

            const tiles: number[] = [];
            for (let index = 0; index < plan.length; index++) {
                if (plan[index] > 0 && !tiles.includes(plan[index])) {
                    tiles.push(plan[index]);
                }
            }
            for (const tile of tiles) {
                const slot = kindOf(statics, tile);
                if (!sheetBound(tileset, slot)) {
                    warnings.push(
                        `make_map: tile ${tile} is slot ${slot}, but tileset ${tilesetId} ("${tileset.name}") has no ${slot} image bound — the id resolves and stores fine and paints nothing, which is how a map ends up with holes in it`
                    );
                }
            }

            const cells: any[] = [];
            const clears: any[] = [];
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const want = plan[y * width + x];
                    // The plan owns the whole stack of a cell, not just the layer it
                    // happens to paint: a floor that lands on layer 1 while last run's
                    // wall is still on layer 3 is a wall you walk through in the editor
                    // and cannot walk through in the game.
                    const wanted = want > 0 ? (LAYER_OF[kindOf(statics, want)] ?? 0) : -1;
                    if (want > 0) {
                        cells.push({ x, y, tileId: want });
                    }
                    if (!existing) {
                        continue;
                    }
                    for (let layer = 0; layer < 4; layer++) {
                        if (layer === wanted) {
                            continue;
                        }
                        if (tileAt(existing, x, y, layer) > 0) {
                            clears.push({ x, y, layer, tileId: 0 });
                        }
                    }
                }
            }

            const regionCells: any[] = [];
            if (args.clearRegions?.length && existing) {
                const erase = new Set((args.clearRegions as number[]).map(Number));
                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        if (erase.has(tileAt(existing, x, y, LAYER_REGION))) {
                            regionCells.push({ x, y, layer: LAYER_REGION, tileId: 0 });
                        }
                    }
                }
            }
            for (const [index, spec] of ((args.regions ?? []) as any[]).entries()) {
                for (const spot of spotsFor(spec, `regions[${index}]`)) {
                    if (spot.x < 0 || spot.y < 0 || spot.x >= width || spot.y >= height) {
                        continue;
                    }
                    regionCells.push({ x: spot.x, y: spot.y, layer: LAYER_REGION, tileId: Number(spec.id) });
                }
            }

            const summary = {
                mapId: mapId ?? null,
                name: args.name ?? args.find ?? existing?.name ?? null,
                size: [width, height],
                tilesetId,
                tilesPlanned: tiles.length,
                cellsToWrite: cells.length,
                cellsToClear: clears.length,
                regionCells: regionCells.length,
                ...(args.flags?.length ? { flagsFor: (args.flags as any[]).map((entry: any) => entry.tileId ?? entry.range) } : {}),
                ...(args.properties ? { properties: Object.keys(args.properties) } : {})
            };
            if (args.dryRun) {
                return done(context, "make_map", { ...summary, dryRun: true }, mapId === undefined ? [] : [mapId], [], [], warnings);
            }

            let flagReport: string[] = [];
            const { value, wrote } = await context.transaction(async () => {
                let id = mapId as number;
                if (id === undefined) {
                    const made = await context.call("create_map", {
                        name: args.name ?? args.find,
                        width,
                        height,
                        tilesetId,
                        parentId: args.parentId
                    });
                    id = Number(made.id);
                } else {
                    const props: Record<string, unknown> = { mapId: id, ...(args.properties ?? {}) };
                    if (args.name !== undefined) {
                        props.name = args.name;
                    }
                    if (args.tilesetId !== undefined && Number(args.tilesetId) !== Number(existing?.tilesetId)) {
                        props.tilesetId = tilesetId;
                    }
                    const touched = Object.keys(props).filter(key => key !== "mapId" && props[key] !== undefined);
                    if (touched.length) {
                        await context.call("set_map_properties", props);
                    }
                }
                if (clears.length) {
                    await context.call("set_tiles", { mapId: id, cells: clears });
                }
                if (cells.length) {
                    await context.call("set_tiles", { mapId: id, cells });
                }
                if (regionCells.length) {
                    await context.call("set_tiles", { mapId: id, cells: regionCells });
                }
                if (args.flags?.length) {
                    const flagged = await context.call("set_tileset_flags", { tilesetId, tiles: args.flags });
                    flagReport = (flagged.changed ?? []).map((one: any) => `${String(one.ids)} → ${one.flags}${one.clearedOverride ? " (cleared the 0x10 no-effect bit so the passage applies)" : ""}`);
                }
                return id;
            });

            const painted = project.readMap(value);
            const flags = tilesets[tilesetId]?.flags ?? [];
            let open = 0;
            let blocked = 0;
            for (let y = 0; y < painted.height; y++) {
                for (let x = 0; x < painted.width; x++) {
                    if (DIRS_FOUR.some(direction => isPassable(painted, flags, x, y, direction))) {
                        open++;
                    } else {
                        blocked++;
                    }
                }
            }
            if (open === 0) {
                warnings.push(
                    `make_map: no cell on map ${value} is passable from any direction, so nothing can stand there. Every tile in the plan is either flagged impassable or carries 0x10 (no passage effect) — \`describe_tiles\` lists which, and \`set_tileset_flags\` with passable: false→true changes it`
                );
            }
            return done(
                context,
                "make_map",
                {
                    ...summary,
                    mapId: value,
                    made: mapId === undefined ? "created" : "repainted",
                    cellsWritten: cells.length + clears.length,
                    ...(flagReport.length ? { flagsApplied: flagReport } : {}),
                    walkable: { open, blocked },
                    wrote
                },
                [value],
                wrote,
                [],
                warnings
            );
        })
    );

    register(
        "describe_tiles",
        {
            title: "Say what a tile id is",
            description:
                "The tile dictionary, read out of the project the way the engine reads it. For each id: which slot it belongs to (A1–A4 are autotile shape groups of 48, A5/B–E are fixed), which image that slot is bound to, which layer MZ draws it on, and what its entry in the tileset's 8192-entry `flags` array means — open or blocked from which of the four directions, whether 0x10 is set so those direction bits do nothing at all (much of the stock tileset ships that way), ladder, bush, counter, damage floor, the vehicle bits, the terrain tag — plus how many cells of a map actually use it. " +
                "Ask four ways: `mapId` for every tile a map really paints, which is the fastest way to learn an unfamiliar tileset; `tiles` for the ids in your hand; `slot` to walk one slot one base pattern at a time; or neither, for the slot table alone. " +
                "`contactSheet` also draws the answer: a labelled sheet, one 3x3 block per id rendered by the same code path as a real map, with the id and the engine's own passability verdict printed under each block, because \"which id is the water\" is a question a picture settles faster than a table. The sheet is drawn on a scratch map that this call creates and deletes again; no tileset row and no real map is touched.",
            inputSchema: {
                mapId: z.number().int().optional().describe("Describe every tile this map paints, with cell counts"),
                tilesetId: z.number().int().optional().describe("Which tileset's flags to read (default: the map's own)"),
                tiles: z.array(z.number().int().min(0).max(8191)).optional().describe("Describe exactly these ids"),
                slot: z.enum(["A1", "A2", "A3", "A4", "A5", "B", "C", "D", "E"]).optional().describe("Walk one slot, one base pattern at a time"),
                limit: z.number().int().min(1).max(512).optional().describe("Cap the list (default 120)"),
                contactSheet: z
                    .object({
                        saveTo: z.string().optional().describe("Write the PNG to this path as well as returning it"),
                        overlay: z.enum(["none", "passage"]).optional().describe("Draw the engine's passage verdict over the blocks too"),
                        columns: z.number().int().min(1).max(8).optional().describe("Blocks per row (default 4)"),
                        scale: z.number().min(0.5).max(2).optional().describe("Pixels per tile / 48 (default 1)"),
                        max: z.number().int().min(1).max(64).optional().describe("How many ids to draw (default 24)")
                    })
                    .optional()
            },
            annotations: { readOnlyHint: true }
        },
        guarded(async (args: any) => {
            const project = context.project();
            const statics = context.statics();
            const tilesets: any[] = project.readData("Tilesets");
            const warnings: string[] = [];

            let tilesetId = args.tilesetId === undefined ? undefined : Number(args.tilesetId);
            const usage = new Map<number, number>();
            if (args.mapId !== undefined) {
                const map = project.readMap(Number(args.mapId));
                if (tilesetId === undefined) {
                    tilesetId = Number(map.tilesetId);
                }
                for (let y = 0; y < map.height; y++) {
                    for (let x = 0; x < map.width; x++) {
                        for (let layer = 0; layer < 4; layer++) {
                            const tile = tileAt(map, x, y, layer);
                            if (tile > 0) {
                                usage.set(tile, (usage.get(tile) ?? 0) + 1);
                            }
                        }
                    }
                }
            }
            if (tilesetId === undefined) {
                const first = tilesets.findIndex((entry: any) => entry?.tilesetNames?.some((name: string) => String(name ?? "").trim() !== ""));
                tilesetId = first > 0 ? first : 1;
                warnings.push(`describe_tiles: no mapId or tilesetId was given, so tileset ${tilesetId} ("${tilesets[tilesetId]?.name}") was picked — pass mapId to describe a map, or tilesetId to name one`);
            }
            const tileset = tilesets[tilesetId];
            if (!tileset) {
                throw new Error(`describe_tiles: tileset ${tilesetId} does not exist (Tilesets.json has ${tilesets.length} slots)`);
            }

            const slots: any[] = (await context.call("tileset_slots", { tilesetId })).slots ?? [];
            const entry = (id: number) => {
                const flag = Number(tileset.flags?.[id] ?? 0);
                const kind = kindOf(statics, id);
                const autotile = ["A1", "A2", "A3", "A4"].includes(kind);
                const group = autotile ? shapeGroup(statics, id) : { from: id, to: id };
                const blocked = ["down", "left", "right", "up"].filter((_, index) => (flag & (1 << index)) !== 0);
                const note = (tileset.notes ?? [])[id];
                return {
                    id,
                    slot: kind,
                    sheet: String(tileset.tilesetNames?.[SLOT_INDEX[kind]] ?? "").trim() || null,
                    layer: LAYER_OF[kind] ?? 0,
                    pattern: autotile ? group.from : id,
                    ...(autotile ? { shapeInPattern: id - group.from, shapes: 48 } : {}),
                    flag: hex(flag),
                    what: describeFlags(flag),
                    blockedFrom: blocked,
                    ...(flag & FLAG_NO_PASSAGE_EFFECT ? { warning: "0x10 is set: the direction bits on this tile do nothing, and checkPassage falls through to the layer under it" } : {}),
                    terrainTag: flag >> FLAG_TERRAIN_SHIFT,
                    ...(note ? { note } : {}),
                    ...(usage.has(id) ? { cells: usage.get(id) } : {})
                };
            };

            let ids: number[];
            let asked: string;
            if (args.tiles?.length) {
                ids = [...new Set((args.tiles as number[]).map(Number))].sort((a, b) => a - b);
                asked = `tiles`;
            } else if (args.slot) {
                const slot = slots.find((one: any) => one.slot === args.slot);
                if (!slot) {
                    throw new Error(`describe_tiles: tileset ${tilesetId} has no slot ${args.slot}`);
                }
                const autotile = ["A1", "A2", "A3", "A4"].includes(String(args.slot));
                const step = autotile ? 48 : 1;
                ids = [];
                for (let id = Number(slot.firstId); id < Number(slot.firstId) + Number(slot.count); id += step) {
                    ids.push(id);
                }
                asked = `slot ${args.slot}${autotile ? " (base patterns, 48 shapes each)" : ""}`;
            } else if (usage.size) {
                ids = [...usage.keys()].sort((a, b) => a - b);
                asked = `map ${args.mapId}`;
            } else {
                ids = [];
                for (const slot of slots) {
                    if (!sheetBound(tileset, slot.slot)) {
                        continue;
                    }
                    const autotile = ["A1", "A2", "A3", "A4"].includes(String(slot.slot));
                    const step = autotile ? 48 : 1;
                    for (let id = Number(slot.firstId); id < Number(slot.firstId) + Number(slot.count); id += step) {
                        ids.push(id);
                    }
                }
                asked = `every bound slot, one base pattern each`;
            }
            const limit = Number(args.limit ?? 120);
            const shown = ids.slice(0, limit);
            const tiles = shown.map(entry);

            const parts: any[] = [];
            let sheet: Record<string, unknown> | null = null;
            if (args.contactSheet) {
                const spec = args.contactSheet;
                const max = Number(spec.max ?? 24);
                const list = tiles.slice(0, max);
                if (!list.length) {
                    warnings.push("describe_tiles: the contact sheet asked for ids and the list came out empty, so nothing was drawn");
                } else {
                    const drawn = await contactSheet(context, tilesetId, list, spec, warnings);
                    sheet = drawn.payload;
                    parts.push({ type: "image", data: drawn.base64, mimeType: "image/png" });
                }
            }

            const payload = {
                ok: true,
                tool: "describe_tiles",
                tilesetId,
                tilesetName: tileset.name,
                mode: tileset.mode,
                modeMeans:
                    tileset.mode === 0
                        ? "overworld: `Game_Map.isOverworld()` is true, which is what makes A4 tiles upper tiles and the bush/counter/damage bits take the outdoor path"
                        : `mode ${tileset.mode}: not the overworld rule, so A3 roofs and the layered-flag checks behave the indoor way`,
                askedBy: asked,
                slots: slots.map((slot: any) => ({
                    slot: slot.slot,
                    sheet: String(slot.name ?? "").trim() || null,
                    firstId: slot.firstId,
                    count: slot.count,
                    layer: LAYER_OF[slot.slot] ?? 0,
                    bound: sheetBound(tileset, slot.slot)
                })),
                count: tiles.length,
                ...(ids.length > limit ? { capped: `${ids.length} ids matched, ${limit} reported — raise \`limit\` or narrow the ask` } : {}),
                tiles,
                ...(sheet ? { contactSheet: sheet } : {}),
                ...(warnings.length ? { warnings } : {})
            };
            return reply(payload, parts);
        })
    );

    register(
        "live_dialog",
        {
            title: "Read and answer what the running game is showing",
            description:
                "The dialog layer of a live game, driven by intent instead of counted key presses. `read` says what the game is waiting for and what it is showing: the message text, the choice options with each one's enabled state and where the cursor is, the number pad's digits, and whether the window is actually able to take a key right now. `answer` picks an option by index or types a number, `dismiss` presses on until the game stops waiting, and `cancel` takes the cancel branch. Every one of them ends by reading the game again, so the reply tells you what came next.\n" +
                "Why this is a tool and not three `live_key` calls: `$gameMessage.isChoice()` turns true the moment a choice is *queued*, while `Window_ChoiceList` is still fading in, and the engine only moves the cursor when `Window_Selectable.isCursorMovable()` holds — which needs the window open *and active*. A cursor key sent in those frames is dropped, and the answer comes back as the first option whatever you meant. Measured on a real playtest: it cost a run. So `answer` waits for the window to be able to take keys, presses one edge at a time, and re-reads the cursor after every press instead of assuming it moved; the reply says how many presses it took and refuses an option the game has switched off, because that press does nothing and an empty wait looks like a bug.",
            inputSchema: {
                action: z.enum(["read", "answer", "dismiss", "cancel"]).optional().describe("Default read"),
                index: z.number().int().min(0).max(29).optional().describe("answer: which option, 0-based — the engine's own order, same as `make_choice_scene` options"),
                number: z.number().int().min(0).max(999999999).optional().describe("answer: the value to type into a number-input window"),
                waitMs: z.number().int().min(200).max(60000).optional().describe("How long to wait for the window to be takeable (default 8000)"),
                limit: z.number().int().min(1).max(40).optional().describe("dismiss/cancel: how many presses to try before giving up (default 12)")
            },
            annotations: { title: "Drive the dialog", destructiveHint: false, idempotentHint: false }
        },
        guarded(async (args: any) => {
            const action = String(args.action ?? "read");
            const waitMs = Number(args.waitMs ?? 8000);
            const read = async () => (await context.call("live_eval", { expression: DIALOG_STATE })).value;
            const tap = async (keyCode: number) => {
                await context.call("live_key", { keyCode, pulses: 1, holdFrames: 2 });
            };
            const settle = async (wanted: (state: any) => boolean, limitMs: number) => {
                const until = Date.now() + limitMs;
                let state = await read();
                while (!wanted(state) && Date.now() < until) {
                    await new Promise(resolve => setTimeout(resolve, 80));
                    state = await read();
                }
                return state;
            };

            let state = await read();
            if (!state) {
                throw new Error("live_dialog: the game answered nothing — is the live session running?");
            }
            const presses: string[] = [];

            if (action === "dismiss" || action === "cancel") {
                const keyCode = action === "cancel" ? 27 : 13;
                const limit = Number(args.limit ?? 12);
                let used = 0;
                while (state.busy && used < limit) {
                    if (state.choice?.movable === false && state.choice.opening) {
                        await settle(one => one.choice?.movable === true, waitMs);
                    }
                    await tap(keyCode);
                    presses.push(action === "cancel" ? "cancel" : "ok");
                    used++;
                    state = await settle(one => !one.busy || one.choice?.movable === true, Math.min(waitMs, 1500));
                }
                return reply(
                    {
                        ok: true,
                        tool: "live_dialog",
                        action,
                        presses: used,
                        quiet: !state.busy,
                        ...(used >= limit && state.busy
                            ? {
                                  warning: `still busy after ${limit} presses — ${
                                      state.choice
                                          ? `a choice window is open and its cursor will not move (${JSON.stringify(state.choice)})`
                                          : "a message is waiting on something no key answers, such as a moving picture or a wait"
                                  }`
                              }
                            : {}),
                        now: state
                    },
                    []
                );
            }

            if (action === "answer") {
                const wantedIndex = args.index;
                const wantedNumber = args.number;
                if (wantedIndex === undefined && wantedNumber === undefined) {
                    throw new Error(`live_dialog answer: pass index (a choice) or number (a digit pad); the game is showing ${state.choice ? "a choice" : state.number ? "a number input" : state.busy ? "a message" : "nothing"}`);
                }
                if (wantedNumber !== undefined) {
                    if (!state.number) {
                        throw new Error(`live_dialog: the game is not asking for a number (${state.busy ? "it is showing a message" : "nothing is waiting"}). To pick a choice, pass index`);
                    }
                    await settle(one => one.number?.movable === true, waitMs);
                    state = await read();
                    if (!state.number?.digits?.length) {
                        throw new Error(`live_dialog: the number window never became takeable (${JSON.stringify(state.number)})`);
                    }
                    const digits: number[] = state.number.digits;
                    let cursor = Number(state.number.index);
                    const target = String(wantedNumber).padStart(digits.length, "0");
                    if (target.length > digits.length) {
                        throw new Error(
                            `live_dialog: the game asked for ${digits.length} digits and ${wantedNumber} needs ${String(wantedNumber).length} — the engine clips it, so the value would come out wrong. Raise the number-input window's digits in the Show Number Input command`
                        );
                    }
                    for (let position = 0; position < digits.length; position++) {
                        while (cursor !== position) {
                            const direction = position > cursor ? 39 : 37;
                            await tap(direction);
                            presses.push(direction === 39 ? "right" : "left");
                            const moved = await settle(one => Number(one.number?.index) === position, 2500);
                            if (Number(moved.number?.index) !== position) {
                                throw new Error(`live_dialog: the digit cursor stopped at ${moved.number?.index} instead of ${position} (${JSON.stringify(moved.number)})`);
                            }
                            cursor = position;
                        }
                        const have = Number(digits[position]);
                        const want = Number(target[position]);
                        const up = (want - have + 10) % 10;
                        const down = (have - want + 10) % 10;
                        const keyCode = up <= down ? 38 : 40;
                        const steps = Math.min(up, down);
                        for (let step = 0; step < steps; step++) {
                            await tap(keyCode);
                            presses.push(`${keyCode === 38 ? "up" : "down"}@${position}`);
                            const now = await read();
                            digits[position] = Number(now.number.digits[position]);
                        }
                        if (Number(digits[position]) !== want) {
                            throw new Error(`live_dialog: digit ${position} reads ${digits[position]} after ${steps} presses, not ${want}`);
                        }
                    }
                    await tap(13);
                    presses.push("ok");
                    const after = await settle(one => !one.number, waitMs);
                    return reply({ ok: true, tool: "live_dialog", action, typed: wantedNumber, presses: presses.length, keys: presses.join(", "), answered: !after.number, now: after }, []);
                }

                if (!state.choice?.options?.length) {
                    // A choice is usually preceded by the line that asks it. Pressing
                    // through that is what a player does, and the alternative is a tool
                    // that throws at a frame the window simply has not reached yet.
                    let through = 0;
                    while (state.busy && !state.choice?.options?.length && through < 14) {
                        if (!state.hasText && !state.number) {
                            break;
                        }
                        await tap(13);
                        presses.push("ok-through");
                        through++;
                        state = await settle(one => one.choice?.options?.length || !one.busy, 3000);
                    }
                }
                if (!state.choice?.options?.length) {
                    throw new Error(
                        `live_dialog: no choice list came up after pressing through what was on screen (${presses.join(", ") || "nothing pressed"}) — ${
                            state.busy ? `the game is showing ${state.number ? "a number input" : "a message"}: ${JSON.stringify(String(state.text).slice(0, 80))}` : "the game is not waiting for anything"
                        }. Use action: "read" to see it, "dismiss" to clear a message, and \`number\` instead of \`index\` for a digit pad`
                    );
                }
                const options: any[] = state.choice.options ?? [];
                if (wantedIndex >= options.length) {
                    throw new Error(`live_dialog: there is no option ${wantedIndex} — this choice has ${options.length}: ${options.map((one, at) => `${at}: ${one.label}`).join(" | ")}`);
                }
                if (options[wantedIndex]?.enabled === false) {
                    return reply(
                        {
                            ok: false,
                            tool: "live_dialog",
                            action,
                            refused: `option ${wantedIndex} ("${options[wantedIndex].label}") is switched off, so the engine buzzes it and the window stays open. Its condition is what make_choice_scene calls when`,
                            options,
                            now: state
                        },
                        []
                    );
                }
                await settle(one => one.choice?.movable === true, waitMs);
                state = await read();
                if (state.choice?.movable !== true) {
                    throw new Error(
                        `live_dialog: the choice window came up but will not take a cursor key after ${waitMs}ms (${JSON.stringify(state.choice)}) — this is the state a raw key press used to be swallowed by`
                    );
                }
                let cursor = Number(state.choice.index);
                while (cursor !== wantedIndex) {
                    const keyCode = wantedIndex > cursor ? 40 : 38;
                    await tap(keyCode);
                    presses.push(keyCode === 40 ? "down" : "up");
                    const moved = await settle(one => Number(one.choice?.index) !== cursor, 2500);
                    const next = Number(moved.choice?.index);
                    if (next === cursor) {
                        throw new Error(`live_dialog: the cursor would not move past ${cursor} of ${options.length} options (${JSON.stringify(moved.choice)})`);
                    }
                    cursor = next;
                }
                await tap(13);
                presses.push("ok");
                const after = await settle(one => !one.choice && !one.busy, waitMs);
                return reply(
                    {
                        ok: true,
                        tool: "live_dialog",
                        action,
                        chose: { index: wantedIndex, label: options[wantedIndex]?.label },
                        presses: presses.length,
                        keys: presses.join(", "),
                        settled: !after.busy && !after.choice,
                        now: after
                    },
                    []
                );
            }

            return reply({ ok: true, tool: "live_dialog", action: "read", now: state }, []);
        })
    );

    register(
        "make_battle",
        {
            title: "Author a fight in one call",
            description:
                "Both rows a battle needs — the Enemies row and the Troops row that holds it — from one ask, plus the region that rolls it if you want it met by walking. `create_database_entry` will write either row, but it has to be handed the whole thing, and the shapes here are the ones that fail quietly: a drop is `{kind, dataId, denominator}` where kind 0 is an empty slot and `denominator: 3` means one chance in three (30 would be read as one in 30, not 30%); a trait is `{code, dataId, value}` — 11 element rate, 12 debuff rate, 14 state resist, 21 param, 22 hit and evasion, 31 attack element, 32 attack state, 63 collapse type — where the key is **`value`, unlike an item effect, which uses `value1`/`value2`**; and an action naming a skill that has no Skills row is a battle that throws on the turn the foe decides to act. So names are resolved against the project's own tables, what is not there is refused, and what was written comes back in words. " +
                "Idempotent by name: a build script that runs twice leaves one foe, not one foe per run.",
            inputSchema: {
                foe: z
                    .object({
                        enemyId: z.number().int().optional().describe("Rewrite this Enemies row instead of making one"),
                        name: z.string().optional(),
                        battler: z.object({ name: z.string().optional(), hue: z.number().int().optional() }).optional().describe("A sheet in img/enemies"),
                        params: z
                            .union([
                                z.array(z.number().int().min(0)).length(8),
                                z.object({ hp: z.number().int().min(0).optional(), mp: z.number().int().min(0).optional(), atk: z.number().int().min(0).optional(), def: z.number().int().min(0).optional(), mat: z.number().int().min(0).optional(), mdf: z.number().int().min(0).optional(), agi: z.number().int().min(0).optional(), luk: z.number().int().min(0).optional() })
                            ])
                            .optional()
                            .describe("maxHp, maxMp, atk, def, mat, mdf, agi, luk — as the eight numbers or spelled out"),
                        exp: z.number().int().min(0).optional(),
                        gold: z.number().int().min(0).optional(),
                        actions: z
                            .array(
                                z.object({
                                    skill: z.union([z.number().int(), z.string()]).describe("A Skills row, by id or name"),
                                    rating: z.number().int().min(0).max(9).optional().describe("How often the AI picks it (0 never, 4 usual, 9 always)"),
                                    when: z
                                        .object({
                                            type: z.number().int().min(0).max(7).optional().describe("0 always, 1-2 target HP above/below, 3-4 self MP above/below, 5 at turn, 6 after using skill, 7 by weapon type"),
                                            param1: z.number().int().optional(),
                                            param2: z.number().int().optional()
                                        })
                                        .optional()
                                })
                            )
                            .optional()
                            .describe("What it does on its turn. Passing this replaces the copied row's actions"),
                        elementRates: z.array(z.object({ element: z.union([z.number().int(), z.string()]), rate: z.number().min(0).max(10) })).optional().describe("1 normal, 2 double, 0 immune — as a multiplier against an element from System.elements"),
                        stateResists: z.array(z.object({ state: z.union([z.number().int(), z.string()]), rate: z.number().min(0).max(1) })).optional().describe("0 immune, 1 as usual — a chance multiplier for a States row"),
                        hit: z.number().min(0).max(10).optional().describe("Trait 22 slot 0: 1 always lands, 0.8 lands four times in five"),
                        evasion: z.number().min(0).max(10).optional().describe("Trait 22 slot 1"),
                        collapse: z.number().int().min(0).max(7).optional().describe("How it dies: 0 default, 1 collapse, 2 fly, 3 dissolve, 4 splash, 5 none, 6 double, 7 remove"),
                        drops: z
                            .array(z.object({ kind: z.enum(["item", "weapon", "armor"]).optional(), name: z.string().optional(), id: z.number().int().optional(), oneIn: z.number().int().min(1).max(1000).optional() }))
                            .optional()
                            .describe("Up to three; `oneIn: 3` is the engine's denominator, and a drop naming something the project has no row for is refused"),
                        keepTraits: z.boolean().optional().describe("Keep the traits of the row this is copied from instead of the ones this call names"),
                        note: z.string().optional(),
                        copyFrom: z.number().int().optional().describe("Which Enemies row to start from (default: the first named one)")
                    })
                    .optional(),
                troop: z
                    .object({
                        troopId: z.number().int().optional().describe("Rewrite this Troops row"),
                        name: z.string().optional(),
                        members: z
                            .array(z.object({ foe: z.union([z.number().int(), z.string()]).optional().describe("An Enemies row by id or name; defaults to the foe this call wrote"), x: z.number().int().min(0).max(1000).optional(), y: z.number().int().min(0).max(1000).optional(), hidden: z.boolean().optional() }))
                            .optional(),
                        count: z.number().int().min(1).max(8).optional().describe("Shorthand: this many copies of the foe, placed like a troop the project already has")
                    })
                    .optional(),
                zone: z
                    .object({
                        mapId: z.number().int(),
                        region: z.number().int().min(1).max(255).optional(),
                        weight: z.number().int().min(1).max(100).optional(),
                        encounterStep: z.number().int().min(1).max(200).optional()
                    })
                    .optional()
                    .describe("Roll this troop in a region — `make_encounter_zone` for this one group"),
                dryRun: z.boolean().optional()
            },
            annotations: { title: "Make a battle", destructiveHint: true, idempotentHint: true }
        },
        guarded(async (args: any) => {
            const project = context.project();
            const warnings: string[] = [];
            if (!args.foe && !args.troop && !args.zone) {
                throw new Error("make_battle: pass `foe`, `troop` or `zone` — with none of the three there is nothing to write");
            }
            const enemies: any[] = project.readData("Enemies");
            const troops: any[] = project.readData("Troops");
            const system = project.readData("System");
            const foeTemplate = enemies.find((row: any) => row?.name && row.actions?.length) ?? enemies.find((row: any) => row?.name);
            if (!foeTemplate) {
                throw new Error("make_battle: Enemies.json has no named row to copy the shape from, so a new foe cannot be built safely");
            }
            const troopTemplate = troops.find((row: any) => row?.members?.length);
            if (!troopTemplate) {
                throw new Error("make_battle: Troops.json has no row with members, so a new troop cannot be built safely");
            }

            const named = (table: string, wanted: unknown, where: string, extra?: (row: any) => string | null): any => {
                if (wanted === undefined || wanted === null || wanted === "") {
                    throw new Error(`make_battle ${where}: needs an id or a name`);
                }
                const rows: any[] = project.readData(table);
                if (Number.isInteger(Number(wanted))) {
                    return assertRow(project, table, Number(wanted), where);
                }
                const hit = rows.find(row => row?.name && String(row.name) === String(wanted));
                if (!hit) {
                    const samples = rows.filter((row: any) => row?.name).slice(0, 8).map((row: any) => row.name);
                    throw new Error(`make_battle ${where}: no ${table} row named "${wanted}". Some of what is there: ${samples.join(", ")}`);
                }
                if (extra) {
                    const problem = extra(hit);
                    if (problem) {
                        throw new Error(`make_battle ${where}: ${problem}`);
                    }
                }
                return hit;
            };

            // --- the foe -----------------------------------------------------
            const foe = args.foe ?? null;
            let enemyId: number | null = foe?.enemyId !== undefined ? Number(foe.enemyId) : null;
            if (foe && enemyId === null && foe.name) {
                const same = enemies.find((row: any) => row?.name && String(row.name) === String(foe.name));
                if (same) {
                    enemyId = Number(same.id);
                }
            }
            const base = enemyId === null ? assertRow(project, "Enemies", Number(foe?.copyFrom ?? foeTemplate.id), "make_battle foe copyFrom") : assertRow(project, "Enemies", enemyId, "make_battle foe");
            const fields: Record<string, unknown> = {};
            if (foe) {
                if (foe.name !== undefined) {
                    fields.name = foe.name;
                }
                if (foe.battler) {
                    fields.battlerName = foe.battler.name ?? base.battlerName;
                    fields.battlerHue = Number(foe.battler.hue ?? base.battlerHue ?? 0);
                    if (foe.battler.name && !assetExists(project, "img/enemies", String(foe.battler.name))) {
                        warnings.push(`make_battle: img/enemies/${foe.battler.name}.png is not in this project, so the foe shows an empty frame in battle — import_asset puts it there`);
                    }
                }
                if (foe.params !== undefined) {
                    fields.params = Array.isArray(foe.params) ? foe.params : PARAM_KEYS.map(key => Number((foe.params as any)[key] ?? base.params?.[PARAM_KEYS.indexOf(key)] ?? 0));
                }
                if (foe.exp !== undefined) {
                    fields.exp = Number(foe.exp);
                }
                if (foe.gold !== undefined) {
                    fields.gold = Number(foe.gold);
                }
                if (foe.note !== undefined) {
                    fields.note = foe.note;
                }
                if (foe.actions?.length) {
                    fields.actions = (foe.actions as any[]).map(action => {
                        const skill = named("Skills", action.skill, "foe actions");
                        return {
                            skillId: Number(skill.id),
                            conditionType: Number(action.when?.type ?? 0),
                            conditionParam1: Number(action.when?.param1 ?? 0),
                            conditionParam2: Number(action.when?.param2 ?? 0),
                            rating: Number(action.rating ?? 5)
                        };
                    });
                }
                if (foe.drops?.length) {
                    if (foe.drops.length > 3) {
                        throw new Error(`make_battle: an Enemies row has three drop slots and ${foe.drops.length} were passed`);
                    }
                    const slots = (foe.drops as any[]).map(drop => {
                        const table = drop.kind === "weapon" ? "Weapons" : drop.kind === "armor" ? "Armors" : "Items";
                        const row = named(table, drop.name ?? drop.id, `foe drops (${table})`);
                        return { kind: drop.kind === "weapon" ? 2 : drop.kind === "armor" ? 3 : 1, dataId: Number(row.id), denominator: Number(drop.oneIn ?? 1) };
                    });
                    while (slots.length < 3) {
                        slots.push({ kind: 0, dataId: 1, denominator: 1 });
                    }
                    fields.dropItems = slots;
                }
                const namesTraits = foe.elementRates?.length || foe.stateResists?.length || foe.hit !== undefined || foe.evasion !== undefined || foe.collapse !== undefined;
                if (namesTraits && foe.keepTraits !== true) {
                    const traits: any[] = [];
                    for (const entry of (foe.elementRates ?? []) as any[]) {
                        traits.push({ code: 11, dataId: elementIdOf(system, entry.element), value: Number(entry.rate) });
                    }
                    for (const entry of (foe.stateResists ?? []) as any[]) {
                        traits.push({ code: 14, dataId: Number(named("States", entry.state, "foe stateResists").id), value: Number(entry.rate) });
                    }
                    if (foe.hit !== undefined) {
                        traits.push({ code: 22, dataId: 0, value: Number(foe.hit) });
                    }
                    if (foe.evasion !== undefined) {
                        traits.push({ code: 22, dataId: 1, value: Number(foe.evasion) });
                    }
                    if (foe.collapse !== undefined) {
                        traits.push({ code: 63, dataId: Number(foe.collapse), value: 0 });
                    }
                    fields.traits = traits;
                } else if (enemyId === null && !foe.keepTraits) {
                    warnings.push(`make_battle: the new foe was copied from Enemies ${base.id} "${base.name}", so it came with that row's ${base.actions?.length ?? 0} actions and ${base.dropItems?.filter((one: any) => one?.kind)?.length ?? 0} drops — name actions/drops in this call to replace them`);
                }
            }

            // --- the troop ---------------------------------------------------
            const troop = args.troop ?? null;
            let troopId: number | null = troop?.troopId !== undefined ? Number(troop.troopId) : null;
            if (troop && troopId === null && troop.name) {
                const same = troops.find((row: any) => row?.name && String(row.name) === String(troop.name));
                if (same) {
                    troopId = Number(same.id);
                }
            }
            const members: any[] = [];
            let placedFrom: string | null = null;
            if (troop) {
                // `foe: null` means "the foe this call makes", which has no id until the
                // transaction has created it — so the members are assembled inside it.
                const listed = (troop.members ?? []).map((member: any) => {
                    if (member.enemyId === undefined && member.foe === undefined) {
                        return { pending: true, x: member.x, y: member.y, hidden: member.hidden };
                    }
                    const row = member.enemyId !== undefined ? assertRow(project, "Enemies", member.enemyId, "make_battle troop members") : named("Enemies", member.foe, "make_battle troop members");
                    return { enemyId: Number(row.id), x: member.x, y: member.y, hidden: member.hidden };
                });
                if (listed.length) {
                    members.push(...listed);
                } else {
                    const count = Number(troop.count ?? 1);
                    const shaped = troops.find((row: any) => row?.members?.length === count);
                    if (shaped) {
                        placedFrom = `Troops ${shaped.id} "${shaped.name}", which has ${count} members`;
                        shaped.members.forEach((one: any) => {
                            members.push({ pending: true, x: Number(one.x), y: Number(one.y), hidden: Boolean(one.hidden) });
                        });
                    } else {
                        placedFrom = `a ${count}-wide ladder at 96px spacing, which is how MZ lines a group up — the project has no troop of that size to copy exact positions from`;
                        for (let index = 0; index < count; index++) {
                            members.push({ pending: true, x: 336 + (index % 3) * 96, y: 436 - Math.floor(index / 3) * 90, hidden: false });
                        }
                    }
                }
            }

            if (args.dryRun) {
                return done(
                    context,
                    "make_battle",
                    {
                        dryRun: true,
                        foe: enemyId === null ? { wouldCreate: true, from: `${foeTemplate.id} "${foeTemplate.name}"` } : { wouldPatch: enemyId, name: foeTemplate.name },
                        fieldsWritten: Object.keys(fields),
                        ...(troop ? { troop: troopId === null ? { wouldCreate: true, members } : { wouldPatch: troopId, members }, placedFrom } : {}),
                        zone: args.zone ?? null
                    },
                    args.zone?.mapId ? [Number(args.zone.mapId)] : [],
                    [],
                    [],
                    warnings
                );
            }

            const { value, wrote } = await context.transaction(async () => {
                let foeId = enemyId as number | null;
                let madeFoe: { id: number; existing: boolean } | null = null;
                if (foe) {
                    if (foeId === null) {
                        const created = await context.call("create_database_entry", { table: "Enemies", copyFrom: Number(args.foe.copyFrom ?? foeTemplate.id), fields });
                        foeId = Number(created.id);
                        madeFoe = { id: foeId, existing: false };
                        if (created.basedOn?.id !== undefined && created.basedOn.id !== Number(foe.copyFrom ?? foeTemplate.id)) {
                            warnings.push(
                                `make_battle: the foe was based on Enemies ${created.basedOn.id} "${created.basedOn.name}" rather than the row ${Number(foe.copyFrom ?? foeTemplate.id)} this call asked to copy — the reply says which`
                            );
                        }
                    } else {
                        if (Object.keys(fields).length) {
                            await context.call("patch_database_entry", { table: "Enemies", id: foeId, patch: fields });
                        }
                        madeFoe = { id: foeId, existing: true };
                    }
                }
                let madeTroop: { id: number; existing: boolean } | null = null;
                let troopFinalId: number | null = troopId as number | null;
                if (troop) {
                    const filled = members.map(member => ({
                        ...troopTemplate.members[0],
                        enemyId: member.pending ? Number(foeId ?? base.id) : Number(member.enemyId),
                        ...(member.x !== undefined ? { x: Number(member.x) } : {}),
                        ...(member.y !== undefined ? { y: Number(member.y) } : {}),
                        hidden: Boolean(member.hidden)
                    }));
                    if (troopFinalId === null) {
                        const created = await context.call("create_database_entry", { table: "Troops", copyFrom: Number(troopTemplate.id), fields: { name: troop.name ?? `${filled.length} × ${(enemies.find((row: any) => row?.id === foeId) ?? base).name}`, members: filled } });
                        troopFinalId = Number(created.id);
                        madeTroop = { id: troopFinalId, existing: false };
                    } else {
                        await context.call("patch_database_entry", { table: "Troops", id: troopFinalId, patch: { ...(troop.name ? { name: troop.name } : {}), members: filled } });
                        madeTroop = { id: troopFinalId, existing: true };
                    }
                }
                let zone: any = null;
                if (args.zone && troopFinalId !== null) {
                    zone = await context.call("make_encounter_zone", {
                        mapId: Number(args.zone.mapId),
                        troops: [{ troopId: troopFinalId, weight: args.zone.weight ?? 3, region: args.zone.region }],
                        ...(args.zone.encounterStep !== undefined ? { encounterStep: Number(args.zone.encounterStep) } : {}),
                        ...(args.zone.region ? { region: { id: Number(args.zone.region) } } : {})
                    });
                }
                return { foeId, madeFoe, troopFinalId, madeTroop, zone };
            });

            const payload: Record<string, unknown> = {
                enemyId: value.foeId,
                ...(value.madeFoe ? { enemy: value.madeFoe.existing ? "rewrote Enemies " + value.madeFoe.id : "made Enemies " + value.madeFoe.id } : {}),
                fieldsWritten: Object.keys(fields),
                ...(foe?.params && !Array.isArray(foe.params) ? { paramsFrom: `the keys this call named; the rest stayed as Enemies ${base.id} "${base.name}" had them` } : {}),
                ...(value.troopFinalId !== null ? { troopId: value.troopFinalId, ...(placedFrom ? { positionsFrom: placedFrom } : {}) } : {}),
                ...(value.madeTroop ? { troop: value.madeTroop.existing ? "rewrote Troops " + value.troopFinalId : "made Troops " + value.troopFinalId } : {}),
                ...(value.zone ? { zone: { mapId: Number(args.zone.mapId), encounters: value.zone.encounters ?? null } } : {})
            };
            return done(context, "make_battle", payload, args.zone?.mapId ? [Number(args.zone.mapId)] : [], wrote, [], warnings);
        })
    );

    register(
        "make_item",
        {
            title: "Write a row the player can hold or cast",
            description:
                "An Items, Weapons, Armors or Skills row in one call, with the effects and equipment rules spelled in words. " +
                "The effect shape is the whole reason this exists: MZ stores an item **effect** as `{code, dataId, value1, value2}` — 11 recovers HP as `mhp × value1 + value2`, 12 MP, 13 TP, 21 and 22 add and remove a state, 31 and 32 add a buff and a debuff (dataId is the parameter, value1 the turns), 33 and 34 remove them, 41 is the special (0 = escape), 44 runs a common event — while a **trait** on the same row is `{code, dataId, value}` with one key. Send the trait's `value` to an effect and the engine computes `mhp × undefined`, floors it to NaN, and adds NaN to the actor's HP: a number the bar cannot draw and the save file now has to carry. This compiles the words into the two shapes and refuses a state, parameter or common event the project does not have. " +
                "The type ids are the other quiet failure: an item whose `itypeId` is not 1 or 2 is never listed — MZ has no item-type name list, the menu reads those two numbers and `$dataSystem.itemCategories` decides whether the tab is open at all — and a weapon whose `wtypeId` matches no weapon type cannot be equipped by anyone, so both are checked against `System.json` and said out loud. " +
                "Idempotent by name, like the rest of the layer: re-running a build script rewrites the same row instead of adding one.",
            inputSchema: {
                table: z.enum(["Items", "Weapons", "Armors", "Skills"]).optional().describe("Default Items"),
                id: z.number().int().optional().describe("Rewrite this row instead of making one"),
                name: z.string().optional(),
                description: z.string().optional(),
                icon: z.number().int().min(0).max(8191).optional().describe("Index into img/system/IconSet.png"),
                price: z.number().int().min(0).optional(),
                note: z.string().optional(),
                consumable: z.boolean().optional(),
                occasion: z.number().int().min(0).max(3).optional().describe("0 any time, 1 menu only, 2 battle only, 3 never — never is not the same as unbuyable"),
                scope: z.number().int().min(0).max(11).optional().describe("0 none, 1 one enemy, 2 all enemies, 3 random, 7 self, 8 one ally, 9 all allies, 10 party, 11 dead ally"),
                itypeId: z.union([z.number().int(), z.string()]).optional().describe("Items: 1 for the Item tab, 2 for the Key Item tab. MZ keeps no item-type name list, so any other number leaves the row out of the menu"),
                wtypeId: z.union([z.number().int(), z.string()]).optional().describe("Weapons: System.weaponTypes — a row nothing names cannot be equipped"),
                atypeId: z.union([z.number().int(), z.string()]).optional().describe("Armors: System.armorTypes"),
                etypeId: z.union([z.number().int(), z.string()]).optional().describe("Weapons and armors: the equipment slot, System.equipTypes"),
                params: z
                    .union([
                        z.array(z.number().int()).length(8),
                        z.object({ hp: z.number().int().optional(), mp: z.number().int().optional(), atk: z.number().int().optional(), def: z.number().int().optional(), mat: z.number().int().optional(), mdf: z.number().int().optional(), agi: z.number().int().optional(), luk: z.number().int().optional() })
                    ])
                    .optional()
                    .describe("Weapons and armors: the flat parameter change when equipped"),
                effects: z
                    .array(
                        z.object({
                            hp: z.number().min(-1).max(1).optional().describe("Fraction of max HP recovered"),
                            hpFlat: z.number().int().optional().describe("Flat HP recovered (or lost, with a negative)"),
                            mp: z.number().min(-1).max(1).optional(),
                            mpFlat: z.number().int().optional(),
                            tp: z.number().int().min(-100).max(100).optional(),
                            addState: z.union([z.number().int(), z.string()]).optional().describe("A States row by id or name"),
                            removeState: z.union([z.number().int(), z.string()]).optional().describe("Removing the Dead state is how a revive is written"),
                            chance: z.number().min(0).max(1).optional().describe("Probability the state takes, when it is added or removed by an item"),
                            buff: z.union([z.number().int().min(0).max(7), z.enum(PARAM_NAMES_LITERAL)]).optional(),
                            debuff: z.union([z.number().int().min(0).max(7), z.enum(PARAM_NAMES_LITERAL)]).optional(),
                            removeBuff: z.union([z.number().int().min(0).max(7), z.enum(PARAM_NAMES_LITERAL)]).optional(),
                            removeDebuff: z.union([z.number().int().min(0).max(7), z.enum(PARAM_NAMES_LITERAL)]).optional(),
                            turns: z.number().int().min(1).max(100).optional(),
                            escape: z.boolean().optional().describe("Effect 41 slot 0: the user flees"),
                            commonEvent: z.union([z.number().int(), z.string()]).optional().describe("Effect 44: a CommonEvents row"),
                            raw: z.object({ code: z.number().int(), dataId: z.number().int().optional(), value1: z.number().optional(), value2: z.number().optional() }).optional().describe("Anything this list does not name, spelled in the engine's own keys")
                        })
                    )
                    .optional(),
                damage: z
                    .object({
                        type: z.number().int().min(0).max(3).optional().describe("0 none, 1 HP, 2 MP drain, 3 MP damage"),
                        element: z.union([z.number().int(), z.string()]).optional().describe("An element from System.elements; -1 matches the attacker's"),
                        formula: z.string().optional().describe("Engine JS, with `a` the user and `b` the target: \"a.atk * 4 - b.def * 2\""),
                        variance: z.number().int().min(0).max(100).optional(),
                        critical: z.boolean().optional()
                    })
                    .optional(),
                traits: z.array(z.object({ code: z.number().int(), dataId: z.number().int().optional(), value: z.number().optional() })).optional().describe("Weapons and armors: the engine's own {code, dataId, value}, single value"),
                repeats: z.number().int().min(1).max(9).optional(),
                speed: z.number().int().min(-10000).max(10000).optional().describe("Action order bonus, the engine's own field"),
                successRate: z.number().int().min(0).max(100).optional(),
                tpGain: z.number().int().min(0).max(100).optional(),
                animationId: z.number().int().min(0).optional(),
                mpCost: z.number().int().min(0).optional().describe("Skills only"),
                tpCost: z.number().int().min(0).optional().describe("Skills only"),
                stypeId: z.union([z.number().int(), z.string()]).optional().describe("Skills only: the type from System.skillTypes, by name or id"),
                message1: z.string().optional().describe("Skills only: the battle log line, `X uses …`"),
                message2: z.string().optional().describe("Skills only: the second battle log line"),
                copyFrom: z.number().int().optional(),
                dryRun: z.boolean().optional()
            },
            annotations: { title: "Make an item", destructiveHint: true, idempotentHint: true }
        },
        guarded(async (args: any) => {
            const project = context.project();
            const table = String(args.table ?? "Items");
            if (!["Items", "Weapons", "Armors", "Skills"].includes(table)) {
                throw new Error(`make_item: table has to be Items, Weapons, Armors or Skills, not ${table}. For a foe use make_battle; for a state, actor or common event use create_database_entry`);
            }
            const warnings: string[] = [];
            const rows: any[] = project.readData(table);
            const system = project.readData("System");
            let id = args.id === undefined ? null : Number(args.id);
            if (id === null && args.name) {
                const same = rows.find((row: any) => row?.name && String(row.name) === String(args.name));
                if (same) {
                    id = Number(same.id);
                }
            }
            const templateId = id ?? Number(args.copyFrom ?? rows.find((row: any) => row?.name && String(row.name).trim() && !/Reserved|-{3,}/i.test(String(row.name)))?.id ?? 1);
            const template = assertRow(project, table, templateId, `make_item ${table}`);

            const paramId = (wanted: unknown, where: string): number => {
                const asNumber = Number(wanted);
                if (Number.isInteger(asNumber) && asNumber >= 0 && asNumber <= 7) {
                    return asNumber;
                }
                const index = PARAM_KEYS.indexOf(String(wanted).toLowerCase());
                if (index < 0) {
                    throw new Error(`make_item ${where}: "${wanted}" is not one of ${PARAM_KEYS.join(", ")}`);
                }
                return index;
            };
            const typeId = (wanted: unknown, list: string[] | undefined, where: string): number => {
                const asNumber = Number(wanted);
                if (Number.isInteger(asNumber)) {
                    if (list?.length && !String(list[asNumber] ?? "").trim()) {
                        warnings.push(`make_item ${where}: type ${asNumber} has no name in this project's list, so nothing in the menu will be able to choose it`);
                    }
                    return asNumber;
                }
                if (!list?.length) {
                    throw new Error(`make_item ${where}: "${wanted}" cannot be resolved because System.json has no such type list — pass the id the editor shows`);
                }
                const index = list.findIndex(name => String(name) === String(wanted));
                if (index < 1) {
                    throw new Error(`make_item ${where}: no type named "${wanted}". The list is: ${list.slice(1).filter(Boolean).join(", ")}`);
                }
                return index;
            };

            const fields: Record<string, unknown> = {};
            for (const key of ["name", "description", "note"] as const) {
                if (args[key] !== undefined) {
                    fields[key] = args[key];
                }
            }
            if (args.icon !== undefined) {
                fields.iconIndex = Number(args.icon);
            }
            if (args.price !== undefined) {
                fields.price = Number(args.price);
            }
            if (args.consumable !== undefined && table === "Items") {
                fields.consumable = Boolean(args.consumable);
            }
            for (const key of ["occasion", "scope", "repeats", "speed", "successRate", "tpGain", "animationId"] as const) {
                if (args[key] !== undefined) {
                    // `Game_Action.numRepeats()` reads `item().repeats` for a skill too, so
                    // no rename here: the MV spelling `repeat` would be inert.
                    fields[key] = Number(args[key]);
                }
            }
            for (const key of ["mpCost", "tpCost", "message1", "message2"] as const) {
                if (args[key] !== undefined) {
                    if (table !== "Skills") {
                        warnings.push(`make_item: ${key} is a Skills field and this row is a ${table.replace(/s$/, "").toLowerCase()} — it was not written`);
                        continue;
                    }
                    fields[key] = key.startsWith("message") ? String(args[key]) : Number(args[key]);
                }
            }
            if (args.stypeId !== undefined) {
                if (table !== "Skills") {
                    warnings.push(`make_item: stypeId belongs to a Skills row, not a ${table.replace(/s$/, "").toLowerCase()} — it was not written`);
                } else {
                    fields.stypeId = typeId(args.stypeId, system.skillTypes, "stypeId");
                }
            }
            if (args.itypeId !== undefined) {
                // MZ spells an item's type as a number, not a name: `Window_ItemList.includes`
                // shows a row when `itypeId` is 1 (the Item tab) or 2 (the Key Item tab) and
                // accepts nothing else, while `$dataSystem.itemCategories` is the four-tab
                // switch [item, weapon, armor, keyItem] — so 1 reads slot 0 and 2 slot 3.
                const asNumber = Number(args.itypeId);
                if (!Number.isInteger(asNumber)) {
                    throw new Error(
                        `make_item itypeId: "${args.itypeId}" cannot be resolved, because MZ has no item-type name list — that was MV's System.itemTypes. Pass 1 (the Item tab) or 2 (the Key Item tab)`
                    );
                }
                fields.itypeId = asNumber;
                if (asNumber !== 1 && asNumber !== 2) {
                    warnings.push(
                        `make_item itypeId: ${asNumber} is not a value the item menu reads, so this row will never be listed — the engine shows Items at 1 and key items at 2`
                    );
                } else if (system.itemCategories?.[asNumber === 1 ? 0 : 3] === false) {
                    warnings.push(
                        `make_item itypeId: the ${asNumber === 1 ? "Item" : "Key Item"} tab is switched off in this project (System.itemCategories), so the menu will not open it`
                    );
                }
            }
            if (args.wtypeId !== undefined) {
                fields.wtypeId = typeId(args.wtypeId, system.weaponTypes, "wtypeId");
            }
            if (args.atypeId !== undefined) {
                fields.atypeId = typeId(args.atypeId, system.armorTypes, "atypeId");
            }
            if (args.etypeId !== undefined) {
                fields.etypeId = typeId(args.etypeId, system.equipTypes, "etypeId");
            }
            if (args.params !== undefined) {
                fields.params = Array.isArray(args.params) ? args.params : PARAM_KEYS.map(key => Number((args.params as any)[key] ?? 0));
            }
            if (args.traits?.length) {
                fields.traits = (args.traits as any[]).map(trait => ({ code: Number(trait.code), dataId: Number(trait.dataId ?? 0), value: Number(trait.value ?? 0) }));
            }
            if (args.damage) {
                fields.damage = {
                    type: Number(args.damage.type ?? 1),
                    elementId: args.damage.element === undefined ? 0 : elementIdOf(system, args.damage.element),
                    formula: String(args.damage.formula ?? "0"),
                    variance: Number(args.damage.variance ?? 20),
                    critical: Boolean(args.damage.critical)
                };
            }
            if (args.effects?.length) {
                const effects: any[] = [];
                for (const [index, effect] of (args.effects as any[]).entries()) {
                    const push = (code: number, dataId: number, value1 = 0, value2 = 0) => effects.push({ code, dataId, value1, value2 });
                    const where = `effects[${index}]`;
                    if (effect.raw) {
                        effects.push({ code: Number(effect.raw.code), dataId: Number(effect.raw.dataId ?? 0), value1: Number(effect.raw.value1 ?? 0), value2: Number(effect.raw.value2 ?? 0) });
                        continue;
                    }
                    let written = 0;
                    if (effect.hp !== undefined || effect.hpFlat !== undefined) {
                        push(11, 0, Number(effect.hp ?? 0), Number(effect.hpFlat ?? 0));
                        written++;
                    }
                    if (effect.mp !== undefined || effect.mpFlat !== undefined) {
                        push(12, 0, Number(effect.mp ?? 0), Number(effect.mpFlat ?? 0));
                        written++;
                    }
                    if (effect.tp !== undefined) {
                        push(13, 0, Number(effect.tp));
                        written++;
                    }
                    if (effect.addState !== undefined) {
                        push(21, Number(namedRow(project, "States", effect.addState, `make_item ${where}`).id), Number(effect.chance ?? 1));
                        written++;
                    }
                    if (effect.removeState !== undefined) {
                        push(22, Number(namedRow(project, "States", effect.removeState, `make_item ${where}`).id), Number(effect.chance ?? 1));
                        written++;
                    }
                    for (const [key, code] of [
                        ["buff", 31],
                        ["debuff", 32],
                        ["removeBuff", 33],
                        ["removeDebuff", 34]
                    ] as const) {
                        if ((effect as any)[key] !== undefined) {
                            push(code, paramId((effect as any)[key], `${where} ${key}`), Number(effect.turns ?? 5));
                            written++;
                        }
                    }
                    if (effect.escape) {
                        push(41, 0, 1);
                        written++;
                    }
                    if (effect.commonEvent !== undefined) {
                        push(44, Number(namedRow(project, "CommonEvents", effect.commonEvent, `make_item ${where} commonEvent`).id));
                        written++;
                    }
                    if (!written) {
                        throw new Error(`make_item ${where}: nothing to compile out of ${JSON.stringify(effect)} — use one of hp, hpFlat, mp, mpFlat, tp, addState, removeState, buff, debuff, removeBuff, removeDebuff, escape, commonEvent, raw`);
                    }
                }
                fields.effects = effects;
            }

            const unknown = Object.keys(fields).filter(key => !(key in template));
            if (unknown.length) {
                warnings.push(
                    `make_item: ${table}.json rows carry no ${unknown.join(", ")} field in this project — a row has ${Object.keys(template).join(", ")}. The engine never reads what was written under those keys (MV's rarity, for one)`
                );
            }

            if (args.dryRun) {
                return done(context, "make_item", { dryRun: true, table, id, wouldWrite: Object.keys(fields), effectsPlanned: ((fields.effects ?? []) as any[]).map((effect: any) => `${effect.code}/${effect.dataId}: ${effect.value1}+${effect.value2}`) }, [], [], [], warnings);
            }
            const { value, wrote } = await context.transaction(async () => {
                if (id === null) {
                    const created = await context.call("create_database_entry", { table, copyFrom: templateId, fields });
                    return { id: Number(created.id), basedOn: created.basedOn, existing: false };
                }
                await context.call("patch_database_entry", { table, id, patch: fields });
                return { id, basedOn: id, existing: true };
            });
            if (table === "Items" && !fields.itypeId && !Number((rows.find((row: any) => row?.id === value.id) ?? {})?.itypeId ?? 1)) {
                warnings.push(`make_item: Items ${value.id} has itypeId 0, which is no type — the inventory cannot list it, so no one will ever find it. Pass itypeId`);
            }
            return done(
                context,
                "make_item",
                {
                    table,
                    id: value.id,
                    made: value.existing ? `rewrote ${table} ${value.id}` : `made ${table} ${value.id}`,
                    basedOn: value.basedOn,
                    fieldsWritten: Object.keys(fields),
                    ...(fields.effects ? { effects: (fields.effects as any[]).map(effect => describeItemEffect(effect, project)) } : {}),
                    ...(fields.damage ? { damage: fields.damage } : {})
                },
                [],
                wrote,
                [],
                warnings
            );
        })
    );
}

// ---------------------------------------------------------------------------
// Database rows: names, parameters and effects in words
// ---------------------------------------------------------------------------

const PARAM_KEYS = ["hp", "mp", "atk", "def", "mat", "mdf", "agi", "luk"];
const PARAM_NAMES_LITERAL = ["hp", "mp", "atk", "def", "mat", "mdf", "agi", "luk"] as const;

/** A row by id or by name, in the tables an agent spells out rather than numbers. */
function namedRow(project: Project, table: string, wanted: unknown, where: string): any {
    if (Number.isInteger(Number(wanted)) && !Number.isNaN(Number(wanted))) {
        return assertRow(project, table, Number(wanted), where);
    }
    const rows: any[] = project.readData(table);
    const hit = rows.find((row: any) => row?.name && String(row.name) === String(wanted));
    if (!hit) {
        const sample = rows.filter((row: any) => row?.name).slice(0, 8).map((row: any) => row.name);
        throw new Error(`${where}: no ${table} row named "${wanted}". Some of what is there: ${sample.join(", ")}`);
    }
    return hit;
}

/** An element id from `System.elements`, by name or number, keeping the engine's -1. */
function elementIdOf(system: any, wanted: unknown): number {
    const asNumber = Number(wanted);
    if (!Number.isNaN(asNumber) && Number.isInteger(asNumber)) {
        return asNumber;
    }
    const list: string[] = system.elements ?? [];
    const index = list.findIndex(name => String(name) === String(wanted));
    if (index < 1) {
        throw new Error(`no element named "${wanted}". The elements are: ${list.slice(1).filter(Boolean).join(", ")}`);
    }
    return index;
}

const ITEM_EFFECT_NAMES: Record<number, string> = {
    11: "recover HP",
    12: "recover MP",
    13: "gain TP",
    21: "add state",
    22: "remove state",
    31: "add buff",
    32: "add debuff",
    33: "remove buff",
    34: "remove debuff",
    41: "special",
    42: "grow",
    43: "learn skill",
    44: "common event"
};

/** What an effect the tool just wrote will do, in the words it was asked in. */
function describeItemEffect(effect: any, project: Project): string {
    const name = ITEM_EFFECT_NAMES[effect.code] ?? `code ${effect.code}`;
    if (effect.code === 11 || effect.code === 12) {
        return `${name} ${(effect.value1 * 100).toFixed(0)}% + ${effect.value2}`;
    }
    if (effect.code === 21 || effect.code === 22) {
        const state = (project.readData("States") as any[]).find((row: any) => row?.id === effect.dataId);
        return `${name} ${effect.dataId}${state ? ` "${state.name}"` : ""} at ${Math.round((effect.value1 ?? 1) * 100)}%`;
    }
    if (effect.code >= 31 && effect.code <= 34) {
        return `${name} ${PARAM_KEYS[effect.dataId] ?? effect.dataId} for ${effect.value1} turns`;
    }
    if (effect.code === 44) {
        const event = (project.readData("CommonEvents") as any[]).find((row: any) => row?.id === effect.dataId);
        return `${name} ${effect.dataId}${event ? ` "${event.name}"` : ""}`;
    }
    return `${name} data ${effect.dataId} value ${effect.value1}/${effect.value2}`;
}

// ---------------------------------------------------------------------------
// The live dialog, as the engine sees it
// ---------------------------------------------------------------------------

/**
 * One expression, everything a caller needs to decide what key is safe to send. The
 * window classes are asked rather than guessed: `isCursorMovable()` is the engine's own
 * gate for "will a cursor key land", and `isOpenAndActive()` is the same rule for Ok.
 */
const DIALOG_STATE = `(() => {
    const scene = SceneManager._scene;
    const message = $gameMessage;
    const list = scene && scene._choiceListWindow;
    const pad = scene && scene._numberInputWindow;
    const out = {
        scene: scene ? scene.constructor.name : "none",
        busy: message ? message.isBusy() : false,
        text: message ? message.allText() : "",
        hasText: message ? message.hasText() : false,
        waiting: message ? Number(message._waitCount ?? 0) : 0
    };
    if (list && message && message.isChoice()) {
        const count = list.maxItems ? list.maxItems() : 0;
        out.choice = {
            options: Array.from({ length: count }, (_, index) => ({
                label: list.commandName ? list.commandName(index) : null,
                enabled: list.isItemEnabled ? list.isItemEnabled(index) : true
            })),
            index: list.index ? list.index() : 0,
            movable: list.isCursorMovable ? list.isCursorMovable() : false,
            openAndActive: list.isOpenAndActive ? list.isOpenAndActive() : false,
            opening: list.isOpening ? list.isOpening() : false,
            cancelEnabled: list.isCancelEnabled ? list.isCancelEnabled() : true
        };
    }
    if (pad && message && message.isNumberInput()) {
        const digits = Number(pad._maxDigits || 0);
        const value = Number(pad._number || 0);
        out.number = {
            digits: Array.from({ length: digits }, (_, index) => Math.floor(value / Math.pow(10, digits - 1 - index)) % 10),
            value,
            index: pad.index ? pad.index() : 0,
            movable: pad.isCursorMovable ? pad.isCursorMovable() : false,
            variables: (message.numInputVariables ? message.numInputVariables() : []).map(variable => variable && variable._id).filter(Boolean)
        };
    }
    return out;
})()`;

// ---------------------------------------------------------------------------
// The labelled tile sheet describe_tiles can draw
// ---------------------------------------------------------------------------

const LAYER_OF: Record<string, number> = { A1: 1, A2: 1, A3: 2, A4: 3, A5: 0, B: 0, C: 0, D: 0, E: 0 };

/**
 * Paint the ids on a scratch map, render it with the map renderer, and print one
 * label per block. The scratch map is deleted again in the same call: it is a
 * drawing surface, not content, and the only reason it exists is that resolving an
 * autotile's 48 shapes to a picture is the renderer's job and not something to
 * re-implement here.
 */
async function contactSheet(
    context: HighLevelContext,
    tilesetId: number,
    tiles: any[],
    spec: any,
    warnings: string[]
): Promise<{ payload: Record<string, unknown>; base64: string }> {
    const columns = Number(spec.columns ?? 4);
    const scale = Number(spec.scale ?? 1);
    const rows = Math.ceil(tiles.length / columns);
    const width = columns * 4;
    const height = rows * 4;
    const made = await context.call("create_map", { name: `DT tileset ${tilesetId}`, width, height, tilesetId, parentId: 1 });
    const scratchId = Number(made.id);
    try {
        const cells: any[] = [];
        tiles.forEach((one: any, index: number) => {
            const left = (index % columns) * 4;
            const top = Math.floor(index / columns) * 4;
            for (let dy = 0; dy < 3; dy++) {
                for (let dx = 0; dx < 3; dx++) {
                    cells.push({ x: left + dx, y: top + dy, tileId: one.id });
                }
            }
        });
        await context.call("set_tiles", { mapId: scratchId, cells });
        const { payload, image } = await context.callWithImage("render_map", {
            mapId: scratchId,
            scale,
            showEvents: false,
            overlay: spec.overlay === "passage" ? "passage" : "none"
        });
        if (!image) {
            throw new Error(`render_map returned no picture (${JSON.stringify(payload).slice(0, 160)})`);
        }
        const bitmap = await loadImage(Buffer.from(image.data, "base64"));
        const canvas = createCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bitmap as any, 0, 0);
        const tilePx = bitmap.width / width;
        const fontPx = Math.max(10, Math.round(13 * scale));
        ctx.font = `${fontPx}px sans-serif`;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        tiles.forEach((one: any, index: number) => {
            const x = (index % columns) * 4 * tilePx;
            const y = Math.floor(index / columns) * 4 * tilePx + 3 * tilePx;
            const text = `${one.id} ${one.blockedFrom.length === 4 ? "BLOCKED" : one.blockedFrom.length ? `blocked ${one.blockedFrom.join("/")}` : "open"}${one.terrainTag ? ` t${one.terrainTag}` : ""}`;
            const boxWidth = Math.min(4 * tilePx - 2, ctx.measureText(text).width + 6);
            ctx.fillStyle = "rgba(0, 0, 0, 0.78)";
            ctx.fillRect(x, y, boxWidth, fontPx + 4);
            ctx.fillStyle = "#ffffff";
            ctx.fillText(text, x + 3, y + 2);
        });
        const png = canvas.toBuffer("image/png");
        if (spec.saveTo) {
            mkdirSync(dirname(spec.saveTo), { recursive: true });
            writeFileSync(spec.saveTo, png);
        }
        return {
            payload: {
                blocks: tiles.length,
                columns,
                rows,
                scale,
                pixels: [canvas.width, canvas.height],
                order: tiles.map((one: any, index: number) => `${index + 1}. ${one.id} (${one.slot}${one.cells ? `, ${one.cells} cells` : ""})`),
                ...(spec.saveTo ? { savedTo: spec.saveTo } : {}),
                notice: `the scratch map ${scratchId} was made to draw this and deleted again`
            },
            base64: png.toString("base64")
        };
    } finally {
        try {
            await context.call("delete_map", { mapId: scratchId, force: true });
        } catch (error) {
            warnings.push(`describe_tiles: the scratch map ${scratchId} is still in the project — delete_map refused (${(error as Error).message}), and undo_writes takes it back`);
        }
    }
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tile classification, from the engine's own predicates
// ---------------------------------------------------------------------------

function kindOf(statics: any, tileId: number): string {
    const Tilemap = statics?.Tilemap;
    if (!Tilemap || tileId <= 0) {
        return "empty";
    }
    for (const [name, test] of [
        ["A1", "isTileA1"],
        ["A2", "isTileA2"],
        ["A3", "isTileA3"],
        ["A4", "isTileA4"],
        ["A5", "isTileA5"]
    ] as const) {
        if (Tilemap[test]?.(tileId)) {
            return name;
        }
    }
    return ["B", "C", "D", "E"][Math.floor(tileId / 256)] ?? "?";
}

/** The 48 shape ids one autotile pattern is stored as, aligned to the A1 start. */
function shapeGroup(statics: any, tileId: number): { from: number; to: number } {
    const first = statics?.Tilemap?.TILE_ID_A1 ?? 2048;
    const base = first + Math.floor((tileId - first) / 48) * 48;
    return { from: base, to: base + 47 };
}

const SLOT_INDEX: Record<string, number> = { A1: 0, A2: 1, A3: 2, A4: 3, A5: 4, B: 5, C: 6, D: 7, E: 8 };

function sheetBound(tileset: any, slot: string): boolean {
    const index = SLOT_INDEX[slot];
    if (index === undefined) {
        return true;
    }
    return String(tileset.tilesetNames?.[index] ?? "").trim() !== "";
}

function hex(flag: number): string {
    return `0x${(flag >>> 0).toString(16).padStart(4, "0")}`;
}

/** What a flag value means in words, because a hex number does not say much. */
function describeFlags(flag: number): string {
    const parts: string[] = [];
    const blocked = ["down", "left", "right", "up"].filter((_, index) => (flag & (1 << index)) !== 0);
    parts.push(blocked.length === 4 ? "impassable" : blocked.length ? `blocked from ${blocked.join("+")}` : "passable");
    if (flag & FLAG_NO_PASSAGE_EFFECT) parts.push("override");
    if (flag & FLAG_LADDER) parts.push("ladder");
    if (flag & FLAG_BUSH) parts.push("bush");
    if (flag & FLAG_COUNTER) parts.push("counter");
    if (flag & FLAG_DAMAGE_FLOOR) parts.push("damage");
    if (flag & 0x200) parts.push("boat");
    if (flag & 0x400) parts.push("ship");
    if (flag & 0x800) parts.push("airship");
    const tag = flag >> FLAG_TERRAIN_SHIFT;
    if (tag) parts.push(`terrain ${tag}`);
    return parts.join(", ");
}
