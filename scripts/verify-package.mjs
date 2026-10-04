/**
 * Verify the thing you would actually publish, not the working tree.
 *
 *   npm run verify:package
 *
 * `npm pack` writes the tarball from the `files` allow-list, this script unpacks it into
 * `.rpgmaker-mcp/package-check/`, and then asks two questions of the unpacked result: is
 * anything in it that must not be public (a project, an asset, a token, a machine path),
 * and does it run — spawned as its own process, answering `tools/list`, with the same tool
 * names the working tree exposes. A file missing from `files`, or a doc whose numbers have
 * drifted from the registry, fails here rather than on the npm registry.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PACKAGE_ROOT, liveToken, projectDir, registeredServer } from "./local-env.mjs";
import { makeCall } from "./mcp-client.mjs";

const SCRATCH = join(PACKAGE_ROOT, ".rpgmaker-mcp", "package-check");
const HIGH_LEVEL = ["describe_tiles", "link_maps", "live_dialog", "fix_project", "make_battle", "make_chest", "make_choice_scene", "make_encounter_zone", "make_item", "make_map", "make_npc", "make_shop", "set_startup", "set_tileset_flags", "clear_events", "validate_game"];

let failures = 0;
const check = (name, condition, detail) => {
    if (!condition) {
        failures++;
    }
    console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}${condition || detail === undefined ? "" : ` -> ${JSON.stringify(detail).slice(0, 400)}`}`);
};

/** Every file in a tree, with the tarball's own `package/` prefix stripped off. */
function walk(dir, base = dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? walk(path, base) : [resolve(path).slice(resolve(base).length + 1).replace(/\\/g, "/")];
    });
}

const textOf = files =>
    files
        .filter(name => /\.(?:js|mjs|cjs|json|md|ts|txt|env|sh)$/i.test(name))
        .map(name => ({ name, text: readFileSync(join(SCRATCH, "package", name), "utf8") }));

// ---------------------------------------------------------------------------
// 1. pack it, unpack it
// ---------------------------------------------------------------------------

const version = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;
console.log(`\n== 1. the publishable tree, made the way npm makes it`);
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
// `shell: true` because npm and tar on Windows are shims spawnSync will not find on its own,
// and the command is one string: a GNU tar on PATH reads an absolute `C:\…` argument as
// "remote host C:", so tar is handed a relative name with the scratch folder as its cwd.
const run = (command, options = {}) => spawnSync(command, { encoding: "utf8", shell: true, cwd: PACKAGE_ROOT, ...options });
const packed = run(`npm pack --pack-destination "${SCRATCH}"`);
const found = readdirSync(SCRATCH).filter(name => name.endsWith(".tgz"));
const tarball = found.includes(`rpgmaker-mcp-${version}.tgz`) ? join(SCRATCH, `rpgmaker-mcp-${version}.tgz`) : "";
check(`npm pack produced rpgmaker-mcp-${version}.tgz`, Boolean(tarball) && packed.status === 0, { status: packed.status, out: packed.stdout?.slice(-300), err: packed.stderr?.slice(0, 300) });
if (!tarball) {
    console.log(`\nFATAL — nothing to check: ${packed.error?.message ?? packed.stderr ?? "npm pack wrote no tarball"}`);
    process.exit(1);
}

const extracted = run(`tar -xzf "${tarball.split(/[\\/]/).pop()}"`, { cwd: SCRATCH });
check("and it unpacks", extracted.status === 0, extracted.stderr?.slice(0, 300));
const files = existsSync(join(SCRATCH, "package")) ? walk(join(SCRATCH, "package")) : [];
console.log(`   · ${files.length} files, ${(statSync(tarball).size / 1024).toFixed(1)} kB in the tarball, sha256 ${createHash("sha256").update(readFileSync(tarball)).digest("hex").slice(0, 16)}…`);

// ---------------------------------------------------------------------------
// 2. what a stranger would find in it
// ---------------------------------------------------------------------------

