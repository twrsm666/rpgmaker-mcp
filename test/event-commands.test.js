import nodeTest from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { testWork } from "../bin/local-config.js";
import { Project, makeEvent } from "../src/project.js";
import { showTextCommands, controlSwitchesCommands, controlSelfSwitchCommands, changeGoldCommands,
  changeItemsCommands, changeVariablesCommands, conditionalBranchCommands, moveRouteCommands,
  playAudioCommands, battleCommands, normalizeRawCommands, insertPageCommands,
  transferPlayerCommands, waitCommands, showChoicesCommands, inputNumberCommands, changePartyCommands,
  changeActorHpCommands, changeActorMpCommands, changeActorLevelCommands, changeActorStateCommands,
  recoverAllCommands, changeActorSkillCommands, changeActorImagesCommands, changeEnemyHpCommands,
  enemyAppearCommands, enemyTransformCommands, screenFadeCommands, tintScreenCommands, flashScreenCommands,
  shakeScreenCommands, weatherCommands, showAnimationCommands, setEventLocationCommands, showPictureCommands,
  movePictureCommands, erasePictureCommands, commentCommands, exitEventCommands, callCommonEventCommands,
  labelCommands, jumpToLabelCommands, nameInputCommands, shopCommands, controlTimerCommands,
  changeAccessCommands, eraseEventCommands } from "../src/event-commands.js";

const engine = process.env.RPG_MCP_ENGINE;
const work = testWork;
const test = (name, callback) => nodeTest(name, {
  skip: !engine ? "Local integration test: set RPG_MCP_ENGINE to a licensed MZ installation." : false
}, callback);
async function fixture() {
  await fs.mkdir(work, { recursive: true });
  const root = await fs.mkdtemp(path.join(work, "mz-events-"));
  const template = path.join(engine, "data", "newdata");
  await fs.mkdir(path.join(root, "data"));
  for (const file of ["System.json", "MapInfos.json", "Tilesets.json", "Map001.json"]) await fs.copyFile(path.join(template, "data", file), path.join(root, "data", file));
  const mapPath = path.join(root, "data", "Map001.json");
  const map = JSON.parse(await fs.readFile(mapPath, "utf8"));
  map.data.fill(0); map.events = [null];
  await fs.writeFile(mapPath, JSON.stringify(map));
  const project = await Project.open(root, engine);
  return { project, root };
}
const codes = list => list.map(command => command.code);

test("show text batches dialogue four lines per 101 block with MZ speaker parameter", () => {
  const commands = showTextCommands({ text: "1\n2\n3\n4\n5", speaker: "镇长", faceName: "People1", faceIndex: 2 });
  assert.deepEqual(codes(commands), [101, 401, 401, 401, 401, 101, 401]);
  assert.deepEqual(commands[0].parameters, ["People1", 2, 0, 2, "镇长"]);
  assert.deepEqual(commands[5].parameters, ["People1", 2, 0, 2, "镇长"]);
  assert.deepEqual(commands[1].parameters, ["1"]);
  assert.deepEqual(commands[6].parameters, ["5"]);
  assert.throws(() => showTextCommands({ text: "", speaker: "" }), /non-empty/);
  assert.throws(() => showTextCommands({ text: "hi", faceName: "../evil" }), /asset file name/);
});

test("switch, self-switch, gold and item builders use verified MZ parameter orders", () => {
  assert.deepEqual(controlSwitchesCommands({ switchId: 4, on: true })[0],
    { code: 121, indent: 0, parameters: [4, 4, 0] });
  assert.deepEqual(controlSwitchesCommands({ switchId: 2, endSwitchId: 5, on: false })[0].parameters, [2, 5, 1]);
  assert.deepEqual(controlSelfSwitchCommands({ character: "B", on: false })[0], { code: 123, indent: 0, parameters: ["B", 1] });
  assert.deepEqual(changeGoldCommands({ amount: 500 })[0], { code: 125, indent: 0, parameters: [0, 0, 500] });
  assert.deepEqual(changeGoldCommands({ amount: 500, increase: false })[0].parameters, [1, 0, 500]);
  assert.deepEqual(changeGoldCommands({ amount: 500, variableId: 7 })[0].parameters, [0, 1, 7]);
  assert.deepEqual(changeItemsCommands({ itemId: 12, amount: 3 })[0], { code: 126, indent: 0, parameters: [12, 0, 0, 3] });
  assert.deepEqual(changeItemsCommands({ kind: "weapon", itemId: 2, increase: false })[0], { code: 127, indent: 0, parameters: [2, 1, 0, 1] });
  assert.deepEqual(changeItemsCommands({ kind: "armor", itemId: 9 })[0], { code: 128, indent: 0, parameters: [9, 0, 0, 1] });
  assert.throws(() => controlSelfSwitchCommands({ character: "E", on: true }), /A, B, C or D/);
  assert.throws(() => changeGoldCommands({ amount: 0 }), /amount/);
});

