import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Project } from "./project.js";

/**
 * Reading and editing `js/plugins.js` without reformatting it.
 *
 * The editor writes that file as a JS literal rather than JSON: a comment header,
 * one object per line, and a trailing comma after the last entry. Re-serializing
 * the whole array would rewrite bytes nobody asked to change, so a patch replaces
 * exactly the one object span it touches and leaves the rest of the file alone.
 */

const PLUGIN_EXTENSIONS = ["js", "mjs"];

export interface PluginParameter {
    name: string;
    text?: string;
    type?: string;
    desc?: string;
    default?: string;
}

export interface PluginInfo {
    name: string;
    loadOrder: number;
    status: boolean;
    description: string;
    parameters: Record<string, unknown>;
    fileExists: boolean;
    file?: string;
    sourceBytes?: number;
    /** `@param` blocks the plugin file declares, in source order. */
    declared: PluginParameter[];
    /** Keys present in plugins.js that the file never declares. */
    undeclared: string[];
    /** Declared parameters with no entry in plugins.js, so the default applies. */
    unset: string[];
}

function skipString(text: string, index: number): number {
    const quote = text[index];
    for (let i = index + 1; i < text.length; i++) {
        if (text[i] === "\\") {
            i++;
        } else if (text[i] === quote) {
            return i;
        }
    }
    return index;
}

/** The inside of the `var $plugins = [...]` literal. */
function arrayBody(text: string): { start: number; end: number } {
    const anchor = text.indexOf("$plugins");
    const open = text.indexOf("[", anchor < 0 ? 0 : anchor);
    if (open < 0) {
        throw new Error("no array literal after var $plugins");
    }
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        const character = text[i];
        if (character === '"' || character === "'") {
            i = skipString(text, i);
        } else if (character === "[") {
            depth++;
        } else if (character === "]") {
            depth--;
            if (depth === 0) {
                return { start: open + 1, end: i };
            }
        }
    }
    throw new Error("the plugins array is not balanced");
}

/** Byte spans of each top-level object in the array, in file order. */
function objectSpans(text: string, body: { start: number; end: number }): { start: number; end: number }[] {
    const spans: { start: number; end: number }[] = [];
    let depth = 0;
    let start = -1;
    for (let i = body.start; i < body.end; i++) {
        const character = text[i];
        if (character === '"' || character === "'") {
            i = skipString(text, i);
        } else if (character === "{") {
            if (depth++ === 0) {
                start = i;
            }
        } else if (character === "}") {
            depth--;
            if (depth === 0 && start >= 0) {
                spans.push({ start, end: i + 1 });
                start = -1;
            }
        }
    }
    return spans;
}

export interface PluginsFile {
    text: string;
    entries: { span: { start: number; end: number }; data: any }[];
}

export function readPluginsFile(project: Project): PluginsFile {
    const text = project.readText("js/plugins.js");
    const body = arrayBody(text);
    return {
        text,
        entries: objectSpans(text, body).map(span => {
            try {
                return { span, data: JSON.parse(text.slice(span.start, span.end)) };
            } catch (error) {
                throw new Error(`plugins.js holds JSON that will not parse: ${(error as Error).message}`);
            }
        })
    };
}

/** Replace one entry's object literal and keep every other byte of the file. */
export function writePluginEntry(project: Project, file: PluginsFile, index: number, entry: unknown): { backupPath: string | null } {
    const target = file.entries[index];
    if (!target) {
        throw new Error(`No plugin entry at position ${index}`);
    }
    const updated = file.text.slice(0, target.span.start) + JSON.stringify(entry) + file.text.slice(target.span.end);
    return project.writeText("js/plugins.js", updated);
}

/** `@param` / `@command` blocks from a plugin's own comment header. */
export function readPluginDoc(source: string): { plugindesc?: string; target?: string; params: PluginParameter[]; commands: string[] } {
    const params: PluginParameter[] = [];
    const commands: string[] = [];
    let current: PluginParameter | null = null;
    let currentCommand: string | null = null;
    let inBlock = false;
    const result = { plugindesc: undefined as string | undefined, target: undefined as string | undefined, params, commands };

    for (const raw of source.split(/\r?\n/)) {
        const line = raw.replace(/^\s*\*?\s?/, "").trimEnd();
        if (/^\/\*:/.test(line) || /^\/\*\s*@target/.test(line)) {
            inBlock = true;
        } else if (/^\*\//.test(line)) {
            inBlock = false;
            current = null;
            currentCommand = null;
            continue;
        }
        if (!inBlock) {
            continue;
        }
        const match = /^@(\w+)\s*(.*)$/.exec(line);
        if (!match) {
            if (current && /^@desc\b/i.test(line) === false && line && !line.startsWith("//")) {
                current.desc = `${current.desc ?? ""} ${line}`.trim();
            }
            continue;
        }
        const [, tag, value] = match;
        if (tag === "param") {
            current = { name: value.trim() };
            params.push(current);
            currentCommand = null;
        } else if (tag === "command") {
            currentCommand = value.trim();
            if (currentCommand) {
                commands.push(currentCommand);
            }
            current = null;
        } else if (current && (tag === "text" || tag === "type" || tag === "desc" || tag === "default" || tag === "min" || tag === "max")) {
            const field = tag === "text" ? "text" : tag === "type" ? "type" : tag === "desc" ? "desc" : "default";
            const previous = current[field];
            current[field] = tag === "desc" && previous ? `${previous} ${value}`.trim() : value.trim();
        } else if (tag === "plugindesc" && !result.plugindesc) {
            result.plugindesc = value.trim();
        } else if (tag === "target" && !result.target) {
            result.target = value.trim();
        }
    }
    return result;
}

