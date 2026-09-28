/**
 * Compile-time contract tests. The `@ts-expect-error` directives are enforced
 * by `pnpm typecheck` (tsc errors if a directive stops erroring), so this file
 * proves that undeclared effects and mis-scoped capabilities fail the build.
 */
import { describe, expect, it } from "vitest";

import {
  addContext,
  block,
  defineConfig,
  definePlugin,
  hook,
  notify,
  preventStop,
  replaceInput,
  replaceOutput,
  updateShell,
} from "./index.js";

describe("compile-time hook contracts", () => {
  it("accepts declared effects and rejects undeclared ones", () => {
    const ok = hook("tool.before", {
      id: "declared-effects",
      capabilities: {
        "tool.before.block": "required",
        "tool.before.input.replace": "optional",
      },
      async run(event, ctx) {
        if (ctx.capabilities.has("tool.before.input.replace")) {
          return replaceInput({ command: "pnpm install" });
        }
        return block(`no ${event.tool.nativeName}`);
      },
    });

    const undeclared = hook("tool.before", {
      id: "undeclared-effect",
      capabilities: { "tool.before.block": "required" },
      // @ts-expect-error replaceInput requires declaring tool.before.input.replace
      async run() {
        return replaceInput({ command: "x" });
      },
    });

    // updateShell rides the same capability as replaceInput: declaring
    // tool.before.input.replace licenses both, declaring neither licenses none.
    const portable = hook("tool.before", {
      id: "portable-rewrite",
      capabilities: { "tool.before.input.replace": "required" },
      async run(event) {
        if (event.tool.shell !== undefined) return updateShell({ command: "pnpm install" });
        return replaceInput({ command: "pnpm install" });
      },
    });

    const undeclaredPortable = hook("tool.before", {
      id: "undeclared-portable",
      capabilities: { "tool.before.block": "required" },
      // @ts-expect-error updateShell requires declaring tool.before.input.replace
      async run() {
        return updateShell({ command: "x" });
      },
    });

    const noCapabilities = hook("session.end", {
      id: "observe-only",
      // @ts-expect-error observe-only hooks may not return effects
      async run() {
        return block("nope");
      },
    });

    expect(ok.id).toBe("declared-effects");
    expect(portable.id).toBe("portable-rewrite");
    expect(undeclaredPortable.id).toBe("undeclared-portable");
    expect(undeclared.id).toBe("undeclared-effect");
    expect(noCapabilities.id).toBe("observe-only");
  });

  it("accepts event-relative capability keys and types has() to the declaration", () => {
    const relative = hook("tool.before", {
      id: "relative-keys",
      capabilities: { block: "required", "input.replace": "optional" },
      async run(event, ctx) {
        if (ctx.capabilities.has("input.replace") && event.tool.shell !== undefined) {
          return updateShell({ command: "pnpm install" });
        }
        // Either spelling probes the same declaration.
        if (ctx.capabilities.has("tool.before.input.replace")) return replaceInput({ command: "x" });
        return block("no");
      },
    });

    const mixed = hook("turn.stop", {
      id: "mixed-spellings",
      capabilities: { prevent: "required", "turn.stop.notify": "optional" },
      async run(_event, ctx) {
        if (ctx.capabilities.has("notify")) return notify("idle check skipped");
        return preventStop("keep going");
      },
    });

    const undeclaredRelative = hook("tool.before", {
      id: "undeclared-relative",
      capabilities: { block: "required" },
      // @ts-expect-error "block" does not license replaceInput
      async run() {
        return replaceInput({ command: "x" });
      },
    });

    const foreignSuffix = hook("tool.before", {
      id: "foreign-suffix",
      capabilities: {
        // @ts-expect-error "prevent" is not a tool.before capability
        prevent: "required",
      },
      async run() {},
    });

    const undeclaredProbe = hook("tool.before", {
      id: "undeclared-probe",
      capabilities: { block: "required" },
      async run(_event, ctx) {
        // @ts-expect-error input.replace was not declared, so no effect it licenses could be returned
        ctx.capabilities.has("input.replace");
        // @ts-expect-error another event's capability can never answer for this hook
        ctx.capabilities.has("turn.stop.prevent");
        return block("no");
      },
    });

    expect([relative, mixed, undeclaredRelative, foreignSuffix, undeclaredProbe].map((h) => h.id)).toEqual([
      "relative-keys",
      "mixed-spellings",
      "undeclared-relative",
      "foreign-suffix",
      "undeclared-probe",
    ]);
    expect(relative.capabilities).toEqual({ "tool.before.block": "required", "tool.before.input.replace": "optional" });
  });

  it("accepts effect lists when every element is licensed", () => {
    const ok = hook("turn.stop", {
      id: "list",
      capabilities: { prevent: "required", notify: "optional" },
      async run(_event, ctx) {
        return [ctx.capabilities.has("notify") ? notify("lint failed") : undefined, preventStop("fix it")];
      },
    });

    const undeclared = hook("turn.stop", {
      id: "list-undeclared",
      capabilities: { prevent: "required" },
      // @ts-expect-error notify is undeclared, inside a list as anywhere else
      async run() {
        return [notify("lint failed"), preventStop("fix it")];
      },
    });

    expect([ok.id, undeclared.id]).toEqual(["list", "list-undeclared"]);
  });

  it("rejects capabilities scoped to a different event", () => {
    const wrongScope = hook("tool.after", {
      id: "wrong-scope",
      capabilities: {
        // @ts-expect-error tool.before.block is not a tool.after capability
        "tool.before.block": "required",
      },
      async run() {},
    });
    expect(wrongScope.id).toBe("wrong-scope");
  });

  it("rejects effects that are structurally impossible on the event", () => {
    const h = hook("session.start", {
      id: "session-context",
      capabilities: { "session.start.context.add": "optional" },
      async run(event, ctx) {
        if (!ctx.capabilities.has("session.start.context.add")) return;
        return addContext(`cwd: ${event.session.cwd}`);
      },
    });

    const bad = hook("session.start", {
      id: "session-cannot-prevent",
      capabilities: { "session.start.context.add": "optional" },
      // @ts-expect-error preventStop is not licensed by session.start capabilities
      async run() {
        return preventStop();
      },
    });

    expect(h.id).toBe("session-context");
    expect(bad.id).toBe("session-cannot-prevent");
  });

  it("scopes output replacement to tool.after", () => {
    const h = hook("tool.after", {
      id: "redact-output",
      capabilities: { "tool.after.output.replace": "required" },
      async run(event) {
        return replaceOutput({ redactedFrom: event.tool.nativeName });
      },
    });
    expect(h.id).toBe("redact-output");
  });

  it("only allows tool matchers on tool-scoped events", () => {
    const ok = hook("tool.before", {
      id: "match-shell",
      match: { kind: "shell" },
      async run() {},
    });

    const bad = hook("turn.stop", {
      id: "no-match-here",
      // @ts-expect-error turn.stop is not tool-scoped
      match: { kind: "shell" },
      async run() {},
    });

    expect(ok.match).toEqual({ kind: "shell" });
    expect(bad.id).toBe("no-match-here");
  });

  it("narrows tool.kind to what the matcher admits", () => {
    const single = hook("tool.before", {
      id: "narrow-single",
      match: { kind: "shell" },
      capabilities: { block: "required" },
      async run(event) {
        const kind: "shell" = event.tool.kind;
        return block(kind);
      },
    });

    const listed = hook("tool.after", {
      id: "narrow-list",
      match: { kind: ["file.read", "file.edit"] },
      async run(event) {
        const kind: "file.read" | "file.edit" = event.tool.kind;
        // @ts-expect-error "shell" is outside the matched kinds
        const outside: "shell" = event.tool.kind;
        void [kind, outside];
      },
    });

    const byName = hook("tool.before", {
      id: "narrow-by-name",
      match: { nativeName: "Bash" },
      async run(event) {
        // A native-name matcher says nothing about the normalized category.
        // @ts-expect-error kind stays the whole ToolKind union
        const kind: "shell" = event.tool.kind;
        void kind;
      },
    });

    const unmatched = hook("tool.before", {
      id: "unmatched",
      async run(event) {
        // @ts-expect-error without a matcher every kind reaches the handler
        const kind: "shell" = event.tool.kind;
        void kind;
      },
    });

    expect([single, listed, byName, unmatched].map((h) => h.match)).toEqual([
      { kind: "shell" },
      { kind: ["file.read", "file.edit"] },
      { nativeName: "Bash" },
      undefined,
    ]);
  });

  it("scopes notify to the stop events", () => {
    const ok = hook("turn.stop", {
      id: "notifier",
      capabilities: { "turn.stop.notify": "optional" },
      async run(_event, ctx) {
        if (ctx.capabilities.has("turn.stop.notify")) return notify("idle check skipped");
        return;
      },
    });

    const wrongEvent = hook("tool.before", {
      id: "notify-on-tool",
      capabilities: {
        // @ts-expect-error notify is not available on tool.before
        "tool.before.notify": "optional",
      },
      async run() {},
    });

    // The case that catches a botched EffectForCapability ladder edit: the
    // capability is real, but it does not license this effect.
    const undeclared = hook("turn.stop", {
      id: "notify-undeclared",
      capabilities: { "turn.stop.prevent": "required" },
      // @ts-expect-error notify requires declaring turn.stop.notify
      async run() {
        return notify("unannounced");
      },
    });

    expect([ok.id, wrongEvent.id, undeclared.id]).toEqual(["notifier", "notify-on-tool", "notify-undeclared"]);
  });

  it("erases to a uniform HookDefinition inside definePlugin", () => {
    const plugin = definePlugin({
      name: "typed-plugin",
      hooks: [
        hook("tool.before", {
          id: "a",
          capabilities: { "tool.before.block": "required" },
          async run() {
            return block("no");
          },
        }),
        hook("turn.stop", {
          id: "b",
          capabilities: { "turn.stop.prevent": "optional" },
          async run(_event, ctx) {
            if (ctx.capabilities.has("turn.stop.prevent")) return preventStop("keep going");
            return;
          },
        }),
      ],
    });
    expect(plugin.hooks.map((h) => h.id)).toEqual(["a", "b"]);
  });
});

