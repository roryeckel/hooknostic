import {
  AGENT_PLUGIN_COMPONENT_IDS,
  componentSummary,
  containsPluginData,
  expandStdioServer,
  normalizedPluginRootCwd,
} from "@hooknostic/agent-plugin";
import type {
  AgentPluginComponentId,
  AgentPluginIssue,
  AgentPluginPackage,
  AgentPluginProjectionFile,
  AgentPluginProjectionPlan,
  AgentPluginProjector,
} from "@hooknostic/agent-plugin";
import type { TargetSpec } from "@hooknostic/core";
import { CODEX_PLUGIN_HOOKS_PATH, CODEX_PLUGIN_MODE_RANGE } from "./generate.js";

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
  author?: unknown;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  skills?: string;
  mcpServers?: string;
  hooks?: string;
}

/** How many levels the server's working directory sits below the plugin root. */
function fromWorkingDirectory(cwd: string): string {
  if (cwd === ".") return ".";
  return cwd
    .split("/")
    .map(() => "..")
    .join("/");
}

/**
 * Translate portable MCP servers into Codex's native shape.
 *
 * The native route does NOT implement the Agent Plugins placeholder contract,
 * which the portable route does (`.capture/codex-agent-plugin` recorded
 * PLUGIN_ROOT and PLUGIN_DATA bound in `env`, and `cwd` defaulted to the plugin
 * root). Measured on 0.153.2 (`.capture/codex-native-mcp`): `${PLUGIN_ROOT}` and
 * `${PLUGIN_DATA}` reach the server as literal text in `args`, `env` gains
 * neither variable, and `cwd` is absent unless declared. What the route DOES
 * give is a `cwd` resolved against the plugin root, so the contract is carried
 * here instead: every server gets an explicit plugin-root-relative `cwd`, and
 * `${PLUGIN_ROOT}` / `./` paths are rewritten relative to it. Without this a
 * package referencing its own shipped code -- the ordinary case -- registers an
 * argv that cannot resolve.
 *
 * Two shapes have no representation and are dropped with an omission rather
 * than emitted broken:
 *
 * - `${PLUGIN_DATA}` anywhere. The route provides no writable per-plugin
 *   directory and no way to name one, and the package loader forbids an author
 *   from defining the variable themselves.
 * - `sse`. Codex selects the transport from `command` vs `url` and ignores the
 *   portable `type`, so an sse server survives as a `streamable_http`
 *   registration against the same url -- a wrong-protocol connection, which is
 *   worse than an absent component. The portable `headers` key is ignored for
 *   the same reason; `http_headers` is what Codex reads, and through it a
 *   literal header value is preserved.
 */
