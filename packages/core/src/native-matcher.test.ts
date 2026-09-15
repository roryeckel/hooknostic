import { describe, expect, it } from "vitest";

import type { ToolMatch } from "@hooknostic/sdk";

import type { HookIR } from "./ir.js";
import { namesByKind, nativeToolSelection, type NativeToolVocabulary } from "./native-matcher.js";

const VOCABULARY: NativeToolVocabulary = {
  names: namesByKind({ Bash: "shell", PowerShell: "shell", Read: "file.read", Grep: "file.read", Other: "other" }),
  patterns: { mcp: "mcp__.+__.+" },
};

function hooks(...matches: (ToolMatch | undefined)[]): HookIR[] {
  return matches.map(
    (match, index) =>
      ({ id: `h${index}`, event: "tool.before", ...(match === undefined ? {} : { match }) }) as unknown as HookIR,
  );
}

describe("nativeToolSelection", () => {
  it("selects the native names of every matched kind", () => {
    expect(nativeToolSelection(hooks({ kind: "shell" }, { kind: ["file.read"] }), VOCABULARY)).toEqual({
      names: ["Bash", "Grep", "PowerShell", "Read"],
      patterns: [],
    });
  });

  it("uses a nativeName directly, even alongside a kind", () => {
    expect(nativeToolSelection(hooks({ kind: "shell", nativeName: "Bash" }), VOCABULARY)).toEqual({
      names: ["Bash"],
      patterns: [],
    });
  });

  it("selects a kind recognized by pattern", () => {
    expect(nativeToolSelection(hooks({ kind: "mcp" }, { nativeName: "my-tool" }), VOCABULARY)).toEqual({
      names: ["my-tool"],
      patterns: ["mcp__.+__.+"],
    });
  });

  it.each([
    ["a hook without a match", hooks({ kind: "shell" }, undefined)],
    ["an empty match", hooks({})],
    ["the unenumerable other kind", hooks({ kind: "shell" }, { kind: "other" })],
    ["a kind the vocabulary does not describe", hooks({ kind: "web.search" })],
    ["an undescribed kind beside a described one", hooks({ kind: "shell" }, { kind: "web.search" })],
  ])("selects every tool for %s", (_label, reaching) => {
    expect(nativeToolSelection(reaching, VOCABULARY)).toBeUndefined();
  });
});
