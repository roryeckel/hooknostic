import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_DATA_PLACEHOLDER, PLUGIN_ROOT_PLACEHOLDER } from "@hooknostic/agent-plugin";
import { build } from "esbuild";
import { createRequireBanner, licenseNoticesPlugin } from "./bundle-support.mjs";

export const MCP_LAUNCHER_FILE = "mcp-launcher.mjs";
export const MCP_SERVERS_FILE = "mcp-servers.json";

/** One projected stdio server, carrying its portable placeholder text verbatim. */
export interface McpLauncherServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * The generated servers document, read by the self-resolving front end.
 *
 * `servers` is an array rather than a map because the launcher selects by
 * position: the projector writes the array and emits its index, so there is one
 * enumeration and no second view to drift from it. A map would reintroduce that
 * drift -- `load.ts` filters invalid servers out of `mcp.json` before a
 * projector sees it, so positions in the source document and in the projection
 * do not agree, and a mismatch launches one server under another's declaration.
 */
export interface McpLauncherDocument {
  plugin: string;
  servers: McpLauncherServer[];
}

export type McpLauncherFrontEnd = "client-expanded" | "self-resolving";

export interface McpLauncherOptions {
  frontEnd: McpLauncherFrontEnd;
  /** Path from the launcher's own directory to the plugin root. Self-resolving only. */
  rootOffset?: string;
  dataOffset?: string;
  /** Names the data directory, so it survives a version-scoped reinstall. Self-resolving only. */
  pluginName?: string;
}

/**
 * Spawn, Windows shim escaping, signal forwarding and exit propagation.
 *
 * The `.cmd`/`.bat` double-escape is load-bearing and was measured, not
 * reasoned: `cross-spawn` applies it only to shims under `node_modules/.bin`.
 */
const LAUNCHER_CORE = `import spawn from "cross-spawn";
import { spawn as nativeSpawn } from "node:child_process";
import { normalize } from "node:path";
import escape from "cross-spawn/lib/util/escape.js";
function run({ cwd, command, args, env }) {
  const options = env === undefined ? { cwd, stdio: "inherit" } : { cwd, stdio: "inherit", env };
  const parsed = spawn._parse(command, args, options);
  // npm's global shims also forward %*. cross-spawn only double-escapes shims
  // under node_modules/.bin; apply that protection to other batch files too.
  if (process.platform === "win32" && /\\.(cmd|bat)$/i.test(parsed.file ?? "")) {
    const line = [escape.command(normalize(parsed.file)), ...args.map(arg => escape.argument(arg, true))].join(" ");
    parsed.args = ["/d", "/s", "/c", '"' + line + '"'];
  }
  const child = nativeSpawn(parsed.command, parsed.args, parsed.options);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    } else process.exitCode = code ?? 1;
  });
}
`;

/**
 * Claude expands both variables and binds them itself, so the front end only
 * has to supply the working directory Claude documents and ignores.
 */
const CLIENT_EXPANDED_FRONT_END = `const [cwd, command, ...args] = process.argv.slice(2);
run({ cwd, command, args });
`;

/**
 * Codex and OpenCode implement none of the placeholder contract, so this front
 * end implements it for them: it resolves the plugin root from its own
 * location, supplies a data directory, and expands before spawning.
 */
