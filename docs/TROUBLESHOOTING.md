# 常见 Bug 与排查指南 — RPG Maker MZ 自动化/无头化实战经验

本文档记录用 MCP 桥接、浏览器自动化和 AI agent 制作/试玩 RPG Maker MZ (1.8.1) 游戏时**真实踩过、且多个 AI 反复翻车**的坑。每条都给出症状、根因（以本地引擎源码为准）和修复方法。

---

## 1. 标题画面崩溃：`Cannot read properties of undefined (reading 'clamp')`

**翻车率最高的一个。** Claude、Qwen、GLM 都在这上面栽过，且每次都先怀疑插件冲突、PIXI 版本、tileset 数据，全猜错了。

### 症状
游戏资源加载完毕、进入 `Scene_Title` 一瞬间整页报错，黑屏或错误文字，控制台：

```
TypeError: Cannot read properties of undefined (reading 'clamp')
```

### 真实调用栈（MZ 1.8.1，rmmz_core.js / rmmz_windows.js）
1. `Scene_Boot` 结束 → `Scene_Title.create()` → `Window_TitleCommand` 构造
2. `Window_Base.initialize` → `updateBackOpacity()`
3. `Window_Base.windowOpacity()` → `$gameSystem.windowOpacity()`
4. `rmmz_core.js:417`：`return $dataSystem.advanced.windowOpacity;` → **undefined**
5. 该 undefined 被传入 `.clamp(min, max)` → 引擎给 `Number.prototype` 挂的 clamp 在 undefined 上调用 → 崩溃

### 根因
**MZ 1.8.1 官方 newdata 模板的 `data/System.json` 里，`advanced` 对象根本没有 `windowOpacity` 字段。** 实测模板 `advanced` 的完整内容只有：

```json
{ "gameId": 10000000, "screenWidth": 816, "screenHeight": 624,
  "uiAreaWidth": 816, "uiAreaHeight": 624,
  "numberFontFilename": "mplus-2p-bold-sub.woff",
  "fallbackFonts": "Verdana, sans-serif", "fontSize": 26,
  "mainFontFilename": "mplus-1m-regular.woff" }
```

用原生编辑器新建工程时，编辑器保存会补上该字段；但**用脚本/模板拷贝批量建工程**（自动化场景几乎必然这么做）就缺它。引擎读 `$dataSystem` 的地方几乎都不写默认值，缺字段直接炸。

### 修复
在 `data/System.json` 的 `advanced` 里加：

```json
"windowOpacity": 192
```

（192 是 MZ 编辑器默认值。）

### MCP 0.3.0 起的自动处理
`Project.open` 启动时校验该字段：缺失则**自动备份原文件到 `.rpg-mcp/` 并补上 192**，`project_info` 会返回 `systemRepair` 字段说明动了什么；`--read-only` 模式则直接报错并给出上面这句修复方法，而不是让游戏在运行时崩溃。

### 经验教训
- 引擎的“默认值”不一定存在于代码里——MZ 大量裸读 `$dataSystem`。凡是“从模板拼工程”，先核对模板 `System.json` 与引擎运行时读取路径。
- 见到 `undefined.clamp`：`grep "\.clamp(" 引擎js`，反推调用链和数据来源，**不要猜插件**。
- 排查手段：在 `index.html` 里注入 `window.addEventListener("error"/"unhandledrejection")` 钩子，并包装 `Graphics.printError`，把**完整堆栈**送出来；只有 message 没有堆栈时，人（和 AI）永远在猜。

---

## 2. 失焦冻结：`SceneManager.isGameActive()`

### 症状
游戏画面停住、桥接指令（移动/输入）全部不推进，但没有任何报错；切回游戏窗口（有焦点）后又一切正常。

### 根因
MZ 1.8 的 `SceneManager.isGameActive()` = `window.top.document.hasFocus()`，门闩在 `updateScene` 里：**失焦时 `updateMain` 照跑（`Graphics.frameCount` 实测 700ms 内 +42），只有 `this._scene.update()` 那一行不执行**，于是 `_fadeDuration`/`_transferring`/`isMoving` 全部冻住，而 `Input.update()` 仍在采样按键边沿——边沿算出来了却没人消费。别把 frameCount 当活性信号，要数 `Scene_Base.prototype.update` 的调用次数。（旧版本此处写作"`updateMain` 整个停摆、连 updateInputData 都不跑"，与实测不符。）无头浏览器、后台标签页、自动化注入场景常态失焦 → 看起来像"游戏卡死"。

