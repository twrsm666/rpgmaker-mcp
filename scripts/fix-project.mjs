/**
 * Write the engine keys this project is missing, out loud.
 *
 *   npm run fix-project              # repair what can be repaired
 *   npm run fix-project -- --check   # report only, write nothing
 *
 * A project copied from the engine's `data/newdata` template — which is what the README
 * tells a first-time reader to point `RMMZ_PROJECT` at — lacks `System.advanced.windowOpacity`,
 * and the game then dies on its title screen with `Cannot read properties of undefined (reading
 * 'clamp')`. This is the one command for that, and the exit code says whether the project is
 * left in a state the engine can boot.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PACKAGE_ROOT, describeProjectChoice, liveToken, projectDir } from "./local-env.mjs";

const check = process.argv.slice(2).includes("--check");

process.env.RMMZ_PROJECT = projectDir;
const token = liveToken();
if (token) {
    process.env.RMMZ_LIVE_TOKEN = token;
}
console.log(describeProjectChoice());

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { server } = await import(pathToFileURL(join(PACKAGE_ROOT, "dist", "index.js")).href);
const client = new Client({ name: "fix-project", version: "1.0.0" });
const pair = InMemoryTransport.createLinkedPair();
await server.connect(pair[1]);
await client.connect(pair[0]);

const result = await client.callTool({ name: "fix_project", arguments: { dryRun: check } });
const text = result.content?.find(part => part.type === "text")?.text ?? "";
if (result.isError) {
    console.error(`fix_project refused: ${text.slice(0, 400)}`);
    process.exit(1);
}
const reply = JSON.parse(text);
console.log(JSON.stringify(reply, null, 2));

const blocked = reply.cannotFix ?? [];
if (check) {
    const planned = reply.planned ?? [];
    console.log(
        planned.length
            ? `${planned.length} key(s) missing, and they would be written from ${planned[0].source ?? reply.tookValuesFrom ?? "?"}`
            : "nothing missing: the engine has every key it reads without a fallback"
    );
    process.exitCode = planned.length || blocked.length ? 1 : 0;
} else {
    console.log(
        reply.changed
            ? `wrote ${JSON.stringify(reply.repaired)} into ${join(projectDir, "data", "System.json")}`
            : "wrote nothing — every engine key this project needs is already there"
    );
    process.exitCode = blocked.length || reply.everyEngineKeyPresent === false ? 1 : 0;
}
if (blocked.length) {
    for (const entry of blocked) {
        console.error(`cannot repair ${entry.path}: ${entry.why}`);
    }
}
process.exit(process.exitCode ?? 0);
