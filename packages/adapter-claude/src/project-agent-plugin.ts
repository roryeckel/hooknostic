import {
  type AgentPluginDeviation,
  type AgentPluginIssue,
  type AgentPluginMcpServer,
  type AgentPluginPackage,
  type AgentPluginProjectionFile,
  type AgentPluginProjectionPlan,
  type AgentPluginProjector,
  assertPackageDelivery,
  classifyStdioCwd,
  componentSummary,
  hasUnportableCommandPath,
  isJsonObject as object,
  isRejectedSkillPath,
  isRootNpmManifestPath,
  materializedPackageFiles,
  parseJsonObject,
  validateNpmRuntimePackage,
} from "@hooknostic/agent-plugin";
import type { TargetSpec } from "@hooknostic/core";
import { bundleMcpLauncher, MCP_LAUNCHER_FILE } from "@hooknostic/core";

import {
  claudeExpandedReferences,
  declaresEnvironmentExpansion,
  ENVIRONMENT_EXPANSION_DEVIATION,
  environmentExpansionReason,
} from "./mcp-expansion.js";

export const CLAUDE_AGENT_PLUGIN_NAMESPACE = "com.anthropic.claude-code";
const MANIFEST_PATH = ".claude-plugin/plugin.json";
const MCP_PATH = ".mcp.json";
const HOOKS_PATH = "hooks/hooks.json";

// Claude treats a `package.json`/`package-lock.json` pair at the plugin root as
// install input for its locked, script-free `npm ci` (ADR-0012), so only the
// explicitly configured and validated `runtimePackage` may materialize there.
// Both routes into the root — a plain package file and a Claude
// client-extension overlay file — are filtered against `isRootNpmManifestPath`,
// so neither can override the validated runtime lock.

const CLAUDE_METADATA_PREFIX = ".claude-plugin/";

// The paths Claude reads as its own plugin configuration are this projector's
// output: `.claude-plugin/` metadata, `.mcp.json`, and `hooks/hooks.json` are
// each merged from the portable components and the Claude client extension. A
// package-root file that happens to sit at one of them is neither of those
// inputs, and copying it there would hand Claude native configuration that
// never passed the portable validation its components receive — the source
// package would be deciding the shape of the emitted plugin (ADR-0011). The
// comparison case-folds for the same reason `isRootNpmManifestPath` does.
function isReservedNativePath(path: string): boolean {
  const name = path.toLowerCase();
  return name.startsWith(CLAUDE_METADATA_PREFIX) || name === MCP_PATH || name === HOOKS_PATH;
}

function parseObject(file: AgentPluginProjectionFile | undefined, label: string): Record<string, unknown> {
  if (file === undefined) return {};
  const parsed = parseJsonObject(file.contents);
  if (!parsed.ok) throw new Error(`${label} ${parsed.error}`);
  return parsed.value;
}

function stringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizedPortablePath(path: string): string | undefined {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized === "" || normalized.startsWith("/") || normalized.split("/").includes("..")) return undefined;
  return normalized;
}

function runtimePackageFiles(
  source: AgentPluginPackage,
  context: Parameters<AgentPluginProjector<TargetSpec>["project"]>[1],
): { manifest: AgentPluginProjectionFile; lockfile: AgentPluginProjectionFile; sourcePaths: Set<string> } | undefined {
  const configured = context.runtimePackage;
  if (configured === undefined) return undefined;
  const manifestPath = normalizedPortablePath(configured.manifest);
  const lockfilePath = normalizedPortablePath(configured.lockfile);
  if (manifestPath === undefined || lockfilePath === undefined || manifestPath === lockfilePath) {
    throw new Error("runtimePackage.manifest and runtimePackage.lockfile must be distinct package-root-relative paths");
  }
  const manifest = source.files.find((file) => file.path === manifestPath);
  const lockfile = source.files.find((file) => file.path === lockfilePath);
  if (manifest === undefined || lockfile === undefined) {
    throw new Error("runtimePackage.manifest and runtimePackage.lockfile must name included regular files");
  }
  // Claude installs the pair with a locked, script-free npm install in its
  // cached plugin copy (ADR-0012), so the manifest and lockfile must agree and
  // every dependency must be locked, or installation fails on the consumer's
  // machine rather than here.
  const validation = validateNpmRuntimePackage(
    manifest.contents,
    lockfile.contents,
    configured.allowInstallScripts === undefined ? {} : { allowInstallScripts: configured.allowInstallScripts },
  );
  if (!validation.ok) throw new Error(validation.error);
  return {
    manifest: { path: "package.json", contents: manifest.contents, mode: manifest.mode },
    lockfile: { path: "package-lock.json", contents: lockfile.contents, mode: lockfile.mode },
    sourcePaths: new Set([manifestPath, lockfilePath]),
  };
}