test("variable builder covers constant, variable, random and script operands", () => {
  assert.deepEqual(changeVariablesCommands({ variableId: 3, operation: "add", operand: { type: "constant", value: 10 } })[0].parameters,
    [3, 3, 1, 0, 10]);
  assert.deepEqual(changeVariablesCommands({ variableId: 3, endVariableId: 5, operand: { type: "variable", value: 2 } })[0].parameters,
    [3, 5, 0, 1, 2]);
  assert.deepEqual(changeVariablesCommands({ variableId: 1, operand: { type: "random", value: 1, maxValue: 6 } })[0].parameters,
    [1, 1, 0, 2, 1, 6]);
  assert.deepEqual(changeVariablesCommands({ variableId: 1, operation: "mul", operand: { type: "script", value: "$gameParty.gold()" } })[0].parameters,
    [1, 1, 3, 4, "$gameParty.gold()"]);
  assert.throws(() => changeVariablesCommands({ variableId: 1, operand: { type: "gameData", value: 1 } }), /constant, variable, random or script/);
  assert.throws(() => changeVariablesCommands({ variableId: 5, endVariableId: 2, operand: { type: "constant", value: 1 } }), /endVariableId/);
});

test("conditional branch lays out 111/411/412 with indented branches", () => {
  const commands = conditionalBranchCommands({
    condition: { type: "switch", switchId: 8, on: true },
    thenCommands: [{ code: 126, parameters: [1, 0, 0, 1] }],
    elseCommands: [{ code: 125, parameters: [0, 0, 10] }, { code: 250, parameters: [{ name: "Item1" }] }]
  });
  assert.deepEqual(codes(commands), [111, 126, 411, 125, 250, 412]);
  assert.deepEqual(commands[0].parameters, [0, 8, 0]);
  assert.equal(commands[1].indent, 1);
  assert.equal(commands[2].indent, 0);
  assert.equal(commands[3].indent, 1);
  assert.equal(commands[5].indent, 0);
  const withoutElse = conditionalBranchCommands({ condition: { type: "item", itemId: 3 } });
  assert.deepEqual(codes(withoutElse), [111, 412]);
  assert.deepEqual(withoutElse[0].parameters, [8, 3]);
  const variable = conditionalBranchCommands({ condition: { type: "variable", variableId: 2, operator: ">=", operandVariableId: 3 } });
  assert.deepEqual(variable[0].parameters, [1, 2, 1, 3, 1]);
  const gold = conditionalBranchCommands({ condition: { type: "gold", amount: 100, test: "<" } });
  assert.deepEqual(gold[0].parameters, [7, 100, 2]);
  assert.throws(() => conditionalBranchCommands({ condition: { type: "warp" } }), /condition\.type/);
  assert.throws(() => conditionalBranchCommands({ condition: { type: "switch", switchId: 1 } }), /on must be a boolean/);
});

