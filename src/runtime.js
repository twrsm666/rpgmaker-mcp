import crypto from "node:crypto";
import fs from "node:fs/promises";

export class RuntimeBridge {
  constructor(project) {
    this.project = project;
    this.sessions = new Map();
    this.pending = new Map();
  }
  poll(payload) {
    if (typeof payload.session !== "string" || !/^[a-f0-9]{32}$/.test(payload.session)) throw new Error("Invalid runtime session");
    if (payload.state && JSON.stringify(payload.state).length > 65536) throw new Error("Runtime state too large");
    const session = this.sessions.get(payload.session) || { queue: [] };
    session.state = payload.state; session.lastSeen = Date.now();
    this.sessions.set(payload.session, session);
    if (this.sessions.size > 8) {
      for (const [id, value] of this.sessions) if (Date.now() - value.lastSeen > 30000) this.sessions.delete(id);
    }
    const commands = session.queue.splice(0);
    return { commands };
  }
  reply(payload) {
    const pending = this.pending.get(payload.id);
    if (!pending || pending.sessionId !== payload.session) throw new Error("Unknown runtime request");
    this.pending.delete(payload.id); clearTimeout(pending.timer);
    if (payload.error) pending.reject(new Error(payload.error));
    else pending.resolve(payload.result);
    return { ok: true };
  }
  status() {
    return [...this.sessions].map(([sessionId, session]) => ({ sessionId, online: Date.now() - session.lastSeen < 5000,
      lastSeen: new Date(session.lastSeen).toISOString(), state: session.state }));
  }
  request(sessionId, command, parameters = {}) {
    const session = this.sessions.get(sessionId);
    if (!session || Date.now() - session.lastSeen > 5000) throw new Error("Runtime offline. Enable MZVisualBridge and start local test play.");
    if (session.queue.length >= 8) throw new Error("Runtime queue full");
    const id = crypto.randomBytes(12).toString("hex");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        session.queue = session.queue.filter(c => c.id !== id);
        reject(new Error("Runtime command timed out; observe state before retrying."));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer, sessionId });
      session.queue.push({ id, command, parameters });
    });
  }
  async activate(preview) {
    await this.project.journalDirectory();
    const connection = await this.project.file(".rpg-mcp/connection.json", true);
    await fs.writeFile(connection, JSON.stringify({ url: preview.url, token: preview.token }) + "\n");
  }
  close() {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Bridge closed")); }
    this.pending.clear();
  }
}
