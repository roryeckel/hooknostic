import { classifyStdioCwd, componentSummary, isRejectedSkillPath } from "@hooknostic/agent-plugin";
import type {
  AgentPluginIssue,
  AgentPluginPackage,
  AgentPluginProjectionFile,
  AgentPluginProjectionPlan,
  AgentPluginProjector,
} from "@hooknostic/agent-plugin";
import type { McpLauncherDocument, McpLauncherServer, TargetSpec } from "@hooknostic/core";
import { MCP_LAUNCHER_FILE, MCP_SERVERS_FILE, bundleMcpLauncher } from "@hooknostic/core";

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
/**
 * The launcher and its servers document, a sibling of the package rather than
 * inside it: everything under `package/` is the author's namespace, and the
 * example already ships a root `runtime/` directory.
 */
const LAUNCHER_DIR = `${PLUGIN_DIR}/hooknostic-runtime`;
const LAUNCHER_PATH = `${LAUNCHER_DIR}/${MCP_LAUNCHER_FILE}`;
const LAUNCHER_SERVERS_PATH = `${LAUNCHER_DIR}/${MCP_SERVERS_FILE}`;
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
const RUNTIME_LAUNCHER = "__HOOKNOSTIC_LAUNCHER__";

/**
 * Translate portable MCP servers into OpenCode's shape.
 *
 * OpenCode binds neither PLUGIN_ROOT nor PLUGIN_DATA, so every stdio server
 * runs through the generated launcher, which supplies both. Only two markers
 * appear in the emitted argv -- the install directory and the launcher's own
 * path -- and the module replaces them at load time, because neither is
 * knowable at build time. No package-controlled text passes through that
 * substitution: the portable declaration goes into the servers document
 * instead, which the module never reads.
 *
 * `environment` is deliberately not emitted. Whether OpenCode merges it with
 * the parent environment or replaces it is uncaptured, and a replacement would
 * strip PATH -- which is how `command[0]` resolves. The launcher applies the
 * declared environment itself, on top of its own.
 */