function replacePluginVariables(value: string): string {
  return value
    .replaceAll("${PLUGIN_ROOT}", "${CLAUDE_PLUGIN_ROOT}")
    .replaceAll("${PLUGIN_DATA}", "${CLAUDE_PLUGIN_DATA}");
}

// Claude ignores stdio `cwd`, so the launcher establishes the portable working
// directory before starting the server (`.capture/claude-mcp-cwd`).
const MCP_LAUNCHER_PATH = `runtime/${MCP_LAUNCHER_FILE}`;

/** A translated server, or the reason this one cannot be represented. */
type TranslatedServer = { entry: Record<string, unknown>; reason?: undefined } | { entry?: undefined; reason: string };

function translateServer(server: AgentPluginMcpServer): TranslatedServer {
  if (server.type !== "stdio") {
    return {
      entry: {
        type: server.type === "streamable-http" ? "http" : server.type,
        url: server.url,
        ...(server.headers === undefined ? {} : { headers: server.headers }),
      },
    };
  }
  if (hasUnportableCommandPath(server.command)) {
    return {
      reason: `command ${JSON.stringify(server.command)} contains a backslash, which is a path separator only on the consumer's platform`,
    };
  }
  const classified = classifyStdioCwd(server.cwd);
  if (classified === undefined) {
    return {
      reason: `working directory ${JSON.stringify(server.cwd)} escapes the directory it is anchored on`,
    };
  }
  // Never translated: the specification expands nothing in `command`, so a
  // `${PLUGIN_ROOT}` there is literal text, and Claude's own expansion of it
  // is reported as a deviation rather than arranged.
  const command = server.command.startsWith("./")
    ? `\${CLAUDE_PLUGIN_ROOT}/${server.command.slice(2)}`
    : server.command;
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(server.env ?? {}).map(([key, value]) => [key, replacePluginVariables(value)]),
  );
  env["PLUGIN_ROOT"] = "${CLAUDE_PLUGIN_ROOT}";
  env["PLUGIN_DATA"] = "${CLAUDE_PLUGIN_DATA}";
  // Through the shared classifier rather than a prefix replacement, which
  // passed `${PLUGIN_DATA}/../x` through unchecked and left `./worker/./`
  // unnormalized.
  const base = classified.base === "root" ? "CLAUDE_PLUGIN_ROOT" : "CLAUDE_PLUGIN_DATA";
  const cwd = classified.relative === "." ? `\${${base}}` : `\${${base}}/${classified.relative}`;
  return {
    entry: {
      type: "stdio",
      command: "node",
      args: [
        `\${CLAUDE_PLUGIN_ROOT}/${MCP_LAUNCHER_PATH}`,
        cwd,
        command,
        ...(server.args ?? []).map(replacePluginVariables),
      ],
      env,
      cwd,
    },
  };
}

function workingDirectories(source: AgentPluginPackage): string[] {
  const included = new Set(source.directories ?? []);
  const required = new Set<string>();
  for (const server of Object.values(source.mcp?.mcpServers ?? {})) {
    if (server.type !== "stdio" || server.cwd === undefined) continue;
    const classified = classifyStdioCwd(server.cwd);
    // Retain only existing, inventoried package directories. In particular,
    // never create arbitrary paths or client-managed PLUGIN_DATA directories.
    if (classified === undefined || classified.base !== "root") continue;
    if (included.has(classified.relative)) required.add(classified.relative);
  }
  return [...required].sort();
}

