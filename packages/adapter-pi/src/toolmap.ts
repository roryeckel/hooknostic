import type { ShellShapes, ToolInvocation, ToolKind } from "@hooknostic/sdk";
import { shellCodec } from "@hooknostic/sdk";

/**
 * pi built-in tool names (0.84.4 type defs: `read`, `bash`, `powershell`,
 * `edit`, `write`, `grep`, `find`, `ls`). `grep`/`find`/`ls` are read-only and
 * off by default but classify the same when enabled.
 */
const EXACT: Record<string, ToolKind> = {
  bash: "shell",
  powershell: "shell",
  read: "file.read",
  grep: "file.read",
  find: "file.read",
  ls: "file.read",
  write: "file.write",
  edit: "file.edit",
};

/**
 * pi shell tools: `bash` input is `{command, timeout?}` — the `command` key is
 * captured (fixtures/pi/0.84/tool-call-bash.input.json). `powershell` has the
 * same shape per the 0.84.4 type definitions (`PowerShellToolInput =
 * BashToolInput`), which is schema-derived, not captured — per the
 * harness-capture discipline it stays OUT of the shape table until a live
 * capture confirms it, and both codec directions decline rather than assume.
 * Neither tool has a cwd argument key.
 */
export const PI_SHELL_SHAPES: ShellShapes = {
  bash: { commandKey: "command" },
};

export const piShellCodec = shellCodec(PI_SHELL_SHAPES);

export function classifyPiTool(nativeName: string, input: unknown): ToolInvocation {
  // Own-property guard: a tool named "constructor" must not resolve a
  // prototype member.
  const known = Object.hasOwn(EXACT, nativeName) ? EXACT[nativeName] : undefined;
  if (known !== undefined) {
    const shell = piShellCodec.classify(nativeName, input);
    return { kind: known, nativeName, input, ...(shell !== undefined ? { shell } : {}) };
  }
  // Extension/MCP-via-extension tools surface under their registered name;
  // pi has no native server_tool split, so the native name stays
  // authoritative and the kind is "other" (an extension tool is not a
  // distinguishable MCP tool call on this harness).
  return { kind: "other", nativeName, input };
}
