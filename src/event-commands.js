import { z } from "zod";
import { integer } from "./project.js";

// MZ event command builders behind the event_* tools. Codes and parameter
// orders are verified against the licensed local MZ 1.8.x corescript
// (Game_Interpreter / Game_Character in rmmz_objects.js). MZ renumbered audio
// against MV: Play SE is 250 and Play ME is 249. Switch/self-switch encoding
// is inverted from the UI: 0 means ON and 1 means OFF.

const NAME_PATTERN = /^[^/\\:\0]+$/;
const int = (value, label, min, max) => {
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return integer(value, label, min, max);
};
const indented = (commands, delta) => commands.map(command => ({ ...command, indent: command.indent + delta }));

export function normalizeRawCommands(commands, label = "commands") {
  if (!Array.isArray(commands)) throw new Error(`${label} must be an array of MZ commands`);
  return commands.map((command, index) => {
    if (!command || typeof command !== "object" || Array.isArray(command))
      throw new Error(`${label}[${index}] must be an object {code, indent?, parameters}`);
    if (!Number.isInteger(command.code) || command.code < 1 || command.code > 999)
      throw new Error(`${label}[${index}].code must be integer 1..999; the code 0 terminator is added automatically`);
    if (command.indent !== undefined) int(command.indent, `${label}[${index}].indent`, 0, 100);
    if (command.parameters !== undefined && !Array.isArray(command.parameters))
      throw new Error(`${label}[${index}].parameters must be an array`);
    return { code: command.code, indent: command.indent ?? 0, parameters: structuredClone(command.parameters ?? []) };
  });
}

// Show Text: [faceName, faceIndex, background, position, speakerName] + 401 lines.
export function showTextCommands({ text, speaker = "", faceName = "", faceIndex = 0, background = 0, position = 2 }) {
  if (typeof text !== "string" || !text.length) throw new Error("text must be a non-empty string");
  if (typeof speaker !== "string" || speaker.length > 64) throw new Error("speaker must be a string of at most 64 characters");
  if (typeof faceName !== "string" || (faceName && !NAME_PATTERN.test(faceName)))
    throw new Error("face.name must be an asset file name without path separators");
  int(faceIndex, "face.index", 0, 7);
  int(background, "background", 0, 2);
  int(position, "position", 0, 2);
  const commands = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 4) {
    commands.push({ code: 101, indent: 0, parameters: [faceName, faceIndex, background, position, speaker] });
    for (const line of lines.slice(i, i + 4)) commands.push({ code: 401, indent: 0, parameters: [line] });
  }
  return commands;
}

// Control Switches: [startId, endId, value] with value 0 = ON, 1 = OFF.
export function controlSwitchesCommands({ switchId, endSwitchId = switchId, on }) {
  int(switchId, "switchId", 1, 9999);
  int(endSwitchId, "endSwitchId", 1, 9999);
  if (endSwitchId < switchId) throw new Error("endSwitchId must be >= switchId");
  if (typeof on !== "boolean") throw new Error("on must be a boolean (true = ON)");
  return [{ code: 121, indent: 0, parameters: [switchId, endSwitchId, on ? 0 : 1] }];
}

// Control Self Switches: [character, value]. At runtime this always targets
// the event executing the command; MZ has no event-id parameter here.
export function controlSelfSwitchCommands({ character = "A", on }) {
  if (!["A", "B", "C", "D"].includes(character)) throw new Error("character must be A, B, C or D");
  if (typeof on !== "boolean") throw new Error("on must be a boolean (true = ON)");
  return [{ code: 123, indent: 0, parameters: [character, on ? 0 : 1] }];
}

// Change Gold: [operation, operandType, operand]; operation 0 = increase, 1 = decrease.
export function changeGoldCommands({ amount, increase = true, variableId }) {
  int(amount, "amount", 1, 99999999);
  if (variableId !== undefined) int(variableId, "variableId", 1, 9999);
  return [{ code: 125, indent: 0, parameters: [increase ? 0 : 1, variableId === undefined ? 0 : 1, variableId ?? amount] }];
}

const ITEM_CODES = { item: 126, weapon: 127, armor: 128 };
// Change Items/Weapons/Armors: [id, operation, operandType, operand].
export function changeItemsCommands({ kind = "item", itemId, amount = 1, increase = true, variableId }) {
  const code = ITEM_CODES[kind];
  if (!code) throw new Error("kind must be item, weapon or armor");
  int(itemId, "itemId", 1, 9999);
  int(amount, "amount", 1, 9999);
  if (variableId !== undefined) int(variableId, "variableId", 1, 9999);
  return [{ code, indent: 0, parameters: [itemId, increase ? 0 : 1, variableId === undefined ? 0 : 1, variableId ?? amount] }];
}

const VARIABLE_OPERATIONS = { set: 0, add: 1, sub: 2, mul: 3, div: 4, mod: 5 };
const VARIABLE_OPERANDS = { constant: 0, variable: 1, random: 2, script: 4 };
// Change Variables: [startId, endId, operation, operandType, ...operand values].
export function changeVariablesCommands({ variableId, endVariableId = variableId, operation = "set", operand }) {
  int(variableId, "variableId", 1, 9999);
  int(endVariableId, "endVariableId", 1, 9999);
  if (endVariableId < variableId) throw new Error("endVariableId must be >= variableId");
  const operationType = VARIABLE_OPERATIONS[operation];
  if (operationType === undefined) throw new Error("operation must be one of set, add, sub, mul, div, mod");
  if (!operand || typeof operand !== "object" || Array.isArray(operand)) throw new Error("operand {type, value} is required");
  const operandType = VARIABLE_OPERANDS[operand.type];
  if (operandType === undefined)
    throw new Error("operand.type must be constant, variable, random or script (game data operands need event_raw_commands)");
  const parameters = [variableId, endVariableId, operationType, operandType];
  if (operand.type === "random") {
    int(operand.value, "operand.value", 0, 99999999);
    int(operand.maxValue, "operand.maxValue", 0, 99999999);
    if (operand.maxValue < operand.value) throw new Error("operand.maxValue must be >= operand.value");
    parameters.push(operand.value, operand.maxValue);
  } else if (operand.type === "variable") {
    int(operand.value, "operand.value", 1, 9999);
    parameters.push(operand.value);
  } else if (operand.type === "script") {
    if (typeof operand.value !== "string" || !operand.value.length) throw new Error("operand.value must be JavaScript code for script operands");
    parameters.push(operand.value);
  } else {
    if (!Number.isInteger(operand.value)) throw new Error("operand.value must be an integer for constant operands");
    int(operand.value, "operand.value", -99999999, 99999999);
    parameters.push(operand.value);
  }
  return [{ code: 122, indent: 0, parameters }];
}

const BRANCH_OPERATORS = { "==": 0, ">=": 1, "<=": 2, ">": 3, "<": 4, "!=": 5 };
const ACTOR_TESTS = { inParty: 0, name: 1, class: 2, skill: 3, weapon: 4, armor: 5, state: 6 };
const BUTTON_STATES = { pressed: 0, triggered: 1, repeated: 2 };

