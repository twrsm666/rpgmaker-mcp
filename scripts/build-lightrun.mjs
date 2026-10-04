/**
 * Author "Return the Lamp" (还灯) inside the demo project using only the
 * registered MCP tools. The game deliberately exercises the command shapes that
 * have no reference data on this machine: choices, nested conditional branches,
 * a loop with break, battle branches and a shop. Every branch writes a distinct
 * variable, so the playtest can prove that exactly one branch ran rather than
 * none or all three.
 *
 *   node scripts/build-lightrun.mjs plan     # what each tile id actually is
 *   node scripts/build-lightrun.mjs build    # database, maps, tiles, events
 *   node scripts/build-lightrun.mjs verify   # decode, connectivity, assets, render
 *   node scripts/build-lightrun.mjs reset    # take the game back out again
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withRegisteredServer } from "./mcp-client.mjs";

const here = resolve(fileURLToPath(import.meta.url), "..", "..");
const shots = join(here, "samples", "lightrun");
const phase = process.argv[2] ?? "build";

const MAPS = {
    home: { name: "LR Home", width: 14, height: 11, tilesetId: 3 },
    village: { name: "LR Village", width: 26, height: 20, tilesetId: 1 },
    cave: { name: "LR Cave", width: 22, height: 18, tilesetId: 4 },
    tower: { name: "LR Tower", width: 12, height: 21, tilesetId: 3 }
};

const SW = { intro: 20, woke: 21, quest: 22, lampLit: 23, bossDown: 24, ending: 25 };
const VR = { caps: 21, branch: 22, loop: 23 };
const ITEM = { oil: 2, matches: 3, cap: 4, key: 5 };

/** Tile ids read off the contact sheets (scripts/tile-sheet.mjs), each with the
 *  passability the server itself reports: floors open, walls blocked. */
const T = {
    3: { floor: 3246, wall: 7234, carpet: 4084, ornate: 4158, dark: 6880 },
    1: { grass: 2816, road: 3968, water: 2048, rock: 214, house: 4304 },
    4: { floor: 2816, stone: 1538, wall: 7378, lava: 2240 }
};

/** Where each named route lands, resolved to map ids once the maps exist. */
const ROUTES = {
    "village.fromHome": { map: "village", x: 2, y: 10 },
    "home.fromVillage": { map: "home", x: 12, y: 5 },
    "cave.fromVillage": { map: "cave", x: 1, y: 9 },
    "village.fromCave": { map: "village", x: 24, y: 10 },
    "tower.fromCave": { map: "tower", x: 6, y: 19 },
    "tower.fromVillage": { map: "tower", x: 6, y: 19 },
    "village.fromTower": { map: "village", x: 12, y: 1 },
    "village.lit": { map: "village", x: 12, y: 11 },
    "tower.mid": { map: "tower", x: 8, y: 12 },
    "tower.top": { map: "tower", x: 8, y: 4 },
    "tower.bottom": { map: "tower", x: 6, y: 17 }
};

// --- command builders -------------------------------------------------------

const c = (code, ...parameters) => ({ code, indent: 0, parameters });
const END = () => c(0);
/**
 * Shift a block of commands deeper. Relative, not absolute: every builder emits its
 * own openers at 0 and its bodies at 1, so nesting a branch inside a loop has to add
 * one level rather than flatten both to the same indent — which is what MZ reads as
 * "the branch body is empty", and a Break Loop in it then runs on every pass.
 */
const at = (indent, commands) => commands.map(command => ({ ...command, indent: command.indent + indent }));

/** Show Text: one 101 plus one 401 per line, as MZ stores a dialog. */
const say = (lines, options = {}) => {
    const { face = ["", 0], background = 2, position = 1, speaker = "" } = options;
    return [c(101, face[0], face[1], background, position, speaker), ...lines.map(line => c(401, line))];
};

/**
 * Conditional branch. MZ keeps the result in `_branch[indent]`, so the opener,
 * the Else (411) and the End If (412) all sit at the parent indent and only the
 * bodies go one deeper — a marker written deeper reads a slot nobody filled.
 */
const branch = (condition, then, otherwise = null) => [
    c(condition[0], ...condition.slice(1)),
    ...at(1, then),
    ...(otherwise ? [c(411), ...at(1, otherwise)] : []),
    c(412)
];

/** Show Choices: 402 markers at the parent indent, bodies one deeper. */
const choices = (labels, bodies, options = {}) => {
    const { cancel = null, position = 2, background = 0, defaultType = 0 } = options;
    const out = [c(102, labels, cancel === null ? -1 : labels.length, defaultType, position, background)];
    labels.forEach((label, index) => {
        out.push(c(402, index, label), ...at(1, bodies[index]), c(0));
    });
    if (cancel) {
        out.push(c(403), ...at(1, cancel), c(0));
    }
    return out;
};

/** Loop: 112 opens and 413 closes, both at the parent indent. */
const loop = body => [c(112), ...at(1, body), c(413)];

