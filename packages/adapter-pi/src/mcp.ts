import type {
  AgentPluginComponentId,
  AgentPluginComponentSupport,
  AgentPluginMcpServer,
  AgentPluginProjectionProfile,
} from "@hooknostic/agent-plugin";
import { classifyStdioCwd, hasUnportableCommandPath } from "@hooknostic/agent-plugin";
import type { McpLauncherServer } from "@hooknostic/core";
import { REMOTE_ENVIRONMENT_SOURCE } from "@hooknostic/core";

import { piMcpOmissions, piNativeMcpOmissions } from "./omissions.js";

/**
 * pi 1.x registers MCP servers from extensions with `pi.registerMcpServer`
 * (`.capture/pi-mcp`). The projection never hands pi a package's own stdio
 * text: each server is registered as pi's Node running the shared launcher
 * with an index into a generated servers document, and the launcher applies
 * the portable command, args, env, and cwd, binding PLUGIN_ROOT and
 * PLUGIN_DATA itself. pi expands `${NAME}`, `$NAME`, and `!command` in env and
 * header values and `~/` in command, args, and cwd, so none of those fields
 * may carry portable text unescaped.
 */

/** The three MCP transport cells a pi projection profile rates. */
export type PiMcpCells = Record<
  "agent-plugin.mcp.stdio" | "agent-plugin.mcp.streamable-http" | "agent-plugin.mcp.sse",
  AgentPluginComponentSupport
>;

/** 0.84: no native MCP channel, so every transport is omitted. */
export const legacyPiMcpCells = (rationale: string): PiMcpCells => ({
  "agent-plugin.mcp.stdio": { level: "unsupported", omission: piMcpOmissions.stdio, rationale },
  "agent-plugin.mcp.streamable-http": { level: "unsupported", omission: piMcpOmissions["streamable-http"], rationale },
  "agent-plugin.mcp.sse": { level: "unsupported", omission: piMcpOmissions.sse, rationale },
});

const EXPOSURE =
  "pi's default exposure applies: the tools are reached through codemode scripts, whose calls reach tool hooks as nested calls, rather than being declared to the model one by one.";

// pi 1.3.0 docs/mcp.md: a server in ~/.pi/agent/mcp.json or a trusted .pi/mcp.json
// whose name differs only in `-` and `_` takes precedence over a registered one.
const PRECEDENCE =
  " A server in the user-level ~/.pi/agent/mcp.json or the project .pi/mcp.json whose name pi treats as the same takes precedence over the registration, which /mcp then lists as overridden. Repository-local delivery refuses a colliding project entry; no build can see the user-level file.";

/** 1.x: native MCP through pi.registerMcpServer from a generated extension (.capture/pi-mcp). */
export const nativePiMcpCells: PiMcpCells = {
  "agent-plugin.mcp.stdio": {
    level: "emulated",
    rationale:
      "A generated pi extension registers each server with pi.registerMcpServer as pi's own Node running a generated launcher, which binds PLUGIN_ROOT and a Hooknostic-managed PLUGIN_DATA directory and applies the declared command, args, env values and cwd. A Bun-compiled or single-executable pi build is its own executable, so there the launcher runs on the node pi requires on PATH. pi sees only the launcher, so its expansion of env values ($NAME, ${NAME}, !command) and of ~/ never reaches package text. The data directory is chosen by Hooknostic rather than by pi, so the contract is emulated. " +
      EXPOSURE +
      PRECEDENCE,
  },
  "agent-plugin.mcp.streamable-http": {
    level: "exact",
    rationale:
      "The generated extension registers the URL verbatim, which pi does not expand, and escapes each header value with pi's $$ and $! escapes, so pi sends exactly the declared text. A header named __proto__, which pi's resolver would drop, is registered under a spelling that differs only in case; HTTP field names are case-insensitive. " +
      EXPOSURE +
      PRECEDENCE,
  },
  "agent-plugin.mcp.sse": {
    level: "unsupported",
    omission: piNativeMcpOmissions.sse,
    rationale:
      "pi rejects the legacy SSE transport: registerMcpServer throws for it (.capture/pi-mcp). A server that documents SSE often also serves streamable HTTP.",
  },
};

/**
 * The native MCP evidence the 1.x project and package profiles both rest on,
 * beside their own playback records.
 */