function branchParameters(condition) {
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) throw new Error("condition must be an object");
  const needs = (field, min, max) => {
    if (condition[field] === undefined) throw new Error(`condition.${field} is required for condition.type "${condition.type}"`);
    return int(condition[field], `condition.${field}`, min, max);
  };
  const requireBoolean = field => {
    if (typeof condition[field] !== "boolean") throw new Error(`condition.${field} must be a boolean`);
    return condition[field];
  };
  switch (condition.type) {
    case "switch":
      return [0, needs("switchId", 1, 9999), requireBoolean("on") ? 0 : 1];
    case "variable": {
      const id = needs("variableId", 1, 9999);
      const operator = BRANCH_OPERATORS[condition.operator];
      if (operator === undefined) throw new Error("condition.operator must be ==, >=, <=, >, < or !=");
      if (condition.operandVariableId !== undefined) {
        int(condition.operandVariableId, "condition.operandVariableId", 1, 9999);
        return [1, id, 1, condition.operandVariableId, operator];
      }
      if (!Number.isInteger(condition.value)) throw new Error("condition.value must be an integer (or set condition.operandVariableId)");
      int(condition.value, "condition.value", -99999999, 99999999);
      return [1, id, 0, condition.value, operator];
    }
    case "selfSwitch":
      if (!["A", "B", "C", "D"].includes(condition.character)) throw new Error("condition.character must be A, B, C or D");
      return [2, condition.character, requireBoolean("on") ? 0 : 1];
    case "timer":
      if (![">=", "<="].includes(condition.test)) throw new Error("condition.test must be >= or <=");
      return [3, needs("seconds", 1, 359999), condition.test === "<=" ? 1 : 0];
    case "actor": {
      const test = ACTOR_TESTS[condition.test];
      if (test === undefined) throw new Error("condition.test must be one of inParty, name, class, skill, weapon, armor, state");
      const id = needs("actorId", 1, 9999);
      if (test === 0) return [4, id, 0, 0];
      if (test === 1) {
        if (typeof condition.value !== "string") throw new Error("condition.value must be the actor name for test name");
        return [4, id, 1, condition.value];
      }
      return [4, id, test, needs("value", 1, 9999)];
    }
    case "enemy": {
      const index = needs("troopMemberIndex", 0, 7);
      if (condition.test === "appeared") return [5, index, 0, 0];
      if (condition.test === "state") return [5, index, 1, needs("stateId", 1, 9999)];
      throw new Error("condition.test must be appeared or state");
    }
    case "character":
      if (![2, 4, 6, 8].includes(condition.direction)) throw new Error("condition.direction must be 2, 4, 6 or 8");
      return [6, needs("characterId", -1, 9999), condition.direction];
    case "gold":
      if (![">=", "<=", "<"].includes(condition.test)) throw new Error("condition.test must be >=, <= or <");
      return [7, needs("amount", 0, 99999999), [">=", "<=", "<"].indexOf(condition.test)];
    case "item":
      return [8, needs("itemId", 1, 9999)];
    case "weapon":
      return [9, needs("weaponId", 1, 9999), requireBoolean("includeEquipped") ? 1 : 0];
    case "armor":
      return [10, needs("armorId", 1, 9999), requireBoolean("includeEquipped") ? 1 : 0];
    case "button": {
      if (typeof condition.button !== "string" || !condition.button.length)
        throw new Error("condition.button must be a button name such as ok, cancel, up, down, left, right, shift, control, pageup, pagedown");
      const state = BUTTON_STATES[condition.state ?? "pressed"];
      if (state === undefined) throw new Error("condition.state must be pressed, triggered or repeated");
      return [11, condition.button, state];
    }
    case "script":
      if (typeof condition.code !== "string" || !condition.code.length) throw new Error("condition.code must be JavaScript for script conditions");
      return [12, condition.code];
    case "vehicle":
      return [13, needs("vehicleId", 0, 2)];
    default:
      throw new Error('condition.type must be one of switch, variable, selfSwitch, timer, actor, enemy, character, gold, item, weapon, armor, button, script, vehicle');
  }
}

// Conditional Branch: 111 + indented "then" commands + 411 + "else" + 412.
export function conditionalBranchCommands({ condition, thenCommands = [], elseCommands = [] }) {
  const then = normalizeRawCommands(thenCommands, "thenCommands");
  const otherwise = normalizeRawCommands(elseCommands, "elseCommands");
  const commands = [{ code: 111, indent: 0, parameters: branchParameters(condition) }, ...indented(then, 1)];
  if (otherwise.length) commands.push({ code: 411, indent: 0, parameters: [] }, ...indented(otherwise, 1));
  commands.push({ code: 412, indent: 0, parameters: [] });
  return commands;
}

const MOVE_ROUTE = {
  down: { code: 1 }, left: { code: 2 }, right: { code: 3 }, up: { code: 4 },
  lowerLeft: { code: 5 }, lowerRight: { code: 6 }, upperLeft: { code: 7 }, upperRight: { code: 8 },
  random: { code: 9 }, towardPlayer: { code: 10 }, awayFromPlayer: { code: 11 },
  forward: { code: 12 }, backward: { code: 13 },
  jump: { code: 14, fields: ["x", "y"], range: [-999, 999] },
  wait: { code: 15, fields: ["frames"], range: [1, 999] },
  turnDown: { code: 16 }, turnLeft: { code: 17 }, turnRight: { code: 18 }, turnUp: { code: 19 },
  turnRight90: { code: 20 }, turnLeft90: { code: 21 }, turn180: { code: 22 }, turnRightOrLeft90: { code: 23 },
  turnRandom: { code: 24 }, turnTowardPlayer: { code: 25 }, turnAwayFromPlayer: { code: 26 },
  switchOn: { code: 27, fields: ["switchId"], range: [1, 9999] },
  switchOff: { code: 28, fields: ["switchId"], range: [1, 9999] },
  speed: { code: 29, fields: ["value"], range: [1, 6] },
  frequency: { code: 30, fields: ["value"], range: [1, 6] },
  walkAnimeOn: { code: 31 }, walkAnimeOff: { code: 32 }, stepAnimeOn: { code: 33 }, stepAnimeOff: { code: 34 },
  directionFixOn: { code: 35 }, directionFixOff: { code: 36 }, throughOn: { code: 37 }, throughOff: { code: 38 },
  transparentOn: { code: 39 }, transparentOff: { code: 40 },
  changeImage: { code: 41 }, opacity: { code: 42, fields: ["value"], range: [0, 255] },
  blendMode: { code: 43, fields: ["value"], range: [0, 2] },
  playSe: { code: 44 }, script: { code: 45 }
};

function audioParameter({ name, volume = 90, pitch = 100, pan = 0 }, label) {
  if (typeof name !== "string" || !name.length || !NAME_PATTERN.test(name))
    throw new Error(`${label}.name must be an audio asset file name without path separators`);
  int(volume, `${label}.volume`, 0, 100);
  int(pitch, `${label}.pitch`, 50, 150);
  int(pan, `${label}.pan`, -100, 100);
  return { name, volume, pitch, pan };
}

// Set Move Route: [characterId, {list, repeat, skippable, wait}]. Engine
// character() encoding (rmmz_objects.js): -1 = the PLAYER, 0 = this event,
// 1..9999 = event ID. repeat:true loops the list forever after ROUTE_END —
// on an action-triggered event that usually deadlocks the interpreter's
// "route" wait, so the default here is false.
export function moveRouteCommands({ targetId = 0, steps, repeat = false, skippable = false, wait = false }) {
  int(targetId, "targetId", -1, 9999);
  if (!Array.isArray(steps) || !steps.length) throw new Error("steps must be a non-empty array of move instructions");
  if (steps.length > 999) throw new Error("steps must contain at most 999 instructions");
  const list = steps.map((step, index) => {
    if (!step || typeof step !== "object" || Array.isArray(step) || typeof step.move !== "string")
      throw new Error(`steps[${index}] must be an object with a move name`);
    const spec = MOVE_ROUTE[step.move];
    if (!spec) throw new Error(`steps[${index}].move "${step.move}" is unknown. Valid moves: ${Object.keys(MOVE_ROUTE).join(", ")}`);
    const parameters = [];
    if (spec.fields) for (const field of spec.fields) {
      if (step[field] === undefined) throw new Error(`steps[${index}].move "${step.move}" requires "${field}"`);
      if (spec.range) int(step[field], `steps[${index}].${field}`, spec.range[0], spec.range[1]);
      parameters.push(step[field]);
    }
    if (step.move === "changeImage") {
      if (typeof step.characterName !== "string" || (step.characterName && !NAME_PATTERN.test(step.characterName)))
        throw new Error(`steps[${index}].characterName must be an asset file name without path separators`);
      int(step.characterIndex ?? 0, `steps[${index}].characterIndex`, 0, 7);
      parameters.push(step.characterName, step.characterIndex ?? 0);
    }
    if (step.move === "playSe") parameters.push(audioParameter(step, `steps[${index}]`));
    if (step.move === "script") {
      if (typeof step.code !== "string" || !step.code.length) throw new Error(`steps[${index}].code must be JavaScript`);
      parameters.push(step.code);
    }
    return { code: spec.code, parameters };
  });
  list.push({ code: 0, parameters: [] });
  return [{ code: 205, indent: 0, parameters: [targetId, { list, repeat: !!repeat, skippable: !!skippable, wait: !!wait }] }];
}

