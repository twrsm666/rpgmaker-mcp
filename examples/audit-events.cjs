// 用法: node audit-events.cjs <RPG-MZ项目目录>
// 事件全面审计：贴图/音频/动画/物品/敌人/传送目标/开关翻页保护
const fs = require("fs");
const path = require("path");
const root = path.resolve(process.argv[2] || ".");
const dataDir = path.join(root, "data");
const problems = [];
const note = (severity, file, evId, evName, page, cmdIndex, what) =>
  problems.push({ severity, where: `${file} ev${evId}(${evName}) p${page} cmd${cmdIndex}`, what });

const existsAny = (dir, base, exts) => exts.some(ext => fs.existsSync(path.join(root, dir, base + ext)));
const charOk = name => existsAny("img/characters", name, [".png"]);
const faceOk = name => existsAny("img/faces", name, [".png"]);
const enemyOk = name => existsAny("img/enemies", name, [".png"]);
const picOk = name => existsAny("img/pictures", name, [".png"]);
const animOk = name => existsAny("img/animations", name, [".png"]);
const audioOk = (kind, name) => existsAny(path.join("audio", kind), name, [".ogg", ".wav"]);

const load = f => JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf8"));
const system = load("System.json");
const states = load("States.json");
const actors = load("Actors.json"), items = load("Items.json"), weapons = load("Weapons.json"),
  armors = load("Armors.json"), skills = load("Skills.json"), enemies = load("Enemies.json"),
  troops = load("Troops.json"), animations = load("Animations.json");
const mapFiles = fs.readdirSync(dataDir).filter(f => /^Map\d+\.json$/.test(f));
const maps = {};
for (const f of mapFiles) maps[f] = load(f);
const mapById = id => maps["Map" + String(id).padStart(3, "0") + ".json"];
const good = (arr, id) => id >= 0 && id < arr.length && arr[id] != null;

// --- whole Animations.json: image files must exist (动画是否存在) ---
for (const an of animations) {
  if (!an) continue;
  for (const key of ["animation1Name", "animation2Name"]) {
    if (an[key] && !animOk(an[key])) problems.push({ severity: "FATAL", where: `Animations.json id${an.id}`, what: `${key}=${an[key]}.png 缺失（会 LoadError 卡死场景）` });
  }
}
// --- Troops: enemy ids + battler images ---
for (const troop of troops) {
  if (!troop) continue;
  for (const member of troop.members || []) {
    const enemy = enemies[member.enemyId];
    if (!enemy) { problems.push({ severity: "FATAL", where: `Troops id${troop.id}`, what: `enemyId ${member.enemyId} 不存在` }); continue; }
    if (enemy.battlerName && !enemyOk(enemy.battlerName)) problems.push({ severity: "FATAL", where: `Enemies id${enemy.id}`, what: `battlerName ${enemy.battlerName}.png 缺失` });
  }
}

const validRouteCodes = new Set([0, ...Array.from({ length: 39 }, (_, i) => i + 1), 41, 42, 43, 44, 45]);