function translateMcp(source: AgentPluginPackage): {
  servers: Record<string, CodexStdioServer | CodexRemoteServer>;
  omitted: { name: string; component: AgentPluginComponentId; reason: string }[];
} {
  // Null-prototype: a schema-valid server named `__proto__` assigned into `{}`
  // invokes the inherited setter, so JSON.stringify would omit it while the
  // summary counted it emitted.
  const servers: Record<string, CodexStdioServer | CodexRemoteServer> = Object.create(null);
  const omitted: { name: string; component: AgentPluginComponentId; reason: string }[] = [];
  for (const [name, server] of Object.entries(source.mcp?.mcpServers ?? {})) {
    if (server.type !== "stdio") {
      if (server.type === "sse") {
        omitted.push({
          name,
          component: "agent-plugin.mcp.sse",
          reason:
            "Codex has no sse transport; emitting it would register a streamable_http connection to the same url",
        });
        continue;
      }
      servers[name] = {
        url: server.url,
        ...(server.headers === undefined ? {} : { http_headers: { ...server.headers } }),
      };
      continue;
    }
    const values = [server.command, ...(server.args ?? []), ...Object.values(server.env ?? {})];
    if (server.cwd !== undefined) values.push(server.cwd);
    if (values.some(containsPluginData)) {
      omitted.push({
        name,
        component: "agent-plugin.mcp.stdio",
        reason:
          "the native Codex MCP route provides no ${PLUGIN_DATA} directory and expands no placeholder, so the server would receive the literal text",
      });
      continue;
    }
    const cwd = normalizedPluginRootCwd(server.cwd);
    if (cwd === undefined) {
      omitted.push({
        name,
        component: "agent-plugin.mcp.stdio",
        reason: `working directory ${JSON.stringify(server.cwd)} is not a location inside the plugin`,
      });
      continue;
    }
    // Expansion is relative rather than absolute because the install path is
    // unknown at build time: Codex resolves `cwd` against the plugin root, so a
    // path relative to `cwd` reaches the same file an absolute one would.
    servers[name] = {
      ...expandStdioServer(server, fromWorkingDirectory(cwd)),
      cwd,
    };
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
      // Below the range where plugin hook delivery was captured there is no
      // projection at all: a package can only reach Codex as an installed
      // plugin, and an installed plugin is not known to run hooks here. Stated
      // as a profile rather than left absent so `inspect` answers for these
      // versions instead of failing, and so a range spanning the boundary
      // resolves to the least capable level -- which is this one.
      range: ">=0.140 <0.153",
      components: Object.fromEntries(
        AGENT_PLUGIN_COMPONENT_IDS.map((component) => [
          component,
          {
            level: "unsupported" as const,
            rationale:
              "Hook delivery from an installed plugin is established on 0.153.2 only; the 0.148.0 binary was read as having removed it and that reading is not re-testable, so a projected plugin for these versions would carry components beside hooks nobody has watched run.",
          },
        ]),
      ),
      source: {
        date: "2026-09-08",
        validatedOn: [
          {
            version: "0.148.0",
            date: "2026-08-20",
            method: "doc-derived",
            artifact: ".capture/codex-plugin-hooks",
            what: "Recorded as having removed the plugin_hooks feature; not re-testable on this machine, so the versions between it and 0.153.2 are declined rather than assumed.",
          },
        ],
      },
    },
    {
      range: CODEX_PLUGIN_MODE_RANGE,
      components: {
        "agent-plugin.manifest": {
          level: "exact",
          rationale:
            "Rewritten as .codex-plugin/plugin.json; name, version and description survive, and the portable manifest is removed because it would outrank the native one and suppress hooks.",
        },
        "agent-plugin.skills": { level: "exact" },
        "agent-plugin.mcp.stdio": {
          level: "emulated",
          rationale:
            "The native MCP route expands no Agent Plugins placeholder and binds no PLUGIN_ROOT/PLUGIN_DATA env, unlike the portable route it replaces, so plugin-root anchoring is carried by an explicit plugin-root-relative cwd with command and args rewritten against it. A server using ${PLUGIN_DATA} has no representation and is omitted.",
        },
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
          {
            version: "0.153.2",
            date: "2026-09-08",
            method: "live-probe",
            artifact: ".capture/codex-native-mcp",
            what: "The native MCP route implements none of the Agent Plugins placeholder contract the portable route does: ${PLUGIN_ROOT} and ${PLUGIN_DATA} read back as literal text in args, env gained neither variable, and cwd was absent unless declared.",
          },
          {
            version: "0.153.2",
            date: "2026-09-08",
            method: "live-probe",
            artifact: ".capture/codex-native-mcp",
            what: "A declared cwd is joined to the plugin root without being expanded first, so a relative one anchors correctly (`.` reached the plugin root, `worker` reached a directory inside it) while ${PLUGIN_ROOT}/worker produced a path containing the literal placeholder.",
          },
          {
            version: "0.153.2",
            date: "2026-09-08",
            method: "live-probe",
            artifact: ".capture/codex-native-mcp",
            what: "A native manifest carrying author, license, homepage and keywords installed normally and resolved its version from the manifest, so those fields are carried through rather than dropped.",
          },
          {
            version: "0.153.2",
            date: "2026-09-08",
            method: "live-probe",
            artifact: ".capture/codex-native-mcp",
            what: "The declared cwd is honoured at spawn, not merely recorded: in a session a server declaring cwd \".\" started with process.cwd() equal to the installed plugin root and resolved its relative argument against it, while an identical server declaring no cwd never started. PLUGIN_ROOT and PLUGIN_DATA were unset in the spawned process.",
          },
          {
            version: "0.153.2",
            date: "2026-09-08",
            method: "live-probe",
            artifact: ".capture/codex-hook-command",
            what: "A hook command is parsed with quoting honoured and does NOT accept Claude's exec form: of three spellings on one event, command + args failed while the quoted and bare strings both ran, so the substituted plugin-root path is quoted.",
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

    // A projection replaces `output` wholesale, so `local` mode cannot also be
    // served from it -- and the hooks that mode generates land at
    // .codex/hooks.json with a session-relative command, which the native
    // manifest has no key for and an installed plugin would never run. Without
    // this the build reports success and ships a plugin whose skills and MCP
    // work and whose hooks silently do not.
    if (context.target.mode !== "plugin") {
      issues.push({
        severity: "error",
        scope: "projection",
        message: `codex target ${JSON.stringify(context.target.id)} is projected into an Agent Plugin, which requires mode: "plugin"; mode ${JSON.stringify(context.target.mode)} generates repository-level hooks the plugin manifest cannot reference.`,
      });
    }

    for (const file of source.files) {
      // Both portable documents are replaced by native ones at other paths.
      // Shipping either beside its replacement is what suppresses hooks.
      if (file.path === PORTABLE_MANIFEST_PATH || file.path === PORTABLE_MCP_PATH) continue;
      files.push({ path: file.path, contents: file.contents, mode: file.mode });
      copiedPaths.push(file.path);
    }

    // Carried rather than dropped: a manifest declaring all of these installed
    // and resolved its version normally (`.capture/codex-native-mcp`), so
    // passing them through cannot lose information whether Codex reads them or
    // ignores them -- whereas dropping them certainly does.
    const manifest: CodexNativeManifest = {
      name: source.manifest.name,
      ...(source.manifest.version === undefined ? {} : { version: source.manifest.version }),
      ...(source.manifest.description === undefined
        ? {}
        : { description: source.manifest.description }),
      ...(source.manifest.author === undefined ? {} : { author: source.manifest.author }),
      ...(source.manifest.homepage === undefined ? {} : { homepage: source.manifest.homepage }),
      ...(source.manifest.repository === undefined
        ? {}
        : { repository: source.manifest.repository }),
      ...(source.manifest.license === undefined ? {} : { license: source.manifest.license }),
      ...(source.manifest.keywords === undefined ? {} : { keywords: [...source.manifest.keywords] }),
      ...(source.skills.length === 0 ? {} : { skills: "./skills/" }),
    };

    const { servers, omitted } = translateMcp(source);
    for (const { name, component, reason } of omitted) {
      omissions.push({ component, name, reason });
      issues.push({
        severity: context.onUnsupported,
        // "projection", not "mcp": this reports a component the TARGET cannot
        // represent, which core codes HN205. Under "mcp" it reads as HN503
        // "invalid Agent Plugin package", blaming a package that is valid --
        // and for a component whose level is not `unsupported`, that misfiled
        // code is the only diagnostic the omission produces.
        scope: "projection",
        component,
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
      // Generation emits a hooks-only manifest so that an unprojected
      // plugin-mode target is still installable; the fuller one written below
      // replaces it at the same path.
      if (file.path === NATIVE_MANIFEST_PATH) continue;
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

    // Codex reads no client-extension namespace, so none is declared and the
    // component is never discovered here.
    // Per-server, not per-transport: a stdio server is dropped only when its own
    // paths cannot be re-anchored, so the count comes from what was omitted.
    const skippedByComponent = new Map<AgentPluginComponentId, number>();
    for (const { component } of omitted) {
      skippedByComponent.set(component, (skippedByComponent.get(component) ?? 0) + 1);
    }
    const counts = componentSummary(source, {
      hasRuntimePackage: context.runtimePackage !== undefined,
      skipped: (component, discovered) =>
        component === "agent-plugin.runtime-package"
          ? discovered
          : (skippedByComponent.get(component) ?? 0),
    });
    if (context.runtimePackage !== undefined) {
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