test("move route builds a 205 command whose route list matches Game_Character codes", () => {
  const [command] = moveRouteCommands({
    targetId: 0,
    repeat: true,
    steps: [{ move: "forward" }, { move: "turnRight90" }, { move: "jump", x: -2, y: 3 }, { move: "wait", frames: 30 },
      { move: "switchOn", switchId: 5 }, { move: "speed", value: 4 }, { move: "changeImage", characterName: "People1", characterIndex: 1 },
      { move: "playSe", name: "Item1" }, { move: "script", code: "this.requestBalloon(1)" }]
  });
  assert.equal(command.code, 205);
  // Engine character() encoding: -1 = player, 0 = this event.
  assert.equal(command.parameters[0], 0);
  const route = command.parameters[1];
  assert.equal(route.repeat, true);
  assert.equal(route.skippable, false);
  assert.equal(route.wait, false);
  assert.deepEqual(codes(route.list), [12, 20, 14, 15, 27, 29, 41, 44, 45, 0]);
  assert.deepEqual(route.list[2].parameters, [-2, 3]);
  assert.deepEqual(route.list[3].parameters, [30]);
  assert.deepEqual(route.list[5].parameters, [4]);
  assert.deepEqual(route.list[6].parameters, ["People1", 1]);
  assert.deepEqual(route.list[7].parameters, [{ name: "Item1", volume: 90, pitch: 100, pan: 0 }]);
  assert.deepEqual(route.list.at(-1), { code: 0, parameters: [] });
  // Defaults: target this event, no repeat loop (repeat:true + wait:true on
  // failing steps deadlocks the interpreter's route wait).
  const defaults = moveRouteCommands({ steps: [{ move: "turnTowardPlayer" }] })[0];
  assert.equal(defaults.parameters[0], 0);
  assert.equal(defaults.parameters[1].repeat, false);
  const playerRoute = moveRouteCommands({ targetId: -1, steps: [{ move: "forward" }] })[0];
  assert.equal(playerRoute.parameters[0], -1);
  assert.throws(() => moveRouteCommands({ steps: [{ move: "teleport" }] }), /unknown\. Valid moves/);
  assert.throws(() => moveRouteCommands({ steps: [{ move: "wait" }] }), /requires "frames"/);
  assert.throws(() => moveRouteCommands({ steps: [{ move: "speed", value: 9 }] }), /value/);
});

test("audio uses MZ codes: SE 250, ME 249, BGM 241, BGS 245", () => {
  assert.deepEqual(playAudioCommands({ name: "Item1" }), [{ code: 250, indent: 0, parameters: [{ name: "Item1", volume: 90, pitch: 100, pan: 0 }] }]);
  assert.equal(playAudioCommands({ kind: "me", name: "Victory1" })[0].code, 249);
  assert.equal(playAudioCommands({ kind: "bgm", name: "Theme1", volume: 70 })[0].code, 241);
  assert.equal(playAudioCommands({ kind: "bgs", name: "Wind1" })[0].code, 245);
  assert.throws(() => playAudioCommands({ kind: "noise", name: "x" }), /se, me, bgm or bgs/);
  assert.throws(() => playAudioCommands({ name: "a/b" }), /asset file name/);
  assert.throws(() => playAudioCommands({ name: "Item1", volume: 300 }), /volume/);
});

test("battle builds 301 plus optional win/escape/lose result branches", () => {
  const plain = battleCommands({ troopId: 3 });
  assert.deepEqual(plain, [{ code: 301, indent: 0, parameters: [0, 3, false, false] }]);
  assert.deepEqual(battleCommands({ type: "random" })[0].parameters, [2, 0, false, false]);
  assert.deepEqual(battleCommands({ type: "variable", variableId: 9, canEscape: true })[0].parameters, [1, 9, true, false]);
  const branched = battleCommands({
    troopId: 2, canEscape: true, canLose: true,
    onWin: [{ code: 125, parameters: [0, 0, 100] }],
    onEscape: [{ code: 121, parameters: [1, 1, 1] }],
    onLose: [{ code: 355, parameters: ["$gameVariables.setValue(1, 9)"] }]
  });
  assert.deepEqual(codes(branched), [301, 601, 125, 602, 121, 603, 355, 604]);
  assert.deepEqual(branched[1].parameters, []);
  assert.equal(branched[2].indent, 1);
  assert.equal(branched[3].indent, 0);
  assert.equal(branched[4].indent, 1);
  assert.equal(branched[6].indent, 1);
  assert.equal(branched[7].indent, 0);
  assert.throws(() => battleCommands({ troopId: 2, onEscape: [{ code: 121, parameters: [1, 1, 1] }] }), /canEscape: true/);
  assert.throws(() => battleCommands({ type: "direct" }), /troopId/);
});

