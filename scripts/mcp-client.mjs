/**
 * Speak real MCP over stdio to the server exactly as it is registered in the
 * user's Qoder settings, so a build script exercises the same command, args and
 * environment an agent would get.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describeProjectChoice, projectSource, registeredServer, settingsPath } from "./local-env.mjs";

export async function withRegisteredServer(run) {
    const entry = registeredServer();
    if (!entry.command) {
        throw new Error(
            `no mcpServers.rpgmaker entry in ${settingsPath()}. Register \`node <this package>/dist/index.js\` with ` +
                `RMMZ_PROJECT and RMMZ_CORESCRIPT_ROOT in its env, or point RMMZ_SETTINGS at the file that has it.`
        );
    }
    // The registered entry is a default, not an order: whoever set RMMZ_PROJECT asked for
    // that project by name, and a suite that silently wrote somebody else's project is a
    // suite whose result means nothing. Printed before anything is written, for the same
    // reason.
    const chosen = projectSource();
    console.log(describeProjectChoice());
    const transport = new StdioClientTransport({
        command: entry.command,
        args: entry.args,
        env: { ...entry.env, ...process.env },
        cwd: chosen.dir
    });
    const client = new Client({ name: "tiny-game-builder", version: "1.0.0" });
    await client.connect(transport);
    try {
        // The client itself comes along so a caller can list the registry the way an
        // agent's MCP connection sees it, not just call tools on it.
        return await run(makeCall(client), client);
    } finally {
        await client.close();
    }
}

export function makeCall(client) {
    return async function call(name, args = {}, timeoutMs) {
        const result = await client.callTool(
            { name, arguments: args },
            undefined,
            timeoutMs === undefined ? {} : { timeout: timeoutMs }
        );
        const parts = Array.isArray(result.content) ? result.content : [];
        const text = parts.find(part => part.type === "text")?.text ?? "";
        const image = parts.find(part => part.type === "image") ?? null;
        if (result.isError) {
            throw new Error(`${name} failed: ${text.slice(0, 400)}`);
        }
        let parsed = {};
        try {
            parsed = text ? JSON.parse(text) : {};
        } catch {
            parsed = { raw: text };
        }
        return image ? { ...parsed, image } : parsed;
    };
}
