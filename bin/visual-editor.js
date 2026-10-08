// Exact four-argument shorthand. Actual MCP calls; never direct map-file writes.
export async function visualEditor(client, mapId, options = {}) {
  const read = result => {
    if (result.isError) throw new Error(result.content[0].text);
    return JSON.parse(result.content.find(c => c.type === "text").text);
  };
  const { editorId } = read(await client.callTool({ name: "open_editor", arguments: { mapId, ...options } }));
  const call = (name, args) => client.callTool({ name, arguments: { editorId, ...args } }).then(read);
  return {
    editorId,
    putground(x, y, high, num, caption, expectedSheet) {
      return call("putground", { x, y, high, num, ...(caption ? { caption } : {}), ...(expectedSheet ? { expectedSheet } : {}) });
    },
    put_event(event) { return call("put_event", event); },
    move_event(eventId, x, y) { return call("move_event", { eventId, x, y }); },
    set_event_image(eventId, image, pageIndex = 0) { return call("set_event_image", { eventId, image, pageIndex }); },
    close() { return client.callTool({ name: "close_editor", arguments: { editorId } }).then(read); }
  };
}
