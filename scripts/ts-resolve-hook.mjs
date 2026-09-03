// Module-resolution hook for scripts/drive-capture-session.mjs (registered via
// module.register). Two jobs:
// 1. Rewrite sibling ".js" specifiers to ".ts" for hooknostic workspace
//    sources, so startModelPlayback (packages/cli/test/harness-playback.ts)
//    imports unbuilt TS under node --experimental-strip-types. Scoped to
//    packages/: the driver's own specifiers stay untouched.
// 2. Shadow bare "vitest" with scripts/vitest-stub.mjs for the same import —
//    the real vitest throws outside its runtime, and harness-playback.ts only
//    references expect() in fixture-replay helpers the drift lane never calls.
const WORKSPACE = new URL("../packages/", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "vitest" && context.parentURL?.startsWith(WORKSPACE)) {
    return { url: new URL("vitest-stub.mjs", import.meta.url).href, shortCircuit: true };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      specifier.startsWith(".") &&
      specifier.endsWith(".js") &&
      context.parentURL?.startsWith(WORKSPACE)
    ) {
      const tsUrl = new URL(specifier, context.parentURL).href.replace(/\.js$/, ".ts");
      try {
        return await nextResolve(tsUrl, context);
      } catch {
        // fall through to the original error
      }
    }
    throw error;
  }
}