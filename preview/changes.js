// Immutable map deltas are shared by the Node writer and browser observer.
// The browser never fetches "latest" in the middle of a sequence of steps.
export function diffMap(before, after) {
  const delta = { tiles: [], events: [], properties: {}, eventLength: after.events.length };
  if (before.width !== after.width || before.height !== after.height) {
    delta.reset = structuredClone(after);
    return delta;
  }
  for (let i = 0; i < after.data.length; i++) {
    if (before.data[i] !== after.data[i]) delta.tiles.push({ index: i, value: after.data[i] });
  }
  for (let id = 0; id < Math.max(before.events.length, after.events.length); id++) {
    if (JSON.stringify(before.events[id] ?? null) !== JSON.stringify(after.events[id] ?? null))
      delta.events.push({ id, value: structuredClone(after.events[id] ?? null) });
  }
  for (const key of Object.keys(after)) {
    if (key !== "data" && key !== "events" && JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      delta.properties[key] = structuredClone(after[key]);
  }
  return delta;
}
export function applyChange(bundle, change) {
  if (bundle.mapId !== change.mapId || bundle.revision !== change.beforeRevision)
    throw new Error("Preview revision mismatch; cannot apply this step to a different map state.");
  const result = structuredClone(bundle);
  if (change.delta.reset) result.map = structuredClone(change.delta.reset);
  else {
    for (const cell of change.delta.tiles) result.map.data[cell.index] = cell.value;
    for (const event of change.delta.events) result.map.events[event.id] = structuredClone(event.value);
    result.map.events.length = change.delta.eventLength;
    Object.assign(result.map, structuredClone(change.delta.properties));
  }
  result.revision = change.revision;
  return result;
}
export function summarizeChange(change) {
  if (change.presentation?.caption) return change.presentation.caption;
  return `${change.label} · ${change.delta.tiles.length} 格 · ${change.delta.events.length} 个事件`;
}