const AUDIO_CODES = { se: 250, me: 249, bgm: 241, bgs: 245 };
// Play SE / ME / BGM / BGS: one audio object parameter {name, volume, pitch, pan}.
export function playAudioCommands({ kind = "se", ...audio }) {
  const code = AUDIO_CODES[kind];
  if (!code) throw new Error("kind must be se, me, bgm or bgs");
  return [{ code, indent: 0, parameters: [audioParameter(audio, "audio")] }];
}

// Battle Processing: [type, troopId/variableId, canEscape, canLose], optionally
// followed by 601 When Win / 602 When Escape / 603 When Lose / 604 End.
export function battleCommands({ type = "direct", troopId, variableId, canEscape = false, canLose = false,
  onWin = [], onEscape = [], onLose = [] }) {
  if (typeof canEscape !== "boolean" || typeof canLose !== "boolean") throw new Error("canEscape/canLose must be booleans");
  let parameters;
  if (type === "random") parameters = [2, 0, canEscape, canLose];
  else if (type === "variable") {
    int(variableId, "variableId", 1, 9999);
    parameters = [1, variableId, canEscape, canLose];
  } else {
    int(troopId, "troopId", 1, 999);
    parameters = [0, troopId, canEscape, canLose];
  }
  const win = normalizeRawCommands(onWin, "onWin");
  const escape = normalizeRawCommands(onEscape, "onEscape");
  const lose = normalizeRawCommands(onLose, "onLose");
  if (escape.length && !canEscape) throw new Error("onEscape commands require canEscape: true");
  if (lose.length && !canLose) throw new Error("onLose commands require canLose: true");
  const commands = [{ code: 301, indent: 0, parameters }];
  if (win.length || escape.length || lose.length) {
    commands.push({ code: 601, indent: 0, parameters: [] }, ...indented(win, 1));
    if (canEscape) commands.push({ code: 602, indent: 0, parameters: [] }, ...indented(escape, 1));
    if (canLose) commands.push({ code: 603, indent: 0, parameters: [] }, ...indented(lose, 1));
    commands.push({ code: 604, indent: 0, parameters: [] });
  }
  return commands;
}

// Transfer Player: [designation(0 direct), mapId, x, y, direction(0 retain), fadeType(0 black/1 white/2 none)].
export function transferPlayerCommands({ mapId, x, y, direction = 0, fade = 0 }) {
  int(mapId, "mapId", 1, 999);
  int(x, "x", 0); int(y, "y", 0);
  if (![0, 2, 4, 6, 8].includes(direction)) throw new Error("direction must be 0 (retain), 2, 4, 6 or 8");
  int(fade, "fade", 0, 2);
  return [{ code: 201, indent: 0, parameters: [0, mapId, x, y, direction, fade] }];
}

// Wait: [frames] at 60 fps.
export function waitCommands({ frames }) {
  int(frames, "frames", 1, 999);
  return [{ code: 230, indent: 0, parameters: [frames] }];
}

// Show Choices: MZ 1.8 stores five parameters [choices, cancelType, defaultType,
// positionType, background]; MV-era references with four parameters misplace
// the window settings. 402 carries [index, text] per choice; 403 (no
// parameters) is the cancel branch and only exists when cancelType is -1.
export function showChoicesCommands({ choices, cancelType = -2, defaultType = 0, background = 0, position = 2, cancelCommands = [] }) {
  if (!Array.isArray(choices) || !choices.length || choices.length > 6)
    throw new Error("choices must contain 1..6 entries of {text, commands?}");
  const texts = [];
  const branches = [];
  choices.forEach((choice, index) => {
    if (!choice || typeof choice !== "object" || Array.isArray(choice) || typeof choice.text !== "string" || !choice.text.length)
      throw new Error(`choices[${index}] must be {text, commands?} with non-empty text`);
    texts.push(choice.text);
    branches.push(normalizeRawCommands(choice.commands ?? [], `choices[${index}].commands`));
  });
  int(cancelType, "cancelType", -2, choices.length - 1);
  int(defaultType, "defaultType", -1, choices.length - 1);
  int(background, "background", 0, 2);
  int(position, "position", 0, 2);
  const commands = [{ code: 102, indent: 0, parameters: [texts, cancelType, defaultType, position, background] }];
  branches.forEach((branch, index) => {
    commands.push({ code: 402, indent: 0, parameters: [index, texts[index]] });
    commands.push(...indented(branch, 1));
  });
  if (cancelType === -1) commands.push({ code: 403, indent: 0, parameters: [] },
    ...indented(normalizeRawCommands(cancelCommands, "cancelCommands"), 1));
  return commands;
}

// Input Number: [variableId, maxDigits].
export function inputNumberCommands({ variableId, maxDigits }) {
  int(variableId, "variableId", 1, 9999);
  int(maxDigits, "maxDigits", 1, 8);
  return [{ code: 103, indent: 0, parameters: [variableId, maxDigits] }];
}

// Change Party Member: [actorId, operation(0 add/1 remove), initialize].
export function changePartyCommands({ actorId, add = true, initialize = false }) {
  int(actorId, "actorId", 1, 9999);
  return [{ code: 129, indent: 0, parameters: [actorId, add ? 0 : 1, initialize ? 1 : 0] }];
}

// Commands 311/312/316 select targets with [scope(0 actor/1 entire party),
// actorId] and values with [operation(0 increase/1 decrease), operandType,
// operand] via iterateActorEx/operateValue.
function actorScope({ actorId, entireParty = false }) {
  int(actorId ?? 0, "actorId", 0, 9999);
  return [entireParty ? 1 : 0, actorId ?? 0];
}
function operandPair({ operation = "increase", value, valueVariableId }) {
  const operationType = operation === "increase" ? 0 : operation === "decrease" ? 1 : undefined;
  if (operationType === undefined) throw new Error("operation must be increase or decrease");
  if (valueVariableId !== undefined) { int(valueVariableId, "valueVariableId", 1, 9999); return [operationType, 1, valueVariableId]; }
  if (!Number.isInteger(value)) throw new Error("value must be an integer (or pass valueVariableId)");
  int(value, "value", 1, 99999999);
  return [operationType, 0, value];
}

// Change HP: [scope, actorId, operation, operandType, operand, allowKnockout].
export function changeActorHpCommands(args) {
  const [scope, id] = actorScope(args);
  const [op, type, operand] = operandPair(args);
  return [{ code: 311, indent: 0, parameters: [scope, id, op, type, operand, args.allowKnockout ? 1 : 0] }];
}

// Change MP: [scope, actorId, operation, operandType, operand].
export function changeActorMpCommands(args) {
  const [scope, id] = actorScope(args);
  const [op, type, operand] = operandPair(args);
  return [{ code: 312, indent: 0, parameters: [scope, id, op, type, operand] }];
}

// Change Level: [scope, actorId, operation, operandType, operand, showLevelUp].
export function changeActorLevelCommands(args) {
  const [scope, id] = actorScope(args);
  const [op, type, operand] = operandPair(args);
  return [{ code: 316, indent: 0, parameters: [scope, id, op, type, operand, args.showLevelUp === false ? 0 : 1] }];
}

// Change State: [scope, actorId, operation(0 add/1 remove), stateId].
export function changeActorStateCommands({ actorId, entireParty = false, add = true, stateId }) {
  const [scope, id] = actorScope({ actorId, entireParty });
  int(stateId, "stateId", 1, 9999);
  return [{ code: 313, indent: 0, parameters: [scope, id, add ? 0 : 1, stateId] }];
}

