import { describe, expect, it } from "vitest";
import { block, definePlugin, hook, replaceInput } from "@hooknostic/sdk";
import { buildPluginIR } from "@hooknostic/core";
import { claudeAdapter } from "./index.js";
import { generateClaudeArtifacts } from "./generate.js";

const TARGET = { id: "claude", version: ">=2.1", mode: "plugin" as const, output: "./dist/claude" };
const BUNDLE = { code: "// bundled runtime placeholder\n" };

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
    const artifacts = generateClaudeArtifacts(exampleIR(), TARGET, BUNDLE);
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
      timeout: 60,
    });

    expect(artifacts[2]!.contents).toBe(BUNDLE.code);
  });

  it("passes its own artifact validation", async () => {
    const adapter = claudeAdapter();
    const artifacts = generateClaudeArtifacts(exampleIR(), TARGET, BUNDLE);
    const diagnostics = await adapter.validateArtifacts!(artifacts, TARGET);
    expect(diagnostics).toEqual([]);
  });

  it("is deterministic", () => {
    const a = generateClaudeArtifacts(exampleIR(), TARGET, BUNDLE);
    const b = generateClaudeArtifacts(exampleIR(), TARGET, BUNDLE);
    expect(a).toEqual(b);
  });
});

describe("claudeAdapter capability data", () => {
  it("resolves the 2.x profile with rationale on every non-exact cell", () => {
    const resolved = claudeAdapter().capabilities(TARGET);
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.matrix?.["tool.before.block"]?.level).toBe("exact");
    for (const [id, entry] of Object.entries(resolved.matrix ?? {})) {
      if (entry.level !== "exact") {
        expect(entry.rationale, `capability ${id} needs a rationale`).toBeTruthy();
      }
    }
  });

  it("reports HN203 outside validated ranges", () => {
    const resolved = claudeAdapter().capabilities({ ...TARGET, version: ">=99" });
    expect(resolved.diagnostics[0]?.code).toBe("HN203");
  });
});
