import type {
  AgentPluginIssue,
  AgentPluginPackage,
  AgentPluginProjectionFile,
  AgentPluginProjectionPlan,
  AgentPluginProjector,
  ComponentId,
} from "@hooknostic/agent-plugin";
import {
  assertPackageDelivery,
  classifyStdioCwd,
  COMPONENT_IDS,
  componentSummary,
  contentsText,
  DEFAULT_AGENT_NOT_PACKAGED,
  hasUnportableCommandPath,
  isRejectedSkillPath,
  isRootNpmManifestPath,
  materializedPackageFiles,
  parseJsonObject,
  projectPackageSkillTexts,
  RELATIVE_SKILL_TEXT,
  SKILL_REFERENCE_UNEXPANDED,
} from "@hooknostic/agent-plugin";
import type { McpLauncherDocument, McpLauncherServer, TargetSpec } from "@hooknostic/core";
import { bundleMcpLauncher, MCP_LAUNCHER_FILE, MCP_SERVERS_FILE, rangeWithin } from "@hooknostic/core";

import { CODEX_PLUGIN_HOOKS_PATH, CODEX_PLUGIN_MODE_RANGE } from "./generate.js";

/** Codex reads its own plugin metadata from here; a root plugin.json outranks it. */
const NATIVE_MANIFEST_PATH = ".codex-plugin/plugin.json";
/**
 * Folded like every other collision check on generated output: the package is
 * inventoried on one filesystem and installed on others, and a
 * `.Codex-Plugin/plugin.json` occupies the generated manifest's path on most
 * of the ones Codex installs onto. Matched exactly, it was hoisted as a plain
 * file and the build then failed in core on a case-insensitive duplicate
 * naming the manifest this projection emits -- a path the author never wrote.
 */
const isNativeManifestPath = (path: string): boolean => path.toLowerCase() === NATIVE_MANIFEST_PATH;
/** The directory Codex reads its own plugin metadata from; the native manifest lives in it. */
const NATIVE_METADATA_DIR = ".codex-plugin";
const NATIVE_MCP_PATH = ".mcp.json";
const PORTABLE_MANIFEST_PATH = "plugin.json";
const PORTABLE_MCP_PATH = "mcp.json";
const SKILLS_DIR = "skills";
const RUNTIME_DIR = "runtime";

/**
 * Whether a package-root path is claiming a path Codex reads as its own
 * configuration, rather than shipping package content.
 *
 * The output half of the package boundary (ADR-0011), and the same rule the
 * Claude projector applies through its own `isReservedNativePath`. A copied
 * `.mcp.json` is a native MCP document that never passed `translateMcp`,
 * reaching Codex's configuration without the validation portable `mcp.json`
 * servers receive; beside a build that generates one it was emitted twice, and
 * the only complaint was core's duplicate-artifact-path error blaming this
 * adapter for a file the package wrote. Under `.codex-plugin/`, only the
 * manifest is consumed -- checked above, with its own remediation -- and
 * anything else there is a shape no capture records, which is declined rather
 * than defaulted.
 *
 * The paths deliberately NOT reserved here are where this parts company with
 * `RESERVED_HOISTED_ROOT_PATHS`, and the asymmetry is the point rather than an
 * omission to complete later. `skills/` is the portable tree this copy loop
 * exists to copy. `runtime/` is inert package content, and an exact collision
 * with the generated launcher is reported where the launcher is emitted. A root
 * `hooks.json` the native manifest never names is inert too -- measured on
 * 0.154.0 (`.capture/codex-client-extension`) -- and a real collision with a
 * generated hook artifact is reported where those are emitted. What makes all
 * three dangerous under hoisting is the rewrite, not the path.
 *
 * Folded like every other check on the output layout.
 */
function isReservedNativePath(path: string): boolean {
  const folded = path.toLowerCase();
  return folded === NATIVE_MCP_PATH || folded.startsWith(`${NATIVE_METADATA_DIR}/`);
}
/**
 * Root paths and trees a client extension may not hoist onto, as a matter of
 * policy -- whether or not this build happens to generate anything there.
 *
 * This list is NOT how collisions with generated output are caught. Every path
 * the projection emits is collected into a folded map before hoisting and a
 * hoist landing on one is refused by that check, so a newly generated file
 * needs no entry here. What the list adds is the paths that are dangerous even
 * when empty:
 *
 * - `skills/` is where the manifest points Codex for discovery, so a namespace
 *   file landing there is discovered as a skill without passing the portable
 *   loader; `runtime/` carries the generated launcher when there is one, and
 *   `.mcp.json` the native MCP configuration -- a hoist into either when
 *   nothing is generated ships an unvalidated document at the path Codex reads.
 *   The manifest keys are pinned by `PORTABLE_CANONICAL_MANIFEST_KEYS` for the
 *   same reason; hoisting is the same door from the other side.
 * - `.codex-plugin/` is Codex's own metadata directory. The manifest in it is
 *   the compatibility overlay and is consumed, never copied; anything else
 *   there is a shape no capture records, and an uncaptured shape is declined
 *   rather than defaulted.
 * - The portable root manifests are stripped by the copy loop because a root
 *   `plugin.json` outranks the native one and suppresses hooks; a hoist must
 *   not put one back. The npm manifests and lockfiles are stripped because a
 *   root `package.json` stands in for a published coordinate this projection
 *   never emits, and Codex installs no dependencies for it
 *   (`.capture/codex-marketplace-deps`). That check goes through
 *   `isRootNpmManifestPath` because npm reads those names case-insensitively.
 */
