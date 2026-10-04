/**
 * Repair the engine keys a project is missing, before a suite boots a game in it.
 *
 *   import { ensureBoots } from "./ensure-bootable.mjs";
 *   await ensureBoots(call);
 *
 * Why this is a shared step rather than a note in the README: a project copied from the
 * engine's `data/newdata` template has no `System.advanced.windowOpacity`, and the engine
 * throws the first frame it reads it. The game then sits on its title screen with its loop
 * dead, so a suite that boots one fails *somewhere else entirely* — a third-round reviewer
 * following the fifteen-minute path got `6 PASS / 2 FAIL` out of `verify:input` and the
 * output named the key bindings, not the missing key.
 *
 * `fix_project` is idempotent and only writes what the engine reads without a fallback, so
 * calling it unconditionally costs one read on a project the editor built and saves a
 * confusing run on one that was not.
 */
export async function ensureBoots(call, log = line => console.log(line)) {
    const fixed = await call("fix_project", {});
    if (fixed?.changed) {
        log(`fix_project wrote ${JSON.stringify(fixed.repaired)} — without them the engine throws on its first frame and no game comes up`);
    }
    for (const blocked of fixed?.cannotFix ?? []) {
        log(`fix_project left ${blocked.path} alone: ${blocked.why}`);
    }
    return fixed;
}
