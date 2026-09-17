import { writeFileSync } from "node:fs";

// The argument names the source that ran, so the marker says which document
// Codex read rather than merely that something fired.
const which = process.argv[2] ?? "unnamed";
writeFileSync(
  new URL(`./hooks-${which}-fired.json`, import.meta.url),
  `${JSON.stringify({ fired: true, entry: which, pluginRoot: process.env.PLUGIN_ROOT ?? null }, null, 2)}\n`,
);