test("raw command normalization rejects the code 0 terminator and defaults indent", () => {
  assert.deepEqual(normalizeRawCommands([{ code: 102, parameters: [["Yes", "No"]] }, { code: 402, parameters: [1, "Yes"] }]),
    [{ code: 102, indent: 0, parameters: [["Yes", "No"]] }, { code: 402, indent: 0, parameters: [1, "Yes"] }]);
  assert.throws(() => normalizeRawCommands([{ code: 0, parameters: [] }]), /terminator/);
  assert.deepEqual(normalizeRawCommands([{ code: 121 }]), [{ code: 121, indent: 0, parameters: [] }]);
  assert.throws(() => normalizeRawCommands("nope"), /must be an array/);
});

test("event tools append through project.edit: order, terminator and insertAt", async () => {
  const { project } = await fixture(), original = await project.read(1);
  await project.edit(1, original.revision, map => { map.events[1] = makeEvent({ id: 1, x: 3, y: 3, text: "欢迎。" }); }, "fixture");
  const revision = (await project.read(1)).revision;
  await project.edit(1, revision, map => {
    insertPageCommands(map, { eventId: 1, commands: battleCommands({ troopId: 1 }) });
    insertPageCommands(map, { eventId: 1, commands: controlSwitchesCommands({ switchId: 2, on: true }) });
    insertPageCommands(map, { eventId: 1, commands: playAudioCommands({ name: "Item1" }) });
  }, "event-tools");
  const { map } = await project.read(1);
  const list = map.events[1].pages[0].list;
  assert.deepEqual(codes(list), [101, 401, 301, 121, 250, 0]);
  await project.edit(1, (await project.read(1)).revision, map => {
    const info = insertPageCommands(map, { eventId: 1, at: 0, commands: showTextCommands({ text: "首先。" }) });
    assert.equal(info.insertAt, 0);
  }, "insert-at");
  const again = (await project.read(1)).map.events[1].pages[0].list;
  assert.deepEqual(codes(again), [101, 401, 101, 401, 301, 121, 250, 0]);
  assert.throws(() => insertPageCommands({ events: [null], width: 1, height: 1 }, { eventId: 1, commands: [] }), /does not exist/);
});

test("transfer, wait, comment and flow builders use verified MZ parameter orders", () => {
  assert.deepEqual(transferPlayerCommands({ mapId: 5, x: 9, y: 12, direction: 8 })[0],
    { code: 201, indent: 0, parameters: [0, 5, 9, 12, 8, 0] });
  assert.deepEqual(transferPlayerCommands({ mapId: 1, x: 0, y: 0, fade: 1 })[0].parameters, [0, 1, 0, 0, 0, 1]);
  assert.throws(() => transferPlayerCommands({ mapId: 1, x: 0, y: 0, direction: 3 }), /direction/);
  assert.deepEqual(waitCommands({ frames: 30 })[0], { code: 230, indent: 0, parameters: [30] });
  assert.deepEqual(exitEventCommands(), [{ code: 115, indent: 0, parameters: [] }]);
  assert.deepEqual(callCommonEventCommands({ commonEventId: 4 })[0], { code: 117, indent: 0, parameters: [4] });
  assert.deepEqual(labelCommands({ name: "循环" })[0], { code: 118, indent: 0, parameters: ["循环"] });
  assert.deepEqual(jumpToLabelCommands({ name: "循环" })[0], { code: 119, indent: 0, parameters: ["循环"] });
  assert.deepEqual(commentCommands({ text: "a\nb" }),
    [{ code: 108, indent: 0, parameters: ["a"] }, { code: 408, indent: 0, parameters: ["b"] }]);
  assert.throws(() => jumpToLabelCommands({ name: "" }), /1\.\.100/);
});

