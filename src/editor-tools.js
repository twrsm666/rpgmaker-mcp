import crypto from "node:crypto";
import { z } from "zod";
import { point, makeEvent } from "./project.js";

export function registerEditorTools({ project, preview, register, textResult }) {
  const editors = new Map();
  const coordinate = z.number().int().min(0);
  const common = { editorId: z.string().uuid(), caption: z.string().max(512).optional(),
    holdMs: z.number().int().min(0).max(2000).optional() };
  const image = z.object({ characterName: z.string().max(128).optional(), characterIndex: z.number().int().min(0).max(7).optional(),
    direction: z.union([2, 4, 6, 8].map(d => z.literal(d))).optional(),
    pattern: z.number().int().min(0).max(2).optional(), tileId: z.number().int().min(0).max(1023).optional() }).strict();
  async function step(args, action, mutate) {
    const editor = editors.get(args.editorId);
    if (!editor) throw new Error("Unknown editorId. Call open_editor first.");
    const perform = async () => {
      const presentation = { editorId: args.editorId, action, caption: args.caption || action,
        focus: args.x === undefined ? undefined : { x: args.x, y: args.y },
        holdMs: args.holdMs ?? editor.holdMs };
      const result = await mutate(editor, presentation);
      editor.revision = result.revision; editor.steps++;
      if (!result.changed) return textResult({ ...result, presentation: { status: "unchanged", note: "Cell/event already had this value." } });
      const shown = editor.awaitVisible ? await preview.observer.wait(result.changeId, editor.mapId, result.revision) : { status: "queued" };
      return textResult({ ...result, editorId: args.editorId, step: editor.steps,
        presentation: { ...shown, note: shown.note || "Browser acknowledgement means this exact map revision was rendered, not that a human viewed it." } });
    };
    const result = editor.queue.then(perform);
    editor.queue = result.catch(() => {});
    return result;
  }
  register("open_editor", "Begin a fine-grained visual editing session on one map. Stores the current revision, focuses the observer and records replayable steps. Close native MZ editor before disk writes.", {
    mapId: z.number().int().min(1).max(999), holdMs: z.number().int().min(0).max(2000).default(250),
    awaitVisible: z.boolean().default(true)
  }, async ({ mapId, holdMs, awaitVisible }) => {
    if (project.readOnly) throw new Error("Server is read-only");
    const bundle = await project.bundle(mapId), editorId = crypto.randomUUID();
    if (editors.size >= 16) throw new Error("Close unused editor sessions first.");
    editors.set(editorId, { mapId, holdMs, awaitVisible, revision: bundle.revision, steps: 0, queue: Promise.resolve() });
    preview.focus({ mapId }); preview.observer.begin(editorId, bundle, holdMs);
    return textResult({ editorId, mapId, revision: bundle.revision, holdMs, previewUrl: preview.previewUrl,
      example: "putground(editorId, x, y, high, num, expectedSheet): high=0..3 visual draw order (not a semantic category), 4=shadow, 5=region; expectedSheet required for 0..3." });
  }, true);
  register("putground", "Place exactly one cell. x/y are zero-based; high=0..3 is MZ visual draw order, not a semantic ground/interior/dungeon layer; high=4 is shadow and high=5 is region. For high 0..3, provide expectedSheet from tileset_catalog/tile_palette; mismatched tile IDs are rejected, and num=0 clears the cell without any expectedSheet.", {
    ...common, x: coordinate, y: coordinate, high: z.number().int().min(0).max(5), num: z.number().int().min(0).max(8191),
    autoTile: z.boolean().default(true),
    expectedSheet: z.enum(["A1", "A2", "A3", "A4", "A5", "B", "C", "D", "E"]).optional()
  }, args => step(args, `putground(${args.x}, ${args.y}, ${args.high}, ${args.num})`,
    (editor, presentation) => project.paint(editor.mapId, editor.revision, {
      cells: [{ x: args.x, y: args.y, layer: args.high, tileId: args.num, expectedSheet: args.expectedSheet }],
      requireSheet: true, autoTile: args.autoTile,
      label: "putground", presentation
    })), true);
  register("put_event", "Create/update a full event as one visible editing step, including an optional transfer destination. Use move_event/set_event_image for partial updates without losing commands/pages. Unknown keys are rejected, not ignored.", {
    ...common, eventId: z.number().int().min(1).max(9999).optional(), x: coordinate, y: coordinate,
    name: z.string().max(256).optional(), note: z.string().max(65536).default(""), text: z.string().max(65536).optional(),
    image: image.optional(), trigger: z.number().int().min(0).max(4).default(0),
    transfer: z.object({ mapId: z.number().int().min(1).max(999), x: coordinate, y: coordinate,
      direction: z.union([z.literal(0), z.literal(2), z.literal(4), z.literal(6), z.literal(8)]).optional() }).strict().optional(),
    pages: z.array(z.record(z.string(), z.unknown())).min(1).max(20).optional()
  }, args => step(args, `put_event(${args.name || "事件"}, ${args.x}, ${args.y})`, async (editor, presentation) => {
    let eventId = args.eventId || 1;
    const result = await project.edit(editor.mapId, editor.revision, async map => {
      point(map, args.x, args.y);
      if (args.transfer) point((await project.read(args.transfer.mapId)).map, args.transfer.x, args.transfer.y);
      if (!args.eventId) while (map.events[eventId]) eventId++;
      map.events[eventId] = makeEvent({ ...args, id: eventId });
    }, "put_event", presentation);
    return { ...result, eventId };
  }), true);
  register("move_event", "Move one existing event and preserve all pages/logic. Browser shows old and new coordinates as a single step.", {
    ...common, eventId: z.number().int().min(1).max(9999), x: coordinate, y: coordinate
  }, args => step(args, `move_event(E${args.eventId}, ${args.x}, ${args.y})`, (editor, presentation) =>
    project.edit(editor.mapId, editor.revision, map => {
      point(map, args.x, args.y); const event = map.events[args.eventId];
      if (!event) throw new Error("Event does not exist");
      presentation.from = { x: event.x, y: event.y };
      event.x = args.x; event.y = args.y;
    }, "move_event", presentation)), true);
  register("set_event_image", "Change sprite/direction/pattern on one event page without replacing commands, conditions or other pages.", {
    ...common, eventId: z.number().int().min(1).max(9999),
    pageIndex: z.number().int().min(0).max(19).default(0), image
  }, args => step(args, `set_event_image(E${args.eventId}, page ${args.pageIndex})`, (editor, presentation) =>
    project.edit(editor.mapId, editor.revision, map => {
      const event = map.events[args.eventId], page = event?.pages[args.pageIndex];
      if (!page) throw new Error("Event/page does not exist");
      presentation.focus = { x: event.x, y: event.y };
      Object.assign(page.image, args.image);
    }, "set_event_image", presentation)), true);
  register("close_editor", "Close a fine-grained session, retaining its observer replay. Subsequent writes need a new session.", {
    editorId: z.string().uuid()
  }, async ({ editorId }) => {
    const editor = editors.get(editorId);
    if (!editor) throw new Error("Unknown editorId");
    await editor.queue; editors.delete(editorId); preview.observer.end(editorId);
    return textResult({ mapId: editor.mapId, revision: editor.revision, steps: editor.steps, closed: true });
  }, true);
}
