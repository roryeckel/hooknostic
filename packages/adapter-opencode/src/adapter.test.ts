import { describe, expect, it } from "vitest";

import { analyzeCapabilities, buildPluginIR } from "@hooknostic/core";
import type { HookResult } from "@hooknostic/sdk";
import { definePlugin, hook, replaceOutput } from "@hooknostic/sdk";
import { loadFixture } from "@hooknostic/testkit";

import { planOpenCodeApplication, serializeOpenCodeOutput } from "./apply.js";
import { decodeOpenCode, OpenCodeDecodeError } from "./decode.js";
import { generateOpenCodeArtifacts } from "./generate.js";
import { opencodeHarness } from "./harness.js";
import { opencodeAdapter } from "./index.js";
import { classifyOpenCodeTool } from "./toolmap.js";

const INVOCATION = { targetId: "opencode", harnessVersion: opencodeHarness.referenceVersion };

describe("decodeOpenCode fixtures", () => {
  const CASES = [
    "tool-before",
    "tool-after",
    "permission-ask",
    "permission-asked",
    "compacting",
    "session-created",
    "session-deleted",
    "session-idle",
    "session-compacted",
    "chat-message",
    "system-transform",
  ] as const;

  for (const name of CASES) {
    it(`decodes ${name} to its canonical event`, () => {
      const input = loadFixture(
        "opencode",
        "1.18",
        name === "permission-ask" ? "permission-ask.type-derived.json" : `${name}.input.json`,
      );
      const canonical = loadFixture<Record<string, unknown>>("opencode", "1.18", `${name}.canonical.json`);
      const decoded = decodeOpenCode(input, INVOCATION);
      expect(decoded).toEqual({
        ...canonical,
        harness: { ...(canonical["harness"] as object), version: opencodeHarness.referenceVersion },
        raw: input,
      });
    });
  }

  it("tolerates unknown callback input fields", () => {
    const input = loadFixture<Record<string, any>>("opencode", "1.18", "tool-before.input.json");
    input["input"]["agent"] = "build";
    input["input"]["brandNew"] = true;
    const decoded = decodeOpenCode(input, INVOCATION);
    expect(decoded.event).toBe("tool.before");
  });

  it("snapshots mutable tool arguments before canonical dispatch", () => {
    const args = { command: "npm install", nested: { keep: true } };
    const decoded = decodeOpenCode(
      {
        hook: "tool.execute.before",
        directory: "C:/project",
        input: { tool: "bash" },
        output: { args },
      },
      INVOCATION,
    );

    if (!("tool" in decoded)) throw new Error("expected tool.before event");
    const input = decoded.tool.input as { command: string; nested: { keep: boolean } };
    expect(input).toEqual(args);
    expect(input).not.toBe(args);
    expect(input.nested).not.toBe(args.nested);

    input.nested.keep = false;
    expect(args.nested.keep).toBe(true);
  });

  it("rejects unmapped callbacks and bus events", () => {
    expect(() => decodeOpenCode({ hook: "lsp.updated", directory: "C:/x", input: {} }, INVOCATION)).toThrow(
      OpenCodeDecodeError,
    );
    expect(() =>
      decodeOpenCode({ hook: "event", directory: "C:/x", input: { event: { type: "storage.write" } } }, INVOCATION),
    ).toThrow(OpenCodeDecodeError);
  });
});

describe("classifyOpenCodeTool", () => {
  it("classifies lowercase opencode tool ids", () => {
    expect(classifyOpenCodeTool("bash", {}).kind).toBe("shell");
    expect(classifyOpenCodeTool("read", {}).kind).toBe("file.read");
    expect(classifyOpenCodeTool("edit", {}).kind).toBe("file.edit");
    expect(classifyOpenCodeTool("webfetch", {}).kind).toBe("web.fetch");
    expect(classifyOpenCodeTool("task", {}).kind).toBe("agent");
    expect(classifyOpenCodeTool("myserver_dothing", {}).kind).toBe("mcp");
    expect(classifyOpenCodeTool("somethingnew", {}).kind).toBe("other");
  });
});

function result(partial: Partial<HookResult> & Pick<HookResult, "event">): HookResult {
  return { schemaVersion: 1, effects: [], errors: [], ...partial };
}

