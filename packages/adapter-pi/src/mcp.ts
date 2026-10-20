import type {
  AgentPluginComponentId,
  AgentPluginComponentSupport,
  AgentPluginMcpServer,
} from "@hooknostic/agent-plugin";
import { classifyStdioCwd, hasUnportableCommandPath } from "@hooknostic/agent-plugin";
import type { McpLauncherServer } from "@hooknostic/core";

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
      "A generated pi extension registers each server with pi.registerMcpServer as pi's own Node running a generated launcher, which binds PLUGIN_ROOT and a Hooknostic-managed PLUGIN_DATA directory and applies the declared command, args, env values and cwd. pi sees only the launcher, so its expansion of env values ($NAME, ${NAME}, !command) and of ~/ never reaches package text. The data directory is chosen by Hooknostic rather than by pi, so the contract is emulated. " +
      EXPOSURE +
      PRECEDENCE,
  },
  "agent-plugin.mcp.streamable-http": {
    level: "exact",
    rationale:
      "The generated extension registers the URL verbatim, which pi does not expand, and escapes each header value with pi's $$ and $! escapes, so pi sends exactly the declared text. " +
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

/** pi accepts only these characters in a server name (docs/mcp.md, rejected otherwise). */
const PI_SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/** Names differing only in `-` and `_` are one server to pi; a second is rejected. */
export const piNamespace = (name: string): string => name.replaceAll("-", "_");

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
    claimed.set(namespace, name);
    registrations.push({
      name,
      type: "http",
      url: server.url,
      ...(server.headers === undefined ? {} : { headers: { ...server.headers } }),
    });
  }
  return { registrations, launcherServers, omitted };
}

/**
 * Source of the pi extension that registers the servers when pi loads it.
 *
 * `rootFromHere` and `launcherFromHere` are paths relative to the module's own
 * directory, resolved at load time because the install location is unknown at
 * build time. A stdio server is pi's own Node (`process.execPath`) running the
 * launcher with the server's index, anchored on the plugin root; no package
 * text reaches pi's expansion. A remote server keeps its URL, which pi does not
 * expand, and its headers escaped for pi. With `resolveEnvironment` (a direct
 * project source), `${NAME}` and `${NAME:-default}` in the URL and header
 * values are first resolved from the launch environment, as the other targets
 * resolve a project's own declarations; a missing variable registers the
 * server disabled with a warning.
 */
export function piMcpExtensionSource(options: {
  registrations: readonly PiMcpRegistration[];
  rootFromHere: string;
  launcherFromHere: string;
  resolveEnvironment: boolean;
}): string {
  return `// Generated by Hooknostic. Registers MCP servers with pi. Do not edit.
/* global process, console */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, ${JSON.stringify(options.rootFromHere)});
const launcher = resolve(here, ${JSON.stringify(options.launcherFromHere)});
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
    ? `const expand = (value, missing) =>
  value.replace(/\\$\\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\\}/g, (reference, name, fallback) => {
    const resolved = process.env[name];
    if (resolved !== undefined) return resolved;
    if (fallback !== undefined) return fallback;
    missing.add(name);
    return reference;
  });`
    : "const expand = (value) => value;"
}

const remote = (server) => {
  const missing = new Set();
  const url = expand(server.url, missing);
  const headers =
    server.headers === undefined
      ? undefined
      : Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, escape(expand(value, missing))]));
  if (missing.size > 0) {
    console.warn("Hooknostic disabled MCP " + JSON.stringify(server.name) + ": missing environment " + [...missing].sort().join(", "));
  }
  return { url, ...(headers === undefined ? {} : { headers }), ...(missing.size > 0 ? { enabled: false } : {}) };
};

export default function (pi) {
  for (const server of registrations) {
    const config =
      server.type === "stdio"
        ? { command: process.execPath, args: [launcher, String(server.index)], cwd: root }
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