console.log(`\n== 2. the allow-list did its job`);
for (const required of ["package.json", "dist/index.js", "plugin/RMMZLiveBridge.js", "scripts/verify-full.mjs", "scripts/verify-package.mjs", "scripts/census.mjs", "scripts/fix-project.mjs", "scripts/ensure-bootable.mjs", "assets/lighthouse-night.png", "README.md", "ACCEPTANCE.md", "REVIEW-RESPONSE.md", "CHANGELOG.md", "RELEASING.md", "LICENSE"]) {
    check(`${required} is in it`, files.includes(required), files.filter(name => name.startsWith(required.split("/")[0])).slice(0, 6));
}
// The acceptance game's ending picture has to come from inside this package: a build that
// reaches outside it for one of its own files is a build nobody else can run. And a
// stranger must not be asked to compile anything — `npm pack` strips `package-lock.json`
// (only `npm-shrinkwrap.json` is publishable), so the runbook says `npm install`, and what
// has to be true either way is that `dist/` is already there.
const packedManifest = JSON.parse(readFileSync(join(SCRATCH, "package", "package.json"), "utf8"));
check("nothing in it asks the installer to build: no prepare or prepack hook", !packedManifest.scripts?.prepare && !packedManifest.scripts?.prepack, Object.keys(packedManifest.scripts ?? {}));
check(`and the entry points it advertises are in the tree (${packedManifest.main})`, files.includes(String(packedManifest.main)) && files.includes(String(packedManifest.bin?.["rpgmaker-mcp"])), { main: packedManifest.main, bin: packedManifest.bin });
const packedReadme = readFileSync(join(SCRATCH, "package", "README.md"), "utf8");
check("the runbook's first command is the one that works here (`npm install`, not `npm ci`)", !files.includes("package-lock.json") && !files.includes("npm-shrinkwrap.json") && /npm install/.test(packedReadme), /npm (?:install|ci)/.exec(packedReadme)?.[0]);
for (const [label, pattern] of [
    ["the engine's command codebook", "codebook/commands.json"],
    ["the author's play logs and screenshots", "samples/"],
    ["a generated codebook or scratch dir", ".rpgmaker-mcp"],
    ["a plugin as installed into a project", "js/plugins.js"],
    ["the TypeScript sources", "src/"]
]) {
    const hits = files.filter(name => name.includes(pattern));
    check(`and none of ${label} (${pattern})`, hits.length === 0, hits.slice(0, 5));
}
check("the working tree's own engine tables are not smuggled in", !files.some(name => /^data\/.*\.json$/.test(name)), files.filter(name => name.startsWith("data/")).slice(0, 5));

console.log(`\n== 3. nothing in it names this machine or its secret`);
// This script is the one that writes the needles down, so it cannot be clean of them.
const SELF = "scripts/verify-package.mjs";
const banned = [
    ["the live bridge token", liveToken()],
    ["the RPG Maker project path", projectDir],
    ["a user home path", "\\Users\\"],
    ["a user home path, forward-slashed", "/Users/"],
    ["this machine's user name", homedir().split(/[\\/]/).pop()]
];
const texts = textOf(files).filter(({ name }) => name !== SELF);
for (const [label, needle] of banned) {
    if (!needle) {
        continue;
    }
    const hits = texts.filter(({ text }) => text.includes(needle)).map(({ name }) => name);
    check(`no shipped file contains ${label}`, hits.length === 0, hits.slice(0, 5));
}
const shipped = texts.find(({ name }) => name === "plugin/RMMZLiveBridge.js")?.text ?? "";
const local = readFileSync(join(PACKAGE_ROOT, "plugin", "RMMZLiveBridge.js"), "utf8");
check("the bridge plugin published is byte-for-byte the one the working tree has", shipped === local, { shipped: shipped.length, local: local.length });
const declared = /@version (\S+)/.exec(shipped)?.[1];
check(`and its @version (${declared}) equals the BRIDGE_VERSION live_status compares against`, declared === /BRIDGE_VERSION = "([^"]+)"/.exec(shipped)?.[1], {
    declared,
    compared: /BRIDGE_VERSION = "([^"]+)"/.exec(shipped)?.[1]
});

// ---------------------------------------------------------------------------
// 4. does the unpacked server run, and is it the same server
// ---------------------------------------------------------------------------

console.log(`\n== 4. the unpacked server, spawned on its own`);
const entry = registeredServer();
const env = { ...entry.env, ...process.env, RMMZ_PROJECT: projectDir };
const names = async client => (await client.listTools()).tools.map(tool => tool.name).sort();

/** Spawn a `dist/index.js` as its own process and read its registry, the way a client does. */
async function spawnAt(script, label) {
    const client = new Client({ name: `package-check-${label}`, version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [script], env, cwd: projectDir }));
    return { client, tools: await names(client) };
}

