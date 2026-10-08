# MCP tools

All paths refer to one project configured when the server starts. No tool
accepts arbitrary filesystem paths or shell commands.

## Project / map catalog

| Tool | Main inputs | Notes |
| --- | --- | --- |
| `project_info` | none | Project metadata, `catalogRevision`, private preview URL |
| `list_maps` | none | ID/name/parent/order |
| `create_map` | ID, name, dimensions, tileset, `expectedCatalogRevision` | Refuses existing file/ID; backs up catalog |
| `configure_map` | mapId, properties, `expectedRevision` | Shrink refuses lost cells/events |
| `read_map` | mapId, optional data/region | Revision and event pages |

## Design observation

| Tool | Main inputs |
| --- | --- |
| `render_map` | mapId, optional region, scale, grid, events, regions, state |
| `tileset_catalog` | mapId; active Tileset mode and actual image file in each A1-A5/B-E slot |
| `tile_palette` | mapId, sheet A1–A5 / B–E, optional start/count |

### tile_info

```
tile_info { tileId }
```

放置组合体相关的贴图前，先探测这个 tile id：返回所属图集、autotile 类别与角色；A4/A3 会给出配对的墙顶↔墙身基块 tileId（影子画在墙身、单独的墙顶没有影子），阴影层(z=4)由 `paint_tiles` 的 autoShadow 自动维护（墙身右侧地面写左半位掩码 5，旧影子同步回收）；B-E/A5 普通贴图会提醒它可能是 2x2/3x3 组合体（帐篷、大树等）的一角，铺放前先用 tile_palette 看邻块。

> autoShadow（默认开）：按引擎 Tilemap._addShadow 的象限位表双向调和阴影层——画出的 A4/A3 墙身(kind%16>=8)在右侧非墙地面写位 5（左半），墙身自格写 0，被抹掉的墙身留下的旧阴影同时回收。编辑器手工画墙就是这个结果：往墙身自格补位 10 会让两格以上的厚墙出现明暗相间的竖条（MCP 预览和真实引擎里都能看到）。只有 0/5/10 会被自动改写，其他手工阴影值原样保留。返回结果的 `shadowCells` 给出本次改写的阴影格数；关闭则完全不动第 4 层。
| `inspect_cell` | mapId, x, y |
| `preview_focus` | mapId, optional x/y |

Event-page selection in design rendering uses supplied switches, variables,
self-switches, actors and items. Event commands are not executed there.

## Transactional edits

Map data layers 0..3 are draw-order planes, not semantic ground/interior/dungeon
categories. Inspect `tileset_catalog` and `tile_palette` to choose the current
map's actual sheet. `putground` and every non-empty visual cell/rectangle in `paint_tiles`
must include `expectedSheet`; `place_building` requires `expectedRoofSheet` and
`expectedWallSheet`. These assertions are checked against the numeric tile ID.
`tileId`/`num` `0` clears a visual cell and must not carry an `expectedSheet`, because 0
belongs to no sheet. Shadow and region layers use numeric values and must not include a sheet.
`stamp_region` refuses maps with different Tileset IDs because raw tile IDs do
not preserve their appearance across different Tilesets.

`paint_tiles`, `place_building`, `stamp_region`, `upsert_event`, `delete_event`
require the latest `expectedRevision`. Region stamps also require a source
revision. Edits normally return a PNG; a post-commit rendering failure is
reported separately from a successful disk write.

`upsert_event` replaces a whole event when its ID exists. Raw pages use MZ's
native JSON shape; only basic structure is validated, not every command's
parameter semantics.

## Event logic commands

