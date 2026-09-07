import {
  validateNpmRuntimePackage,
  type AgentPluginIssue,
  type AgentPluginMcpServer,
  type AgentPluginPackage,
  type AgentPluginProjectionFile,
  type AgentPluginProjectionPlan,
  type AgentPluginProjector,
} from "@hooknostic/agent-plugin";
import type { TargetSpec } from "@hooknostic/core";

export const CLAUDE_AGENT_PLUGIN_NAMESPACE = "com.anthropic.claude-code";
const MANIFEST_PATH = ".claude-plugin/plugin.json";
const MCP_PATH = ".mcp.json";
const HOOKS_PATH = "hooks/hooks.json";

// Claude treats a `package.json`/`package-lock.json` pair at the plugin root as
// install input for its locked, script-free `npm ci` (ADR-0012), so only the
// explicitly configured and validated `runtimePackage` may materialize there.
// Both routes into the root — a plain package file and a Claude
// client-extension overlay file — are filtered against this. The comparison
// case-folds for the same reason inventory exclusions do: the package is
// inventoried on one filesystem and installed on others, so a `Package.json`
// that Linux distinguishes is npm's install input to a Windows or macOS
// consumer.
function isRootNpmManifestPath(path: string): boolean {
  const name = path.toLowerCase();
  return name === "package.json" || name === "package-lock.json";
}

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

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(file: AgentPluginProjectionFile | undefined, label: string): Record<string, unknown> {
  if (file === undefined) return {};
  const text = typeof file.contents === "string" ? file.contents : new TextDecoder().decode(file.contents);
  const value = JSON.parse(text) as unknown;
  if (!object(value)) throw new Error(`${label} must contain a JSON object`);
  return value;
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
  const validation = validateNpmRuntimePackage(manifest.contents, lockfile.contents);
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

function translateServer(server: AgentPluginMcpServer): Record<string, unknown> {
  if (server.type !== "stdio") {
    return {
      type: server.type === "streamable-http" ? "http" : server.type,
      url: server.url,
      ...(server.headers === undefined ? {} : { headers: server.headers }),
    };
  }
  const command = server.command.startsWith("./")
    ? `\${CLAUDE_PLUGIN_ROOT}/${server.command.slice(2)}`
    : replacePluginVariables(server.command);
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(server.env ?? {}).map(([key, value]) => [key, replacePluginVariables(value)]),
  );
  env["PLUGIN_ROOT"] = "${CLAUDE_PLUGIN_ROOT}";
  env["PLUGIN_DATA"] = "${CLAUDE_PLUGIN_DATA}";
  return {
    type: "stdio",
    command,
    ...(server.args === undefined
      ? {}
      : { args: server.args.map((argument) => replacePluginVariables(argument)) }),
    env,
    cwd: replacePluginVariables(server.cwd ?? "${PLUGIN_ROOT}"),
  };
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

function componentCounts(source: AgentPluginPackage) {
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
    const count = Object.values(source.mcp?.mcpServers ?? {}).filter((server) => server.type === type).length;
    if (count > 0) {
      counts[`agent-plugin.mcp.${type}`] = { discovered: count, emitted: count, skipped: 0 };
    }
  }
  const prefix = `${CLAUDE_AGENT_PLUGIN_NAMESPACE}/`;
  const extensionFiles = source.files.filter((file) => file.path.startsWith(prefix));
  const manifestExtension =
    source.manifest.extensions?.[CLAUDE_AGENT_PLUGIN_NAMESPACE] === undefined ? 0 : 1;
  const skipped = extensionFiles.filter((file) => isRootNpmManifestPath(file.path.slice(prefix.length))).length;
  const discovered = extensionFiles.length + manifestExtension;
  if (discovered > 0) {
    counts["agent-plugin.client-extension.files"] = {
      discovered,
      emitted: extensionFiles.length - skipped + manifestExtension,
      skipped,
    };
  }
  return counts;
}

