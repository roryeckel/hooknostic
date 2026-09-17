import { writeFileSync } from "node:fs";

writeFileSync(
  new URL("./native-hooks-fired.json", import.meta.url),
  `${JSON.stringify({ fired: true, pluginRoot: process.env.PLUGIN_ROOT ?? null }, null, 2)}\n`,
);