function hooksFrom(value: Record<string, unknown>, label: string): Record<string, unknown[]> {
  const hooks = value["hooks"];
  if (hooks === undefined) return {};
  if (!object(hooks)) throw new Error(`${label} hooks must be an object`);
  const result: Record<string, unknown[]> = {};
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) throw new Error(`${label} hooks.${event} must be an array`);
    result[event] = entries;
  }
  return result;
}

function mergeHooks(
  nativeManifest: Record<string, unknown>,
  generatedManifest: Record<string, unknown>,
): Record<string, unknown> {
  const native = hooksFrom(nativeManifest, "client extension");
  const generated = hooksFrom(generatedManifest, "Hooknostic");
  const events = new Set([...Object.keys(native), ...Object.keys(generated)]);
  return {
    ...(typeof nativeManifest["description"] === "string"
      ? { description: nativeManifest["description"] }
      : typeof generatedManifest["description"] === "string"
        ? { description: generatedManifest["description"] }
        : {}),
    hooks: Object.fromEntries(
      [...events].sort().map((event) => [event, [...(native[event] ?? []), ...(generated[event] ?? [])]]),
    ),
  };
}

function componentCounts(
  source: AgentPluginPackage,
  runtimePackage: "absent" | "emitted" | "skipped",
  omittedStdio = 0,
) {
  const prefix = `${CLAUDE_AGENT_PLUGIN_NAMESPACE}/`;
  return componentSummary(source, {
    namespace: CLAUDE_AGENT_PLUGIN_NAMESPACE,
    hasRuntimePackage: runtimePackage !== "absent",
    skipped: (component) => {
      if (component === "agent-plugin.runtime-package") return runtimePackage === "skipped" ? 1 : 0;
      // A refused stdio server is discovered but not emitted; without this the
      // report contradicts summary.omissions and .mcp.json alike.
      if (component === "agent-plugin.mcp.stdio") return omittedStdio;
      if (component !== "agent-plugin.client-extension.files") return 0;
      // Only the overlay files npm would read as install input are withheld;
      // the manifest extension and every other overlay file are emitted.
      return source.files.filter(
        (file) => file.path.startsWith(prefix) && isRootNpmManifestPath(file.path.slice(prefix.length)),
      ).length;
    },
  });
}

