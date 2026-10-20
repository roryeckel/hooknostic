import type { ReportedToolFacts } from "@hooknostic/core";
import type { FileShapes, ShellShapes, ToolInvocation, ToolKind } from "@hooknostic/sdk";
import { fileCodec, shellCodec } from "@hooknostic/sdk";

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
 * pi shell tools use `{command, timeout?}`. The `command` key is captured for
 * both bash and powershell (fixtures/pi/{0.84,1.3}/tool-call-{bash,powershell}.input.json).
 * Neither tool has a cwd argument key in the observed payloads.
 */
export const PI_SHELL_SHAPES: ShellShapes = {
  bash: { commandKey: "command" },
  // Both Windows PowerShell and pwsh were observed (.capture/pi/FEATURES.md).
  // bash remains unknown: shellPath can select PowerShell, fish or tcsh.
  powershell: { commandKey: "command", dialect: "powershell" },
};

export const piShellCodec = shellCodec(PI_SHELL_SHAPES);

/** Captured tool-call-{read,write,edit}; search/list paths scope directories. */
export const PI_FILE_SHAPES: FileShapes = {
  read: { pathKey: "path" },
  write: { pathKey: "path" },
  edit: { pathKey: "path" },
};
export const piFileCodec = fileCodec(PI_FILE_SHAPES);

/**
 * pi 1.x prefixes every MCP server tool `mcp__` (pi's own isMcpToolName; native
 * MCP since 0.99.0; fixtures/pi/1.3/tool-call-mcp and the codemode-nested
 * tool-call-mcp-nested). The rest of the name is lossy: 1.3.0's
 * createMcpToolName replaces every non-identifier character of
 * `mcp__<server>__<tool>` with `_`, and appends a hash after truncating to 64
 * characters or when the result collides. So `get__secret` on `probe` and
 * `secret` on `probe__get` share a name, and a long name keeps neither part
 * whole. The kind is certain from the name; the split is not, so it is never
 * parsed from it. pi states the split outside the name on a result only, in
 * `details`; decodePi hands that over as a reported fact (ADR-0032), and a
 * call without one keeps the split absent. The resource tools
 * (`list_mcp_resources`, ...) reach every server and stay `other`.
 */
const PI_MCP_PREFIX = "mcp__";

export function classifyPiTool(nativeName: string, input: unknown, reported?: ReportedToolFacts): ToolInvocation {
  if (nativeName.startsWith(PI_MCP_PREFIX)) {
    return { kind: "mcp", nativeName, input, ...(reported?.mcp ? { mcp: { ...reported.mcp } } : {}) };
  }
  // Own-property guard: a tool named "constructor" must not resolve a
  // prototype member.
  const known = Object.hasOwn(EXACT, nativeName) ? EXACT[nativeName] : undefined;
  if (known !== undefined) {
    const shell = piShellCodec.classify(nativeName, input);
    const file = piFileCodec.classify(nativeName, input);
    return {
      kind: known,
      nativeName,
      input,
      ...(shell !== undefined ? { shell } : {}),
      ...(file !== undefined ? { file } : {}),
    };
  }
  // Other extension tools, including codemode and 0.84's third-party MCP
  // adapter tools (`mcp`, `mcpScript`), surface under their registered name;
  // the native name stays authoritative and the kind is "other".
  return { kind: "other", nativeName, input };
}
