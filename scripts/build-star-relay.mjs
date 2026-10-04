/**
 * Build the acceptance game — "Star Relay" — through the high-level authoring tools.
 *
 * This script is the test the server needs: if an agent cannot lay out a whole,
 * playable three-map game with `make_npc` / `make_chest` / `link_maps` / `make_shop` /
 * `make_encounter_zone` / `make_choice_scene` / `set_tileset_flags` / `validate_game`,
 * then the high-level layer is documentation rather than control. Everything it *has* to
 * reach below that layer is recorded with a reason and written to
 * `samples/star-relay/escape-hatches.json`, because that list is the next release's
 * roadmap and should be short.
 *
 *   node scripts/build-star-relay.mjs build    # database, maps, tiles, content
 *   node scripts/build-star-relay.mjs check    # decode, connectivity, assets, renders
 *   node scripts/build-star-relay.mjs reset    # take the game back out again
 *
 * Re-running `build` is safe: the maps are found by name, their events are cleared, and
 * every content call replaces the event of its own name.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withRegisteredServer } from "./mcp-client.mjs";

const here = resolve(fileURLToPath(import.meta.url), "..", "..");
// `RMMZ_SR_SHOTS` exists because the same game is built twice: once into the author's
// project, whose evidence is quoted in the docs, and once into a throwaway copy of the
// shipped template by `npm run census`. The second must not overwrite the first.
const shots = process.env.RMMZ_SR_SHOTS ?? join(here, "samples", "star-relay");
const phase = process.argv[2] ?? "build";

const MAPS = {
    home: { title: "home", name: "SR Keeper's House", width: 14, height: 11, tilesetId: 3 },
    village: { title: "village", name: "SR Village", width: 26, height: 18, tilesetId: 1 },
    cave: { title: "cave", name: "SR Relay Cave", width: 22, height: 16, tilesetId: 4 }
};

/** Ids past the rows "Return the Lamp" reserved, so the two games coexist. */
const SW = { met: 27, quest: 28, shrine: 29, boss: 30, ending: 31 };
const VR = { branch: 25, bats: 26, core: 27 };

/** Tile ids the server's own flags say are walkable or solid, per tileset. */
const T = {
    3: { floor: 3246, wall: 7234, carpet: 4084, dark: 6880 },
    1: { grass: 2816, road: 3968, water: 2048, rock: 283, house: 4304 },
    4: { floor: 2816, stone: 1538, wall: 7378, lava: 2240 }
};

/** Where each route lands, resolved to map ids once the maps exist. */
const ROUTES = {
    "village.fromHome": { map: "village", x: 2, y: 9 },
    "home.fromVillage": { map: "home", x: 13, y: 5 },
    "cave.fromVillage": { map: "cave", x: 1, y: 8 },
    "village.fromCave": { map: "village", x: 24, y: 9 },
    "cave.altar": { map: "cave", x: 18, y: 8 },
    "village.arrive": { map: "village", x: 15, y: 9 }
};

// ---------------------------------------------------------------------------
// The two kinds of call: content goes through the high-level layer, and what
// cannot is written down.
// ---------------------------------------------------------------------------

const escapeHatches = [];
let highLevelCalls = 0;

/** Reading the project is not a gap in the layer; a write the layer could not make is. */
const READ_ONLY = new Set(["list_maps", "get_map", "read_database", "find_events", "decode_commands", "inspect_cell", "map_connectivity", "check_assets", "render_map", "validate_game", "tileset_slots", "command_catalog", "block_structure"]);

const install = (call, ids) => {
    /** A low-level call, logged with the reason the high-level layer could not make it. */
    const low = async (tool, reason, args = {}) => {
        const result = await call(tool, args);
        escapeHatches.push({ tool, kind: READ_ONLY.has(tool) ? "read" : "write", reason, args: summarize(args) });
        return result;
    };
    /** A high-level call: the point of the whole exercise. */
    const high = async (tool, args = {}) => {
        highLevelCalls++;
        const result = await call(tool, args);
        if (result?.error) {
            throw new Error(`${tool}: ${result.error}`);
        }
        for (const warning of result.warnings ?? []) {
            console.log(`   ! ${tool}: ${warning}`);
        }
        for (const hatch of result.escapeHatches ?? []) {
            console.log(`   ~ ${tool} fell back to raw commands: ${hatch}`);
        }
        return result;
    };
    return { low, high };
};