### 修复
仅测试副本中打补丁（不要发到正式游戏）：

```js
SceneManager.isGameActive = () => true;
```

`plugin/MZVisualBridge.js` 现在自带这条（只在 `--test` 副本生效），并把 `settled()` 的超时消息改成
回报阻塞谓词与 `sceneTickDelta`；`interact`/`input` 返回 `consumed` 字段，边沿没人消费时不再谎报成功。
详见 `docs/tool-defects.md`。

另注意：后台标签页的 `requestAnimationFrame` 会被浏览器节流甚至暂停——注入的按键边沿此时没人采样。确定性驱动的可靠手法是手动泵帧：置按键 → `Input.update()` → `SceneManager.updateScene()` → 清按键。

---

## 3. 桥接输入注入失效（`Input._currentState` 直写的三重坑）

### 症状
往 `Input._currentState.ok = true` 后游戏毫无反应，或者十次里成功一两次（时序竞态）；战斗指令界面尤其明显。

### 三重坑（全部实测）
1. **监听挂载点**：MZ 1.8 把 keydown/keyup 挂在 **`document`** 上（`Input._setupEventHandlers`），往 `window` 派发 `KeyboardEvent` 无效。
2. **触发边沿**：`Input.isTriggered(name)` = `_latestButton === name && _pressedTime === 0`，而 `_latestButton` 只在 `Input.update()` 里由 `_currentState` 的**上升沿**刷新。直接写 state 只有一帧窗口，还要跟游戏循环的采样抢时序；手动多调一次 `Input.update()` 反而会把边沿吃掉（二次采样）。
3. **失焦清空**：`window` 的 blur 事件 → `Input.clear()`，把按住的 state 全清掉。按下与松开之间失焦 = 永不触发。

### 正确姿势
用引擎官方虚拟按键 API：**`Input.virtualClick(buttonName)`**。它置 `_virtualButton`，下一次 `Input.update()` 消费并产生恰好一帧干净 trigger，且**不怕 `Input.clear()`**。再配合向 `document` 派发真实 keydown/keyup 兜底（keyMapper: ok=13/32/90、cancel=27/45/88、up=38、down=40、left=37、right=39、pageup=33/81、pagedown=34/87）。MZVisualBridge 0.3.0 已改为该方案。

---

## 4. 音效指令码 MZ 与 MV 错位

MV：Play SE = **249**。MZ：**Play ME = 249、Play SE = 250**（MZ 重新编号）。照 MV 资料写 249，结果音效变成了 ME（或行为对不上）。BGM=241、BGS=245 两代一致。

---

## 5. 开关参数反转：0 = ON，1 = OFF

开关（121）、独立开关（123）的 value 参数：**0 = ON，1 = OFF**，与编辑器 UI 直觉相反。写反的症状是“事件永远不翻页 / 事件循环触发”。条件分支（111）的 switch 条件同样是 0=ON。

---

## 6. 显示选项（102）：MZ 是 5 个参数

MV 资料（包括很多流传的指令码表）：`[choices, cancelType, background, position]`。
**MZ 1.8：`[choices, cancelType, defaultType, position, background]`** —— `defaultType`（默认高亮项）插在中间，照抄旧表会把窗口样式设置错位。

补充（源码核对）：
- 402 = `[index, text]`，逐项跟随在 102 后；
- 403（When Cancel）**没有参数**，只在 `cancelType = -1`（分支）时存在；取消时 `onChoice(choiceCancelType())`；
- `cancelType = params[1] < choices.length ? params[1] : -2`，超出范围自动变“禁止”；
- 选项最多 6 项（编辑器上限）。

---

## 7. 商店处理（302）：purchaseOnly 在 `params[4]`

`command302` 把 302 自身的参数当作第一行商品，并执行 `SceneManager.prepareNextScene(goods, params[4])`。所以：

- 302 参数 = `[kind, itemId, price, 0, purchaseOnly]`（purchaseOnly 在**第 5 个**位置）；
- 后续商品行用 605 = `[kind, itemId, price, 0]`；
- `kind`：0 物品 / 1 武器 / 2 防具；`price` 0 = 数据库价。

---

