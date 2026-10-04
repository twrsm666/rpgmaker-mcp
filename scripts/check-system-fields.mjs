import { readFileSync } from "node:fs";

/**
 * Report the `System.json.advanced` fields the engine reads versus the fields a
 * project actually has. A project scaffolded from an older editor template is
 * missing keys the newer engine dereferences, and MZ fails with an opaque
 * `undefined.clamp` TypeError instead of a missing-field message.
 */
const projectDir = process.argv[2] ?? "..";
const files = ["rmmz_core.js", "rmmz_objects.js", "rmmz_windows.js", "rmmz_scenes.js", "rmmz_sprites.js", "rmmz_managers.js"];

const used = new Map();
for (const file of files) {
    let text;
    try {
        text = readFileSync(`${projectDir}/js/${file}`, "utf8");
    } catch {
        continue;
    }
    for (const match of text.matchAll(/\$dataSystem\.advanced\.(\w+)/g)) {
        if (!used.has(match[1])) {
            used.set(match[1], `${file}`);
        }
    }
}

const system = JSON.parse(readFileSync(`${projectDir}/data/System.json`, "utf8"));
const have = new Set(Object.keys(system.advanced ?? {}));
const missing = [...used.keys()].filter(key => !have.has(key));

console.log(`engine files under ${projectDir}/js`);
console.log(`engine reads ${used.size} advanced fields; project has ${have.size}`);
console.log(`MISSING (${missing.length}): ${missing.join(", ") || "none"}`);
for (const key of missing) {
    console.log(`   ${key} <- read in ${used.get(key)}`);
}
console.log(`UNUSED (${[...have].filter(key => !used.has(key)).length}): ${[...have].filter(key => !used.has(key)).join(", ") || "none"}`);
