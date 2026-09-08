import type {
  AgentPluginComponentId,
  AgentPluginIssue,
  AgentPluginPackage,
  AgentPluginProjectionFile,
  AgentPluginProjectionPlan,
  AgentPluginProjector,
} from "@hooknostic/agent-plugin";
import type { TargetSpec } from "@hooknostic/core";
import { CODEX_PLUGIN_HOOKS_PATH } from "./generate.js";

/** Codex reads its own plugin metadata from here; a root plugin.json outranks it. */
const NATIVE_MANIFEST_PATH = ".codex-plugin/plugin.json";
const NATIVE_MCP_PATH = ".mcp.json";
const PORTABLE_MANIFEST_PATH = "plugin.json";
const PORTABLE_MCP_PATH = "mcp.json";

/** Native stdio server. `type` is absent: `command` is what selects the transport. */
interface CodexStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** Native remote server. `url` selects the transport; `http_headers` keeps its values. */
interface CodexRemoteServer {
  url: string;
  http_headers?: Record<string, string>;
}

interface CodexNativeManifest {
  name: string;
  version?: string;
  description?: string;
  skills?: string;
  mcpServers?: string;
  hooks?: string;
}

/**
 * Translate portable MCP servers into Codex's native shape.
 *
 * `sse` is dropped rather than passed through. Codex's native reader selects the
 * transport from `command` vs `url` and ignores the portable `type` entirely, so
 * an sse server survives as a `streamable_http` registration against the same
 * url -- a wrong-protocol connection, which is worse than an absent component.
 * The portable `headers` key is ignored for the same reason; `http_headers` is
 * what Codex reads, and through it a literal header value is preserved.
 */
function translateMcp(source: AgentPluginPackage): {
  servers: Record<string, CodexStdioServer | CodexRemoteServer>;
  omitted: string[];
} {
  const servers: Record<string, CodexStdioServer | CodexRemoteServer> = {};
  const omitted: string[] = [];
  for (const [name, server] of Object.entries(source.mcp?.mcpServers ?? {})) {
    if (server.type === "stdio") {
      servers[name] = {
        command: server.command,
        ...(server.args === undefined ? {} : { args: [...server.args] }),
        ...(server.env === undefined ? {} : { env: { ...server.env } }),
        ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
      };
    } else if (server.type === "streamable-http") {
      servers[name] = {
        url: server.url,
        ...(server.headers === undefined ? {} : { http_headers: { ...server.headers } }),
      };
    } else {
      omitted.push(name);
    }
  }
  return { servers, omitted };
}

/**
 * Project an Agent Plugins package into a native Codex plugin.
 *
 * Codex can consume the portable package unmodified -- a root `plugin.json`
 * carrying its schema URL installs, its `skills/` are discovered and its
 * `mcp.json` servers register. That is deliberately NOT what this emits,
 * because a portable manifest cannot carry hooks and displaces the one that can.
 *
 * Measured on `codex-cli` 0.153.2 (`.capture/codex-plugin-hooks`):
 *
 * - A native `.codex-plugin/plugin.json` carries `skills`, `mcpServers` and
 *   `hooks` together, all three active in one installed plugin.
 * - A valid root `plugin.json` outranks it. A package declaring both loaded its
 *   skill and silently ignored its hook, and there is no convention fall-back:
 *   a portable package with a hooks document at `hooks.json` or
 *   `hooks/hooks.json` fired nothing. So the portable manifest is REMOVED here
 *   rather than shipped beside its replacement -- carrying both is the one
 *   arrangement that looks correct and silently loses every hook.
 * - Hook commands resolve against the session cwd, not the install cache, which
 *   is why the generated command is anchored with `${PLUGIN_ROOT}`.
 */
