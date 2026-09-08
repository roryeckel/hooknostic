import {
  componentSummary,
  containsPluginData,
  expandStdioServer,
  normalizedPluginRootCwd,
} from "@hooknostic/agent-plugin";
import type {
  AgentPluginIssue,
  AgentPluginPackage,
  AgentPluginProjectionFile,
  AgentPluginProjectionPlan,
  AgentPluginProjector,
} from "@hooknostic/agent-plugin";
import type { TargetSpec } from "@hooknostic/core";

/**
 * OpenCode scans `.opencode/plugins/` for `*.ts` / `*.js` and does NOT recurse,
 * so package content nests safely beneath it while generated modules sit at the
 * top. Both were measured: two sibling modules each took effect, and neither
 * `plugins/sub/probe.js` nor `.opencode/other/probe.js` was loaded.
 */
const PLUGIN_DIR = ".opencode/plugins";
const INJECTOR_PATH = `${PLUGIN_DIR}/hooknostic-agent-plugin.js`;
/**
 * The package itself, nested one level so the flat scan never loads its files.
 *
 * Everything the package ships goes here, not just its skills: an MCP server
 * ordinarily names its implementation with `${PLUGIN_ROOT}/...`, and copying
 * only skill trees leaves that argv pointing at a file the output does not
 * contain -- an MCP component reported emitted and exact that cannot start.
 */
const PACKAGE_DIR = `${PLUGIN_DIR}/package`;
const PORTABLE_MANIFEST_PATH = "plugin.json";
const PORTABLE_MCP_PATH = "mcp.json";

/**
 * OpenCode's local server, read from `McpLocalConfig` in the 1.18.29 binary: one
 * argv array, `environment` rather than `env`, and a `cwd` whose own description
 * says "relative paths resolve from the workspace directory" -- which is why the
 * projection always emits an absolute one.
 */
interface OpenCodeLocalServer {
  type: "local";
  command: string[];
  cwd: string;
  environment?: Record<string, string>;
  enabled: true;
}

/** OpenCode's remote server. The client negotiates StreamableHTTP, then SSE. */
interface OpenCodeRemoteServer {
  type: "remote";
  url: string;
  headers?: Record<string, string>;
  enabled: true;
}

type OpenCodeServer = OpenCodeLocalServer | OpenCodeRemoteServer;

const RUNTIME_PLUGIN_ROOT = "__HOOKNOSTIC_PLUGIN_ROOT__";

/**
 * Translate portable MCP servers into OpenCode's shape.
 *
 * `${PLUGIN_ROOT}` becomes a marker the generated module replaces with the real
 * directory at load time -- the install location is not knowable at build time.
 * Nothing else is substituted: the specification defines only two placeholders,
 * excludes `command`, `env` keys and every remote field from expansion, and
 * requires unrecognized placeholder-like text to stay literal.
 *
 * `${PLUGIN_DATA}` is the one portable shape with no representation here, so a
 * server using it is dropped with an omission rather than handed literal text.
 */
function translateMcp(source: AgentPluginPackage): {
  servers: Record<string, OpenCodeServer>;
  omitted: { name: string; reason: string }[];
} {
  // Null-prototype: a schema-valid server named `__proto__` assigned into `{}`
  // sets the prototype instead of an own property, and JSON.stringify would then
  // omit it while the summary counted it emitted.
  const servers: Record<string, OpenCodeServer> = Object.create(null);
  const omitted: { name: string; reason: string }[] = [];
  for (const [name, server] of Object.entries(source.mcp?.mcpServers ?? {})) {
    if (server.type !== "stdio") {
      // Remote fields are passed through verbatim, placeholders included.
      servers[name] = {
        type: "remote",
        url: server.url,
        ...(server.headers === undefined ? {} : { headers: { ...server.headers } }),
        enabled: true,
      };
      continue;
    }
    const values = [server.command, ...(server.args ?? []), ...Object.values(server.env ?? {})];
    if (server.cwd !== undefined) values.push(server.cwd);
    if (values.some(containsPluginData)) {
      omitted.push({
        name,
        reason:
          "OpenCode has no ${PLUGIN_DATA} equivalent, so the server would receive the literal placeholder text",
      });
      continue;
    }
    const cwd = normalizedPluginRootCwd(server.cwd);
    if (cwd === undefined) {
      omitted.push({
        name,
        reason: `working directory ${JSON.stringify(server.cwd)} is not a location inside the plugin`,
      });
      continue;
    }
    // Always emitted, including for the portable default: an omitted `cwd` means
    // the plugin root, and OpenCode resolves a relative one "from the workspace
    // directory" -- so the default has to be stated, and stated absolutely, or a
    // conformant `./bin/server` looks for itself in the user's project.
    const { command, args, env } = expandStdioServer(server, RUNTIME_PLUGIN_ROOT);
    servers[name] = {
      type: "local",
      // OpenCode takes one argv array, not a command plus args.
      command: [command, ...(args ?? [])],
      cwd: cwd === "." ? RUNTIME_PLUGIN_ROOT : `${RUNTIME_PLUGIN_ROOT}/${cwd}`,
      ...(env === undefined ? {} : { environment: env }),
      enabled: true,
    };
  }
  return { servers, omitted };
}

