import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export async function buildGuard(adapter, project) {
  const { buildPluginIR, bundleRuntime } = await import("../../packages/core/src/index.ts");
  const { definePlugin, hook } = await import("../../packages/sdk/src/index.ts");
  // Declaration mirrors guard.ts; the compiled runtime uses guard.ts itself.
  const plugin = definePlugin({ name: "mcp-name-guard", hooks: [hook("tool.before", {
    id: "mcp-name-guard", match: { nativeName: "hooknostic_hooknostic_echo" },
    capabilities: { "tool.before.block": "required" }, run() {},
  })] });
  const { ir } = buildPluginIR(plugin);
  if (!ir) throw new Error("MCP guard IR failed");
  await copyFile(new URL("./guard.ts", import.meta.url), join(project, "mcp-guard.ts"));
  const target = { id: "opencode", version: adapter.harness.referenceVersion, delivery: "project", output: "." };
  const bundle = await bundleRuntime({
    source: adapter.shimEntry({ entryImportPath: "./mcp-guard.ts", harnessVersion: target.version,
      capabilities: { "tool.before.observe": "exact", "tool.before.block": "exact" } }),
    resolveDir: project,
    alias: { ...adapter.shimAliases(), "@hooknostic/sdk": fileURLToPath(new URL("../../packages/sdk/dist/index.js", import.meta.url)) },
  });
  const artifacts = await adapter.compile(ir, target, bundle, {});
  for (const artifact of artifacts) {
    const path = join(project, artifact.path);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, artifact.contents);
  }
}