test("choices lay out 102 with the MZ five-parameter order plus 402/403 branches", () => {
  const choices = showChoicesCommands({
    choices: [{ text: "Yes", commands: [{ code: 125, parameters: [0, 0, 10] }] }, { text: "No" }],
    cancelType: -1, cancelCommands: [{ code: 250, parameters: [{ name: "Cancel1" }] }]
  });
  assert.deepEqual(codes(choices), [102, 402, 125, 402, 403, 250]);
  // MZ 1.8 reads [choices, cancelType, defaultType, positionType, background].
  assert.deepEqual(choices[0].parameters, [["Yes", "No"], -1, 0, 2, 0]);
  assert.deepEqual(choices[1].parameters, [0, "Yes"]);
  assert.equal(choices[2].indent, 1);
  assert.deepEqual(choices[3].parameters, [1, "No"]);
  assert.deepEqual(choices[4].parameters, []);
  assert.equal(choices[5].indent, 1);
  const choiceAsCancel = showChoicesCommands({ choices: [{ text: "a" }, { text: "b" }], cancelType: 1 });
  assert.deepEqual(codes(choiceAsCancel), [102, 402, 402]);
  assert.throws(() => showChoicesCommands({ choices: [{ text: "a" }], cancelType: 1 }), /cancelType/);
  assert.throws(() => showChoicesCommands({ choices: [{ text: "" }] }), /non-empty text/);
  assert.throws(() => showChoicesCommands({ choices: [] }), /1\.\.6/);
});

test("actor and enemy stat builders match iterateActorEx/operateValue layouts", () => {
  assert.deepEqual(changeActorHpCommands({ actorId: 2, operation: "decrease", value: 30, allowKnockout: true })[0],
    { code: 311, indent: 0, parameters: [0, 2, 1, 0, 30, 1] });
  assert.deepEqual(changeActorHpCommands({ entireParty: true, value: 50 })[0].parameters, [1, 0, 0, 0, 50, 0]);
  assert.deepEqual(changeActorHpCommands({ actorId: 1, valueVariableId: 4 })[0].parameters, [0, 1, 0, 1, 4, 0]);
  assert.deepEqual(changeActorMpCommands({ actorId: 3, operation: "decrease", value: 5 })[0],
    { code: 312, indent: 0, parameters: [0, 3, 1, 0, 5] });
  assert.deepEqual(changeActorLevelCommands({ actorId: 1, value: 2 })[0].parameters, [0, 1, 0, 0, 2, 1]);
  assert.deepEqual(changeActorStateCommands({ actorId: 1, add: false, stateId: 4 })[0],
    { code: 313, indent: 0, parameters: [0, 1, 1, 4] });
  assert.deepEqual(recoverAllCommands({ entireParty: true })[0], { code: 314, indent: 0, parameters: [1, 0] });
  assert.deepEqual(changeActorSkillCommands({ actorId: 2, skillId: 7 })[0].parameters, [0, 2, 0, 7]);
  assert.deepEqual(changeActorImagesCommands({ actorId: 1, characterName: "People2", characterIndex: 3 })[0],
    { code: 322, indent: 0, parameters: [1, "People2", 3, "", 0, ""] });
  assert.deepEqual(changePartyCommands({ actorId: 5, add: false })[0], { code: 129, indent: 0, parameters: [5, 1, 0] });
  assert.deepEqual(changeEnemyHpCommands({ troopMemberIndex: 1, value: 100 })[0],
    { code: 331, indent: 0, parameters: [1, 1, 0, 100, 1] });
  assert.deepEqual(enemyAppearCommands({ troopMemberIndex: 2 })[0], { code: 335, indent: 0, parameters: [2] });
  assert.deepEqual(enemyTransformCommands({ troopMemberIndex: 0, enemyId: 8 })[0], { code: 336, indent: 0, parameters: [0, 8] });
  assert.throws(() => changeActorHpCommands({ actorId: 1 }), /value must be an integer/);
  assert.throws(() => changeActorHpCommands({ actorId: 1, value: 5, operation: "halve" }), /increase or decrease/);
});

