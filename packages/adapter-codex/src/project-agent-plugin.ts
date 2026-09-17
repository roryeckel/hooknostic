import type {
  AgentPluginComponentId,
  AgentPluginIssue,
  AgentPluginPackage,
  AgentPluginProjectionFile,
  AgentPluginProjectionPlan,
  AgentPluginProjector,
} from "@hooknostic/agent-plugin";
import {
  AGENT_PLUGIN_COMPONENT_IDS,
  assertPackageDelivery,
  classifyStdioCwd,
  componentSummary,
  hasUnportableCommandPath,
  isRejectedSkillPath,
} from "@hooknostic/agent-plugin";
import type { McpLauncherDocument, McpLauncherServer, TargetSpec } from "@hooknostic/core";
import { bundleMcpLauncher, MCP_LAUNCHER_FILE, MCP_SERVERS_FILE, rangeWithin } from "@hooknostic/core";

import { CODEX_PLUGIN_HOOKS_PATH, CODEX_PLUGIN_MODE_RANGE } from "./generate.js";

/** Codex reads its own plugin metadata from here; a root plugin.json outranks it. */
const NATIVE_MANIFEST_PATH = ".codex-plugin/plugin.json";
const NATIVE_MCP_PATH = ".mcp.json";
const PORTABLE_MANIFEST_PATH = "plugin.json";
const PORTABLE_MCP_PATH = "mcp.json";
const SKILLS_DIR = "skills";
const RUNTIME_DIR = "runtime";
/**
 * Root paths and trees this projection decides, whatever a client extension
 * ships under the namespace.
 *
 * The manifest keys are pinned by `PORTABLE_CANONICAL_MANIFEST_KEYS` so an
 * extension cannot point Codex at a tree the portable loader never validated.
 * Hoisting is the same door from the other side: a namespace file landing in
 * `skills/` is discovered as a skill without passing that loader, one landing
 * on `.mcp.json` supplies native MCP configuration this projection otherwise
 * generates and checks, and one landing in `runtime/` displaces the generated
 * launcher. No capture records what Codex does with any of those, and an
 * uncaptured shape is declined rather than defaulted.
 */
const RESERVED_HOISTED_ROOT_PATHS = new Set([PORTABLE_MANIFEST_PATH, PORTABLE_MCP_PATH, NATIVE_MCP_PATH]);
const RESERVED_HOISTED_ROOT_DIRECTORIES = new Set([SKILLS_DIR, RUNTIME_DIR]);

/** The reserved path or tree a hoist would occupy, or `undefined` when it is free. */
function reservedHoistTarget(path: string): string | undefined {
  if (RESERVED_HOISTED_ROOT_PATHS.has(path)) return path;
  const top = path.split("/")[0]!;
  return RESERVED_HOISTED_ROOT_DIRECTORIES.has(top) ? top : undefined;
}

function reservedHoistMessage(kind: "file" | "directory", sourcePath: string, path: string, reserved: string): string {
  const subject = `client extension ${kind} ${JSON.stringify(sourcePath)}`;
  return reserved === path
    ? `${subject} cannot hoist onto reserved root path ${JSON.stringify(path)}`
    : `${subject} cannot hoist to ${JSON.stringify(path)}, inside the ${JSON.stringify(
        `${reserved}/`,
      )} tree this projection generates and validates`;
}

/**
 * Codex's reverse-DNS client-extension namespace.
 *
 * Two measured facts make this worth declaring. OpenAI documents
 * `extensions."com.openai"` in a root `plugin.json` as the home for its own
 * settings -- presentation, app mappings, hook configuration -- and the shipped
 * 0.154.0 binary does not honour even its supported `hooks` field
 * (`.capture/codex-client-extension`). So the portable form authors are told to
 * write reaches nothing on that build, and something has to carry it to where
 * Codex actually looks. That is this projection's job: the selected OpenAI
 * settings are folded into the generated native manifest, and files under the
 * namespace are hoisted to the package root.
 *
 * The namespace earns its place even though the base tree is copied verbatim.
 * A root-level `.app.json` or `assets/` reaches every harness, inert everywhere
 * but here; under the namespace it reaches only Codex.
 */
