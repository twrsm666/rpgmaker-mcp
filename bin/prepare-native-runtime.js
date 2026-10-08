import { parseArgs } from "node:util";
import { prepareNativeRuntime } from "../src/native-runtime.js";
import { requiredEngine } from "./local-config.js";
const { values } = parseArgs({ options: { engine: { type: "string" } } });
const engine = requiredEngine(values.engine || process.env.RPG_MCP_ENGINE);
console.log(JSON.stringify(await prepareNativeRuntime(engine), null, 2));