// Recover All: [scope, actorId].
export function recoverAllCommands({ actorId, entireParty = false }) {
  const [scope, id] = actorScope({ actorId, entireParty });
  return [{ code: 314, indent: 0, parameters: [scope, id] }];
}

// Learn/Forget Skill: [scope, actorId, operation(0 learn/1 forget), skillId].
export function changeActorSkillCommands({ actorId, entireParty = false, learn = true, skillId }) {
  const [scope, id] = actorScope({ actorId, entireParty });
  int(skillId, "skillId", 1, 9999);
  return [{ code: 318, indent: 0, parameters: [scope, id, learn ? 0 : 1, skillId] }];
}

// Change Actor Images: [actorId, characterName, characterIndex, faceName, faceIndex, battlerName].
export function changeActorImagesCommands({ actorId, characterName = "", characterIndex = 0, faceName = "", faceIndex = 0, battlerName = "" }) {
  int(actorId, "actorId", 1, 9999);
  for (const [label, name] of [["characterName", characterName], ["faceName", faceName], ["battlerName", battlerName]])
    if (typeof name !== "string" || (name && !NAME_PATTERN.test(name)))
      throw new Error(`${label} must be an asset file name without path separators`);
  int(characterIndex, "characterIndex", 0, 7); int(faceIndex, "faceIndex", 0, 7);
  return [{ code: 322, indent: 0, parameters: [actorId, characterName, characterIndex, faceName, faceIndex, battlerName] }];
}

// Change Enemy HP: [troopMemberIndex, operation, operandType, operand, allowKnockout]. Battle events only.
export function changeEnemyHpCommands({ troopMemberIndex, operation = "decrease", value, valueVariableId, allowKnockout = true }) {
  int(troopMemberIndex, "troopMemberIndex", 0, 7);
  const [op, type, operand] = operandPair({ operation, value, valueVariableId });
  return [{ code: 331, indent: 0, parameters: [troopMemberIndex, op, type, operand, allowKnockout ? 1 : 0] }];
}

// Enemy Appear: [troopMemberIndex].
export function enemyAppearCommands({ troopMemberIndex }) {
  int(troopMemberIndex, "troopMemberIndex", 0, 7);
  return [{ code: 335, indent: 0, parameters: [troopMemberIndex] }];
}

// Enemy Transform: [troopMemberIndex, enemyId].
export function enemyTransformCommands({ troopMemberIndex, enemyId }) {
  int(troopMemberIndex, "troopMemberIndex", 0, 7);
  int(enemyId, "enemyId", 1, 9999);
  return [{ code: 336, indent: 0, parameters: [troopMemberIndex, enemyId] }];
}

// Fadeout Screen (221) / Fadein Screen (222): no parameters.
export function screenFadeCommands({ mode }) {
  const code = mode === "out" ? 221 : mode === "in" ? 222 : undefined;
  if (!code) throw new Error('mode must be "out" (fade to black) or "in" (fade back in)');
  return [{ code, indent: 0, parameters: [] }];
}

// Tint Screen: [[red, green, blue, gray], frames, wait].
export function tintScreenCommands({ red = 0, green = 0, blue = 0, gray = 0, frames = 60, wait = false }) {
  int(red, "red", -255, 255); int(green, "green", -255, 255); int(blue, "blue", -255, 255); int(gray, "gray", 0, 255);
  int(frames, "frames", 1, 600);
  return [{ code: 223, indent: 0, parameters: [[red, green, blue, gray], frames, wait ? 1 : 0] }];
}

// Flash Screen: [[red, green, blue], frames, wait].
export function flashScreenCommands({ red = 255, green = 255, blue = 255, frames = 60, wait = false }) {
  int(red, "red", 0, 255); int(green, "green", 0, 255); int(blue, "blue", 0, 255);
  int(frames, "frames", 1, 600);
  return [{ code: 224, indent: 0, parameters: [[red, green, blue], frames, wait ? 1 : 0] }];
}

// Shake Screen: [power, speed, frames, wait].
export function shakeScreenCommands({ power = 5, speed = 5, frames = 60, wait = false }) {
  int(power, "power", 1, 9); int(speed, "speed", 1, 9); int(frames, "frames", 1, 600);
  return [{ code: 225, indent: 0, parameters: [power, speed, frames, wait ? 1 : 0] }];
}

const WEATHER_TYPES = { none: 0, rain: 1, storm: 2, snow: 3 };
// Set Weather Effect: [type(0 none/1 rain/2 storm/3 snow), power, frames, wait].
export function weatherCommands({ type = "none", power = 5, frames = 60, wait = false }) {
  const typeCode = WEATHER_TYPES[type];
  if (typeCode === undefined) throw new Error("type must be none, rain, storm or snow");
  int(power, "power", 0, 9); int(frames, "frames", 1, 600);
  return [{ code: 236, indent: 0, parameters: [typeCode, power, frames, wait ? 1 : 0] }];
}

// Show Animation: [targetId(-1 player/0 this event/1.. event), animationId, wait].
export function showAnimationCommands({ targetId = 0, animationId, wait = false }) {
  int(targetId, "targetId", -1, 9999);
  int(animationId, "animationId", 1, 9999);
  return [{ code: 212, indent: 0, parameters: [targetId, animationId, wait ? 1 : 0] }];
}

// Set Event Location: [targetId, designation(0 direct), x, y, direction(0 retain)].
// Variable designation and swapping with another event need event_raw_commands.
export function setEventLocationCommands({ targetId = 0, x, y, direction = 0 }) {
  int(targetId, "targetId", 0, 9999);
  int(x, "x", 0); int(y, "y", 0);
  if (![0, 2, 4, 6, 8].includes(direction)) throw new Error("direction must be 0 (retain), 2, 4, 6 or 8");
  return [{ code: 203, indent: 0, parameters: [targetId, 0, x, y, direction] }];
}

// Show Picture: [number, name, origin(0 upper-left/1 center), designation(0 direct),
// x, y, scaleX, scaleY, opacity, blendMode].
export function showPictureCommands({ number, imageName, origin = 1, x, y, scaleX = 100, scaleY = 100, opacity = 255, blendMode = 0 }) {
  int(number, "number", 1, 100);
  if (typeof imageName !== "string" || !imageName.length || !NAME_PATTERN.test(imageName))
    throw new Error("imageName must be an asset file name without path separators");
  int(origin, "origin", 0, 1);
  int(x, "x", -9999, 9999); int(y, "y", -9999, 9999);
  int(scaleX, "scaleX", 0, 2000); int(scaleY, "scaleY", 0, 2000);
  int(opacity, "opacity", 0, 255); int(blendMode, "blendMode", 0, 2);
  return [{ code: 231, indent: 0, parameters: [number, imageName, origin, 0, x, y, scaleX, scaleY, opacity, blendMode] }];
}

// Move Picture: [number, unused, origin, designation, x, y, scaleX, scaleY,
// opacity, blendMode, duration, waitForCompletion, easingType].
export function movePictureCommands({ number, origin = 1, x, y, scaleX = 100, scaleY = 100, opacity = 255, blendMode = 0, frames = 60, wait = false, easing = 0 }) {
  int(number, "number", 1, 100);
  int(origin, "origin", 0, 1);
  int(x, "x", -9999, 9999); int(y, "y", -9999, 9999);
  int(scaleX, "scaleX", 0, 2000); int(scaleY, "scaleY", 0, 2000);
  int(opacity, "opacity", 0, 255); int(blendMode, "blendMode", 0, 2);
  int(frames, "frames", 1, 3600); int(easing, "easing", 0, 3);
  return [{ code: 232, indent: 0, parameters: [number, 0, origin, 0, x, y, scaleX, scaleY, opacity, blendMode, frames, wait ? 1 : 0, easing] }];
}

// Erase Picture: [number].
export function erasePictureCommands({ number }) {
  int(number, "number", 1, 100);
  return [{ code: 235, indent: 0, parameters: [number] }];
}

