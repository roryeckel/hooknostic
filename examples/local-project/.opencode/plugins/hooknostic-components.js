import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const declarations = JSON.parse("[[\"sample\",{\"type\":\"local\",\"command\":[\"node\",\"__HOOKNOSTIC_LAUNCHER__\",\"0\"],\"cwd\":\"__HOOKNOSTIC_PLUGIN_ROOT__\",\"enabled\":true}]]");
export default async () => ({ config(config) {
  const paths = ["skills"].map(path => resolve(root, path));
  if (paths.length) config.skills = { ...(config.skills ?? {}), paths: [...new Set([...(config.skills?.paths ?? []), ...paths])] };
  const mcp = { ...(config.mcp ?? {}) };
  for (const [name, server] of declarations) {
    if (Object.hasOwn(mcp, name)) throw new Error("Hooknostic MCP collision: " + name);
    const value = server.type === "local" ? { ...server,
      command: server.command.map(arg => arg === "__HOOKNOSTIC_LAUNCHER__" ? resolve(root, ".hooknostic/artifacts/opencode/mcp-launcher.mjs") : arg),
      cwd: server.cwd === "__HOOKNOSTIC_PLUGIN_ROOT__" ? resolve(root, ".") : server.cwd,
    } : server;
    Object.defineProperty(mcp, name, { value, enumerable: true, configurable: true, writable: true });
  }
  config.mcp = mcp;
} });
