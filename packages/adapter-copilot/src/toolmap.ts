import type { FileShapes, ShellShapes, ToolInvocation, ToolKind } from "@hooknostic/sdk";
import { fileCodec, shellCodec } from "@hooknostic/sdk";

/**
 * Copilot CLI tool names. Two vocabularies reach hooks: the runtime names a
 * camelCase event carries, and the Claude-compatible names a PascalCase
 * `PreToolUse`/`PostToolUse` reports (hooks reference, "Tool names for hook
 * matching"; captured on 1.0.101). Both are mapped, because both can appear in
 * a payload a user configured themselves. Search tools (glob, grep) target a
 * pattern, not a file, so they are kinds only -- no file view (ADR-0026).
 *
 * `list_powershell`, `read_powershell` and `stop_powershell` drive background
 * shell sessions; they are not a shell invocation with a command to rewrite.
 */
export const COPILOT_TOOL_KINDS: Record<string, ToolKind> = {
  bash: "shell",
  powershell: "shell",
  view: "file.read",
  create: "file.write",
  edit: "file.edit",
  grep: "file.read",
  glob: "file.read",
  web_fetch: "web.fetch",
  web_search: "web.search",
  task: "agent",

  Bash: "shell",
  Read: "file.read",
  Write: "file.write",
  Edit: "file.edit",
  Grep: "file.read",
  Glob: "file.read",
  WebFetch: "web.fetch",
  WebSearch: "web.search",
  Agent: "agent",
  Task: "agent",
};

/**
 * Shell argument shapes. Both runtime shell tools name the command `command`
 * and add a `description`; neither has a working-directory key.
 *
 * `bash` and `powershell` were observed by effect: on Linux the `bash` tool ran
 * `/usr/bin/bash`, on macOS it ran `/bin/bash`, and on Windows the `powershell`
 * tool ran Windows PowerShell 5.1 (`shell-dialects` fields in fixtures/copilot/
 * 1.0, .capture/copilot/README.md and .capture/shell-dialects). A Windows host
 * advertised no `bash` tool, and the PascalCase `Bash` name is the Claude alias
 * for BOTH runtime tools, so it carries the command but no dialect: the tool
 * name there does not establish a family (ADR-0029).
 */
export const COPILOT_SHELL_SHAPES: ShellShapes = {
  bash: { commandKey: "command", dialect: "posix" },
  powershell: { commandKey: "command", dialect: "powershell" },
  Bash: { commandKey: "command" },
};

export const copilotShellCodec = shellCodec(COPILOT_SHELL_SHAPES);

/**
 * File tools name their one target `path`. Captured on 1.0.101 for `create`,
 * `view` and `edit`, and for the PascalCase `Write`, `Read` and `Edit` names
 * (which keep the runtime input keys). `grep` and `glob` take patterns and stay
 * out of the table.
 */
export const COPILOT_FILE_SHAPES: FileShapes = {
  view: { pathKey: "path" },
  create: { pathKey: "path" },
  edit: { pathKey: "path" },
  Read: { pathKey: "path" },
  Write: { pathKey: "path" },
  Edit: { pathKey: "path" },
};

export const copilotFileCodec = fileCodec(COPILOT_FILE_SHAPES);

export function classifyCopilotTool(nativeName: string, input: unknown): ToolInvocation {
  const shell = copilotShellCodec.classify(nativeName, input);
  const file = copilotFileCodec.classify(nativeName, input);
  // Copilot names an MCP tool `<server>-<tool>` on tool events
  // (`probe-probe_echo`) and `<server>/<tool>` on permissionRequest. No native
  // tool name observed carries either separator, so an unknown name with one is
  // an MCP call. The split itself is never parsed: both segments may contain a
  // hyphen and no payload states the boundary (ADR-0032), so `tool.mcp` stays
  // absent and hooks fall back to `nativeName` and `input`.
  const mcp = !Object.hasOwn(COPILOT_TOOL_KINDS, nativeName) && /[-/]/.test(nativeName);
  return {
    kind:
      (Object.hasOwn(COPILOT_TOOL_KINDS, nativeName) ? COPILOT_TOOL_KINDS[nativeName] : undefined) ??
      (mcp ? "mcp" : "other"),
    nativeName,
    input,
    ...(shell !== undefined ? { shell } : {}),
    ...(file !== undefined ? { file } : {}),
  };
}
