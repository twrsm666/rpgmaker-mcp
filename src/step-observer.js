import crypto from "node:crypto";

// ACKs only describe browser presentation. They cannot write map files or
// dispatch runtime commands. A disk commit is never rolled back on ACK failure.
export class StepObserver {
  constructor() {
    this.sequence = 0;
    this.clients = new Map();
    this.acknowledged = new Map();
    this.waiters = new Map();
    this.demo = null;
    this.latestRevision = new Map();
    this.closed = false;
  }
  attach(mapId, send) {
    const id = crypto.randomUUID();
    this.clients.set(id, { mapId, send, lastAck: 0 });
    return id;
  }
  detach(id) { this.clients.delete(id); }
  publish(change) {
    const frame = { ...change, sequence: ++this.sequence };
    if (frame.type === "edit") {
      this.latestRevision.set(frame.mapId, frame.revision);
      if (this.demo && this.demo.editorId === frame.presentation?.editorId && this.demo.steps.length < 3000) {
        this.demo.steps.push(structuredClone(frame));
      } else if (this.demo && this.demo.editorId === frame.presentation?.editorId) this.demo.truncated = true;
    }
    for (const client of this.clients.values()) {
      try { client.send(frame); } catch {}
    }
    return frame;
  }
  begin(editorId, bundle, holdMs) {
    this.demo = { editorId, mapId: bundle.mapId, initial: structuredClone(bundle), steps: [], holdMs, closed: false };
    this.publish({ type: "demo_begin", editorId, bundle, holdMs });
  }
  end(editorId) {
    if (this.demo?.editorId === editorId) this.demo.closed = true;
    this.publish({ type: "demo_end", editorId });
  }
  ack({ clientId, changeId, mapId, revision, status }) {
    const client = this.clients.get(clientId);
    if (!client) throw new Error("Unknown observer client");
    if (!Number.isInteger(mapId) || !["rendered", "view"].includes(status)) throw new Error("Invalid presentation acknowledgement");
    client.mapId = mapId;
    client.lastAck = Date.now();
    if (status !== "rendered") return { ok: true };
    if (!/^[a-f0-9]{64}$/.test(revision || "") || typeof changeId !== "string") throw new Error("Invalid frame acknowledgement");
    const record = { clientId, changeId, mapId, revision, status: "rendered", timestamp: Date.now() };
    this.acknowledged.set(changeId, record);
    if (this.acknowledged.size > 3000) this.acknowledged.delete(this.acknowledged.keys().next().value);
    for (const waiter of this.waiters.get(changeId) || []) {
      if (waiter.mapId === mapId && waiter.revision === revision) { clearTimeout(waiter.timer); waiter.resolve(record); }
    }
    this.waiters.delete(changeId);
    return { ok: true };
  }
  wait(changeId, mapId, revision, timeoutMs = 6000) {
    const ack = this.acknowledged.get(changeId);
    if (ack?.mapId === mapId && ack.revision === revision) return Promise.resolve(ack);
    if (![...this.clients.values()].some(c => c.mapId === mapId))
      return Promise.resolve({ status: "no_observer", changeId });
    return new Promise(resolve => {
      const waiter = { resolve, mapId, revision, timer: null };
      waiter.timer = setTimeout(() => {
        const list = this.waiters.get(changeId) || [];
        const remaining = list.filter(item => item !== waiter);
        if (remaining.length) this.waiters.set(changeId, remaining); else this.waiters.delete(changeId);
        resolve({ status: "pending_or_paused", changeId, note: "Saved to disk. Observer has not acknowledged this frame yet." });
      }, timeoutMs);
      this.waiters.set(changeId, [...(this.waiters.get(changeId) || []), waiter]);
    });
  }
  close() {
    this.closed = true;
    for (const list of this.waiters.values()) for (const waiter of list) {
      clearTimeout(waiter.timer); waiter.resolve({ status: "closed" });
    }
    this.waiters.clear(); this.clients.clear();
  }
}
