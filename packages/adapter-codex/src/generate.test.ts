import { describe, expect, it } from "vitest";

import { buildPluginIR } from "@hooknostic/core";
import { block, definePlugin, hook } from "@hooknostic/sdk";

import { CODEX_NATIVE_MATCHER_RANGE, CODEX_PLUGIN_MODE_RANGE, generateCodexArtifacts } from "./generate.js";
import { codexHarness } from "./harness.js";
import { codexAdapter } from "./index.js";

const TARGET = {
  id: "codex",
  version: codexHarness.recommendedRange,
  delivery: "project" as const,
  output: "./dist/codex",
};
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
    expect(artifacts.map((a) => a.path)).toEqual([".codex/hooks.json", ".codex/hooknostic/hooknostic.mjs"]);
    const hooksJson = JSON.parse(artifacts[0]!.contents as string);
    expect(Object.keys(hooksJson.hooks)).toEqual(["PreToolUse", "Stop"]);
    expect(hooksJson.hooks.PreToolUse[0].hooks[0]).toEqual({
      type: "command",
      command: "node .codex/hooknostic/hooknostic.mjs",
      timeout: 6,
    });
  });

  // A plugin hook command resolves against the session cwd, not the install
  // cache (.capture/codex-plugin-hooks), so the relative form the local artifact
  // uses would silently find nothing here.
  it("anchors the plugin-mode command to the plugin root", () => {
    const artifacts = generateCodexArtifacts(
      exampleIR(),
      { ...TARGET, delivery: "package", version: CODEX_PLUGIN_MODE_RANGE },
      BUNDLE,
      OPTIONS,
    );
    expect(artifacts.map((a) => a.path).sort()).toEqual([
      ".codex-plugin/plugin.json",
      "hooknostic/hooknostic.mjs",
      "hooks.json",
    ]);
    // The manifest is what makes the tree installable at all, and ${PLUGIN_ROOT}
    // below only resolves inside an installed plugin.
    const manifest = JSON.parse(String(artifacts.find((a) => a.path === ".codex-plugin/plugin.json")!.contents));
    expect(manifest).toMatchObject({ hooks: "./hooks.json" });
    const hooks = JSON.parse(String(artifacts.find((a) => a.path === "hooks.json")!.contents));
    const commands = Object.values(hooks.hooks as Record<string, { hooks: { command: string }[] }[]>).flatMap(
      (groups) => groups.flatMap((group) => group.hooks.map((h) => h.command)),
    );
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      // Quoted: ${PLUGIN_ROOT} expands to an absolute install path, and a
      // Windows home directory routinely contains a space.
      expect(command).toBe('node "${PLUGIN_ROOT}/hooknostic/hooknostic.mjs"');
    }
  });

  // Hook delivery from an installed plugin is established on 0.153.2 only; the
  // 0.148.0 binary was read as having removed it and is not re-testable.
  it("declines plugin mode on a range wider than the captured one", () => {
    expect(() =>
      generateCodexArtifacts(exampleIR(), { ...TARGET, delivery: "package", version: ">=0.148 <1" }, BUNDLE, OPTIONS),
    ).toThrow(/requires harness >=0\.153 <1/);
  });

  it("keeps the local-mode command relative to the project root", () => {
    const artifacts = generateCodexArtifacts(exampleIR(), TARGET, BUNDLE, OPTIONS);
    expect(artifacts.map((a) => a.path).sort()).toEqual([".codex/hooknostic/hooknostic.mjs", ".codex/hooks.json"]);
    expect(String(artifacts.find((a) => a.path === ".codex/hooks.json")!.contents)).toContain(
      "node .codex/hooknostic/hooknostic.mjs",
    );
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
    const hooksJson = JSON.parse(artifacts.find((a) => a.path.endsWith("hooks.json"))!.contents as string);
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
    expect(() => generateCodexArtifacts(capped, TARGET, BUNDLE, OPTIONS)).toThrow(/SessionEnd.*grants at most 3s/);
  });

  it("does not preempt runtime timeouts longer than 60 seconds", () => {
    const artifacts = generateCodexArtifacts(exampleIR(), TARGET, BUNDLE, {
      runtime: { ...OPTIONS.runtime, timeoutMs: 61_000 },
    });
    const hooksJson = JSON.parse(artifacts[0]!.contents as string);
    expect(hooksJson.hooks.PreToolUse[0].hooks[0].timeout).toBe(62);
  });
});

describe("Codex native tool matchers", () => {
  function hooksFor(
    version: string,
    ...matches: ({ kind: "shell" } | { kind: "mcp" } | { kind: "file.read" } | undefined)[]
  ) {
    const { ir, diagnostics } = buildPluginIR(
      definePlugin({
        name: "matchers",
        hooks: [
          ...matches.map((match, index) =>
            hook("tool.before", { id: `before-${index}`, ...(match === undefined ? {} : { match }), async run() {} }),
          ),
          hook("tool.after", { id: "after-shell", match: { kind: "shell" }, async run() {} }),
        ],
      }),
    );
    expect(diagnostics).toEqual([]);
    return JSON.parse(generateCodexArtifacts(ir!, { ...TARGET, version }, BUNDLE, OPTIONS)[0]!.contents as string)
      .hooks;
  }

  it("selects the classifier's shell names on PreToolUse only", () => {
    const hooks = hooksFor(CODEX_NATIVE_MATCHER_RANGE, { kind: "shell" });
    expect(hooks.PreToolUse[0].matcher).toBe("Bash|exec_command|shell");
    expect(hooks.PostToolUse[0]).not.toHaveProperty("matcher");
  });

  it.each([
    ["an uncaptured version", ">=0.148 <0.153", [{ kind: "shell" as const }]],
    ["an undescribed MCP kind", CODEX_NATIVE_MATCHER_RANGE, [{ kind: "shell" as const }, { kind: "mcp" as const }]],
    ["an unmatched hook", CODEX_NATIVE_MATCHER_RANGE, [{ kind: "shell" as const }, undefined]],
    ["an uncaptured non-shell kind", CODEX_NATIVE_MATCHER_RANGE, [{ kind: "file.read" as const }]],
  ])("selects every tool for %s", (_label, version, matches) => {
    expect(hooksFor(version, ...matches).PreToolUse[0]).not.toHaveProperty("matcher");
  });
});

describe("codexAdapter capability data", () => {
  it("resolves the 0.14x profile with rationale on every non-exact cell", () => {
    const resolved = codexAdapter().capabilities(TARGET);
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.matrix?.["tool.before.requestApproval"]?.level).toBe("exact");
    // Captured live on 0.151.0 (.capture/codex-tools): the hook engine
    // rejects updatedMCPToolOutput outright (fails open).
    expect(resolved.matrix?.["tool.after.output.replace"]?.level).toBe("unsupported");
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