function checkCommands(file, ev, pageIndex, page, list) {
  (list || []).forEach((cmd, index) => {
    const at = `cmd${index}`;
    const p = cmd.parameters || [];
    switch (cmd.code) {
      case 101:
        if (p[0] && !faceOk(p[0])) note("FATAL", file, ev.id, ev.name, pageIndex, index, `脸图 img/faces/${p[0]}.png 缺失`);
        break;
      case 103: case 121: case 122: {
        const maxId = cmd.code === 121 ? system.switches.length : system.variables.length;
        if (p[1] >= maxId) note("WARN", file, ev.id, ev.name, pageIndex, index, `ID ${p[0]}-${p[1]} 超出 System.json ${cmd.code === 121 ? "switches" : "variables"} 数量 ${maxId}`);
        break;
      }
      case 126: if (!good(items, p[0])) note("FATAL", file, ev.id, ev.name, pageIndex, index, `物品 ${p[0]} 不存在`); break;
      case 127: if (!good(weapons, p[0])) note("FATAL", file, ev.id, ev.name, pageIndex, index, `武器 ${p[0]} 不存在`); break;
      case 128: if (!good(armors, p[0])) note("FATAL", file, ev.id, ev.name, pageIndex, index, `防具 ${p[0]} 不存在`); break;
      case 129: case 303: case 318:
        if (cmd.code === 318 ? p[0] === 0 && !good(actors, p[1]) : !good(actors, p[0]))
          note("FATAL", file, ev.id, ev.name, pageIndex, index, `角色 ${cmd.code === 318 ? p[1] : p[0]} 不存在`);
        if (cmd.code === 318 && !good(skills, p[3])) note("FATAL", file, ev.id, ev.name, pageIndex, index, `技能 ${p[3]} 不存在`);
        break;
      case 132: case 132 + 109: break;
      case 135: case 136: case 137: case 134: break;
      case 201: {
        const target = mapById(p[1]);
        if (!target) { note("FATAL", file, ev.id, ev.name, pageIndex, index, `传送目标 Map${p[1]} 不存在`); break; }
        if (p[2] < 0 || p[2] >= target.width || p[3] < 0 || p[3] >= target.height)
          note("FATAL", file, ev.id, ev.name, pageIndex, index, `传送坐标 ${p[2]},${p[3]} 超出 Map${p[1]} (${target.width}x${target.height})`);
        break;
      }
      case 205: {
        const route = p[1] || {};
        if (p[0] !== -1 && p[0] !== 0 && !(p[0] >= 1 && p[0] < (mapById(file.match(/\d+/)[0])?.events.length ?? 0)))
          note("WARN", file, ev.id, ev.name, pageIndex, index, `移动路线 targetId ${p[0]}（本图无此事件）`);
        if (route.repeat && route.wait) note("WARN", file, ev.id, ev.name, pageIndex, index, "repeat:true + wait:true —— 步骤失败会死锁解释器（阿尔伯特卡死同款）");
        for (const step of route.list || []) {
          if (!validRouteCodes.has(step.code)) note("FATAL", file, ev.id, ev.name, pageIndex, index, `移动路线未知指令码 ${step.code}`);
          if (step.code === 41 && step.parameters[0] && !charOk(step.parameters[0]))
            note("FATAL", file, ev.id, ev.name, pageIndex, index, `移动路线换装图 ${step.parameters[0]}.png 缺失`);
          if ((step.code === 26 || step.code === 27) && step.parameters[0] >= system.switches.length)
            note("FATAL", file, ev.id, ev.name, pageIndex, index, `路线开关 ${step.parameters[0]} 超界`);
          if (step.code === 44 && step.parameters[0]?.name && !audioOk("se", step.parameters[0].name))
            note("FATAL", file, ev.id, ev.name, pageIndex, index, `路线SE ${step.parameters[0].name} 缺失`);
        }
        break;
      }
      case 212: if (!good(animations, p[1])) note("FATAL", file, ev.id, ev.name, pageIndex, index, `动画 ${p[1]} 不存在于 Animations.json`); break;
      case 231: case 232:
        if (cmd.code === 231 && p[1] && !picOk(p[1])) note("FATAL", file, ev.id, ev.name, pageIndex, index, `图片 img/pictures/${p[1]}.png 缺失`);
        break;
      case 241: if (p[0]?.name && !audioOk("bgm", p[0].name)) note("WARN", file, ev.id, ev.name, pageIndex, index, `BGM ${p[0].name} 缺失`); break;
      case 245: if (p[0]?.name && !audioOk("bgs", p[0].name)) note("WARN", file, ev.id, ev.name, pageIndex, index, `BGS ${p[0].name} 缺失`); break;
      case 249: if (p[0]?.name && !audioOk("me", p[0].name)) note("WARN", file, ev.id, ev.name, pageIndex, index, `ME ${p[0].name} 缺失`); break;
      case 250: if (p[0]?.name && !audioOk("se", p[0].name)) note("FATAL", file, ev.id, ev.name, pageIndex, index, `SE ${p[0].name} 缺失`); break;
      case 301: {
        if (!good(troops, p[1])) { note("FATAL", file, ev.id, ev.name, pageIndex, index, `敌群 ${p[1]} 不存在`); break; }
        const hasBranch = list.some(c => [601, 602, 603].includes(c.code));
        if (!hasBranch) note("WARN", file, ev.id, ev.name, pageIndex, index, "战斗处理缺少 601/602/603 结果分支");
        break;
      }
      case 302: {
        const rows = [cmd];
        for (let k = index + 1; list[k] && list[k].code === 605; k++) rows.push(list[k]);
        for (const row of rows) {
          const kindName = ["item", "weapon", "armor"][row.parameters[0]];
          const table = { item: items, weapon: weapons, armor: armors }[kindName];
          if (table && !good(table, row.parameters[1])) note("FATAL", file, ev.id, ev.name, pageIndex, index, `商品 ${kindName} ${row.parameters[1]} 不存在`);
        }
        break;
      }
      case 311: case 312: case 313: case 314: case 316: case 317: {
        const actorRef = p[0] === 0 ? p[1] : 1;
        if (cmd.code !== 314 && !good(actors, actorRef)) note("FATAL", file, ev.id, ev.name, pageIndex, index, `角色 ${actorRef} 不存在`);
        if (cmd.code === 313 && !good(states, p[3])) note("FATAL", file, ev.id, ev.name, pageIndex, index, `状态 ${p[3]} 不存在`);
        break;
      }
      case 322: {
        if (p[1] && !charOk(p[1])) note("FATAL", file, ev.id, ev.name, pageIndex, index, `322 行走图 ${p[1]}.png 缺失`);
        if (p[3] && !faceOk(p[3])) note("FATAL", file, ev.id, ev.name, pageIndex, index, `322 脸图 ${p[3]}.png 缺失`);
        if (p[5] && !enemyOk(p[5])) note("FATAL", file, ev.id, ev.name, pageIndex, index, `322 战斗图 ${p[5]}.png 缺失`);
        break;
      }
      case 331: case 335: case 336:
        if (cmd.code === 336 && !good(enemies, p[1])) note("FATAL", file, ev.id, ev.name, pageIndex, index, `变身敌人 ${p[1]} 不存在`);
        break;
      default:
        if (cmd.code >= 1 && cmd.code <= 655 && ![0, 101, 102, 105, 108, 111, 115, 117, 118, 119, 121, 122, 123, 124, 125, 126, 127, 128, 129, 132, 133, 134, 135, 136, 137, 138, 139, 140, 201, 205, 212, 221, 222, 223, 224, 225, 230, 231, 232, 233, 235, 236, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 261, 301, 302, 303, 311, 312, 313, 314, 315, 316, 317, 318, 103, 104, 105, 320, 321, 322, 323, 324, 325, 326, 331, 332, 333, 334, 335, 336, 337, 338, 339, 340, 355, 401, 402, 403, 404, 405, 408, 411, 412, 601, 602, 603, 604, 605, 655].includes(cmd.code))
          note("WARN", file, ev.id, ev.name, pageIndex, index, `未审计的指令码 ${cmd.code}`);
    }
  });
}