export const codexAgentPluginProjector: AgentPluginProjector<TargetSpec> = {
  // Codex reads no portable client-extension namespace: its native
  // `.codex-plugin/` directory is not one, and none of its bundled plugins use
  // the extensions map. Declaring an invented namespace would make the
  // component discoverable against something nothing reads.
  namespace: "",
  profiles: [
    {
      range: ">=0.148 <1",
      components: {
        "agent-plugin.manifest": {
          level: "exact",
          rationale:
            "Rewritten as .codex-plugin/plugin.json; name, version and description survive, and the portable manifest is removed because it would outrank the native one and suppress hooks.",
        },
        "agent-plugin.skills": { level: "exact" },
        "agent-plugin.mcp.stdio": { level: "exact" },
        "agent-plugin.mcp.streamable-http": {
          level: "exact",
          rationale:
            "Declared headers survive as native http_headers, which the portable route through a root manifest drops.",
        },
        "agent-plugin.mcp.sse": {
          level: "unsupported",
          rationale:
            "Codex has no sse transport: its native reader selects the transport from command vs url and ignores the portable type, so an sse server would register as a streamable_http connection to the same url. Dropped rather than emitted, because a wrong-protocol connection is worse than an absent one.",
        },
        "agent-plugin.client-extension.files": {
          level: "unsupported",
          rationale:
            "Codex reads no portable client-extension namespace; its native .codex-plugin/ directory is not one, and none of its bundled plugins use the extensions map.",
        },
        "agent-plugin.runtime-package": {
          level: "unsupported",
          rationale:
            "Not probed. Codex's installer was only observed copying package content; whether it runs a locked npm install like Claude's marketplace is unestablished.",
        },
      },
      source: {
        date: "2026-09-08",
        validatedOn: [
          {
            version: "0.153.2",
            date: "2026-09-07",
            method: "live-probe",
            artifact: ".capture/codex-agent-plugin",
            what: "`codex plugin add` copies the plugin source directory wholesale -- a junk directory and a stray README both landed in the install cache -- so the filtered package is what a build adds. Installation is user-level: marketplace and plugin entries land in ~/.codex/config.toml.",
          },
          {
            version: "0.153.2",
            date: "2026-09-08",
            method: "live-probe",
            artifact: ".capture/codex-plugin-hooks",
            what: "One native .codex-plugin/plugin.json declaring skills, mcpServers and hooks had all three active at once: the skill was discovered, both servers registered, and the UserPromptSubmit hook ran.",
          },
          {
            version: "0.153.2",
            date: "2026-09-08",
            method: "live-probe",
            artifact: ".capture/codex-plugin-hooks",
            what: "Manifest precedence suppresses hooks: a package carrying both a root plugin.json and a native manifest with hooks loaded its skill and ignored its hook, and a portable package with hooks at hooks.json or hooks/hooks.json fired nothing.",
          },
          {
            version: "0.153.2",
            date: "2026-09-08",
            method: "live-probe",
            artifact: ".capture/codex-plugin-hooks",
            what: "Native MCP shape: url + http_headers registered as streamable_http with the Authorization header intact, where the same file in portable shape (type + headers) registered with http_headers empty and a type: sse server registered as streamable_http rather than being skipped.",
          },
          {
            version: "0.153.2",
            date: "2026-09-08",
            method: "live-probe",
            artifact: ".capture/codex-plugin-hooks",
            what: "A plugin hook command resolves against the session cwd: of three variants on one event, only ${PLUGIN_ROOT}/... ran; a relative path and ${CODEX_PLUGIN_ROOT} did not.",
          },
        ],
        notes: [
          "Marketplace roots expose plugins through <root>/.agents/plugins/marketplace.json.",
          "Windows only; not probed on Linux or macOS.",
        ],
      },
    },
  ],
  project: async (source, context): Promise<AgentPluginProjectionPlan> => {
    const issues: AgentPluginIssue[] = [];
    const omissions: AgentPluginProjectionPlan["summary"]["omissions"] = [];
    const files: AgentPluginProjectionFile[] = [];
    const copiedPaths: string[] = [];

    for (const file of source.files) {
      // Both portable documents are replaced by native ones at other paths.
      // Shipping either beside its replacement is what suppresses hooks.
      if (file.path === PORTABLE_MANIFEST_PATH || file.path === PORTABLE_MCP_PATH) continue;
      files.push({ path: file.path, contents: file.contents, mode: file.mode });
      copiedPaths.push(file.path);
    }

    const manifest: CodexNativeManifest = {
      name: source.manifest.name,
      ...(source.manifest.version === undefined ? {} : { version: source.manifest.version }),
      ...(source.manifest.description === undefined
        ? {}
        : { description: source.manifest.description }),
      ...(source.skills.length === 0 ? {} : { skills: "./skills/" }),
    };

    const { servers, omitted } = translateMcp(source);
    for (const name of omitted) {
      const reason =
        "Codex has no sse transport; emitting it would register a streamable_http connection to the same url";
      omissions.push({ component: "agent-plugin.mcp.sse", name, reason });
      issues.push({
        severity: context.onUnsupported,
        scope: "mcp",
        component: "agent-plugin.mcp.sse",
        path: `${PORTABLE_MCP_PATH}#${name}`,
        message: `MCP server ${JSON.stringify(name)} was omitted: ${reason}.`,
      });
    }
    if (Object.keys(servers).length > 0) {
      manifest.mcpServers = `./${NATIVE_MCP_PATH}`;
      files.push({
        path: NATIVE_MCP_PATH,
        contents: `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
      });
    }

    const copied = new Set(copiedPaths);
    for (const file of context.hookArtifacts) {
      if (copied.has(file.path)) {
        issues.push({
          severity: "error",
          scope: "projection",
          path: file.path,
          message: `generated Hooknostic path ${JSON.stringify(file.path)} collides with package content`,
        });
        continue;
      }
      if (file.path === CODEX_PLUGIN_HOOKS_PATH) manifest.hooks = `./${CODEX_PLUGIN_HOOKS_PATH}`;
      files.push({ ...file });
    }

    files.push({
      path: NATIVE_MANIFEST_PATH,
      contents: `${JSON.stringify(manifest, null, 2)}\n`,
    });

    const counts: AgentPluginProjectionPlan["summary"]["components"] = {
      "agent-plugin.manifest": { discovered: 1, emitted: 1, skipped: 0 },
    };
    if (source.skills.length > 0) {
      counts["agent-plugin.skills"] = {
        discovered: source.skills.length,
        emitted: source.skills.length,
        skipped: 0,
      };
    }
    for (const type of ["stdio", "streamable-http", "sse"] as const) {
      const discovered = Object.values(source.mcp?.mcpServers ?? {}).filter(
        (server) => server.type === type,
      ).length;
      if (discovered === 0) continue;
      const skipped = type === "sse" ? discovered : 0;
      counts[`agent-plugin.mcp.${type}` as AgentPluginComponentId] = {
        discovered,
        emitted: discovered - skipped,
        skipped,
      };
    }
    if (context.runtimePackage !== undefined) {
      counts["agent-plugin.runtime-package"] = { discovered: 1, emitted: 0, skipped: 1 };
      omissions.push({
        component: "agent-plugin.runtime-package",
        reason: "Codex is not known to install a plugin's npm dependencies",
      });
    }

    return {
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
      ...(source.directories === undefined ? {} : { directories: source.directories }),
      issues,
      summary: {
        components: counts,
        omissions,
        copiedPaths: [...copiedPaths].sort((a, b) => a.localeCompare(b)),
      },
    };
  },
};
