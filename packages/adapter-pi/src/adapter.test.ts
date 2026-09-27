import { describe, expect, it } from "vitest";

import { analyzeCapabilities, buildPluginIR } from "@hooknostic/core";
import type { HooknosticConfig } from "@hooknostic/sdk";
import type { HookResult } from "@hooknostic/sdk";
import { definePlugin, hook } from "@hooknostic/sdk";
import { loadFixture } from "@hooknostic/testkit";

import { planPiApplication, serializePiOutput } from "./apply.js";
import { decodePi, PiDecodeError } from "./decode.js";
import { generatePiArtifacts } from "./generate.js";
import { piHarness } from "./harness.js";
import { piAdapter } from "./index.js";
import { classifyPiTool } from "./toolmap.js";

const INVOCATION = { targetId: "pi", harnessVersion: piHarness.referenceVersion };

describe("decodePi fixtures", () => {
  const CASES = [
    "session-start",
    "before-agent-start",
    "before-agent-start-isolated",
    "context",
    "tool-call-write",
    "tool-call-bash",
    "tool-result-write",
    "tool-result-bash",
    "tool-result-error",
    "agent-settled",
    "session-shutdown",
    "session-before-compact",
    "session-compact",
    "session-compact-failed",
  ] as const;

  for (const name of CASES) {
    it(`decodes ${name} to its canonical event`, () => {
      const input = loadFixture("pi", "0.84", `${name}.input.json`);
      const canonical = loadFixture<Record<string, unknown>>("pi", "0.84", `${name}.canonical.json`);
      const decoded = decodePi(input, INVOCATION);
      expect(decoded).toEqual({
        ...canonical,
        harness: { ...(canonical["harness"] as object), version: piHarness.referenceVersion },
        raw: input,
      });
    });
  }

  it("maps tool_result isError to tool.error and success to tool.after", () => {
    const error = decodePi(loadFixture("pi", "0.84", "tool-result-error.input.json"), INVOCATION);
    expect(error.event).toBe("tool.error");
    const success = decodePi(loadFixture("pi", "0.84", "tool-result-bash.input.json"), INVOCATION);
    expect(success.event).toBe("tool.after");
  });

  it("maps both compaction outcomes to context.compact.after", () => {
    const success = decodePi(loadFixture("pi", "0.84", "session-compact.input.json"), INVOCATION);
    expect(success.event).toBe("context.compact.after");
    const failed = decodePi(loadFixture("pi", "0.84", "session-compact-failed.input.json"), INVOCATION);
    expect(failed.event).toBe("context.compact.after");
  });

  it("tolerates unknown event fields", () => {
    const input = loadFixture<Record<string, any>>("pi", "0.84", "tool-call-bash.input.json");
    input["event"]["brandNew"] = true;
    input["event"]["agent"] = "build";
    const decoded = decodePi(input, INVOCATION);
    expect(decoded.event).toBe("tool.before");
  });

  it("snapshots mutable tool input before canonical dispatch", () => {
    const input = { command: "npm install", nested: { keep: true } };
    const decoded = decodePi(
      { event: { type: "tool_call", toolName: "bash", toolCallId: "c1", input }, ctx: { cwd: "C:/project" } },
      INVOCATION,
    );

    if (!("tool" in decoded)) throw new Error("expected tool.before event");
    const toolInput = decoded.tool.input as { command: string; nested: { keep: boolean } };
    expect(toolInput).toEqual(input);
    expect(toolInput).not.toBe(input);
    expect(toolInput.nested).not.toBe(input.nested);

    toolInput.nested.keep = false;
    expect(input.nested.keep).toBe(true);
  });

  it("carries toolCallId into correlation when present", () => {
    const input = loadFixture<{ event: { toolCallId?: string } }>("pi", "0.84", "tool-call-bash.input.json");
    const decoded = decodePi(input, INVOCATION);
    expect(decoded.correlation.toolCallId).toBe(input.event.toolCallId);
  });

  it("rejects unmapped pi events", () => {
    expect(() => decodePi({ event: { type: "turn_start" }, ctx: { cwd: "C:/x" } }, INVOCATION)).toThrow(PiDecodeError);
    expect(() => decodePi({ event: { type: "message_start" }, ctx: { cwd: "C:/x" } }, INVOCATION)).toThrow(
      PiDecodeError,
    );
  });

  it("rejects malformed envelopes", () => {
    expect(() => decodePi(null, INVOCATION)).toThrow(PiDecodeError);
    expect(() => decodePi({ event: "not-object" }, INVOCATION)).toThrow(PiDecodeError);
    expect(() => decodePi({ event: { type: "tool_call" } }, INVOCATION)).toThrow(PiDecodeError);
  });
});