function translateMcp(source: AgentPluginPackage): {
  servers: Record<string, OpenCodeServer>;
  launcherServers: McpLauncherServer[];
  omitted: { name: string; reason: string }[];
} {
  // Null-prototype: a schema-valid server named `__proto__` assigned into `{}`
  // sets the prototype instead of an own property, and JSON.stringify would then
  // omit it while the summary counted it emitted.
  const servers: Record<string, OpenCodeServer> = Object.create(null);
  const launcherServers: McpLauncherServer[] = [];
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
    if (classifyStdioCwd(server.cwd) === undefined) {
      omitted.push({
        name,
        reason: `working directory ${JSON.stringify(server.cwd)} escapes the directory it is anchored on`,
      });
      continue;
    }
    servers[name] = {
      type: "local",
      // OpenCode takes one argv array, not a command plus args.
      command: ["node", RUNTIME_LAUNCHER, String(launcherServers.length)],
      // Stated absolutely even for the portable default of the plugin root,
      // because OpenCode resolves a relative one "from the workspace
      // directory". It anchors the launcher; the launcher chdirs the server.
      cwd: RUNTIME_PLUGIN_ROOT,
      enabled: true,
    };
    // The index is this entry's position in the document written below, taken
    // before the push. Any second enumeration would disagree with it: the
    // loader drops invalid servers before a projector sees them.
    launcherServers.push({
      name,
      command: server.command,
      ...(server.args === undefined ? {} : { args: [...server.args] }),
      ...(server.env === undefined ? {} : { env: { ...server.env } }),
      ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
    });
  }
  return { servers, launcherServers, omitted };
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
    "// Two install-time paths are substituted, and nothing else: this module",
    "// cannot know them at build time. Both are Hooknostic's own -- the package's",
    "// declaration lives in the servers document the launcher reads, so no",
    "// package-controlled text passes through here at all.",
    "//",
    "// A remote server is returned untouched, because a client MUST NOT expand in",
    "// url or headers and unrecognized placeholder-like text MUST stay literal --",
    "// resolving a ${TOKEN} here would put a host value in a package-chosen",
    "// destination.",
    "//",
    "// The walk is structural. A JSON round-trip would corrupt a Windows plugin",
    "// root, whose backslashes are not valid JSON escapes.",
    "//",
    "// The package sits one level down, out of the flat plugin scan; that",
    "// directory, not this module's, is what ${PLUGIN_ROOT} means.",
    "const here = dirname(fileURLToPath(import.meta.url));",
    'const pluginRoot = join(here, "package");',
    `const launcher = join(here, "hooknostic-runtime", ${JSON.stringify(MCP_LAUNCHER_FILE)});`,
    `const ROOT_MARKER = ${JSON.stringify(RUNTIME_PLUGIN_ROOT)};`,
    `const LAUNCHER_MARKER = ${JSON.stringify(RUNTIME_LAUNCHER)};`,
    "const resolveText = (text) =>",
    "  text.split(LAUNCHER_MARKER).join(launcher).split(ROOT_MARKER).join(pluginRoot);",
    "const resolve = (server) =>",
    '  server.type !== "local"',
    "    ? server",
    "    : { ...server, command: server.command.map(resolveText), cwd: resolveText(server.cwd) };",
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
            "A project plugin has no declarative config, so the servers are contributed by a generated module that resolves the install directory at load time and launches each one through a generated Node launcher, which binds PLUGIN_ROOT and a Hooknostic-managed PLUGIN_DATA directory and expands args, env values and cwd. cwd is emitted absolutely, including for the portable default of the plugin root, because OpenCode resolves a relative one from the workspace directory. The declared environment is applied by the launcher rather than through OpenCode's environment key, whose merge-or-replace behaviour is uncaptured, and the data directory is chosen by Hooknostic rather than by OpenCode, so the contract is emulated. Node must be on PATH, because the launcher is a Node program.",
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
          {
            version: "1.18.29",
            date: "2026-09-08",
            method: "live-probe",
            artifact: ".capture/opencode-agent-plugin",
            what: "A projected server started through the generated launcher received absolute PLUGIN_ROOT and PLUGIN_DATA, an expanded ${PLUGIN_DATA} argument rather than the literal text, and its declared working directory; PLUGIN_ROOT resolved to the nested package rather than to the generated module's own directory. Driven through the offline playback lane against a loopback model server, so it costs nothing and regressions fail CI.",
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

    // The whole package, one level down: everything ${PLUGIN_ROOT} could name
    // has to be there, and unlike Codex there is no native manifest to outrank
    // -- OpenCode reads none here.
    //
    // The single exception is the SKILL.md of a skill the loader rejected and
    // continued past under `onInvalid: "warn"`: its files stay in `files` while
    // it leaves `skills`, and `skills.paths` names the copied tree wholesale,
    // so shipping it hands OpenCode the very skill the loader said it skipped.
    const insideRejectedSkill = isRejectedSkillPath(source);
    for (const file of source.files) {
      if (insideRejectedSkill(file.path)) continue;
      const path = `${PACKAGE_DIR}/${file.path}`;
      files.push({ path, contents: file.contents, mode: file.mode });
      copiedPaths.push(path);
    }
    // Staging creates parents for emitted files only, so a directory with no
    // files in it -- a server's `cwd`, say -- exists in the package and not in
    // the output unless it is named here.
    const directories = (source.directories ?? []).map(
      (directory) => `${PACKAGE_DIR}/${directory}`,
    );

    const { servers, launcherServers, omitted } = translateMcp(source);
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
    if (launcherServers.length > 0) {
      const document: McpLauncherDocument = {
        plugin: source.manifest.name,
        servers: launcherServers,
      };
      files.push({
        path: LAUNCHER_SERVERS_PATH,
        contents: `${JSON.stringify(document, null, 2)}\n`,
      });
      files.push({
        path: LAUNCHER_PATH,
        contents: await bundleMcpLauncher({
          frontEnd: "self-resolving",
          // The launcher is a sibling of the copied package, not inside it.
          rootOffset: "../package",
          pluginName: source.manifest.name,
        }),
      });
    }

    const copied = new Set(copiedPaths);
    const generated = new Set([INJECTOR_PATH, LAUNCHER_PATH, LAUNCHER_SERVERS_PATH]);
    for (const file of context.hookArtifacts) {
      if (copied.has(file.path) || generated.has(file.path)) {
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
      ...(directories.length === 0 ? {} : { directories }),
      issues,
      summary: {
        components: counts,
        omissions,
        copiedPaths: [...copiedPaths].sort((a, b) => a.localeCompare(b)),
      },
    };
  },
};
