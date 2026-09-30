import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { validateHeaderName, validateHeaderValue } from "node:http";
import { isIP } from "node:net";
import { basename, dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";

import { minimatch } from "minimatch";

import { type AgentDefinition, loadAgentDefinitions } from "./agent-definitions.js";
import { parseMarkdownFrontmatter } from "./frontmatter.js";
import { isAgentSkillName } from "./names.js";
import {
  AGENT_PLUGIN_MANIFEST_SCHEMA,
  AGENT_PLUGIN_MCP_SCHEMA,
  type AgentPluginFile,
  type AgentPluginIssue,
  type AgentPluginManifest,
  type AgentPluginMcpConfig,
  type AgentPluginMcpServer,
  type AgentPluginPackage,
  type AgentPluginSkill,
  type LoadAgentPluginOptions,
  type LoadAgentPluginResult,
} from "./types.js";

const MANIFEST_KEYS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);
const AUTHOR_KEYS = new Set(["name", "email", "url"]);
const SKILL_KEYS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
const PLUGIN_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

// Its own module so the agent definition loader can share the grammar without an import cycle.
export { isAgentSkillName };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(
  issues: AgentPluginIssue[],
  severity: AgentPluginIssue["severity"],
  scope: AgentPluginIssue["scope"],
  message: string,
  path?: string,
): void {
  issues.push({ severity, scope, message, ...(path === undefined ? {} : { path }) });
}

function json(file: AgentPluginFile): unknown {
  return JSON.parse(new TextDecoder().decode(file.contents)) as unknown;
}

function validOptionalString(manifest: Record<string, unknown>, key: string): boolean {
  return manifest[key] === undefined || typeof manifest[key] === "string";
}

