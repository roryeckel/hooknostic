import { mkdir, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AdapterRegistry } from "@hooknostic/core";
import type { CommandIO } from "./check.js";
export async function runInit(config: string, registry: AdapterRegistry, io: CommandIO, json: boolean): Promise<number> {
  const path = resolve(config);
  const root = dirname(path);
  const targets = Object.fromEntries(Object.values(registry).filter(a => a.projectIntegration).map(a => [a.id, { adapter: a.id, version: a.harness.recommendedRange, delivery: "project", output: `.hooknostic/artifacts/${a.id}` }]));
  const files = [
    [path, `import { defineConfig } from "@hooknostic/sdk";\nexport default defineConfig(${JSON.stringify({ project: { root: "." }, entry: "./hooks.ts", targets }, null, 2)});\n`],
    [join(root, "hooks.ts"), 'import { definePlugin } from "@hooknostic/sdk";\nexport default definePlugin({ name: "sample-project", hooks: [] });\n'],
  ];
  const created: string[] = [];
  for (const [file, contents] of files) {
    await mkdir(dirname(file!), { recursive: true });
    try {
      const handle = await open(file!, "wx");
      try { await handle.writeFile(contents!); } finally { await handle.close(); }
      created.push(file!);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  if (json) io.stdout(JSON.stringify({ schemaVersion: 1, command: "init", created }));
  else io.stdout(`Created ${created.length} files. Install Hooknostic and its SDK with your package manager, then run hooknostic sync.`);
  return 0;
}
