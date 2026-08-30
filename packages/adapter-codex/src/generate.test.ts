import { describe, expect, it } from "vitest";
import { block, definePlugin, hook } from "@hooknostic/sdk";
import { buildPluginIR } from "@hooknostic/core";
import { codexAdapter } from "./index.js";
import { generateCodexArtifacts } from "./generate.js";

const TARGET = { id: "codex", version: ">=0.148 <1", mode: "local" as const, output: "./dist/codex" };
const BUNDLE = { code: "// bundled runtime placeholder\n" };
const OPTIONS = {
  runtime: { onHookError: "continue" as const, timeoutMs: 5_000, contextCharLimit: 16_000, notifyCharLimit: 2_000 },
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

  it("covers every hook on the event, and refuses a capped event it cannot fit", () => {
    // This fixture had one hook per native event, so sum-of-budgets and the old
    // single-budget formula produced identical numbers -- the Codex half of the
    // derivation was asserted by nothing and stayed green when reverted.
    const ir = exampleIR();
    ir.hooks.push({
      index: ir.hooks.length,
      event: "tool.before",
      id: "second-tool-hook",
      capabilities: {},
    });
    const artifacts = generateCodexArtifacts(ir, TARGET, BUNDLE, OPTIONS);
    const hooksJson = JSON.parse(
      artifacts.find((a) => a.path.endsWith("hooks.json"))!.contents,
    );
    expect(hooksJson.hooks.PreToolUse[0].hooks[0].timeout).toBe(11);

    // codex-cli clamps SessionEnd to 3s, so the 5s default cannot fit and the
    // build must say so rather than emit a manifest asking for time it will not
    // be given.
    const capped = exampleIR();
    capped.hooks.push({
      index: capped.hooks.length,
      event: "session.end",
      id: "teardown",
      capabilities: {},
    });
    expect(() => generateCodexArtifacts(capped, TARGET, BUNDLE, OPTIONS)).toThrow(
      /SessionEnd.*grants at most 3s/,
    );
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
    // The rationale sweep lives in the shared adapter contract
    // (@hooknostic/testkit), so it covers a third-party adapter too. These
    // assertions stay because they pin THIS adapter's specific ratings.
  });

  it("errors on tool.error requirements through analysis (event unavailable)", () => {
    const resolved = codexAdapter().capabilities({ ...TARGET, version: ">=5" });
    expect(resolved.diagnostics[0]?.code).toBe("HN203");
  });
});