## 8. 存档/菜单/遇敌/编成权限：MZ 重编号了

| 功能 | MV | **MZ 1.8** |
|---|---|---|
| 计时器 | 134 | **124** |
| 存档权限 | 141 | **134** |
| 菜单权限 | 142 | **135** |
| 遇敌权限 | 143 | **136** |
| 编成权限 | — | **137** |

照 MV 码位写会拿到完全不同的指令。参数 `[0 禁止 / 1 允许]`。

---

## 9. 前视战斗没有敌人血条（不是 bug，但最容易被误判）

**MZ 前视（front-view）战斗默认完全不显示敌方 HP**，UI 上只看得到敌人名字。这非常容易被误判成“敌人血量无限/伤害无效”。

- 想要血条：装 `examples/EnemyHpBars.js`（纯视觉插件，不改战斗逻辑，前视/侧视都有效）。
- 想验证伤害：别看 UI，直接读引擎内存：

```js
$gameTroop.members().map(e => ({ name: e.name(), hp: e.hp, mhp: e.mhp, alive: e.isAlive() }))
```

- 自动化打一场战斗的按键数：MZ 默认 4 人队伍，每人 2 次确认（选指令 + 选目标）= **8 次 ok 才结算一回合**，之后还有战报消息要确认。数错次数会以为“输入无效”。

---

## 10. MZ 1.8 API 改名导致调试插件崩溃

例：`BattleManager.inputtingActor` 在 1.8 已改名/移除——针对旧版或 MV 写的调试/自动化插件会直接 `TypeError: xxx is not a function`。任何插件报这个错，先去 1.8 源码里 grep 方法名确认存在，再怀疑别的。

---

## 11. 一张 404 贴图冻住整个游戏（isReady 死锁）

### 症状
游戏显示正常、不报错（或仅控制台一条 LoadError），但一切交互无效：传送不动、按键无反应、场景停摆——和第 2、3 条的症状几乎一样，极易误判成焦点/输入问题。

### 根因
事件引用了不存在的图片文件（例如把 `!SF_Switch1` 记成 `!$SF_Switch1`——MZ 素材里 `$` 是三方向动画标记，差一个字符就是两个文件）。加载失败的位图进入错误态后，**`ImageManager.isReady()` 每帧抛 LoadError**，而场景启动门控是：

```js
// rmmz_scenes.js
Scene_Base.prototype.isReady = function() {
    return ImageManager.isReady() && EffectManager.isReady() && FontManager.isReady();
};
// SceneManager.updateScene: isReady() 为真才调用 scene.start()
```

→ `scene.start()` 永远不执行 → `_active` 恒为 false → `Game_Player.update(sceneActive=false)` 连 `performTransfer` 都不跑。**一张 404 图片 = 全游戏逻辑死亡**，而且错误位图缓存在内存里，改完数据必须刷新页面才恢复。

### 修复
1. 事件图片名必须与 `img/characters/` 里的文件名逐字符一致（注意 `!`“单方向”、`$`“动画”前缀的组合）。
2. 排查手段：页面内执行 `ImageManager.isReady()` 看是否抛 `LoadError, <路径>`；修复数据后**刷新页面**清错误缓存。
3. MCP 侧防御：`upsert_event` 的 characterName 已有文件名字符校验，但不校验文件存在性（素材在 img/ 下，可自行 `ls img/characters` 核对）。

---

## 12. 移动路线两大坑：targetId 反义与 repeat 死循环

### 症状
对话事件里给事件追加一条 `wait:true` 的移动路线后，**事件停在半路、玩家无法移动、无报错**——`isEventRunning()` 恒为 true 的软锁死。

### 根因一：targetId 语义（-1 是玩家！）
引擎 `Game_Interpreter.character(param)`：

```js
if (param < 0) return $gamePlayer;          // -1 = 玩家
else return $gameMap.event(param > 0 ? param : this._eventId);  // 0 = 本事件
```

直觉上"-1=本事件、0=玩家"的人（包括此 MCP 0.3.0 之前的文档）会把路线强加到**玩家**头上。

### 根因二：repeat:true + 会失败的步骤
`repeat:true` 的路线走到 ROUTE_END 后**回到开头永远循环**。若步骤是 `towardPlayer` 而目标相邻（对话触发时必然相邻），移动永远失败但路线永不结束 → `isMoveRouteForcing()` 恒真 → 解释器的 `wait: "route"` 等到天荒地老。玩家身上被强加这种路线时，就是全屏软锁死。

