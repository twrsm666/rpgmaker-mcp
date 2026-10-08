import { Capture } from "./capture.js";

export class Playtest {
  constructor(preview, runtime, browserPath) {
    this.preview = preview; this.runtime = runtime;
    this.capture = new Capture(preview, browserPath);
    this.context = null; this.page = null;
  }
  async start() {
    if (this.page && !this.page.isClosed()) throw new Error("Browser playtest already running");
    const browser = await this.capture.open();
    this.context = await browser.newContext({
      viewport: { width: 1000, height: 800 },
      serviceWorkers: "block",
      extraHTTPHeaders: { Authorization: `Bearer ${this.preview.token}` }
    });
    // Testing unknown project plugins must not transmit files to external hosts.
    await this.context.route("**/*", route => {
      const requestUrl = route.request().url();
      if (requestUrl.startsWith(this.preview.url + "/") || requestUrl.startsWith("data:") || requestUrl.startsWith("blob:")) route.continue();
      else route.abort("blockedbyclient");
    });
    await this.context.routeWebSocket("**/*", socket => socket.close());
    this.page = await this.context.newPage();
    const errors = [];
    this.page.on("pageerror", e => errors.push(e.stack || e.message));
    this.page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await this.page.goto(`${this.preview.url}/game/index.html?test`, { waitUntil: "load", timeout: 20000 });
    const start = Date.now();
    while (Date.now() - start < 20000) {
      const session = this.runtime.status().find(item => item.online && item.state?.scene === "Scene_Title");
      if (session) return { ...session, transport: "browser", note: "Complete stock MZ game runtime in installed Chromium. NW.js-only plugins require native test play. External network blocked." };
      const visibleError = await this.page.locator("#errorPrinter").textContent().catch(() => null);
      if (visibleError || errors.length) throw new Error([visibleError, ...errors].filter(Boolean).join("\n"));
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error("Browser game did not register an active title session within 20 seconds");
  }
  async close() {
    await this.context?.close();
    await this.capture.close();
    this.context = null; this.page = null;
  }
}
