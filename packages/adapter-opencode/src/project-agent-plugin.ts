import type {
  AgentPluginDegradation,
  AgentPluginIssue,
  AgentPluginPackage,
  AgentPluginProjectionFile,
  AgentPluginProjectionPlan,
  AgentPluginProjector,
} from "@hooknostic/agent-plugin";
import {
  assertPackageDelivery,
  classifyStdioCwd,
  componentSummary,
  hasUnportableCommandPath,
  isRejectedSkillPath,
  materializedPackageFiles,
  npmPublicationProblems,
  projectPackageSkillTexts,
  RELATIVE_SKILL_TEXT,
} from "@hooknostic/agent-plugin";
import type { McpLauncherDocument, McpLauncherServer, TargetSpec } from "@hooknostic/core";
import { bundleMcpLauncher, MCP_LAUNCHER_FILE, MCP_SERVERS_FILE } from "@hooknostic/core";

import {
  PACKAGE_COMPONENTS_PATH,
  PACKAGE_ENTRY_PATH,
  PACKAGE_MANIFEST_PATH,
  PACKAGE_PLUGIN_PATH,
  packageEntrySource,
} from "./generate.js";
import { qualifiedSkillNames, renameSkillManifest } from "./skill-names.js";
import { OPENCODE_SKILL_REFERENCE_DEGRADATION, OPENCODE_SKILL_TEXT_RATIONALE } from "./skill-text.js";

/**
 * Package delivery emits an npm package, so every path here is package-root
 * relative. Nothing scans a package's interior -- OpenCode loads exactly the
 * one module `exports["./server"]` names -- so the directory scan rules that
 * shape project delivery do not apply, and generated modules sit at the root
 * beside the manifest.
 *
 * Measured on 1.18.30 (`.capture/opencode-plugin-routes`): `exports["./server"]`
 * is preferred over `main`; two distinct functions exported from the entry are
 * both loaded exactly once; and `import.meta.url` resolves to the real file, so
 * a module can address assets shipped beside it.
 */
// Imported, not restated: the compiler emits an entry and manifest at these
// paths for a hooks-only package, and this projection replaces them. Two
// spellings that must agree is exactly the drift that would make the
// replacement silently become a second, colliding file.
const MANIFEST_PATH = PACKAGE_MANIFEST_PATH;
/** The single module OpenCode loads; it re-exports the hook and component plugins. */
const ENTRY_PATH = PACKAGE_ENTRY_PATH;
const INJECTOR_PATH = PACKAGE_COMPONENTS_PATH;
/**
 * The package itself, nested one level so the author's namespace never collides
 * with a generated module.
 *
 * Everything the package ships goes here, not just its skills: an MCP server
 * ordinarily names its implementation with `${PLUGIN_ROOT}/...`, and copying
 * only skill trees leaves that argv pointing at a file the output does not
 * contain -- an MCP component reported emitted and exact that cannot start.
 */
const PACKAGE_DIR = "package";
/**
 * The nested package boundary emitted only when the author shipped none.
 *
 * The generated root manifest declares `type: "module"` for the generated
 * modules beside it, and Node reads a `.js` file's module system from the
 * nearest `package.json` ABOVE that file. A copied package with no manifest of
 * its own therefore inherits the generated one, and every `.js` in the author's
 * namespace silently becomes ESM: a CommonJS stdio server spelled
 * `node ${PLUGIN_ROOT}/server.js` dies on first launch with `require is not
 * defined`, having been reported emitted at build time.
 *
 * `"commonjs"` is not a preference. It is Node's own default for a `.js` file
 * with no manifest above it, which is precisely what the source had before
 * projection -- the boundary restores the semantics, it does not pick them.
 */
const PACKAGE_BOUNDARY_PATH = `${PACKAGE_DIR}/package.json`;
const PACKAGE_BOUNDARY = `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`;
/**
 * The launcher and its servers document, a sibling of the package rather than
 * inside it: everything under `package/` is the author's namespace, and the
 * example already ships a root `runtime/` directory.
 */
const LAUNCHER_DIR = "hooknostic-runtime";
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
  timeout?: number;
}

/** OpenCode's remote server. The client negotiates StreamableHTTP, then SSE. */
interface OpenCodeRemoteServer {
  type: "remote";
  url: string;
  headers?: Record<string, string>;
  enabled: true;
  timeout?: number;
}

type OpenCodeServer = OpenCodeLocalServer | OpenCodeRemoteServer;