describe("classifyPiTool", () => {
  it("classifies pi built-in tools", () => {
    expect(classifyPiTool("bash", {}).kind).toBe("shell");
    expect(classifyPiTool("powershell", {}).kind).toBe("shell");
    expect(classifyPiTool("read", {}).kind).toBe("file.read");
    expect(classifyPiTool("write", {}).kind).toBe("file.write");
    expect(classifyPiTool("edit", {}).kind).toBe("file.edit");
    expect(classifyPiTool("grep", {}).kind).toBe("file.read");
  });

  it("classifies unknown tools as other without inventing MCP identity", () => {
    // pi has no native server_tool split; an extension tool name is not
    // distinguishable evidence of an MCP tool call.
    expect(classifyPiTool("myserver_dothing", {})).toEqual({
      kind: "other",
      nativeName: "myserver_dothing",
      input: {},
    });
  });

  it("classifies shell tools with the captured shape only", () => {
    const bash = classifyPiTool("bash", { command: "ls" });
    expect(bash.shell).toEqual({ command: "ls", commandKey: "command" });
    // powershell's shape is schema-derived, not captured: both codec
    // directions decline rather than assume the key.
    const powershell = classifyPiTool("powershell", { command: "ls" });
    expect(powershell.shell).toBeUndefined();
  });

  it("does not resolve prototype members for a tool named constructor", () => {
    expect(classifyPiTool("constructor", {}).kind).toBe("other");
  });
});

function result(partial: Partial<HookResult> & Pick<HookResult, "event">): HookResult {
  return { schemaVersion: 1, effects: [], errors: [], ...partial };
}

