import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export async function buildResults(adapter, project) {
  const { buildPluginIR, bundleRuntime } = await import("../../packages/core/src/index.ts");
  const { definePlugin, hook } = await import("../../packages/sdk/src/index.ts");
  const { ir } = buildPluginIR(definePlugin({ name: "result-audit", hooks: [
    hook("tool.error", { id: "errors", run() {} }),
    hook("tool.after", { id: "results", capabilities: { "tool.after.output.replace": "required" }, run() {} }),
  ] }));
  await copyFile(new URL("results.ts", import.meta.url), join(project, "results.ts"));
  const target = { id: "opencode", version: adapter.harness.referenceVersion, delivery: "project", output: "." };
  const bundle = await bundleRuntime({
    source: adapter.shimEntry({ entryImportPath: "./results.ts", harnessVersion: target.version,
      capabilities: { "tool.error.observe": "approximate", "tool.after.observe": "exact", "tool.after.output.replace": "approximate" } }),
    resolveDir: project,
    alias: { ...adapter.shimAliases(), "@hooknostic/sdk": fileURLToPath(new URL("../../packages/sdk/dist/index.js", import.meta.url)) },
  });
  for (const artifact of await adapter.compile(ir, target, bundle, {})) {
    const path = join(project, artifact.path);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, artifact.contents);
  }
}