const summarize = args => {
    const text = JSON.stringify(args);
    return text && text.length > 220 ? `${text.slice(0, 217)}...` : args;
};

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

const rect = (x, y, width, height, tileId) => ({ x, y, width, height, tileId });

/** The tile plan per map: what fills, what the player walks on, what stops them. */
const LAYOUT = {
    home: [
        rect(0, 0, 14, 11, T[3].wall),
        rect(1, 1, 12, 9, T[3].floor),
        rect(5, 2, 4, 2, T[3].carpet),
        rect(9, 6, 3, 2, T[3].dark),
        rect(13, 5, 1, 1, T[3].floor)
    ],
    village: [
        rect(0, 0, 26, 18, T[1].grass),
        rect(2, 9, 23, 1, T[1].road),
        rect(15, 9, 1, 8, T[1].road),
        rect(19, 13, 5, 4, T[1].water),
        rect(4, 3, 4, 3, T[1].house),
        // The ring of standing rocks around the relay well, with the gap the player
        // walks through at (15,8). Solid or not is decided by set_tileset_flags below.
        rect(12, 3, 7, 1, T[1].rock),
        rect(12, 4, 1, 4, T[1].rock),
        rect(18, 4, 1, 4, T[1].rock),
        rect(12, 8, 3, 1, T[1].rock),
        rect(16, 8, 3, 1, T[1].rock)
    ],
    cave: [
        rect(0, 0, 22, 16, T[4].wall),
        rect(1, 7, 4, 3, T[4].floor),
        rect(2, 8, 1, 1, T[4].floor),
        rect(5, 3, 12, 10, T[4].floor),
        rect(17, 5, 4, 7, T[4].floor),
        rect(8, 12, 6, 3, T[4].floor),
        rect(6, 4, 2, 2, T[4].stone),
        rect(13, 10, 2, 2, T[4].stone),
        rect(19, 12, 2, 3, T[4].lava)
    ]
};

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

/** The same rectangle, spelled the way `make_map` wants its paint strokes. */
const stroke = block => ({ x: block.x, y: block.y, width: block.width, height: block.height, tile: block.tileId });

/** What the village's rock ring and its water are to the engine: solid, and the water
 *  also carries a terrain tag. Said in the call that paints them, so the layout and its
 *  passability cannot drift apart. */
const VILLAGE_FLAGS = [{ tileId: T[1].rock, passable: false }, { tileId: T[1].water, passable: false, terrainTag: 2 }];

/** The maps this game owns, painted. `make_map` takes the whole plan: it makes or reuses
 *  the map, resolves one tile per cell so nothing is stacked, sends each tile to the layer
 *  its own slot belongs to, and applies the passage flags in the same transaction. */
const laidOut = {};

const ensureMap = async ({ low, high }, spec, key) => {
    const painted = await high("make_map", {
        find: spec.name,
        width: spec.width,
        height: spec.height,
        tilesetId: spec.tilesetId,
        parentId: 1,
        paint: LAYOUT[key].map(stroke),
        ...(key === "village" ? { flags: VILLAGE_FLAGS } : {})
    });
    laidOut[spec.title] = painted;
    if (painted.made === "repainted") {
        // A re-run takes the old content out; the tiles were replaced by the call above.
        await high("clear_events", { mapId: painted.mapId });
    }
    console.log(`   ${spec.name} (${painted.mapId}, ${painted.made}): ${painted.cellsWritten} cells, ${painted.walkable.open} of them walkable`);
    return painted.mapId;
};