describe("planPiApplication", () => {
  it("blocks tool calls by handler result", () => {
    expect(
      planPiApplication(
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
    ).toEqual(loadFixture("pi", "0.84", "tool-before-block.output.json"));
  });

  it("rewrites input via in-place event.input replacement", () => {
    expect(
      planPiApplication(
        result({
          event: "tool.before",
          effects: [{ hookId: "r", effect: { kind: "replaceInput", input: { command: "pnpm install" } } }],
        }),
      ),
    ).toEqual(loadFixture("pi", "0.84", "tool-before-rewrite.output.json"));
  });

  it("replaces tool output through the handler result, string-coercing non-strings", () => {
    expect(
      planPiApplication(
        result({
          event: "tool.after",
          effects: [{ hookId: "r", effect: { kind: "replaceOutput", output: "[redacted]" } }],
        }),
      ),
    ).toEqual(loadFixture("pi", "0.84", "tool-after-replace.output.json"));

    expect(
      planPiApplication(
        result({
          event: "tool.after",
          effects: [{ hookId: "r", effect: { kind: "replaceOutput", output: { a: 1 } } }],
        }),
      ),
    ).toEqual({ resultReplacement: { content: [{ type: "text", text: '{"a":1}' }] } });
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

    expect(serializePiOutput(undefined)).toBe("undefined");
    expect(serializePiOutput(42n)).toBe("42");
    expect(serializePiOutput(cyclic)).toBe("[object Object]");
    expect(serializePiOutput(hostile)).toBe("[hooknostic: unrepresentable output]");
  });

  it("injects prompt context as a before_agent_start message", () => {
    expect(
      planPiApplication(
        result({
          event: "prompt.before",
          effects: [{ hookId: "c", effect: { kind: "addContext", context: "Remember the build layout." } }],
        }),
      ),
    ).toEqual(loadFixture("pi", "0.84", "prompt-context.output.json"));
  });

  it("appends model-request context as user messages on the context event", () => {
    expect(
      planPiApplication(
        result({
          event: "model.request.before",
          effects: [{ hookId: "c", effect: { kind: "addContext", context: "Architecture: hexagonal." } }],
        }),
      ),
    ).toEqual(loadFixture("pi", "0.84", "model-request-context.output.json"));
  });

  it("cancels compaction on a block", () => {
    expect(
      planPiApplication(
        result({
          event: "context.compact.before",
          effects: [{ hookId: "g", effect: { kind: "block", reason: "summary would lose state" } }],
          terminatedBy: "g",
        }),
      ),
    ).toEqual(loadFixture("pi", "0.84", "compact-block.output.json"));
  });

  it("posts a stop-prevention reason as a trigger-turn message", () => {
    expect(
      planPiApplication(
        result({
          event: "turn.stop",
          effects: [
            { hookId: "n", effect: { kind: "notify", message: "Checkpoint created." } },
            { hookId: "p", effect: { kind: "preventStop", reason: "run the tests first" } },
          ],
          terminatedBy: "p",
        }),
      ),
    ).toEqual(loadFixture("pi", "0.84", "turn-stop-prevent.output.json"));
  });

  it("does not plan an unsupported notification", () => {
    expect(
      planPiApplication(
        result({
          event: "turn.stop",
          effects: [{ hookId: "n", effect: { kind: "notify", message: "Done." } }],
        }),
      ),
    ).toEqual({});
  });

  it("drops an input replacement that follows a block", () => {
    expect(
      planPiApplication(
        result({
          event: "tool.before",
          effects: [
            { hookId: "r", effect: { kind: "replaceInput", input: { command: "x" } } },
            { hookId: "g", effect: { kind: "block", reason: "no" } },
          ],
          terminatedBy: "g",
        }),
      ),
    ).toEqual({ block: { reason: "no" } });
  });

  it("does not emit prompt-context effects for other events", () => {
    expect(
      planPiApplication(
        result({
          event: "session.start",
          effects: [{ hookId: "c", effect: { kind: "addContext", context: "hi" } }],
        }),
      ),
    ).toEqual({});
  });
});

function exampleIR() {
  const { ir } = buildPluginIR(
    definePlugin({
      name: "p",
      hooks: [hook("tool.before", { id: "g", async run() {} })],
    }),
  );
  return ir!;
}

describe("generatePiArtifacts", () => {
  const TARGET = { id: "pi", version: ">=0.84 <1", delivery: "project" as const, output: "dist" };

  it("emits the bundled project extension module", () => {
    const artifacts = generatePiArtifacts(exampleIR(), TARGET, {
      code: "const extension = () => ({});\nexport default extension;\n",
    });
    expect(artifacts.map((a) => a.path)).toEqual([".pi/extensions/hooknostic.js"]);
  });

  it("emits a loadable pi package for package delivery with no components", () => {
    // `components.root` is optional; without it the projector never runs, and
    // the bundle alone would be a bare module pi cannot discover.
    const artifacts = generatePiArtifacts(
      exampleIR(),
      { ...TARGET, delivery: "package" },
      { code: "const extension = () => ({});\nexport default extension;\n" },
    );
    expect(artifacts.map((a) => a.path).sort()).toEqual(["hooknostic.js", "package.json"]);

    const manifest = JSON.parse(String(artifacts.find((a) => a.path === "package.json")!.contents)) as Record<
      string,
      unknown
    >;
    expect(manifest["type"]).toBe("module");
    expect((manifest["pi"] as Record<string, unknown>)["extensions"]).toEqual(["./hooknostic.js"]);
  });

  it("names a hooks-only package by the target's npm coordinate", () => {
    const manifestOf = (npmName?: string) =>
      JSON.parse(
        String(
          generatePiArtifacts(
            exampleIR(),
            { ...TARGET, delivery: "package", ...(npmName === undefined ? {} : { npmName }) },
            { code: "const extension = () => ({});\nexport default extension;\n" },
          ).find((artifact) => artifact.path === "package.json")!.contents,
        ),
      ) as Record<string, unknown>;

    expect(manifestOf("@example/example-pi")["name"]).toBe("@example/example-pi");
    expect(manifestOf()["name"]).toBe(exampleIR().name);
  });
});

describe("pi output replacement fidelity", () => {
  it("requires an explicit approximate minimum for a required output replacement", () => {
    const plugin = buildPluginIR(
      definePlugin({
        name: "p",
        hooks: [
          hook("tool.after", {
            id: "replace",
            capabilities: { "tool.after.output.replace": "required" },
            async run() {
              return { kind: "replaceOutput", output: { redacted: true } };
            },
          }),
        ],
      }),
    ).ir!;
    const config: HooknosticConfig = {
      entry: "./hooks.ts",
      targets: {
        pi: { version: piHarness.referenceVersion, delivery: "project", output: "./dist/pi" },
      },
    };
    const adapters = { pi: piAdapter() };
    const strict = analyzeCapabilities(plugin, config, adapters);
    expect(strict.ok).toBe(false);
    expect(strict.targets.pi?.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HN201",
        severity: "error",
        capability: "tool.after.output.replace",
        support: "approximate",
      }),
    );

    const relaxed = analyzeCapabilities(
      plugin,
      {
        ...config,
        targets: {
          pi: { ...config.targets.pi!, compatibility: { minimum: "approximate" } },
        },
      },
      adapters,
    );
    expect(relaxed.ok).toBe(true);
  });
});