### 修复
- 一次性路线一律 `repeat:false`；循环巡逻路线才用 repeat（且不要配 wait:true）。
- 对话中的"走近"演出改用 `turnTowardPlayer`（转身必定成功）。
- 解锁已卡死的会话：`$gamePlayer._moveRouteForcing = false; $gamePlayer._originalMoveRoute = null; $gameMap._interpreter.terminate();`

---

## 13. revision 冲突工作流

MCP 每次写入都要求 `expectedRevision`（读/渲染地图时返回的 SHA-256）。报 `Revision conflict` 后**不要用旧值重试**——重新 read/render 拿新 revision。同一张图既开原生编辑器又用 MCP 写，必然反复冲突；规矩是：编辑器开着就只读，MCP 写之前关编辑器。

---

## 14. 诊断方法论（通用流程）

1. **先把完整堆栈拿到手**：`index.html` 注入 error/unhandledrejection 钩子；包装 `Graphics.printError`；MZVisualBridge 0.3.0 起 `state()` 自带 `lastGameError` 和引擎错误面板文本，`runtime_status` 直接能看到。
2. **引擎源码是唯一权威**：写任何事件指令前，先 grep `Game_Interpreter.prototype.commandXXX` 确认参数个数和顺序；用任何 API 前先确认它存在于 1.8 源码。本文档第 4–8 条全是“照记忆/旧资料写”翻的车。
3. **实验验证代替 UI 观察**：改一个变量 → 读 `Game_*` 对象内存 → 对照结论。伤害验证、开关状态、变量值都能这么读。
4. **“没反应”的排查顺序**：焦点/RAF 冻结（第 2 条）→ 输入边沿没被采样（第 3 条）→ 事件逻辑本身错了。先排除前两个再查第三个，能省掉大半调试时间。

---

*MCP 0.3.0 已内置的对策：第 1 条自动校验修复、第 3 条 virtualClick 输入、第 12 条错误详细化与游戏页错误上报。其余各条请作为布置事件与自动化试玩时的核对清单。*

## 15. 设了开关却不翻页：宝箱/奖励无限重复拿

### 症状
军用残箱每次调查都重新发装备；掠夺者打赢后原地站着可以无限再战再拿；入队对话可以反复重新触发（反复改名）。玩家报告原话："可以无限拿东西"。

### 根因
事件第 0 页用 123（自开关）/121（开关）给自己打"已完成"标记，但**整个事件没有任何一个页面以该标记为条件**。翻页从未发生，第 0 页永远命中——发奖励的指令每按一次执行一次。这是"用 MCP 造事件"最容易漏的一步：工具只负责发奖励的指令，翻页要你自己记得补。

### 修复模式（标准两页结构）
```
page0（无条件）: 台词 → 126/127/128 发奖励 → 123 ["A", 0]
page1（conditions.selfSwitchValid=true, selfSwitchCh="A"）: "已经空了" 台词
```
战斗事件同理：301 的 601（胜利分支）末尾补 123，再挂一个**空 image** 的 A 条件页让敌人消失。入队事件：在"入伙"分支内部补 123（拒绝分支不要补，否则永远无法再入队）。

### 自动审计规则（本项目 audit-events.cjs 已实现）
事件在某页发放**增益**资源（125/126/127/128/129/311/312/316/317/318 的"增加"方向），且整个事件没有任何"设标记 → 有页面以该标记为条件"的翻页保护 → 判 BUG。
注意：311/312/313 的**减少方向**是伤害陷阱（辐射白骨扣血+中毒），可重复是正确设计，必须按操作数方向区分，否则会误报。

### 教训
凡是"给东西"的工具（event_give_items / event_give_gold / event_change_actor_level / event_recover_all …），用完立刻补 event_self_switch + 条件页，或造完后跑一遍翻页审计。全局开关做演示没问题，但真正防重复的必须是那个被页面条件引用的标记。