`event_show_text`, `event_show_choices`, `event_input_number`, `event_battle`,
`event_give_gold`, `event_give_items`, `event_switches`, `event_self_switch`,
`event_variables`, `event_if`, `event_move_route`, `event_play_se`,
`event_transfer_player`, `event_wait`, `event_change_party`,
`event_change_actor_hp`, `event_change_actor_mp`, `event_change_actor_level`,
`event_change_actor_state`, `event_recover_all`, `event_change_actor_skill`,
`event_change_actor_images`, `event_change_enemy_hp`, `event_enemy_appear`,
`event_enemy_transform`, `event_screen_fade`, `event_tint_screen`,
`event_flash_screen`, `event_shake_screen`, `event_set_weather`,
`event_show_animation`, `event_set_event_location`, `event_show_picture`,
`event_move_picture`, `event_erase_picture`, `event_comment`,
`event_exit_event`, `event_erase_event`, `event_call_common_event`, `event_label`,
`event_jump_to_label`, `event_name_input`, `event_shop`, `event_control_timer`,
`event_change_access`, `event_raw_commands`.

All of them share the same shape: target an existing event page
(`mapId`, `expectedRevision`, `eventId`, optional `pageIndex`), append
correctly encoded MZ commands, commit through the same transactional path as
`upsert_event` (backup, revision check, exact delta, screenshot). `insertAt`
places commands at a specific list index; the default position is the page end,
and the trailing code 0 terminator is always kept last.

| Tool | MZ codes | Notes |
| --- | --- | --- |
| `event_show_text` | 101/401 | Speaker name, face, background, position; lines batch four per 101 block |
| `event_show_choices` | 102/402/403 | MZ stores [choices, cancelType, defaultType, position, background]; cancelType −2 disallow / −1 branch / choice index; 403 exists only for the branch case |
| `event_input_number` | 103 | Variable + 1..8 digits |
| `event_battle` | 301 (+601/602/603/604) | type direct/variable/random; `onWin`/`onEscape`/`onLose` raw commands become indented result branches |
| `event_give_gold` | 125 | Amount or variable operand |
| `event_give_items` | 126/127/128 | item/weapon/armor; give or remove |
| `event_switches` | 121 | One switch or an inclusive ID range; `on` boolean |
| `event_self_switch` | 123 | A/B/C/D; always targets the event executing the command |
| `event_variables` | 122 | set/add/sub/mul/div/mod; constant, variable, random or script operand |
| `event_if` | 111/411/412 | 14 condition types; `thenCommands`/`elseCommands` are indented automatically |
| `event_move_route` | 205 | targetId follows the engine's character() encoding: **−1 player / 0 this event** / event ID; named steps mapped to Game_Character.ROUTE_* codes. repeat defaults false — repeat:true + wait:true on failing steps deadlocks the route wait |
| `event_play_se` | 250/249/241/245 | kind se/me/bgm/bgs; MZ renumbered audio against MV (SE is 250, ME is 249) |
| `event_transfer_player` | 201 | Direct designation; direction 0 retains facing; fade 0 black / 1 white / 2 none |
| `event_wait` | 230 | Frames at 60 fps |
| `event_change_party` | 129 | Add/remove actor, optional re-initialization |
| `event_change_actor_hp` | 311 | [scope(0 actor/1 party), actorId, op, operandType, operand, allowKnockout] |
| `event_change_actor_mp` | 312 | Same layout minus the knockout flag |
| `event_change_actor_level` | 316 | With showLevelUp flag |
| `event_change_actor_state` | 313 | Add/remove a state |
| `event_recover_all` | 314 | One actor or the entire party |
| `event_change_actor_skill` | 318 | Learn/forget |
| `event_change_actor_images` | 322 | Character/face/battler swap |
| `event_change_enemy_hp` | 331 | Battle event pages; [troopMemberIndex, op, operandType, operand, allowKnockout] |
| `event_enemy_appear` | 335 | Reveal a hidden troop member |
| `event_enemy_transform` | 336 | Replace a troop member with another enemy |
| `event_screen_fade` | 221/222 | mode out (to black) / in |
| `event_tint_screen` | 223 | [r,g,b,gray] + frames |
| `event_flash_screen` | 224 | [r,g,b] + frames |
| `event_shake_screen` | 225 | power/speed/frames |
| `event_set_weather` | 236 | none/rain/storm/snow + power/frames |
| `event_show_animation` | 212 | targetId −1 player / 0 this event / event ID |
| `event_set_event_location` | 203 | Direct designation; direction 0 retains |
| `event_show_picture` | 231 | [number, name, origin, 0, x, y, scaleX, scaleY, opacity, blendMode] |
| `event_move_picture` | 232 | [number, 0, origin, 0, x, y, ..., duration, wait, easingType] |
| `event_erase_picture` | 235 | Picture number |
| `event_comment` | 108/408 | Non-executed documentation lines |
| `event_exit_event` | 115 | Abort the current event run; does **not** remove the event |
| `event_erase_event` | 214 | Erase the event for the rest of the game (MZ; MV used 115 for this) |
| `event_call_common_event` | 117 | Common event ID |
| `event_label` / `event_jump_to_label` | 118/119 | Named jump targets |
| `event_name_input` | 303 | Actor + 1..16 characters |
| `event_shop` | 302/605 | goods rows [kind, id, price]; purchase-only flag lives at 302 params[4] |
| `event_control_timer` | 124 | Start seconds / stop (MZ renumbered: MV used 134) |
| `event_change_access` | 134/135/136/137 | Save/menu/encounter/formation allow flags (MV used 141–143) |
| `event_raw_commands` | any 1..999 | Literal `{code, indent?, parameters}` entries; the fallback for anything else |