describe("planOpenCodeApplication", () => {
  it("blocks tool calls by throwing", () => {
    expect(
      planOpenCodeApplication(
        result({
          event: "tool.before",
          effects: [
            {
              hookId: "g",
              effect: { kind: "block", reason: "Refusing destructive root deletion" },
            },
          ],
          terminatedBy: "g",
        }),
      ),
    ).toEqual(loadFixture("opencode", "1.18", "tool-before-block.output.json"));
  });

  it("rewrites input via args mutation", () => {
    expect(
      planOpenCodeApplication(
        result({
          event: "tool.before",
          effects: [{ hookId: "r", effect: { kind: "replaceInput", input: { command: "pnpm install" } } }],
        }),
      ),
    ).toEqual(loadFixture("opencode", "1.18", "tool-before-rewrite.output.json"));
  });

  it("replaces output via output mutation, string-coercing non-strings", () => {
    expect(
      planOpenCodeApplication(
        result({
          event: "tool.after",
          effects: [{ hookId: "r", effect: { kind: "replaceOutput", output: "[redacted]" } }],
        }),
      ),
    ).toEqual(loadFixture("opencode", "1.18", "tool-after-replace.output.json"));

    expect(
      planOpenCodeApplication(
        result({
          event: "tool.after",
          effects: [{ hookId: "r", effect: { kind: "replaceOutput", output: { a: 1 } } }],
        }),
      ),
    ).toEqual({ mutations: { output: '{"a":1}' } });
  });

  it("totally converts unusual output replacement values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("no property access");
        },
      },
    );

    expect(serializeOpenCodeOutput(undefined)).toBe("undefined");
    expect(serializeOpenCodeOutput(42n)).toBe("42");
    expect(serializeOpenCodeOutput(cyclic)).toBe("[object Object]");
    expect(serializeOpenCodeOutput(hostile)).toBe("[hooknostic: unrepresentable output]");
  });

  it("denies permission requests through the live reply API, not a callback mutation", () => {
    expect(
      planOpenCodeApplication(
        result({
          event: "permission.request",
          effects: [{ hookId: "g", effect: { kind: "block", reason: "nope" } }],
          terminatedBy: "g",
        }),
      ),
    ).toEqual(loadFixture("opencode", "1.18", "permission-deny.output.json"));
  });

  it("appends compaction context", () => {
    expect(
      planOpenCodeApplication(
        result({
          event: "context.compact.before",
          effects: [
            {
              hookId: "c",
              effect: { kind: "addContext", context: "Working directory layout: see AGENTS.md" },
            },
            { hookId: "c2", effect: { kind: "addContext", context: "Prefer pnpm over npm" } },
          ],
        }),
      ),
    ).toEqual(loadFixture("opencode", "1.18", "compacting-context.output.json"));
  });

  it("routes model.request.before context to output.system, not output.context", () => {
    expect(
      planOpenCodeApplication(
        result({
          event: "model.request.before",
          effects: [
            {
              hookId: "c",
              effect: { kind: "addContext", context: "Working directory layout: see AGENTS.md" },
            },
            { hookId: "c2", effect: { kind: "addContext", context: "Prefer pnpm over npm" } },
          ],
        }),
      ),
    ).toEqual(loadFixture("opencode", "1.18", "model-request-before-context.output.json"));
  });

  it("does not plan a system mutation for a different event", () => {
    // The two channels share addContext but not their output key; crossing them
    // would silently inject into the compaction prompt instead of the request.
    const planned = planOpenCodeApplication(
      result({
        event: "context.compact.before",
        effects: [{ hookId: "c", effect: { kind: "addContext", context: "x" } }],
      }),
    );
    expect(planned.mutations?.system).toBeUndefined();
    expect(planned.mutations?.context).toEqual(["x"]);
  });
});

