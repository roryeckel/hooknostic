import { writeFileSync } from "node:fs";

// One script, two inline documents: the argument names which array entry
// ran, so a single marker cannot be mistaken for both.
const which = process.argv[2] ?? "unnamed";
writeFileSync(
  new URL(`./hooks-${which}-fired.json`, import.meta.url),
  `${JSON.stringify({ fired: true, entry: which, pluginRoot: process.env.PLUGIN_ROOT ?? null }, null, 2)}\n`,
);
