import { describe, expect, it } from "vitest";
import { loadFixture } from "@hooknostic/testkit";
import { baseHookEventSchema } from "@hooknostic/sdk";
import { CodexDecodeError, decodeCodex } from "./decode.js";
import { classifyCodexTool } from "./toolmap.js";

const INVOCATION = { targetId: "codex", harnessVersion: "0.148.0" };

const CASES = [
  "session-start",
  "session-end",
  "prompt-submit",
  "pre-tool-bash",
  "post-tool-bash",
  "permission-request",
  "subagent-start",
  "subagent-stop",
  "pre-compact",
  "stop",
] as const;

describe("decodeCodex fixtures", () => {
  for (const name of CASES) {
    it(`decodes ${name} to its canonical event`, () => {
      const input = loadFixture("codex", "0.148", `${name}.input.json`);
      const canonical = loadFixture<Record<string, unknown>>(
        "codex",
        "0.148",
        `${name}.canonical.json`,
      );
      const decoded = decodeCodex(input, INVOCATION);
      expect(decoded).toEqual({
        ...canonical,
        harness: { ...(canonical["harness"] as object), version: "0.148.0" },
        raw: input,
      });
      expect(baseHookEventSchema.parse(decoded)).toBeTruthy();
    });
  }

  it("tolerates additive vendor fields and preserves raw", () => {
    const input = loadFixture<Record<string, unknown>>(
      "codex",
      "0.148",
      "pre-tool-bash.input.json",
    );
    const decoded = decodeCodex({ ...input, future_field: 42 }, INVOCATION);
    expect(decoded.event).toBe("tool.before");
    expect((decoded.raw as Record<string, unknown>)["future_field"]).toBe(42);
  });

  it("handles null last_assistant_message without inventing values", () => {
    const input = loadFixture<Record<string, unknown>>("codex", "0.148", "stop.input.json");
    const decoded = decodeCodex({ ...input, last_assistant_message: null }, INVOCATION);
    expect(decoded.event).toBe("turn.stop");
    expect((decoded as { lastMessage?: string }).lastMessage).toBeUndefined();
  });

  it("throws CodexDecodeError for unmapped events", () => {
    expect(() =>
      decodeCodex({ hook_event_name: "SomethingNew", cwd: "C:/x" }, INVOCATION),
    ).toThrow(CodexDecodeError);
  });
});

describe("classifyCodexTool", () => {
  it("classifies codex tool paths", () => {
    expect(classifyCodexTool("Bash", {}).kind).toBe("shell");
    expect(classifyCodexTool("exec_command", {}).kind).toBe("shell");
    expect(classifyCodexTool("apply_patch", {}).kind).toBe("file.edit");
    expect(classifyCodexTool("spawn_agent", {}).kind).toBe("agent");
    expect(classifyCodexTool("update_plan", {}).kind).toBe("other");
    expect(classifyCodexTool("web_search", {}).kind).toBe("web.search");
    expect(classifyCodexTool("mcp__filesystem__read_file", {}).mcp).toEqual({
      server: "filesystem",
      tool: "read_file",
    });
  });
});
