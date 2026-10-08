import test from "node:test";
import assert from "node:assert/strict";
import { diffMap, applyChange, summarizeChange } from "../preview/changes.js";

const map = () => ({ width: 3, height: 2, tilesetId: 2, data: Array(36).fill(0), events: [null], note: "" });
test("single cell produces a minimal immutable delta and replays exactly", () => {
  const before = map(), after = structuredClone(before); after.data[4] = 2912;
  const change = { mapId: 1, beforeRevision: "a", revision: "b", delta: diffMap(before, after) };
  assert.deepEqual(change.delta.tiles, [{ index: 4, value: 2912 }]);
  const bundle = { mapId: 1, revision: "a", map: before };
  assert.deepEqual(applyChange(bundle, change).map, after);
  assert.equal(bundle.map.data[4], 0);
});
test("queued changes preserve intermediate states rather than fetch final state", () => {
  const initial = map(), a = structuredClone(initial), b = structuredClone(initial);
  a.data[0] = 2816; b.data[0] = 2816; b.data[1] = 2912;
  let bundle = { mapId: 1, revision: "0", map: initial };
  bundle = applyChange(bundle, { mapId: 1, beforeRevision: "0", revision: "1", delta: diffMap(initial, a) });
  assert.equal(bundle.map.data[1], 0);
  bundle = applyChange(bundle, { mapId: 1, beforeRevision: "1", revision: "2", delta: diffMap(a, b) });
  assert.deepEqual(bundle.map, b);
});
test("event movement/image changes preserve full pages and resize uses snapshot", () => {
  const before = map();
  before.events[1] = { id: 1, x: 0, y: 0, pages: [{ list: [101, 401], image: "old" }] };
  const after = structuredClone(before);
  after.events[1].x = 2; after.events[1].pages[0].image = "new";
  const delta = diffMap(before, after);
  assert.equal(delta.events.length, 1); assert.deepEqual(delta.events[0].value.pages[0].list, [101, 401]);
  const result = applyChange({ mapId: 1, revision: "a", map: before }, { mapId: 1, beforeRevision: "a", revision: "b", delta });
  assert.deepEqual(result.map, after);
  after.width = 4; after.data = Array(48).fill(0);
  assert.deepEqual(diffMap(before, after).reset, after);
});
test("different map/stale revision is rejected and captions do not evaluate code", () => {
  const delta = diffMap(map(), map());
  assert.throws(() => applyChange({ mapId: 1, revision: "x" }, { mapId: 2, beforeRevision: "x", delta }), /revision mismatch/);
  assert.throws(() => applyChange({ mapId: 1, revision: "x" }, { mapId: 1, beforeRevision: "y", delta }), /revision mismatch/);
  assert.equal(summarizeChange({ presentation: { caption: "<script>not executable</script>" } }), "<script>not executable</script>");
});
