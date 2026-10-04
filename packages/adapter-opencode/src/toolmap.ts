import type { FileShapes, ShellShapes, ToolInvocation, ToolKind } from "@hooknostic/sdk";
import { fileCodec, shellCodec } from "@hooknostic/sdk";

/** OpenCode tool ids are lowercase (bash, read, edit, …). */
const EXACT: Record<string, ToolKind> = {
  bash: "shell",
  shell: "shell",
  read: "file.read",
  glob: "file.read",
  grep: "file.read",
  list: "file.read",
  write: "file.write",
  edit: "file.edit",
  patch: "file.edit",
  // Offered instead of edit/write when the model id looks like a GPT model;
  // without this entry the `<server>_<tool>` MCP split below claimed it as
  // server "apply". Captured 1.18.31: fixtures/opencode/1.18/tool-apply-patch-before.
  apply_patch: "file.edit",
  multiedit: "file.edit",
  webfetch: "web.fetch",
  websearch: "web.search",
  task: "agent",
  agent: "agent",
  todowrite: "other",
  todoread: "other",
};

/**
 * OpenCode's `bash` tool names the command `command`, verified against
 * `fixtures/opencode/1.18/tool-before.input.json`. `shell` appears in the
 * classification map but has no capture, so it is absent from the table and
 * both codec directions decline rather than assume it matches.
 */
export const OPENCODE_SHELL_SHAPES: ShellShapes = {
  bash: { commandKey: "command" },
};

export const opencodeShellCodec = shellCodec(OPENCODE_SHELL_SHAPES, {
  normalizeName: (name) => name.toLowerCase(),
});

/**
 * Captured on 1.18.31 (fixtures/opencode/1.18/tool-{read,write,edit,apply-patch}-before):
 * the file tools name their target `filePath`; `apply_patch` (offered to
 * GPT-like model ids) carries a Codex-grammar patch in `patchText`. `patch` and
 * `multiedit` were never observed and stay absent (ADR-0026).
 */
export const OPENCODE_FILE_SHAPES: FileShapes = {
  read: { pathKey: "filePath" },
  write: { pathKey: "filePath" },
  edit: { pathKey: "filePath" },
  apply_patch: { patchKey: "patchText" },
};

export const opencodeFileCodec = fileCodec(OPENCODE_FILE_SHAPES, {
  normalizeName: (name) => name.toLowerCase(),
});

export function classifyOpenCodeTool(nativeName: string, input: unknown): ToolInvocation {
  const mcpMatch = /^([^_]+)_(.+)$/.exec(nativeName);
  const lowered = nativeName.toLowerCase();
  // Own-property guard: a tool named "constructor" must not resolve a prototype member.
  const known = Object.hasOwn(EXACT, lowered) ? EXACT[lowered] : undefined;
  if (known !== undefined) {
    const shell = opencodeShellCodec.classify(nativeName, input);
    const file = opencodeFileCodec.classify(nativeName, input);
    return {
      kind: known,
      nativeName,
      input,
      ...(shell !== undefined ? { shell } : {}),
      ...(file !== undefined ? { file } : {}),
    };
  }
  // MCP tools surface as `<server>_<tool>`; without a registry we can only
  // best-effort split, keeping the native name authoritative.
  if (mcpMatch) {
    return {
      kind: "mcp",
      nativeName,
      input,
      mcp: { server: mcpMatch[1]!, tool: mcpMatch[2]! },
    };
  }
  return { kind: "other", nativeName, input };
}
