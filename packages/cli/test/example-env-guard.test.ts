import { describe, expect, it } from "vitest";

import type { HookContext, ToolBeforeEvent, ToolInvocation } from "@hooknostic/sdk";
import { fileCodec } from "@hooknostic/sdk";

import plugin from "../../../examples/agent-plugin/src/hooks.js";

// The combined example's .env guard is the documented pattern for a portable
// file guard, so its handling of an absent tool.file is pinned here: a write or
// edit whose targets cannot be read must be refused, not let through.
const guard = plugin.hooks.find((hook) => hook.id === "protect-env-files")!;
const ctx = {} as HookContext;
const claudeFiles = fileCodec({ Read: { pathKey: "file_path" }, Edit: { pathKey: "file_path" } });

function event(tool: ToolInvocation): ToolBeforeEvent {
  return {
    schemaVersion: 1,
    event: "tool.before",
    harness: { id: "claude", nativeEvent: "PreToolUse" },
    session: { cwd: "C:/repo" },
    correlation: {},
    raw: {},
    tool,
  };
}

function withView(kind: ToolInvocation["kind"], nativeName: string, input: Record<string, unknown>): ToolBeforeEvent {
  const file = claudeFiles.classify(nativeName, input);
  return event({ kind, nativeName, input, ...(file !== undefined ? { file } : {}) });
}

describe("combined example .env guard", () => {
  it("blocks a .env target and passes an ordinary one", async () => {
    expect(await guard.run(withView("file.read", "Read", { file_path: "C:/repo/.env" }), ctx)).toMatchObject({
      kind: "block",
    });
    expect(await guard.run(withView("file.edit", "Edit", { file_path: "C:/repo/notes.md" }), ctx)).toBeUndefined();
  });

  it("refuses an edit whose targets it cannot read, but lets a search through", async () => {
    // MultiEdit has no captured shape, so no view -- the edit is unverifiable.
    const multiEdit = event({
      kind: "file.edit",
      nativeName: "MultiEdit",
      input: { file_path: "C:/repo/.env", edits: [] },
    });
    expect(await guard.run(multiEdit, ctx)).toMatchObject({ kind: "block" });

    // A search takes a pattern, not a file: absent view, nothing to verify.
    const grep = event({ kind: "file.read", nativeName: "Grep", input: { pattern: "TODO" } });
    expect(await guard.run(grep, ctx)).toBeUndefined();
  });
});
