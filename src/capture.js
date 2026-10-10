import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

export class Capture {
  constructor(preview, executable) {
    this.preview = preview;
    this.executable = executable;
    this.browser = null;
    this.queue = Promise.resolve();
  }
  async open() {
    if (this.browser?.isConnected()) return this.browser;
    const paths = [
      this.executable,
      process.env.RPG_MCP_BROWSER,
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    ].filter(Boolean);
    for (const candidate of paths) {
      try {
        await fs.access(candidate);
        this.browser = await chromium.launch({ executablePath: candidate, headless: true });
        return this.browser;
      } catch (e) { if (e.code !== "ENOENT") throw e; }
    }
    throw new Error("No installed Chromium/Edge/Chrome found. Supply --browser executable. No browser is downloaded automatically.");
  }
  render(options) {
    const next = this.queue.then(() => this._render(options));
    this.queue = next.catch(() => {});
    return next;
  }
  async _render(options) {
    const browser = await this.open();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
    try {
      const query = new URLSearchParams({ token: this.preview.token, spec: JSON.stringify(options) });
      // Maps are no longer capped at 256x256, so a whole-map render of a large
      // project legitimately takes minutes; a 20 s budget would just rename the
      // old size limit as a timeout.
      await page.goto(`${this.preview.url}/render.html?${query}`, { waitUntil: "load", timeout: 300000 });
      await page.waitForFunction(() => window.renderDone || window.renderError, { timeout: 300000 });
      const result = await page.evaluate(() => ({ error: window.renderError, meta: window.renderMeta }));
      if (result.error) throw new Error(result.error);
      const buffer = await page.locator("#render").screenshot({ type: "png", timeout: 300000 });
      return { buffer, ...result.meta };
    } finally { await page.close(); }
  }
  async close() { await this.browser?.close(); }
}