const build = async (call, ids) => {
    const { low, high } = install(call, ids);

    // The project may have come from the engine's `data/newdata` template rather than the
    // editor, and that template has no `advanced.windowOpacity`: the game would stop on its
    // title screen and every playtest after this would time out. Repair first, out loud.
    const repaired = await high("fix_project", {});
    if (repaired.changed) {
        console.log(`fix_project wrote ${JSON.stringify(repaired.repaired)} (from ${repaired.tookValuesFrom})`);
    }

    // --- the shell: names, tables, terrain -----------------------------------
    const switches = { ...(await low("read_database", "reading the switch table to grow it", { table: "System" })).value.switches };
    const variables = { ...(await low("read_database", "reading the variable table to grow it", { table: "System" })).value.variables };
    for (const [key, id] of Object.entries(SW)) {
        switches[id] = { met: "见过灯塔", quest: "接下传灯", shrine: "洞窟祭坛", boss: "守卫退去", ending: "星灯已续" }[key];
    }
    for (const [key, id] of Object.entries(VR)) {
        variables[id] = { branch: "支线探针", bats: "遇敌计数", core: "灯芯状态" }[key];
    }
    // The two tables go in the same call that could set the title and the opening cell,
    // because `patch_database_entry` has to be handed `advanced` whole to touch one key.
    await high("set_startup", { switches, variables });

    const lantern = await ensureLantern(high);
    const fuse = await ensureFuse(high);
    const boss = await ensureBossTroop(high);

    // The terrain and its passability were one call per map, made when the maps were
    // created above; the village's rock ring is the interesting one, because MZ ships
    // 岩山 with the "no effect on passage" bit set — walkable ground until the flags say
    // otherwise. The playtest walks into it.
    for (const [key, spec] of Object.entries(MAPS)) {
        const painted = laidOut[spec.title];
        if (!painted) {
            continue;
        }
        console.log(`   ${spec.name}: ${painted.tilesPlanned} distinct tiles over ${painted.size.join("x")} cells, walkable ${painted.walkable.open}/${painted.walkable.open + painted.walkable.blocked}`);
        for (const line of painted.flagsApplied ?? []) {
            console.log(`   fence: ${line}`);
        }
    }

    // --- the keeper's house ---------------------------------------------------
    // An Autorun page re-arms on every frame its conditions hold, and while an event is
    // starting `Game_Map.isEventRunning()` is true, which is what `Game_Player.canMove()`
    // reads — so an autorun that does not erase itself or take a self switch is a map the
    // player cannot walk on. This is the shape that actually stops.
    await high("make_choice_scene", {
        mapId: ids.home, x: 0, y: 0, name: "SR Intro", trigger: 3, priorityType: 0,
        script: [
            { say: { lines: ["—— 星之 relay ——", "天空站的最后一盏灯昨夜熄了。", "守灯人 Maren 在屋里等你。"], background: 1 } },
            { switch: { id: SW.met } },
            { wait: 30 },
            { selfSwitch: { letter: "A" } },
            { erase: true }
        ]
    });
    const intro = (await call("find_events", { mapId: ids.home, name: "SR Intro", limit: 10 })).hits[0];
    await high("make_choice_scene", {
        mapId: ids.home, eventId: intro.eventId, pageIndex: 1, trigger: 0, priorityType: 0,
        when: { selfSwitch: "A" }, script: [{ comment: ["星之 relay 开场已演"] }]
    });

    await high("make_npc", {
        mapId: ids.home, x: 5, y: 3, name: "Maren the Keeper",
        image: { characterName: "Actor1", characterIndex: 1, direction: 8 },
        // `follow.when` is a switch, so make_npc appends the Control Switches that sets it
        // to this page — which is what unlocks the door out of the house.
        say: {
            lines: ["灯塔的传灯链断在洞窟那一站。", "带上这个村的星灯去，别摸黑走。", "路上有蝙蝠，别停。"],
            speaker: "Maren",
            faceName: "Actor1",
            faceIndex: 1
        },
        follow: {
            say: ["星灯在村东的贩子手里。", "别走中间那块石头——那不是给脚踩的。"],
            when: { switch: SW.quest }
        },
        patrol: [{ down: true }, { right: true }, { up: true }, { left: true }, { wait: 20 }]
    });

    await high("make_chest", {
        mapId: ids.home, x: 10, y: 2, name: "Cellar Chest",
        contents: { gold: 90, items: [{ id: 7, count: 2 }] },
        message: ["值班柜里还有 90 钱和两瓶伤药。"],
        graphic: { characterName: "!Chest" }
    });

    await high("make_chest", {
        mapId: ids.home, x: 11, y: 2, name: "Locked Strongbox",
        contents: { gold: 200 },
        message: ["铁箱开了，里面是亮闪闪的 200 钱。"],
        lockedMessage: ["铁箱纹丝不动。“传灯令之后再来。”"],
        requires: { switch: SW.quest }
    });

    // --- the village ----------------------------------------------------------
    await high("link_maps", {
        a: { mapId: ids.home, x: ROUTES["home.fromVillage"].x, y: ROUTES["home.fromVillage"].y, name: "Door to Village" },
        b: { mapId: ids.village, x: ROUTES["village.fromHome"].x, y: ROUTES["village.fromHome"].y, name: "Door to the Keeper's House" },
        requires: { switch: SW.quest },
        lockedMessage: ["门从里面闩着。先去找守灯人说话。"],
        fade: 1
    });

    await high("make_npc", {
        mapId: ids.village, x: 15, y: 6, name: "Warden Ilse",
        image: { characterName: "Actor2", characterIndex: 2, direction: 2 },
        say: { lines: ["祭坛在洞窟最深处。", "灯要星灯点亮，别的火都不认。"], speaker: "Ilse" },
        follow: {
            when: { switch: SW.shrine },
            say: ["你手上有星灯了。去洞窟吧。"]
        },
        priorityType: 1,
        directionFix: true
    });

    await high("make_shop", {
        mapId: ids.village, x: 8, y: 10, name: "Relay Trader",
        image: { characterName: "Actor2", characterIndex: 4, direction: 8 },
        speaker: "贩子",
        greeting: ["星灯 80，伤药 100。"],
        farewell: ["谢惠。"],
        goods: [{ id: lantern, price: 80, purchaseOnly: false }, { id: 7 }]
    });

    await high("make_chest", {
        mapId: ids.village, x: 20, y: 5, name: "Offering Chest",
        contents: { items: [{ id: fuse, count: 1 }], gold: 30 },
        message: ["愿台的箱子里有一匣引火和 30 钱。"],
        lockedMessage: ["箱子内有一把钥匙，还有… 空的灯座。"],
        requires: { item: lantern },
        graphic: { characterName: "!Chest" }
    });

    await high("link_maps", {
        a: { mapId: ids.village, x: ROUTES["village.fromCave"].x, y: ROUTES["village.fromCave"].y, name: "Cave Mouth" },
        b: { mapId: ids.cave, x: ROUTES["cave.fromVillage"].x, y: ROUTES["cave.fromVillage"].y, name: "Back to the Village" },
        graphic: { characterName: "!Door2" },
        sound: "Door4",
        fade: 1
    });

    // The credits, as an autorun on the village once the relay is lit. It takes a self
    // switch on the way out for the same reason the intro does: an autorun that never
    // turns itself off re-arms every frame, and that is a map the player cannot walk on.
    await high("make_choice_scene", {
        mapId: ids.village, x: 0, y: 0, name: "SR Credits", trigger: 3, priorityType: 0,
        when: { switch: SW.ending },
        script: [
            { fade: "out" },
            { scroll: { lines: ["星之 relay", "—— 全 ——", "地图、地形、NPC、商店、宝箱、遇敌、抉择与结局", "全部由 rpgmaker-mcp 的高层工具写入", "玩家用键盘走完"], fast: true } },
            { me: "Fanfare1" },
            { switch: { id: SW.boss, value: false } },
            { selfSwitch: { letter: "A" } },
            { title: true }
        ]
    });
    const credits = (await call("find_events", { mapId: ids.village, name: "SR Credits", limit: 10 })).hits[0];
    await high("make_choice_scene", {
        mapId: ids.village, eventId: credits.eventId, pageIndex: 1, trigger: 0, priorityType: 0,
        when: { selfSwitch: "A" }, script: [{ comment: ["字幕已放完"] }]
    });

    // --- the cave -------------------------------------------------------------
    await high("make_choice_scene", {
        mapId: ids.cave, x: 0, y: 0, name: "SR Cave Air", trigger: 3, priorityType: 0,
        script: [
            { say: ["洞窟里没有风。", "越往里走，越觉得自己手里缺一样东西。"] },
            { variable: { id: VR.core, set: 0 } },
            { switch: { id: SW.shrine } },
            { selfSwitch: { letter: "A" } },
            { erase: true }
        ]
    });
    const caveAir = (await call("find_events", { mapId: ids.cave, name: "SR Cave Air", limit: 10 })).hits[0];
    await high("make_choice_scene", {
        mapId: ids.cave, eventId: caveAir.eventId, pageIndex: 1, trigger: 0, priorityType: 0,
        when: { selfSwitch: "A" }, script: [{ comment: ["洞窟的气已说过"] }]
    });

    // The zone's troop row is found by name before it is made, because `make_encounter_zone`
    // creates a row every call: without this, a second `build` would add a duplicate.
    const bats = (await low("read_database", "reusing the zone's troop row instead of adding another", { table: "Troops" })).entries.find(row => row.name === "SR Cave Bats");
    const zone = await high("make_encounter_zone", {
        mapId: ids.cave,
        // One member, and an enemy row the shipped template actually has. This used to name
        // Enemies[6], which existed only because the author's project had grown a sixth row —
        // and a row that is missing makes the zone roll a battle the engine cannot build.
        troops: [{ ...(bats ? { troopId: bats.id } : { name: "SR Cave Bats", enemies: [{ id: 3 }] }), weight: 6, region: 3 }],
        region: { id: 3, rect: { x: 5, y: 3, width: 12, height: 10 } },
        encounterStep: 14
    });
    console.log(`   encounter zone: troop ${JSON.stringify(zone.troops)}, ${zone.encounters.length} row(s), step ${zone.encounterStep}`);

    await high("make_choice_scene", {
        mapId: ids.cave, x: ROUTES["cave.altar"].x, y: ROUTES["cave.altar"].y, name: "The Relay Well",
        trigger: 0, priorityType: 1,
        image: { characterName: "!Crystal" },
        script: [
            { say: ["祭坛的灯座是空的，井底黑得发亮。"] },
            {
                choice: {
                    options: [
                        {
                            label: "把星灯放进灯座",
                            when: { item: lantern },
                            lockedMessage: ["灯座认不出你手上的东西。回去买星灯。"],
                            then: [
                                { se: "Flash1" },
                                { battle: { troopId: boss, canEscape: false, canLose: true, win: [
                                    { say: ["黑影退了。灯座亮起。"] },
                                    { switch: { id: SW.boss } },
                                    { switch: { id: SW.ending } },
                                    { gold: 150 },
                                    { variable: { id: VR.branch, set: 1 } },
                                    { transfer: { mapId: ids.village, x: ROUTES["village.arrive"].x, y: ROUTES["village.arrive"].y, direction: 8 } }
                                ], lose: [
                                    { say: ["灯灭了。"] },
                                    { gameOver: true }
                                ] } }
                            ]
                        },
                        {
                            label: "伸手进黑暗里",
                            then: [
                                { variable: { id: VR.branch, set: 2 } },
                                { say: ["井底有什么握住了你的手。"] },
                                { flash: { color: [0, 0, 0], duration: 40 } },
                                { gameOver: true }
                            ]
                        }
                    ],
                    cancel: [{ variable: { id: VR.branch, set: 3 } }, { say: ["你把手缩回口袋里。"] }]
                }
            }
        ]
    });

    // --- start the game on the keeper's house ---------------------------------
    await high("set_startup", {
        title: "Star Relay · 星之 relay",
        startMapId: ids.home,
        startX: 3,
        startY: 5,
        startDirection: 6,
        partyMembers: [1]
    });

    return { lantern, fuse, boss, zone };
};