const RESERVED_HOISTED_ROOT_PATHS = new Set([PORTABLE_MANIFEST_PATH, PORTABLE_MCP_PATH, NATIVE_MCP_PATH]);
const RESERVED_HOISTED_ROOT_DIRECTORIES = new Set([SKILLS_DIR, RUNTIME_DIR, NATIVE_METADATA_DIR]);

type ReservedHoistTarget = { kind: "path" } | { kind: "tree"; tree: string };

/**
 * The reserved path or tree a hoist would occupy, or `undefined` when it is
 * free. Folded like every other collision check on generated output: the
 * package is inventoried on one filesystem and installed on others, and
 * `Skills/extra/SKILL.md` lands inside the generated `skills/` tree on most of
 * the ones Codex installs onto. Core's duplicate check folds file paths, not
 * directory prefixes, so nothing downstream would catch it.
 */
function reservedHoistTarget(path: string): ReservedHoistTarget | undefined {
  const folded = path.toLowerCase();
  if (RESERVED_HOISTED_ROOT_PATHS.has(folded) || isRootNpmManifestPath(path)) return { kind: "path" };
  const top = folded.split("/")[0]!;
  return RESERVED_HOISTED_ROOT_DIRECTORIES.has(top) ? { kind: "tree", tree: top } : undefined;
}

function reservedHoistMessage(
  kind: "file" | "directory",
  sourcePath: string,
  path: string,
  reserved: ReservedHoistTarget,
): string {
  const subject = `client extension ${kind} ${JSON.stringify(sourcePath)}`;
  return reserved.kind === "path"
    ? `${subject} cannot hoist onto reserved root path ${JSON.stringify(path)}`
    : `${subject} cannot hoist to ${JSON.stringify(path)}, inside the ${JSON.stringify(
        `${reserved.tree}/`,
      )} tree this projection generates and validates`;
}

/**
 * The emitted file that `foldedPath` or one of its ancestors names, or
 * `undefined` when none does. A path collides with a file at its own position
 * or at any ancestor -- `assets/x` cannot exist beside a file `assets` -- so
 * the ancestors are walked rather than every emitted file.
 */
function occupyingFile(foldedPath: string, byFoldedPath: ReadonlyMap<string, string>): string | undefined {
  for (let prefix = foldedPath; ;) {
    const occupied = byFoldedPath.get(prefix);
    if (occupied !== undefined) return occupied;
    const cut = prefix.lastIndexOf("/");
    if (cut < 0) return undefined;
    prefix = prefix.slice(0, cut);
  }
}

/**
 * Record every proper ancestor of `path` as an occupied directory, keyed by its
 * folded spelling and valued by the spelling the path actually carries, so a
 * diagnostic can name the directory the author can find.
 */
