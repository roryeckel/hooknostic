import { describe, expect, it } from "vitest";

import { baseHookEventSchema } from "@hooknostic/sdk";
import { loadFixture } from "@hooknostic/testkit";

import { ClaudeDecodeError, decodeClaude } from "./decode.js";
import { claudeHarness } from "./harness.js";
import { classifyClaudeTool } from "./toolmap.js";

const INVOCATION = { targetId: "claude", harnessVersion: claudeHarness.referenceVersion };

const CASES = [
  "session-start",
  "session-end",
  "prompt-submit",
  "pre-tool-bash",
  "pre-tool-powershell",
  "pre-tool-read",
  "pre-tool-write",
  "pre-tool-edit",
  "pre-tool-notebookedit",
  "post-tool-bash",
  "post-tool-failure",
  "permission-request",
  "pre-compact",
  "post-compact",
  "subagent-start",
  "subagent-stop",
  "pre-tool-read-subagent",
  "post-tool-read-subagent",
  "pre-tool-read-primary-agent",
  "session-start-primary-agent",
  "stop",
] as const;

describe("decodeClaude fixtures", () => {
  for (const name of CASES) {
    it(`decodes ${name} to its canonical event`, () => {
      const input = loadFixture("claude", "2.1", `${name}.input.json`);
      const canonical = loadFixture<Record<string, unknown>>("claude", "2.1", `${name}.canonical.json`);
      const decoded = decodeClaude(input, INVOCATION);
      // Canonical fixtures omit raw and harness.version; splice them in.
      expect(decoded).toEqual({
        ...canonical,
        harness: { ...(canonical["harness"] as object), version: claudeHarness.referenceVersion },
        raw: input,
      });
      expect(baseHookEventSchema.parse(decoded)).toBeTruthy();
    });
  }

  it("tolerates unknown additive vendor fields and preserves them in raw", () => {
    const input = loadFixture<Record<string, unknown>>("claude", "2.1", "pre-tool-bash.input.json");
    const extended = {
      ...input,
      brand_new_field: { future: true },
      another: [1, 2, 3],
    };
    const decoded = decodeClaude(extended, INVOCATION);
    expect(decoded.event).toBe("tool.before");
    expect((decoded.raw as Record<string, unknown>)["brand_new_field"]).toEqual({
      future: true,
    });
  });

  it("does not invent missing correlation identifiers", () => {
    const decoded = decodeClaude({ hook_event_name: "SessionStart", cwd: "C:/x" }, { targetId: "claude" });
    expect(decoded.session.id).toBeUndefined();
    expect(decoded.correlation).toEqual({});
    expect(decoded.harness.version).toBeUndefined();
  });

  it("throws ClaudeDecodeError for unmapped vendor events and malformed payloads", () => {
    expect(() => decodeClaude({ hook_event_name: "Notification", cwd: "C:/x" }, INVOCATION)).toThrow(ClaudeDecodeError);
    expect(() => decodeClaude("not-an-object", INVOCATION)).toThrow(ClaudeDecodeError);
    expect(() => decodeClaude({ cwd: "C:/x" }, INVOCATION)).toThrow(ClaudeDecodeError);
  });
});

describe("classifyClaudeTool", () => {
  it("classifies built-in and MCP tools", () => {
    expect(classifyClaudeTool("Bash", {}).kind).toBe("shell");
    expect(classifyClaudeTool("Read", {}).kind).toBe("file.read");
    expect(classifyClaudeTool("Edit", {}).kind).toBe("file.edit");
    expect(classifyClaudeTool("Write", {}).kind).toBe("file.write");
    expect(classifyClaudeTool("WebFetch", {}).kind).toBe("web.fetch");
    expect(classifyClaudeTool("Task", {}).kind).toBe("agent");
    expect(classifyClaudeTool("SomethingNew", {}).kind).toBe("other");

    const mcp = classifyClaudeTool("mcp__memory__create_entities", { a: 1 });
    expect(mcp).toEqual({
      kind: "mcp",
      nativeName: "mcp__memory__create_entities",
      input: { a: 1 },
      mcp: { server: "memory", tool: "create_entities" },
    });

    const pluginMcp = classifyClaudeTool("mcp__plugin_my-plugin_db__query", {});
    expect(pluginMcp.mcp).toEqual({ server: "plugin_my-plugin_db", tool: "query" });
  });
});