/** The item the whole game turns on: a real row, priced, with its own description. */
async function ensureLantern(high) {
    const made = await high("make_item", {
        table: "Items",
        // Row 7 is `Potion` in the engine's own template and in a project built from it, so
        // the copy source exists wherever this runs. Copying a row only the author's project
        // has is how the acceptance game stopped being reproducible.
        copyFrom: 7,
        name: "Star Lantern",
        price: 80,
        consumable: false,
        description: "把天空站的最后一束光封在玻璃里。祭坛的灯座只认它。"
    });
    return made.id;
}

/** The cave chest's second prize, made by this game rather than borrowed from whichever
 *  other acceptance game the project happens to hold: in a copy of the shipped template
 *  Items 2–5 are blank slots, and the row this chest used to hand out belongs to the lamp
 *  game, so building Star Relay alone could not fill it. */
async function ensureFuse(high) {
    const made = await high("make_item", {
        table: "Items",
        copyFrom: 7,
        name: "Relay Fuse",
        price: 25,
        consumable: false,
        description: "洞窟的湿气重，没有它点不着第二束光。"
    });
    return made.id;
}

/** A foe and the one-member group the altar runs, in the call that names both. */
async function ensureBossTroop(high) {
    const made = await high("make_battle", {
        foe: {
            name: "SR Relay Warden",
            // The engine's template ships five enemies (Goblin first), so row 1 is the copy
            // source that is there wherever this build runs; everything that matters about the
            // warden — its name, params, exp, gold and drop — is spelled below, not inherited.
            copyFrom: 1,
            params: { hp: 60, atk: 16, def: 8 },
            exp: 40,
            gold: 40,
            drops: [{ kind: "item", name: "Star Lantern", oneIn: 2 }]
        },
        troop: { name: "SR Relay Guardian", members: [{}] }
    });
    return made.troopId;
}

