import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeCapabilities, buildPluginIR, statedMcpEvents } from "@hooknostic/core";
import type { HooknosticConfig } from "@hooknostic/sdk";
import type { HookResult } from "@hooknostic/sdk";
import { definePlugin, hook } from "@hooknostic/sdk";
import { fixturePath, loadFixture, planCanonicalFixtures } from "@hooknostic/testkit";

import { planPiApplication, serializePiOutput } from "./apply.js";
import { decodePi, PiDecodeError, type PiEnrichment, type PiNativeEvent } from "./decode.js";
import { generatePiArtifacts } from "./generate.js";
import { piHarness } from "./harness.js";
import { piAdapter, piNativeMcp } from "./index.js";
import { PI_LEGACY_RANGE, PI_RANGE, piCapabilityProfiles } from "./profile.js";
import { classifyPiTool } from "./toolmap.js";

const INVOCATION = { targetId: "pi", harnessVersion: piHarness.referenceVersion };

describe("decodePi fixtures", () => {
  const CASES = [
    "session-start",
    "before-agent-start",
    "before-agent-start-isolated",
    "context",
    "tool-call-write",
    "tool-call-read",
    "tool-call-edit",
    "tool-call-bash-configured-powershell",
    "tool-call-bash",
    "tool-call-powershell",
    "tool-result-write",
    "tool-result-read",
    "tool-result-edit",
    "tool-result-bash-configured-powershell",
    "tool-result-bash",
    "tool-result-powershell",
    "tool-result-error",
    "tool-call-mcp",
    "tool-result-mcp",
    "tool-call-codemode",
    "tool-call-mcp-nested",
    "tool-result-mcp-nested",
    "tool-result-mcp-extension",
    "tool-result-mcp-shadow",
    "agent-settled",
    "agent-settled-with-message",
    "agent-settled-error",
    "agent-settled-aborted",
    "agent-settled-retry",
    "agent-settled-retry-aborted",
    "agent-settled-resumed",
    "session-shutdown",
    "session-before-compact",
    "session-compact",
    "session-compact-failed",
  ] as const;

  for (const name of CASES) {
    it(`decodes ${name} to its canonical event`, () => {
      const input = loadFixture("pi", piHarness.fixtureDir, `${name}.input.json`);
      const canonical = loadFixture<Record<string, unknown>>("pi", piHarness.fixtureDir, `${name}.canonical.json`);
      const enrichment = existsSync(fixturePath("pi", piHarness.fixtureDir, `${name}.enrichment.json`))
        ? loadFixture<PiEnrichment>("pi", piHarness.fixtureDir, `${name}.enrichment.json`)
        : {};
      const decoded = decodePi(input, INVOCATION, enrichment);
      expect(decoded).toEqual({
        ...canonical,
        harness: { ...(canonical["harness"] as object), version: piHarness.referenceVersion },
        raw: input,
      });
    });
  }

  it("maps tool_result isError to tool.error and success to tool.after", () => {
    const error = decodePi(loadFixture("pi", piHarness.fixtureDir, "tool-result-error.input.json"), INVOCATION);
    expect(error.event).toBe("tool.error");
    const success = decodePi(loadFixture("pi", piHarness.fixtureDir, "tool-result-bash.input.json"), INVOCATION);
    expect(success.event).toBe("tool.after");
  });

  it("maps both compaction outcomes to context.compact.after", () => {
    const success = decodePi(loadFixture("pi", piHarness.fixtureDir, "session-compact.input.json"), INVOCATION);
    expect(success.event).toBe("context.compact.after");
    const failed = decodePi(loadFixture("pi", piHarness.fixtureDir, "session-compact-failed.input.json"), INVOCATION);
    expect(failed.event).toBe("context.compact.after");
  });

  it("tolerates unknown event fields", () => {
    const input = loadFixture<Record<string, any>>("pi", piHarness.fixtureDir, "tool-call-bash.input.json");
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
    const input = loadFixture<{ event: { toolCallId?: string } }>(
      "pi",
      piHarness.fixtureDir,
      "tool-call-bash.input.json",
    );
    const decoded = decodePi(input, INVOCATION);
    expect(decoded.correlation.toolCallId).toBe(input.event.toolCallId);
  });

  it("declines before_agent_start for a captured custom-message run", () => {
    // A sendMessage({triggerTurn: true}) continuation submits no user prompt.
    const input = loadFixture<{ event: Record<string, unknown> }>(
      "pi",
      piHarness.fixtureDir,
      "before-agent-start-custom.input.json",
    );
    expect(input.event["messageType"]).toBe("custom");
    expect(() => decodePi(input, INVOCATION)).toThrow(/custom-message run/);
    const user = loadFixture<{ event: Record<string, unknown> }>(
      "pi",
      piHarness.fixtureDir,
      "before-agent-start-isolated.input.json",
    );
    expect(user.event["messageType"]).toBe("user");
    expect(decodePi(user, INVOCATION).event).toBe("prompt.before");
  });

  it("holds a current canonical for every input except the declined ones", () => {
    const fixturesDir = fixturePath("pi", piHarness.fixtureDir, ".");
    const plan = planCanonicalFixtures({
      fixturesDir,
      decode: (input, enrichment) => decodePi(input, INVOCATION, enrichment as PiEnrichment),
      isDecline: (error) => error instanceof PiDecodeError,
    });
    expect(plan.stale).toEqual([]);
    expect([...plan.writes.keys()]).toContain("before-agent-start.canonical.json");
    expect([...plan.writes.keys()]).not.toContain("before-agent-start-custom.canonical.json");
    for (const [name, canonical] of plan.writes) {
      expect(JSON.parse(readFileSync(join(fixturesDir, name), "utf8")), name).toEqual(
        JSON.parse(JSON.stringify(canonical)),
      );
    }
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
    // Only pi's mcp__<server>__<tool> spelling is MCP; another extension tool
    // name is not distinguishable evidence of an MCP tool call.
    expect(classifyPiTool("myserver_dothing", {})).toEqual({
      kind: "other",
      nativeName: "myserver_dothing",
      input: {},
    });
  });

  it.each(["tool-call-mcp", "tool-call-mcp-nested"])(
    "classifies the captured native MCP call in %s as mcp without guessing its split",
    (name) => {
      const input = loadFixture<PiNativeEvent>("pi", piHarness.fixtureDir, `${name}.input.json`);
      const decoded = decodePi(input, INVOCATION);
      if (!("tool" in decoded)) throw new Error("expected a tool event");
      expect(decoded.tool).toEqual({ kind: "mcp", nativeName: "mcp__probe__probe_echo", input: {} });
    },
  );

  it.each(["tool-result-mcp", "tool-result-mcp-nested"])(
    "takes the server and tool of the captured MCP result in %s from the details pi states",
    (name) => {
      const input = loadFixture<PiNativeEvent>("pi", piHarness.fixtureDir, `${name}.input.json`);
      const enrichment = loadFixture<PiEnrichment>("pi", piHarness.fixtureDir, `${name}.enrichment.json`);
      const decoded = decodePi(input, INVOCATION, enrichment);
      if (!("tool" in decoded)) throw new Error("expected a tool event");
      expect(decoded.tool).toEqual({
        kind: "mcp",
        nativeName: "mcp__probe__probe_echo",
        input: {},
        mcp: { server: "probe", tool: "probe_echo" },
      });
      // Without the tool's source, nothing says pi's MCP extension wrote those details.
      expect((decodePi(input, INVOCATION) as { tool: unknown }).tool).toEqual({
        kind: "mcp",
        nativeName: "mcp__probe__probe_echo",
        input: {},
      });
    },
  );

  it.each([
    ["tool-result-mcp-extension", "mcp__fake__echo", { server: "fake", tool: "echo" }],
    ["tool-result-mcp-shadow", "mcp__probe__probe_echo", { server: "shadow", tool: "echo" }],
  ] as const)("takes no split from the details another extension's tool states in %s", (name, nativeName, details) => {
    // Another extension registered the tool, under an MCP-shaped name or the
    // native tool's own; its result states a split that is that extension's.
    const input = loadFixture<PiNativeEvent>("pi", piHarness.fixtureDir, `${name}.input.json`);
    const enrichment = loadFixture<PiEnrichment>("pi", piHarness.fixtureDir, `${name}.enrichment.json`);
    expect(input.event["details"]).toEqual(details);
    const decoded = decodePi(input, INVOCATION, enrichment);
    if (!("tool" in decoded)) throw new Error("expected a tool event");
    expect(decoded.tool).toEqual({ kind: "mcp", nativeName, input: {} });
    // The same details from pi's own MCP extension would state the split.
    const native = loadFixture<PiEnrichment>("pi", piHarness.fixtureDir, "tool-result-mcp.enrichment.json");
    expect((decodePi(input, INVOCATION, native) as { tool: { mcp?: unknown } }).tool.mcp).toEqual(details);
  });

  it("never invents an MCP split from pi's lossy tool name", () => {
    // pi 1.3.0 createMcpToolName: `get__secret` on `probe`, `_hidden` on
    // `probe`, and a long server name that pi truncates and hashes.
    for (const name of ["mcp__probe__get__secret", "mcp__probe___hidden", `mcp__${"s".repeat(50)}__ech_1a2b3c4d`]) {
      expect(classifyPiTool(name, {})).toEqual({ kind: "mcp", nativeName: name, input: {} });
    }
    // A stated identity applies to an MCP tool only, as pi registered it.
    expect(classifyPiTool("mcp__a_b__c", {}, { mcp: { server: "a-b", tool: "c" } }).mcp).toEqual({
      server: "a-b",
      tool: "c",
    });
    expect(classifyPiTool("bash", { command: "ls" }, { mcp: { server: "a", tool: "b" } })).not.toHaveProperty("mcp");
    // details that does not name both parts states nothing.
    const partial = decodePi(
      {
        event: {
          type: "tool_result",
          toolName: "mcp__a_b__c",
          toolCallId: "1",
          input: {},
          content: [],
          details: { server: "a-b" },
        },
        ctx: { cwd: "C:/project" },
      },
      INVOCATION,
      loadFixture<PiEnrichment>("pi", piHarness.fixtureDir, "tool-result-mcp.enrichment.json"),
    );
    expect("tool" in partial && partial.tool.mcp).toBeUndefined();
  });

  it.each([
    ["tool-result-mcp-error", { server: "probe", tool: "probe_fail" }],
    ["tool-result-mcp-rpc-error", undefined],
  ] as const)("decodes the captured failing MCP call in %s with the split only where pi states it", (name, mcp) => {
    const input = loadFixture<PiNativeEvent>("pi", piHarness.fixtureDir, `${name}.input.json`);
    const enrichment = loadFixture<PiEnrichment>("pi", piHarness.fixtureDir, `${name}.enrichment.json`);
    const decoded = decodePi(input, INVOCATION, enrichment);
    expect(decoded.event).toBe("tool.error");
    if (!("tool" in decoded)) throw new Error("expected a tool event");
    expect(decoded.tool.kind).toBe("mcp");
    expect(decoded.tool.mcp).toEqual(mcp);
  });

  it("keeps an mcp__ tool other, with no stated split, outside the 1.x line", () => {
    // pi 0.84 has no native MCP channel; there an mcp__ tool is another
    // extension's, and its details state nothing pi established.
    const result = loadFixture<PiNativeEvent>("pi", piHarness.fixtureDir, "tool-result-mcp.input.json");
    const call = loadFixture<PiNativeEvent>("pi", piHarness.fixtureDir, "tool-call-mcp.input.json");
    const legacy = { nativeMcp: false };
    const other = { kind: "other", nativeName: "mcp__probe__probe_echo", input: {} };
    const source = loadFixture<PiEnrichment>("pi", piHarness.fixtureDir, "tool-result-mcp.enrichment.json");
    expect((decodePi(result, INVOCATION, source, legacy) as { tool: unknown }).tool).toEqual(other);
    expect((decodePi(call, INVOCATION, {}, legacy) as { tool: unknown }).tool).toEqual(other);
    // classifyTool decides for the target's range exactly as the shim does.
    const classify = piAdapter().classifyTool!;
    const stated = { mcp: { server: "probe", tool: "probe_echo" } };
    expect(classify("mcp__probe__probe_echo", {}, stated, PI_LEGACY_RANGE)).toEqual(other);
    // A range spanning both lines is not within 1.x, so it is read conservatively.
    expect(classify("mcp__probe__probe_echo", {}, stated, `${PI_LEGACY_RANGE} || ${PI_RANGE}`)).toEqual(other);
    expect(classify("mcp__probe__probe_echo", {}, stated, PI_RANGE).mcp).toEqual(stated.mcp);
    expect(classify("mcp__probe__probe_echo", {}, stated).mcp).toEqual(stated.mcp);
  });

  it("applies the MCP split exactly where the adapter declares pi states it", () => {
    // The shim and classifyTool decide by piNativeMcp; inspect, dispatch, and
    // the contract suite by statedMcpEvents. One declaration answers both.
    const { mcpIdentity } = piAdapter();
    const probes = [...piCapabilityProfiles.map((profile) => profile.range), piHarness.referenceVersion, "2.0.0"];
    for (const range of probes) {
      expect(piNativeMcp(range), range).toBe(statedMcpEvents(mcpIdentity, range).length > 0);
    }
  });

  it("settles the MCP line in the generated entry from the target range", () => {
    const entry = (targetRange: string) =>
      piAdapter().shimEntry!({
        entryImportPath: "./hooks.ts",
        capabilities: {},
        minimumCapabilityLevel: "exact",
        policy: { onHookError: "continue", timeoutMs: 1000, contextCharLimit: 1000, notifyCharLimit: 1000 },
        targetRange,
      });
    expect(entry(PI_LEGACY_RANGE)).toContain("  nativeMcp: false,");
    expect(entry(PI_RANGE)).not.toContain("nativeMcp");
  });

  it("keeps the captured codemode script tool as other", () => {
    const input = loadFixture<PiNativeEvent>("pi", piHarness.fixtureDir, "tool-call-codemode.input.json");
    const decoded = decodePi(input, INVOCATION);
    if (!("tool" in decoded)) throw new Error("expected a tool event");
    expect(decoded.tool.kind).toBe("other");
    expect(classifyPiTool("list_mcp_resources", {}).kind).toBe("other");
  });

  it("classifies shell tools with the captured shape only", () => {
    const bash = classifyPiTool("bash", { command: "ls" });
    expect(bash.shell).toEqual({ command: "ls", commandKey: "command" });
    // The Windows loopback fixture captures the same command key.
    const powershell = classifyPiTool("powershell", { command: "ls" });
    expect(powershell.shell).toEqual({ command: "ls", commandKey: "command", dialect: "powershell" });
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
    ).toEqual(loadFixture("pi", piHarness.fixtureDir, "tool-before-block.output.json"));
  });

  it("rewrites input via in-place event.input replacement", () => {
    expect(
      planPiApplication(
        result({
          event: "tool.before",
          effects: [{ hookId: "r", effect: { kind: "replaceInput", input: { command: "pnpm install" } } }],
        }),
      ),
    ).toEqual(loadFixture("pi", piHarness.fixtureDir, "tool-before-rewrite.output.json"));
  });

  it("replaces tool output through the handler result, string-coercing non-strings", () => {
    expect(
      planPiApplication(
        result({
          event: "tool.after",
          effects: [{ hookId: "r", effect: { kind: "replaceOutput", output: "[redacted]" } }],
        }),
      ),
    ).toEqual(loadFixture("pi", piHarness.fixtureDir, "tool-after-replace.output.json"));

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
    ).toEqual(loadFixture("pi", piHarness.fixtureDir, "prompt-context.output.json"));
  });

  it("appends model-request context as user messages on the context event", () => {
    expect(
      planPiApplication(
        result({
          event: "model.request.before",
          effects: [{ hookId: "c", effect: { kind: "addContext", context: "Architecture: hexagonal." } }],
        }),
      ),
    ).toEqual(loadFixture("pi", piHarness.fixtureDir, "model-request-context.output.json"));
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
    ).toEqual(loadFixture("pi", piHarness.fixtureDir, "compact-block.output.json"));
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
    ).toEqual(loadFixture("pi", piHarness.fixtureDir, "turn-stop-prevent.output.json"));
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
  const TARGET = { id: "pi", version: piHarness.recommendedRange, delivery: "project" as const, output: "dist" };

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
              return { kind: "replaceOutput" as const, output: { redacted: true } };
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
  const PKG = { id: "pi", version: piHarness.recommendedRange, delivery: "package" as const, output: "dist" };
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