function selfResolvingFrontEnd(rootOffset: string, pluginName: string, dataOffset?: string): string {
  return `import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_TOKEN = ${JSON.stringify(PLUGIN_ROOT_PLACEHOLDER)};
const DATA_TOKEN = ${JSON.stringify(PLUGIN_DATA_PLACEHOLDER)};
const ROOT_OFFSET = ${JSON.stringify(rootOffset)};
const PLUGIN_NAME = ${JSON.stringify(pluginName)};
const DOCUMENT = ${JSON.stringify(MCP_SERVERS_FILE)};

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, ROOT_OFFSET);

function fail(message) {
  console.error("hooknostic mcp-launcher: " + message);
  process.exit(1);
}

// realpath so a symlinked or differently-cased install path still compares
// equal; a path that does not resolve falls back to lexical normalization.
function canonical(value) {
  try {
    return realpathSync.native(value);
  } catch {
    return resolve(value);
  }
}

// Defer to a client that already implements the contract. Its directory is
// genuinely client-managed and survives updates, so re-deriving our own would
// point the server elsewhere and strand what it had written. The root must
// match: an unrelated PLUGIN_ROOT in the ambient environment is not this
// plugin's, and at most one installed plugin can resolve to this root.
function inheritedPluginData() {
  const root = process.env.PLUGIN_ROOT;
  const data = process.env.PLUGIN_DATA;
  if (!root || !data || !isAbsolute(data)) return undefined;
  return canonical(root) === canonical(pluginRoot) ? data : undefined;
}

const inherited = inheritedPluginData();
const pluginData = ${dataOffset === undefined ? 'inherited ?? join(homedir(), ".hooknostic", "plugin-data", PLUGIN_NAME)' : `resolve(here, ${JSON.stringify(dataOffset)})`};
if (inherited === undefined) {
  try {
    mkdirSync(pluginData, { recursive: true });
  } catch (error) {
    fail("could not create the plugin data directory " + pluginData + ": " + error.message);
  }
}

const documentPath = join(here, DOCUMENT);
let document;
try {
  document = JSON.parse(readFileSync(documentPath, "utf8"));
} catch (error) {
  fail("could not read " + documentPath + ": " + error.message);
}
if (document === null || typeof document !== "object" || !Array.isArray(document.servers)) {
  fail(documentPath + " declares no servers array");
}
const index = Number(process.argv[2]);
const entry = Number.isInteger(index) ? document.servers[index] : undefined;
if (entry === null || typeof entry !== "object") {
  fail("no server at index " + JSON.stringify(process.argv[2]) + " in " + documentPath);
}
if (typeof entry.command !== "string") {
  fail("server at index " + index + " in " + documentPath + " declares no command");
}

const expand = (value) => value.split(ROOT_TOKEN).join(pluginRoot).split(DATA_TOKEN).join(pluginData);

const cwd =
  entry.cwd === undefined
    ? pluginRoot
    : entry.cwd.startsWith("./")
      ? resolve(pluginRoot, entry.cwd)
      : resolve(expand(entry.cwd));
// The specification excludes \`command\` from expansion and resolves a
// plugin-relative one against the plugin ROOT -- not against cwd, which may be
// a subdirectory.
const command = entry.command.startsWith("./") ? resolve(pluginRoot, entry.command) : entry.command;
const args = (entry.args ?? []).map(expand);
// Values only: expansion "does not apply to env keys".
// Null-prototype: a declared key named __proto__ survives JSON.parse as an
// own property, but assigning it into an ordinary object reaches the
// inherited setter, and the variable would vanish from the spawned server.
const env = Object.assign(Object.create(null), process.env);
for (const [key, value] of Object.entries(entry.env ?? {})) env[key] = expand(value);
env.PLUGIN_ROOT = pluginRoot;
env.PLUGIN_DATA = pluginData;

// Created only inside PLUGIN_DATA, whose tree the client owns and which nothing
// has populated on a first run. A package-relative cwd is never created: that
// would mask a directory the package failed to ship.
const dataBase = resolve(pluginData);
if (cwd === dataBase || cwd.startsWith(dataBase + sep)) {
  try {
    mkdirSync(cwd, { recursive: true });
  } catch (error) {
    fail("could not create the working directory " + cwd + ": " + error.message);
  }
}

run({ cwd, command, args, env });
`;
}

/**
 * Bundle the generated launcher.
 *
 * `cross-spawn` is resolved from this package (or, once published, from the
 * installed CLI that inlines it) rather than from the plugin author's
 * dependencies, and OS selection stays in the generated runtime so a package
 * built on Linux still handles Windows PATH/PATHEXT and `.cmd` shims.
 */
export async function bundleMcpLauncher(options: McpLauncherOptions): Promise<string> {
  const contents =
    LAUNCHER_CORE +
    (options.frontEnd === "client-expanded"
      ? CLIENT_EXPANDED_FRONT_END
      : selfResolvingFrontEnd(options.rootOffset ?? "..", options.pluginName ?? "", options.dataOffset));
  const entry = createRequire(import.meta.url).resolve("cross-spawn");
  const result = await build({
    stdin: { contents, resolveDir: dirname(entry) },
    absWorkingDir: dirname(entry),
    outfile: "hooknostic-mcp-launcher.mjs",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // Strip host-specific module-path comments for reproducible output.
    minify: true,
    write: false,
    legalComments: "eof",
    plugins: [licenseNoticesPlugin({ additionalSources: [fileURLToPath(import.meta.url)] })],
    banner: { js: createRequireBanner },
  });
  return result.outputFiles[0]!.text;
}