### 附：!Chest 这类素材的真正机关——朝向行=开合状态，翻页要改 direction 并锁 directionFix
本模板的宝箱图集（!Chest.png / !SF_Chest.png，8 款箱子 × 3 帧 × 4 朝向行）里，**每个箱子同一行的 3 帧几乎完全相同**（逐帧像素比对：多数 0.0% 差异），开盖的样子画在**"朝上"那一行**（down=闭合、left/right=闭合、up=掀盖露内腔；两款图集、全部 8 款均如此，down 行 vs up 行差异 40-66%）。所以：
- 翻页显示开盖，靠改 pattern（帧）**完全无效**——同帧内没有开盖画；
- 正确做法：page0 `image.direction=2`（闭合行），page1 `image.direction=8`（开盖行）；
- 并且两页都要 `directionFix: true`：引擎在对话开始时会把事件转向玩家（setDirection），朝向一转就离开 up 行，表现为"开盖动画播完又合上了"。directionFix 让 setDirection 失效，开盖页永远停在 up 行。
教训：拿到"某帧看起来不一样"的结论前，先用像素比对确认帧间差异在哪一行/哪一列——这次先误判成"帧3=开盖"（其实是 up 行整体是开盖、帧3只是同行的微差），白白换了款式又被转向打回原形。

## 16. 建筑贴图是组合体：A4 墙顶/墙身配对 + 影子层，选块前必须探测邻块

### 症状
用 MCP 的 paint_tiles 铺出来的建筑是"贴纸"：白墙/砖墙没有影子；或者补了影子后是一条悬空的黑柱，和墙之间隔半格地。

### 机制（引擎源码 + 官方帮助双重确认）
1. **A4 分两种角色**（rmmz_core.js Tilemap.isWallTopTile/isWallSideTile）：autotileKind % 16 < 8 是**墙顶**（只有上表面贴图，无墙体无影子），% 16 >= 8 是**墙身**（影子的承载者）。配对关系：墙顶 k ↔ 墙身 k+8（白色：顶 kind4=基块 6112 ↔ 身 kind12=6464；红砖：顶 kind16=6656 ↔ 身 kind24=7040）。只铺墙顶 = 悬空的地毯；铺墙顶+墙身才是完整墙体。
2. **影子不在贴图里，在影子层**。地图数据 z=4 是影子层，值为 4 位象限掩码（Tilemap._addShadow：bit1=左上、bit2=右上、bit4=左下、bit8=右下；渲染为半格黑色矩形）。**编辑器画墙时会自动在墙身右侧的地面格写"左半"掩码 5（bit1+bit4）**，影子紧贴墙体、从顶盖以下开始，墙身每高一行影子随之变长。MCP 的 paint_tiles 只写图块层，不会自动补——这正是"建筑没有影子"的根因。
3. **官方帮助**（MZ 手册 Editing Map Designs → Autoshadows / Shadow Pen）："垂直叠放两块以上 autotile 时，右下会自动画出影子"；Shadow Pen 以 1/4 格为粒度手绘，点击加影、再点删除。
4. **B-E/A5 普通贴图**大量是 2x2/3x3 组合体（帐篷=9 块、大树、水井）：拿到单块可能只是其一角，必须先用 tile_palette 看它在图集中的上下左右邻居，整组铺放。

### 修复（MCP 0.3.0 起）
- 新工具 **tile_info { tileId }**：选块前探测——返回图集/autotile 角色、A4/A3 配对基块 id、B-E/A5 的组合体警告。选到组合体的一块时先探测再铺。
- **paint_tiles 新增 autoShadow（默认开）**：绘制 A4 墙身（引擎判定 Tilemap.isWallSideTile）后，自动在右侧非墙地面写影子位 5（引擎 Tilemap._addShadow 的象限编码），与编辑器画墙行为一致。0.4.0 起这一步是**双向**的，见第 17 条。
- demo 修复实录：白墙从"两行墙顶"改为"墙顶 k4 一行 + 墙身 k12 一行"；红砖废墟从 A5 贴纸 1562 换成 A4 红砖 顶 6656 + 身 7040；影子位 5 盖在墙身右侧地面。

### 教训
在 RPG Maker 里"贴图像素一样"不等于"是同一块系统"：墙顶和墙身是两个 autotile、影子是第三个数据层。自动化铺图必须把"组合关系探测"放在放块之前，否则每一层机制缺失都会累积成画面上的违和感。

## 17. 抹墙后残留的错落黑条：autoShadow 只会加、不会减（0.4.0 已修）

