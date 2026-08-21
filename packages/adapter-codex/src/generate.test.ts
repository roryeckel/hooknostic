import { describe, expect, it } from "vitest";
import { block, definePlugin, hook } from "@hooknostic/sdk";
import { buildPluginIR } from "@hooknostic/core";
import { codexAdapter } from "./index.js";
import { generateCodexArtifacts } from "./generate.js";

const TARGET = { id: "codex", version: ">=0.148", mode: "local" as const, output: "./dist/codex" };
const BUNDLE = { code: "// bundled runtime placeholder\n" };
const OPTIONS = {
  runtime: { onHookError: "continue" as const, timeoutMs: 5_000, contextCharLimit: 16_000 },
};

function exampleIR() {
  const { ir, diagnostics } = buildPluginIR(
    definePlugin({
      name: "portable-repo-hooks",
      hooks: [
        hook("tool.before", {
          id: "guard",
          capabilities: { "tool.before.block": "required" },
          async run() {
            return block("no");
          },
        }),
        hook("turn.stop", { id: "s", async run() {} }),
      ],
    }),
  );
  expect(diagnostics).toEqual([]);
  return ir!;
}

describe("generateCodexArtifacts", () => {
  it("emits a self-contained repo-level .codex directory", () => {
    const artifacts = generateCodexArtifacts(exampleIR(), TARGET, BUNDLE, OPTIONS);
    expect(artifacts.map((a) => a.path)).toEqual([
      ".codex/hooks.json",
      ".codex/hooknostic/hooknostic.mjs",
    ]);
    const hooksJson = JSON.parse(artifacts[0]!.contents);
    expect(Object.keys(hooksJson.hooks)).toEqual(["PreToolUse", "Stop"]);
    expect(hooksJson.hooks.PreToolUse[0].hooks[0]).toEqual({
      type: "command",
      command: "node .codex/hooknostic/hooknostic.mjs",
      timeout: 6,
    });
  });

  it("refuses plugin mode for the validated range (plugin_hooks removed)", () => {
    expect(() =>
      generateCodexArtifacts(exampleIR(), { ...TARGET, mode: "plugin" }, BUNDLE, OPTIONS),
    ).toThrow(/plugin_hooks/);
  });

  it("passes its own artifact validation", async () => {
    const adapter = codexAdapter();
    const artifacts = generateCodexArtifacts(exampleIR(), TARGET, BUNDLE, OPTIONS);
    expect(await adapter.validateArtifacts!(artifacts, TARGET)).toEqual([]);
  });

  it("does not preempt runtime timeouts longer than 60 seconds", () => {
    const artifacts = generateCodexArtifacts(exampleIR(), TARGET, BUNDLE, {
      runtime: { ...OPTIONS.runtime, timeoutMs: 61_000 },
    });
    const hooksJson = JSON.parse(artifacts[0]!.contents);
    expect(hooksJson.hooks.PreToolUse[0].hooks[0].timeout).toBe(62);
  });
});

describe("codexAdapter capability data", () => {
  it("resolves the 0.14x profile with rationale on every non-exact cell", () => {
    const resolved = codexAdapter().capabilities(TARGET);
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.matrix?.["tool.before.requestApproval"]?.level).toBe("exact");
    expect(resolved.matrix?.["tool.after.output.replace"]?.level).toBe("approximate");
    expect(resolved.matrix?.["tool.error.observe"]).toBeUndefined();
    expect(resolved.matrix?.["context.compact.before.block"]).toBeUndefined();
    for (const [id, entry] of Object.entries(resolved.matrix ?? {})) {
      if (entry.level !== "exact") {
        expect(entry.rationale, `capability ${id} needs a rationale`).toBeTruthy();
      }
    }
  });

  it("errors on tool.error requirements through analysis (event unavailable)", () => {
    const resolved = codexAdapter().capabilities({ ...TARGET, version: ">=5" });
    expect(resolved.diagnostics[0]?.code).toBe("HN203");
  });
});
