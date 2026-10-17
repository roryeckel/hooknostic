import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runProcess } from "./harness-playback.js";

describe.skipIf(process.env["HOOKNOSTIC_PLAYBACK"] !== "pi")("Pi generated default role playback", () => {
  it("delivers the native append and honours trust, custom system prompts, and CLI precedence", async () => {
    const result = await runProcess(
      process.execPath,
      ["--experimental-strip-types", ".capture/pi-default-agent/drive.mjs", "--generated-only"],
      {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        env: process.env,
        timeoutMs: 240_000,
      },
    );
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("COMPLETED 5 native Pi probes");
  }, 300_000);
});