const IF_SWITCH = (id, on = true) => [111, 0, id, on ? 0 : 1];
const IF_VARIABLE = (id, operator, value) => [111, 1, id, 0, value, operator];
const IF_ITEM = id => [111, 8, id];
const OP = { eq: 0, ge: 1, le: 2, gt: 3, lt: 4, ne: 5 };

const SET_SWITCH = (id, value = true) => c(121, id, id, value ? 0 : 1);
const SET_SELF = (letter, value = true) => c(123, letter, value ? 0 : 1);
const ADD_VARIABLE = (id, value) => c(122, id, id, 1, 0, value);
const SET_VARIABLE = (id, value) => c(122, id, id, 0, 0, value);
const GOLD = value => c(125, value < 0 ? 1 : 0, 0, Math.abs(value));
const GIVE_ITEM = (id, count = 1, operation = 0) => c(126, id, operation, 0, count);
const SE = (name, volume = 90, pitch = 100) => c(250, { name, volume, pitch, pan: 0 });
const ME = (name, volume = 90) => c(249, { name, volume, pitch: 100, pan: 0 });
const BGM = (name, volume = 70) => c(241, { name, volume, pitch: 100, pan: 0 });
const FADE_BGM = duration => c(242, duration);
const GO = (ref, direction = 0, fade = 0) => c(201, ref, 0, 0, 0, direction, fade);
const WAIT = frames => c(230, frames);
const FADEOUT = () => c(221);
const FADEIN = () => c(222);
const ANIME = (target, id, wait = false) => c(212, target, id, wait);
const BALLOON = (target, id, wait = false) => c(213, target, id, wait);
const ERASE = () => c(214);
const FLASH = (color, duration, wait = true) => c(224, color, duration, wait);
const WEATHER = (type, power, duration) => c(236, type, power, duration, false);
const BATTLE = troopId => c(301, 0, troopId, 1, 1);
const RECOVER = () => c(314, 0, 1);

const IMAGE = (characterName, characterIndex = 0, direction = 2) => ({ characterName, characterIndex, direction, pattern: 0, tileId: 0 });

// --- the game ---------------------------------------------------------------

/**
 * Events, one entry per map. `refs` carries the enemy and troop ids created at
 * build time, because the battle commands name rows that a fresh project does
 * not have yet.
 */
