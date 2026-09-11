/** Locate the nearest owned integration without relying on the harness session cwd. */
export function projectMcpBootstrap(output: string, config: string, index: number): string[] {
  for (const path of [output, config]) {
    if (!path || path.includes("\\") || path.startsWith("/") || path.includes(":") || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("invalid project MCP bootstrap path");
  }
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("invalid project MCP server index");
  const code = `import { readFileSync, realpathSync, lstatSync } from "node:fs";
import { dirname, join, relative, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const fail = message => { throw new Error("hooknostic project MCP: " + message); };
let root = realpathSync(process.cwd());
let manifest;
while (true) {
  try {
    const state = join(root, ".hooknostic/integration.json");
    if (lstatSync(join(root, ".hooknostic")).isSymbolicLink() || lstatSync(state).isSymbolicLink()) fail("symlinked ownership state");
    manifest = JSON.parse(readFileSync(state, "utf8"));
    break;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const parent = dirname(root);
  if (parent === root) fail("no owned integration above invocation directory");
  root = parent;
}
if (manifest.schemaVersion !== 1 || manifest.config !== ${JSON.stringify(config)} || !Array.isArray(manifest.owned)) fail("nearest integration belongs to another configuration");
function ownedFile(path) {
  let cursor = root;
  for (const part of path.split("/")) {
    cursor = join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) fail("symlinked generated path: " + path);
  }
  const destination = realpathSync(cursor);
  const rel = relative(root, destination);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) fail("generated path escapes project");
  const entries = manifest.owned.filter(entry => entry.path === path && entry.key === undefined);
  const hash = createHash("sha256").update(readFileSync(destination)).digest("hex");
  if (entries.length !== 1 || entries[0].hash !== hash) fail("missing or modified owned file: " + path);
  return destination;
}
const launcher = ownedFile(${JSON.stringify(`${output}/mcp-launcher.mjs`)});
ownedFile(${JSON.stringify(`${output}/mcp-servers.json`)});
process.argv = [process.execPath, launcher, ${JSON.stringify(String(index))}];
await import(pathToFileURL(launcher).href);`;
  return ["--input-type=module", "--eval", code];
}