/**
 * Source for the module that contributes the package's components.
 *
 * OpenCode has no manifest for a project plugin, so this file IS the plugin: it
 * declares the servers and the skills directory through the `config` hook, which
 * receives the merged configuration and mutates it. `skills.paths` adds to the
 * default discovery directories rather than replacing them, and a plugin's entry
 * merges with any the project configured -- both measured.
 */
function injectorSource(
  manifest: AgentPluginPackage["manifest"],
  servers: Record<string, OpenCodeServer>,
  hasSkills: boolean,
): string {
  const identity = {
    name: manifest.name,
    ...(manifest.version === undefined ? {} : { version: manifest.version }),
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
  };
  // EVERY export of a plugin module is loaded as a plugin -- a non-function
  // export fails the whole module with "Plugin export is not a function" -- so
  // the package identity is a comment rather than the named export it wants to
  // be. OpenCode has no consumer for it either way.
  return [
    "// Generated by Hooknostic from an Agent Plugins 1.0 package. Do not edit.",
    "//",
    "// Agent Plugins package identity, which OpenCode's project-plugin model has",
    "// nowhere to put:",
    ...JSON.stringify(identity, null, 2)
      .split("\n")
      .map((line) => `//   ${line}`),
    'import { fileURLToPath } from "node:url";',
    'import { dirname, join } from "node:path";',
    "",
    "// Only the install directory is substituted, and only here: it is not known",
    "// at build time. Nothing else is expanded. Agent Plugins 1.0 defines exactly",
    "// two placeholders and requires unrecognized placeholder-like text to stay",
    "// literal, so a ${TOKEN} in a header is a literal value the package chose --",
    "// resolving it from the environment would send a host secret to a",
    "// package-chosen endpoint.",
    "//",
    "// The walk is structural. A JSON round-trip would corrupt a Windows plugin",
    "// root, whose backslashes are not valid JSON escapes.",
    "//",
    "// The package sits one level down, out of the flat plugin scan; that",
    "// directory, not this module's, is what ${PLUGIN_ROOT} means.",
    'const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "package");',
    `const MARKER = ${JSON.stringify(RUNTIME_PLUGIN_ROOT)};`,
    "const resolve = (value) =>",
    '  typeof value === "string"',
    "    ? value.split(MARKER).join(pluginRoot)",
    "    : Array.isArray(value)",
    "      ? value.map(resolve)",
    '      : value !== null && typeof value === "object"',
    "        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]))",
    "        : value;",
    "",
    "// Parsed, not written as an object literal: a server named __proto__ is a",
    "// literal key that sets the prototype, and the server would vanish.",
    `const mcpServers = JSON.parse(${JSON.stringify(JSON.stringify(servers, null, 2))});`,
    "",
    "export default async () => ({",
    "  config: (config) => {",
    ...(Object.keys(servers).length === 0
      ? []
      : [
          "    config.mcp = { ...(config.mcp ?? {}) };",
          "    for (const [name, server] of Object.entries(mcpServers)) {",
          "      // defineProperty, not assignment: `config.mcp.__proto__ = ...`",
          "      // would reach the inherited setter instead of adding a server.",
          "      Object.defineProperty(config.mcp, name, {",
          "        value: resolve(server),",
          "        enumerable: true,",
          "        writable: true,",
          "        configurable: true,",
          "      });",
          "    }",
        ]),
    ...(hasSkills
      ? [
          "    const paths = config.skills?.paths ?? [];",
          '    const own = join(pluginRoot, "skills");',
          "    if (!paths.includes(own)) {",
          "      config.skills = { ...(config.skills ?? {}), paths: [...paths, own] };",
          "    }",
        ]
      : []),
    "  },",
    "});",
    "",
  ].join("\n");
}

