/* global process, console */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const declarations = JSON.parse("[[\"sample\",{\"type\":\"local\",\"command\":[\"node\",\"__HOOKNOSTIC_LAUNCHER__\",\"0\"],\"cwd\":\"__HOOKNOSTIC_PLUGIN_ROOT__\",\"enabled\":true}]]");

const expandEnvironment = (value, missing) => value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (reference, name) => {
  const resolved = process.env[name];
  if (resolved === undefined) { missing.add(name); return reference; }
  return resolved;
});
const resolveRemote = (name, server) => {
  const missing = new Set();
  const resolved = { ...server,
    url: expandEnvironment(server.url, missing),
    ...(server.headers === undefined ? {} : { headers: Object.fromEntries(Object.entries(server.headers).map(([header, value]) => [header, expandEnvironment(value, missing)])) }),
  };
  if (missing.size === 0) return resolved;
  console.warn("Hooknostic disabled MCP " + JSON.stringify(name) + ": missing environment " + [...missing].sort().join(", "));
  return { ...server, enabled: false };
};

export default async () => ({ config(config) {
  const mcp = { ...(config.mcp ?? {}) };
  for (const [name, server] of declarations) {
    const value = server.type === "local" ? { ...server,
      command: server.command.map(arg => arg === "__HOOKNOSTIC_LAUNCHER__" ? resolve(root, ".hooknostic/artifacts/opencode/mcp-launcher.mjs") : arg),
      cwd: server.cwd === "__HOOKNOSTIC_PLUGIN_ROOT__" ? resolve(root, ".") : server.cwd,
    } : resolveRemote(name, server);
    Object.defineProperty(mcp, name, { value, enumerable: true, configurable: true, writable: true });
  }
  config.mcp = mcp;
} });
