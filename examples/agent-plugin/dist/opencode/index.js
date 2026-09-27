import hooks from "./hooknostic.js";
import components from "./hooknostic-agent-plugin.js";
const plugins = [hooks, components];
export default { id: "hooknostic.package.combined-example", async setup(ctx) {
  const cleanups = [];
  try { for (const plugin of plugins) { const cleanup = await plugin.setup(ctx); if (cleanup) cleanups.push(cleanup); } }
  catch (error) { await Promise.allSettled(cleanups.map(cleanup => cleanup())); throw error; }
  return async () => { await Promise.allSettled(cleanups.map(cleanup => cleanup())); };
} };
