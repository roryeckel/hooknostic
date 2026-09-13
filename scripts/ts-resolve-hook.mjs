// Module-resolution hook for scripts/drive-capture-session.mjs (registered via
// module.register). Three jobs:
// 1. Rewrite sibling ".js" specifiers to ".ts" for hooknostic workspace
//    sources, so startModelPlayback (packages/cli/test/harness-playback.ts)
//    imports unbuilt TS under node --experimental-strip-types. Scoped to
//    packages/: the driver's own specifiers stay untouched.
// 2. Shadow bare "vitest" with scripts/vitest-stub.mjs for the same import —
//    the real vitest throws outside its runtime, and harness-playback.ts only
//    references expect() in fixture-replay helpers the drift lane never calls.
// 3. Retry extensionless relative specifiers with ".js". Some node_modules
//    ESM builds (jsonc-parser's lib/esm) use bundler-style extensionless
//    internal imports that plain Node cannot resolve; every other consumer of
//    that dependency goes through a bundler (vitest, the esbuild CLI bundle),
//    so the driver's plain-Node loader is the only lane that needs the retry.
const WORKSPACE = new URL("../packages/", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "vitest" && context.parentURL?.startsWith(WORKSPACE)) {
    return { url: new URL("vitest-stub.mjs", import.meta.url).href, shortCircuit: true };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.startsWith(WORKSPACE)) {
      const tsUrl = new URL(specifier, context.parentURL).href.replace(/\.js$/, ".ts");
      try {
        return await nextResolve(tsUrl, context);
      } catch {
        // fall through to the original error
      }
    }
    if (specifier.startsWith(".") && !/\.[^/]+$/.test(specifier)) {
      // Extensionless relative import: retry with ".js" (bundler-style ESM).
      // Scoped to node_modules parents: workspace TS files import with
      // extensions by convention, and the ".js" retry must not shadow a
      // genuinely missing workspace module with an unrelated error. Only
      // truly extensionless specifiers are retried — an import like
      // "./data.json" that failed must surface its own error, not risk
      // binding to an unrelated "./data.json.js" sibling.
      const parent = context.parentURL ?? "";
      if (parent.includes("/node_modules/")) {
        const jsUrl = `${specifier}.js`;
        try {
          return await nextResolve(jsUrl, context);
        } catch {
          // fall through to the original error
        }
      }
    }
    throw error;
  }
}