// Comment: 108 with 408 continuation lines (readable labels inside command lists).
export function commentCommands({ text }) {
  if (typeof text !== "string" || !text.length) throw new Error("text must be a non-empty string");
  return text.split("\n").map((line, index) => ({ code: index ? 408 : 108, indent: 0, parameters: [line] }));
}

// Exit Event Processing: no parameters.
export function exitEventCommands() {
  return [{ code: 115, indent: 0, parameters: [] }];
}

// Erase Event: []. In MZ this is 214; 115 is Abort Event, which MV used as erase.
export function eraseEventCommands() {
  return [{ code: 214, indent: 0, parameters: [] }];
}

// Call Common Event: [commonEventId].
export function callCommonEventCommands({ commonEventId }) {
  int(commonEventId, "commonEventId", 1, 9999);
  return [{ code: 117, indent: 0, parameters: [commonEventId] }];
}

// Label: [name]. Jump to Label: [name].
function labelName({ name }, label) {
  if (typeof name !== "string" || !name.length || name.length > 100)
    throw new Error(`${label} must be a string of 1..100 characters`);
  return name;
}
export function labelCommands(args) {
  return [{ code: 118, indent: 0, parameters: [labelName(args, "name")] }];
}
export function jumpToLabelCommands(args) {
  return [{ code: 119, indent: 0, parameters: [labelName(args, "name")] }];
}

// Name Input Processing: [actorId, maxCharacters].
export function nameInputCommands({ actorId, maxCharacters = 8 }) {
  int(actorId, "actorId", 1, 9999); int(maxCharacters, "maxCharacters", 1, 16);
  return [{ code: 303, indent: 0, parameters: [actorId, maxCharacters] }];
}

const SHOP_KINDS = { item: 0, weapon: 1, armor: 2 };
// Shop Processing: 302 carries the first goods row plus the purchase-only flag
// at index 4 (Scene_Shop.prepare reads params[4]); 605 carries further rows.
export function shopCommands({ goods, purchaseOnly = false }) {
  if (!Array.isArray(goods) || !goods.length || goods.length > 99)
    throw new Error("goods must contain 1..99 entries of {kind, id, price?}");
  const rows = goods.map((entry, index) => {
    const kind = SHOP_KINDS[entry?.kind];
    if (kind === undefined) throw new Error(`goods[${index}].kind must be item, weapon or armor`);
    int(entry.id ?? 0, `goods[${index}].id`, 1, 9999);
    int(entry.price ?? 0, `goods[${index}].price`, 0, 99999999);
    return [kind, entry.id, entry.price ?? 0, 0];
  });
  return [
    { code: 302, indent: 0, parameters: [...rows[0], purchaseOnly ? 1 : 0] },
    ...rows.slice(1).map(row => ({ code: 605, indent: 0, parameters: row }))
  ];
}

// Control Timer: [operation(0 start/1 stop), seconds].
export function controlTimerCommands({ mode = "start", seconds = 0 }) {
  if (!["start", "stop"].includes(mode)) throw new Error('mode must be "start" or "stop"');
  int(seconds, "seconds", 0, 359999);
  if (mode === "start" && seconds < 1) throw new Error("seconds must be >= 1 when mode is start");
  return [{ code: 124, indent: 0, parameters: [mode === "start" ? 0 : 1, seconds] }];
}

const ACCESS_CODES = { save: 134, menu: 135, encounters: 136, formation: 137 };
// Change Save/Menu/Encounter/Formation Access: [0 disable/1 enable]. MZ 1.8
// renumbered these against MV (MV used 134 timer, 141-143).
export function changeAccessCommands({ save, menu, encounters, formation }) {
  const provided = Object.entries({ save, menu, encounters, formation }).filter(([, value]) => value !== undefined);
  if (!provided.length) throw new Error("set at least one of save, menu, encounters, formation (booleans)");
  for (const [key, value] of provided)
    if (typeof value !== "boolean") throw new Error(`${key} must be a boolean (true = allow, false = forbid)`);
  return provided.map(([key, value]) => ({ code: ACCESS_CODES[key], indent: 0, parameters: [value ? 1 : 0] }));
}

// Insert builder output into one event page. Default position: just before the
// page's final code 0 terminator. Returns placement info for the tool result.
export function insertPageCommands(map, { eventId, pageIndex = 0, at, commands }) {
  const event = map.events[eventId];
  if (!event) throw new Error(`Event ${eventId} does not exist on this map; create it with upsert_event or put_event first`);
  const page = event.pages[pageIndex];
  if (!page) throw new Error(`Event ${eventId} has no page index ${pageIndex}`);
  if (!Array.isArray(page.list) || !page.list.length || page.list.at(-1).code !== 0)
    throw new Error(`Event ${eventId} page ${pageIndex} has a malformed command list`);
  if (page.list.length + commands.length > 10000) throw new Error("Event page would exceed the MZ limit of 10000 commands");
  const insertAt = at === undefined ? page.list.length - 1 : int(at, "insertAt", 0, page.list.length - 1);
  page.list.splice(insertAt, 0, ...structuredClone(commands));
  return { eventId, pageIndex, insertAt, inserted: commands.length };
}

