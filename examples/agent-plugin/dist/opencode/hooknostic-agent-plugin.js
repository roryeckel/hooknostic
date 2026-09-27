import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "package");
const launcher = join(here, "hooknostic-runtime", "mcp-launcher.mjs");
const servers = JSON.parse("{\"greeter\":{\"type\":\"local\",\"command\":[\"node\",\"__HOOKNOSTIC_LAUNCHER__\",\"0\"],\"cwd\":\"__HOOKNOSTIC_PLUGIN_ROOT__\",\"enabled\":true}}");
const skills = [{"name":"greet","description":"Greet the user by name and summarize the repo state.","directory":"skills/greet","manifestPath":"skills/greet/SKILL.md","id":"combined-example/greet"}];
const nativeServer = (server) => {
  const { enabled, timeout, ...rest } = server;
  return { ...rest, ...(enabled === undefined ? {} : { disabled: !enabled }),
    ...(timeout === undefined ? {} : { timeout: { startup: timeout } }) };
};
const resolve = value => value.split("__HOOKNOSTIC_LAUNCHER__").join(launcher).split("__HOOKNOSTIC_PLUGIN_ROOT__").join(root);
export default { id: "hooknostic.components.combined-example", async setup(ctx) {
  if (Object.keys(servers).length) await ctx.mcp.transform(editor => {
    for (const [name, server] of Object.entries(servers)) editor.set(name, nativeServer(server.type === "local" ? {
      ...server, command: server.command.map(resolve), cwd: resolve(server.cwd),
    } : server));
  });
  const values = skills.map(skill => ({ id: skill.id, name: skill.name, description: skill.description,
    path: join(root, skill.manifestPath),
    content: readFileSync(join(root, skill.manifestPath), "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ""),
  }));
  if (values.length) await ctx.skill.transform(editor => { for (const skill of values) editor.add(skill); });
} };