describe("compile-time config contracts", () => {
  const claude = { version: ">=2.1 <3", delivery: "package" as const, output: "./dist/claude" };
  const codex = { version: ">=0.148 <1", delivery: "project" as const, output: "./dist/codex" };

  it("infers projection target names from the configured targets", () => {
    const hooked = defineConfig({ entry: "./src/hooks.ts", targets: { claude, codex } });
    const hookless = defineConfig({
      components: { root: ".", targets: ["claude"] },
      targets: { claude },
    });
    const both = defineConfig({
      entry: "./src/hooks.ts",
      components: { root: ".", targets: ["claude", "codex"], onInvalid: "warn" },
      targets: { claude, codex },
    });
    const direct = defineConfig({
      project: { root: "." },
      components: {
        mcp: "./mcp.json",
        mcpOverrides: { codex: { startupTimeoutMs: 60_000, servers: { serena: { args: ["serve"] } } } },
      },
      targets: { codex },
    });
    expect([
      hooked.entry,
      hookless.entry,
      both.components?.targets,
      direct.components?.mcpOverrides?.codex?.startupTimeoutMs,
    ]).toEqual(["./src/hooks.ts", undefined, ["claude", "codex"], 60_000]);

    // @ts-expect-error at least one of entry or components is required
    defineConfig({ targets: { claude } });
    defineConfig({
      // @ts-expect-error "opencode" is not a configured target
      components: { root: ".", targets: ["opencode"] },
      targets: { claude },
    });
    defineConfig({
      entry: "./src/hooks.ts",
      // @ts-expect-error projection targets cannot be empty
      components: { root: ".", targets: [] },
      targets: { claude },
    });
    defineConfig({
      project: { root: "." },
      components: {
        mcp: "./mcp.json",
        // @ts-expect-error "claude" is not a configured target
        mcpOverrides: { claude: {} },
      },
      targets: { codex },
    });
    defineConfig({
      components: {
        root: ".",
        // @ts-expect-error package components cannot carry direct MCP overrides
        mcpOverrides: { claude: {} },
      },
      targets: { claude },
    });
    defineConfig({
      project: { root: "." },
      // Skills accept the declaration, spelled against where the file lands.
      components: { skills: ["./skills"], executableFiles: ["review/bin/tool"] },
      targets: { codex },
    });
    defineConfig({
      project: { root: "." },
      // @ts-expect-error a direct MCP source owns no tree to mark executable
      components: { mcp: "./mcp.json", executableFiles: ["bin/tool"] },
      targets: { codex },
    });
  });
});
