// Probe a tile id BEFORE building with it. RPG Maker tilesets are full of
// multi-piece compositions:
//   - A4 walls split into wall-top (kind % 16 < 8: upper surface, no shadow of
//     its own) and wall-side (kind % 16 >= 8: body whose art carries the cast
//     shadow; pairs with the top sharing its kind group, top k <-> side k+8).
//   - A3 buildings use the same top/side split.
//   - B-E / A5 normal tiles may be a single piece of a 2x2 / 3x3 composite
//     object (tents, large trees, wells).
//   - The editor's wall tool also stamps SHADOW BITS into the map's shadow
//     layer (data layer 4, 4-bit quadrant mask: 1=TL, 2=TR, 4=BL, 8=BR; right
//     half of a tile = 10) on the ground tile to the right of wall-side cells.
//     Raw tile painting must stamp those bits itself or the wall looks flat.
export function tileInfo(tileId) {
  if (!Number.isInteger(tileId) || tileId < 0 || tileId > 8191) {
    throw new Error("tileId must be integer 0..8191");
  }
  const info = { tileId };
  if (tileId < 1024) {
    const sheet = ["B", "C", "D", "E"][Math.floor(tileId / 256)];
    return Object.assign(info, {
      kind: "normal", sheet, sheetIndex: tileId % 256, autotile: false,
      compositionWarning:
        "单块独立贴图。许多道具是 2x2/3x3 组合体（帐篷、大树、水井），本块可能只是其一角。" +
        "放置前用 tile_palette 查看它在图集中的上下左右邻居，确认组合关系后再整组铺放。"
    });
  }
  if (tileId < 2048) {
    const s = tileId - 1536;
    return Object.assign(info, {
      kind: "normal", sheet: "A5", sheetX: s % 8, sheetY: Math.floor(s / 8), autotile: false,
      compositionWarning:
        "A5 普通贴图：不参与 autotile 拼边，单独一块就是最终样子（无墙体延伸、无影子）。" +
        "墙体/建筑请改用 A4 的墙顶+墙身组合，并在影子层(z=4)补影子位。"
    });
  }
  const base = tileId >= 5888 ? 5888 : tileId >= 4352 ? 4352 : tileId >= 2816 ? 2816 : 2048;
  const sheet = { 5888: "A4", 4352: "A3", 2816: "A2", 2048: "A1" }[base];
  const autotileKind = Math.floor((tileId - base) / 48);
  const piece = (tileId - base) % 48;
  Object.assign(info, { kind: sheet, autotile: true, autotileKind, piece });
  if (sheet === "A4" || sheet === "A3") {
    const isTop = autotileKind % 16 < 8;
    const mateKind = isTop ? autotileKind + 8 : autotileKind - 8;
    const noun = sheet === "A4" ? "墙" : "建筑";
    info.role = isTop
      ? (sheet === "A4" ? "wall-top（墙顶/上表面，无自带影子）" : "roof-top（屋顶/上表面）")
      : (sheet === "A4" ? "wall-side（墙体，投影画在影子层）" : "building-side（建筑墙体）");
    info.pairedKind = mateKind;
    info.pairedBaseTileId = base + mateKind * 48;
    info.warning = isTop
      ? `本块只是上表面，没有墙体也没有影子。必须在正下方叠放配对的${noun}体（autotileKind ${mateKind}，基块 tileId ${info.pairedBaseTileId}，paint_tiles 配合 autoTile 拼边）；自动阴影只在${noun}体右侧的非墙地面写左半位掩码5（tileId 5），${noun}体自身的影子层(z=4)保持 0——编辑器手工画墙就是这个结果，往墙身自格写掩码会让厚墙变成明暗相间的竖条。`
      : `本块是${noun}体。顶端一行必须放配对的顶/盖（autotileKind ${mateKind}，基块 tileId ${info.pairedBaseTileId}）。编辑器/自动阴影只在墙身右侧的非墙地面写左半位掩码5（tileId 5），墙身自格的影子层(z=4)是 0；用 paint_tiles 时保留 autoShadow=true 即可，它会同时回收旧影子。`;
  } else if (sheet === "A2") {
    info.role = "ground autotile（地面）";
    info.warning = "与同 kind 相邻自动拼边，无需组合。";
  } else {
    info.role = "water/animation autotile（A1）";
    info.warning = "含水面动画帧，运行时按帧轮播。";
  }
  return info;
}
