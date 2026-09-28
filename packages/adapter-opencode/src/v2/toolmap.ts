import type { FileShapes, ShellShapes, ToolInvocation, ToolKind } from "@hooknostic/sdk";
import { fileCodec, shellCodec } from "@hooknostic/sdk";

/** Captured at the hook boundary: fixtures/opencode/2.0/tool-shell-workdir-before.input.json. */
export const OPENCODE_V2_SHELL_SHAPES: ShellShapes = { shell: { commandKey: "command", cwdKey: "workdir" } };
export const opencodeV2ShellCodec = shellCodec(OPENCODE_V2_SHELL_SHAPES);

/**
 * Captured at the hook boundary (fixtures/opencode/2.0/tool-{read,write,edit,patch}-before):
 * file tools name their target `path`; `patch` (offered to GPT-like model ids)
 * carries a Codex-grammar patch in `patchText`. glob/grep search a directory and
 * have no view (ADR-0026).
 */
export const OPENCODE_V2_FILE_SHAPES: FileShapes = {
  read: { pathKey: "path" },
  write: { pathKey: "path" },
  edit: { pathKey: "path" },
  patch: { patchKey: "patchText" },
};
export const opencodeV2FileCodec = fileCodec(OPENCODE_V2_FILE_SHAPES);

// Each name has its own tool-*-before fixture in fixtures/opencode/2.0.
// Search is admission-only; tool-subagent-after also captures a completed child session.
const kinds: Readonly<Record<string, ToolKind>> = {
  shell: "shell",
  read: "file.read",
  glob: "file.read",
  grep: "file.read",
  write: "file.write",
  edit: "file.edit",
  // Replaces edit/write when the model id looks like a GPT model (tool-patch-before).
  patch: "file.edit",
  webfetch: "web.fetch",
  websearch: "web.search",
  subagent: "agent",
};

export function classifyOpenCodeV2Tool(nativeName: string, input: unknown): ToolInvocation {
  const shell = opencodeV2ShellCodec.classify(nativeName, input);
  const file = opencodeV2FileCodec.classify(nativeName, input);
  // Code Mode emits outer execute and inner tool hooks. The inner envelope
  // has no MCP discriminator. Even a connected server's namespace can contain
  // custom tools (fixtures/opencode/2.0/mcp-identity). Preserve both names;
  // exact nativeName matching is the verified guard route until ownership is known.
  const kind = Object.hasOwn(kinds, nativeName) ? kinds[nativeName]! : "other";
  return { nativeName, input, kind, ...(shell ? { shell } : {}), ...(file ? { file } : {}) };
}