function addAncestorDirectories(path: string, into: Map<string, string>): void {
  const segments = path.split("/");
  for (let depth = 1; depth < segments.length; depth += 1) {
    const directory = segments.slice(0, depth).join("/");
    const folded = directory.toLowerCase();
    if (!into.has(folded)) into.set(folded, directory);
  }
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
/** Where the inline form of the extension lives in the file the author wrote. */
const INLINE_EXTENSION_PATH = `${PORTABLE_MANIFEST_PATH}#/extensions/${CODEX_AGENT_PLUGIN_NAMESPACE}`;

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

/**
 * The `hooks` forms the native manifest accepts: a path, a path array, an
 * inline hook document, or an array of them. All four ran their markers on
 * 0.154.0 in one session (`.capture/codex-client-extension`), so composing an
 * author's declaration with the generated document is a captured shape, not a
 * documented one.
 */
type CodexHooksDeclaration = string | string[] | Record<string, unknown>[];

const isHookObject = (entry: unknown): entry is Record<string, unknown> =>
  entry !== null && typeof entry === "object" && !Array.isArray(entry);

/**
 * Why an authored `hooks` value is none of the four captured forms, or
 * `undefined` when it is one of them. Anything else is declined rather than
 * composed with: wrapped into the generated array it ships a manifest whose
 * `hooks` field is invalid, which drops the generated document along with the
 * author's -- and the build would report success.
 */
function hooksDeclarationProblem(authored: unknown): string | undefined {
  if (typeof authored === "string" || isHookObject(authored)) return undefined;
  if (!Array.isArray(authored)) return `got ${authored === null ? "null" : typeof authored}`;
  if (authored.every((entry) => typeof entry === "string") || authored.every(isHookObject)) return undefined;
  return "got an array that is neither all paths nor all hook objects";
}

/**
 * Whether an authored hook path names the document this projection generates.
 * The vendor documentation's own example is `hooks: "./hooks.json"`, which is
 * exactly that document, so the comparison ignores the `./` anchor and folds
 * case: on the filesystems Codex installs onto, `Hooks.json` is the generated
 * file too.
 */
const namesGeneratedHookDocument = (entry: string, generatedPath: string): boolean =>
  entry.replace(/^(\.\/)+/, "").toLowerCase() === generatedPath.replace(/^(\.\/)+/, "").toLowerCase();

/**
 * Add generated hooks while keeping OpenAI's path and inline-object arrays
 * homogeneous: the documentation permits arrays of paths or arrays of objects,
 * not a mix, so the generated document is inlined when the author inlined
 * theirs.
 *
 * An authored path that already names the generated document is replaced by
 * the generated spelling in place rather than appended to: a path array runs
 * every entry (`.capture/codex-client-extension`), so `["./hooks.json",
 * "./hooks.json"]` fired every generated hook twice.
 */
function appendHookSource(
  authored: unknown,
  generatedPath: string,
  generatedContents: string | Uint8Array,
): { value: CodexHooksDeclaration; error?: string } {
  if (authored === undefined) return { value: generatedPath };
  const entries: unknown[] = Array.isArray(authored) ? authored : [authored];
  if (entries.every((entry) => typeof entry === "string")) {
    const paths = entries as string[];
    if (!paths.some((entry) => namesGeneratedHookDocument(entry, generatedPath))) {
      return { value: [...paths, generatedPath] };
    }
    const deduplicated: string[] = [];
    for (const entry of paths) {
      const named = namesGeneratedHookDocument(entry, generatedPath) ? generatedPath : entry;
      if (named !== generatedPath || !deduplicated.includes(generatedPath)) deduplicated.push(named);
    }
    return { value: Array.isArray(authored) ? deduplicated : generatedPath };
  }

  // Hook artifacts are compiler output and already validated by the adapter,
  // so a document that does not parse is a defect upstream -- reported against
  // the artifact rather than thrown out of the projection.
  try {
    return {
      value: [
        ...(entries as Record<string, unknown>[]),
        JSON.parse(contentsText(generatedContents)) as Record<string, unknown>,
      ],
    };
  } catch (error) {
    return { value: generatedPath, error: error instanceof Error ? error.message : String(error) };
  }
}

const LAUNCHER_PATH = `${RUNTIME_DIR}/${MCP_LAUNCHER_FILE}`;
const LAUNCHER_SERVERS_PATH = `${RUNTIME_DIR}/${MCP_SERVERS_FILE}`;

/** Native stdio server. `type` is absent: `command` is what selects the transport. */
interface CodexStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Names Codex copies from its own environment; `env` carries literals. */
  env_vars?: string[];
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
  hooks?: CodexHooksDeclaration;
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
  mcpEnvironment: Readonly<Record<string, readonly string[]>> = {},
): {
  servers: Record<string, CodexStdioServer | CodexRemoteServer>;
  launcherServers: McpLauncherServer[];
  omitted: { name: string; component: ComponentId; reason: string }[];
} {
  // Null-prototype: a schema-valid server named `__proto__` assigned into `{}`
  // invokes the inherited setter, so JSON.stringify would omit it while the
  // summary counted it emitted.
  const servers: Record<string, CodexStdioServer | CodexRemoteServer> = Object.create(null);
  const launcherServers: McpLauncherServer[] = [];
  const omitted: { name: string; component: ComponentId; reason: string }[] = [];
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
    // Codex starts a stdio child with a fixed platform allowlist and nothing
    // else, so a variable this server reads arrives unset unless it is named
    // here (`.capture/codex-plugin-mcp-environment`). The launcher passes its
    // own environment through, so forwarding reaches the server itself.
    // Own-property lookup: a schema-valid server named `constructor` would
    // otherwise read Object.prototype's member and forward a function.
    const declared = Object.hasOwn(mcpEnvironment, name) ? mcpEnvironment[name] : undefined;
    const forwarded = [...new Set(declared ?? [])].sort();
    servers[name] = {
      command: "node",
      args: [`./${LAUNCHER_PATH}`, String(launcherServers.length)],
      cwd: ".",
      ...(forwarded.length === 0 ? {} : { env_vars: forwarded }),
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
        COMPONENT_IDS.map((component) => [
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
            version: "0.153.2",
            date: "2026-09-27",
            method: "live-probe",
            artifact: ".capture/marketplace-launch",
            what: "On Windows, installed the documented combined example through an isolated marketplace; its skill reached model input, the generated hook denied a harmless shell marker, and the bundled MCP server returned a greeting from an unrelated project with no workspace dependencies.",
          },
          {
            version: "0.156.1",
            date: "2026-09-27",
            method: "live-probe",
            artifact: ".capture/marketplace-launch",
            what: "On Windows, installed the documented combined example through an isolated marketplace; its skill reached model input, the generated hook denied a harmless shell marker, and the bundled MCP server returned a greeting from an unrelated project with no workspace dependencies.",
          },
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
        "agent-plugin.skills": {
          level: "exact",
          rationale:
            "Copied as authored, except that ${SKILL_DIR} in a SKILL.md body becomes `.`: Codex expands nothing in skill text, and the base instructions of the models it bundles tell the model to resolve a skill's relative paths against the directory containing its SKILL.md (ADR-0028). A model without those instructions, such as one behind a custom provider, is not told.",
          degradations: [
            {
              id: SKILL_REFERENCE_UNEXPANDED,
              summary:
                "A SKILL.md that holds a Claude Code variable such as ${CLAUDE_PLUGIN_ROOT}, ${PLUGIN_ROOT} or ${PLUGIN_DATA} anywhere, or ${SKILL_DIR} in its frontmatter, reaches the model with that text as written: Codex expands nothing in skill text, frontmatter included.",
              evidence: ".capture/skill-directory",
            },
          ],
        },
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
            "Codex installs no dependencies -- measured, not assumed. A plugin shipping package.json and package-lock.json declaring one dependency installed with both files copied verbatim, no node_modules in the installed root, and the dependency failing to resolve from it; a node_modules placed there by hand made the same check pass, so the check discriminates. A node_modules shipped INSIDE the package is copied like any other content and does resolve, but Hooknostic never inventories node_modules at any depth and strips one from the source package, so that route is closed for npm specifically. Node code can be bundled, portable package content can be supplied by an explicit components.materialize provider at build time, and author-supplied content is copied verbatim.",
        },
        "agents.definition": {
          level: "unsupported",
          rationale:
            "Codex's plugin format has no agents component: OpenAI tracks bundling agents in a plugin as an open request (openai/codex#18988), and no route was probed that Codex reads from an installed plugin. Deliver agent definitions to a Codex project target, which reads .codex/agents.",
        },
        "agents.primary": {
          level: "unsupported",
          rationale:
            "Codex has no agent a session runs as, and a Codex plugin cannot deliver an agent definition at all.",
        },
        "agents.default": {
          level: "unsupported",
          rationale:
            "A Codex plugin cannot carry configuration or agents, and Hooknostic does not make a package set the default agent anyway. Deliver it to a Codex project target, which emulates it.",
        },
        "agents.native": {
          level: "unsupported",
          rationale: "Native fields ride on a delivered definition, and a Codex plugin cannot deliver one.",
        },
      },
      source: {
        date: "2026-09-08",
        validatedOn: [
          {
            version: "0.154.0",
            date: "2026-09-30",
            method: "live-probe",
            artifact: ".capture/skill-directory",
            what: "Over the loopback model with isolated state, a $where mention handed the model the project skill's SKILL.md path and the whole file with every ${...} as written: ${CLAUDE_SKILL_DIR}, ${CLAUDE_PLUGIN_ROOT}, ${CLAUDE_PLUGIN_DATA}, ${CLAUDE_SESSION_ID}, ${SKILL_DIR}, ${PLUGIN_ROOT}, ${PLUGIN_DATA} and ${HOME}. The base instructions of all seven models codex debug models lists say to resolve relative paths against the directory containing a filesystem-backed SKILL.md; the loopback model, served through a custom provider, received none.",
          },
          {
            version: "0.154.0",
            date: "2026-09-21",
            method: "live-probe",
            artifact: ".capture/mcp-child-path",
            what: "Against the actual projected package, a synthetic ambient variable was absent without components.mcpEnvironment and reached the stdio child when the declaration generated env_vars.",
          },
          {
            version: "0.153.2",
            date: "2026-09-21",
            method: "live-probe",
            artifact: ".capture/mcp-child-path",
            what: "The installed-plugin path at the lower validated edge behaved the same: a synthetic ambient variable was filtered without components.mcpEnvironment and reached the projected stdio child through generated env_vars.",
          },
          {
            version: "0.154.0",
            date: "2026-09-16",
            method: "live-probe",
            artifact: ".capture/mcp-child-path",
            what: "A projected stdio MCP child retained every parent PATH entry plus two Codex entries while the rest of its environment was filtered to 22 keys; the generated launcher bound PLUGIN_ROOT and PLUGIN_DATA, so bare runner commands remained resolvable without relying on ambient configuration variables.",
          },
          {
            version: "0.154.0",
            date: "2026-09-21",
            method: "live-probe",
            artifact: ".capture/codex-plugin-mcp-environment",
            what: "What filters that environment, and the way through it: the same installed plugin in the same environment saw a synthetic marker in its MCP child only once its .mcp.json named it in env_vars, while its UserPromptSubmit command hook saw the marker unchanged in both cases. The marker is not credential-shaped, so the MCP baseline is an allowlist rather than a secret filter. Declared env values are copied verbatim, so Codex expands no reference of its own.",
          },
          {
            version: "0.154.0",
            date: "2026-09-16",
            method: "live-probe",
            artifact: ".capture/codex-client-extension",
            what: 'Four plugins differing only in how the skills directory is named: one declaring nothing had skills/ discovered, so discovery is conventional. One naming ./custom-skills/ solely inside extensions."com.openai" had its skill ignored, but that negative was expected -- portable skills/ is canonical and an inline skills value cannot replace it -- so this run says nothing about whether the namespace is read; the 2026-09-17 records below carry the corrected probe. Observed through codex debug prompt-input, so a discovered skill is one that reaches the model rather than a log line.',
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
          {
            version: "0.154.0",
            date: "2026-09-17",
            method: "live-probe",
            artifact: ".capture/codex-client-extension",
            what: "A native .codex-plugin/plugin.json declaring hooks as a two-path array ran both documents' UserPromptSubmit markers in one isolated loopback session, beside the single-path control. The path-array form this projection emits when an author declares a path is consumed, not merely documented.",
          },
          {
            version: "0.154.0",
            date: "2026-09-17",
            method: "live-probe",
            artifact: ".capture/codex-client-extension",
            what: "The same session ran a native manifest declaring hooks as a single inline hook document and another declaring a two-document inline array; every marker fired. The inline-object-array form this projection emits when an author inlines their hooks is consumed.",
          },
          {
            version: "0.154.0",
            date: "2026-09-17",
            method: "live-probe",
            artifact: ".capture/codex-client-extension",
            what: "A root hooks.json the native manifest never names is inert: beside a manifest with no hooks key its marker stayed absent, and beside a manifest declaring an inline hook document only the inline marker fired, while the single-path control ran in the same session. So the generated hooks.json this projection must still emit when it inlines the generated document beside an author's inline object is not discovered by convention, and generated hooks do not run twice on that path.",
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
    // A skill's SKILL.md is the one copied file whose bytes may change: its
    // body's ${SKILL_DIR} becomes `.` (ADR-0028). A rewritten file is
    // generated, not copied, but still occupies its path for every collision
    // check below.
    const skillTexts = projectPackageSkillTexts(
      source.skills,
      (path) => source.files.find((file) => file.path === path)?.contents,
      RELATIVE_SKILL_TEXT,
      "Codex",
    );

    for (const file of source.files) {
      // The root manifest is what suppresses hooks: a package carrying it and a
      // native one loaded its skill and ignored its hook. `mcp.json` is dropped
      // for a weaker reason -- no capture record says what a root one does
      // beside a native manifest, and an uncaptured shape is declined rather
      // than defaulted, since the plausible reading is a double registration.
      // Folded like every other check on the output layout: a `Plugin.json`
      // Linux distinguishes is the root manifest on the filesystems Codex
      // installs onto, and copied it suppressed every hook the same way.
      const folded = file.path.toLowerCase();
      if (folded === PORTABLE_MANIFEST_PATH || folded === PORTABLE_MCP_PATH) continue;
      // Hoisted below, to the package root, rather than shipped one level down
      // where nothing would read it.
      if (file.path.startsWith(NAMESPACE_PREFIX)) continue;
      // The source project's own development manifest and lockfile describe how
      // to build the package, not anything Codex should install. Copied
      // verbatim they shipped `private: true` and workspace protocol ranges
      // into the plugin, and any name they happened to carry stood in for a
      // published npm coordinate this projection never emits.
      if (isRootNpmManifestPath(file.path)) continue;
      if (isNativeManifestPath(file.path)) {
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
      if (isReservedNativePath(file.path)) {
        // Fatal for the reason the manifest above is, and not subject to
        // `onUnsupported`: the package is claiming an output path, which is not
        // a component Codex cannot represent. Neither path has a
        // `com.openai/` route either -- `reservedHoistTarget` refuses both --
        // so each remediation names something the author can actually do.
        issues.push({
          severity: "error",
          scope: "file",
          path: file.path,
          message:
            file.path.toLowerCase() === NATIVE_MCP_PATH
              ? `Agent Plugin file ${JSON.stringify(file.path)} occupies the native MCP configuration this projection generates from ${JSON.stringify(PORTABLE_MCP_PATH)}; declare the servers there instead, or remove the file from the package.`
              : `Agent Plugin file ${JSON.stringify(file.path)} is inside ${JSON.stringify(`${NATIVE_METADATA_DIR}/`)}, which Codex reads its own plugin metadata from and where only ${JSON.stringify(NATIVE_MANIFEST_PATH)} is consumed; move it elsewhere in the package, or remove it.`,
        });
        continue;
      }
      if (insideRejectedSkill(file.path)) continue;
      files.push({ path: file.path, contents: skillTexts.rewritten.get(file.path) ?? file.contents, mode: file.mode });
      copiedPaths.push(file.path);
    }

    // Keyed case-insensitively, like every other collision check on generated
    // output: the package is inventoried on one filesystem and installed on
    // others, and `Assets/logo.png` beside `assets/Logo.png` is one file on
    // most of them. The value keeps the spelling the package shipped so the
    // diagnostic can name it.
    const shippedByFoldedPath = new Map(copiedPaths.map((path) => [path.toLowerCase(), path]));

    const { servers, launcherServers, omitted } = translateMcp(source, new Set(), context.mcpEnvironment ?? {});
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

    // A hook document colliding with package content is reported below and
    // not emitted, so the manifest must not point at it either.
    const hooksArtifact = context.hookArtifacts.find(
      (file) => file.path === CODEX_PLUGIN_HOOKS_PATH && !shippedByFoldedPath.has(file.path.toLowerCase()),
    );

    // Every path this build generates, known before anything is hoisted, so a
    // hoist landing on one is refused here with the source path named. Checked
    // against what is actually emitted rather than a hand-kept list: the list
    // above states policy, and a generated file it forgot would otherwise be
    // hoistable until someone remembered to add it -- or surface later as a
    // collision blamed on "package content" the author never wrote.
    const generatedByFoldedPath = new Map<string, string>([[NATIVE_MANIFEST_PATH, NATIVE_MANIFEST_PATH]]);
    if (Object.keys(servers).length > 0) generatedByFoldedPath.set(NATIVE_MCP_PATH, NATIVE_MCP_PATH);
    if (launcherServers.length > 0) {
      for (const path of [LAUNCHER_PATH, LAUNCHER_SERVERS_PATH]) generatedByFoldedPath.set(path.toLowerCase(), path);
    }
    for (const file of context.hookArtifacts) {
      if (file.path !== NATIVE_MANIFEST_PATH) generatedByFoldedPath.set(file.path.toLowerCase(), file.path);
    }
    // Provider-materialized package trees are emitted output like any other, so a
    // hoist landing in one is refused before it happens rather than surfacing
    // later as a collision blamed on "package content" the author never wrote.
    // They join `generatedByFoldedPath` rather than `copiedPaths`: their bytes
    // came from an installer, not from the package, so the summary's "copied
    // byte-for-byte" list must not claim them.
    const materialized = materializedPackageFiles(context.materializedTrees, {
      claimed: new Set(copiedPaths),
    });
    issues.push(...materialized.issues);
    for (const file of materialized.files) {
      const folded = file.path.toLowerCase();
      // The same two readings the hoist loop makes below, because a runtime
      // landing on an emitted file or beneath one is the same defect from the
      // other side: `into` was pointed at output rather than at free space.
      const occupied = occupyingFile(folded, generatedByFoldedPath) ?? occupyingFile(folded, shippedByFoldedPath);
      if (occupied !== undefined) {
        issues.push({
          severity: "error",
          scope: "projection",
          path: file.path,
          message: `a materialized package tree lands on or inside ${JSON.stringify(occupied)}, which the output already carries; point its "into" at a directory nothing else uses`,
        });
        continue;
      }
      generatedByFoldedPath.set(folded, file.path);
      files.push(file);
    }
    // Directories the output already has, from shipped files, generated files
    // and the package's own directory inventory. A hoisted FILE landing on one
    // is the mirror of the hoisted-directory-onto-file check below, and without
    // it the collision surfaced in core as an EISDIR-style duplicate that never
    // mentioned the namespace source.
    const occupiedDirectories = new Map<string, string>();
    for (const path of copiedPaths) addAncestorDirectories(path, occupiedDirectories);
    for (const path of generatedByFoldedPath.values()) addAncestorDirectories(path, occupiedDirectories);
    for (const directory of source.directories ?? []) {
      if (directory === CODEX_AGENT_PLUGIN_NAMESPACE || directory.startsWith(NAMESPACE_PREFIX)) continue;
      if (insideRejectedSkill(`${directory}/`)) continue;
      const folded = directory.toLowerCase();
      if (!occupiedDirectories.has(folded)) occupiedDirectories.set(folded, directory);
    }

    // The client extension, hoisted to the root. A `.codex-plugin/plugin.json`
    // here is an overlay rather than a file: it becomes the base of the
    // generated manifest, which is the "compatibility overlay" the vendor
    // documentation describes.
    const inlineExtension = source.manifest.extensions?.[CODEX_AGENT_PLUGIN_NAMESPACE];
    let overlayManifest: Record<string, unknown> = {};
    // Kept so a diagnostic about the overlay's contents can name the file the
    // author actually wrote, rather than the manifest this projection emits.
    let overlaySourcePath: string | undefined;
    // The first overlay seen, accepted or not, so a second spelling of the same
    // path is reported instead of silently replacing it.
    let firstOverlayPath: string | undefined;
    let ignoredCompatibilityOverlays = 0;
    const refuseHoist = (sourcePath: string, message: string): void => {
      issues.push({
        severity: "error",
        scope: "projection",
        component: "agent-plugin.client-extension.files",
        path: sourcePath,
        message,
      });
    };
    for (const file of source.files) {
      if (!file.path.startsWith(NAMESPACE_PREFIX)) continue;
      const path = file.path.slice(NAMESPACE_PREFIX.length);
      if (path === "") continue;
      const folded = path.toLowerCase();
      // Before the reserved-tree check: the overlay lives inside the reserved
      // `.codex-plugin/` tree and is the one thing there that is consumed.
      if (isNativeManifestPath(path)) {
        if (firstOverlayPath !== undefined && inlineExtension === undefined) {
          // Two spellings that are one path on the filesystems Codex installs
          // onto. Last-wins would leave `overlaySourcePath` blaming a file whose
          // contents may not be the ones the author meant.
          refuseHoist(
            file.path,
            `client extension manifest ${JSON.stringify(file.path)} duplicates ${JSON.stringify(firstOverlayPath)}; the two are one path on a case-insensitive filesystem, so only one compatibility overlay can be declared`,
          );
          continue;
        }
        firstOverlayPath ??= file.path;
        // The documented portable form replaces the compatibility overlay
        // wholesale. An ignored fallback cannot make an otherwise valid inline
        // declaration fail merely because stale fallback bytes remain beside it
        // -- so it is not even parsed -- but it is said out loud, like every
        // other client-extension input this projection ignores: edits to this
        // file reach nothing, and only the summary's skipped count showed it.
        if (inlineExtension !== undefined) {
          ignoredCompatibilityOverlays++;
          issues.push({
            severity: "warn",
            scope: "projection",
            component: "agent-plugin.client-extension.files",
            path: file.path,
            message: `client extension overlay ${JSON.stringify(file.path)} is superseded by ${JSON.stringify(
              INLINE_EXTENSION_PATH,
            )} and ignored; fold its settings into the inline object or remove the file.`,
          });
          continue;
        }
        // Malformed is reported, never guessed at.
        const parsed = parseJsonObject(file.contents);
        if (!parsed.ok) {
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
        overlaySourcePath = file.path;
        continue;
      }
      const reserved = reservedHoistTarget(path);
      if (reserved !== undefined) {
        refuseHoist(file.path, reservedHoistMessage("file", file.path, path, reserved));
        continue;
      }
      const generated = generatedByFoldedPath.get(folded);
      if (generated !== undefined) {
        refuseHoist(
          file.path,
          `client extension file ${JSON.stringify(file.path)} hoists onto ${JSON.stringify(generated)}, which this projection generates`,
        );
        continue;
      }
      const shipped = shippedByFoldedPath.get(folded);
      if (shipped !== undefined) {
        refuseHoist(
          file.path,
          `client extension file ${JSON.stringify(file.path)} hoists onto ${JSON.stringify(shipped)}, which the package already ships`,
        );
        continue;
      }
      const occupiedDirectory = occupiedDirectories.get(folded);
      if (occupiedDirectory !== undefined) {
        refuseHoist(
          file.path,
          `client extension file ${JSON.stringify(file.path)} hoists onto ${JSON.stringify(occupiedDirectory)}, which is a directory of the output`,
        );
        continue;
      }
      const occupiedFile = occupyingFile(folded, shippedByFoldedPath) ?? occupyingFile(folded, generatedByFoldedPath);
      if (occupiedFile !== undefined) {
        refuseHoist(
          file.path,
          `client extension file ${JSON.stringify(file.path)} hoists inside ${JSON.stringify(occupiedFile)}, which is emitted as a file`,
        );
        continue;
      }
      shippedByFoldedPath.set(folded, path);
      addAncestorDirectories(path, occupiedDirectories);
      files.push({ path, contents: file.contents, mode: file.mode });
      copiedPaths.push(path);
    }

    // Typed where this projection decides the value, free-form where the client
    // extension does: Codex's presentation surface is large and vendor-owned,
    // and modelling its field names here would mean a Hooknostic release every
    // time OpenAI adds one.
    const extensionEntry = inlineExtension ?? overlayManifest;
    // Where the author's declaration lives -- the whole extension, or one key
    // of it: one of the two files they wrote, never the manifest this
    // projection generates. Naming that would send them to output they do not
    // have, and which is a hard error to ship. Only those two files can have
    // supplied a key, so one of them is always the source.
    const declarationPath = (key?: string): { path: string } | Record<never, never> => {
      if (inlineExtension !== undefined) {
        return { path: key === undefined ? INLINE_EXTENSION_PATH : `${INLINE_EXTENSION_PATH}/${key}` };
      }
      if (overlaySourcePath === undefined) return {};
      return { path: key === undefined ? overlaySourcePath : `${overlaySourcePath}#/${key}` };
    };
    const hooksProblem = "hooks" in extensionEntry ? hooksDeclarationProblem(extensionEntry["hooks"]) : undefined;
    if (hooksProblem !== undefined) {
      issues.push({
        severity: "error",
        scope: "manifest",
        component: "agent-plugin.client-extension.files",
        ...declarationPath("hooks"),
        message: `client extension "hooks" must be a path, an array of paths, a hook object, or an array of hook objects (the forms captured on Codex); ${hooksProblem}.`,
      });
    }
    // When the author inlined their hooks, the generated document is inlined
    // beside them and the generated hooks.json file is still emitted below,
    // because core verifies that every hook artifact survives projection. That
    // file is inert: a root hooks.json the native manifest does not name is not
    // discovered by convention, beside a manifest with no hooks key or one with
    // an inline document (`.capture/codex-client-extension`), so the generated
    // hooks run once on this path rather than from both the manifest and the
    // file.
    const composedHooks =
      hooksArtifact === undefined
        ? undefined
        : appendHookSource(
            hooksProblem === undefined ? extensionEntry["hooks"] : undefined,
            `./${CODEX_PLUGIN_HOOKS_PATH}`,
            hooksArtifact.contents,
          );
    if (composedHooks?.error !== undefined) {
      issues.push({
        severity: "error",
        scope: "projection",
        path: CODEX_PLUGIN_HOOKS_PATH,
        message: `generated hook document ${JSON.stringify(CODEX_PLUGIN_HOOKS_PATH)} is not JSON, so it cannot be inlined beside the client extension's hook object: ${composedHooks.error}`,
      });
    }

    // Carried rather than dropped: a manifest declaring all of these installed
    // and resolved its version normally (`.capture/codex-native-mcp`), so
    // passing them through cannot lose information whether Codex reads them or
    // ignores them -- whereas dropping them certainly does.
    // The inline OpenAI object replaces the compatibility overlay; portable
    // identity and components remain canonical in either case. Component
    // pointers come last, `mcpServers` before `hooks`: the committed example's
    // manifest is byte-compared in CI, so key order is part of the output.
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
      ...(Object.keys(servers).length === 0 ? {} : { mcpServers: `./${NATIVE_MCP_PATH}` }),
      ...(composedHooks === undefined ? {} : { hooks: composedHooks.value }),
    };
    const manifest: Record<string, unknown> = { ...extensionEntry, ...generated };
    // A declined `hooks` value must not survive the spread either, whether or
    // not a generated document replaced it.
    if (hooksProblem !== undefined && !("hooks" in generated)) delete manifest["hooks"];
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
        // The package is valid; this projection decided to ignore part of it.
        // `scope: "manifest"` would file that as invalid Agent Plugin input,
        // blaming the author for a choice made here -- the same misfiling the
        // MCP omission below is careful to avoid.
        severity: "warn",
        scope: "projection",
        component: "agent-plugin.client-extension.files",
        ...declarationPath(),
        message: `client extension declares ${claimed.map((key) => JSON.stringify(key)).join(", ")}, which this projection decides from the package itself; the declared value is ignored.`,
      });
    }

    if (Object.keys(servers).length > 0) {
      files.push({
        path: NATIVE_MCP_PATH,
        contents: `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
      });
    }
    if (launcherServers.length > 0) {
      // A better diagnostic than the duplicate-path failure core would raise
      // anyway (`artifacts.ts`), naming the colliding path and why it is taken.
      for (const path of [LAUNCHER_PATH, LAUNCHER_SERVERS_PATH]) {
        if (!shippedByFoldedPath.has(path.toLowerCase())) continue;
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

    for (const file of context.hookArtifacts) {
      // Generation emits a hooks-only manifest so that an unprojected
      // plugin-mode target is still installable; the fuller one written below
      // replaces it at the same path.
      if (file.path === NATIVE_MANIFEST_PATH) continue;
      if (shippedByFoldedPath.has(file.path.toLowerCase())) {
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

    files.push({
      path: NATIVE_MANIFEST_PATH,
      contents: `${JSON.stringify(manifest, null, 2)}\n`,
    });

    // Per-server, not per-transport: a stdio server is dropped only when its own
    // paths cannot be re-anchored, so the count comes from what was omitted.
    const skippedByComponent = new Map<ComponentId, number>();
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
              // The overlay's own directory: every package carrying an overlay
              // inventories it, and staging creates it for the generated
              // manifest anyway. Anything beneath it is reserved.
              if (outputPath.toLowerCase() === NATIVE_METADATA_DIR) return [];
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
            const firstByCaseFoldedOutput = new Map<string, { sourcePath: string; index: number }>();
            for (const { sourcePath, outputPath } of directoryCandidates) {
              const caseFoldedOutput = outputPath.toLowerCase();
              const previous = firstByCaseFoldedOutput.get(caseFoldedOutput);
              if (previous === undefined) {
                firstByCaseFoldedOutput.set(caseFoldedOutput, { sourcePath, index: retained.length });
                retained.push(outputPath);
                continue;
              }
              const hoistedHere = sourcePath.startsWith(NAMESPACE_PREFIX);
              // Two ordinary source directories remain for core's general
              // path validation. A namespace directory maps to the same
              // physical output directory after hoisting, so coalesce it.
              if (!hoistedHere && !previous.sourcePath.startsWith(NAMESPACE_PREFIX)) {
                retained.push(outputPath);
                continue;
              }
              // A directory is mergeable: its non-conflicting files already
              // hoist independently, so retain one output directory and let
              // the file collision checks reject only a path that cannot
              // coexist on a case-insensitive filesystem. The package's own
              // spelling is the one retained, whichever the inventory listed
              // first: on a case-sensitive filesystem that is the directory
              // its unhoisted files land in. Once the package's spelling holds
              // the slot, the entry records that, so a second ordinary
              // spelling is kept beside it for core's duplicate check rather
              // than overwriting it and hiding the pair.
              if (!hoistedHere) {
                retained[previous.index] = outputPath;
                previous.sourcePath = sourcePath;
              }
            }
            return retained;
          })();
    // Generated paths are case-insensitive: a package can carry `assets` at
    // its root and `com.openai/Assets` side by side, but the latter hoists onto
    // the former on case-insensitive filesystems.
    const emittedByFoldedPath = new Map(files.map((file) => [file.path.toLowerCase(), file.path]));
    for (const { sourcePath, outputPath } of hoistedDirectories ?? []) {
      const occupiedFile = occupyingFile(outputPath.toLowerCase(), emittedByFoldedPath);
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
      ...(context.agents === undefined ? {} : { agents: context.agents }),
      harness: "codex",
      ...(context.defaultAgent === undefined ? {} : { defaultAgent: context.defaultAgent }),
      skipped: (component, discovered) =>
        component === "agent-plugin.runtime-package" || component.startsWith("agents.")
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
    // Analysis already reported the unsupported component; nothing is emitted,
    // because a plugin has no agents route Codex is known to read.
    for (const agent of context.agents ?? []) {
      omissions.push({
        component: "agents.definition",
        name: agent.name,
        reason: "a Codex plugin has no agents route; deliver agent definitions to a project target instead",
      });
    }
    if (context.defaultAgent !== undefined) {
      omissions.push({ component: "agents.default", name: context.defaultAgent, reason: DEFAULT_AGENT_NOT_PACKAGED });
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
        ...(skillTexts.degradations.length === 0 ? {} : { degradations: skillTexts.degradations }),
        copiedPaths: [...copiedPaths]
          .filter((path) => !skillTexts.rewritten.has(path))
          .sort((a, b) => a.localeCompare(b)),
      },
    };
  },
};
