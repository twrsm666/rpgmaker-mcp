import test from "node:test";
import assert from "node:assert/strict";
import { StepObserver } from "../src/step-observer.js";
const revision = "a".repeat(64);
const frame = id => ({ type: "edit", mapId: 1, revision, beforeRevision: "b".repeat(64), changeId: id,
  delta: { tiles: [], events: [] }, presentation: {} });
test("ordinary edits publish even when no demonstration is open", () => {
  const observer = new StepObserver(), delivered = [];
  observer.attach(1, f => delivered.push(f));
  observer.publish(frame("normal"));
  assert.equal(delivered.length, 1); assert.equal(delivered[0].sequence, 1);
  observer.close();
});
test("ACK may arrive before waiter and matches the exact revision", async () => {
  const observer = new StepObserver(), clientId = observer.attach(1, () => {});
  observer.ack({ clientId, mapId: 1, revision, changeId: "c1", status: "rendered" });
  assert.equal((await observer.wait("c1", 1, revision)).status, "rendered");
  const waiting = observer.wait("c2", 1, revision);
  observer.ack({ clientId, mapId: 1, revision, changeId: "c2", status: "rendered" });
  assert.equal((await waiting).changeId, "c2");
  observer.close();
});
test("no browser and paused browser are distinguished; neither affects disk", async () => {
  const observer = new StepObserver();
  assert.equal((await observer.wait("c1", 1, revision)).status, "no_observer");
  observer.attach(1, () => {});
  assert.equal((await observer.wait("c2", 1, revision, 15)).status, "pending_or_paused");
  observer.close();
});
test("demo recording, client identity and graceful shutdown", async () => {
  const observer = new StepObserver();
  const id = observer.attach(1, () => {});
  observer.begin("editor", { mapId: 1, revision, map: {} }, 250);
  observer.publish({ ...frame("c1"), presentation: { editorId: "editor" } });
  assert.equal(observer.demo.steps.length, 1);
  observer.end("editor"); assert.equal(observer.demo.closed, true);
  assert.throws(() => observer.ack({ clientId: "unknown", status: "view", mapId: 1 }), /Unknown/);
  const waiting = observer.wait("not-acked", 1, revision);
  observer.close(); assert.equal((await waiting).status, "closed");
  assert.ok(id);
});