const GAME = refs => ({
    home: [
        {
            name: "Wake Up",
            x: 0,
            y: 0,
            pages: [
                { page: { trigger: 3 }, list: [...say(["—— 还灯 ——", "昨夜风暴，灯塔熄了。", "出门前先去照镜子。"], { background: 1 }), SET_SWITCH(SW.intro), SET_SELF("A"), END()] },
                { page: { conditions: { selfSwitch: "A" }, trigger: 3 }, list: [END()] }
            ]
        },
        {
            name: "Mirror",
            x: 2,
            y: 2,
            pages: [
                {
                    page: { image: IMAGE("!Switch1"), trigger: 0, priorityType: 1 },
                    list: [
                        ...say(["镜子里的人眼下全是青黑。", "昨晚灯塔灭的时候，你值夜班。"], { speaker: "自己" }),
                        SET_SWITCH(SW.woke),
                        BALLOON(0, 1),
                        SE("Cat", 90, 120),
                        END()
                    ]
                },
                { page: { conditions: { switch1Id: SW.woke }, image: IMAGE("!Switch1"), trigger: 0, priorityType: 1 }, list: [...say(["“记得把灯点上。”你对着镜子说。"], { speaker: "自己" }), END()] }
            ]
        },
        {
            name: "Cat",
            x: 5,
            y: 6,
            pages: [
                {
                    page: { image: IMAGE("Actor3", 4, 4), trigger: 0, priorityType: 1 },
                    list: [
                        ...say(["猫蹲在唯一的出口上，盯着你。"], { speaker: "猫" }),
                        ...choices(
                            ["摸它", "问它灯塔的事", "把它抱开"],
                            [
                                [SET_VARIABLE(VR.branch, 10), ...say(["喵。"], { speaker: "猫" }), SE("Cat")],
                                [SET_VARIABLE(VR.branch, 11), ...say(["它朝北边的灯塔看了一眼。", "“……你也觉得那塔有问题？”"], { speaker: "猫" })],
                                [SET_VARIABLE(VR.branch, 12), ...say(["它钻进了桌子底下。"], { speaker: "猫" })]
                            ],
                            { cancel: [SET_VARIABLE(VR.branch, 13), ...say(["你伸手，它先动了。"], { speaker: "猫" })] }
                        ),
                        END()
                    ]
                }
            ]
        },
        {
            name: "Supply Chest",
            x: 11,
            y: 2,
            pages: [
                {
                    page: { image: IMAGE("!Chest"), trigger: 0, priorityType: 1 },
                    list: [
                        ...branch(
                            IF_SWITCH(SW.quest),
                            [
                                ...say(["值班柜里还剩半桶灯油。"], { speaker: "系统" }),
                                GIVE_ITEM(ITEM.oil),
                                ME("Item"),
                                ANIME(0, 1),
                                // Only a chest that was actually emptied closes: the
                                // locked visit has to stay re-openable for later.
                                SET_SELF("A")
                            ],
                            [...say(["柜子锁着。“灯塔物资，凭值班令领取。”"], { speaker: "系统" })]
                        ),
                        END()
                    ]
                },
                { page: { conditions: { selfSwitch: "A" }, image: IMAGE("!Chest", 1), trigger: 0, priorityType: 1 }, list: [END()] }
            ]
        },
        {
            name: "Door to Village",
            x: 13,
            y: 5,
            pages: [
                { page: { image: IMAGE("!Door1"), trigger: 1 }, list: [...say(["门开着，但你还没醒。"]), END()] },
                {
                    page: { conditions: { switch1Id: SW.woke }, image: IMAGE("!Door1"), trigger: 1 },
                    list: [SE("Door1"), GO("village.fromHome", 4, 1), END()]
                }
            ]
        }
    ],
    village: [
        {
            name: "Elder",
            x: 12,
            y: 7,
            pages: [
                {
                    page: { image: IMAGE("Actor1", 0, 8), trigger: 0, priorityType: 1, directionFix: true },
                    list: [
                        ...say(["灯塔熄了三天，海上的船不敢靠近。", "你是最后一个值夜的人。把灯找回来。"], { face: ["Actor1", 0], speaker: "村长" }),
                        ...choices(
                            ["我去", "我害怕"],
                            [
                                [SET_SWITCH(SW.quest), GOLD(150), ME("Like"), ...say(["“拿去买火种。”"], { face: ["Actor1", 0], speaker: "村长" })],
                                [SET_VARIABLE(VR.branch, 21), ...say(["“害怕也得去。船等不了。”"], { face: ["Actor1", 0], speaker: "村长" })]
                            ],
                            { cancel: [SET_VARIABLE(VR.branch, 22), ...say(["你没有答应，也没有走。"], { speaker: "村长" })] }
                        ),
                        END()
                    ]
                },
                {
                    page: { conditions: { switch1Id: SW.quest }, image: IMAGE("Actor1", 0, 8), trigger: 0, priorityType: 1, directionFix: true },
                    list: [...say(["“东边的洞窟里有光菇，北边的塔才需要亮。”"], { face: ["Actor1", 0], speaker: "村长" }), BALLOON(0, 1), END()]
                }
            ]
        },
        {
            name: "Shop",
            x: 17,
            y: 7,
            pages: [
                {
                    page: { image: IMAGE("Actor2", 1, 8), trigger: 0, priorityType: 1, directionFix: true },
                    list: [
                        ...say(["“火种、药，都卖。”"], { face: ["Actor2", 1], speaker: "商人" }),
                        c(302, 0, ITEM.matches, 1, 120, 0),
                        c(605, 0, 7, 0, 0, 0),
                        c(605, 0, ITEM.oil, 1, 90, 0),
                        ...say(["“慢走。”"], { face: ["Actor2", 1], speaker: "商人" }),
                        END()
                    ]
                }
            ]
        },
        {
            name: "Sign",
            x: 10,
            y: 11,
            pages: [
                {
                    page: { image: IMAGE("!Weapon"), trigger: 0, priorityType: 1 },
                    list: [
                        c(108, "A signpost written by the MCP server."),
                        ...say(["东：洞窟（有光菇）  北：灯塔  西：出镇", "\\N[1] 的名字被刻在牌子背面。"], { background: 0, speaker: "路牌" }),
                        END()
                    ]
                }
            ]
        },
        {
            name: "Storyteller",
            x: 7,
            y: 12,
            pages: [
                {
                    page: { image: IMAGE("Actor3", 2, 4), trigger: 0, priorityType: 1 },
                    list: [
                        SET_VARIABLE(VR.loop, 0),
                        ...loop([
                            ...say(["那天夜里，海面上全是黑的。"]),
                            ADD_VARIABLE(VR.loop, 1),
                            ...branch(IF_VARIABLE(VR.loop, OP.ge, 3), [c(113)])
                        ]),
                        ...say(["“同一句话讲了", "三", "遍，你该信了。”"], { speaker: "说书人" }),
                        END()
                    ]
                }
            ]
        },
        {
            name: "Door to Home",
            x: 1,
            y: 10,
            pages: [{ page: { trigger: 1 }, list: [SE("Door1"), GO("home.fromVillage", 6, 1), END()] }]
        },
        {
            name: "Cave Gate",
            x: 25,
            y: 9,
            pages: [
                { page: { trigger: 1 }, list: [...say(["洞里黑。先弄到照明的东西。"]), END()] },
                { page: { conditions: { itemId: ITEM.oil }, trigger: 1 }, list: [SE("Wind1"), GO("cave.fromVillage", 6, 1), END()] }
            ]
        },
        {
            name: "Tower Gate",
            x: 12,
            y: 0,
            pages: [
                { page: { trigger: 1 }, list: [...say(["塔门紧锁。锁孔的形状像一柄剑。"]), END()] },
                { page: { conditions: { itemId: ITEM.key }, trigger: 1 }, list: [SE("Door2"), GO("tower.fromVillage", 2, 1), END()] }
            ]
        },
        {
            name: "Ending",
            x: 0,
            y: 0,
            pages: [
                {
                    page: { conditions: { switch1Id: SW.lampLit }, trigger: 3 },
                    list: [
                        c(231, 1, "lighthouse-night", 0, 0, 0, 0, 100, 100, 255, 0),
                        WAIT(30),
                        c(232, 1, "", 0, 0, 0, 0, 92, 92, 255, 0, 60, true, 0),
                        c(105, true, 1),
                        c(405, "还灯"),
                        c(405, "——"),
                        c(405, "地图、事件、指令与这一行字幕"),
                        c(405, "都由 rpgmaker-mcp 写入"),
                        c(405, "玩家用键盘走完"),
                        WAIT(120),
                        c(235, 1),
                        SET_SWITCH(SW.ending),
                        ME("Fanfare2"),
                        SET_SELF("A"),
                        END()
                    ]
                },
                { page: { conditions: { switch1Id: SW.lampLit, selfSwitch: "A" }, trigger: 3 }, list: [END()] }
            ]
        }
    ],
    cave: [
        {
            name: "Glow Cap A",
            x: 5,
            y: 5,
            pages: [{ page: { image: IMAGE("!Crystal"), trigger: 0, priorityType: 1 }, list: [ME("Item"), GIVE_ITEM(ITEM.cap), ADD_VARIABLE(VR.caps, 1), ...say(["光菇 1/3。它在你手里还在发光。"]), ERASE(), END()] }]
        },
        {
            name: "Glow Cap B",
            x: 14,
            y: 2,
            pages: [{ page: { image: IMAGE("!Crystal"), trigger: 0, priorityType: 1 }, list: [ME("Item"), GIVE_ITEM(ITEM.cap), ADD_VARIABLE(VR.caps, 1), ...say(["光菇 2/3。"]), ERASE(), END()] }]
        },
        {
            name: "Glow Cap C",
            x: 18,
            y: 12,
            pages: [
                {
                    page: { image: IMAGE("!Crystal"), trigger: 0, priorityType: 1 },
                    list: [
                        ME("Item"),
                        GIVE_ITEM(ITEM.cap),
                        ADD_VARIABLE(VR.caps, 1),
                        ...say(["光菇 3/3。"]),
                        ...branch(IF_VARIABLE(VR.caps, OP.ge, 3), [...say(["三朵串成一串，照亮了洞窟最深处。"]), WEATHER(0, 0, 0)]),
                        ERASE(),
                        END()
                    ]
                }
            ]
        },
        {
            name: "Guardian",
            x: 18,
            y: 15,
            pages: [
                {
                    page: { image: IMAGE("!Weapon"), trigger: 2, priorityType: 0 },
                    list: [
                        ...say(["一柄插在石头里的剑，自己立了起来。"], { speaker: "???" }),
                        FADEOUT(),
                        BGM("Battle1", 70),
                        FADEIN(),
                        BATTLE(refs.bossTroop),
                        c(601),
                        ...at(1, [SET_VARIABLE(VR.branch, 1), SET_SWITCH(SW.bossDown), GIVE_ITEM(ITEM.key), ME("Victory1"), ...say(["剑落进你手里，化成一把钥匙。"])]),
                        c(602),
                        ...at(1, [SET_VARIABLE(VR.branch, 2), ...say(["你退开了。它还站在原地。"])]),
                        c(603),
                        ...at(1, [SET_VARIABLE(VR.branch, 3), RECOVER(), ...say(["你倒在石头里。有人把你拖回了镇上。"]), GO("village.fromCave", 0, 1)]),
                        SET_SELF("A"),
                        END()
                    ]
                },
                { page: { conditions: { selfSwitch: "A" }, trigger: 0, priorityType: 1 }, list: [END()] }
            ]
        },
        {
            name: "Matches Chest",
            x: 3,
            y: 14,
            pages: [
                {
                    page: { image: IMAGE("!Chest"), trigger: 0, priorityType: 1 },
                    list: [
                        ...branch(
                            IF_SWITCH(SW.bossDown),
                            [...say(["火种盒。守卫让开了。"]), GIVE_ITEM(ITEM.matches), ME("Item"), SET_SELF("A")],
                            [...say(["盒子被一股力气按住。“先赢那把剑。”"])]
                        ),
                        END()
                    ]
                },
                { page: { conditions: { selfSwitch: "A" }, image: IMAGE("!Chest", 1), trigger: 0, priorityType: 1 }, list: [END()] }
            ]
        },
        { name: "Cave Exit", x: 0, y: 9, pages: [{ page: { trigger: 1 }, list: [GO("village.fromCave", 4, 1), END()] }] },
        {
            name: "Cave North Door",
            x: 6,
            y: 1,
            pages: [
                { page: { trigger: 1 }, list: [...say(["北边的门被石头堵着。"]), END()] },
                { page: { conditions: { switch1Id: SW.bossDown }, trigger: 1 }, list: [SE("Door3"), GO("tower.fromCave", 2, 1), END()] }
            ]
        },
        { name: "Lava Note", x: 19, y: 5, pages: [{ page: { trigger: 0, priorityType: 1 }, list: [...say(["热。别踩。"]), END()] }] }
    ],
    tower: [
        { name: "Up from Bottom", x: 3, y: 16, pages: [{ page: { trigger: 1 }, list: [SE("Switch1"), GO("tower.mid", 2, 0), END()] }] },
        { name: "Up from Mid", x: 3, y: 9, pages: [{ page: { trigger: 1 }, list: [SE("Switch1"), GO("tower.top", 2, 0), END()] }] },
        { name: "Down from Top", x: 8, y: 5, pages: [{ page: { trigger: 1 }, list: [GO("tower.mid", 8, 0), END()] }] },
        { name: "Down from Mid", x: 8, y: 13, pages: [{ page: { trigger: 1 }, list: [GO("tower.bottom", 2, 0), END()] }] },
        { name: "Tower Exit", x: 1, y: 17, pages: [{ page: { trigger: 1 }, list: [GO("village.fromTower", 8, 1), END()] }] },
        {
            name: "Lamp",
            x: 3,
            y: 1,
            pages: [
                {
                    page: { image: IMAGE("!Flame"), trigger: 0, priorityType: 1 },
                    list: [
                        ...branch(
                            IF_ITEM(ITEM.oil),
                            [
                                ...branch(
                                    IF_ITEM(ITEM.matches),
                                    [
                                        GIVE_ITEM(ITEM.oil, 1, 1),
                                        GIVE_ITEM(ITEM.matches, 1, 1),
                                        FLASH([255, 220, 120], 30),
                                        ME("Fanfare1"),
                                        ANIME(0, 1, true),
                                        SET_SWITCH(SW.lampLit),
                                        ...say(["灯芯咬住火，光从塔顶压下来。", "海面上，船开始转向。"]),
                                        FADE_BGM(60),
                                        BGM("Scene3", 60),
                                        GO("village.lit", 0, 1)
                                    ],
                                    [...say(["灯芯是干的，可是没有火。"]), BALLOON(0, 2)]
                                )
                            ],
                            [...say(["灯座空着。“先弄到灯油。”"])]
                        ),
                        END()
                    ]
                }
            ]
        }
    ]
});

