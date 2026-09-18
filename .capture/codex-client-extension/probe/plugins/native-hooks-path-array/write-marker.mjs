import { writeFileSync } from "node:fs";

// One script, two documents: the argument names which entry of the hooks
// array ran, so a single marker cannot be mistaken for both.
const which = process.argv[2] ?? "unnamed";
writeFileSync(
  new URL(`./hooks-${which}-fired.json`, import.meta.url),
  `${JSON.stringify({ fired: true, entry: which, pluginRoot: process.env.PLUGIN_ROOT ?? null }, null, 2)}\n`,
);