describe("generateOpenCodeArtifacts", () => {
  const TARGET = {
    id: "opencode",
    version: opencodeHarness.recommendedRange,
    delivery: "project" as const,
    output: "./dist/opencode",
  };

  function exampleIR() {
    const { ir } = buildPluginIR(
      definePlugin({
        name: "p",
        hooks: [hook("tool.before", { id: "g", async run() {} })],
      }),
    );
    return ir!;
  }

  it("emits the bundled local plugin module", () => {
    const artifacts = generateOpenCodeArtifacts(exampleIR(), TARGET, {
      code: "export const HooknosticPlugin = async () => ({});\n",
    });
    expect(artifacts.map((a) => a.path)).toEqual([".opencode/plugins/hooknostic.js"]);
  });

  it("names a hooks-only package by the target's npm coordinate", () => {
    const manifestOf = (npmName?: string) =>
      JSON.parse(
        String(
          generateOpenCodeArtifacts(
            exampleIR(),
            { ...TARGET, delivery: "package", ...(npmName === undefined ? {} : { npmName }) },
            { code: "export const HooknosticPlugin = async () => ({});" },
          ).find((artifact) => artifact.path === "package.json")!.contents,
        ),
      ) as Record<string, unknown>;

    // A hooks-only package emits its manifest here rather than through the
    // projector, so the coordinate has to reach both paths or publishing a
    // plugin without components would silently fall back to the plugin name.
    expect(manifestOf("@example/example-opencode")["name"]).toBe("@example/example-opencode");
    expect(manifestOf()["name"]).toBe(exampleIR().name);
  });

  it("emits a loadable package for package delivery with no components", () => {
    // `components.root` is optional, and without it the Agent Plugin projector
    // never runs. Emitting the bundle alone would leave a bare module at the
    // output root with no manifest -- something OpenCode cannot load at all,
    // and worse than the project-shaped tree this replaced.
    const artifacts = generateOpenCodeArtifacts(
      exampleIR(),
      { ...TARGET, delivery: "package" },
      { code: "export const HooknosticPlugin = async () => ({});\n" },
    );
    expect(artifacts.map((a) => a.path).sort()).toEqual(["hooknostic.js", "index.js", "package.json"]);

    const manifest = JSON.parse(String(artifacts.find((a) => a.path === "package.json")!.contents)) as Record<
      string,
      unknown
    >;
    expect(manifest["exports"]).toEqual({ "./server": "./index.js" });
    expect(manifest["type"]).toBe("module");

    const entry = String(artifacts.find((a) => a.path === "index.js")!.contents);
    expect(entry).toContain('export { HooknosticPlugin } from "./hooknostic.js";');
    // No injector exists in this shape, so the entry must not name one.
    expect(entry).not.toContain("hooknostic-agent-plugin.js");
  });
});

