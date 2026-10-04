import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface CommandParamSpec {
    index: number;
    name: string;
}

export interface CommandSpec {
    code: number;
    method: string | null;
    label: string | null;
    params: CommandParamSpec[];
    confidence: "high" | "medium" | "low";
    body?: string;
}

export interface Codebook {
    byCode: Map<number, CommandSpec>;
    source: string | null;
}

const EMPTY: Codebook = { byCode: new Map<number, CommandSpec>(), source: null };

let cached: Codebook | null = null;

/**
 * Loads the command dictionary produced by `scripts/extract-commands.mjs`,
 * which parses `Game_Interpreter.prototype.commandNNN` out of the engine.
 * Absent the file the server still works; commands are reported by raw code.
 */
export function loadCodebook(packageRoot: string): Codebook {
    if (cached) {
        return cached;
    }
    const candidates = [
        join(packageRoot, "src", "codebook", "commands.json"),
        join(packageRoot, "dist", "codebook", "commands.json"),
        process.env["RMMZ_CODEBOOK"] ?? ""
    ].filter(Boolean);
    for (const path of candidates) {
        if (!existsSync(path)) {
            continue;
        }
        const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
        const list: CommandSpec[] = Array.isArray(parsed)
            ? (parsed as CommandSpec[])
            : Array.isArray((parsed as { commands?: unknown }).commands)
              ? ((parsed as { commands: CommandSpec[] }).commands)
              : Object.values(parsed as Record<string, CommandSpec>);
        const byCode = new Map<number, CommandSpec>();
        for (const spec of list) {
            if (spec && typeof spec.code === "number") {
                byCode.set(spec.code, spec);
            }
        }
        cached = { byCode, source: path };
        return cached;
    }
    cached = EMPTY;
    return cached;
}

export function describeCommand(codebook: Codebook, command: { code: number; indent: number; parameters: unknown[] }): string {
    const spec = codebook.byCode.get(command.code);
    const name = spec?.label ?? spec?.method ?? `code ${command.code}`;
    const indent = "    ".repeat(command.indent);
    if (command.parameters.length === 0) {
        return `${indent}${name}`;
    }
    const rendered = command.parameters.map((value, index) => {
        const paramName = spec?.params?.[index]?.name;
        const text = JSON.stringify(value);
        return paramName ? `${paramName}=${text}` : text;
    });
    return `${indent}${name}(${rendered.join(", ")})`;
}

/**
 * Codes this engine's `Game_Interpreter` does not implement, as far as the codebook read
 * out of the engine can tell.
 *
 * Not a refusal: a plugin can add a command code, and the editor keeps whatever it is
 * handed. But two things silently stop working for a code that is not in the book —
 * `decode_commands` can only say "code 4001", so the author cannot read back what they
 * wrote, and no parameter check exists for it, so `validate_game` has nothing to say.
 * Both are worth naming at the moment the list is written.
 */
export function unknownCodeWarnings(codebook: Codebook, list: { code: number }[]): string[] {
    if (!codebook.source) {
        return [];
    }
    const missing = [...new Set(list.map(command => Number(command.code)).filter(code => Number.isInteger(code) && !codebook.byCode.has(code)))];
    if (missing.length === 0) {
        return [];
    }
    return [
        `${missing.length} command code(s) in this list are not implemented by the engine's Game_Interpreter as the codebook reads it: ${missing.join(", ")}. ` +
            `For those, decode_commands can only say "code N" and validate_game has no parameter check to run. ` +
            "A plugin that adds a command is a fine reason; a mistyped code is the other reason, and the game shows neither — check it against the editor."
    ];
}