export const nativePiMcpValidations: AgentPluginProjectionProfile["source"]["validatedOn"] = [
  {
    version: "1.3.0",
    date: "2026-10-19",
    method: "schema-derived",
    artifact: ".capture/pi/README.md",
    what: "installed @earendil-works/pi-coding-agent 1.3.0 docs/mcp.md and resolve-config-value source: native MCP since 0.99.0, registered by extensions or read from mcp.json files; stdio and streamable HTTP only, with SSE rejected; $ and $! escape pi's value expansion",
  },
  {
    version: "1.3.0",
    date: "2026-10-19",
    method: "live-probe",
    artifact: ".capture/pi-mcp/README.md",
    what: "Loopback pi sessions with a recording MCP server: pi.registerMcpServer from a -e extension, a pi package extension, and a trusted project .pi/mcp.json each started the stdio server (an untrusted one did not); args reached it literally except ~/, env values merged over the parent environment with $NAME, ${NAME}, $ and $! resolved, an unset reference silently kept the server from starting, and an explicit cwd was honoured. Streamable HTTP header values honoured $ and $!, and a codemode script's MCP call reached tool_call and tool_result as a nested call",
  },
  {
    version: "1.3.0",
    date: "2026-10-20",
    method: "live-probe",
    artifact: ".capture/pi-mcp/README.md",
    what: "The same loopback probes on Linux: every route, argument, environment, cwd, header, SSE, and nested-call observation matched the Windows run",
  },
];

/** pi accepts only these characters in a server name (docs/mcp.md, rejected otherwise). */
const PI_SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/** Names differing only in `-` and `_` are one server to pi; a second is rejected. */
export const piNamespace = (name: string): string => name.replaceAll("-", "_");

/**
 * pi 1.3.0 copies header values into a plain object (`resolveHeadersOrThrow`,
 * core/resolve-config-value.js), where assigning `__proto__` sets nothing, so
 * a header with that name never reaches the request. Field names are
 * case-insensitive (RFC 9110 section 5.1) and pi's transport sends them through
 * `Headers`, so that header is registered under the first spelling differing
 * only in case that the server does not already declare. Every other name, and
 * every value, is kept; `undefined` means all 32 spellings are taken.
 */
export function piHeaders(headers: Readonly<Record<string, string>>): Record<string, string> | undefined {
  if (!Object.hasOwn(headers, "__proto__")) return { ...headers };
  const spelling = Array.from({ length: 31 }, (_, offset) => {
    const mask = 31 - offset;
    return (
      "__" +
      [..."proto"].map((letter, bit) => (mask & (1 << (4 - bit)) ? letter.toUpperCase() : letter)).join("") +
      "__"
    );
  }).find((candidate) => !Object.hasOwn(headers, candidate));
  if (spelling === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name === "__proto__" ? spelling : name, value]),
  );
}

/** One server the generated extension registers. */
export type PiMcpRegistration =
  | { name: string; type: "stdio"; index: number }
  | { name: string; type: "http"; url: string; headers?: Record<string, string> };

export interface PiMcpOmission {
  component: AgentPluginComponentId;
  name: string;
  reason: string;
}

/**
 * Translate portable servers into pi registrations, the launcher document,
 * and omissions. A transport whose resolved support is `unsupported` (SSE,
 * which pi rejects, or every transport on a 0.84 target) is omitted with that
 * cell's rationale.
 */
export function translatePiMcp(
  servers: Readonly<Record<string, AgentPluginMcpServer>>,
  support: Readonly<Partial<Record<AgentPluginComponentId, AgentPluginComponentSupport>>>,
  projectCwdServers: ReadonlySet<string> = new Set(),
): { registrations: PiMcpRegistration[]; launcherServers: McpLauncherServer[]; omitted: PiMcpOmission[] } {
  const registrations: PiMcpRegistration[] = [];
  const launcherServers: McpLauncherServer[] = [];
  const omitted: PiMcpOmission[] = [];
  const claimed = new Map<string, string>();
  for (const [name, server] of Object.entries(servers)) {
    const component = `agent-plugin.mcp.${server.type}` as AgentPluginComponentId;
    const cell = support[component];
    if (cell === undefined || cell.level === "unsupported") {
      omitted.push({
        component,
        name,
        reason: cell?.omission?.summary ?? cell?.rationale ?? "pi cannot represent this transport",
      });
      continue;
    }
    if (!PI_SERVER_NAME.test(name)) {
      omitted.push({ component, name, reason: "pi accepts only letters, digits, `_`, and `-` in an MCP server name" });
      continue;
    }
    const namespace = piNamespace(name);
    const holder = claimed.get(namespace);
    if (holder !== undefined) {
      omitted.push({
        component,
        name,
        reason: `pi treats names that differ only in \`-\` and \`_\` as one server, and ${JSON.stringify(holder)} already holds it`,
      });
      continue;
    }
    if (server.type === "stdio") {
      if (hasUnportableCommandPath(server.command)) {
        omitted.push({
          component,
          name,
          reason: `command ${JSON.stringify(server.command)} contains a backslash, which is a path separator only on the consumer's platform`,
        });
        continue;
      }
      if (classifyStdioCwd(server.cwd) === undefined && !projectCwdServers.has(name)) {
        omitted.push({
          component,
          name,
          reason: `working directory ${JSON.stringify(server.cwd)} escapes the directory it is anchored on`,
        });
        continue;
      }
      claimed.set(namespace, name);
      // The index is this entry's position in the document, taken before the
      // push; the launcher selects by position (core/mcp-launcher.ts).
      registrations.push({ name, type: "stdio", index: launcherServers.length });
      launcherServers.push({
        name,
        command: server.command,
        ...(server.args === undefined ? {} : { args: [...server.args] }),
        ...(server.env === undefined ? {} : { env: { ...server.env } }),
        ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
      });
      continue;
    }
    const headers = server.headers === undefined ? undefined : piHeaders(server.headers);
    if (server.headers !== undefined && headers === undefined) {
      omitted.push({
        component,
        name,
        reason: "every spelling of the __proto__ header is declared, and pi drops the one spelled __proto__",
      });
      continue;
    }
    claimed.set(namespace, name);
    registrations.push({ name, type: "http", url: server.url, ...(headers === undefined ? {} : { headers }) });
  }
  return { registrations, launcherServers, omitted };
}