Codes and parameter orders were verified against the local MZ 1.8.x corescript.
Database IDs (switches, variables, items, weapons, armors, troops) are checked
against the project JSON files before writing. Compose complex sequences by
chaining several `event_*` calls; they append in call order. While an
`open_editor` session is open, external writes change the revision, so close
the session first or re-read the map afterward.

## Fine-grained edits

1. `open_editor(mapId, holdMs, awaitVisible)` → `editorId`.
2. `putground(editorId, x, y, high, num, expectedSheet)` for visual layers 0..3; omit `expectedSheet` on shadow/region layers 4/5.
3. `put_event(editorId, x, y, name, transfer/text/image/pages...)`. Unknown keys are rejected, not
   stripped; `pages` cannot be combined with `transfer`/`text`/`image` because pages replace the list.
4. `move_event(editorId, eventId, x, y)`.
5. `set_event_image(editorId, eventId, pageIndex, image)`.
6. `close_editor(editorId)`.

Coordinates are zero-based. Every commit has an exact delta and revision.
Editor sessions track revisions; an external change causes a conflict instead
of automatic overwriting.

Possible presentation status:

- `rendered`: observer ACK received after canvas rendering and requested hold.
- `queued`: caller opted not to await the observer.
- `no_observer`: no subscribed browser for that map.
- `pending_or_paused`: saved, but no ACK within the bounded wait.
- `unchanged`: no file update was needed.

A render ACK is not proof a person watched the screen.

## Recovery / static checks

`edit_history`, `undo_map_edit`, `analyze_map`.

Undo creates another backed-up revision. Analysis approximates stock directional
passage and simple blockers; custom passage plugins need playtesting.

## Runtime

Browser: `playtest_start`, `playtest_stop`.

Windows NW.js: `native_playtest_start`, `native_playtest_stop`; install/enable
`plugin/MZVisualBridge.js` first.

Inspection: `runtime_status`, `runtime_capture`.

`runtime_control` actions:

- `start_new_game`: only from title.
- `reload_map`: only when no event/message is running.
- `move`: direction 2/4/6/8, bounded step count.
- `teleport`: existing map and in-bounds coordinate.
- `interact`: normal confirmation interaction.
- `input`: ok/cancel/up/down/left/right/pageup/pagedown.
- `set_switch`, `set_variable`: existing database ID and matching value type.

Runtime commands affect game memory, not disk map files or saved games.
There is no arbitrary-eval MCP tool and no automatic-walkthrough script API.
