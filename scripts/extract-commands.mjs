#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Derive the event command dictionary from the shipped engine instead of from
 * documentation: `Game_Interpreter.prototype.commandNNN` is the authoritative
 * list of codes the runtime understands, the comment line above each definition
 * is the engine's own name for it, and the local variables assigned from
 * `parameters[N]` reveal what each positional argument means.
 *
 * Usage: node scripts/extract-commands.mjs <corescript-dir|corescript-root> [out.json]
 *   e.g. node scripts/extract-commands.mjs "C:/.../data/corescript/v1.8.0"
 */
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");

function resolveSource(argument) {
    if (!argument) {
        console.error("usage: node scripts/extract-commands.mjs <corescript version dir or root> [out.json]");
        process.exit(1);
    }
    const direct = join(argument, "rmmz_objects.js");
    if (existsSync(direct)) {
        return direct;
    }
    const versions = readdirSync(argument)
        .filter(name => /^v\d+\.\d+\.\d+$/.test(name))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const newest = versions[versions.length - 1];
    if (!newest) {
        console.error(`${argument} has neither rmmz_objects.js nor v*/ subfolders`);
        process.exit(1);
    }
    return join(argument, newest, "rmmz_objects.js");
}

const sourcePath = resolveSource(process.argv[2]);
const outputPath = process.argv[3] ?? join(packageRoot, "src", "codebook", "commands.json");
const source = readFileSync(sourcePath, "utf8");
const lines = source.split("\n");

function matchingBrace(text, openIndex) {
    let depth = 0;
    for (let i = openIndex; i < text.length; i++) {
        const char = text[i];
        if (char === "{") {
            depth++;
        } else if (char === "}") {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}

/** The engine names every command with a one-line comment directly above it. */
function commentFor(lineIndex) {
    for (let i = lineIndex - 1; i >= Math.max(0, lineIndex - 4); i--) {
        const line = lines[i].trim();
        if (line === "") {
            continue;
        }
        const comment = /^\/\/\s*(.+)$/.exec(line);
        if (comment) {
            return comment[1].trim();
        }
        return null;
    }
    return null;
}

/**
 * Pull `parameters[N]` bindings out of a function body. Two kinds of evidence:
 * a local assignment (`const id = params[1]`) or the call site the argument is
 * handed to (`$gameMessage.setBackground(params[2])`), which is how MZ's engine
 * usually consumes parameters. Bare inline uses still count toward the
 * parameter count so callers know the arity.
 */
function parseParams(body) {
    const named = new Map();
    let highest = -1;
    const binding = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:this\.currentCommand\(\)\.parameters|\bparams\b|\bparameters\b)\[(\d+)\]/g;
    for (const match of body.matchAll(binding)) {
        const index = Number(match[2]);
        highest = Math.max(highest, index);
        if (!named.has(index)) {
            named.set(index, match[1]);
        }
    }
    const callSite = /\.([A-Za-z_$][\w$]*)\(((?:[^()]|\([^()]*\))*)\)/g;
    for (const line of body.split("\n")) {
        for (const call of line.matchAll(callSite)) {
            const method = call[1];
            const args = splitArguments(call[2]);
            args.forEach((arg, position) => {
                for (const indexMatch of arg.matchAll(/(?:params|parameters)\[(\d+)\]/g)) {
                    const index = Number(indexMatch[1]);
                    highest = Math.max(highest, index);
                    if (!named.has(index)) {
                        named.set(index, args.length === 1 ? method : `${method}Arg${position}`);
                    }
                }
            });
        }
    }
    const inline = /(?:this\.currentCommand\(\)\.parameters|\bparams\b|\bparameters\b)\[(\d+)\]/g;
    for (const match of body.matchAll(inline)) {
        highest = Math.max(highest, Number(match[1]));
    }
    const params = [];
    for (let index = 0; index <= highest; index++) {
        params.push({ index, name: named.get(index) ?? `arg${index}`, named: named.has(index) });
    }
    return params;
}

/** Split a JS argument list on top-level commas. */
function splitArguments(text) {
    const parts = [];
    let depth = 0;
    let current = "";
    for (const char of text) {
        if (char === "(" || char === "[" || char === "{") {
            depth++;
        } else if (char === ")" || char === "]" || char === "}") {
            depth--;
        }
        if (char === "," && depth === 0) {
            parts.push(current.trim());
            current = "";
            continue;
        }
        current += char;
    }
    if (current.trim()) {
        parts.push(current.trim());
    }
    return parts;
}

function parseContinuations(body) {
    const scans = [...body.matchAll(/nextEventCode\(\)\s*===\s*(\d+)/g)].map(match => Number(match[1]));
    return [...new Set(scans)];
}

const definitions = [];
const definitionPattern = /^Game_Interpreter\.prototype\.command(\d+) = function\(([^)]*)\)/g;
for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const match = definitionPattern.exec(lines[lineIndex]);
    if (!match) {
        continue;
    }
    definitionPattern.lastIndex = 0;
    const code = Number(match[1]);
    const start = source.indexOf(lines[lineIndex]);
    const brace = source.indexOf("{", start);
    const end = matchingBrace(source, brace);
    const body = end > brace ? source.slice(brace + 1, end) : "";
    definitions.push({
        code,
        method: `command${code}`,
        label: commentFor(lineIndex),
        args: match[2].trim(),
        params: parseParams(body),
        continuations: parseContinuations(body),
        body: body.trim().slice(0, 1200),
        sourceLine: lineIndex + 1
    });
}

