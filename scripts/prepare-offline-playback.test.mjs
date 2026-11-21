import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const script = fileURLToPath(new URL("prepare-offline-playback.mjs", import.meta.url));
const run = (...args) =>
  spawnSync(process.execPath, ["--experimental-strip-types", script, ...args], { encoding: "utf8" });

it("rejects a lane it does not know, instead of preparing nothing and passing", () => {
  // A misspelt lane once printed "done" and exited 0; with HOOKNOSTIC_PLAYBACK
  // set to the same misspelling, every playback test then skipped.
  for (const lane of ["codexx", "", "opencode-v3"]) {
    const result = run(...(lane ? [lane] : []));
    expect(result.status, `${lane}: ${result.stdout}${result.stderr}`).toBe(2);
  }
});

it("accepts each lane with nothing to fetch", () => {
  for (const lane of ["claude", "codex", "copilot", "pi"]) {
    const result = run(lane, "--version", "0.0.0");
    expect(result.status, `${lane}: ${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`prepare-offline-playback ${lane}: done`);
  }
});
