import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeBridge } from "../src/runtime.js";

test("runtime queue/reply isolation and online status", async () => {
  const bridge = new RuntimeBridge({});
  const session = "a".repeat(32), other = "b".repeat(32);
  assert.throws(() => bridge.request(session, "capture"), /offline/);
  bridge.poll({ session, state: { mapId: 1, player: { x: 2, y: 3 } } });
  assert.equal(bridge.status()[0].online, true);
  const promise = bridge.request(session, "move", { direction: 6 });
  const { commands } = bridge.poll({ session, state: { mapId: 1 } });
  assert.equal(commands.length, 1);
  assert.throws(() => bridge.reply({ session: other, id: commands[0].id, result: {} }), /Unknown runtime/);
  bridge.reply({ session, id: commands[0].id, result: { state: { x: 3 } } });
  assert.deepEqual(await promise, { state: { x: 3 } });
  assert.equal(bridge.poll({ session }).commands.length, 0);
  bridge.close();
});
test("runtime errors are delivered, outstanding commands reject on close", async () => {
  const bridge = new RuntimeBridge({}), session = "c".repeat(32);
  bridge.poll({ session, state: {} });
  const promise = bridge.request(session, "reload_map");
  const pending = bridge.poll({ session }).commands[0];
  bridge.reply({ session, id: pending.id, error: "Finish event/message before reloading map" });
  await assert.rejects(promise, /Finish event/);
  const closing = bridge.request(session, "capture");
  bridge.close();
  await assert.rejects(closing, /Bridge closed/);
});