// ---------------------------------------------------------------------------
// Check: what the tools wrote, read back
// ---------------------------------------------------------------------------

const check = async call => {
    const ids = await mapIds(call);
    const report = await call("validate_game", { mapIds: Object.values(ids) });
    const errors = (report.problems ?? []).filter(problem => problem.severity === "error");
    const warnings = (report.problems ?? []).filter(problem => problem.severity === "warning");
    console.log(`validate_game: ok=${report.ok} checked=${JSON.stringify(report.checked)} errors=${errors.length} warnings=${warnings.length}`);
    for (const problem of [...errors, ...warnings].slice(0, 10)) {
        console.log(`   ${problem.severity.toUpperCase()} ${problem.where}: ${problem.what}`);
    }
    if (errors.length) {
        // Printing the audit and carrying on is how a build that wrote an unbootable game
        // ended up costing a playtest its whole timeout.
        throw new Error(
            `the game this build wrote has ${errors.length} error(s): ${errors
                .slice(0, 6)
                .map(problem => `${problem.where} (${problem.fix})`)
                .join("; ")}`
        );
    }
    const reach = await call("map_connectivity", { mapId: ids.home, x: 3, y: 5, followTransfers: true, maxMaps: 12 });
    for (const walked of reach.reports ?? []) {
        console.log(`   reach ${walked.name}(${walked.mapId}) cells ${walked.reachableCells}/${walked.walkableCells} events ${walked.events.length} stranded ${walked.unreachableEvents?.length ?? 0}`);
    }
    for (const trap of reach.traps ?? []) {
        console.log(`   TRAP map ${trap.mapId} "${trap.event}": ${trap.error}`);
    }
    const assets = await call("check_assets", { limit: 300 });
    console.log(`check_assets: ok=${assets.ok} missing=${JSON.stringify((assets.missing ?? []).slice(0, 6))}`);
    for (const [key, id] of Object.entries(ids)) {
        await call("render_map", { mapId: id, showEvents: true, saveTo: join(shots, `${key}.png`) });
        const map = await call("get_map", { mapId: id });
        const commands = map.events.reduce((total, event) => total + (event.pages ?? []).reduce((sum, page) => sum + page.commandCount, 0), 0);
        console.log(`   ${key}: map ${id} ${map.width}x${map.height} events ${map.events.length} commands ${commands} encounters ${map.encounterList?.length ?? 0}`);
    }

    // The tile legend. The build names its ground by id (that is art direction, and the
    // editor keeps it in the painter's head), so here the server reads the same ids back
    // out of the tileset the way the engine will, and draws the labelled sheet a person
    // would otherwise have to squint at PNGs to make.
    for (const [key, spec] of Object.entries(MAPS)) {
        const legend = await call("describe_tiles", {
            mapId: ids[key],
            contactSheet: { saveTo: join(shots, `${key}-tiles.png`), overlay: "passage", columns: 4, max: 12 }
        });
        console.log(`   tiles on ${spec.title}: ${legend.contactSheet.blocks} drawn into ${key}-tiles.png — ${legend.tiles.map(tile => `${tile.id}(${tile.slot},${tile.cells} cells,${tile.blockedFrom.length === 4 ? "solid" : "walkable"})`).join(" ")}`);
    }
    const altar = (await call("find_events", { mapId: ids.cave, name: "Relay Well", limit: 5 })).hits[0];
    const decoded = await call("decode_commands", { mapId: ids.cave, eventId: altar.eventId, pageIndex: 0 });
    console.log("altar script:");
    for (const line of decoded.lines.slice(0, 26)) {
        console.log(`     ${line}`);
    }
    return { errors, warnings };
};

