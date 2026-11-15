/**
 * Every shipped adapter must pass the same contract.
 *
 * The obligations live in `@hooknostic/testkit` so an adapter published from
 * another repository is held to them too. Registration iterates the default
 * registry itself: there is no per-adapter row to forget, which closes the one
 * gap the previous SUBJECTS array admitted it could not catch. Fixture paths
 * and audit ranges derive from each adapter's own `harness` metadata. The one
 * per-harness row, the handler-error driver, is itself checked against the
 * registry, so a missing one fails rather than skips.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { SHELL_DIALECTS } from "@hooknostic/sdk";
import {
  adapterFixturesDir,
  describeAdapterContract,
  describeHandlerErrorReporting,
  describeScenarioCoverage,
  type HandlerErrorDriver,
  scenarioById,
} from "@hooknostic/testkit";

import { defaultAdapterRegistry } from "./registry.js";

const adapters = Object.values(defaultAdapterRegistry()).flatMap((adapter) =>
  adapter.harnessFamilies
    ? adapter.harnessFamilies.map(
        (harness) =>
          adapter.resolveTarget!({
            id: adapter.id,
            version: harness.recommendedRange,
            delivery: "project",
            output: ".",
          }).adapter!,
      )
    : [adapter],
);

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

type Callback = (...args: unknown[]) => Promise<unknown>;
const callbackFor = (callbacks: Map<string, Callback>, name: string): Callback => {
  const callback = callbacks.get(name);
  if (callback === undefined) throw new Error(`the shim registered no ${name} callback`);
  return callback;
};

/**
 * How each harness runs its artifact, for the handler-error obligation (#175).
 * The command shims need only a captured input; an in-process shim also needs
 * the host's calling convention, which no adapter field describes. Keyed by
 * display name, which separates harness families of one adapter id; a harness
 * registered without a row fails below.
 */
const HANDLER_ERROR_DRIVERS: Record<string, HandlerErrorDriver> = {
  "Claude Code": { execution: "command", event: "tool.before", input: "pre-tool-bash.input.json" },
  "Codex CLI": { execution: "command", event: "tool.before", input: "pre-tool-bash.input.json" },
  // The camelCase payload names no event; Copilot passes the registered name as argv.
  "GitHub Copilot CLI": {
    execution: "command",
    event: "tool.before",
    input: "tool-before.input.json",
    args: ["preToolUse"],
  },
  // The Plugin function, called with PluginInput; each hook with (input, output).
  OpenCode: {
    execution: "module",
    event: "tool.before",
    input: "tool-before.input.json",
    async deliver(exported, native) {
      const { hook, directory, input, output } = native as Record<string, unknown> & { hook: string };
      const hooks = await (exported as (input: unknown) => Promise<Record<string, Callback | undefined>>)({
        directory,
      });
      try {
        await callbackFor(new Map(Object.entries(hooks) as [string, Callback][]), hook)(input, output);
      } finally {
        await hooks["dispose"]?.();
      }
    },
  },
  // `setup(ctx)`, whose domains register callbacks by name; each called with the event.
  "OpenCode v2": {
    execution: "module",
    event: "tool.before",
    input: "tool-before.input.json",
    async deliver(exported, native) {
      const { hook, directory, event } = native as { hook: string; directory: string; event: unknown };
      const callbacks = new Map<string, Callback>();
      const domain = {
        async hook(name: string, callback: Callback) {
          callbacks.set(name, callback);
          return { dispose: async () => {} };
        },
      };
      const cleanup = await (exported as { setup(ctx: unknown): Promise<() => Promise<void>> }).setup({
        location: { directory },
        session: domain,
        tool: domain,
        permission: domain,
        event: { async *subscribe() {} },
      });
      try {
        await callbackFor(callbacks, hook)(event);
      } finally {
        await cleanup();
      }
    },
  },
  // The extension factory, called with the ExtensionAPI; each handler with (event, ctx).
  pi: {
    execution: "module",
    event: "tool.before",
    input: "tool-call-bash.input.json",
    async deliver(exported, native) {
      const { event, ctx } = native as { event: { type: string }; ctx: unknown };
      const handlers = new Map<string, Callback>();
      (exported as (pi: unknown) => void)({ on: (name: string, handler: Callback) => handlers.set(name, handler) });
      await callbackFor(handlers, event.type)(event, ctx);
    },
  },
};

for (const adapter of adapters) {
  describeAdapterContract(adapter, { fixturesDir: adapterFixturesDir(adapter) });
  describeScenarioCoverage(adapter);
  const driver = HANDLER_ERROR_DRIVERS[adapter.harness.displayName];
  if (driver !== undefined)
    describeHandlerErrorReporting(adapter, driver, { fixturesDir: adapterFixturesDir(adapter) });
}

describe("handler error reporting coverage", () => {
  // A new harness cannot skip the obligation by having no driver, and a
  // renamed one cannot leave its old row passing for nothing.
  it("drives every registered harness, and only those", () => {
    expect(Object.keys(HANDLER_ERROR_DRIVERS).sort()).toEqual(
      adapters.map((adapter) => adapter.harness.displayName).sort(),
    );
  });
});

describe("scheduled scenario limitations", () => {
  it("declares non-silent limits for the unsupported Codex playback drivers", () => {
    expect(scenarioById("tool-before-approval")?.inconclusiveByHarness?.["codex"]).toMatch(
      /interactive approval driver/,
    );
    expect(scenarioById("permission-request")?.inconclusiveByHarness?.["codex"]).toMatch(
      /interactive permission driver/,
    );
    expect(scenarioById("agent-subagent")?.inconclusiveByHarness?.["codex"]).toMatch(/hook-trust bypass/);
    expect(scenarioById("context-compact")?.inconclusiveByHarness?.["claude"]).toMatch(/cannot deterministically fill/);
  });
});

describe("shell dialect evidence (ADR-0029)", () => {
  it("has a fixture carrying every dialect the vocabulary names", () => {
    // A family joins SHELL_DIALECTS with a captured case behind it, never ahead of one.
    const carried = new Set<string>();
    for (const adapter of adapters) {
      const dir = adapterFixturesDir(adapter);
      for (const name of readdirSync(dir).filter((file) => file.endsWith(".canonical.json"))) {
        const dialect = (
          JSON.parse(readFileSync(resolve(dir, name), "utf8")) as { tool?: { shell?: { dialect?: string } } }
        ).tool?.shell?.dialect;
        if (dialect !== undefined) carried.add(dialect);
      }
    }
    expect([...carried].sort()).toEqual([...SHELL_DIALECTS].sort());
  });
});

describe("validation evidence", () => {
  it("points every validatedOn artifact at an existing tracked path", () => {
    // Repo-local (a third party's evidence lives in its own tree): this is
    // what stops "fixtures/codex/0.148" from outliving the directory.
    for (const adapter of adapters) {
      const resolution = adapter.capabilities({
        id: adapter.id,
        version: adapter.harness.recommendedRange,
        delivery: "project",
        output: ".",
      });
      for (const profile of resolution.profilesUsed) {
        for (const record of profile.source.validatedOn) {
          if (record.artifact === undefined) continue;
          expect(
            existsSync(resolve(REPO_ROOT, record.artifact)),
            `${adapter.id} ${profile.range}: artifact ${record.artifact} does not exist`,
          ).toBe(true);
          expect(
            execFileSync("git", ["ls-files", "--", record.artifact], {
              cwd: REPO_ROOT,
              encoding: "utf8",
            }).trim(),
            `${adapter.id} ${profile.range}: artifact ${record.artifact} is not tracked`,
          ).not.toBe("");
        }
      }
    }
  });
});