/**
 * Project an Agent Plugins package into OpenCode's project-plugin layout.
 *
 * Unlike Claude and Codex this is not an installable unit: `.opencode/plugins/`
 * is read from the project directory, so the whole projection is inherently
 * project-scoped and needs no install step. The compiled hooks are already a
 * module in that directory, and this adds a second one carrying the package's
 * MCP servers and skills -- OpenCode loads every module in the directory.
 *
 * Measured on `opencode` 1.18.29 through `debug config` and `debug skill`:
 *
 * - A plugin's `config` hook mutation survives into the resolved configuration,
 *   for both `mcp` and `skills.paths`.
 * - `skills.paths` is additive: an injected path did not displace either the
 *   project's own entry or the default discovery directories.
 * - `import.meta.url` resolves to the module's real location, so a plugin can
 *   address files shipped beside it.
 * - The scan is flat: two sibling modules both loaded, while modules one level
 *   deeper and in a neighbouring directory did not.
 */
export const opencodeAgentPluginProjector: AgentPluginProjector<TargetSpec> = {
  // OpenCode reads no reverse-DNS client-extension namespace.
  namespace: "",
  // The hook module and the package share `.opencode/plugins/`.
  profiles: [
    {
      range: ">=1.10 <2",
      components: {
        "agent-plugin.manifest": {
          level: "emulated",
          rationale:
            "A project plugin is resolved by path and has no manifest, so name, version and description survive only as a comment in the generated module. They cannot be a named export: every export of a plugin module is loaded as a plugin, and a non-function one fails the whole module.",
        },
        "agent-plugin.skills": { level: "exact" },
        "agent-plugin.mcp.stdio": {
          level: "emulated",
          rationale:
            "A project plugin has no declarative config, so the servers are contributed by a generated module that resolves ${PLUGIN_ROOT} to the install directory at load time; nothing else is substituted. cwd is always emitted absolutely, including for the portable default of the plugin root, because OpenCode resolves a relative one from the workspace directory. A server using ${PLUGIN_DATA} has no representation and is omitted.",
        },
        "agent-plugin.mcp.streamable-http": { level: "exact" },
        "agent-plugin.mcp.sse": {
          level: "emulated",
          rationale:
            "OpenCode declares no sse transport; a remote server is reached by the client trying StreamableHTTP and then SSE, so an sse server connects through that fall-back rather than through a declared transport.",
        },
        "agent-plugin.client-extension.files": {
          level: "unsupported",
          rationale: "OpenCode reads no portable client-extension namespace.",
        },
        "agent-plugin.runtime-package": {
          level: "unsupported",
          rationale:
            "A project plugin is loaded from disk with no install step, so a declared npm manifest and lockfile have nothing to install them.",
        },
      },
      source: {
        date: "2026-09-08",
        validatedOn: [
          {
            version: "1.18.29",
            date: "2026-09-08",
            method: "live-probe",
            artifact: ".capture/opencode-agent-plugin",
            what: "A project plugin's config hook contributed both an mcp entry and a skills.paths entry, each visible in `opencode debug config`, and the skill at the injected path was listed by `opencode debug skill`.",
          },
          {
            version: "1.18.29",
            date: "2026-09-08",
            method: "live-probe",
            artifact: ".capture/opencode-agent-plugin",
            what: "skills.paths is additive: an injected path coexisted with the project's own configured path and with the default .agents/skills discovery directory.",
          },
          {
            version: "1.18.29",
            date: "2026-09-08",
            method: "live-probe",
            artifact: ".capture/opencode-agent-plugin",
            what: "Interpolation runs BEFORE plugin config hooks: in one run the same {env:VAR} header expanded when it came from opencode.json and survived verbatim when a plugin injected it. A plugin therefore cannot emit OpenCode's own syntax -- and per Agent Plugins 1.0 it must not expand the value itself either, so such text stays literal.",
          },
          {
            version: "1.18.29",
            date: "2026-09-08",
            method: "live-probe",
            artifact: ".capture/opencode-agent-plugin",
            what: "The plugin scan is flat and confined to .opencode/plugin(s): two sibling modules both loaded, while .opencode/plugins/sub/probe.js and .opencode/other/probe.js did not, so the whole package nests safely below the scanned directory -- which is where it goes, because an MCP server's ${PLUGIN_ROOT} argv needs the implementation shipped beside it.",
          },
          {
            version: "1.18.29",
            date: "2026-09-08",
            method: "type-derived",
            artifact: ".capture/opencode-agent-plugin",
            what: "McpLocalConfig declares an optional cwd whose own description reads \"Working directory for the MCP server process. Relative paths resolve from the workspace directory\", so a working directory IS expressible and must be absolute; an injected cwd also survived config resolution unchanged.",
          },
          {
            version: "1.18.29",
            date: "2026-09-08",
            method: "live-probe",
            artifact: ".capture/opencode-agent-plugin",
            what: "Every export of a plugin module is loaded as a plugin: a module carrying a non-function named export beside its default failed to load entirely with \"Plugin export is not a function\".",
          },
          {
            version: "1.18.29",
            date: "2026-09-08",
            method: "type-derived",
            artifact: ".capture/opencode-agent-plugin",
            what: "A remote MCP server is attempted as [StreamableHTTP, SSE] in that order, with declared headers passed to both, which is why sse is emulated rather than unsupported.",
          },
        ],
        notes: [
          "Project plugins need no install: `.opencode/plugins/` is read from the project directory.",
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
      // The whole package, one level down. The two portable documents are
      // replaced by the generated module, and everything else -- skills, MCP
      // server implementations, their assets -- is what ${PLUGIN_ROOT} resolves
      // against at load time.
      if (file.path === PORTABLE_MANIFEST_PATH || file.path === PORTABLE_MCP_PATH) continue;
      const path = `${PACKAGE_DIR}/${file.path}`;
      files.push({ path, contents: file.contents, mode: file.mode });
      copiedPaths.push(path);
    }

    const { servers, omitted } = translateMcp(source);
    for (const { name, reason } of omitted) {
      omissions.push({ component: "agent-plugin.mcp.stdio", name, reason });
      issues.push({
        severity: context.onUnsupported,
        // "projection", not "mcp": this reports a component the TARGET cannot
        // represent, which core codes HN205. Under "mcp" it reads as HN503
        // "invalid Agent Plugin package", blaming a package that is valid --
        // and for a component whose level is not `unsupported`, that misfiled
        // code is the only diagnostic the omission produces.
        scope: "projection",
        component: "agent-plugin.mcp.stdio",
        path: `${PORTABLE_MCP_PATH}#${name}`,
        message: `MCP server ${JSON.stringify(name)} was omitted: ${reason}.`,
      });
    }
    files.push({
      path: INJECTOR_PATH,
      contents: injectorSource(source.manifest, servers, source.skills.length > 0),
    });

    const copied = new Set(copiedPaths);
    for (const file of context.hookArtifacts) {
      if (copied.has(file.path) || file.path === INJECTOR_PATH) {
        issues.push({
          severity: "error",
          scope: "projection",
          path: file.path,
          message: `generated Hooknostic path ${JSON.stringify(file.path)} collides with package content`,
        });
        continue;
      }
      files.push({ ...file });
    }

    // OpenCode reads no client-extension namespace, so none is declared and the
    // component is never discovered here.
    const counts = componentSummary(source, {
      hasRuntimePackage: context.runtimePackage !== undefined,
      skipped: (component, discovered) =>
        component === "agent-plugin.runtime-package"
          ? discovered
          : component === "agent-plugin.mcp.stdio"
            ? omitted.length
            : 0,
    });
    if (context.runtimePackage !== undefined) {
      omissions.push({
        component: "agent-plugin.runtime-package",
        reason: "a project plugin is loaded from disk, so nothing installs its npm dependencies",
      });
    }

    return {
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
      issues,
      summary: {
        components: counts,
        omissions,
        copiedPaths: [...copiedPaths].sort((a, b) => a.localeCompare(b)),
      },
    };
  },
};