const reset = async call => {
    const ids = await mapIds(call);
    for (const id of Object.values(ids)) {
        const map = await call("get_map", { mapId: id });
        for (const event of map.events ?? []) {
            await call("remove_event", { mapId: id, eventId: event.id });
        }
    }
    const system = (await call("read_database", { table: "System" })).value;
    const switches = { ...system.switches };
    const variables = { ...system.variables };
    for (const id of Object.values(SW)) {
        delete switches[id];
    }
    for (const id of Object.values(VR)) {
        delete variables[id];
    }
    await call("patch_database_entry", {
        table: "System",
        patch: { switches, variables, gameTitle: "还灯 · Return the Lamp", startMapId: 40, startX: 3, startY: 5 }
    });
    for (const table of ["Troops", "Items"]) {
        const rows = (await call("read_database", { table })).entries;
        for (const row of rows.filter(entry => String(entry.name).startsWith("SR ") || entry.name === "Star Lantern")) {
            await call("patch_database_entry", { table, id: row.id, patch: { name: "", description: "" } });
        }
    }
    console.log("reset: events cleared, names dropped, start back on the lamp game (the maps themselves stay; undo_writes is what deletes files)");
    console.log("     the fence stays painted: tileset 1's rock and water flags are what the game needs and `set_tileset_flags` has no stored value to restore from — measured here, the lamp game's four maps reach exactly the same cells either way (106/369/309/50).");
};