for (const file of mapFiles) {
  const map = maps[file];
  for (const ev of map.events || []) {
    if (!ev) continue;
    (ev.pages || []).forEach((page, pageIndex) => {
      const img = page.image || {};
      if (img.characterName && !charOk(img.characterName))
        note("FATAL", file, ev.id, ev.name, pageIndex, -1, `行走图 img/characters/${img.characterName}.png 缺失（LoadError 卡死场景）`);
      if (page.conditions.switch1Valid && page.conditions.switch1Id >= system.switches.length)
        note("FATAL", file, ev.id, ev.name, pageIndex, -1, `页面条件开关 ${page.conditions.switch1Id} 超界`);
      checkCommands(file, ev, pageIndex, page, page.list);
      // 出场时移动路线 page.moveRoute 由 moveType 驱动，moveType=0 时不执行
    });
    // 无限重复触发检测：事件在某页发放资源（金币/物品/装备/升级/入队等），
    // 但整个事件没有任何"设标记→有页面以该标记为条件"的翻页保护
    const setFlags = new Set();
    for (const page of ev.pages || []) for (const cmd of page.list) {
      if (cmd.code === 123 && cmd.parameters[1] === 0) setFlags.add("S:" + cmd.parameters[0]);
      if (cmd.code === 121 && cmd.parameters[2] === 0)
        for (let id = cmd.parameters[0]; id <= cmd.parameters[1]; id++) setFlags.add("W:" + id);
    }
    const gateFlags = new Set();
    for (const page of ev.pages || []) {
      if (page.conditions.selfSwitchValid) gateFlags.add("S:" + page.conditions.selfSwitchCh);
      if (page.conditions.switch1Valid) gateFlags.add("W:" + page.conditions.switch1Id);
      if (page.conditions.switch2Valid) gateFlags.add("W:" + page.conditions.switch2Id);
    }
    const protectedByGate = [...setFlags].some(flag => gateFlags.has(flag));
    if (!protectedByGate) {
      // 只把"增益"算作可刷资源：伤害型 311/312/313（扣血/扣MP/加减益状态）可重复是正确设计
      const opIndex = { 125: 0, 126: 1, 127: 1, 128: 1, 129: 1, 311: 2, 312: 2, 316: 2, 317: 2, 318: 2 };
      const isGain = cmd => {
        if (cmd.code === 313) return false;
        const at = opIndex[cmd.code];
        if (at === undefined) return false;
        return cmd.parameters[at] === 0;
      };
      (ev.pages || []).forEach((page, pageIndex) => {
        for (const cmd of page.list) {
          if (isGain(cmd)) {
            note("BUG", file, ev.id, ev.name, pageIndex, -1,
              `无翻页保护却发放资源（指令 ${cmd.code}）→ 可无限重复获取（残箱同款）`);
            break;
          }
        }
      });
    }
    // 设了标记但没有任何页面用它做条件 → 提示（若事件同时无保护则已由上面报 BUG）
    (ev.pages || []).forEach((page, pageIndex) => {
      for (const cmd of page.list) {
        const setsSelf = cmd.code === 123 && cmd.parameters[1] === 0;
        const setsSwitch = cmd.code === 121 && cmd.parameters[2] === 0;
        if (!setsSelf && !setsSwitch) continue;
        const used = (ev.pages || []).some(p => setsSelf
          ? p.conditions.selfSwitchValid && p.conditions.selfSwitchCh === cmd.parameters[0]
          : p.conditions.switch1Valid && p.conditions.switch1Id === cmd.parameters[0]);
        if (!used) note("INFO", file, ev.id, ev.name, pageIndex, -1,
          `设置${setsSelf ? "自开关 " + cmd.parameters[0] : "开关 " + cmd.parameters[0]}=ON 但没有页面以它为条件（若已有其他翻页保护则仅为冗余演示）`);
      }
    });
  }
}

const fatal = problems.filter(p => p.severity === "FATAL");
const bug = problems.filter(p => p.severity === "BUG");
const warn = problems.filter(p => p.severity === "WARN");
for (const p of [...fatal, ...bug, ...warn]) console.log(`[${p.severity}] ${p.where}: ${p.what}`);
console.log(`\n总计 FATAL=${fatal.length} BUG=${bug.length} WARN=${warn.length}`);
