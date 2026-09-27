import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./is-main-module.mjs";

/** Keep the package baseline attached to evidence, separate from old project fixtures. */
export function packageReferenceVersion(adapter) {
  const artifact = adapter.id === "codex" ? ".capture/codex-plugin-hooks" : ".capture/claude-marketplace-deps";
  const records = adapter.agentPluginProjector?.profiles.flatMap((profile) => profile.source.validatedOn) ?? [];
  const record = records.find((entry) => entry.artifact === artifact && entry.method === "live-probe");
  if (!record) throw new Error(`${adapter.id}: missing marketplace validation evidence`);
  return record.version;
}

export function requirePackageSupport(level) {
  if (level === undefined || level === "unsupported") {
    throw new Error("Marketplace verification requires a package-capable harness; no scenario may pass by omission.");
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const id = process.argv[2];
  if (!["claude", "codex"].includes(id))
    throw new Error("usage: verify-marketplaces.mjs <claude|codex> [--print-version]");
  const { defaultAdapterRegistry } = await import("../packages/cli/dist/index.js");
  const version = packageReferenceVersion(defaultAdapterRegistry()[id]);
  if (process.argv.includes("--print-version")) console.log(version);
  else {
    const result = spawnSync(
      process.execPath,
      [
        join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs"),
        "run",
        "packages/cli/test/marketplace-example.test.ts",
        "packages/cli/test/harness-playback.test.ts",
        "-t",
        "marketplace example|uses exactly the captured reference|through an installed plugin|starts a projected MCP server",
      ],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        stdio: "inherit",
        env: {
          ...process.env,
          HOOKNOSTIC_PLAYBACK: id,
          HOOKNOSTIC_PLAYBACK_VERSION: process.env.HOOKNOSTIC_PLAYBACK_VERSION ?? version,
          HOOKNOSTIC_REQUIRE_PACKAGE: "1",
          HOOKNOSTIC_SMOKE: "",
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "",
          OPENAI_API_KEY: "",
          OPENROUTER_API_KEY: "",
        },
      },
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
}
