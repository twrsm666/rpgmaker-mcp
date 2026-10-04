import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dumpMzJson, isExpandedStyle, parseMzJson } from "./core/json.js";

/**
 * Round-trip check against files the editor itself wrote: parse and re-serialize
 * must reproduce the original bytes, otherwise every write would produce a
 * whole-file diff. Usage: node dist/roundtrip.js <path-to-data-dir>
 */
const dir = process.argv[2];
if (!dir || !existsSync(dir)) {
    console.error("usage: node dist/roundtrip.js <path to a project's data directory>");
    process.exit(1);
}

let failures = 0;
for (const file of readdirSync(dir).filter(name => name.endsWith(".json"))) {
    const original = readFileSync(join(dir, file), "utf8");
    const value = parseMzJson(original);
    const rewritten = dumpMzJson(value, isExpandedStyle(original));
    if (rewritten === original) {
        console.log(`  ok     ${file}`);
    } else {
        failures++;
        const firstDifference = [...original].findIndex((char, index) => char !== rewritten[index]);
        console.log(
            `  DIFFER ${file} at char ${firstDifference} of ${original.length}\n` +
                `         original: ${JSON.stringify(original.slice(Math.max(0, firstDifference - 30), firstDifference + 40))}\n` +
                `         rewritten: ${JSON.stringify(rewritten.slice(Math.max(0, firstDifference - 30), firstDifference + 40))}`
        );
    }
}
console.log(failures === 0 ? "round-trip identical for all files" : `${failures} file(s) differ`);
process.exit(failures === 0 ? 0 : 1);
