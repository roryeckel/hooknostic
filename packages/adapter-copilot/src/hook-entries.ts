import { isJsonObject } from "@hooknostic/agent-plugin";

const SHELL_FIELDS = ["bash", "powershell", "command"] as const;

/** Events whose http hooks Copilot requires to use https://. */
const AUTHORIZING_EVENTS = new Set(["preToolUse", "preMcpToolCall", "permissionRequest"]);

/**
 * Why Copilot's hook loader would reject one hook entry, or undefined.
 *
 * Each rule is a loader error captured on 1.0.101 (.capture/copilot, the
 * hooks-malformed probe); fields the loader accepted unchecked (an unknown
 * key, a numeric matcher) are left alone. The rules matter more than their
 * count suggests: a repository hook file drops only the bad entry, but one bad
 * entry in a plugin's com.github.copilot/hooks/hooks.json rejects the whole
 * file, so every hook beside it, generated ones included, silently never runs.
 */
export function copilotHookEntryProblem(event: string, entry: unknown): string | undefined {
  if (!isJsonObject(entry)) return "expected an object";
  const type = entry["type"] ?? "command";
  if (type === "http") {
    if (typeof entry["url"] !== "string") return "an http hook requires a url";
    if (AUTHORIZING_EVENTS.has(event) && !entry["url"].startsWith("https://")) {
      return `an http hook on ${event} must use https://`;
    }
    return undefined;
  }
  if (type === "prompt") {
    if (event !== "sessionStart") return "a prompt hook is only valid on sessionStart";
    if (typeof entry["prompt"] !== "string") return "a prompt hook requires a prompt";
    return undefined;
  }
  if (type !== "command") return `type ${JSON.stringify(type)} is not command, http or prompt`;

  const shells = SHELL_FIELDS.filter((field) => entry[field] !== undefined);
  if ((entry["exec"] === undefined) === (shells.length === 0)) {
    return "a command hook needs either exec or bash/powershell/command, but not both";
  }
  for (const field of ["exec", ...shells, "cwd"]) {
    if (entry[field] !== undefined && typeof entry[field] !== "string") return `${field} must be a string`;
  }
  const args = entry["args"];
  if (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))) {
    return "args must be an array of strings";
  }
  const env = entry["env"];
  if (env !== undefined && (!isJsonObject(env) || Object.values(env).some((value) => typeof value !== "string"))) {
    return "env must be an object of strings";
  }
  for (const field of ["timeoutSec", "timeout"]) {
    if (entry[field] !== undefined && typeof entry[field] !== "number") return `${field} must be a number`;
  }
  return undefined;
}