async function optionalJson(project, relative) {
  try { return await project.json(relative); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function requireDatabaseEntry(project, relative, id, label) {
  if (typeof id !== "number" || !Number.isInteger(id)) return;
  const data = await optionalJson(project, relative);
  if (data && !(id >= 1 && id < data.length && data[id]))
    throw new Error(`${label} ID ${id} is outside the project database (${relative})`);
}
async function requireSystemIndex(project, kind, id) {
  if (typeof id !== "number" || !Number.isInteger(id)) return;
  const system = await project.json("data/System.json");
  const names = kind === "switch" ? system.switches : system.variables;
  if (!(id >= 1 && id < (names?.length ?? 0)))
    throw new Error(`${kind} ID ${id} is outside the project database (data/System.json)`);
}

async function requireMapExists(project, id) {
  if (!(await project.maps()).some(map => map.id === id))
    throw new Error(`Map ${id} does not exist in this project (MapInfos.json)`);
}

const rawCommands = z.array(z.record(z.string(), z.unknown())).max(1000);

export function registerEventTools({ project, register, afterEdit }) {
  const base = {
    mapId: z.number().int().min(1).max(999),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    eventId: z.number().int().min(1).max(9999),
    pageIndex: z.number().int().min(0).max(19).default(0),
    insertAt: z.number().int().min(0).max(9999).optional(),
    screenshot: z.boolean().default(true)
  };
  // Every tool builds MZ commands, then commits them into one event page via
  // the same transactional edit path as upsert_event (backup, revision check,
  // precise delta to the browser observer, screenshot).
  const eventTool = (name, description, schema, build) => register(name, description, { ...base, ...schema }, async args => {
    const commands = await build(args);
    let placement;
    const result = await project.edit(args.mapId, args.expectedRevision, map => {
      placement = insertPageCommands(map, { eventId: args.eventId, pageIndex: args.pageIndex, at: args.insertAt, commands });
    }, name);
    return afterEdit({ ...result, ...placement }, args.screenshot);
  }, true);

  eventTool("event_show_text", "Append Show Text dialogue (MZ codes 101/401) to an existing event page. Lines longer than 4 are batched into further 101 blocks like the MZ editor.", {
    text: z.string().min(1).max(65536), speaker: z.string().max(64).optional(),
    face: z.object({ name: z.string().max(128), index: z.number().int().min(0).max(7).default(0) }).optional(),
    background: z.number().int().min(0).max(2).default(0), position: z.number().int().min(0).max(2).default(2)
  }, args => showTextCommands({ text: args.text, speaker: args.speaker ?? "",
    faceName: args.face?.name ?? "", faceIndex: args.face?.index ?? 0, background: args.background, position: args.position }));

  eventTool("event_battle", "Append Battle Processing (MZ code 301): type direct (troopId), variable (troop from variableId) or random encounter. With canEscape/canLose and onWin/onEscape/onLose command arrays it also lays out the 601/602/603/604 result branches with correct indentation.", {
    type: z.enum(["direct", "variable", "random"]).default("direct"),
    troopId: z.number().int().min(1).max(999).optional(),
    variableId: z.number().int().min(1).max(9999).optional(),
    canEscape: z.boolean().default(false), canLose: z.boolean().default(false),
    onWin: rawCommands.optional(), onEscape: rawCommands.optional(), onLose: rawCommands.optional()
  }, async args => {
    if (args.type === "direct" && args.troopId === undefined) throw new Error("troopId is required for direct battles");
    if (args.type === "variable" && args.variableId === undefined) throw new Error("variableId is required for variable battles");
    if (args.type === "direct") await requireDatabaseEntry(project, "data/Troops.json", args.troopId, "Troop");
    return battleCommands(args);
  });

  eventTool("event_give_gold", "Append Change Gold (MZ code 125): gain or lose an amount, optionally read from a variable.", {
    amount: z.number().int().min(1).max(99999999), increase: z.boolean().default(true),
    variableId: z.number().int().min(1).max(9999).optional()
  }, async args => {
    if (args.variableId !== undefined) await requireSystemIndex(project, "variable", args.variableId);
    return changeGoldCommands(args);
  });

  eventTool("event_give_items", "Append Change Items/Weapons/Armors (MZ codes 126/127/128): give or remove a quantity, optionally read from a variable.", {
    kind: z.enum(["item", "weapon", "armor"]).default("item"),
    itemId: z.number().int().min(1).max(9999), amount: z.number().int().min(1).max(9999).default(1),
    increase: z.boolean().default(true), variableId: z.number().int().min(1).max(9999).optional()
  }, async args => {
    await requireDatabaseEntry(project, { item: "data/Items.json", weapon: "data/Weapons.json", armor: "data/Armors.json" }[args.kind],
      args.itemId, args.kind[0].toUpperCase() + args.kind.slice(1));
    if (args.variableId !== undefined) await requireSystemIndex(project, "variable", args.variableId);
    return changeItemsCommands(args);
  });

  eventTool("event_switches", "Append Control Switches (MZ code 121): turn one switch or an inclusive ID range ON/OFF. In MZ data 0 = ON and 1 = OFF; this tool takes plain booleans.", {
    switchId: z.number().int().min(1).max(9999), endSwitchId: z.number().int().min(1).max(9999).optional(),
    on: z.boolean()
  }, async args => {
    await requireSystemIndex(project, "switch", args.endSwitchId ?? args.switchId);
    return controlSwitchesCommands(args);
  });

  eventTool("event_self_switch", "Append Control Self Switches (MZ code 123) for A/B/C/D. At runtime it always targets the event that runs the command, so the classic page-turn pattern is: page 0 sets A ON, page 1 has condition selfSwitch A.", {
    character: z.enum(["A", "B", "C", "D"]).default("A"), on: z.boolean()
  }, args => controlSelfSwitchCommands(args));

  eventTool("event_variables", "Append Change Variables (MZ code 122): set/add/sub/mul/div/mod on one variable or an inclusive ID range, with constant, variable, random or script operands.", {
    variableId: z.number().int().min(1).max(9999), endVariableId: z.number().int().min(1).max(9999).optional(),
    operation: z.enum(["set", "add", "sub", "mul", "div", "mod"]).default("set"),
    operand: z.record(z.string(), z.unknown())
  }, async args => {
    await requireSystemIndex(project, "variable", args.endVariableId ?? args.variableId);
    if (args.operand?.type === "variable") await requireSystemIndex(project, "variable", args.operand.value);
    return changeVariablesCommands(args);
  });

  eventTool("event_if", "Append Conditional Branch (MZ code 111/411/412). condition.type: switch, variable, selfSwitch, timer, actor, enemy, character, gold, item, weapon, armor, button, script, vehicle. thenCommands/elseCommands are raw MZ commands placed inside the branch with correct indentation.", {
    condition: z.record(z.string(), z.unknown()),
    thenCommands: rawCommands.optional(), elseCommands: rawCommands.optional()
  }, async args => {
    const condition = args.condition;
    if (condition?.type === "switch") await requireSystemIndex(project, "switch", condition.switchId);
    if (condition?.type === "variable") {
      await requireSystemIndex(project, "variable", condition.variableId);
      if (condition.operandVariableId !== undefined) await requireSystemIndex(project, "variable", condition.operandVariableId);
    }
    if (condition?.type === "item") await requireDatabaseEntry(project, "data/Items.json", condition.itemId, "Item");
    if (condition?.type === "weapon") await requireDatabaseEntry(project, "data/Weapons.json", condition.weaponId, "Weapon");
    if (condition?.type === "armor") await requireDatabaseEntry(project, "data/Armors.json", condition.armorId, "Armor");
    return conditionalBranchCommands({ condition, thenCommands: args.thenCommands ?? [], elseCommands: args.elseCommands ?? [] });
  });

  eventTool("event_move_route", "Append Set Move Route (MZ code 205). targetId follows the engine's character() encoding: -1 = the PLAYER, 0 = this event, 1..9999 = event ID. steps use move names (down/left/right/up, lowerLeft..upperRight, random, towardPlayer, awayFromPlayer, forward, backward, jump{x,y}, wait{frames}, turn*, switchOn/Off{switchId}, speed{1-6}, frequency{1-6}, walkAnimeOn/Off, stepAnimeOn/Off, directionFixOn/Off, throughOn/Off, transparentOn/Off, changeImage{characterName,characterIndex}, opacity{0-255}, blendMode{0-2}, playSe{name,...}, script{code}). repeat defaults to false; repeat:true loops the route forever and deadlocks a wait:true route whose steps can fail (e.g. towardPlayer onto a blocked tile).", {
    targetId: z.number().int().min(-1).max(9999).default(0),
    steps: z.array(z.record(z.string(), z.unknown())).min(1).max(999),
    repeat: z.boolean().default(false), skippable: z.boolean().default(false), wait: z.boolean().default(false)
  }, async args => {
    for (const step of args.steps) if (step.move === "switchOn" || step.move === "switchOff")
      await requireSystemIndex(project, "switch", step.switchId);
    return moveRouteCommands(args);
  });

  eventTool("event_play_se", "Append an audio command: Play SE (MZ code 250), Play ME (249), Play BGM (241) or Play BGS (245). MZ renumbered these against MV, where SE was 249. Audio assets live in the project's audio/ folders.", {
    kind: z.enum(["se", "me", "bgm", "bgs"]).default("se"), name: z.string().min(1).max(128),
    volume: z.number().int().min(0).max(100).default(90), pitch: z.number().int().min(50).max(150).default(100),
    pan: z.number().int().min(-100).max(100).default(0)
  }, args => playAudioCommands(args));

  eventTool("event_transfer_player", "Append Transfer Player (MZ code 201): move the party to a map coordinate. direction 0 retains facing, fade 0 black / 1 white / 2 none. Variable-based destinations need event_raw_commands.", {
    toMapId: z.number().int().min(1).max(999), x: z.number().int().min(0), y: z.number().int().min(0),
    direction: z.union([z.literal(0), z.literal(2), z.literal(4), z.literal(6), z.literal(8)]).default(0),
    fade: z.number().int().min(0).max(2).default(0)
  }, async args => {
    await requireMapExists(project, args.toMapId);
    return transferPlayerCommands({ mapId: args.toMapId, x: args.x, y: args.y, direction: args.direction, fade: args.fade });
  });

  eventTool("event_wait", "Append Wait (MZ code 230): pause the event for a number of frames (60 frames = 1 second).", {
    frames: z.number().int().min(1).max(999)
  }, args => waitCommands(args));

  eventTool("event_show_choices", "Append Show Choices (MZ code 102 + 402/403). MZ 1.8 stores [choices, cancelType, defaultType, position, background]. Each choice is {text, commands?}; cancelType -2 = disallow, -1 = branch to cancelCommands, or a choice index that acts as cancel.", {
    choices: z.array(z.object({ text: z.string().min(1).max(120), commands: rawCommands.optional() })).min(1).max(6),
    cancelType: z.number().int().min(-2).max(5).default(-2),
    defaultType: z.number().int().min(-1).max(5).default(0),
    background: z.number().int().min(0).max(2).default(0),
    position: z.number().int().min(0).max(2).default(2),
    cancelCommands: rawCommands.optional()
  }, async args => {
    if (args.cancelType >= args.choices.length) throw new Error("cancelType must be -2, -1 or a choice index");
    if (args.defaultType >= args.choices.length) throw new Error("defaultType must be -1 or a choice index");
    return showChoicesCommands(args);
  });

  eventTool("event_input_number", "Append Input Number (MZ code 103): ask for a numeric value stored into a variable (1..8 digits).", {
    variableId: z.number().int().min(1).max(9999), maxDigits: z.number().int().min(1).max(8)
  }, async args => {
    await requireSystemIndex(project, "variable", args.variableId);
    return inputNumberCommands(args);
  });

  eventTool("event_change_party", "Append Change Party Member (MZ code 129): add or remove an actor, optionally re-initializing them from the database first.", {
    actorId: z.number().int().min(1).max(9999), add: z.boolean().default(true), initialize: z.boolean().default(false)
  }, async args => {
    await requireDatabaseEntry(project, "data/Actors.json", args.actorId, "Actor");
    return changePartyCommands(args);
  });

  eventTool("event_change_actor_hp", "Append Change HP (MZ code 311): increase/decrease one actor's or the entire party's HP by a constant or variable amount. allowKnockout permits lethal damage (default false).", {
    actorId: z.number().int().min(1).max(9999).optional(), entireParty: z.boolean().default(false),
    operation: z.enum(["increase", "decrease"]).default("increase"),
    value: z.number().int().min(1).max(99999999).optional(), valueVariableId: z.number().int().min(1).max(9999).optional(),
    allowKnockout: z.boolean().default(false)
  }, async args => {
    if (!args.entireParty) await requireDatabaseEntry(project, "data/Actors.json", args.actorId, "Actor");
    if (args.valueVariableId !== undefined) await requireSystemIndex(project, "variable", args.valueVariableId);
    return changeActorHpCommands(args);
  });

  eventTool("event_change_actor_mp", "Append Change MP (MZ code 312): increase/decrease one actor's or the entire party's MP by a constant or variable amount.", {
    actorId: z.number().int().min(1).max(9999).optional(), entireParty: z.boolean().default(false),
    operation: z.enum(["increase", "decrease"]).default("increase"),
    value: z.number().int().min(1).max(99999999).optional(), valueVariableId: z.number().int().min(1).max(9999).optional()
  }, async args => {
    if (!args.entireParty) await requireDatabaseEntry(project, "data/Actors.json", args.actorId, "Actor");
    if (args.valueVariableId !== undefined) await requireSystemIndex(project, "variable", args.valueVariableId);
    return changeActorMpCommands(args);
  });

  eventTool("event_change_actor_level", "Append Change Level (MZ code 316): raise/lower one actor's or the entire party's level, optionally showing the level-up message.", {
    actorId: z.number().int().min(1).max(9999).optional(), entireParty: z.boolean().default(false),
    operation: z.enum(["increase", "decrease"]).default("increase"),
    value: z.number().int().min(1).max(9999).optional(), valueVariableId: z.number().int().min(1).max(9999).optional(),
    showLevelUp: z.boolean().default(true)
  }, async args => {
    if (!args.entireParty) await requireDatabaseEntry(project, "data/Actors.json", args.actorId, "Actor");
    if (args.valueVariableId !== undefined) await requireSystemIndex(project, "variable", args.valueVariableId);
    return changeActorLevelCommands(args);
  });

  eventTool("event_change_actor_state", "Append Change State (MZ code 313): add or remove a state (buff, poison, knockout...) for one actor or the entire party.", {
    actorId: z.number().int().min(1).max(9999).optional(), entireParty: z.boolean().default(false),
    add: z.boolean().default(true), stateId: z.number().int().min(1).max(9999)
  }, async args => {
    if (!args.entireParty) await requireDatabaseEntry(project, "data/Actors.json", args.actorId, "Actor");
    await requireDatabaseEntry(project, "data/States.json", args.stateId, "State");
    return changeActorStateCommands(args);
  });

  eventTool("event_recover_all", "Append Recover All (MZ code 314): fully restore one actor's or the entire party's HP/MP/states. The classic healer/tavern pattern.", {
    actorId: z.number().int().min(1).max(9999).optional(), entireParty: z.boolean().default(false)
  }, async args => {
    if (!args.entireParty) await requireDatabaseEntry(project, "data/Actors.json", args.actorId, "Actor");
    return recoverAllCommands(args);
  });

  eventTool("event_change_actor_skill", "Append Change Skill (MZ code 318): teach or forget a skill for one actor or the entire party.", {
    actorId: z.number().int().min(1).max(9999).optional(), entireParty: z.boolean().default(false),
    learn: z.boolean().default(true), skillId: z.number().int().min(1).max(9999)
  }, async args => {
    if (!args.entireParty) await requireDatabaseEntry(project, "data/Actors.json", args.actorId, "Actor");
    await requireDatabaseEntry(project, "data/Skills.json", args.skillId, "Skill");
    return changeActorSkillCommands(args);
  });

  eventTool("event_change_actor_images", "Append Change Actor Images (MZ code 322): swap an actor's walking character, face and battler graphics (disguise/transform scenes).", {
    actorId: z.number().int().min(1).max(9999),
    characterName: z.string().max(128).default(""), characterIndex: z.number().int().min(0).max(7).default(0),
    faceName: z.string().max(128).default(""), faceIndex: z.number().int().min(0).max(7).default(0),
    battlerName: z.string().max(128).default("")
  }, async args => {
    await requireDatabaseEntry(project, "data/Actors.json", args.actorId, "Actor");
    return changeActorImagesCommands(args);
  });

  eventTool("event_change_enemy_hp", "Append Change Enemy HP (MZ code 331) for battle event pages: increase/decrease a troop member's HP by a constant or variable amount. allowKnockout (default true) permits lethal damage.", {
    troopMemberIndex: z.number().int().min(0).max(7),
    operation: z.enum(["increase", "decrease"]).default("decrease"),
    value: z.number().int().min(1).max(99999999).optional(), valueVariableId: z.number().int().min(1).max(9999).optional(),
    allowKnockout: z.boolean().default(true)
  }, async args => {
    if (args.valueVariableId !== undefined) await requireSystemIndex(project, "variable", args.valueVariableId);
    return changeEnemyHpCommands(args);
  });

  eventTool("event_enemy_appear", "Append Enemy Appear (MZ code 335) for battle event pages: reveal a hidden troop member.", {
    troopMemberIndex: z.number().int().min(0).max(7)
  }, args => enemyAppearCommands(args));

  eventTool("event_enemy_transform", "Append Enemy Transform (MZ code 336) for battle event pages: replace a troop member with another enemy (mid-boss transformations).", {
    troopMemberIndex: z.number().int().min(0).max(7), enemyId: z.number().int().min(1).max(9999)
  }, async args => {
    await requireDatabaseEntry(project, "data/Enemies.json", args.enemyId, "Enemy");
    return enemyTransformCommands(args);
  });

  eventTool("event_screen_fade", "Append Fadeout Screen (MZ code 221, to black) or Fadein Screen (222, back in). Standard around teleports: fadeout → transfer → fadein.", {
    mode: z.enum(["out", "in"])
  }, args => screenFadeCommands(args));

  eventTool("event_tint_screen", "Append Tint Screen (MZ code 223): shift the screen color (red/green/blue -255..255, gray 0..255) over a frame duration.", {
    red: z.number().int().min(-255).max(255).default(0), green: z.number().int().min(-255).max(255).default(0),
    blue: z.number().int().min(-255).max(255).default(0), gray: z.number().int().min(0).max(255).default(0),
    frames: z.number().int().min(1).max(600).default(60), wait: z.boolean().default(false)
  }, args => tintScreenCommands(args));

  eventTool("event_flash_screen", "Append Flash Screen (MZ code 224): flash the screen in a color (0..255 per channel) over a frame duration.", {
    red: z.number().int().min(0).max(255).default(255), green: z.number().int().min(0).max(255).default(255),
    blue: z.number().int().min(0).max(255).default(255), frames: z.number().int().min(1).max(600).default(60),
    wait: z.boolean().default(false)
  }, args => flashScreenCommands(args));

  eventTool("event_shake_screen", "Append Shake Screen (MZ code 225): shake with power/speed 1..9 over a frame duration (earthquakes, impacts).", {
    power: z.number().int().min(1).max(9).default(5), speed: z.number().int().min(1).max(9).default(5),
    frames: z.number().int().min(1).max(600).default(60), wait: z.boolean().default(false)
  }, args => shakeScreenCommands(args));

  eventTool("event_set_weather", "Append Set Weather Effect (MZ code 236): none/rain/storm/snow with power 0..9 over a frame duration. Not applied during battle.", {
    type: z.enum(["none", "rain", "storm", "snow"]).default("none"), power: z.number().int().min(0).max(9).default(5),
    frames: z.number().int().min(1).max(600).default(60), wait: z.boolean().default(false)
  }, args => weatherCommands(args));

  eventTool("event_show_animation", "Append Show Animation (MZ code 212): play a database animation on the player (-1), this event (0) or another event. Battle animations live on troops/actors; this one is for the map.", {
    targetId: z.number().int().min(-1).max(9999).default(0), animationId: z.number().int().min(1).max(9999),
    wait: z.boolean().default(false)
  }, async args => {
    await requireDatabaseEntry(project, "data/Animations.json", args.animationId, "Animation");
    return showAnimationCommands(args);
  });

  eventTool("event_set_event_location", "Append Set Event Location (MZ code 203): instantly place this event (0) or another event at a coordinate; direction 0 retains facing. Variable designation and event swapping need event_raw_commands.", {
    targetId: z.number().int().min(0).max(9999).default(0), x: z.number().int().min(0), y: z.number().int().min(0),
    direction: z.union([z.literal(0), z.literal(2), z.literal(4), z.literal(6), z.literal(8)]).default(0)
  }, args => setEventLocationCommands(args));

  eventTool("event_show_picture", "Append Show Picture (MZ code 231): display an image from img/pictures at pixel coordinates; origin 0 upper-left, 1 center. blendMode 0 normal, 1 additive, 2 multiply.", {
    number: z.number().int().min(1).max(100), imageName: z.string().min(1).max(128),
    origin: z.number().int().min(0).max(1).default(1), x: z.number().int().min(-9999).max(9999), y: z.number().int().min(-9999).max(9999),
    scaleX: z.number().int().min(0).max(2000).default(100), scaleY: z.number().int().min(0).max(2000).default(100),
    opacity: z.number().int().min(0).max(255).default(255), blendMode: z.number().int().min(0).max(2).default(0)
  }, args => showPictureCommands(args));

  eventTool("event_move_picture", "Append Move Picture (MZ code 232): animate a picture to new geometry over a frame duration; easing 0 constant, 1 slow-in, 2 slow-out, 3 slow-in-out.", {
    number: z.number().int().min(1).max(100), origin: z.number().int().min(0).max(1).default(1),
    x: z.number().int().min(-9999).max(9999), y: z.number().int().min(-9999).max(9999),
    scaleX: z.number().int().min(0).max(2000).default(100), scaleY: z.number().int().min(0).max(2000).default(100),
    opacity: z.number().int().min(0).max(255).default(255), blendMode: z.number().int().min(0).max(2).default(0),
    frames: z.number().int().min(1).max(3600).default(60), wait: z.boolean().default(false),
    easing: z.number().int().min(0).max(3).default(0)
  }, args => movePictureCommands(args));

  eventTool("event_erase_picture", "Append Erase Picture (MZ code 235).", {
    number: z.number().int().min(1).max(100)
  }, args => erasePictureCommands(args));

  eventTool("event_comment", "Append a Comment (MZ code 108 + 408 lines): non-executed documentation inside the event command list, ideal for marking what each page does.", {
    text: z.string().min(1).max(65536)
  }, args => commentCommands(args));

  eventTool("event_exit_event", "Append Exit Event Processing (MZ code 115): stop the current event immediately (guard clauses). This does NOT erase the event; use event_erase_event for that.", {},
    () => exitEventCommands());

  eventTool("event_erase_event", "Append Erase Event (MZ code 214): remove this event for the rest of the game (emptied chest, one-shot NPC). Erased events reappear on map reload only if a page condition or save state says otherwise; combine with event_self_switch or event_switches when you also need a condition.", {},
    () => eraseEventCommands());

  eventTool("event_call_common_event", "Append Call Common Event (MZ code 117): run a common event from the database as a child interpreter.", {
    commonEventId: z.number().int().min(1).max(9999)
  }, async args => {
    await requireDatabaseEntry(project, "data/CommonEvents.json", args.commonEventId, "Common event");
    return callCommonEventCommands(args);
  });

  eventTool("event_label", "Append a Label (MZ code 118): a named jump target for event_jump_to_label and loops.", {
    name: z.string().min(1).max(100)
  }, args => labelCommands(args));

  eventTool("event_jump_to_label", "Append Jump to Label (MZ code 119): continue execution at the matching event_label. Use with event_if for loops.", {
    name: z.string().min(1).max(100)
  }, args => jumpToLabelCommands(args));

  eventTool("event_name_input", "Append Name Input Processing (MZ code 303): let the player type an actor's name (1..16 characters).", {
    actorId: z.number().int().min(1).max(9999), maxCharacters: z.number().int().min(1).max(16).default(8)
  }, async args => {
    await requireDatabaseEntry(project, "data/Actors.json", args.actorId, "Actor");
    return nameInputCommands(args);
  });

  eventTool("event_shop", "Append Shop Processing (MZ code 302 + 605 rows): open the shop scene with goods [{kind, id, price?}] where price 0 uses the database price. purchaseOnly hides the Sell command.", {
    goods: z.array(z.object({ kind: z.enum(["item", "weapon", "armor"]), id: z.number().int().min(1).max(9999),
      price: z.number().int().min(0).max(99999999).default(0) })).min(1).max(99),
    purchaseOnly: z.boolean().default(false)
  }, async args => {
    const files = { item: "data/Items.json", weapon: "data/Weapons.json", armor: "data/Armors.json" };
    for (const entry of args.goods) {
      const label = entry.kind[0].toUpperCase() + entry.kind.slice(1);
      await requireDatabaseEntry(project, files[entry.kind], entry.id, label);
    }
    return shopCommands(args);
  });

  eventTool("event_control_timer", "Append Control Timer (MZ code 124): start a countdown in seconds or stop it; pair with event_if condition type timer.", {
    mode: z.enum(["start", "stop"]).default("start"), seconds: z.number().int().min(0).max(359999).default(60)
  }, args => controlTimerCommands(args));

  eventTool("event_change_access", "Append Change Save/Menu/Encounter/Formation Access (MZ codes 134/135/136/137). MZ 1.8 renumbered these; each boolean means allow (false = forbid).", {
    save: z.boolean().optional(), menu: z.boolean().optional(), encounters: z.boolean().optional(), formation: z.boolean().optional()
  }, args => changeAccessCommands(args));

  eventTool("event_raw_commands", "Universal fallback: insert literal MZ event commands [{code, indent?, parameters}] into an event page. Use it for anything the dedicated event_* tools do not cover (e.g. Fadeout BGM 242, Change Transparent 211, Show Scrolling Text 405, script 355/655, variable-designated transfers). indent defaults to 0; the code 0 terminator is added automatically; complex flows can also be composed by chaining several event_* calls.", {
    commands: z.array(z.record(z.string(), z.unknown())).min(1).max(1000)
  }, args => normalizeRawCommands(args.commands));
}
