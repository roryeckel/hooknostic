import { describe, expect, it } from "vitest";

import { claudeAdapter, COPILOT_EXCLUSION, generateClaudeArtifacts } from "@hooknostic/adapter-claude";
import { copilotHookEntryProblem } from "@hooknostic/adapter-copilot";
import { buildPluginIR } from "@hooknostic/core";
import { block, definePlugin, hook, preventStop } from "@hooknostic/sdk";

// GitHub Copilot CLI also runs `.claude/settings.json` hooks, and one entry its
// loader rejects drops that file's whole `hooks` field (captured on 1.0.101,
// .capture/copilot/README.md). Claude's project entries must be such entries,
// or Copilot runs them as a bare `node` and fails closed on every shell call.
function claudeProjectEntries() {
  const { ir, diagnostics } = buildPluginIR(
    definePlugin({
      name: "coexistence-probe",
      hooks: [
        hook("prompt.before", { id: "baseline", run() {} }),
        hook("tool.before", {
          id: "guard",
          match: { kind: "shell" },
          capabilities: { block: "required" },
          run: () => block("no"),
        }),
        hook("turn.stop", { id: "stop", capabilities: { prevent: "required" }, run: () => preventStop("again") }),
      ],
    }),
  );
  expect(diagnostics).toEqual([]);
  const artifacts = generateClaudeArtifacts(
    ir!,
    { id: "claude", version: ">=2.1 <3", delivery: "project", output: ".hooknostic/artifacts/claude" },
    { code: "// runtime\n" },
    { runtime: { onHookError: "continue", timeoutMs: 5_000, contextCharLimit: 16_000, notifyCharLimit: 2_000 } },
  );
  const integration = claudeAdapter().projectIntegration!(
    artifacts,
    ".hooknostic/artifacts/claude",
    ".agents/hooknostic/hooknostic.config.ts",
  );
  return integration.entries.map((entry) => ({
    event: entry.key.at(-1)!,
    hooks: (entry.value as { hooks: Record<string, unknown>[] }).hooks,
  }));
}

describe("Claude project hooks under GitHub Copilot CLI", () => {
  it("carries an entry Copilot's loader rejects on every event, so Copilot drops the file's hooks", () => {
    const entries = claudeProjectEntries();
    expect(entries.map(({ event }) => event).sort()).toEqual(["PreToolUse", "Stop", "UserPromptSubmit"]);
    for (const { event, hooks } of entries) {
      for (const entry of hooks) {
        expect(entry["timeoutSec"], event).toBe(COPILOT_EXCLUSION);
        expect(copilotHookEntryProblem(event, entry), event).toBe("timeoutSec must be a number");
      }
    }
  });

  it("would otherwise be accepted and run by Copilot, which is the failure the marker prevents", () => {
    for (const { event, hooks } of claudeProjectEntries()) {
      for (const { timeoutSec: _marker, ...entry } of hooks) {
        expect(copilotHookEntryProblem(event, entry), event).toBeUndefined();
      }
    }
  });
});