// Codes the interpreter has no handler for are still real: they are the
// continuation lines an opener consumes in a loop, so the opener's comment names
// them and the engine's own scan proves they exist.
const handled = new Set(definitions.map(definition => definition.code));
const derived = [];
for (const definition of definitions) {
    for (const code of definition.continuations) {
        if (handled.has(code) || derived.some(entry => entry.code === code)) {
            continue;
        }
        derived.push({
            code,
            method: null,
            label: `${definition.label ?? `command${definition.code}`} line`,
            args: "",
            params: [{ index: 0, name: "text", named: false }],
            continuations: [],
            body: "",
            derivedFrom: definition.code,
            sourceLine: definition.sourceLine
        });
    }
}

// Two codes the editor writes that have no `Game_Interpreter` handler and are not
// continuation lines either: the terminator, and the End If that closes a
// Conditional Branch. Both are inert at runtime — `executeCommand` finds no
// method and steps over them — but they carry the block's shape, and without an
// entry here every branch decoded as a hole.
const markers = [
    { code: 0, method: null, label: "End of commands / branch separator", args: "", params: [], continuations: [], body: "", derivedFrom: null, sourceLine: 0 },
    { code: 412, method: null, label: "End If", args: "", params: [], continuations: [], body: "", derivedFrom: null, sourceLine: 0 }
].filter(marker => !handled.has(marker.code));

const entries = [...definitions, ...derived, ...markers]
    .sort((a, b) => a.code - b.code)
    .map(entry => ({
        code: entry.code,
        method: entry.method,
        label: entry.label,
        params: entry.params,
        continuations: entry.continuations,
        confidence: entry.label && entry.params.some(param => param.named) ? "high" : entry.label ? "medium" : "low",
        derivedFrom: entry.derivedFrom,
        body: entry.body || undefined
    }));

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify({ source: sourcePath, count: entries.length, commands: entries }, null, 2), "utf8");

const counts = { high: 0, medium: 0, low: 0 };
for (const entry of entries) {
    counts[entry.confidence]++;
}
console.log(`${entries.length} commands from ${sourcePath}`);
console.log(`confidence: high=${counts.high} medium=${counts.medium} low=${counts.low}, derived continuation codes=${derived.length}`);