export const CODEX_AGENT_PLUGIN_NAMESPACE = "com.openai";
const NAMESPACE_PREFIX = `${CODEX_AGENT_PLUGIN_NAMESPACE}/`;

/**
 * Manifest keys this projection decides, whatever a client extension says.
 *
 * Identity comes from the portable manifest, and component wiring points at
 * trees this projection emitted and validated. Everything else in the extension
 * passes through untouched -- that is the point of having one.
 */
const PORTABLE_CANONICAL_MANIFEST_KEYS = [
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "skills",
  "mcpServers",
] as const;

/** Add generated hooks while keeping OpenAI's path and inline-object arrays homogeneous. */
function appendHookSource(authored: unknown, generatedPath: string, generatedContents: string | Uint8Array): unknown {
  if (authored === undefined) return generatedPath;
  const entries = Array.isArray(authored) ? authored : [authored];
  if (entries.every((entry) => typeof entry === "string")) return [...entries, generatedPath];

  // Hook artifacts are compiler output and already validated by the adapter.
  // Inline the generated document when the author used the other documented
  // form: OpenAI accepts arrays of paths or arrays of objects, not mixed arrays.
  const text = typeof generatedContents === "string" ? generatedContents : new TextDecoder().decode(generatedContents);
  return [...entries, JSON.parse(text) as unknown];
}

/** Decode an overlay document; a malformed one is reported, never guessed at. */
function parseOverlayManifest(contents: string | Uint8Array): { value: Record<string, unknown>; error?: string } {
  const text = typeof contents === "string" ? contents : new TextDecoder().decode(contents);
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { value: {}, error: "is not a JSON object" };
    }
    return { value: parsed as Record<string, unknown> };
  } catch (error) {
    return { value: {}, error: error instanceof Error ? error.message : String(error) };
  }
}
const LAUNCHER_PATH = `${RUNTIME_DIR}/${MCP_LAUNCHER_FILE}`;
const LAUNCHER_SERVERS_PATH = `${RUNTIME_DIR}/${MCP_SERVERS_FILE}`;

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

/**
 * Translate portable MCP servers into Codex's native shape.
 *
 * The native route does NOT implement the Agent Plugins placeholder contract,
 * which the portable route does (`.capture/codex-agent-plugin` recorded
 * PLUGIN_ROOT and PLUGIN_DATA bound in `env`, and `cwd` defaulted to the plugin
 * root). Measured on 0.153.2 (`.capture/codex-native-mcp`): `${PLUGIN_ROOT}` and
 * `${PLUGIN_DATA}` reach the server as literal text in `args`, `env` gains
 * neither variable, and `cwd` is absent unless declared.
 *
 * So every stdio server registers the same way -- `node ./runtime/mcp-launcher.mjs
 * <index>` with `cwd: "."` -- and the launcher supplies the contract at spawn
 * time. `cwd: "."` is what makes the relative argv resolve: the route joins a
 * declared `cwd` to the plugin root without expanding it first, and a server
 * declaring none never started at all.
 *
 * The index is a position in the generated servers document, assigned in this
 * loop as each entry is appended, so the emitted argv and the document cannot
 * disagree. Deriving it from any second enumeration would: `load.ts` drops
 * invalid servers before a projector sees them, so positions in the package's
 * own `mcp.json` are not these positions.
 *
 * `sse` is still dropped with an omission: Codex selects the transport from
 * `command` vs `url` and ignores the portable `type`, so an sse server would
 * survive as a `streamable_http` registration against the same url -- a
 * wrong-protocol connection, which is worse than an absent component. The
 * portable `headers` key is ignored for the same reason; `http_headers` is what
 * Codex reads, and through it a literal header value is preserved.
 */