/**
 * Source of the pi extension that registers the servers when pi loads it.
 *
 * `rootFromHere` and `launcherFromHere` are paths relative to the module's own
 * real directory, resolved at load time because the install location is
 * unknown at build time. pi resolves an extension path lexically and loads it
 * through jiti (1.3.0 extensions/loader.js), so the module may be handed a
 * location reached through a link; it takes its directory's real path, as the
 * offsets are computed between real paths.
 *
 * A stdio server is pi's own Node (`process.execPath`) running the launcher
 * with the server's index, anchored on the plugin root; no package text reaches
 * pi's expansion. A Bun-compiled or Node single-executable pi build has no
 * Node of its own to lend -- its execPath is pi itself, which pi's config.js and
 * extensions/loader.js detect -- so there the launcher runs on the `node` that
 * pi requires on PATH (README: Node.js 22.19 or newer).
 *
 * A remote server keeps its URL, which pi does not expand, and its headers
 * escaped for pi. With `resolveEnvironment` (a direct project source),
 * `${NAME}` and `${NAME:-default}` in the URL and header values are first
 * resolved from the launch environment, as the other targets resolve a
 * project's own declarations (REMOTE_ENVIRONMENT_SOURCE); a missing variable
 * registers the server disabled with a warning.
 */
export function piMcpExtensionSource(options: {
  registrations: readonly PiMcpRegistration[];
  rootFromHere: string;
  launcherFromHere: string;
  resolveEnvironment: boolean;
}): string {
  return `// Generated by Hooknostic. Registers MCP servers with pi. Do not edit.
/* global process, console */
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = realpathSync(dirname(fileURLToPath(import.meta.url)));
const root = resolve(here, ${JSON.stringify(options.rootFromHere)});
const launcher = resolve(here, ${JSON.stringify(options.launcherFromHere)});
// A Bun-compiled or Node single-executable pi is its own execPath.
const embedded =
  process.versions.bun !== undefined ||
  process.features?.sea === true ||
  process.getBuiltinModule?.("node:sea")?.isSea?.() === true;
const node = embedded ? "node" : process.execPath;
// Parsed, not written as an object literal, so no server name can reach a
// prototype setter.
const registrations = JSON.parse(${JSON.stringify(JSON.stringify(options.registrations))});
// pi expands $NAME, \${NAME}, and a leading !command in header values; $$ and $!
// are its escapes, so the value pi sends is exactly this text.
const escape = (value) => {
  const doubled = value.split("$").join("$$");
  return doubled.startsWith("!") ? "$" + doubled : doubled;
};
${
  options.resolveEnvironment
    ? REMOTE_ENVIRONMENT_SOURCE
    : "const expandEnvironment = (value) => value;\nconst warnMissingEnvironment = () => {};"
}

const remote = (server) => {
  const missing = new Set();
  const url = expandEnvironment(server.url, missing);
  const headers =
    server.headers === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(server.headers).map(([key, value]) => [key, escape(expandEnvironment(value, missing))]),
        );
  if (missing.size > 0) warnMissingEnvironment(server.name, missing);
  return { url, ...(headers === undefined ? {} : { headers }), ...(missing.size > 0 ? { enabled: false } : {}) };
};

export default function (pi) {
  for (const server of registrations) {
    const config =
      server.type === "stdio"
        ? { command: node, args: [launcher, String(server.index)], cwd: root }
        : remote(server);
    try {
      pi.registerMcpServer(server.name, config);
    } catch (error) {
      // pi throws for a name another extension registered; the other servers
      // still register.
      console.warn("Hooknostic could not register MCP " + JSON.stringify(server.name) + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }
}
`;
}
