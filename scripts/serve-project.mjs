import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Serve an MZ project over http so a browser can run it as a playtest.
 * Separate from scripts/verify-live.mjs because that one owns both the http
 * port and the live bridge port, and a demo driven through an already
 * registered MCP server needs the bridge to belong to that process alone.
 */
const here = resolve(fileURLToPath(import.meta.url), "..", "..");
const projectDir = resolve(process.argv[2] ?? join(here, "..", "demo-project"));
const port = Number(process.argv[3] ?? 8080);

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".gif": "image/gif",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".webm": "video/webm",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".css": "text/css; charset=utf-8",
    ".efkefc": "application/octet-stream",
    ".txt": "text/plain; charset=utf-8"
};

createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const file = normalize(join(projectDir, path));
    if (!file.startsWith(projectDir) || !existsSync(file)) {
        response.writeHead(404).end("not found");
        return;
    }
    response.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    response.end(readFileSync(file));
}).listen(port, "127.0.0.1", () => console.log(`pid ${process.pid}: ${projectDir} at http://127.0.0.1:${port}/index.html`));