### 症状
先整片铺 A4 墙身、再用 `paint_tiles` 挖出房间，挖出来的地面上出现错落相间的半格黑条。把第 4 层手动写 0 后条纹立刻消失——可以确认问题在阴影层，不在贴图。

### 根因
`stampWallShadow` 是单调追加：只写"墙身自格 = 10 / 墙身右侧地面 = 5"，从不回收。墙被抹成 `tileId 0` 之后旧掩码留在原地，而后续 autoShadow 只重算还站着的墙，永远不会把已清空的格子归零。整图填墙再挖洞的铺法必然命中，逐格手工画墙则不会——所以它看起来像"忽然坏了"。

A/B 定位（不要靠猜）：同一张图在未打补丁的原始包与当前包上渲染哈希完全一致（`ee36d731…`，`engine.js` md5 相同、`(6,11)` 处 shadow 都是 10），说明缺陷早于本文件第 15、16 条之后的所有修补。

### 修复（0.4.0 shadow reconcile）
- 第 4 层按**当前**墙况双向调和：墙身自格 → 0，右侧非墙地面 → 5，其余自动位 → 0（墙身自格的取值在下一条里被推翻，见 18）。
- 只改写 0/5/10 三种自动值；Shadow Pen 手绘的其他象限掩码原样保留，重铺不会毁掉手工阴影。
- `paint_tiles` 返回 `shadowCells`（本次改写的阴影格数），这条写路径不再是静默副作用。
- 顺带解开的相关阻塞：清空一个视觉格现在写 `tileId: 0` 且**不带** `expectedSheet`（0 不属于任何图集，旧版会被 0.4.0 的页图集校验挡成"没有任何写法可用"）。

### 教训
自动化"补影子"必须做成对账（reconcile）而不是叠加：凡是从目标状态推导派生层的写路径，都要能同时覆盖"新增"和"撤销"，否则第一次大规模返工就会把历史残留固化进画面。

## 18. 墙身自格被写掩码：所有 MCP 做的地图墙壁都是明暗相间竖条（已修）

### 症状
第 17 条修完之后仍然有条纹，而且**范围大得多**：凡是 MCP 铺的墙，两格以上厚度的墙面就出现等间隔的深色竖条；MCP 预览和真实引擎里都看得到。用户在编辑器里手工拉一段墙（附件截图）则是干净的。

### 根因
第 17 条的修复保留了"墙身自格 = 10"这一半规则，它本身就是错的。`stampWallShadow` 逐格写：墙身 → 10、墙身右侧地面 → 5。于是一行连续墙变成 `10 5 10 5 10 5…`——厚墙每两格一条暗带。

判据来自用户手工做的地图 `Documents/RMMZ/Project1/data/Map001.json`：36 个 A4 墙格、18 个阴影格，**墙身上 0 个、地面上 18 个，取值全是 5**。编辑器画墙从不给墙身自格打影子（墙是"受光面"，影子落在它照到的地上）。

错误规则不止在代码里，还写进了 `src/tile-info.js` 的提示语、`docs/TOOLS.md` 第 32 行和 `paint_tiles` 的工具描述——读工具说明的 agent 会照着手写 `10`，所以它会被反复制造出来。

### 修复
- `stampWallShadow`：墙身自格 → 0，只有右侧第一格非墙地面 → 5。旧版留下的墙身掩码会在下一次默认 paint 时被自动回收（自修复），已实测 `lantern-bay` 四张图 51 / 43 / 288 / 156 个坏格清零。
- 写路径 gate：`paint_tiles` 现在**拒绝**那些会被 autoShadow 立刻改回的第 4层写入，报错里给出该格应有的掩码值；要自己支配阴影层就显式传 `autoShadow: false`。
- 测试：`test/shadow.test.js` 新增"两格以上厚墙不得有交替暗带"（逐格断言墙身 0、右侧地面 5、第二格地面 0，并断言幂等）与"回收旧版墙身掩码"两条；`test/project.test.js` 新增"第 4 层冲突写入被拒且不留半成品"一条，并改写了两条把 `10` 钉死在期望值里的旧断言。

### 教训
"和编辑器行为一致"这句话必须拿编辑器真产出的文件来对，不能拿推理对。这条规则错在代码、错在文档、错在工具描述三处，任何一处单独修都不够——派生层的约定要连提示语一起改，否则 agent 会按提示语把它重新写回去。