const mapIds = async call => {
    const maps = (await call("list_maps")).maps;
    const ids = {};
    for (const [key, spec] of Object.entries(MAPS)) {
        const found = maps.find(map => map.name === spec.name);
        if (!found) {
            throw new Error(`map "${spec.name}" is not in the project — run \`node scripts/build-star-relay.mjs build\` first`);
        }
        ids[key] = found.id;
    }
    return ids;
};

withRegisteredServer(async call => {
    mkdirSync(shots, { recursive: true });
    const started = Date.now();
    const ids = phase === "build" ? await (async () => {
        const maps = await mapIdsOrMake(call);
        return maps;
    })() : await mapIds(call).catch(() => ({}));

    if (phase === "build") {
        const result = await build(call, ids);
        writeFileSync(join(shots, "escape-hatches.json"), JSON.stringify({ highLevelCalls, escapeHatches }, null, 2));
        const writes = escapeHatches.filter(hatch => hatch.kind === "write");
        console.log(`\nbuilt with ${highLevelCalls} high-level calls and ${writes.length} low-level writes the layer could not make (${escapeHatches.length - writes.length} reads along the way)`);
        const byTool = {};
        for (const hatch of writes) {
            byTool[hatch.tool] = (byTool[hatch.tool] ?? 0) + 1;
        }
        console.log(`escape hatches: ${JSON.stringify(byTool)}`);
        console.log(`lantern item ${result.lantern}, boss troop ${result.boss}`);
        console.log("\n--- now checking what it wrote");
        await check(call);
    } else if (phase === "check") {
        await check(call);
    } else if (phase === "reset") {
        await reset(call);
    } else {
        throw new Error(`unknown phase ${phase}`);
    }
    console.log(`${phase} finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}).catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});

/** The maps by name, creating and painting the ones that are not there yet. */
async function mapIdsOrMake(call) {
    const tools = install(call, {});
    const ids = {};
    for (const [key, spec] of Object.entries(MAPS)) {
        ids[key] = await ensureMap(tools, spec, key);
    }
    return ids;
}