describe("validateArtifacts for package delivery", () => {
  const adapter = piAdapter();
  const PKG = { id: "pi", version: ">=0.84 <1", delivery: "package" as const, output: "dist" };
  const manifest = { path: "package.json", contents: '{"name":"example-plugin","version":"1.2.3"}\n' };
  const goodExtension = {
    path: "hooknostic.js",
    contents:
      "import { createHooknosticExtension } from 'x';\nconst e = createHooknosticExtension(p, o);\nexport default e;\n",
  };

  it("validates the package-root module rather than the project path", async () => {
    const diagnostics = await adapter.validateArtifacts!(
      [{ path: "hooknostic.js", contents: "export const NotTheExtension = 1;\n" }, manifest],
      PKG,
    );
    expect(diagnostics.map((d) => d.code)).toContain("HN301");
  });

  it("refuses a package with no manifest", async () => {
    const diagnostics = await adapter.validateArtifacts!([{ path: "hooknostic.js", contents: "// x\n" }], PKG);
    expect(diagnostics.some((d) => d.message.includes("package.json"))).toBe(true);
  });

  it.each(["_under", "has space"])("refuses a hooks-only package named %s, which npm cannot pack", async (name) => {
    const diagnostics = await adapter.validateArtifacts!(
      [goodExtension, { path: "package.json", contents: `{"name":${JSON.stringify(name)},"version":"1.2.3"}\n` }],
      PKG,
    );
    const diagnostic = diagnostics.find((d) => d.message.includes("not a valid npm package name"));
    expect(diagnostic?.severity).toBe("error");
  });

  it("accepts a well-formed package", async () => {
    const diagnostics = await adapter.validateArtifacts!([goodExtension, manifest], PKG);
    expect(diagnostics).toEqual([]);
  });

  it("accepts a projected package's manifest without double-reporting", async () => {
    // The Agent Plugin projector reports manifest findings while building its
    // plan; validating them again here would double every finding. The
    // projector-built package carries its component module, which is what
    // marks it as projected.
    const diagnostics = await adapter.validateArtifacts!(
      [
        goodExtension,
        { path: "hooknostic-agent-plugin.js", contents: "export const components = {};\n" },
        { path: "skills/probe/SKILL.md", contents: "---\nname: probe\n---\nbody\n" },
        { path: "package.json", contents: '{"name":"UPPER","version":"next"}\n' },
      ],
      PKG,
    );
    expect(diagnostics).toEqual([]);
  });
});