export function translateMcp(
  source: Pick<AgentPluginPackage, "mcp">,
  projectCwdServers: ReadonlySet<string> = new Set(),
): {
  servers: Record<string, CodexStdioServer | CodexRemoteServer>;
  launcherServers: McpLauncherServer[];
  omitted: { name: string; component: AgentPluginComponentId; reason: string }[];
} {
  // Null-prototype: a schema-valid server named `__proto__` assigned into `{}`
  // invokes the inherited setter, so JSON.stringify would omit it while the
  // summary counted it emitted.
  const servers: Record<string, CodexStdioServer | CodexRemoteServer> = Object.create(null);
  const launcherServers: McpLauncherServer[] = [];
  const omitted: { name: string; component: AgentPluginComponentId; reason: string }[] = [];
  for (const [name, server] of Object.entries(source.mcp?.mcpServers ?? {})) {
    if (server.type !== "stdio") {
      if (server.type === "sse") {
        omitted.push({
          name,
          component: "agent-plugin.mcp.sse",
          reason: "Codex has no sse transport; emitting it would register a streamable_http connection to the same url",
        });
        continue;
      }
      servers[name] = {
        url: server.url,
        ...(server.headers === undefined ? {} : { http_headers: { ...server.headers } }),
      };
      continue;
    }
    if (hasUnportableCommandPath(server.command)) {
      omitted.push({
        name,
        component: "agent-plugin.mcp.stdio",
        reason: `command ${JSON.stringify(server.command)} contains a backslash, which is a path separator only on the consumer's platform`,
      });
      continue;
    }
    if (classifyStdioCwd(server.cwd) === undefined && !projectCwdServers.has(name)) {
      omitted.push({
        name,
        component: "agent-plugin.mcp.stdio",
        reason: `working directory ${JSON.stringify(server.cwd)} escapes the directory it is anchored on`,
      });
      continue;
    }
    servers[name] = {
      command: "node",
      args: [`./${LAUNCHER_PATH}`, String(launcherServers.length)],
      cwd: ".",
    };
    // Portable text verbatim: the launcher expands it against paths only it
    // knows, and rewriting here would expand twice.
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
  namespace: CODEX_AGENT_PLUGIN_NAMESPACE,
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
            "The native MCP route expands no Agent Plugins placeholder and binds no PLUGIN_ROOT/PLUGIN_DATA env, unlike the portable route it replaces, so the projection emits a Node launcher that resolves the plugin root from its own location, creates and binds a Hooknostic-managed PLUGIN_DATA directory outside the version-scoped install root, and expands args, env values and cwd before spawning the server. The directory is chosen by Hooknostic rather than by Codex, and the server runs one process below the harness, so the contract is emulated rather than native. Node must be on PATH, because the launcher is a Node program.",
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
          level: "exact",
          rationale:
            'OpenAI documents extensions."com.openai" in a root plugin.json as the preferred source of OpenAI settings, but 0.154.0 did not run a UserPromptSubmit hook declared there while an equivalent native-manifest control did. This projection bridges that implementation gap: the inline object replaces the compatibility overlay, portable identity/skills/MCP remain canonical, authored hooks are combined with generated hooks, and namespace files are hoisted to the package root. Exact because the documented settings arrive intact at the native surface the harness consumes.',
        },
        "agent-plugin.runtime-package": {
          level: "unsupported",
          rationale:
            "Codex installs no dependencies -- measured, not assumed. A plugin shipping package.json and package-lock.json declaring one dependency installed with both files copied verbatim, no node_modules in the installed root, and the dependency failing to resolve from it; a node_modules placed there by hand made the same check pass, so the check discriminates. A node_modules shipped INSIDE the package is copied like any other content and does resolve, but Hooknostic never inventories node_modules at any depth and strips one from the source package -- so bundling is the route available through this build.",
        },
      },
      source: {
        date: "2026-09-08",
        validatedOn: [
          {
            version: "0.154.0",
            date: "2026-09-16",
            method: "live-probe",
            artifact: ".capture/codex-client-extension",
            what: 'The reverse-DNS namespace OpenAI documents is not honoured. Four plugins differing only in how the skills directory is named: one declaring nothing had skills/ discovered, so discovery is conventional; one naming ./custom-skills/ solely inside extensions."com.openai" had its skill ignored, which convention cannot explain. Observed through codex debug prompt-input, so a discovered skill is one that reaches the model rather than a log line.',
          },
          {
            version: "0.154.0",
            date: "2026-09-16",
            method: "live-probe",
            artifact: ".capture/codex-client-extension",
            what: 'A plugin\'s skills/ directory is discovered with no declaration anywhere -- no native manifest, no skills field, no extensions map. The explicit "skills" pointer this projector writes is therefore belt and braces rather than the mechanism, which is what the 180 plugins in the bundled marketplace also do.',
          },
          {
            version: "0.154.0",
            date: "2026-09-15",
            method: "live-probe",
            artifact: ".capture/codex-marketplace-deps",
            what: 'No npm dependency installation. A plugin declaring is-number@7.0.0 with a package-lock.json and no node_modules installed with both manifests copied verbatim, no node_modules in the installed root, and import("is-number") failing ERR_MODULE_NOT_FOUND from there. Placing node_modules/is-number by hand made the same import succeed and removing it restored the failure, so the negative is the dependency and not a broken probe.',
          },
          {
            version: "0.154.0",
            date: "2026-09-15",
            method: "live-probe",
            artifact: ".capture/codex-marketplace-deps",
            what: "A node_modules directory shipped inside the source package survives installation and resolves from the installed plugin root, so a vendored or bundled dependency closure is a working route where a declared manifest is not.",
          },
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
            what: 'The declared cwd is honoured at spawn, not merely recorded: in a session a server declaring cwd "." started with process.cwd() equal to the installed plugin root and resolved its relative argument against it, while an identical server declaring no cwd never started. PLUGIN_ROOT and PLUGIN_DATA were unset in the spawned process.',
          },
          {
            version: "0.153.2",
            date: "2026-09-08",
            method: "live-probe",
            artifact: ".capture/codex-plugin-launcher",
            what: 'An installed projected plugin started its stdio server through the generated launcher: reached by `node ./runtime/mcp-launcher.mjs <index>` with cwd ".", the server received absolute PLUGIN_ROOT and PLUGIN_DATA, an expanded ${PLUGIN_DATA} argument rather than the literal text, and the declared working directory. Driven through the offline playback lane against a loopback model server, so it costs nothing and regressions fail CI.',
          },
          {
            version: "0.153.2",
            date: "2026-09-08",
            method: "live-probe",
            artifact: ".capture/codex-isolated-home",
            what: "CODEX_HOME relocates plugin and marketplace state: the same command lists the real marketplace from the default home and none from an isolated one, and marketplace add plus plugin add both succeed inside it, leaving ~/.codex/config.toml byte-identical. `plugin add` requires the qualified <plugin>@<marketplace> form.",
          },
          {
            version: "0.153.2",
            date: "2026-09-08",
            method: "live-probe",
            artifact: ".capture/codex-hook-command",
            what: "A hook command is parsed with quoting honoured and does NOT accept Claude's exec form: of three spellings on one event, command + args failed while the quoted and bare strings both ran, so the substituted plugin-root path is quoted.",
          },
          {
            version: "0.154.0",
            date: "2026-09-17",
            method: "live-probe",
            artifact: ".capture/codex-client-extension",
            what: "Correction and supported-field probe: the earlier custom-skills negative was expected because portable skills/ is canonical and did not test namespace consumption. In one isolated loopback session, extensions.com.openai.hooks failed to run a UserPromptSubmit marker while an equivalent .codex-plugin/plugin.json control fired, establishing that 0.154.0 does not honour the documented inline hooks route.",
          },
          {
            version: "0.154.0",
            date: "2026-09-17",
            method: "doc-derived",
            artifact: ".capture/codex-client-extension",
            what: "Official OpenAI plugin documentation defines the inline extensions.com.openai object as replacing the compatibility overlay, keeps root identity plus portable skills/MCP canonical, and permits hooks as a path, path array, inline object, or inline-object array.",
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
    assertPackageDelivery("codex", context.target.delivery);
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
    if (context.target.delivery !== "package") {
      issues.push({
        severity: "error",
        scope: "projection",
        message: `codex target ${JSON.stringify(context.target.id)} is projected into an Agent Plugin, which requires delivery: "package"; mode ${JSON.stringify(context.target.delivery)} generates repository-level hooks the plugin manifest cannot reference.`,
      });
    }

    // Generation refuses an out-of-range plugin target, but a package with no
    // `entry` never reaches generation, so the refusal has to be repeated here
    // or a package-only build ships a native plugin for versions this adapter
    // declines -- under onUnsupported: "warn" the declining profile only warns.
    if (!rangeWithin(context.target.version, CODEX_PLUGIN_MODE_RANGE)) {
      issues.push({
        severity: "error",
        scope: "projection",
        message: `codex target ${JSON.stringify(context.target.id)} is projected into an Agent Plugin, which requires harness ${CODEX_PLUGIN_MODE_RANGE}; version ${JSON.stringify(context.target.version)} admits releases where hook delivery from an installed plugin is not established.`,
      });
    }

    // A skill the loader rejected leaves `source.skills` but keeps its files,
    // and the native manifest points Codex at the whole `skills/` tree, so
    // copying that tree verbatim has Codex discover a skill reported as
    // skipped.
    const insideRejectedSkill = isRejectedSkillPath(source);

    for (const file of source.files) {
      // The root manifest is what suppresses hooks: a package carrying it and a
      // native one loaded its skill and ignored its hook. `mcp.json` is dropped
      // for a weaker reason -- no capture record says what a root one does
      // beside a native manifest, and an uncaptured shape is declined rather
      // than defaulted, since the plausible reading is a double registration.
      if (file.path === PORTABLE_MANIFEST_PATH || file.path === PORTABLE_MCP_PATH) continue;
      // Hoisted below, to the package root, rather than shipped one level down
      // where nothing would read it.
      if (file.path.startsWith(NAMESPACE_PREFIX)) continue;
      if (file.path === NATIVE_MANIFEST_PATH) {
        // This projection always writes the native manifest, so a copied one is
        // guaranteed to be lost -- silently, until now. Reported rather than
        // overwritten, and fatal rather than subject to `onUnsupported`: the
        // package is claiming an output path, which is not a component Codex
        // cannot represent.
        issues.push({
          severity: "error",
          scope: "file",
          path: file.path,
          message: `Agent Plugin file ${JSON.stringify(file.path)} occupies the path this projection generates; move it to ${JSON.stringify(`${NAMESPACE_PREFIX}${file.path}`)} to declare it as a Codex client extension, or remove it from the package.`,
        });
        continue;
      }
      if (insideRejectedSkill(file.path)) continue;
      files.push({ path: file.path, contents: file.contents, mode: file.mode });
      copiedPaths.push(file.path);
    }

    // The client extension, hoisted to the root. A `.codex-plugin/plugin.json`
    // here is an overlay rather than a file: it becomes the base of the
    // generated manifest, which is the "compatibility overlay" the vendor
    // documentation describes.
    const inlineExtension = source.manifest.extensions?.[CODEX_AGENT_PLUGIN_NAMESPACE];
    let overlayManifest: Record<string, unknown> = {};
    let ignoredCompatibilityOverlays = 0;
    const hoisted = new Set(copiedPaths);
    for (const file of source.files) {
      if (!file.path.startsWith(NAMESPACE_PREFIX)) continue;
      const path = file.path.slice(NAMESPACE_PREFIX.length);
      if (path === "") continue;
      const reserved = reservedHoistTarget(path);
      if (reserved !== undefined) {
        issues.push({
          severity: "error",
          scope: "projection",
          component: "agent-plugin.client-extension.files",
          path: file.path,
          message: reservedHoistMessage("file", file.path, path, reserved),
        });
        continue;
      }
      if (path === NATIVE_MANIFEST_PATH) {
        // The documented portable form replaces the compatibility overlay
        // wholesale. An ignored fallback cannot make an otherwise valid inline
        // declaration fail merely because stale fallback bytes remain beside it.
        if (inlineExtension !== undefined) {
          ignoredCompatibilityOverlays++;
          continue;
        }
        const parsed = parseOverlayManifest(file.contents);
        if (parsed.error !== undefined) {
          issues.push({
            severity: "error",
            scope: "manifest",
            component: "agent-plugin.client-extension.files",
            path: file.path,
            message: `client extension manifest ${JSON.stringify(file.path)} ${parsed.error}`,
          });
          continue;
        }
        overlayManifest = parsed.value;
        continue;
      }
      if (hoisted.has(path)) {
        issues.push({
          severity: "error",
          scope: "projection",
          component: "agent-plugin.client-extension.files",
          path: file.path,
          message: `client extension file ${JSON.stringify(file.path)} hoists onto ${JSON.stringify(path)}, which the package already ships`,
        });
        continue;
      }
      hoisted.add(path);
      files.push({ path, contents: file.contents, mode: file.mode });
      copiedPaths.push(path);
    }

    // Carried rather than dropped: a manifest declaring all of these installed
    // and resolved its version normally (`.capture/codex-native-mcp`), so
    // passing them through cannot lose information whether Codex reads them or
    // ignores them -- whereas dropping them certainly does.
    // The inline OpenAI object replaces the compatibility overlay; portable
    // identity and components remain canonical in either case.
    const generated: CodexNativeManifest = {
      name: source.manifest.name,
      ...(source.manifest.version === undefined ? {} : { version: source.manifest.version }),
      ...(source.manifest.description === undefined ? {} : { description: source.manifest.description }),
      ...(source.manifest.author === undefined ? {} : { author: source.manifest.author }),
      ...(source.manifest.homepage === undefined ? {} : { homepage: source.manifest.homepage }),
      ...(source.manifest.repository === undefined ? {} : { repository: source.manifest.repository }),
      ...(source.manifest.license === undefined ? {} : { license: source.manifest.license }),
      ...(source.manifest.keywords === undefined ? {} : { keywords: [...source.manifest.keywords] }),
      ...(source.skills.length === 0 ? {} : { skills: `./${SKILLS_DIR}/` }),
    };
    // Typed where this projection decides the value, free-form where the client
    // extension does: Codex's presentation surface is large and vendor-owned,
    // and modelling its field names here would mean a Hooknostic release every
    // time OpenAI adds one.
    const extensionEntry = inlineExtension ?? overlayManifest;
    const manifest: Record<string, unknown> = { ...extensionEntry, ...generated };
    // Spreading `generated` last is not enough: it omits a key it has nothing
    // to say about, and the extension's value would then survive. `skills` is
    // the dangerous one -- a package with no valid skills that declares
    // `skills: "./elsewhere/"` would point Codex at a tree the portable loader
    // never validated, which is the whole thing this projection exists to stop.
    const claimed: string[] = [];
    for (const key of PORTABLE_CANONICAL_MANIFEST_KEYS) {
      if (!(key in extensionEntry)) continue;
      claimed.push(key);
      if (!(key in generated)) delete manifest[key];
    }
    if (claimed.length > 0) {
      issues.push({
        severity: "warn",
        scope: "manifest",
        component: "agent-plugin.client-extension.files",
        path: NATIVE_MANIFEST_PATH,
        message: `client extension declares ${claimed.map((key) => JSON.stringify(key)).join(", ")}, which this projection decides from the package itself; the declared value is ignored.`,
      });
    }

    const { servers, launcherServers, omitted } = translateMcp(source);
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
    if (launcherServers.length > 0) {
      // A better diagnostic than the duplicate-path failure core would raise
      // anyway (`artifacts.ts`), naming the colliding path and why it is taken.
      for (const path of [LAUNCHER_PATH, LAUNCHER_SERVERS_PATH]) {
        if (!copiedPaths.includes(path)) continue;
        issues.push({
          severity: "error",
          scope: "projection",
          path,
          message: `generated Hooknostic path ${JSON.stringify(path)} collides with package content`,
        });
      }
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
          rootOffset: "..",
          pluginName: source.manifest.name,
        }),
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
      if (file.path === CODEX_PLUGIN_HOOKS_PATH) {
        manifest.hooks = appendHookSource(manifest.hooks, `./${CODEX_PLUGIN_HOOKS_PATH}`, file.contents);
      }
      files.push({ ...file });
    }

    files.push({
      path: NATIVE_MANIFEST_PATH,
      contents: `${JSON.stringify(manifest, null, 2)}\n`,
    });

    // Per-server, not per-transport: a stdio server is dropped only when its own
    // paths cannot be re-anchored, so the count comes from what was omitted.
    const skippedByComponent = new Map<AgentPluginComponentId, number>();
    for (const { component } of omitted) {
      skippedByComponent.set(component, (skippedByComponent.get(component) ?? 0) + 1);
    }
    const directoryCandidates =
      source.directories === undefined
        ? undefined
        : source.directories
            .filter((sourcePath) => !insideRejectedSkill(`${sourcePath}/`))
            .flatMap((sourcePath) => {
              if (sourcePath === CODEX_AGENT_PLUGIN_NAMESPACE) return [];
              if (!sourcePath.startsWith(NAMESPACE_PREFIX)) return [{ sourcePath, outputPath: sourcePath }];
              const outputPath = sourcePath.slice(NAMESPACE_PREFIX.length);
              // The output root is created by staging; there is no directory
              // artifact for the portable namespace itself.
              if (outputPath === "") return [];
              const reserved = reservedHoistTarget(outputPath);
              if (reserved !== undefined) {
                issues.push({
                  severity: "error",
                  scope: "projection",
                  component: "agent-plugin.client-extension.files",
                  path: sourcePath,
                  message: reservedHoistMessage("directory", sourcePath, outputPath, reserved),
                });
                return [];
              }
              return [{ sourcePath, outputPath }];
            });
    const hoistedDirectories = directoryCandidates?.filter(({ sourcePath }) => sourcePath.startsWith(NAMESPACE_PREFIX));
    const directories =
      directoryCandidates === undefined
        ? undefined
        : (() => {
            const retained: string[] = [];
            const sourcePathsByCaseFoldedOutput = new Map<string, string>();
            for (const { sourcePath, outputPath } of directoryCandidates) {
              const caseFoldedOutput = outputPath.toLowerCase();
              const previousSourcePath = sourcePathsByCaseFoldedOutput.get(caseFoldedOutput);
              if (previousSourcePath === undefined) {
                sourcePathsByCaseFoldedOutput.set(caseFoldedOutput, sourcePath);
                retained.push(outputPath);
                continue;
              }
              const extensionSourcePath = sourcePath.startsWith(NAMESPACE_PREFIX)
                ? sourcePath
                : previousSourcePath.startsWith(NAMESPACE_PREFIX)
                  ? previousSourcePath
                  : undefined;
              // Two ordinary source directories remain for core's general
              // path validation. A namespace directory maps to the same
              // physical output directory after hoisting, so coalesce it.
              if (extensionSourcePath === undefined) {
                retained.push(outputPath);
                continue;
              }
              // A directory is mergeable: its non-conflicting files already
              // hoist independently, so retain one output directory and let
              // the file collision checks reject only a path that cannot
              // coexist on a case-insensitive filesystem.
            }
            return retained;
          })();
    // Generated paths are case-insensitive: a package can carry `assets` at
    // its root and `com.openai/Assets` side by side, but the latter hoists onto
    // the former on case-insensitive filesystems.
    const emittedPaths = new Set(files.map((file) => file.path.toLowerCase()));
    for (const { sourcePath, outputPath } of hoistedDirectories ?? []) {
      const hoistedPath = outputPath.toLowerCase();
      const occupiedFile = [...emittedPaths].find(
        (emittedPath) => hoistedPath === emittedPath || hoistedPath.startsWith(`${emittedPath}/`),
      );
      if (occupiedFile === undefined) continue;
      // Staging creates retained directories before writing artifacts. Letting
      // either input claim the same path would therefore turn this into an
      // opaque EISDIR error instead of identifying the two conflicting inputs.
      issues.push({
        severity: "error",
        scope: "projection",
        component: "agent-plugin.client-extension.files",
        path: sourcePath,
        message: `client extension directory ${JSON.stringify(sourcePath)} hoists onto or inside ${JSON.stringify(occupiedFile)}, which is emitted as a file`,
      });
    }

    const counts = componentSummary(source, {
      namespace: CODEX_AGENT_PLUGIN_NAMESPACE,
      hasRuntimePackage: context.runtimePackage !== undefined,
      skipped: (component, discovered) =>
        component === "agent-plugin.runtime-package"
          ? discovered
          : component === "agent-plugin.client-extension.files"
            ? ignoredCompatibilityOverlays
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
      // Filtered too, or a rejected skill still materializes as an empty
      // directory bearing its name. Client-extension directories are hoisted
      // to the package root along with their files.
      ...(directories === undefined ? {} : { directories }),
      issues,
      summary: {
        components: counts,
        omissions,
        copiedPaths: [...copiedPaths].sort((a, b) => a.localeCompare(b)),
      },
    };
  },
};