test("screen, weather, animation and picture builders match engine parameter orders", () => {
  assert.deepEqual(screenFadeCommands({ mode: "out" })[0], { code: 221, indent: 0, parameters: [] });
  assert.equal(screenFadeCommands({ mode: "in" })[0].code, 222);
  assert.throws(() => screenFadeCommands({ mode: "sideways" }), /mode/);
  assert.deepEqual(tintScreenCommands({ red: -68, gray: 68, frames: 30 })[0],
    { code: 223, indent: 0, parameters: [[-68, 0, 0, 68], 30, 0] });
  assert.deepEqual(flashScreenCommands({ frames: 20, wait: true })[0],
    { code: 224, indent: 0, parameters: [[255, 255, 255], 20, 1] });
  assert.deepEqual(shakeScreenCommands({ power: 8, speed: 2, frames: 45, wait: true })[0],
    { code: 225, indent: 0, parameters: [8, 2, 45, 1] });
  assert.deepEqual(weatherCommands({ type: "storm", power: 8 })[0], { code: 236, indent: 0, parameters: [2, 8, 60, 0] });
  assert.throws(() => weatherCommands({ type: "sandstorm" }), /none, rain, storm or snow/);
  assert.deepEqual(showAnimationCommands({ targetId: -1, animationId: 42, wait: true })[0],
    { code: 212, indent: 0, parameters: [-1, 42, 1] });
  assert.deepEqual(setEventLocationCommands({ targetId: 3, x: 8, y: 9, direction: 6 })[0],
    { code: 203, indent: 0, parameters: [3, 0, 8, 9, 6] });
  assert.deepEqual(showPictureCommands({ number: 2, imageName: "Portal", x: 408, y: 312 })[0],
    { code: 231, indent: 0, parameters: [2, "Portal", 1, 0, 408, 312, 100, 100, 255, 0] });
  assert.deepEqual(movePictureCommands({ number: 2, x: 100, y: 50, frames: 45, wait: true, easing: 2 })[0],
    { code: 232, indent: 0, parameters: [2, 0, 1, 0, 100, 50, 100, 100, 255, 0, 45, 1, 2] });
  assert.deepEqual(erasePictureCommands({ number: 2 })[0], { code: 235, indent: 0, parameters: [2] });
  assert.throws(() => showPictureCommands({ number: 1, imageName: "a/b", x: 0, y: 0 }), /asset file name/);
});

test("shop, timer, access, input-number and name-input builders use MZ 1.8 layouts", () => {
  const shop = shopCommands({ goods: [{ kind: "item", id: 1 }, { kind: "weapon", id: 2, price: 120 }], purchaseOnly: true });
  assert.deepEqual(codes(shop), [302, 605]);
  // Scene_Shop.prepare reads the purchase-only flag from 302 params[4].
  assert.deepEqual(shop[0].parameters, [0, 1, 0, 0, 1]);
  assert.deepEqual(shop[1].parameters, [1, 2, 120, 0]);
  assert.throws(() => shopCommands({ goods: [{ kind: "vehicle", id: 1 }] }), /item, weapon or armor/);
  assert.deepEqual(inputNumberCommands({ variableId: 3, maxDigits: 4 })[0], { code: 103, indent: 0, parameters: [3, 4] });
  assert.deepEqual(nameInputCommands({ actorId: 1 })[0], { code: 303, indent: 0, parameters: [1, 8] });
  assert.deepEqual(controlTimerCommands({ mode: "start", seconds: 90 })[0], { code: 124, indent: 0, parameters: [0, 90] });
  assert.deepEqual(controlTimerCommands({ mode: "stop" })[0], { code: 124, indent: 0, parameters: [1, 0] });
  assert.throws(() => controlTimerCommands({ mode: "start", seconds: 0 }), />= 1/);
  assert.deepEqual(changeAccessCommands({ save: false, encounters: true }),
    [{ code: 134, indent: 0, parameters: [0] }, { code: 136, indent: 0, parameters: [1] }]);
  assert.throws(() => changeAccessCommands({}), /at least one/);
});

// MV used 115 for erase; MZ uses 214 and 115 became Abort Event. Getting these
// confused leaves a one-shot chest standing in the world after it pays out.
test("erase event is MZ 214 and stays distinct from abort event 115", () => {
  assert.deepEqual(eraseEventCommands(), [{ code: 214, indent: 0, parameters: [] }]);
  assert.deepEqual(exitEventCommands(), [{ code: 115, indent: 0, parameters: [] }]);
});

test("project open repairs the newdata System.json windowOpacity omission", async () => {
  const { project, root } = await fixture();
  const system = JSON.parse(await fs.readFile(path.join(root, "data", "System.json"), "utf8"));
  assert.equal(system.advanced.windowOpacity, 192);
  const info = await project.info();
  assert.equal(info.systemRepair.field, "advanced.windowOpacity");
  const reopened = await Project.open(root, process.env.RPG_MCP_ENGINE);
  assert.equal(reopened.systemRepair, null);
});