// --- tiles ------------------------------------------------------------------

const rect = (x, y, width, height, tileId, layer = 0) => ({ x, y, width, height, layer, tileId });

const TILE_MAPS = {
    home: [
        rect(0, 0, 14, 11, T[3].wall),
        rect(1, 1, 12, 9, T[3].floor),
        rect(5, 4, 4, 3, T[3].carpet),
        rect(2, 2, 2, 1, T[3].dark),
        rect(13, 5, 1, 1, T[3].floor)
    ],
    village: [
        rect(0, 0, 26, 20, T[1].grass),
        rect(2, 9, 22, 2, T[1].road),
        rect(11, 1, 3, 9, T[1].road),
        rect(19, 14, 5, 4, T[1].water),
        rect(4, 3, 5, 4, T[1].house),
        rect(16, 3, 5, 4, T[1].house),
        rect(0, 0, 26, 1, T[1].rock),
        rect(0, 19, 26, 1, T[1].rock),
        rect(0, 0, 1, 20, T[1].rock),
        rect(25, 0, 1, 20, T[1].rock),
        rect(2, 13, 1, 1, T[1].rock),
        rect(6, 15, 1, 1, T[1].rock),
        rect(9, 5, 1, 1, T[1].rock),
        rect(22, 5, 1, 1, T[1].rock),
        rect(25, 9, 1, 2, T[1].grass),
        rect(11, 0, 3, 1, T[1].road),
        rect(12, 0, 1, 1, T[1].road)
    ],
    cave: [
        rect(0, 0, 22, 18, T[4].wall),
        rect(1, 1, 20, 16, T[4].floor),
        rect(3, 3, 16, 3, T[4].stone),
        rect(6, 12, 10, 1, T[4].stone),
        rect(18, 3, 3, 2, T[4].lava),
        rect(0, 9, 1, 1, T[4].floor),
        rect(6, 1, 1, 1, T[4].floor),
        rect(1, 17, 20, 1, T[4].wall),
        rect(1, 16, 10, 1, T[4].floor)
    ],
    tower: [
        rect(0, 0, 12, 21, T[3].wall),
        rect(1, 1, 10, 5, T[3].floor),
        rect(1, 9, 10, 5, T[3].floor),
        rect(1, 16, 10, 3, T[3].floor),
        rect(3, 1, 2, 1, T[3].carpet),
        rect(3, 9, 2, 1, T[3].carpet),
        rect(3, 16, 2, 1, T[3].carpet),
        rect(6, 19, 1, 1, T[3].floor)
    ]
};