export function pluginPath(project: Project, name: string): string | null {
    for (const extension of PLUGIN_EXTENSIONS) {
        const path = join(project.dir, "js", "plugins", `${name}.${extension}`);
        if (existsSync(path)) {
            return path;
        }
    }
    return null;
}

export function listPlugins(project: Project): PluginInfo[] {
    const file = readPluginsFile(project);
    return file.entries.map((entry, loadOrder) => {
        const path = pluginPath(project, entry.data.name);
        const declared = path ? readPluginDoc(readFileSync(path, "utf8")).params : [];
        const names = new Set(declared.map(parameter => parameter.name));
        const configured = Object.keys(entry.data.parameters ?? {});
        return {
            name: entry.data.name,
            loadOrder,
            status: Boolean(entry.data.status),
            description: entry.data.description ?? "",
            parameters: entry.data.parameters ?? {},
            fileExists: Boolean(path),
            file: path ? `js/plugins/${entry.data.name}` : undefined,
            sourceBytes: path ? statSync(path).size : undefined,
            declared,
            undeclared: configured.filter(key => !names.has(key)),
            unset: [...names].filter(key => !configured.includes(key))
        };
    });
}

export function findPlugin(project: Project, name: string): { file: PluginsFile; index: number; entry: any } {
    const file = readPluginsFile(project);
    const index = file.entries.findIndex(item => item.data.name === name);
    if (index < 0) {
        const known = file.entries.map(item => item.data.name);
        throw new Error(
            `No plugin named "${name}" is listed in js/plugins.js. Known: ${known.length ? known.join(", ") : "(none)"}. ` +
                `list_plugins shows what is installed; a plugin file that has never been added through the editor has no entry here.`
        );
    }
    return { file, index, entry: file.entries[index].data };
}

/**
 * Add an entry to the end of the list, keeping whatever comma convention the file
 * already uses: the editor terminates every entry with a comma, a hand written
 * file may not, and rewriting the separators of entries nobody mentioned would be
 * the kind of diff that makes a project unmergeable.
 */
function appendPluginEntry(project: Project, file: PluginsFile, entry: unknown): { backupPath: string | null } {
    const json = JSON.stringify(entry);
    const last = file.entries[file.entries.length - 1];
    if (!last) {
        // An empty list gives no evidence of the convention, so use the editor's,
        // which terminates every entry: `[\n{...},\n];`
        const open = file.text.indexOf("[");
        return project.writeText("js/plugins.js", `${file.text.slice(0, open + 1)}\n${json},${file.text.slice(open + 1)}`);
    }
    const after = /^\s*,/.exec(file.text.slice(last.span.end));
    const at = after ? last.span.end + after[0].length : last.span.end;
    const trailing = Boolean(after);
    const inserted = trailing ? `\n${json},` : `,\n${json}`;
    return project.writeText("js/plugins.js", file.text.slice(0, at) + inserted + file.text.slice(at));
}

/** Switch a plugin on in the editor's list, filling in its declared defaults. */
export function enablePlugin(
    project: Project,
    name: string,
    source: string,
    parameters: Record<string, unknown> = {}
): { added: boolean; loadOrder: number; parameters: Record<string, unknown>; description: string } {
    const file = readPluginsFile(project);
    const doc = readPluginDoc(source);
    const index = file.entries.findIndex(item => item.data.name === name);
    if (index >= 0) {
        const entry = file.entries[index].data;
        const merged = { ...(entry.parameters ?? {}), ...parameters };
        writePluginEntry(project, file, index, { ...entry, status: true, parameters: merged });
        return { added: false, loadOrder: index, parameters: merged, description: entry.description ?? "" };
    }
    const defaults: Record<string, unknown> = {};
    for (const parameter of doc.params) {
        if (parameter.default !== undefined && parameter.default !== "") {
            defaults[parameter.name] = parameter.default;
        }
    }
    const merged = { ...defaults, ...parameters };
    const description = doc.plugindesc ?? "";
    appendPluginEntry(project, file, { name, status: true, description, parameters: merged });
    return { added: true, loadOrder: file.entries.length, parameters: merged, description };
}
