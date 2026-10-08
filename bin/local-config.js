import path from "node:path";
import { fileURLToPath } from "node:url";
export const serviceRoot = fileURLToPath(new URL("../", import.meta.url));
export function requiredEngine(value = process.env.RPG_MCP_ENGINE) {
  if (!value) throw new Error("Set RPG_MCP_ENGINE to your licensed RPG Maker MZ installation directory, or supply --engine.");
  return path.resolve(value);
}
export const testWork = process.env.RPG_MCP_TEST_WORK || path.join(serviceRoot, ".work");