export async function projectAgentPluginToClaude(
  source: AgentPluginPackage,
  context: Parameters<AgentPluginProjector<TargetSpec>["project"]>[1],
): Promise<AgentPluginProjectionPlan> {
  const issues: AgentPluginIssue[] = [];
  const omissions: AgentPluginProjectionPlan["summary"]["omissions"] = [];
  const files = new Map<string, AgentPluginProjectionFile>();
  const copiedPaths = new Set<string>();
  const acceptedSkills = new Set(source.skills.map((skill) => skill.directory));
  let runtimePackage: ReturnType<typeof runtimePackageFiles>;

  try {
    runtimePackage = runtimePackageFiles(source, context);
  } catch (error) {
    return {
      files: [],
      issues: [{ severity: "error", scope: "file", component: "agent-plugin.runtime-package", message: error instanceof Error ? error.message : String(error) }],
      summary: {
        components: {
          ...componentCounts(source),
          "agent-plugin.runtime-package": { discovered: 1, emitted: 0, skipped: 1 },
        },
        omissions: [],
        copiedFileCount: 0,
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
    ) continue;
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
    const skillMatch = /^skills\/([^/]+)(?:\/|$)/.exec(file.path);
    if (skillMatch && !acceptedSkills.has(`skills/${skillMatch[1]}`)) continue;
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
      const reason = `Claude would install a plugin-root ${path} without the validation agentPlugin.runtimePackage inputs receive; declare npm dependencies with runtimePackage instead`;
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

  try {
    if (runtimePackage !== undefined) {
      files.set("package.json", runtimePackage.manifest);
      files.set("package-lock.json", runtimePackage.lockfile);
    }
    const extensionManifest = parseObject(files.get(MANIFEST_PATH), "Claude plugin manifest");
    const manifestExtension = source.manifest.extensions?.[CLAUDE_AGENT_PLUGIN_NAMESPACE] ?? {};
    const manifest = {
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
    files.set(MANIFEST_PATH, { path: MANIFEST_PATH, contents: stringify(manifest) });
    copiedPaths.delete(MANIFEST_PATH);

    const extensionMcp = parseObject(files.get(MCP_PATH), "Claude MCP configuration");
    const extensionServers = extensionMcp["mcpServers"];
    if (extensionServers !== undefined && !object(extensionServers)) {
      throw new Error("Claude MCP configuration mcpServers must be an object");
    }
    const translated = Object.fromEntries(
      Object.entries(source.mcp?.mcpServers ?? {}).map(([name, server]) => [name, translateServer(server)]),
    );
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
    issues,
    summary: {
      components: {
        ...componentCounts(source),
        ...(runtimePackage === undefined
          ? {}
          : { "agent-plugin.runtime-package": { discovered: 1, emitted: 1, skipped: 0 } }),
      },
      omissions,
      copiedFileCount: [...copiedPaths].filter((path) => files.has(path)).length,
    },
  };
}

export const claudeAgentPluginProjector: AgentPluginProjector<TargetSpec> = {
  namespace: CLAUDE_AGENT_PLUGIN_NAMESPACE,
  profiles: [
    {
      range: ">=2.1 <3",
      components: {
        "agent-plugin.manifest": { level: "exact" },
        "agent-plugin.skills": { level: "exact" },
        "agent-plugin.mcp.stdio": { level: "exact" },
        "agent-plugin.mcp.streamable-http": { level: "exact" },
        "agent-plugin.mcp.sse": { level: "exact" },
        "agent-plugin.client-extension.files": { level: "exact" },
        "agent-plugin.runtime-package": { level: "exact" },
      },
      source: {
        date: "2026-09-04",
        validatedOn: [
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
            method: "captured",
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
        ],
        notes: ["https://code.claude.com/docs/en/plugins-reference (checked 2026-09-04)"],
      },
    },
  ],
  project: projectAgentPluginToClaude,
};