let publishedClient;
let listed = [];
let localTools = [];
try {
    const opened = await spawnAt(join(SCRATCH, "package", "dist", "index.js"), "published");
    publishedClient = opened.client;
    listed = opened.tools;
    check("it answers tools/list", listed.length > 0, listed.length);
    check(`and its handshake advertises the published version (${version})`, publishedClient.getServerVersion()?.version === version, publishedClient.getServerVersion());

    const working = await spawnAt(join(PACKAGE_ROOT, "dist", "index.js"), "working-tree");
    localTools = working.tools;
    await working.client.close();

    const missing = localTools.filter(name => !listed.includes(name));
    const extra = listed.filter(name => !localTools.includes(name));
    check(`the published registry is the working tree's, name for name (${localTools.length} tools)`, missing.length === 0 && extra.length === 0, { missing, extra });
    check(`all ${HIGH_LEVEL.length} high-level calls survive the pack`, HIGH_LEVEL.every(name => listed.includes(name)), HIGH_LEVEL.filter(name => !listed.includes(name)));
    check("every published tool carries a description worth reading", (await publishedClient.listTools()).tools.every(tool => (tool.description ?? "").length >= 40));

    console.log(`\n== 5. the docs published with it still match the registry`);
    const readme = texts.find(({ name }) => name === "README.md")?.text ?? "";
    const acceptance = texts.find(({ name }) => name === "ACCEPTANCE.md")?.text ?? "";
    const stated = (row) => Number(new RegExp(`\\| ${row}[^|]*\\| (\\d+) \\|`).exec(acceptance)?.[1] ?? 0);
    const total = Number(/\*\*Total\*\* \| \*\*(\d+)\*\* \|/.exec(acceptance)?.[1] ?? 0);
    check(`ACCEPTANCE.md's stated total (${total}) equals the live count (${listed.length})`, total === listed.length, { total, live: listed.length });
    check(`its high-level row (${stated("High-level")}) equals the layer's own ${HIGH_LEVEL.length} tools`, stated("High-level") === HIGH_LEVEL.length, { stated: stated("High-level") });
    check(`primitives + high-level = the total`, stated("Primitives") + stated("High-level") === total, { primitives: stated("Primitives"), high: stated("High-level"), total });
    check("the packed README has no placeholder left in it", !/TODO|FIXME|coming soon/i.test(readme), readme.match(/.{0,60}(?:TODO|FIXME|coming soon).{0,60}/i)?.[0]);

    console.log(`\n== 6. three real calls through the published code`);
    // The house call helper, not the SDK's positional overload: `callTool(name, args)` is a
    // shape this version does not answer, and an unanswered call reads as a timeout.
    const call = makeCall(publishedClient);
    const info = await call("project_info", {}, 120000);
    check(`project_info reaches the project this run named (${info.gameTitle || "an untitled project"})`, Boolean(info.projectDir), Object.keys(info).slice(0, 8));
    // A fresh install has no command dictionary — it is derived from a licensed engine and is
    // deliberately not published. What has to be true either way is that the reply says so.
    const book = info.codebook ?? {};
    check(book.loaded ? `the published build carries its codebook (${book.commands} commands)` : "no codebook in the published build, and `project_info` says so with the command to run", book.loaded === true || /extract:commands/.test(book.howToFix ?? ""), book);
    check(`and it still reads the renderer from your install (${info.renderer?.engine ?? "none"})`, /^v\d/.test(info.renderer?.engine ?? ""), info.rendererError ?? info.renderer);
    const maps = await call("list_maps", {});
    check(`list_maps returns ${maps.maps?.length} maps`, (maps.maps ?? []).length > 0, maps.maps?.length);
    // Which map is read depends on what the project holds: the acceptance game's if it is here,
    // the reader's own first map if it is not. Judging a project this server never wrote is not
    // this suite's job — proving the published code answers three real calls is.
    const relay = (maps.maps ?? []).filter(map => /^SR /.test(map.name));
    const sample = relay[0] ?? (maps.maps ?? [])[0];
    check(`the published tree reads a map (${sample?.name ?? "none"} ${sample?.id ?? "?"}, ${relay.length ? "the acceptance game" : "a project of your own"})`, sample?.id > 0, relay.map(map => map.name));
    const tiles = await call("describe_tiles", { mapId: sample?.id });
    check(`describe_tiles answers for map ${sample?.id} without being asked for a sheet`, (tiles.tiles ?? []).length > 0 && tiles.image === undefined, {
        ids: tiles.tiles?.length,
        slots: tiles.slots?.length,
        image: tiles.image !== undefined,
        warning: tiles.warnings?.[0]
    });
    const sound = await call("validate_game", { mapIds: [sample?.id] });
    check(`validate_game answers with a report rather than an error (${sound.checked?.events ?? "?"} events, ${sound.ok === true ? "sound" : `${(sound.problems ?? []).filter(p => p.severity === "error").length} error(s)`})`, Array.isArray(sound.problems) && typeof sound.ok === "boolean", Object.keys(sound).slice(0, 6));
    if (relay.length >= 3) {
        const wholeGame = await call("validate_game", { mapIds: relay.map(map => map.id) });
        check("and the acceptance game this package was built beside is sound", wholeGame.ok === true, (wholeGame.problems ?? []).slice(0, 3));
    }
} finally {
    await publishedClient?.close().catch(() => {});
    // The extracted tree is scratch; the tarball is left where it is, because the next thing
    // you want to do after this passes is publish exactly the file it just checked.
    rmSync(join(SCRATCH, "package"), { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURES`} — ${files.length} published files, ${listed.length} tools in the published registry, ${localTools.length} in the working tree`);
if (failures === 0) {
    console.log(`the tarball this checked is left at ${tarball.replace(/\\/g, "/")}`);
}
process.exit(failures === 0 ? 0 : 1);
