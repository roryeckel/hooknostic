import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const driver = fileURLToPath(new URL("./drive-capture-session.mjs", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [driver, "pi", ...args], { encoding: "utf8", timeout: 150_000 });

it("reports Pi paid capture as inconclusive before probing a provider", () => {
  const result = run("--transport", "llm");
  expect(result.status, result.stderr).toBe(5);
  expect(result.stderr).toContain("Pi paid drift capture is not established");
});

it.skipIf(process.env.HOOKNOSTIC_PLAYBACK !== "pi")(
  "captures and compares a real Pi loopback exchange",
  () => {
    const scratch = mkdtempSync(join(tmpdir(), "hooknostic-pi-drift-test-"));
    try {
      const result = run("--transport", "playback", "--scratch", scratch);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("Verdict: clean");
      const call = JSON.parse(readFileSync(join(scratch, "captured/tool_call.jsonl"), "utf8").trim());
      expect(call.payload.event.toolName).toBe("bash");
      expect(call.payload.event.input.command).toContain("hooknostic-original");
      expect(readFileSync(join(scratch, "hooknostic-tool.txt"), "utf8")).toBe("hooknostic-original");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
  150_000,
);
