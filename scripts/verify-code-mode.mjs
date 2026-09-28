import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./is-main-module.mjs";

/**
 * The Codex build Code Mode hook dispatch was captured on, read from the
 * profile's own `captured` record (.capture/codex-code-mode). The Code Mode
 * playback drives run against it or newer; `referenceVersion` predates it, so
 * the ordinary playback lane skips them.
 */
export function codeModeReferenceVersion(adapter) {
  const records = adapter
    .supportedHarnessVersions()
    .flatMap(
      (range) =>
        adapter.capabilities({ id: adapter.id, version: range, delivery: "project", output: "." }).profilesUsed,
    )
    .flatMap((profile) => profile.source.validatedOn);
  const record = records.find((entry) => entry.artifact === ".capture/codex-code-mode" && entry.method === "captured");
  if (!record) throw new Error(`${adapter.id}: missing Code Mode capture evidence`);
  return record.version;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--print-version")) {
    process.stderr.write("usage: verify-code-mode.mjs [--print-version]\n");
    process.exit(2);
  }
  const { defaultAdapterRegistry } = await import("../packages/cli/dist/index.js");
  const version = codeModeReferenceVersion(defaultAdapterRegistry().codex);
  if (args.includes("--print-version")) console.log(version);
  else {
    const result = spawnSync(
      process.execPath,
      [
        join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs"),
        "run",
        "packages/cli/test/harness-playback.test.ts",
        "-t",
        "uses exactly the captured reference|inside a Code Mode exec",
      ],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        stdio: "inherit",
        env: {
          ...process.env,
          HOOKNOSTIC_PLAYBACK: "codex",
          HOOKNOSTIC_PLAYBACK_VERSION: process.env.HOOKNOSTIC_PLAYBACK_VERSION ?? version,
          // Below the baseline the drives fail instead of skipping, so this
          // gate cannot pass with nothing exercised.
          HOOKNOSTIC_REQUIRE_CODE_MODE: "1",
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
