import { Project, ProjectError, databaseNames, isDatabaseName } from "./project.js";

/**
 * Add a row to a database table.
 *
 * MZ stores these as 1-based arrays where `row.id === index`, and the editor never
 * removes a row: a fresh project already ships unused slots as full-shaped rows with
 * an empty name (Items 2-5, Skills 4-30, ...), and the ids of everything that exists
 * are reserved by those rows. So "create" here means *claim the next blank slot*, and
 * only when the table has no blank left does it grow. That keeps ids stable, which is
 * the property every map event, actor note and saved game depends on.
 */

const NO_ROWS: Record<string, string> = {
    System: "System.json is one object, not rows: patch it with patch_database_entry.",
    MapInfos: "MapInfos is the map tree, not a database table: create_map adds both the map file and its entry."
};

/** A row the editor lists as empty. */
function isBlank(row: any): boolean {
    return Boolean(row) && String(row.name ?? "") === "";
}

export interface CreatedEntry {
    table: string;
    id: number;
    slot: "claimed blank slot" | "appended new row";
    basedOn: { id: number; name: string } | null;
    fieldsApplied: string[];
    entry: any;
    blanksLeft: number;
}

export function createDatabaseEntry(
    project: Project,
    table: string,
    options: { id?: number; copyFrom?: number; fields?: Record<string, unknown> } = {}
): CreatedEntry {
    if (NO_ROWS[table]) {
        throw new ProjectError(NO_ROWS[table]);
    }
    if (!isDatabaseName(table)) {
        throw new ProjectError(`"${table}" is not a database table. Available: ${databaseNames().join(", ")}`);
    }
    const rows: any[] = project.readData(table);
    if (!Array.isArray(rows)) {
        throw new ProjectError(`data/${table}.json is not an array of rows`);
    }

    const id = options.id ?? nextSlot(rows);
    if (!Number.isInteger(id) || id < 1) {
        throw new ProjectError(`Row id must be an integer 1 or above, got ${options.id}`);
    }
    const existing = rows[id];
    if (existing && String(existing.name ?? "") !== "") {
        throw new ProjectError(
            `${table}[${id}] already holds "${existing.name}". Use patch_database_entry to change it, ` +
                `or leave id out to take the next free slot.`
        );
    }
    if (!existing && id > rows.length) {
        throw new ProjectError(
            `${table} has rows up to ${rows.length - 1}; writing id ${id} would leave a hole at ${rows.length}. ` +
                "The engine reads $data" + table + "[id] directly, so a missing row throws the first time it is used."
        );
    }

    const template = pickTemplate(table, rows, id, options.copyFrom);
    const appended = !existing || id >= rows.length;
    const entry: any = template.clone ? JSON.parse(JSON.stringify(template.row)) : { ...template.row };
    const fields = options.fields ?? {};
    Object.assign(entry, fields);
    // MZ keeps the id twice: as the array index and in the row. The editor reads the
    // field, the runtime reads the index, so they have to agree.
    entry.id = id;

    rows[id] = entry;
    project.writeData(table, rows);

    return {
        table,
        id,
        slot: appended ? "appended new row" : "claimed blank slot",
        basedOn: template.basedOn,
        fieldsApplied: Object.keys(fields),
        entry,
        blanksLeft: rows.filter(isBlank).length
    };
}

/** The id the editor would use: the first blank slot, then the end of the table. */
function nextSlot(rows: any[]): number {
    for (let index = 1; index < rows.length; index++) {
        if (!rows[index] || isBlank(rows[index])) {
            return index;
        }
    }
    return rows.length;
}

/**
 * Where the new row's field shape comes from. Claiming a blank slot needs no template
 * at all — that row already holds the defaults the editor gave it. Otherwise a blank
 * sibling is the closest thing to an empty row this format has, and only a completely
 * full table falls back to copying a real entry, which the reply reports.
 */
function pickTemplate(
    table: string,
    rows: any[],
    id: number,
    copyFrom?: number
): { row: any; clone: boolean; basedOn: { id: number; name: string } | null } {
    if (copyFrom !== undefined) {
        const source = rows[copyFrom];
        if (!source) {
            throw new ProjectError(`copyFrom ${copyFrom} is not a row of ${table}`);
        }
        return { row: source, clone: true, basedOn: { id: copyFrom, name: String(source.name ?? "") } };
    }
    const current = rows[id];
    if (current) {
        return { row: current, clone: false, basedOn: null };
    }
    const blankIndex = rows.findIndex(isBlank);
    if (blankIndex > 0) {
        return { row: rows[blankIndex], clone: true, basedOn: { id: blankIndex, name: "" } };
    }
    const lastIndex = rows.length - 1;
    const last = rows[lastIndex];
    if (!last) {
        throw new ProjectError(
            `${table} has no row to copy the field shape from. Add the first one in the editor, or pass copyFrom.`
        );
    }
    return { row: last, clone: true, basedOn: { id: lastIndex, name: String(last.name ?? "") } };
}
