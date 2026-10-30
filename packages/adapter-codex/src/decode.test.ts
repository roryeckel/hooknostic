import { describe, expect, it } from "vitest";

import { baseHookEventSchema } from "@hooknostic/sdk";
import { loadFixture } from "@hooknostic/testkit";

import { CodexDecodeError, decodeCodex } from "./decode.js";
import { codexHarness } from "./harness.js";
import { classifyCodexTool } from "./toolmap.js";

const INVOCATION = { targetId: "codex", harnessVersion: codexHarness.referenceVersion };

const CASES = [
  "session-start",
  "session-end",
  "prompt-submit",
  "pre-tool-bash",
  "post-tool-bash",
  "pre-tool-apply-patch-add",
  "pre-tool-apply-patch-update-move",
  "pre-tool-apply-patch-delete",
  "pre-tool-apply-patch-multi",
  "post-tool-apply-patch-add",
  "pre-tool-view-image",
  "pre-tool-code-mode",
  "post-tool-code-mode",
  "permission-request",
  "subagent-start",
  "subagent-stop",
  "subagent-start-live",
  "subagent-stop-live",
  "pre-tool-bash-subagent",
  "post-tool-bash-subagent",
  "pre-tool-wait-agent",
  "pre-compact",
  "stop",
] as const;

describe("decodeCodex fixtures", () => {
  for (const name of CASES) {
    it(`decodes ${name} to its canonical event`, () => {
      const input = loadFixture("codex", "0.148", `${name}.input.json`);
      const canonical = loadFixture<Record<string, unknown>>("codex", "0.148", `${name}.canonical.json`);
      const decoded = decodeCodex(input, INVOCATION);
      expect(decoded).toEqual({
        ...canonical,
        harness: { ...(canonical["harness"] as object), version: codexHarness.referenceVersion },
        raw: input,
      });
      expect(baseHookEventSchema.parse(decoded)).toBeTruthy();
    });
  }

  it("tolerates additive vendor fields and preserves raw", () => {
    const input = loadFixture<Record<string, unknown>>("codex", "0.148", "pre-tool-bash.input.json");
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
    expect(() => decodeCodex({ hook_event_name: "SomethingNew", cwd: "C:/x" }, INVOCATION)).toThrow(CodexDecodeError);
  });
});

describe("shell argument normalization", () => {
  it("reads the command from whichever key the native tool uses", () => {
    // The finding this exists for: `Bash` names it `command`, `exec_command`
    // names it `cmd`. A portable guard matching `kind: "shell"` and reading
    // `input.command` matched every target and silently permitted every Codex
    // exec_command call. Captured on codex-cli 0.151.0 --
    // see .capture/codex-tools/README.md.
    expect(classifyCodexTool("Bash", { command: "echo one" }).shell).toEqual({
      command: "echo one",
      commandKey: "command",
    });
    expect(classifyCodexTool("exec_command", { cmd: "echo two", workdir: "C:/proj" }).shell).toEqual({
      command: "echo two",
      cwd: "C:/proj",
      commandKey: "cmd",
      cwdKey: "workdir",
    });
  });

  it("leaves shell undefined for a shell tool whose shape was never captured", () => {
    // `shell` is classified as a shell tool but was never observed as a tool
    // NAME, so its argument shape is unknown. Undefined tells a hook to fall
    // back to `input`; a guess would tell it nothing and be wrong silently.
    expect(classifyCodexTool("shell", { cmd: "echo three" }).kind).toBe("shell");
    expect(classifyCodexTool("shell", { cmd: "echo three" }).shell).toBeUndefined();
  });

  it("never replaces the verbatim input", () => {
    const input = { cmd: "echo four", workdir: "C:/proj", login: false };
    expect(classifyCodexTool("exec_command", input).input).toBe(input);
  });
});

describe("classifyCodexTool", () => {
  it("classifies codex tool paths", () => {
    expect(classifyCodexTool("Bash", {}).kind).toBe("shell");
    expect(classifyCodexTool("exec_command", {}).kind).toBe("shell");
    expect(classifyCodexTool("apply_patch", {}).kind).toBe("file.edit");
    expect(classifyCodexTool("spawn_agent", {}).kind).toBe("agent");
    // Waiting on a subagent is not starting one (fixture pre-tool-wait-agent).
    expect(classifyCodexTool("multi_agent_v1wait_agent", {}).kind).toBe("other");
    expect(classifyCodexTool("update_plan", {}).kind).toBe("other");
    expect(classifyCodexTool("web_search", {}).kind).toBe("web.search");
    expect(classifyCodexTool("mcp__filesystem__read_file", {}).mcp).toEqual({
      server: "filesystem",
      tool: "read_file",
    });
  });
});
