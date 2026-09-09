import type { AgentPluginStdioServer } from "./types.js";

export const PLUGIN_ROOT_PLACEHOLDER = "${PLUGIN_ROOT}";
export const PLUGIN_DATA_PLACEHOLDER = "${PLUGIN_DATA}";

/**
 * The Agent Plugins 1.0 placeholder rules, which are narrower than they look.
 *
 * The specification defines exactly two placeholders and states that a client
 * "MUST expand ${PLUGIN_ROOT} and ${PLUGIN_DATA} in supported configuration
 * fields", which for an MCP server are stdio `args`, `env` VALUES and `cwd` --
 * "it does not apply to `env` keys, `command`, or fixed component locations".
 * For a remote server it says a client "MUST NOT perform placeholder or
 * environment-variable expansion in `url`, header names, or header values".
 *
 * And the rule that is easy to violate by being helpful: "Unrecognized
 * placeholder-like text MUST remain literal. Clients MUST NOT perform any other
 * placeholder or environment-variable expansion." A `${TOKEN}` in a header is
 * literal text, not a reference to the host environment -- expanding it would
 * send a host value to an endpoint the package chose.
 */
export function containsPluginData(value: string): boolean {
  return value.includes(PLUGIN_DATA_PLACEHOLDER);
}

/** Replace every `${PLUGIN_ROOT}`, leaving all other placeholder-like text alone. */
export function expandPluginRoot(value: string, root: string): string {
  return value.split(PLUGIN_ROOT_PLACEHOLDER).join(root);
}

/**
 * Apply the field rules above to one stdio server.
 *
 * `command` is deliberately returned untouched: the specification excludes it
 * from expansion. Note that a `./relative` command resolves against the plugin
 * ROOT, not against `cwd` -- so a caller that emits a `cwd` below the root must
 * re-anchor the command itself rather than leaving it relative.
 */
export function expandStdioServer(
  server: AgentPluginStdioServer,
  root: string,
): { command: string; args?: string[]; env?: Record<string, string> } {
  return {
    command: server.command,
    ...(server.args === undefined
      ? {}
      : { args: server.args.map((arg) => expandPluginRoot(arg, root)) }),
    ...(server.env === undefined
      ? {}
      : {
          env: Object.fromEntries(
            Object.entries(server.env).map(([key, value]) => [
              key,
              expandPluginRoot(value, root),
            ]),
          ),
        }),
  };
}

/**
 * A plugin-root-relative `cwd` in normalized form, or undefined if it is not
 * anchored on the plugin root or climbs above it.
 *
 * The schema constrains `cwd` to start with `./`, `${PLUGIN_ROOT}` or
 * `${PLUGIN_DATA}`, but says nothing about what follows, so `./worker/`,
 * `./a/./b` and `${PLUGIN_ROOT}/worker/..` are all valid and all mean something
 * simpler than they say. Normalizing matters because callers derive a depth
 * from the result: counting the raw segments of `worker/` yields two, and a
 * sibling path then gets one `..` too many.
 */
/** Which directory a `cwd` is anchored on, and where inside it the value points. */
export interface StdioCwd {
  base: "root" | "data";
  /** Normalized, never escaping `base`; "." means the base itself. */
  relative: string;
}

/**
 * Classify and normalize a stdio `cwd`, or `undefined` if it escapes its base.
 *
 * The schema constrains `cwd` to start with `./`, `${PLUGIN_ROOT}` or
 * `${PLUGIN_DATA}` but says nothing about what follows, so `./worker/`,
 * `./a/./b` and `${PLUGIN_ROOT}/worker/..` are all valid and all mean something
 * simpler than they say. An omitted `cwd` is the plugin root, which the
 * specification states rather than leaves to the client.
 */
export function classifyStdioCwd(cwd: string | undefined): StdioCwd | undefined {
  if (cwd === undefined) return { base: "root", relative: "." };
  let base: StdioCwd["base"];
  let rest: string;
  if (cwd === PLUGIN_ROOT_PLACEHOLDER || cwd === `${PLUGIN_ROOT_PLACEHOLDER}/`) {
    base = "root";
    rest = "";
  } else if (cwd.startsWith(`${PLUGIN_ROOT_PLACEHOLDER}/`)) {
    base = "root";
    rest = cwd.slice(PLUGIN_ROOT_PLACEHOLDER.length + 1);
  } else if (cwd === PLUGIN_DATA_PLACEHOLDER || cwd === `${PLUGIN_DATA_PLACEHOLDER}/`) {
    base = "data";
    rest = "";
  } else if (cwd.startsWith(`${PLUGIN_DATA_PLACEHOLDER}/`)) {
    base = "data";
    rest = cwd.slice(PLUGIN_DATA_PLACEHOLDER.length + 1);
  } else if (cwd === "." || cwd === "./") {
    base = "root";
    rest = "";
  } else if (cwd.startsWith("./")) {
    base = "root";
    rest = cwd.slice(2);
  } else return undefined;

  const segments: string[] = [];
  for (const segment of rest.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // Escaping is not representable as a location inside the plugin or inside
      // the data directory the specification confines a data-rooted cwd to, so
      // the caller drops the server rather than pointing it somewhere else.
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return { base, relative: segments.length === 0 ? "." : segments.join("/") };
}

export function normalizedPluginRootCwd(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return ".";
  let rest: string;
  if (cwd === PLUGIN_ROOT_PLACEHOLDER) rest = "";
  else if (cwd.startsWith(`${PLUGIN_ROOT_PLACEHOLDER}/`)) {
    rest = cwd.slice(PLUGIN_ROOT_PLACEHOLDER.length + 1);
  } else if (cwd === "." || cwd === "./") rest = "";
  else if (cwd.startsWith("./")) rest = cwd.slice(2);
  else return undefined;

  const segments: string[] = [];
  for (const segment of rest.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // Escaping the plugin root is not representable as a package-relative
      // location, so the caller drops the server rather than pointing it out.
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? "." : segments.join("/");
}