const REGIONS = { cave: [rect(3, 3, 16, 3, 1, 5)] };

// --- phases -----------------------------------------------------------------

const paint = async (call, mapId, rects) => {
    for (const r of rects) {
        const result = await call("set_tiles", { mapId, rect: r });
        if (result.cellsWritten !== r.width * r.height) {
            throw new Error(`set_tiles wrote ${result.cellsWritten} of ${r.width * r.height} cells`);
        }
    }
};

const plan = async call => {
    for (const [tilesetId, picks] of Object.entries(T)) {
        const tileset = (await call("read_database", { table: "Tilesets", id: Number(tilesetId) })).entry;
        console.log(`== tileset ${tilesetId} ${tileset.name}`);
        for (const [label, id] of Object.entries(picks)) {
            const flags = tileset.flags[id] ?? 0;
            const passage = flags & 0x0f;
            console.log(
                `   ${label.padEnd(7)} ${String(id).padStart(4)} passage=0x${passage.toString(16)} ${(passage & 0x0f) === 15 ? "blocked" : "open"}` +
                    ` damage=${flags & 0x100 ? 1 : 0} counter=${flags & 0x80 ? 1 : 0} ladder=${flags & 0x20 ? 1 : 0}`
            );
        }
    }
};

/** Find a row by name, or claim one the way the editor does. */
const ensureRow = async (call, table, name, spec) => {
    const rows = await call("read_database", { table });
    const found = rows.entries.find(entry => entry.name === name);
    if (found) {
        return { id: found.id, created: false };
    }
    const created = await call("create_database_entry", { table, ...spec, fields: { ...spec.fields, name } });
    return { id: created.id, created: true };
};