export async function projectAgentPluginToClaude(
  source: AgentPluginPackage,
  context: Parameters<AgentPluginProjector<TargetSpec>["project"]>[1],
): Promise<AgentPluginProjectionPlan> {
  assertPackageDelivery("claude", context.target.delivery);
  const issues: AgentPluginIssue[] = [];
  const omissions: AgentPluginProjectionPlan["summary"]["omissions"] = [];
  const deviations: AgentPluginDeviation[] = [];
  const files = new Map<string, AgentPluginProjectionFile>();
  const copiedPaths = new Set<string>();
  const insideRejectedSkill = isRejectedSkillPath(source);
  let runtimePackage: ReturnType<typeof runtimePackageFiles>;

  try {
    runtimePackage = runtimePackageFiles(source, context);
  } catch (error) {
    return {
      files: [],
      issues: [
        {
          severity: "error",
          scope: "file",
          component: "agent-plugin.runtime-package",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      summary: {
        components: componentCounts(source, "skipped"),
        omissions: [],
        copiedPaths: [],
      },
    };
  }

  for (const file of source.files) {
    if (
      file.path === "plugin.json" ||
      file.path === "mcp.json" ||
      // A package root commonly has the source project's development manifest
      // and lockfile.
      isRootNpmManifestPath(file.path) ||
      runtimePackage?.sourcePaths.has(file.path)
    )
      continue;
    if (file.path.startsWith(`${CLAUDE_AGENT_PLUGIN_NAMESPACE}/`)) continue;
    if (isReservedNativePath(file.path)) {
      // Reported rather than skipped, and fatal rather than subject to
      // `onUnsupported`: this is a package that claims Claude's output paths,
      // not a valid component Claude cannot represent. Every offending path is
      // collected so one build names them all.
      issues.push({
        severity: "error",
        scope: "file",
        path: file.path,
        message: `Agent Plugin file ${JSON.stringify(file.path)} occupies a path Claude reads as native plugin configuration; move it to ${JSON.stringify(`${CLAUDE_AGENT_PLUGIN_NAMESPACE}/${file.path}`)} to declare it as a Claude client extension, or remove it from the package.`,
      });
      continue;
    }
    if (insideRejectedSkill(file.path)) continue;
    files.set(file.path, { path: file.path, contents: file.contents, mode: file.mode });
    copiedPaths.add(file.path);
  }

  for (const file of source.files) {
    const prefix = `${CLAUDE_AGENT_PLUGIN_NAMESPACE}/`;
    if (!file.path.startsWith(prefix)) continue;
    const path = file.path.slice(prefix.length);
    if (isRootNpmManifestPath(path)) {
      // Dropping a declared overlay file degrades the client-extension
      // component, so it obeys the same policy as any other unrepresentable
      // component: fatal by default, silent only under `onUnsupported: "warn"`.
      const reason = `Claude would install a plugin-root ${path} without the validation components.runtimePackage inputs receive; declare npm dependencies with runtimePackage instead`;
      omissions.push({ component: "agent-plugin.client-extension.files", name: file.path, reason });
      issues.push({
        severity: context.onUnsupported,
        scope: "projection",
        component: "agent-plugin.client-extension.files",
        path: file.path,
        message: `Claude client-extension file ${JSON.stringify(file.path)} was omitted: ${reason}.`,
      });
      continue;
    }
    files.set(path, { path, contents: file.contents, mode: file.mode });
    copiedPaths.add(path);
  }

  const materialized = materializedPackageFiles(context.materializedTrees, { claimed: copiedPaths });
  issues.push(...materialized.issues);
  // A materialized tree landing on a path this projection generates is a collision
  // between two of its own outputs, not package content, and the later
  // `files.set` at each generated path would silently drop the runtime.
  // `isReservedNativePath` covers all of them: the manifest, `.mcp.json` and
  // `hooks/hooks.json` are exactly the paths Claude reads as its own
  // configuration, which is why the generator writes them there.
  const materializedPaths = new Set<string>();
  for (const file of materialized.files) {
    if (isReservedNativePath(file.path)) {
      issues.push({
        severity: "error",
        scope: "projection",
        component: "agent-plugin.client-extension.files",
        path: file.path,
        message: `a materialized package tree lands on ${JSON.stringify(file.path)}, a path this projection generates or Claude reads as native configuration; point its "into" at a directory the output does not use`,
      });
      continue;
    }
    materializedPaths.add(file.path);
    files.set(file.path, file);
  }

  try {
    if (runtimePackage !== undefined) {
      files.set("package.json", runtimePackage.manifest);
      files.set("package-lock.json", runtimePackage.lockfile);
    }
    const extensionManifest = parseObject(files.get(MANIFEST_PATH), "Claude plugin manifest");
    const manifestExtension = source.manifest.extensions?.[CLAUDE_AGENT_PLUGIN_NAMESPACE] ?? {};
    const manifest: Record<string, unknown> = {
      ...extensionManifest,
      ...manifestExtension,
      name: source.manifest.name,
      ...(source.manifest.version === undefined ? {} : { version: source.manifest.version }),
      ...(source.manifest.description === undefined ? {} : { description: source.manifest.description }),
      ...(source.manifest.author === undefined ? {} : { author: source.manifest.author }),
      ...(source.manifest.homepage === undefined ? {} : { homepage: source.manifest.homepage }),
      ...(source.manifest.repository === undefined ? {} : { repository: source.manifest.repository }),
      ...(source.manifest.license === undefined ? {} : { license: source.manifest.license }),
      ...(source.manifest.keywords === undefined ? {} : { keywords: source.manifest.keywords }),
    };
    // Native validation requires a non-empty name, unlike the portable
    // author object (.capture/claude-plugin-author). Check after identity
    // precedence is resolved so an overlay cannot invent a missing name.
    const author = manifest["author"];
    if (
      author !== undefined &&
      (!object(author) || typeof author["name"] !== "string" || author["name"].length === 0)
    ) {
      const reason = "Claude requires author.name to be a non-empty string";
      // The three places an author can be declared, in the precedence resolved
      // just above. Naming the manifest this projection generates would send
      // the author to output they do not have.
      const declaredAt =
        source.manifest.author !== undefined
          ? "plugin.json#/author"
          : "author" in manifestExtension
            ? `plugin.json#/extensions/${CLAUDE_AGENT_PLUGIN_NAMESPACE}/author`
            : `${CLAUDE_AGENT_PLUGIN_NAMESPACE}/${MANIFEST_PATH}#/author`;
      issues.push({
        severity: context.onUnsupported,
        scope: "projection",
        component: "agent-plugin.manifest",
        path: declaredAt,
        message: `Author metadata cannot be projected: ${reason}; supply a name or use onUnsupported: "warn" to omit the author.`,
      });
      omissions.push({ component: "agent-plugin.manifest", name: "author", reason });
      delete manifest["author"];
    }
    files.set(MANIFEST_PATH, { path: MANIFEST_PATH, contents: stringify(manifest) });
    copiedPaths.delete(MANIFEST_PATH);

    const extensionMcp = parseObject(files.get(MCP_PATH), "Claude MCP configuration");
    const extensionServers = extensionMcp["mcpServers"];
    if (extensionServers !== undefined && !object(extensionServers)) {
      throw new Error("Claude MCP configuration mcpServers must be an object");
    }
    const translated: Record<string, Record<string, unknown>> = Object.create(null);
    let emittedStdio = 0;
    for (const [name, server] of Object.entries(source.mcp?.mcpServers ?? {})) {
      const { entry, reason } = translateServer(server);
      if (entry === undefined) {
        omissions.push({ component: "agent-plugin.mcp.stdio", name, reason });
        issues.push({
          severity: context.onUnsupported,
          scope: "projection",
          component: "agent-plugin.mcp.stdio",
          path: `mcp.json#${name}`,
          message: `MCP server ${JSON.stringify(name)} was omitted: ${reason}.`,
        });
        continue;
      }
      // Emitted either way. The native declaration stays visible to Claude
      // rather than hidden behind an opaque document, and the author of a
      // `${NAME}` almost always means expansion (ADR-0011, fifteenth amendment).
      const component = `agent-plugin.mcp.${server.type}` as const;
      const references = claudeExpandedReferences(server);
      if (references.length > 0 && declaresEnvironmentExpansion(context.support[component])) {
        deviations.push({
          id: ENVIRONMENT_EXPANSION_DEVIATION,
          component,
          name,
          path: `mcp.json#${name}`,
          reason: environmentExpansionReason(name, references),
        });
      }
      if (entry["type"] === "stdio") emittedStdio += 1;
      Object.defineProperty(translated, name, {
        value: entry,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    // Gated on what survived translation, not on what the package declared: an
    // unused launcher would still take the generated path, and its collision
    // check would then fail a build that onUnsupported: "warn" should pass.
    if (emittedStdio > 0) {
      if (context.hookArtifacts.some((file) => file.path === MCP_LAUNCHER_PATH)) {
        throw new Error(
          `generated MCP launcher path ${JSON.stringify(MCP_LAUNCHER_PATH)} collides with a compiled hook artifact`,
        );
      }
      if (materializedPaths.has(MCP_LAUNCHER_PATH)) {
        throw new Error(
          `generated MCP launcher path ${JSON.stringify(MCP_LAUNCHER_PATH)} collides with a materialized package tree; point its "into" at a directory the output does not use`,
        );
      }
      if (files.has(MCP_LAUNCHER_PATH)) {
        throw new Error(
          `generated MCP launcher path ${JSON.stringify(MCP_LAUNCHER_PATH)} collides with package content`,
        );
      }
      files.set(MCP_LAUNCHER_PATH, {
        path: MCP_LAUNCHER_PATH,
        contents: await bundleMcpLauncher({ frontEnd: "client-expanded" }),
      });
    }
    for (const name of Object.keys(translated)) {
      if (object(extensionServers) && Object.hasOwn(extensionServers, name)) {
        throw new Error(`MCP server ${JSON.stringify(name)} exists in both mcp.json and the Claude client extension`);
      }
    }
    const mergedServers = { ...(object(extensionServers) ? extensionServers : {}), ...translated };
    if (Object.keys(mergedServers).length > 0) {
      files.set(MCP_PATH, { path: MCP_PATH, contents: stringify({ ...extensionMcp, mcpServers: mergedServers }) });
      copiedPaths.delete(MCP_PATH);
    } else {
      files.delete(MCP_PATH);
      copiedPaths.delete(MCP_PATH);
    }

    const generatedHooksFile = context.hookArtifacts.find((file) => file.path === HOOKS_PATH);
    if (generatedHooksFile !== undefined) {
      const nativeHooks = parseObject(files.get(HOOKS_PATH), "Claude client-extension hooks");
      const generatedHooks = parseObject(generatedHooksFile, "Hooknostic hooks");
      files.set(HOOKS_PATH, { path: HOOKS_PATH, contents: stringify(mergeHooks(nativeHooks, generatedHooks)) });
      copiedPaths.delete(HOOKS_PATH);
    }
    for (const hookFile of context.hookArtifacts) {
      if (hookFile.path === MANIFEST_PATH || hookFile.path === HOOKS_PATH) continue;
      if (materializedPaths.has(hookFile.path)) {
        // Both are output this projection emits, so the collision is named by
        // the runtime's destination rather than as package content the author
        // never wrote.
        issues.push({
          severity: "error",
          scope: "projection",
          path: hookFile.path,
          message: `generated Hooknostic path ${JSON.stringify(hookFile.path)} collides with a materialized package tree at the same path; point its "into" at a directory the output does not use`,
        });
        continue;
      }
      if (files.has(hookFile.path)) {
        throw new Error(`generated Hooknostic path ${JSON.stringify(hookFile.path)} collides with package content`);
      }
      files.set(hookFile.path, hookFile);
    }
  } catch (error) {
    issues.push({
      severity: "error",
      scope: "projection",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    directories: workingDirectories(source),
    issues,
    summary: {
      components: componentCounts(
        source,
        runtimePackage === undefined ? "absent" : "emitted",
        // Derived from what was reported, so the count and summary.omissions
        // cannot disagree.
        omissions.filter((item) => item.component === "agent-plugin.mcp.stdio").length,
      ),
      omissions,
      deviations,
      copiedPaths: [...copiedPaths].filter((path) => files.has(path)).sort((a, b) => a.localeCompare(b)),
    },
  };
}

export const claudeAgentPluginProjector: AgentPluginProjector<TargetSpec> = {
  namespace: CLAUDE_AGENT_PLUGIN_NAMESPACE,
  // A Claude plugin loads hooks/hooks.json from its own installed root, so the
  // package IS the hook channel here and both share the target's output.
  profiles: [
    {
      range: ">=2.1 <3",
      components: {
        "agent-plugin.manifest": {
          level: "exact",
          rationale:
            "Author metadata requires a non-empty name; otherwise projection fails or explicitly omits the author under onUnsupported: warn.",
        },
        "agent-plugin.skills": { level: "exact" },
        "agent-plugin.mcp.stdio": {
          level: "exact",
          deviations: [
            {
              id: ENVIRONMENT_EXPANSION_DEVIATION,
              summary:
                "Claude substitutes set variables from its own environment (never from the server's env block) into stdio command, args, env values and cwd, where Agent Plugins 1.0 expands only ${PLUGIN_ROOT} and ${PLUGIN_DATA} and never the command.",
              evidence: ".capture/agent-plugin-mcp-placeholders",
            },
          ],
        },
        "agent-plugin.mcp.streamable-http": {
          level: "exact",
          deviations: [
            {
              id: ENVIRONMENT_EXPANSION_DEVIATION,
              summary:
                "Claude substitutes set environment variables into remote urls and headers, where Agent Plugins 1.0 forbids all expansion.",
              evidence: ".capture/agent-plugin-mcp-placeholders",
            },
          ],
        },
        "agent-plugin.mcp.sse": {
          level: "exact",
          deviations: [
            {
              id: ENVIRONMENT_EXPANSION_DEVIATION,
              summary:
                "Claude substitutes set environment variables into remote urls and headers, where Agent Plugins 1.0 forbids all expansion.",
              evidence: ".capture/agent-plugin-mcp-placeholders",
            },
          ],
        },
        "agent-plugin.client-extension.files": { level: "exact" },
        "agent-plugin.runtime-package": { level: "exact" },
        // Replaced by captured levels when package projection emits subagents (ADR-0027).
        "subagents.definition": {
          level: "unsupported",
          rationale: "Package projection does not emit subagent definitions yet (ADR-0027, proposed).",
        },
        "subagents.native": {
          level: "unsupported",
          rationale: "Package projection does not emit subagent definitions yet (ADR-0027, proposed).",
        },
      },
      source: {
        date: "2026-09-04",
        validatedOn: [
          {
            version: "2.1.260",
            date: "2026-09-27",
            method: "live-probe",
            artifact: ".capture/marketplace-launch",
            what: "On Windows, installed the documented combined example through an isolated marketplace; its skill reached model input, the generated hook denied a harmless shell marker, and the bundled MCP server returned a greeting from an unrelated project with no workspace dependencies.",
          },
          {
            version: "2.1.283",
            date: "2026-09-27",
            method: "live-probe",
            artifact: ".capture/marketplace-launch",
            what: "On Windows, installed the documented combined example through an isolated marketplace; its skill reached model input, the generated hook denied a harmless shell marker, and the bundled MCP server returned a greeting from an unrelated project with no workspace dependencies.",
          },
          {
            version: "2.1.278",
            date: "2026-09-21",
            method: "live-probe",
            artifact: ".capture/agent-plugin-mcp-placeholders",
            what: "A stdio reference to a name the server's own env block also declares resolved to Claude's ambient value, not the declared one, and a name only the block declares stayed literal, in env and args alike; the child still received each declared value.",
          },
          {
            version: "2.1.278",
            date: "2026-09-21",
            method: "live-probe",
            artifact: ".capture/agent-plugin-mcp-placeholders",
            what: "Claude expanded set ${NAME} and ${NAME:-default} references in a projected package's stdio command, args, env values and launcher cwd argument, and in plugin remote urls and header values as the projection emits them; plain unset references remained literal, and placeholder-like header names stayed literal and were refused as invalid.",
          },
          {
            version: "2.1.278",
            date: "2026-09-21",
            method: "live-probe",
            artifact: ".capture/mcp-child-path",
            what: "An arbitrary synthetic ambient variable reached a stdio child launched from the actual projected package with or without components.mcpEnvironment, establishing that Claude needs no target-specific forwarding declaration.",
          },
          {
            version: "2.1.273",
            date: "2026-09-16",
            method: "live-probe",
            artifact: ".capture/mcp-child-path",
            what: "A projected stdio MCP child inherited the parent PATH unchanged, while the generated launcher bound PLUGIN_ROOT and PLUGIN_DATA and established the plugin directory as cwd; bare runner commands remained resolvable.",
          },
          {
            version: "2.1.260",
            date: "2026-09-04",
            method: "live-probe",
            artifact: ".capture/harness-playback",
            what: "Claude discovered a projected skill, started projected stdio/HTTP/SSE MCP servers with root/data variables, and executed merged Hooknostic hooks.",
          },
          {
            version: "2.1.260",
            date: "2026-09-05",
            method: "live-probe",
            artifact: ".capture/claude-marketplace-deps",
            what: "Marketplace installation copied a plugin with package.json/package-lock.json and installed its locked npm dependency in the cached plugin version.",
          },
          {
            version: "2.1.260",
            date: "2026-09-04",
            method: "doc-derived",
            artifact: "docs/baseline-2026-08-20.md",
            what: "Claude documents HTTP and SSE MCP transports and plugin root/data variables.",
          },
          {
            version: "2.1.260",
            date: "2026-09-07",
            method: "live-probe",
            artifact: ".capture/claude-mcp-cwd",
            what: "Cross-directory MCP probe: Claude expanded plugin-root variables but ignored both relative and plugin-root-anchored native cwd; the subprocess inherited the project directory. A generated Node launcher then established the plugin subdirectory as the MCP cwd.",
          },
          {
            version: "2.1.260",
            date: "2026-09-07",
            method: "live-probe",
            artifact: ".capture/claude-plugin-author",
            what: "Native plugin validation rejects author objects with a missing or empty name; omitting author or supplying a non-empty name passes, including whitespace-only names.",
          },
        ],
        notes: ["https://code.claude.com/docs/en/plugins-reference (checked 2026-09-04)"],
      },
    },
  ],
  project: projectAgentPluginToClaude,
};
