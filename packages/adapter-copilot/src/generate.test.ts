import { describe, expect, it } from "vitest";

import { buildPluginIR } from "@hooknostic/core";
import { block, definePlugin, hook } from "@hooknostic/sdk";

import { COPILOT_NATIVE_EVENT, generateCopilotArtifacts } from "./generate.js";
import { copilotHarness } from "./harness.js";
import { copilotAdapter } from "./index.js";
import { projectIntegration } from "./project.js";

const PACKAGE_TARGET = {
  id: "copilot",
  version: copilotHarness.recommendedRange,
  delivery: "package" as const,
  output: "./dist/copilot",
};
const PROJECT_TARGET = { ...PACKAGE_TARGET, delivery: "project" as const };
const BUNDLE = { code: "// bundled runtime placeholder\n" };
const OPTIONS = {
  runtime: { onHookError: "continue" as const, timeoutMs: 5_000, contextCharLimit: 16_000, notifyCharLimit: 2_000 },
};

function exampleIR() {
  const { ir, diagnostics } = buildPluginIR(
    definePlugin({
      name: "portable-copilot-hooks",
      version: "1.2.3",
      description: "Example",
      hooks: [
        hook("tool.before", {
          id: "protect-shell",
          match: { kind: "shell" },
          capabilities: { "tool.before.block": "required" },
          async run() {
            return block("no");
          },
        }),
        hook("session.start", { id: "ctx", capabilities: { "session.start.context.add": "required" }, async run() {} }),
        hook("tool.before", { id: "second-tool-hook", async run() {} }),
        hook("turn.stop", {
          id: "claude-only",
          targets: { include: ["claude"] },
          async run() {},
        }),
      ],
    }),
  );
  expect(diagnostics).toEqual([]);
  return ir!;
}

describe("generateCopilotArtifacts", () => {
  it("emits an Agent Plugins package with hooks under com.github.copilot", () => {
    const artifacts = generateCopilotArtifacts(exampleIR(), PACKAGE_TARGET, BUNDLE, OPTIONS);
    expect(artifacts.map((artifact) => artifact.path)).toEqual([
      "plugin.json",
      "com.github.copilot/hooks/hooks.json",
      "runtime/hooknostic.mjs",
    ]);
    expect(JSON.parse(artifacts[0]!.contents as string)).toEqual({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "portable-copilot-hooks",
      version: "1.2.3",
      description: "Example",
    });

    const hooks = JSON.parse(artifacts[1]!.contents as string);
    // Two tool.before hooks share ONE preToolUse dispatcher; the excluded
    // turn.stop hook contributes no agentStop entry for this target.
    expect(Object.keys(hooks.hooks).sort()).toEqual(["preToolUse", "sessionStart"]);
    expect(hooks.hooks.preToolUse).toHaveLength(1);
    expect(hooks.hooks.preToolUse[0]).not.toHaveProperty("matcher");
    expect(hooks.hooks.preToolUse[0]).toEqual({
      type: "command",
      exec: "node",
      args: ["${PLUGIN_ROOT}/runtime/hooknostic.mjs", "preToolUse"],
      // Two hooks reach preToolUse, each with its own 5s budget, plus one.
      timeoutSec: 11,
    });
    expect(hooks.hooks.sessionStart[0].timeoutSec).toBe(6);
    expect(artifacts[2]!.contents).toBe(BUNDLE.code);
  });

  it("emits a project hooks document whose runtime argument sync rewrites", () => {
    const artifacts = generateCopilotArtifacts(exampleIR(), PROJECT_TARGET, BUNDLE, OPTIONS);
    expect(artifacts.map((artifact) => artifact.path)).toEqual(["hooks/hooknostic.json", "runtime/hooknostic.mjs"]);
    const integration = projectIntegration(artifacts, "dist/copilot");
    expect(integration.files.map((file) => file.path)).toEqual([".github/hooks/hooknostic.json"]);
    const written = JSON.parse(integration.files[0]!.contents as string);
    expect(written.hooks.preToolUse[0].args).toEqual(["dist/copilot/runtime/hooknostic.mjs", "preToolUse"]);
    // The compiled artifact itself is untouched; the relocation is the sync's.
    expect(JSON.parse(artifacts[0]!.contents as string).hooks.preToolUse[0].args[0]).toBe("runtime/hooknostic.mjs");
    expect(integration.guidance.join(" ")).toMatch(/project root/);
    expect(integration.guidance.join(" ")).toMatch(/trust/i);
  });

  it("keeps a root output's runtime argument relative to the project root", () => {
    const artifacts = generateCopilotArtifacts(exampleIR(), { ...PROJECT_TARGET, output: "." }, BUNDLE, OPTIONS);
    const written = JSON.parse(projectIntegration(artifacts, ".").files[0]!.contents as string);
    expect(written.hooks.preToolUse[0].args[0]).toBe("runtime/hooknostic.mjs");
  });

  it("passes its own artifact validation on both deliveries", async () => {
    const adapter = copilotAdapter();
    for (const target of [PACKAGE_TARGET, PROJECT_TARGET]) {
      const diagnostics = await adapter.validateArtifacts!(
        generateCopilotArtifacts(exampleIR(), target, BUNDLE, OPTIONS),
        target,
      );
      expect(diagnostics, target.delivery).toEqual([]);
    }
  });

  it("rejects a hooks document that does not pass its native event to the runtime", async () => {
    const adapter = copilotAdapter();
    const artifacts = generateCopilotArtifacts(exampleIR(), PACKAGE_TARGET, BUNDLE, OPTIONS);
    const hooks = JSON.parse(artifacts[1]!.contents as string);
    hooks.hooks.preToolUse[0].args[1] = "PreToolUse";
    artifacts[1] = { ...artifacts[1]!, contents: `${JSON.stringify(hooks)}\n` };
    const diagnostics = await adapter.validateArtifacts!(artifacts, PACKAGE_TARGET);
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["HN301"]);
  });

  it("is deterministic", () => {
    expect(generateCopilotArtifacts(exampleIR(), PACKAGE_TARGET, BUNDLE, OPTIONS)).toEqual(
      generateCopilotArtifacts(exampleIR(), PACKAGE_TARGET, BUNDLE, OPTIONS),
    );
  });

  it("declares a native event for every canonical event the harness has", () => {
    expect(Object.keys(COPILOT_NATIVE_EVENT).sort()).toEqual(
      [
        "agent.start",
        "agent.stop",
        "context.compact.after",
        "context.compact.before",
        "model.request.before",
        "permission.request",
        "prompt.before",
        "session.end",
        "session.start",
        "tool.after",
        "tool.before",
        "tool.error",
        "turn.stop",
      ].sort(),
    );
    expect(COPILOT_NATIVE_EVENT["model.request.before"]).toBeUndefined();
    expect(COPILOT_NATIVE_EVENT["context.compact.after"]).toBeUndefined();
  });

  it("resolves the 1.x profile and reports HN203 outside it", () => {
    const adapter = copilotAdapter();
    expect(adapter.capabilities(PACKAGE_TARGET).diagnostics).toEqual([]);
    expect(adapter.capabilities({ ...PACKAGE_TARGET, version: ">=2" }).diagnostics[0]?.code).toBe("HN203");
  });
});