/**
 * The two foes the game fights. The stock ones carry 200-1000 HP, which is fine
 * for a real game and hopeless for a scripted playthrough, so the game brings
 * its own weak rows — which also puts create_database_entry through Enemies and
 * Troops, tables whose nested fields (members, traits) it has to write whole.
 */
const foes = async call => {
    const bat = await ensureRow(call, "Enemies", "洞蝠", {
        copyFrom: 3,
        fields: { params: [22, 0, 12, 6, 5, 6, 5, 8, 3], expParams: { baseLevel: 1, exp: 12, param1: 20, param2: 20 }, gold: 8, dropItems: [] }
    });
    const boss = await ensureRow(call, "Enemies", "石中剑", {
        copyFrom: 1,
        fields: { params: [46, 0, 16, 9, 7, 7, 7, 5, 3], expParams: { baseLevel: 2, exp: 40, param1: 30, param2: 30 }, gold: 40, dropItems: [] }
    });
    const troopRow = async (name, source, enemyId) => {
        const rows = await call("read_database", { table: "Troops" });
        const existing = rows.entries.find(entry => entry.name === name);
        if (existing) {
            return existing.id;
        }
        const template = (await call("read_database", { table: "Troops", id: source })).entry;
        const member = { ...template.members[0], enemyId };
        const created = await call("create_database_entry", { table: "Troops", copyFrom: source, fields: { name, members: [member] } });
        return created.id;
    };
    const batTroop = await troopRow("LR Bats", 3, bat.id);
    const bossTroop = await troopRow("LR Guardian", 4, boss.id);
    console.log("foes", JSON.stringify({ bat: bat.id, boss: boss.id, batTroop, bossTroop, created: [bat.created, boss.created] }));
    return { batTroop, bossTroop };
};

