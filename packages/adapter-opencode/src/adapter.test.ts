import { describe, expect, it } from "vitest";
import { definePlugin, hook } from "@hooknostic/sdk";
import type { HookResult } from "@hooknostic/sdk";
import { buildPluginIR } from "@hooknostic/core";
import { loadFixture } from "@hooknostic/testkit";
import { planOpenCodeApplication } from "./apply.js";
import { decodeOpenCode, OpenCodeDecodeError } from "./decode.js";
import { generateOpenCodeArtifacts } from "./generate.js";
import { opencodeAdapter } from "./index.js";
import { classifyOpenCodeTool } from "./toolmap.js";

const INVOCATION = { targetId: "opencode", harnessVersion: "1.18.18" };

describe("decodeOpenCode fixtures", () => {
  const CASES = [
    "tool-before",
    "tool-after",
    "permission-ask",
    "compacting",
    "session-idle",
  ] as const;

  for (const name of CASES) {
    it(`decodes ${name} to its canonical event`, () => {
      const input = loadFixture("opencode", "1.18", `${name}.input.json`);
      const canonical = loadFixture<Record<string, unknown>>(
        "opencode",
        "1.18",
        `${name}.canonical.json`,
      );
      const decoded = decodeOpenCode(input, INVOCATION);
      expect(decoded).toEqual({
        ...canonical,
        harness: { ...(canonical["harness"] as object), version: "1.18.18" },
        raw: input,
      });
    });
  }

  it("tolerates unknown callback input fields", () => {
    const input = loadFixture<Record<string, any>>(
      "opencode",
      "1.18",
      "tool-before.input.json",
    );
    input["input"]["agent"] = "build";
    input["input"]["brandNew"] = true;
    const decoded = decodeOpenCode(input, INVOCATION);
    expect(decoded.event).toBe("tool.before");
  });

  it("rejects unmapped callbacks and bus events", () => {
    expect(() =>
      decodeOpenCode({ hook: "lsp.updated", directory: "C:/x", input: {} }, INVOCATION),
    ).toThrow(OpenCodeDecodeError);
    expect(() =>
      decodeOpenCode(
        { hook: "event", directory: "C:/x", input: { event: { type: "storage.write" } } },
        INVOCATION,
      ),
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
          effects: [
            { hookId: "r", effect: { kind: "replaceInput", input: { command: "pnpm install" } } },
          ],
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

  it("denies permission requests via status mutation, not a throw", () => {
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
});

describe("generateOpenCodeArtifacts", () => {
  const TARGET = {
    id: "opencode",
    version: ">=1.18",
    mode: "local" as const,
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

  it("refuses npm-package mode (deferred past v0.1)", () => {
    expect(() =>
      generateOpenCodeArtifacts(exampleIR(), { ...TARGET, mode: "plugin" }, { code: "" }),
    ).toThrow(/deferred/);
  });
});

describe("opencodeAdapter capability data", () => {
  it("resolves the 1.1x profile with rationale on every non-exact cell", () => {
    const resolved = opencodeAdapter().capabilities({
      id: "opencode",
      version: ">=1.18",
      mode: "local",
      output: "./d",
    });
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.matrix?.["tool.before.block"]?.level).toBe("exact");
    expect(resolved.matrix?.["permission.request.block"]?.level).toBe("exact");
    expect(resolved.matrix?.["tool.before.context.add"]).toBeUndefined();
    expect(resolved.matrix?.["turn.stop.prevent"]).toBeUndefined();
    expect(resolved.matrix?.["agent.start.observe"]).toBeUndefined();
    for (const [id, entry] of Object.entries(resolved.matrix ?? {})) {
      if (entry.level !== "exact") {
        expect(entry.rationale, `capability ${id} needs a rationale`).toBeTruthy();
      }
    }
  });
});