describe("validateArtifacts for package delivery", () => {
  const adapter = opencodeAdapter();
  const PKG = { id: "opencode", version: ">=1.18 <2", delivery: "package" as const, output: "dist" };
  const manifest = { path: "package.json", contents: '{"name":"example-plugin","version":"1.2.3"}\n' };
  const goodEntry = { path: "index.js", contents: 'export { HooknosticPlugin } from "./hooknostic.js";\n' };

  it("validates the package-root module rather than the project path", async () => {
    // The project path never exists in a package, so reading it unconditionally
    // made validation a no-op for every package delivery: a hook module missing
    // its export shipped clean.
    const diagnostics = await adapter.validateArtifacts!(
      [{ path: "hooknostic.js", contents: "export const NotThePlugin = 1;\n" }, goodEntry, manifest],
      PKG,
    );
    expect(diagnostics.map((d) => d.code)).toContain("HN301");
  });

  it("refuses an entry re-exporting a hook module the output does not contain", async () => {
    const diagnostics = await adapter.validateArtifacts!([goodEntry, manifest], PKG);
    expect(diagnostics.some((d) => d.message.includes("does not contain"))).toBe(true);
  });

  it("refuses a package with no manifest", async () => {
    const diagnostics = await adapter.validateArtifacts!([{ path: "index.js", contents: "// nothing\n" }], PKG);
    expect(diagnostics.some((d) => d.message.includes("package.json"))).toBe(true);
  });

  it.each(["_under", "has space"])("refuses a hooks-only package named %s, which npm cannot pack", async (name) => {
    // A hooks-only package takes its name from PluginSpec.name, which is only
    // string().min(1) -- the component projection's own check never runs on
    // this path, so without this the build emits a directory npm cannot pack.
    const diagnostics = await adapter.validateArtifacts!(
      [
        { path: "hooknostic.js", contents: "export const HooknosticPlugin = async () => ({});\n" },
        goodEntry,
        { path: "package.json", contents: `{"name":${JSON.stringify(name)},"version":"1.2.3"}\n` },
      ],
      PKG,
    );
    const diagnostic = diagnostics.find((d) => d.message.includes("not a valid npm package name"));
    expect(diagnostic?.severity).toBe("error");
  });

  it.each(["UPPER", "http"])("warns that a hooks-only package named %s cannot be published", async (name) => {
    // npm installs these from a local path, which is a supported route, so the
    // build keeps working and only publication is out of reach -- matched to
    // the version check rather than escalated past it.
    const diagnostics = await adapter.validateArtifacts!(
      [
        { path: "hooknostic.js", contents: "export const HooknosticPlugin = async () => ({});\n" },
        goodEntry,
        { path: "package.json", contents: `{"name":${JSON.stringify(name)},"version":"1.2.3"}\n` },
      ],
      PKG,
    );
    const diagnostic = diagnostics.find((d) => d.message.includes("not a valid npm package name"));
    expect(diagnostic?.severity).toBe("warn");
  });

  it("fails an npm coordinate that only blocks publication, because publishing is why it exists", async () => {
    // The projector already draws this line. A hooks-only package reaching the
    // opposite verdict made one declaration pass or fail on whether the config
    // happened to also list components.
    const diagnostics = await adapter.validateArtifacts!(
      [
        { path: "hooknostic.js", contents: "export const HooknosticPlugin = async () => ({});\n" },
        goodEntry,
        { path: "package.json", contents: '{"name":"http","version":"1.2.3"}\n' },
      ],
      { ...PKG, npmName: "http" },
    );
    const diagnostic = diagnostics.find((d) => d.message.includes("not a valid npm package name"));
    expect(diagnostic?.severity).toBe("error");
    // Naming the generated manifest would send the author to the wrong file.
    expect(diagnostic?.message).toContain("npmName");
  });

  it("leaves a projected package's manifest to the projector that built it", async () => {
    // The projector reports both of these while constructing its plan, and a
    // projected warning does not stop the build, so checking them again here
    // reached the author as two findings for one declaration.
    const diagnostics = await adapter.validateArtifacts!(
      [
        { path: "hooknostic.js", contents: "export const HooknosticPlugin = async () => ({});\n" },
        { path: "hooknostic-agent-plugin.js", contents: "export const components = {};\n" },
        goodEntry,
        { path: "package.json", contents: '{"name":"UPPER","version":"next"}\n' },
      ],
      PKG,
    );
    expect(diagnostics).toEqual([]);
  });

  it("files its diagnostics against the target that produced them", async () => {
    // Targets may share an adapter under any id, so hard-coding the adapter id
    // attributed the finding to a target the config need not even declare.
    const diagnostics = await adapter.validateArtifacts!(
      [
        { path: "hooknostic.js", contents: "export const HooknosticPlugin = async () => ({});\n" },
        goodEntry,
        { path: "package.json", contents: '{"name":"_under","version":"1.2.3"}\n' },
      ],
      { ...PKG, id: "opencode-registry" },
    );
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.every((d) => d.target === "opencode-registry")).toBe(true);
  });

  it.each([
    ["with no version", '{"name":"example-plugin"}\n'],
    ["with a non-semver version", '{"name":"example-plugin","version":"next"}\n'],
  ])("warns when a hooks-only package %s cannot be published", async (_case, contents) => {
    const diagnostics = await adapter.validateArtifacts!(
      [
        { path: "hooknostic.js", contents: "export const HooknosticPlugin = async () => ({});\n" },
        goodEntry,
        { path: "package.json", contents },
      ],
      PKG,
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ severity: "warn", message: expect.stringContaining("cannot be published") }),
    );
  });

  it("accepts a well-formed package", async () => {
    const diagnostics = await adapter.validateArtifacts!(
      [{ path: "hooknostic.js", contents: "export const HooknosticPlugin = async () => ({});\n" }, goodEntry, manifest],
      PKG,
    );
    expect(diagnostics).toEqual([]);
  });
});