const build = async call => {
    mkdirSync(shots, { recursive: true });
    // A project copied from the engine's own `data/newdata` template has no
    // `advanced.windowOpacity`, and a game built there boots into a title screen that
    // never leaves. Ask for the repair before writing anything, and say what it did.
    const repaired = await call("fix_project", {});
    if (repaired.changed) {
        console.log(`fix_project wrote ${JSON.stringify(repaired.repaired)} (from ${repaired.tookValuesFrom})`);
    }
    const refs = await foes(call);
    const game = GAME(refs);

    // 1. Item rows the game names, claimed the way the editor claims a slot.
    const itemSpecs = [
        { id: ITEM.oil, name: "灯油", desc: "灯塔的燃料。洞窟里太黑，也需要它。" },
        { id: ITEM.matches, name: "火种盒", desc: "守卫看着的那盒火柴。" },
        { id: ITEM.cap, name: "光菇", desc: "摘下来还会发亮的蘑菇。三朵一串。" },
        { id: ITEM.key, name: "塔钥匙", desc: "一柄剑化成的钥匙。" }
    ];
    for (const spec of itemSpecs) {
        const existing = await call("read_database", { table: "Items", id: spec.id });
        if (existing.entry?.name) {
            console.log(`item ${spec.id} "${existing.entry.name}" already there`);
            continue;
        }
        const created = await call("create_database_entry", {
            table: "Items",
            id: spec.id,
            copyFrom: 7,
            fields: { name: spec.name, description: spec.desc, iconIndex: 63, itypeId: 1, consumable: false, scope: 0, occasion: 0, price: 0, note: "written by rpgmaker-mcp" }
        });
        console.log(`item ${created.id} "${created.entry.name}" ${created.slot}`);
    }

    // 2. Switch and variable names, plus the title.
    const system = await call("read_database", { table: "System" });
    await call("patch_database_entry", {
        table: "System",
        patch: {
            gameTitle: "还灯 · Return the Lamp",
            switches: { ...(system.value.switches ?? {}), [SW.intro]: "开场", [SW.woke]: "醒", [SW.quest]: "接令", [SW.lampLit]: "灯已点", [SW.bossDown]: "守卫已让", [SW.ending]: "结局" },
            variables: { ...(system.value.variables ?? {}), [VR.caps]: "光菇", [VR.branch]: "分支探针", [VR.loop]: "说书计数" }
        }
    });

    // 3. Maps.
    const ids = {};
    for (const [key, spec] of Object.entries(MAPS)) {
        const existing = (await call("list_maps")).maps.find(map => map.name === spec.name);
        ids[key] = existing ? existing.id : (await call("create_map", { ...spec, parentId: 1 })).id;
    }
    console.log("maps", JSON.stringify(ids));

    for (const [key, rects] of Object.entries(TILE_MAPS)) {
        await paint(call, ids[key], rects);
    }
    for (const [key, rects] of Object.entries(REGIONS)) {
        await paint(call, ids[key], rects);
    }

    // 4. Map-level settings: encounters, the name banner, the map's own BGM.
    await call("set_map_properties", {
        mapId: ids.cave,
        displayName: "黑水洞",
        encounterStep: 12,
        encounters: [{ regionSet: [1], troopId: refs.batTroop, weight: 3 }],
        disableDashing: true
    });
    await call("set_map_properties", {
        mapId: ids.village,
        displayName: "灯下镇",
        autoplayBgm: true,
        bgm: { name: "Town1", volume: 55, pitch: 100, pan: 0 }
    });
    await call("set_map_properties", { mapId: ids.tower, displayName: "灯塔" });
    await call("set_map_properties", { mapId: ids.home, displayName: "值班室" });

    // 5. Events.
    const wire = command => {
        if (command.code !== 201 || typeof command.parameters[0] !== "string") {
            return command;
        }
        const route = ROUTES[command.parameters[0]];
        if (!route) {
            throw new Error(`unknown transfer route ${command.parameters[0]}`);
        }
        return { ...command, parameters: [0, ids[route.map], route.x, route.y, command.parameters[4] ?? 0, command.parameters[5] ?? 0] };
    };
    const placed = {};
    for (const [key, list] of Object.entries(game)) {
        const mapId = ids[key];
        const existing = await call("find_events", { mapId, limit: 200 });
        for (const hit of existing.hits ?? []) {
            await call("remove_event", { mapId, eventId: hit.eventId });
        }
        placed[key] = [];
        for (const event of list) {
            const created = await call("place_event", { mapId, x: event.x, y: event.y, name: event.name });
            for (let index = 0; index < event.pages.length; index++) {
                const page = event.pages[index];
                const list = page.list.map(wire);
                const bad = list.findIndex(command => !command || typeof command !== "object" || typeof command.code !== "number" || !Array.isArray(command.parameters));
                if (bad >= 0) {
                    throw new Error(`${key}/${event.name} page ${index}: command ${bad} is not a command: ${JSON.stringify(list[bad])?.slice(0, 160)}`);
                }
                await call("set_event_page", {
                    mapId,
                    eventId: created.id,
                    pageIndex: index,
                    // set_event_page only writes what it is given, and a fresh page starts at
                    // the editor default "same as tiles", which silently blocks a touch tile.
                    priorityType: 0,
                    ...page.page
                });
                const written = await call("set_commands", { mapId, eventId: created.id, pageIndex: index, list });
                for (const warning of written.warnings ?? []) {
                    console.log(`  WARN ${key}/${event.name} page ${index}: ${warning}`);
                }
            }
            placed[key].push({ id: created.id, name: event.name, x: event.x, y: event.y });
        }
    }
    console.log("events", JSON.stringify(placed));

    // 6. The ending picture. It ships in this package (`assets/`), because a build that
    // reaches outside the repository for one of its own files is not a build anybody else
    // can reproduce — and it is a .png, because `ImageManager.loadBitmap` asks each img/
    // folder for "<name>.png" and nothing else.
    const imported = await call("import_asset", { source: join(here, "assets", "lighthouse-night.png"), folder: "pictures", name: "lighthouse-night", overwrite: true });
    console.log("picture", JSON.stringify({ file: imported.file, bytes: imported.bytes, action: imported.action }));

    // 7. A new game starts in the home, with the one actor the story follows.
    // MZ reads the starting party from `partyMembers`; `startActors` is MV's key and
    // does nothing here.
    await call("patch_database_entry", {
        table: "System",
        patch: { startMapId: ids.home, startX: 3, startY: 5, partyMembers: [1], testBattlers: [{ actorId: 1, level: 1, equips: [2, 1, 2, 3, 0] }] }
    });
    console.log("start", JSON.stringify({ mapId: ids.home, x: 3, y: 5 }));

    // 8. The gate. A build that prints its map ids and then leaves the playtest to find
    // an unbootable game wastes the run, so the audit of what this build wrote is the
    // last thing `build` does, and an error in it is a failed build.
    const audit = await call("validate_game", { mapIds: Object.values(ids) });
    const errors = (audit.problems ?? []).filter(problem => problem.severity === "error");
    for (const problem of (audit.problems ?? []).filter(problem => problem.severity === "warning").slice(0, 6)) {
        console.log(`   warning ${problem.where}: ${problem.what}`);
    }
    if (errors.length) {
        for (const problem of errors.slice(0, 10)) {
            console.error(`   ERROR ${problem.where}: ${problem.what} -> ${problem.fix}`);
        }
        throw new Error(`build left ${errors.length} error(s) in maps ${Object.values(ids).join(",")} — the playtest would start on a game that is already broken`);
    }
    console.log(`validate_game: the ${Object.keys(ids).length} maps this build wrote are sound (${audit.checked?.events ?? "?"} events checked)`);
};

