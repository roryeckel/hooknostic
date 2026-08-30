import { describe, expect, it } from "vitest";
import { block, definePlugin, hook, replaceInput } from "@hooknostic/sdk";
import { buildPluginIR } from "@hooknostic/core";
import { claudeAdapter } from "./index.js";
import { generateClaudeArtifacts } from "./generate.js";
import { claudeHarness } from "./harness.js";

const TARGET = { id: "claude", version: claudeHarness.recommendedRange, mode: "plugin" as const, output: "./dist/claude" };
const BUNDLE = { code: "// bundled runtime placeholder\n" };
const OPTIONS = {
  runtime: { onHookError: "continue" as const, timeoutMs: 5_000, contextCharLimit: 16_000, notifyCharLimit: 2_000 },
};

function exampleIR() {
  const { ir, diagnostics } = buildPluginIR(
    definePlugin({
      name: "portable-repo-hooks",
      version: "1.2.3",
      description: "Example",
      hooks: [
        hook("tool.before", {
          id: "protect-shell",
          match: { kind: "shell" },
          capabilities: {
            "tool.before.block": "required",
            "tool.before.input.replace": "optional",
          },
          async run(_e, ctx) {
            if (ctx.capabilities.has("tool.before.input.replace")) return replaceInput({});
            return block("no");
          },
        }),
        hook("session.start", { id: "ctx", async run() {} }),
        hook("tool.before", {
          id: "second-tool-hook",
          async run() {},
        }),
        hook("turn.stop", {
          id: "opencode-only",
          targets: { include: ["opencode"] },
          async run() {},
        }),
      ],
    }),
  );
  expect(diagnostics).toEqual([]);
  return ir!;
}

describe("generateClaudeArtifacts", () => {
  it("emits a self-contained plugin artifact with one dispatcher per used native event", () => {
    const artifacts = generateClaudeArtifacts(exampleIR(), TARGET, BUNDLE, OPTIONS);
    expect(artifacts.map((a) => a.path)).toEqual([
      ".claude-plugin/plugin.json",
      "hooks/hooks.json",
      "runtime/hooknostic.mjs",
    ]);

    const pluginJson = JSON.parse(artifacts[0]!.contents);
    expect(pluginJson).toEqual({
      name: "portable-repo-hooks",
      version: "1.2.3",
      description: "Example",
    });

    const hooksJson = JSON.parse(artifacts[1]!.contents);
    // two tool.before hooks → ONE PreToolUse dispatcher; excluded turn.stop
    // hook contributes no Stop entry for this target.
    expect(Object.keys(hooksJson.hooks)).toEqual(["PreToolUse", "SessionStart"]);
    expect(hooksJson.hooks.PreToolUse).toHaveLength(1);
    const command = hooksJson.hooks.PreToolUse[0].hooks[0];
    // exec form: command + args array, no shell string interpolation.
    expect(command).toEqual({
      type: "command",
      command: "node",
      args: ["${CLAUDE_PLUGIN_ROOT}/runtime/hooknostic.mjs"],
      // Two hooks reach PreToolUse and the dispatcher runs both, each under its
      // own budget -- so the native ceiling covers the pair (2 x 5s + 1), not
      // one of them. Sized for a single hook, the harness killed the process
      // mid-dispatch and the response was not partial but absent.
      timeout: 11,
    });
    // SessionStart has one hook, so it keeps the single-hook ceiling.
    expect(hooksJson.hooks.SessionStart[0].hooks[0].timeout).toBe(6);

    expect(artifacts[2]!.contents).toBe(BUNDLE.code);
  });

  it("passes its own artifact validation", async () => {
    const adapter = claudeAdapter();
    const artifacts = generateClaudeArtifacts(exampleIR(), TARGET, BUNDLE, OPTIONS);
    const diagnostics = await adapter.validateArtifacts!(artifacts, TARGET);
    expect(diagnostics).toEqual([]);
  });

  it("is deterministic", () => {
    const a = generateClaudeArtifacts(exampleIR(), TARGET, BUNDLE, OPTIONS);
    const b = generateClaudeArtifacts(exampleIR(), TARGET, BUNDLE, OPTIONS);
    expect(a).toEqual(b);
  });

  // PreToolUse carries two hooks in this fixture, so the ceiling is the pair.
  it.each([
    [1, 2],
    [1_000, 3],
    [61_000, 123],
  ])("covers every hook on the event: runtime %ims -> native %is", (timeoutMs, expected) => {
    const artifacts = generateClaudeArtifacts(exampleIR(), TARGET, BUNDLE, {
      runtime: { ...OPTIONS.runtime, timeoutMs },
    });
    const hooksJson = JSON.parse(artifacts[1]!.contents);
    expect(hooksJson.hooks.PreToolUse[0].hooks[0].timeout).toBe(expected);
  });

  it("lets one slow hook raise its own ceiling without inflating its neighbours", () => {
    // The reason a per-hook budget exists: a hook that shells out to a linter
    // needs minutes, and before this it had to buy those minutes for every hook
    // in the plugin -- including a string matcher whose bug would then hang the
    // harness for the same minutes.
    const ir = exampleIR();
    ir.hooks[0]!.timeoutMs = 120_000;
    const artifacts = generateClaudeArtifacts(ir, TARGET, BUNDLE, OPTIONS);
    const hooksJson = JSON.parse(artifacts[1]!.contents);
    // 120s for the slow hook + 5s for its neighbour, + 1.
    expect(hooksJson.hooks.PreToolUse[0].hooks[0].timeout).toBe(126);
    // The event it does not touch is unchanged.
    expect(hooksJson.hooks.SessionStart[0].hooks[0].timeout).toBe(6);
  });
});

describe("claudeAdapter capability data", () => {
  it("resolves the 2.x profile with rationale on every non-exact cell", () => {
    const resolved = claudeAdapter().capabilities(TARGET);
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.matrix?.["tool.before.block"]?.level).toBe("exact");
    // The rationale sweep lives in the shared adapter contract
    // (@hooknostic/testkit), so it covers a third-party adapter too. These
    // assertions stay because they pin THIS adapter's specific ratings.
  });

  it("reports HN203 outside validated ranges", () => {
    const resolved = claudeAdapter().capabilities({ ...TARGET, version: ">=99" });
    expect(resolved.diagnostics[0]?.code).toBe("HN203");
  });
});
