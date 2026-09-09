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
import type { AgentPluginStdioServer } from "./types.js";

export const PLUGIN_ROOT_PLACEHOLDER = "${PLUGIN_ROOT}";
export const PLUGIN_DATA_PLACEHOLDER = "${PLUGIN_DATA}";

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
 * Whether a portable path means different things on POSIX and on Windows.
 *
 * `./..\..\Windows` is ONE ordinary filename component on POSIX -- so it passes
 * the loader's containment check on a Linux build -- and three components on
 * Windows, where it climbs out of the plugin root. A package is validated where
 * it is built and resolved where it is consumed, so a value whose meaning
 * depends on which of those it is refused rather than shipped.
 */
export function hasAmbiguousSeparator(value: string): boolean {
  return value.includes("\\");
}

/**
 * The same hazard for a `command`, which only `./` forms carry.
 *
 * A bare executable name has no path semantics -- the loader already forbids a
 * separator in one -- and an absolute command is the caller's own, not a
 * package-relative path this projection has to keep contained.
 */
export function hasUnportableCommandPath(command: string): boolean {
  return command.startsWith("./") && hasAmbiguousSeparator(command);
}

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
 * specification states rather than leaving to the client.
 */
export function classifyStdioCwd(cwd: string | undefined): StdioCwd | undefined {
  if (cwd === undefined) return { base: "root", relative: "." };
  // Before splitting: segments are separated by "/" here, so a backslash would
  // survive inside one and only become a separator on the consumer's Windows.
  if (hasAmbiguousSeparator(cwd)) return undefined;
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
      // Escaping is not representable as a location inside the plugin, nor
      // inside the data directory the specification confines a data-rooted cwd
      // to, so the caller drops the server rather than pointing it elsewhere.
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return { base, relative: segments.length === 0 ? "." : segments.join("/") };
}