export const RUNTIME_PLUGIN_ROOT = "__HOOKNOSTIC_PLUGIN_ROOT__";
export const RUNTIME_LAUNCHER = "__HOOKNOSTIC_LAUNCHER__";

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
export function translateMcp(
  source: Pick<AgentPluginPackage, "mcp">,
  projectCwdServers: ReadonlySet<string> = new Set(),
): {
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
    if (hasUnportableCommandPath(server.command)) {
      omitted.push({
        name,
        reason: `command ${JSON.stringify(server.command)} contains a backslash, which is a path separator only on the consumer's platform`,
      });
      continue;
    }
    if (classifyStdioCwd(server.cwd) === undefined && !projectCwdServers.has(name)) {
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
 * OpenCode reads no component declarations from a package manifest, so this
 * module is where they live: it declares the servers and the skills directory
 * through the `config` hook, which receives the merged configuration and mutates
 * it. `skills.paths` adds to the default discovery directories rather than
 * replacing them, and a plugin's entry merges with any the project configured --
 * both measured.
 *
 * It is one of the two plugins the generated entry re-exports, not the whole
 * plugin: identity belongs to `package.json` (ADR-0011, eleventh amendment) and
 * the compiled hooks are the other export.
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
  // identity is echoed as a comment rather than the named export it wants to be.
  // The authoritative copy is the emitted package.json, which is why
  // `agent-plugin.manifest` rates exact here; this echo exists so the generated
  // module still says where it came from when read on its own. Both are written
  // from this same manifest in one build, so they cannot disagree.
  return [
    "// Generated by Hooknostic from an Agent Plugins 1.0 package. Do not edit.",
    "//",
    "// Agent Plugins package identity, echoing the emitted package.json, which",
    "// is where OpenCode actually reads it from:",
    // U+2028 and U+2029 are JavaScript line terminators that JSON.stringify
    // leaves literal, and `description` and `version` are unconstrained strings
    // -- so without escaping them a package's metadata ends the `//` comment and
    // the rest of it becomes executable code in a module OpenCode auto-loads.
    ...JSON.stringify(identity, null, 2)
      .replaceAll("\u2028", "\\u2028")
      .replaceAll("\u2029", "\\u2029")
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
    "// The package sits one level down so the author's namespace cannot collide",
    "// with a generated root name such as the entry module; nothing scans a",
    "// package's interior, so the flat-scan rule that shapes project delivery",
    "// does not apply here. That directory, not this module's, is ${PLUGIN_ROOT}.",
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
 * The npm manifest that makes the output a package rather than a directory.
 *
 * `exports["./server"]` is what selects the entry: measured on 1.18.30 to be
 * preferred over `main` when the two name different files. `main` is emitted
 * beside it so the directory is still a well-formed package for tooling that
 * predates `exports`, and because OpenCode's own manifest reader accepts either.
 *
 * `files` is deliberately explicit. A package published from this output should
 * carry the generated modules, the launcher and the copied package, and nothing
 * else the author happens to leave in the directory.
 */
function packageManifest(
  manifest: AgentPluginPackage["manifest"],
  options: { name: string; hooks: boolean; launcher: boolean },
): string {
  // Every portable identity field has an npm equivalent, so all of them survive
  // rather than only the three a generated comment could carry. `extensions` is
  // deliberately absent: it is the client-extension component's concern, which
  // OpenCode does not read, not the manifest's.
  const document = {
    name: options.name,
    ...(manifest.version === undefined ? {} : { version: manifest.version }),
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    ...(manifest.author === undefined ? {} : { author: manifest.author }),
    ...(manifest.homepage === undefined ? {} : { homepage: manifest.homepage }),
    ...(manifest.repository === undefined ? {} : { repository: manifest.repository }),
    ...(manifest.license === undefined ? {} : { license: manifest.license }),
    ...(manifest.keywords === undefined ? {} : { keywords: manifest.keywords }),
    type: "module" as const,
    main: `./${ENTRY_PATH}`,
    exports: { "./server": `./${ENTRY_PATH}` },
    files: [
      ENTRY_PATH,
      ...(options.hooks ? [PACKAGE_PLUGIN_PATH] : []),
      INJECTOR_PATH,
      ...(options.launcher ? [LAUNCHER_DIR] : []),
      PACKAGE_DIR,
    ],
  };
  return `${JSON.stringify(document, null, 2)}\n`;
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
/** Degradation id for a skill that keeps its bare name (ADR-0021). */
export const SKILL_NAME_UNQUALIFIED = "skill-name-unqualified";

export function createOpenCodeAgentPluginProjector(emitters?: {
  injector: (source: AgentPluginPackage, servers: Record<string, OpenCodeServer>) => string;
  entry: (options: { hooks: boolean; components: boolean; name?: string }) => string;
}): AgentPluginProjector<TargetSpec> {
  return {
    // OpenCode reads no reverse-DNS client-extension namespace.
    namespace: "",
    packageRoot: PACKAGE_DIR,
    qualifiesSkillNames: true,
    // Under skillNames: "authored" each skill ships exactly as written, which
    // is exact delivery, and without the declaration nothing is renamed or
    // reported (ADR-0021).
    // The skill-text degradation (ADR-0028) is not about names, so it stays.
    supportFor: (target, matrix) => {
      const skills = matrix["agent-plugin.skills"];
      if (target.skillNames !== "authored" || skills === undefined || skills.level === "unsupported") return matrix;
      const degradations = (skills.degradations ?? []).filter((item) => item.id !== SKILL_NAME_UNQUALIFIED);
      return {
        ...matrix,
        "agent-plugin.skills": {
          level: "exact",
          rationale: `Each skill keeps its authored name. ${OPENCODE_SKILL_TEXT_RATIONALE}`,
          ...(degradations.length === 0 ? {} : { degradations }),
        },
      };
    },
    // The hook module and the package share `.opencode/plugins/`.
    profiles: [
      {
        range: ">=1.18 <2",
        components: {
          // Package delivery emits an npm manifest, so every portable identity
          // field has a real home rather than surviving as a comment. The one
          // manifest member with no npm equivalent, `extensions`, belongs to the
          // client-extension component, which OpenCode does not read at all.
          "agent-plugin.manifest": { level: "exact" },
          "agent-plugin.skills": {
            level: "emulated",
            degradations: [
              {
                id: SKILL_NAME_UNQUALIFIED,
                summary:
                  "A skill that cannot be named `<plugin>-<skill>` -- the name would pass 64 characters or break the Agent Skills name rules, duplicate another skill in the package, or sit on no rewritable frontmatter line -- keeps its bare name in OpenCode's flat skill namespace, where another plugin's skill of that name would hide it.",
                evidence: ".capture/opencode-skill-namespace",
              },
              OPENCODE_SKILL_REFERENCE_DEGRADATION,
            ],
            rationale:
              "OpenCode lists every skill in one flat namespace, so two plugins shipping a skill of the same name leave only one reachable, where Claude and Codex qualify each by its plugin. The projection names each skill `<plugin>-<skill>` by rewriting only its SKILL.md frontmatter name; the directory keeps its portable name, so package paths into it still resolve. A skill already named for its plugin keeps its name. The emitted name no longer matches its directory, as Agent Skills requires, which OpenCode accepts. " +
              OPENCODE_SKILL_TEXT_RATIONALE,
          },
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
              "Nothing reads the manifest this component supplies. All three OpenCode routes are now measured: a module in .opencode/plugins/ is read from disk with no install step; a package named by a local path in opencode.json is loaded rather than installed, and its declared dependencies do not resolve; and a PUBLISHED module installed by name does install its dependency closure -- but from the package's own npm manifest, which this projector generates, while the component's manifest and lockfile are copied into the nested author package where nothing reads them. Honouring it there would mean merging the runtime manifest's dependencies into the generated one, and would work on one route of three. Bundling works on all three, and Hooknostic never inventories node_modules at any depth, so npm vendoring is not reachable through this build either. Portable package content can instead be supplied by an explicit components.materialize provider at build time; author-supplied content is also copied verbatim.",
          },
        },
        source: {
          date: "2026-09-08",
          validatedOn: [
            {
              version: "1.18.33",
              date: "2026-09-30",
              method: "live-probe",
              artifact: ".capture/skill-directory",
              what: 'Over the loopback model with isolated state, the skill tool loaded a project skill from .agents/skills and handed the model its body with every ${...} as written (${CLAUDE_SKILL_DIR}, ${CLAUDE_PLUGIN_ROOT}, ${CLAUDE_PLUGIN_DATA}, ${CLAUDE_SESSION_ID}, ${SKILL_DIR}, ${PLUGIN_ROOT}, ${PLUGIN_DATA}, ${HOME}), followed by "Base directory for this skill: <absolute path>" and "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory."',
            },
            {
              version: "1.18.31",
              date: "2026-09-23",
              method: "live-probe",
              artifact: ".capture/opencode-skill-namespace",
              what: "Two installed plugins each shipping skills/status/SKILL.md named status: `opencode debug skill` listed one status, the same plugin's in both plugin orders, so the other was unreachable. With only the frontmatter names changed to alpha-status and beta-status and the directories untouched, both were listed at their original locations, nothing was logged about the name differing from its directory, and a model call loaded alpha-status through the skill tool.",
            },
            {
              version: "1.18.32",
              date: "2026-09-21",
              method: "live-probe",
              artifact: ".capture/mcp-child-path",
              what: "An arbitrary synthetic ambient variable reached a stdio child launched from the actual projected package with or without components.mcpEnvironment, establishing that OpenCode needs no target-specific forwarding declaration.",
            },
            {
              version: "1.18.31",
              date: "2026-09-16",
              method: "live-probe",
              artifact: ".capture/mcp-child-path",
              what: "A projected stdio MCP child inherited the parent PATH unchanged, while the generated launcher bound PLUGIN_ROOT to the nested package and supplied PLUGIN_DATA; bare runner commands remained resolvable.",
            },
            {
              version: "1.18.30",
              date: "2026-09-16",
              method: "live-probe",
              artifact: ".capture/opencode-npm-publish",
              what: 'The third route is now measured: this projector\'s output, published unmodified to a loopback registry and installed with `opencode plugin <name>`, loaded through exports["./server"] from the package cache, and the component injector contributed both the skills path and the stdio server -- each resolving its own sibling assets at the cache location rather than the build output. A scoped name works the same way, which matters because an Agent Plugins manifest name cannot be one.',
            },
            {
              version: "1.18.30",
              date: "2026-09-16",
              method: "live-probe",
              artifact: ".capture/opencode-npm-publish",
              what: "A registry-installed plugin's declared dependencies ARE installed, unlike on either other route: a published package declaring is-number@7.0.0 resolved it from the cache root beside itself, a specifier published nowhere failed, and deleting that dependency from the installed closure flipped the result -- so the check discriminates. This is the one OpenCode route on which a plugin could declare dependencies rather than bundle them.",
            },
            {
              version: "1.18.30",
              date: "2026-09-16",
              method: "live-probe",
              artifact: ".capture/opencode-npm-publish",
              what: 'An installed plugin does not follow new publications. The cache directory is named @latest but pins the exact version resolved at first load; after publishing 1.0.1 over an installed 1.0.0 the consumer still loaded 1.0.0, and `opencode plugin <name> --force` -- documented as "replace existing plugin version" -- did not move it. Deleting the cached package root did. Unlike Claude and Codex, bumping the version is not enough here.',
            },
            {
              version: "1.18.31",
              date: "2026-09-15",
              method: "live-probe",
              artifact: ".capture/harness-playback",
              what: 'What this projector EMITS is an installable unit, not merely the route it targets: a projected package written outside the project and named by absolute path in a root opencode.json loaded through its generated exports["./server"] entry, and the component injector reached through that entry\'s re-export started the stdio server through the generated launcher -- ${PLUGIN_ROOT} resolved to the nested author package, ${PLUGIN_DATA} to a directory outside both the package and the project, and the declared cwd anchored inside the package. The 1.18.30 records below establish that such a directory loads; this establishes that the build produces one.',
            },
            {
              version: "1.18.31",
              date: "2026-09-15",
              method: "live-probe",
              artifact: ".capture/opencode-plugin-routes",
              what: 'A relative plugin entry resolves against the declaring config file\'s own directory, from a matched pair against a ROOT opencode.json naming "./plugin-package": the package at <project>/plugin-package loaded, the same package at <project>/.opencode/plugin-package did not. This is the same rule the 1.18.30 .opencode/opencode.json observation shows, seen from a config file in a different directory, and upstream closed a report of it as intended (anomalyco/opencode#28384) -- so it is a rule an author writes against, not a defect awaiting a fix.',
            },
            {
              version: "1.18.30",
              date: "2026-09-15",
              method: "live-probe",
              artifact: ".capture/opencode-plugin-routes",
              what: 'A local directory declaring exports["./server"] loads as a plugin with no registry publication, and that condition is preferred over `main` when the two name different files -- so an emitted npm package is a real installable unit and its manifest is read, not decorative.',
            },
            {
              version: "1.18.30",
              date: "2026-09-15",
              method: "live-probe",
              artifact: ".capture/opencode-plugin-routes",
              what: "Two distinct functions exported from one entry module are each loaded exactly once, while one function exported as both a named export and `default` is loaded once rather than twice -- which is what lets a single package entry re-export the hook plugin and the component injector.",
            },
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
              what: 'McpLocalConfig declares an optional cwd whose own description reads "Working directory for the MCP server process. Relative paths resolve from the workspace directory", so a working directory IS expressible and must be absolute; an injected cwd also survived config resolution unchanged.',
            },
            {
              version: "1.18.29",
              date: "2026-09-08",
              method: "live-probe",
              artifact: ".capture/opencode-agent-plugin",
              what: 'Every export of a plugin module is loaded as a plugin: a module carrying a non-function named export beside its default failed to load entirely with "Plugin export is not a function".',
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
      assertPackageDelivery("opencode", context.target.delivery);
      const issues: AgentPluginIssue[] = [];
      const omissions: AgentPluginProjectionPlan["summary"]["omissions"] = [];
      const degradations: AgentPluginDegradation[] = [];
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
      //
      // A skill's SKILL.md is also the one file whose bytes may change: OpenCode
      // lists skills in one flat namespace, so each is renamed for its plugin
      // (see skill-names.ts). A rewritten file is generated, not copied.
      const insideRejectedSkill = isRejectedSkillPath(source);
      const renamed = new Map<string, Uint8Array>();
      // The declaration is the switch: a profile for an OpenCode that qualifies
      // plugin skills itself drops it, and with it both the renaming and the
      // reports, as ADR-0019 requires of anything a projector reports.
      const qualifying =
        context.support["agent-plugin.skills"]?.degradations?.some((item) => item.id === SKILL_NAME_UNQUALIFIED) ??
        false;
      for (const { skill, name, kept } of qualifying ? qualifiedSkillNames(source.manifest.name, source.skills) : []) {
        let reason = kept;
        if (reason === undefined && name !== skill.name) {
          const contents = source.files.find((file) => file.path === skill.manifestPath)?.contents;
          const rewritten = contents === undefined ? undefined : renameSkillManifest(contents, skill.name, name);
          if (rewritten === undefined) reason = "its frontmatter has no single top-level name line to rewrite";
          else renamed.set(skill.manifestPath, rewritten);
        }
        if (reason === undefined) continue;
        // Reported, never raised: core applies components.onDegraded and
        // components.accept.
        degradations.push({
          id: SKILL_NAME_UNQUALIFIED,
          component: "agent-plugin.skills",
          name: skill.name,
          path: skill.manifestPath,
          reason:
            `skill ${JSON.stringify(skill.name)} keeps its bare name on OpenCode, where skill names are not ` +
            `qualified by plugin and another plugin's skill of that name would hide it: ${reason}.`,
        });
      }
      // Then its body: ${SKILL_DIR} becomes `.` (ADR-0028).
      const skillTexts = projectPackageSkillTexts(
        source.skills,
        (path) => renamed.get(path) ?? source.files.find((file) => file.path === path)?.contents,
        RELATIVE_SKILL_TEXT,
        "OpenCode",
      );
      degradations.push(...skillTexts.degradations);
      const rewrittenPaths: string[] = [];
      for (const file of source.files) {
        if (insideRejectedSkill(file.path)) continue;
        const path = `${PACKAGE_DIR}/${file.path}`;
        const rewritten = skillTexts.rewritten.get(file.path) ?? renamed.get(file.path);
        files.push({ path, contents: rewritten ?? file.contents, mode: file.mode });
        (rewritten === undefined ? copiedPaths : rewrittenPaths).push(path);
      }
      // `${PLUGIN_ROOT}` here is the nested package directory, so a materialized
      // tree has to land inside it or nothing in mcp.json can name it. That
      // prefix is also what keeps it away from every other generated path: the
      // entry, manifest, injector and launcher sit at the output root, which no
      // `into` can reach once `package/` is prepended.
      //
      // Its paths are generated, not copied: their bytes came from an installer,
      // so they stay out of `copiedPaths`, which answers both the summary's
      // "copied byte-for-byte" list and whether the AUTHOR declared the package
      // boundary. A materialized tree is this projection's output and must not be
      // able to answer either question.
      const materialized = materializedPackageFiles(context.materializedTrees, {
        prefix: `${PACKAGE_DIR}/`,
        claimed: new Set([...copiedPaths, ...rewrittenPaths]),
      });
      issues.push(...materialized.issues);
      const materializedPaths = new Set<string>();
      for (const file of materialized.files) {
        materializedPaths.add(file.path);
        files.push(file);
      }

      // Only when the author shipped no manifest of their own: theirs is already
      // the boundary, and whatever module system it declares is theirs to declare.
      const authorsBoundary = copiedPaths.includes(PACKAGE_BOUNDARY_PATH);
      if (!authorsBoundary) {
        files.push({ path: PACKAGE_BOUNDARY_PATH, contents: PACKAGE_BOUNDARY });
      }
      // Staging creates parents for emitted files only, so a directory with no
      // files in it -- a server's `cwd`, say -- exists in the package and not in
      // the output unless it is named here.
      const directories = (source.directories ?? []).map((directory) => `${PACKAGE_DIR}/${directory}`);

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
        contents: emitters
          ? emitters.injector(source, servers)
          : injectorSource(source.manifest, servers, source.skills.length > 0),
      });
      // Either half can be absent: a config needs only one of `entry` or
      // `components`. An entry importing a module the build never produced fails
      // the whole plugin, so the skills and MCP servers below would go with it.
      const hasHooks = context.hookArtifacts.some((artifact) => artifact.path === PACKAGE_PLUGIN_PATH);
      files.push({
        path: ENTRY_PATH,
        contents: (emitters?.entry ?? packageEntrySource)({
          hooks: hasHooks,
          components: true,
          name: source.manifest.name,
        }),
      });
      // The package name is the manifest name verbatim. Coercing an invalid one
      // would publish under a name the author never chose and never sees, so an
      // Agent Plugins name that npm would reject is reported here rather than
      // silently rewritten.
      // The target's coordinate when it declares one, because an Agent Plugins
      // name cannot be scoped and a scoped package is what an organisation
      // publishes. Whichever is used is the name npm will see, so that is the one
      // checked.
      const npmName = context.target.npmName ?? source.manifest.name;
      // The two tiers -- fatal when npm would not install the name, a warning
      // when only publication is lost, fatal again for a defeated explicit
      // npmName -- and their wording live with the helper, shared with the
      // hooks-only validator so the two paths cannot drift apart.
      for (const problem of npmPublicationProblems({
        name: npmName,
        version: source.manifest.version,
        npmNameDeclared: context.target.npmName !== undefined,
      })) {
        issues.push({
          severity: problem.severity,
          scope: "projection",
          component: "agent-plugin.manifest",
          path: MANIFEST_PATH,
          message: problem.message,
        });
      }
      files.push({
        path: MANIFEST_PATH,
        contents: packageManifest(source.manifest, {
          name: npmName,
          hooks: hasHooks,
          launcher: launcherServers.length > 0,
        }),
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

      const copied = new Set([...copiedPaths, ...rewrittenPaths]);
      const generated = new Set([
        INJECTOR_PATH,
        LAUNCHER_PATH,
        LAUNCHER_SERVERS_PATH,
        ...(authorsBoundary ? [] : [PACKAGE_BOUNDARY_PATH]),
        ...materializedPaths,
      ]);
      // The compiler emits a standalone entry and manifest so a hooks-only
      // package is loadable without a projector. Here one ran, and it knows
      // strictly more -- the package manifest's identity, and whether an injector
      // exists -- so its versions replace them. They are not dropped: this
      // projection already pushed a file at each path, which is what core
      // verifies.
      const replaced = new Set([ENTRY_PATH, MANIFEST_PATH]);
      for (const file of context.hookArtifacts) {
        if (replaced.has(file.path)) continue;
        if (materializedPaths.has(file.path)) {
          // A hook artifact is generated output too, so this is a collision
          // between two things this projector emits -- named by the runtime's
          // destination rather than as a bare duplicate in core.
          issues.push({
            severity: "error",
            scope: "projection",
            path: file.path,
            message: `generated Hooknostic path ${JSON.stringify(file.path)} collides with a materialized package tree at the same path; point its "into" at a directory the output does not use`,
          });
          continue;
        }
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
          reason:
            "the generated root manifest is the only one any OpenCode route reads, and this component's manifest " +
            "and lockfile are copied into the nested author package, where nothing merges or installs them; bundle " +
            "the dependencies instead",
        });
      }

      return {
        files: files.sort((a, b) => a.path.localeCompare(b.path)),
        ...(directories.length === 0 ? {} : { directories }),
        issues,
        summary: {
          components: counts,
          omissions,
          ...(degradations.length === 0 ? {} : { degradations }),
          copiedPaths: [...copiedPaths].sort((a, b) => a.localeCompare(b)),
        },
      };
    },
  };
}

export const opencodeAgentPluginProjector = createOpenCodeAgentPluginProjector();