function validateManifest(value: unknown, issues: AgentPluginIssue[]): AgentPluginManifest | undefined {
  if (!object(value)) {
    issue(issues, "error", "manifest", "plugin.json must contain a JSON object.", "plugin.json");
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!MANIFEST_KEYS.has(key)) {
      issue(
        issues,
        "info",
        "manifest",
        `unknown top-level field ${JSON.stringify(key)} is ignored by Agent Plugins 1.0.`,
        "plugin.json",
      );
    }
  }
  if (value["$schema"] !== AGENT_PLUGIN_MANIFEST_SCHEMA) {
    issue(issues, "error", "manifest", `plugin.json must target ${AGENT_PLUGIN_MANIFEST_SCHEMA}.`, "plugin.json");
    return undefined;
  }
  if (typeof value["name"] !== "string" || value["name"].length > 64 || !PLUGIN_NAME.test(value["name"])) {
    issue(issues, "error", "manifest", "plugin.json has an invalid Agent Plugins name.", "plugin.json");
    return undefined;
  }
  for (const key of ["version", "description", "homepage", "repository", "license"]) {
    if (!validOptionalString(value, key)) {
      issue(issues, "error", "manifest", `plugin.json field ${key} must be a string.`, "plugin.json");
      return undefined;
    }
  }
  if (
    value["keywords"] !== undefined &&
    (!Array.isArray(value["keywords"]) || value["keywords"].some((item) => typeof item !== "string"))
  ) {
    issue(issues, "error", "manifest", "plugin.json keywords must be an array of strings.", "plugin.json");
    return undefined;
  }
  if (value["author"] !== undefined) {
    if (!object(value["author"])) {
      issue(issues, "error", "manifest", "plugin.json author must be an object.", "plugin.json");
      return undefined;
    }
    for (const [key, authorValue] of Object.entries(value["author"])) {
      if (!AUTHOR_KEYS.has(key) || typeof authorValue !== "string") {
        issue(issues, "error", "manifest", "plugin.json author contains an invalid field.", "plugin.json");
        return undefined;
      }
    }
  }
  let extensions: Record<string, Record<string, unknown>> | undefined;
  if (value["extensions"] !== undefined) {
    if (!object(value["extensions"])) {
      issue(issues, "warn", "manifest", "plugin.json extensions is not an object and was ignored.", "plugin.json");
    } else {
      const valid: Record<string, Record<string, unknown>> = {};
      for (const [namespace, extension] of Object.entries(value["extensions"])) {
        if (!object(extension)) {
          issue(
            issues,
            "warn",
            "manifest",
            `extension ${JSON.stringify(namespace)} is not an object and was ignored.`,
            "plugin.json",
          );
        } else {
          valid[namespace] = extension;
        }
      }
      extensions = valid;
    }
  }
  const manifest: AgentPluginManifest = {
    $schema: AGENT_PLUGIN_MANIFEST_SCHEMA,
    name: value["name"],
  };
  for (const key of ["version", "description", "homepage", "repository", "license"] as const) {
    const field = value[key];
    if (typeof field === "string") manifest[key] = field;
  }
  if (object(value["author"])) manifest.author = value["author"];
  if (Array.isArray(value["keywords"])) manifest.keywords = value["keywords"] as string[];
  if (extensions !== undefined) manifest.extensions = extensions;
  return manifest;
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function containedPortablePath(root: string, value: string, prefix: "./" | "${PLUGIN_ROOT}"): boolean {
  const suffix = prefix === "./" ? value.slice(2) : value.slice(prefix.length).replace(/^\//, "");
  return contained(root, resolve(root, suffix));
}

async function canonicalCandidate(path: string): Promise<string> {
  let cursor = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      return resolve(await realpath(cursor), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

async function validateDirectMcpPaths(
  config: AgentPluginMcpConfig,
  root: string,
  issues: AgentPluginIssue[],
  projectRoot?: string,
): Promise<void> {
  const canonicalSource = await canonicalCandidate(root);
  const canonicalAllowed = projectRoot === undefined ? canonicalSource : await canonicalCandidate(projectRoot);
  for (const [name, server] of Object.entries(config.mcpServers)) {
    if (server.type !== "stdio") continue;
    let valid = contained(canonicalAllowed, canonicalSource);
    if (valid && server.command.startsWith("./")) {
      valid = contained(canonicalSource, await canonicalCandidate(resolve(root, server.command.slice(2))));
    }
    if (
      valid &&
      server.cwd !== undefined &&
      server.cwd !== "${PLUGIN_DATA}" &&
      !server.cwd.startsWith("${PLUGIN_DATA}/")
    ) {
      const suffix = server.cwd.startsWith("./")
        ? server.cwd.slice(2)
        : server.cwd.slice("${PLUGIN_ROOT}".length).replace(/^\//, "");
      valid = contained(canonicalAllowed, await canonicalCandidate(resolve(root, suffix)));
    }
    if (valid) continue;
    issue(
      issues,
      "warn",
      "mcp",
      `MCP stdio server ${JSON.stringify(name)} is invalid and was skipped.`,
      `mcp.json#/mcpServers/${name}`,
    );
    delete config.mcpServers[name];
  }
}

/**
 * A `./` command must name a file the package ships, with the executable bit.
 *
 * Both halves are invisible today. Containment is checked lexically by
 * `containedPortablePath`, so a command naming no file at all validates and
 * projects happily, then fails at spawn on the consumer's machine; and
 * inventory assigns 0644 to everything except the paths
 * `components.executableFiles` names (ADR-0013), so a server that *is* its own
 * binary or script ships unable to run.
 *
 * A server whose command is a bare executable name reaches neither check,
 * because its entry travels as an argument and an argument needs no permission.
 * That asymmetry is the reason this exists: it is the one command shape where
 * the package itself must supply an executable file.
 *
 * Host permissions are deliberately not consulted. ADR-0013 makes the
 * declaration the source of truth, and a package built on Windows -- where the
 * bit has no meaning -- must still be refused rather than ship an artifact whose
 * behaviour depends on where it was built.
 */
export function validateContainedCommands(
  config: AgentPluginMcpConfig,
  files: readonly AgentPluginFile[],
  options: {
    deferredRoots?: readonly string[];
    materializedPaths?: ReadonlySet<string>;
  } = {},
): AgentPluginIssue[] {
  const issues: AgentPluginIssue[] = [];
  for (const [name, server] of Object.entries(config.mcpServers)) {
    if (server.type !== "stdio" || !server.command.startsWith("./")) continue;
    // Validation above already proves containment and excludes backslashes;
    // normalize with POSIX semantics so the lookup is deterministic on every
    // build host and spellings such as ./bin/../server name the shipped file.
    const path = posix.normalize(server.command.slice(2));
    const file = files.find((candidate) => candidate.path === path);
    if (file === undefined && (options.deferredRoots ?? []).some((root) => path.startsWith(`${root}/`))) {
      continue;
    }
    const problem =
      file === undefined
        ? "which the package does not contain"
        : (file.mode & 0o111) === 0
          ? options.materializedPaths?.has(path)
            ? "which is not executable -- return it with mode 0755 from the materializer postprocess hook"
            : `which is not executable -- add ${JSON.stringify(path)} to components.executableFiles`
          : undefined;
    if (problem === undefined) continue;
    issue(
      issues,
      "warn",
      "mcp",
      `MCP stdio server ${JSON.stringify(name)} runs ${JSON.stringify(server.command)}, ${problem}. It was skipped.`,
      `mcp.json#/mcpServers/${name}`,
    );
    delete config.mcpServers[name];
  }
  return issues;
}

function validHeaders(value: unknown): value is Record<string, string> {
  if (value === undefined) return true;
  if (!object(value)) return false;
  const seen = new Set<string>();
  try {
    for (const [name, headerValue] of Object.entries(value)) {
      if (typeof headerValue !== "string" || seen.has(name.toLowerCase())) return false;
      validateHeaderName(name);
      validateHeaderValue(name, headerValue);
      seen.add(name.toLowerCase());
    }
    return true;
  } catch {
    return false;
  }
}

function loopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost") return true;
  const family = isIP(host);
  if (family === 4) return host.startsWith("127.");
  return family === 6 && host === "::1";
}

function validRemoteUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.hash) return false;
    if (parsed.protocol === "https:") return true;
    return parsed.protocol === "http:" && loopback(parsed.hostname);
  } catch {
    return false;
  }
}