const verify = async call => {
    const byName = async (table, name) => (await call("read_database", { table })).entries.find(entry => entry.name === name)?.id ?? 0;
    const game = GAME({ batTroop: await byName("Troops", "LR Bats"), bossTroop: await byName("Troops", "LR Guardian") });
    const ids = {};
    for (const [key, spec] of Object.entries(MAPS)) {
        const found = (await call("list_maps")).maps.find(map => map.name === spec.name);
        if (!found) {
            console.log(`missing map ${spec.name}`);
            continue;
        }
        ids[key] = found.id;
    }
    const starts = { home: [3, 5], village: [2, 10], cave: [1, 9], tower: [6, 19] };
    for (const [key, list] of Object.entries(game)) {
        if (!ids[key]) {
            continue;
        }
        const undecoded = [];
        for (const event of list) {
            const decoded = await call("find_events", { mapId: ids[key], name: event.name });
            const hit = decoded.hits[0];
            if (!hit) {
                console.log(`  ${key}: ${event.name} MISSING`);
                continue;
            }
            for (let page = 0; page < event.pages.length; page++) {
                const result = await call("decode_commands", { mapId: ids[key], eventId: hit.eventId, pageIndex: page });
                for (const line of result.lines ?? []) {
                    if (/code \d+/.test(line)) {
                        undecoded.push(`${event.name}p${page}: ${line}`);
                    }
                }
            }
        }
        if (undecoded.length) {
            console.log(`  ${key}: ${undecoded.length} undecoded lines`);
            for (const line of undecoded.slice(0, 10)) {
                console.log(`     ${line}`);
            }
        }
        const [x, y] = starts[key];
        const reach = await call("map_connectivity", { mapId: ids[key], x, y });
        const show = report =>
            `${report.name}(${report.mapId})@${report.start.x},${report.start.y} cells ${report.reachableCells}/${report.walkableCells} isolated ${report.isolatedWalkableCells} ` +
            report.events
                .map(event => event.how)
                .filter((value, index, all) => all.indexOf(value) === index)
                .map(how => `${how} ${report.events.filter(event => event.how === how).length}`)
                .join(" ") +
            ` portals ${report.portals.map(portal => `${portal.name}->${portal.to.mapId}:${portal.to.x},${portal.to.y}`).join(",")}` +
            (report.unreachableEvents.length ? ` | stranded: ${report.unreachableEvents.join(" ")}` : "");
        for (const report of reach.reports) {
            console.log(`   ${show(report)}`);
        }
        for (const trap of reach.traps ?? []) {
            console.log(`   TRAP map ${trap.mapId} event "${trap.event}": ${trap.error}`);
        }
        await call("render_map", { mapId: ids[key], showEvents: true, saveTo: join(shots, `${key}.png`) });
    }
    const assets = await call("check_assets", {});
    console.log("assets", JSON.stringify({ ok: assets.ok, refs: assets.refs, distinct: assets.distinct, missing: (assets.missing ?? []).slice(0, 10) }));
};

const reset = async call => {
    const system = await call("read_database", { table: "System" });
    const switches = { ...(system.value.switches ?? {}) };
    const variables = { ...(system.value.variables ?? {}) };
    for (const id of Object.values(SW)) {
        delete switches[id];
    }
    for (const id of Object.values(VR)) {
        delete variables[id];
    }
    await call("patch_database_entry", { table: "System", patch: { switches, variables, gameTitle: "MCP 小屋试验" } });
    for (const spec of Object.values(MAPS)) {
        const found = (await call("list_maps")).maps.find(map => map.name === spec.name);
        if (!found) {
            continue;
        }
        const map = await call("get_map", { mapId: found.id });
        for (const event of map.events ?? []) {
            await call("remove_event", { mapId: found.id, eventId: event.id });
        }
    }
    console.log("reset done (the map files stay; undo_writes is what deletes them)");
};

withRegisteredServer(async call => {
    const started = Date.now();
    if (phase === "plan") {
        await plan(call);
    } else if (phase === "build") {
        await build(call);
    } else if (phase === "verify") {
        await verify(call);
    } else if (phase === "reset") {
        await reset(call);
    } else {
        throw new Error(`unknown phase ${phase}`);
    }
    console.log(`${phase} finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