describe("planOpenCodeApplication on turn.stop", () => {
  it("posts a stop-prevention reason as a reply-driving prompt", () => {
    expect(
      planOpenCodeApplication(
        result({
          event: "turn.stop",
          effects: [
            {
              hookId: "continue",
              effect: {
                kind: "preventStop",
                reason: "Tests have not been run yet; keep working.",
              },
            },
          ],
          terminatedBy: "continue",
        }),
      ),
    ).toEqual(loadFixture("opencode", "1.18", "session-idle-prevent.output.json"));
  });

  it("posts a notification without driving a turn", () => {
    expect(
      planOpenCodeApplication(
        result({
          event: "turn.stop",
          effects: [
            {
              hookId: "notice",
              effect: { kind: "notify", message: "hooknostic: 3 files are still uncommitted." },
            },
          ],
        }),
      ),
    ).toEqual(loadFixture("opencode", "1.18", "session-idle-notify.output.json"));
  });

  it("orders notifications before the reply-driving prompt", () => {
    // The invariant the array shape exists for: the agent must read every
    // notice before the instruction that keeps it working, and exactly one
    // entry may drive a turn.
    const plan = planOpenCodeApplication(
      result({
        event: "turn.stop",
        effects: [
          {
            hookId: "notice",
            effect: { kind: "notify", message: "hooknostic: 3 files are still uncommitted." },
          },
          {
            hookId: "continue",
            effect: {
              kind: "preventStop",
              reason: "Tests have not been run yet; keep working.",
            },
          },
        ],
        terminatedBy: "continue",
      }),
    );
    expect(plan).toEqual(loadFixture("opencode", "1.18", "session-idle-notify-prevent.output.json"));
    expect(plan.prompts?.filter((p) => p.reply)).toHaveLength(1);
    expect(plan.prompts?.at(-1)?.reply).toBe(true);
  });

  it("posts nothing on events with no session-posting semantic", () => {
    expect(
      planOpenCodeApplication(
        result({
          event: "tool.before",
          effects: [{ hookId: "n", effect: { kind: "notify", message: "ignored" } }],
        }),
      ).prompts,
    ).toBeUndefined();
  });
});

describe("opencodeAdapter capability data", () => {
  it("resolves the 1.1x profile with rationale on every non-exact cell", () => {
    const resolved = opencodeAdapter().capabilities({
      id: "opencode",
      version: opencodeHarness.recommendedRange,
      delivery: "project",
      output: "./d",
    });
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.matrix?.["tool.before.block"]?.level).toBe("exact");
    // Captured live on 1.18.25 (.capture/opencode-permission): the ask is a
    // bus event, and denial is a client reply-API round-trip, not a callback.
    expect(resolved.matrix?.["permission.request.observe"]?.level).toBe("emulated");
    expect(resolved.matrix?.["permission.request.block"]?.level).toBe("approximate");
    expect(resolved.matrix?.["tool.after.output.replace"]?.level).toBe("approximate");
    expect(resolved.matrix?.["tool.before.context.add"]).toBeUndefined();
    // Reached by posting into the session; measured live on 1.18.25.
    expect(resolved.matrix?.["turn.stop.prevent"]?.level).toBe("approximate");
    expect(resolved.matrix?.["turn.stop.notify"]?.level).toBe("approximate");
    // No subagent lifecycle callbacks exist at all on this surface.
    expect(resolved.matrix?.["agent.start.observe"]).toBeUndefined();
    expect(resolved.matrix?.["agent.stop.notify"]).toBeUndefined();
    // The rationale sweep lives in the shared adapter contract
    // (@hooknostic/testkit), so it covers a third-party adapter too. These
    // assertions stay because they pin THIS adapter's specific ratings.
  });

  it("requires an explicit approximate policy for output replacement", () => {
    const built = buildPluginIR(
      definePlugin({
        name: "redactor",
        hooks: [
          hook("tool.after", {
            id: "redact",
            capabilities: { "tool.after.output.replace": "required" },
            async run() {
              return replaceOutput({ redacted: true });
            },
          }),
        ],
      }),
    );
    const adapter = opencodeAdapter();
    const target = {
      version: opencodeHarness.recommendedRange,
      delivery: "project" as const,
      output: "./dist/opencode",
    };
    const strict = analyzeCapabilities(
      built.ir!,
      { entry: "./hooks.ts", targets: { opencode: target } },
      { opencode: adapter },
    );
    expect(strict.ok).toBe(false);
    expect(strict.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HN201",
        capability: "tool.after.output.replace",
        support: "approximate",
      }),
    );

    const relaxed = analyzeCapabilities(
      built.ir!,
      {
        entry: "./hooks.ts",
        targets: {
          opencode: {
            ...target,
            compatibility: { minimum: "approximate" },
          },
        },
      },
      { opencode: adapter },
    );
    expect(relaxed.ok).toBe(true);
    expect(relaxed.diagnostics).toContainEqual(expect.objectContaining({ code: "HN101", support: "approximate" }));
  });
});