function validateServer(
  root: string,
  name: string,
  value: unknown,
  issues: AgentPluginIssue[],
  origin: "package" | "direct",
  projectRoot?: string,
): AgentPluginMcpServer | undefined {
  const path = `mcp.json#/mcpServers/${name}`;
  if (!object(value) || typeof value["type"] !== "string") {
    issue(
      issues,
      "warn",
      "mcp",
      `MCP server ${JSON.stringify(name)} is not a valid server object and was skipped.`,
      path,
    );
    return undefined;
  }
  if (value["type"] === "stdio") {
    const allowed = new Set(["type", "command", "args", "env", "cwd"]);
    const command = value["command"];
    const args = value["args"];
    const env = value["env"];
    const cwd = value["cwd"];
    const commandValid =
      typeof command === "string" &&
      command.length > 0 &&
      // The schema admits any command, and the specification excludes it from
      // expansion, so in a package `${NAME}` is literal text and is carried
      // as such (a harness that expands it reports a deviation, ADR-0019). A
      // direct source expands references everywhere else and not here, so it
      // is refused there rather than launched as a literal the author did not mean.
      (origin === "package" || !command.includes("${")) &&
      (command.startsWith("./")
        ? command.length > 2 && containedPortablePath(root, command, "./")
        : !command.includes("/") && !command.includes("\\"));
    const argsValid = args === undefined || (Array.isArray(args) && args.every((item) => typeof item === "string"));
    const envValid =
      env === undefined ||
      (object(env) &&
        Object.entries(env).every(
          ([key, item]) => key !== "PLUGIN_ROOT" && key !== "PLUGIN_DATA" && typeof item === "string",
        ));
    const cwdValid =
      cwd === undefined ||
      (typeof cwd === "string" &&
        ((cwd.startsWith("./") && containedPortablePath(root, cwd, "./")) ||
          ((cwd === "${PLUGIN_ROOT}" || cwd.startsWith("${PLUGIN_ROOT}/")) &&
            containedPortablePath(root, cwd, "${PLUGIN_ROOT}")) ||
          (projectRoot !== undefined &&
            ((cwd.startsWith("./") && contained(projectRoot, resolve(root, cwd.slice(2)))) ||
              ((cwd === "${PLUGIN_ROOT}" || cwd.startsWith("${PLUGIN_ROOT}/")) &&
                contained(projectRoot, resolve(root, cwd.slice("${PLUGIN_ROOT}".length).replace(/^\//, "")))))) ||
          cwd === "${PLUGIN_DATA}" ||
          (cwd.startsWith("${PLUGIN_DATA}/") && !cwd.slice("${PLUGIN_DATA}/".length).split("/").includes(".."))));
    if (Object.keys(value).some((key) => !allowed.has(key)) || !commandValid || !argsValid || !envValid || !cwdValid) {
      issue(issues, "warn", "mcp", `MCP stdio server ${JSON.stringify(name)} is invalid and was skipped.`, path);
      return undefined;
    }
    return {
      type: "stdio",
      command,
      ...(Array.isArray(args) ? { args: args as string[] } : {}),
      ...(object(env) ? { env: env as Record<string, string> } : {}),
      ...(typeof cwd === "string" ? { cwd } : {}),
    };
  }
  if (value["type"] === "streamable-http" || value["type"] === "sse") {
    const allowed = new Set(["type", "url", "headers"]);
    if (
      Object.keys(value).some((key) => !allowed.has(key)) ||
      !validRemoteUrl(value["url"]) ||
      !validHeaders(value["headers"])
    ) {
      issue(issues, "warn", "mcp", `MCP remote server ${JSON.stringify(name)} is invalid and was skipped.`, path);
      return undefined;
    }
    return {
      type: value["type"],
      url: value["url"],
      ...(object(value["headers"]) ? { headers: value["headers"] as Record<string, string> } : {}),
    };
  }
  issue(issues, "warn", "mcp", `MCP server ${JSON.stringify(name)} uses an unknown transport and was skipped.`, path);
  return undefined;
}

function loadMcp(
  root: string,
  inventory: InventoryResult,
  issues: AgentPluginIssue[],
  origin: "package" | "direct",
  projectRoot?: string,
): AgentPluginMcpConfig | undefined {
  const file = inventory.files.find((candidate) => candidate.path === "mcp.json");
  if (file === undefined) {
    if (inventory.directories.has("mcp.json")) {
      issue(issues, "warn", "mcp", "mcp.json is not a regular file and MCP was disabled.", "mcp.json");
    }
    return undefined;
  }
  let value: unknown;
  try {
    value = json(file);
  } catch (error) {
    issue(
      issues,
      "warn",
      "mcp",
      `mcp.json could not be loaded and MCP was disabled: ${error instanceof Error ? error.message : String(error)}`,
      "mcp.json",
    );
    return undefined;
  }
  if (
    !object(value) ||
    Object.keys(value).some((key) => key !== "$schema" && key !== "mcpServers") ||
    value["$schema"] !== AGENT_PLUGIN_MCP_SCHEMA ||
    !object(value["mcpServers"])
  ) {
    issue(issues, "warn", "mcp", "mcp.json has an invalid top-level document and MCP was disabled.", "mcp.json");
    return undefined;
  }
  const serverEntries: [string, AgentPluginMcpServer][] = [];
  for (const [name, server] of Object.entries(value["mcpServers"])) {
    const valid = validateServer(root, name, server, issues, origin, projectRoot);
    if (valid !== undefined) serverEntries.push([name, valid]);
  }
  // Object.fromEntries defines own data properties, including `__proto__`.
  // Assignment to a normal object would invoke Object.prototype's inherited
  // setter and silently omit that schema-valid server name.
  const servers = Object.fromEntries(serverEntries) as Record<string, AgentPluginMcpServer>;
  return { $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: servers };
}

function extractFrontmatter(text: string): unknown {
  return parseMarkdownFrontmatter(text, "SKILL.md").data;
}

function validateSkillFrontmatter(
  value: unknown,
  directory: string,
  options: { allowAdditionalFields?: boolean } = {},
): { name: string; description: string } {
  if (!object(value)) throw new Error("frontmatter must be a mapping");
  if (!options.allowAdditionalFields && Object.keys(value).some((key) => !SKILL_KEYS.has(key))) {
    throw new Error("frontmatter contains an unknown field");
  }
  const name = value["name"];
  const description = value["description"];
  if (typeof name !== "string" || !isAgentSkillName(name) || name !== directory) {
    throw new Error("name must match its directory and satisfy the Agent Skills name rules");
  }
  if (typeof description !== "string" || description.length === 0 || description.length > 1024) {
    throw new Error("description must contain 1-1024 characters");
  }
  for (const key of ["license", "allowed-tools"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new Error(`${key} must be a string`);
    }
  }
  if (
    value["compatibility"] !== undefined &&
    (typeof value["compatibility"] !== "string" ||
      value["compatibility"].length === 0 ||
      value["compatibility"].length > 500)
  ) {
    throw new Error("compatibility must contain 1-500 characters");
  }
  if (
    value["metadata"] !== undefined &&
    (!object(value["metadata"]) || Object.values(value["metadata"]).some((item) => typeof item !== "string"))
  ) {
    throw new Error("metadata must be a map of string values");
  }
  return { name, description };
}

function loadSkills(
  inventory: InventoryResult,
  issues: AgentPluginIssue[],
  options: { allowAdditionalFields?: boolean } = {},
): AgentPluginSkill[] {
  if (!inventory.directories.has("skills")) {
    if (inventory.files.some((file) => file.path === "skills")) {
      issue(issues, "warn", "skill", "skills is not a directory and was ignored.", "skills");
    }
    return [];
  }
  const skills: AgentPluginSkill[] = [];
  for (const file of inventory.files) {
    const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(file.path);
    if (match === null) continue;
    const directory = match[1]!;
    try {
      const parsed = validateSkillFrontmatter(
        extractFrontmatter(new TextDecoder().decode(file.contents)),
        directory,
        options,
      );
      skills.push({ ...parsed, directory: `skills/${directory}`, manifestPath: file.path });
    } catch (error) {
      issue(
        issues,
        "warn",
        "skill",
        `skill ${JSON.stringify(directory)} is invalid and was skipped: ${error instanceof Error ? error.message : String(error)}`,
        file.path,
      );
    }
  }
  return skills;
}

// Exclusions match case-insensitively on every platform: the package is
// inventoried on one filesystem and installed on others, and a `.ENV` that
// Linux distinguishes from `.env` is the same file to a Windows or macOS
// consumer. A deny-list that over-matches fails safe.
const MATCH = { dot: true, nocase: true, nonegate: true, nocomment: true } as const;

function excluded(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => minimatch(path, pattern, MATCH) || minimatch(`${path}/`, pattern, MATCH));
}

interface InventoryResult {
  files: AgentPluginFile[];
  directories: Set<string>;
}

function excludedSkill(path: string, patterns: readonly string[]): boolean {
  return /^skills\/[^/]+$/.test(path) && excluded(`${path}/SKILL.md`, patterns);
}

async function inventory(
  root: string,
  patterns: readonly string[],
  issues: AgentPluginIssue[],
): Promise<InventoryResult | undefined> {
  const pending: { path: string; physical: string; mode: number }[] = [];
  const directories = new Set<string>();

  const walk = async (
    canonicalRoot: string,
    physical: string,
    logical: string,
    ancestors: ReadonlySet<string>,
  ): Promise<void> => {
    let resolved: string;
    try {
      resolved = await realpath(physical);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new Error(
        `${logical || "."} is a broken symbolic link. Remove it, or add it to components.exclude ` +
          `if it is machine-local state rather than package content.`,
      );
    }
    if (!contained(canonicalRoot, resolved)) {
      // Nearly always a machine-local tree that pins an absolute path: a
      // virtualenv's interpreter link, a toolchain cache. The default
      // exclusions cover the names we know, but they cannot know every
      // ecosystem's, so the remedy is named rather than left to be guessed --
      // the other reading of this message ("my package is malformed") is wrong.
      throw new Error(
        `${logical || "."} resolves outside the Agent Plugin root. Add it to components.exclude ` +
          `if it is machine-local state rather than package content.`,
      );
    }
    // Exclusions were matched on the logical name before descending; a link
    // whose target is excluded (`notes.txt -> .env`, `lib -> node_modules/x`)
    // must not smuggle that content in under another name.
    if (logical !== "") {
      const canonicalLogical = relative(canonicalRoot, resolved).replaceAll("\\", "/");
      if (canonicalLogical !== logical && excluded(canonicalLogical, patterns)) {
        throw new Error(`${logical} resolves to excluded path ${canonicalLogical}`);
      }
    }
    const metadata = await stat(physical);
    if (metadata.isDirectory()) {
      if (ancestors.has(resolved)) throw new Error(`symbolic-link cycle at ${logical || "."}`);
      directories.add(logical);
      const next = new Set(ancestors);
      next.add(resolved);
      const entries = await readdir(physical, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const childLogical = logical ? `${logical}/${entry.name}` : entry.name;
        if (excluded(childLogical, patterns) || excludedSkill(childLogical, patterns)) continue;
        await walk(canonicalRoot, resolve(physical, entry.name), childLogical, next);
      }
      return;
    }
    if (!metadata.isFile()) throw new Error(`${logical} is not a regular file or directory`);
    pending.push({ path: logical, physical: resolved, mode: 0o644 });
  };

  try {
    const canonicalRoot = await realpath(root);
    await walk(canonicalRoot, root, "", new Set());
    const files: AgentPluginFile[] = [];
    for (const file of pending) {
      files.push({ path: file.path, contents: await readFile(file.physical), mode: file.mode });
    }
    return { files, directories };
  } catch (error) {
    issue(
      issues,
      "error",
      "file",
      `could not inventory the Agent Plugin package: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function digest(files: readonly AgentPluginFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.mode.toString(8));
    hash.update("\0");
    hash.update(file.contents);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Names never inventoried, at any depth: version control, installed
 * dependencies, and environment/registry secrets. A package that ships
 * `node_modules` or `.env` is never what an author meant to distribute.
 */
export const AGENT_PLUGIN_DEFAULT_EXCLUDED_NAMES = [
  ".git",
  ".hooknostic",
  "node_modules",
  ".env",
  ".env.*",
  ".npmrc",
] as const;

const DEFAULT_EXCLUDES = AGENT_PLUGIN_DEFAULT_EXCLUDED_NAMES.flatMap((name) => [
  name,
  `${name}/**`,
  `**/${name}`,
  `**/${name}/**`,
]);

/**
 * Apply ADR-0013's declared modes to an inventoried file set.
 *
 * `lookup` is a parameter because the two component routes spell a path
 * against different roots -- a package's are relative to the package root, a
 * project's to the skill the file lands in. The *validation* must not vary
 * with the route: ADR-0013's guarantee is that one declaration yields one set
 * of modes on every host, and two spellings of "valid path" would be two
 * contracts wearing one name.
 */
function applyExecutableFiles(
  paths: readonly string[] | undefined,
  lookup: (path: string) => AgentPluginFile | undefined,
  issues: AgentPluginIssue[],
): boolean {
  for (const path of paths ?? []) {
    const file = lookup(path);
    if (
      typeof path !== "string" ||
      /[\\:]/.test(path) ||
      [...path].some((character) => character.charCodeAt(0) < 32) ||
      path.split("/").some((part) => part === "" || part === "." || part === "..") ||
      file === undefined
    ) {
      issue(
        issues,
        "error",
        "file",
        `executableFiles entry ${JSON.stringify(path)} must be an exact, case-sensitive POSIX path to an included file.`,
      );
      return false;
    }
    file.mode = 0o755;
  }
  return true;
}

/** Load an Agent Plugins 1.0 package without consulting network schemas. */
export async function loadAgentPlugin(options: LoadAgentPluginOptions): Promise<LoadAgentPluginResult> {
  const root = resolve(options.root);
  const issues: AgentPluginIssue[] = [];
  const patterns = [...DEFAULT_EXCLUDES, ...(options.exclude ?? [])];
  if (excluded("plugin.json", patterns)) {
    issue(
      issues,
      "error",
      "manifest",
      "plugin.json is mandatory and cannot be excluded from an Agent Plugin package.",
      "plugin.json",
    );
    return { issues };
  }

  const inventoried = await inventory(root, patterns, issues);
  if (inventoried === undefined) return { issues };
  if (!applyExecutableFiles(options.executableFiles, (path) => inventoried.files.find((e) => e.path === path), issues))
    return { issues };
  const manifestFile = inventoried.files.find((file) => file.path === "plugin.json");
  if (manifestFile === undefined) {
    issue(
      issues,
      "error",
      "manifest",
      "could not read plugin.json: file is missing or is not a regular file.",
      "plugin.json",
    );
    return { issues };
  }
  let manifestValue: unknown;
  try {
    manifestValue = json(manifestFile);
  } catch (error) {
    issue(
      issues,
      "error",
      "manifest",
      `could not read plugin.json: ${error instanceof Error ? error.message : String(error)}`,
      "plugin.json",
    );
    return { issues };
  }
  const manifest = validateManifest(manifestValue, issues);
  if (manifest === undefined) return { issues };

  const skills = loadSkills(inventoried, issues);
  const mcp = loadMcp(root, inventoried, issues, "package");
  // Only the package route: the direct route hands `loadMcp` a synthetic
  // one-file inventory, and `validateDirectMcpPaths` already resolves its
  // commands against the real filesystem instead.
  if (mcp !== undefined) {
    issues.push(
      ...validateContainedCommands(mcp, inventoried.files, {
        ...(options.deferredCommandRoots === undefined ? {} : { deferredRoots: options.deferredCommandRoots }),
      }),
    );
  }
  const files = inventoried.files;
  const directories = [...inventoried.directories].filter((path) => path !== "").sort();
  const source: AgentPluginPackage = {
    specVersion: "1.0.0",
    root,
    manifest,
    skills,
    ...(mcp === undefined ? {} : { mcp }),
    files,
    directories,
    contentDigest: digest(files),
  };
  return { package: source, issues };
}

export interface ProjectSkill {
  name: string;
  source: string;
  files: AgentPluginFile[];
}
export interface ProjectComponents {
  origin: "package" | "direct";
  skills: ProjectSkill[];
  mcp?: { root: string; config: AgentPluginMcpConfig };
  /** Portable agent definitions (ADR-0028); absent when none are configured. */
  agents?: AgentDefinition[];
  /** The name of the definition sessions start as (`components.defaultAgent`), where this target takes it. */
  defaultAgent?: string;
}
export function packageComponents(source: AgentPluginPackage): ProjectComponents {
  return {
    origin: "package",
    skills: source.skills.map((skill) => ({
      name: skill.name,
      source: resolve(source.root, skill.directory),
      files: source.files
        .filter((f) => f.path.startsWith(skill.directory + "/"))
        .map((f) => ({ ...f, path: f.path.slice(skill.directory.length + 1) })),
    })),
    ...(source.mcp === undefined ? {} : { mcp: { root: source.root, config: source.mcp } }),
  };
}
export async function loadProjectComponents(options: {
  skills?: string[];
  mcp?: string;
  /** Directories of Hooknostic Agent Definition files (ADR-0028). */
  agents?: string[];
  exclude?: string[];
  executableFiles?: string[];
  projectRoot?: string;
}): Promise<{ source: ProjectComponents; issues: AgentPluginIssue[] }> {
  const issues: AgentPluginIssue[] = [];
  const source: ProjectComponents = { origin: "direct", skills: [] };
  if (options.agents !== undefined) {
    const loaded = await loadAgentDefinitions({
      directories: options.agents,
      ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    });
    issues.push(...loaded.issues);
    source.agents = loaded.agents;
  }
  const names = new Set<string>();
  for (const directory of options.skills ?? []) {
    const data = await inventory(resolve(directory), [...DEFAULT_EXCLUDES, ...(options.exclude ?? [])], issues);
    if (!data) continue;
    const nested: InventoryResult = {
      files: data.files.map((file) => ({ ...file, path: "skills/" + file.path })),
      directories: new Set(["skills", ...[...data.directories].filter(Boolean).map((path) => "skills/" + path)]),
    };
    // Direct project sources are delivered as their original files. Harnesses
    // may attach native frontmatter alongside the portable Agent Skills fields,
    // so validate the standard fields while preserving additional metadata.
    // Packaged components remain strict because their manifest promises the
    // portable package contract rather than a harness-owned local source tree.
    for (const skill of loadSkills(nested, issues, { allowAdditionalFields: true })) {
      if (names.has(skill.name)) {
        issue(issues, "error", "skill", `duplicate skill name ${skill.name}`);
        continue;
      }
      names.add(skill.name);
      source.skills.push({
        name: skill.name,
        source: resolve(directory, skill.directory.slice(7)),
        files: nested.files
          .filter((f) => f.path.startsWith(skill.directory + "/"))
          .map((f) => ({ ...f, path: f.path.slice(skill.directory.length + 1) })),
      });
    }
  }
  // Declared against `<skill>/<path>` -- where the file lands, not where it was
  // read from. The two cannot disagree: a skill's `name` must equal its own
  // directory (`validateSkillFrontmatter`), and the projector writes it to
  // `<destination>/<skill.name>`. Resolved after every listed directory is
  // loaded, so one declaration can name files across all of them, and so a
  // duplicate skill name is rejected first rather than silently deciding which
  // of two files an entry meant.
  applyExecutableFiles(
    options.executableFiles,
    (path) => {
      const separator = path.indexOf("/");
      if (separator <= 0) return undefined;
      const skill = source.skills.find((candidate) => candidate.name === path.slice(0, separator));
      return skill?.files.find((file) => file.path === path.slice(separator + 1));
    },
    issues,
  );
  if (options.mcp) {
    const requested = resolve(options.mcp);
    let direct: { path: string; contents: Buffer } | undefined;
    try {
      const path = await realpath(requested);
      if (DEFAULT_EXCLUDES.some((pattern) => minimatch(path.replaceAll("\\", "/"), pattern, MATCH))) {
        issue(issues, "error", "mcp", "MCP source is an excluded secret/configuration file", requested);
      } else direct = { path, contents: await readFile(path) };
    } catch (error) {
      issue(
        issues,
        "error",
        "mcp",
        `could not load direct MCP source ${JSON.stringify(requested)}: ${error instanceof Error ? error.message : String(error)}`,
        requested,
      );
    }
    if (direct) {
      const file = { path: "mcp.json", contents: direct.contents, mode: 0o644 };
      const root = resolve(direct.path, "..");
      const projectRoot = options.projectRoot === undefined ? undefined : await canonicalCandidate(options.projectRoot);
      const config = loadMcp(root, { files: [file], directories: new Set() }, issues, "direct", projectRoot);
      if (config) {
        await validateDirectMcpPaths(config, root, issues, options.projectRoot);
        source.mcp = { root, config };
      }
    }
  }
  return { source, issues };
}
