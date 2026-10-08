import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { StepObserver } from "./step-observer.js";

const previewRoot = fileURLToPath(new URL("../preview/", import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg",
  ".json": "application/json", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".woff": "font/woff",
  ".ttf": "font/ttf", ".wasm": "application/wasm", ".efkefc": "application/octet-stream" };

export async function startPreview(project, port = 0, runtime = null) {
  const token = crypto.randomBytes(32).toString("hex");
  const observer = new StepObserver();
  const clients = new Set();
  let focus = { mapId: (await project.maps())[0]?.id || 1 };
  const push = change => observer.publish(change);
  project.listeners.add(push);
  const server = http.createServer(async (request, response) => {
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      // Prevent DNS rebinding and cross-origin authenticated reads.
      if (request.headers.host !== new URL(base).host) throw new Error("Invalid Host");
      if (request.headers.origin && request.headers.origin !== base) throw new Error("Cross-origin request denied");
      const url = new URL(request.url, base);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'");
      const isProtected = url.pathname.startsWith("/api/") || url.pathname.startsWith("/asset/") || url.pathname.startsWith("/game/");
      const cookieToken = /(?:^|;\s*)mz_game=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie || "")?.[1];
      const supplied = request.headers.authorization?.replace(/^Bearer /, "") || url.searchParams.get("token") ||
        (url.pathname.startsWith("/game/") ? cookieToken : "") || "";
      const authorized = supplied.length === token.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
      if (isProtected && !authorized) { response.writeHead(401); response.end("Authentication required"); return; }
      const send = data => { response.setHeader("Content-Type", "application/json; charset=utf-8"); response.end(JSON.stringify(data)); };
      if (request.method === "POST" && url.pathname === "/api/ack") {
        const chunks = []; let size = 0;
        for await (const chunk of request) {
          size += chunk.length; if (size > 8192) throw new Error("Acknowledgement too large");
          chunks.push(chunk);
        }
        return send(observer.ack(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
      }
      if (request.method === "POST" && runtime && ["/api/runtime/poll", "/api/runtime/reply"].includes(url.pathname)) {
        const chunks = []; let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) throw new Error("Runtime payload too large");
          chunks.push(chunk);
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        return send(url.pathname.endsWith("/poll") ? runtime.poll(payload) : runtime.reply(payload));
      }
      if (request.method !== "GET") { response.writeHead(405); response.end(); return; }
      if (url.pathname.startsWith("/game/")) {
        if (!runtime) throw new Error("Browser test play requires --live-bridge");
        if (url.pathname === "/game/launch") {
          response.setHeader("Set-Cookie", `mz_game=${token}; HttpOnly; SameSite=Strict; Path=/game/`);
          response.writeHead(302, { Location: "/game/index.html?test" }); response.end(); return;
        }
        // Stock MZ/Pixi needs inline styles and Wasm compilation in its own
        // game page. Map observer retains its stricter CSP.
        response.setHeader("Content-Security-Policy", "default-src 'self' blob: data:; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'");
        const relative = decodeURIComponent(url.pathname.slice("/game/".length));
        if (relative === "mcp-boot.js") {
          response.setHeader("Content-Type", types[".js"]);
          response.end(`window.__MZ_MCP_BOOT = ${JSON.stringify({ url: base, token })};\n`);
          return;
        }
        if (relative === "js/plugins/MZVisualBridge.js") {
          response.setHeader("Content-Type", types[".js"]);
          response.end(await fs.readFile(fileURLToPath(new URL("../plugin/MZVisualBridge.js", import.meta.url))));
          return;
        }
        if (!/^(index\.html|js\/[^\\:\0]+\.js|data\/[A-Za-z0-9_]+\.json|css\/[^\\:\0]+\.css|img\/[^\\:\0]+\.(png|webp|jpg)|audio\/[^\\:\0]+\.(ogg|m4a)|effects\/[^\\:\0]+\.(efkefc|efkmodel|png)|fonts\/[^\\:\0]+\.(woff|ttf)|js\/libs\/effekseer\.wasm|icon\/[^\\:\0]+\.png)$/.test(relative) ||
            relative.split("/").some(segment => segment === ".." || segment === ".")) throw new Error("Game asset path not allowed");
        const file = await project.file(relative);
        let bytes = await fs.readFile(file);
        if (relative === "index.html") bytes = Buffer.from(bytes.toString().replace(/<script[^>]*src=["']js\/main\.js["'][^>]*>/i,
          '<script src="mcp-boot.js"></script><script src="js/main.js">'));
        if (relative === "js/plugins.js") bytes = Buffer.from(bytes.toString() +
          '\n$plugins = $plugins.filter(p => p.name !== "MZVisualBridge"); $plugins.push({name:"MZVisualBridge",status:true,description:"MCP browser test bridge",parameters:{}});\n');
        response.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
        response.end(bytes);
        return;
      }
      if (url.pathname === "/api/info") return send(await project.info());
      if (url.pathname === "/api/maps") return send(await project.maps());
      if (url.pathname === "/api/focus") return send(focus);
      if (url.pathname === "/api/demo") return send(observer.demo);
      if (url.pathname === "/api/runtime/status" && runtime) return send({ sessions: runtime.status() });
      if (url.pathname === "/api/map") return send(await project.bundle(Number(url.searchParams.get("id"))));
      if (url.pathname === "/api/inspect") return send(await project.inspect(Number(url.searchParams.get("id")), Number(url.searchParams.get("x")), Number(url.searchParams.get("y"))));
      if (url.pathname === "/api/events") {
        response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
        const clientId = observer.attach(Number(url.searchParams.get("mapId")) || focus.mapId,
          frame => response.write(`id: ${frame.sequence}\ndata: ${JSON.stringify(frame)}\n\n`));
        response.write(`data: ${JSON.stringify({ type: "connected", clientId, sequence: observer.sequence })}\n\n`);
        clients.add(response);
        request.on("close", () => { clients.delete(response); observer.detach(clientId); });
        return;
      }
      if (url.pathname === "/engine.js") {
        response.setHeader("Content-Type", types[".js"]);
        // Only the locally installed stock Tilemap definition; not project plugins.
        response.end(`const PIXI = { Container: function() {} };\n${project.tilemapSource}\nexport { Tilemap };\n`);
        return;
      }
      if (url.pathname.startsWith("/asset/")) {
        const relative = decodeURIComponent(url.pathname.slice("/asset/".length));
        if (!/^img\/(tilesets|characters|parallaxes)\/[^/\\:\0]+\.(png|webp|jpg)$/i.test(relative)) throw new Error("Asset path not allowed");
        const file = await project.file(relative);
        response.setHeader("Content-Type", types[path.extname(file).toLowerCase()]);
        response.end(await fs.readFile(file));
        return;
      }
      const publicFiles = { "/": "index.html", "/index.html": "index.html", "/app.js": "app.js",
        "/renderer.js": "renderer.js", "/changes.js": "changes.js", "/style.css": "style.css", "/render.html": "render.html", "/render.js": "render.js" };
      if (!publicFiles[url.pathname]) { response.writeHead(404); response.end("Not found"); return; }
      const file = path.join(previewRoot, publicFiles[url.pathname]);
      response.setHeader("Content-Type", types[path.extname(file)]);
      response.end(await fs.readFile(file));
    } catch (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  // Watch only data; external edits trigger a reload as well. No write capability via HTTP.
  const watchTimers = new Map();
  const watcher = (await import("node:fs")).watch(await project.file("data"), (type, filename) => {
    const match = /^Map(\d+)\.json$/.exec(filename || "");
    if (match) {
      const id = Number(match[1]); clearTimeout(watchTimers.get(id));
      watchTimers.set(id, setTimeout(async () => {
        watchTimers.delete(id);
        try {
          const { revision } = await project.read(id);
          // Internal writes already have lossless deltas. Their file watcher
          // echo must not replace queued intermediate frames with final data.
          if (observer.latestRevision.get(id) !== revision) {
            observer.latestRevision.set(id, revision);
            push({ type: "external", mapId: id, revision });
          }
        } catch {}
      }, 180));
    }
    if (filename === "MapInfos.json") push({ type: "catalog" });
  });
  return {
    url, token, observer, previewUrl: `${url}/#token=${token}`,
    focus(value) { focus = value; push({ type: "focus", ...value }); },
    async close() {
      watcher.close(); for (const timer of watchTimers.values()) clearTimeout(timer);
      observer.close(); project.listeners.delete(push);
      for (const client of clients) client.end();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  };
}
