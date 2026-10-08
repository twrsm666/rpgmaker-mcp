// Run after connecting an official MCP SDK Client named `client`.
// This snippet deliberately contains no local token or path.
import { visualEditor } from "../bin/visual-editor.js";

export async function placeSmallPath(client, mapId) {
  const editor = await visualEditor(client, mapId, { holdMs: 300, awaitVisible: true });
  try {
    for (let x = 4; x <= 8; x++) {
      await editor.putground(x, 6, 0, 2912, `Place path tile (${x}, 6)`, "A2");
    }
    await editor.put_event({
      x: 8, y: 7, name: "Guide", text: "Each tile appeared as its own step.",
      image: { characterName: "People1", characterIndex: 0 }
    });
  } finally {
    await editor.close();
  }
}
