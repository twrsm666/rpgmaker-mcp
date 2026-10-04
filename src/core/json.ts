/**
 * RPG Maker MZ stores `data/*.json` either as one compact line (`System.json`)
 * or with line breaks only at the top level: scalars and nested objects share a
 * line, while array-valued properties are written one per line with compact
 * elements. The editor parses any valid JSON, but round-tripping in a different
 * style churns the whole file in a diff, so the writer mirrors the input style.
 */
export function isExpandedStyle(text: string): boolean {
    return text.split("\n").length > 3;
}

export function parseMzJson(text: string): any {
    return JSON.parse(text);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsOnlyNumbers(value: unknown[]): boolean {
    return value.every(item => typeof item === "number");
}

function property(key: string, value: unknown): string {
    return `${JSON.stringify(key)}:${JSON.stringify(value)}`;
}

/**
 * Map files break these two keys onto their own line even when empty; every
 * other property only moves to its own line when it holds a non-empty array.
 */
const MULTILINE_KEYS = new Set(["data", "events"]);

function expandedArray(value: unknown[], multiline = false): string {
    if (value.length === 0) {
        return multiline ? "[\n]" : "[]";
    }
    if (!multiline && containsOnlyNumbers(value)) {
        return JSON.stringify(value);
    }
    return `[\n${value.map(item => JSON.stringify(item)).join(",\n")}\n]`;
}

/** A property stays on the shared line unless it holds a non-empty array. */
function isOwnLine(key: string, value: unknown): boolean {
    return MULTILINE_KEYS.has(key) || (Array.isArray(value) && value.length > 0);
}

function expandedObject(value: Record<string, unknown>): string {
    // Property order is preserved: consecutive inline properties share one line
    // and each `data`/`events` style array is written on its own line, matching
    // how the editor serializes map files.
    const lines: string[] = [];
    let pending: string[] = [];
    const flush = () => {
        if (pending.length > 0) {
            lines.push(pending.join(","));
            pending = [];
        }
    };
    for (const [key, item] of Object.entries(value)) {
        if (isOwnLine(key, item)) {
            flush();
            lines.push(`${JSON.stringify(key)}:${expandedArray(item as unknown[], key === "events")}`);
        } else {
            pending.push(property(key, item));
        }
    }
    flush();
    return `{\n${lines.join(",\n")}\n}`;
}

/** Serialize `value`; `expanded` should come from `isExpandedStyle(original)`. */
export function dumpMzJson(value: unknown, expanded: boolean): string {
    if (!expanded) {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return expandedArray(value);
    }
    if (isPlainObject(value)) {
        return expandedObject(value);
    }
    return JSON.stringify(value);
}
