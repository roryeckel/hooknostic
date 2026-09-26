import type { AgentPluginPackage, AgentPluginProjectionProfile, AgentPluginProjector } from "@hooknostic/agent-plugin";
import type { HarnessAdapter, TargetSpec } from "@hooknostic/core";

import { projectComponents } from "../project.js";
import { createOpenCodeAgentPluginProjector, RUNTIME_LAUNCHER, RUNTIME_PLUGIN_ROOT } from "../project-agent-plugin.js";
import { opencodeV2Harness } from "./harness.js";

const conversion = `const nativeServer = (server) => {
  const { enabled, timeout, ...rest } = server;
  return { ...rest, ...(enabled === undefined ? {} : { disabled: !enabled }),
    ...(timeout === undefined ? {} : { timeout: { startup: timeout } }) };
};`;

export const opencodeV2ProjectProfiles: readonly AgentPluginProjectionProfile[] = [
  {
    range: opencodeV2Harness.recommendedRange,
    components: {
      "agent-plugin.skills": { level: "exact" },
      "agent-plugin.mcp.stdio": {
        level: "emulated",
        rationale:
          "A generated launcher resolves portable paths and environment; a v2 MCP transform registers the server.",
      },
      "agent-plugin.mcp.streamable-http": {
        level: "exact",
        rationale:
          "Loopback Streamable HTTP executes MCP tools with declared headers. Direct project environment references expand; package values remain literal. Default OAuth discovery, dynamic registration, PKCE and refresh are verified against a local issuer; provider-specific OAuth options are unverified.",
      },
      "agent-plugin.mcp.sse": {
        level: "unsupported",
        rationale:
          "A legacy SSE endpoint rejecting POST receives no GET fallback in the v2 capture and fails to connect.",
      },
      "agent-plugin.runtime-package": {
        level: "unsupported",
        rationale:
          "Generated integrations do not install dependency closures. Bundle or explicitly materialize dependencies.",
      },
      "agent-plugin.client-extension.files": {
        level: "unsupported",
        rationale: "No portable client-extension namespace is implemented for v2.",
      },
    },
    source: {
      date: "2026-09-26",
      validatedOn: [
        {
          version: opencodeV2Harness.referenceVersion,
          date: "2026-09-26",
          method: "live-probe",
          artifact: ".capture/opencode-v2-audit",
          what: "Generated project and packed relocated package reach needs_auth, discover a loopback OAuth issuer, dynamically register, complete validated S256 PKCE, refresh after an expired-token rejection and execute an MCP tool with the refreshed bearer. No real credentials or browser were used; custom OAuth configuration and provider login remain unverified.",
        },
        {
          version: opencodeV2Harness.referenceVersion,
          date: "2026-09-26",
          method: "live-probe",
          artifact: ".capture/opencode-v2",
          what: "Generated project integration and separately installed pnpm tarballs expose skills and connect stdio MCP. Server startup records verify environment expansion, cwd and relocated paths; hooks-only, components-only and combined packages load.",
        },
        {
          version: opencodeV2Harness.referenceVersion,
          date: "2026-09-26",
          method: "live-probe",
          artifact: ".capture/opencode-v2",
          what: "OpenCode resolves a scoped npm coordinate from a read-only loopback registry serving an actual pnpm tarball. Its cached installation loads skills, starts stdio MCP with the expected environment/cwd, and executes generated hooks. Separate native/injected skill and Code Mode MCP calls deliver content to recorded model requests.",
        },
        {
          version: opencodeV2Harness.referenceVersion,
          date: "2026-09-26",
          method: "live-probe",
          artifact: ".capture/opencode-v2-remote",
          what: "Generated project and packed relocated package execute Streamable HTTP MCP tools with recorded headers. Project variables expand and missing variables disable only the affected server; package placeholders remain literal. Default and legacy protocol probes do not fall back to SSE after HTTP 405. OAuth is unverified.",
        },
      ],
    },
  },
];

export const projectOpenCodeV2Components: NonNullable<HarnessAdapter["projectComponents"]> = (...args) =>
  projectComponents(
    ...args,
    (body) => `${body}\n${conversion}
export default { id: "hooknostic.components", async setup(ctx) {
  const config = {}; configure(config);
  await ctx.mcp.transform(editor => {
    for (const [name, server] of Object.entries(config.mcp ?? {})) editor.set(name, nativeServer(server));
  });
} };\n`,
  );

export function v2PackageEntry({
  hooks,
  components,
  name,
}: {
  hooks: boolean;
  components: boolean;
  name?: string;
}): string {
  return [
    ...(hooks ? ['import hooks from "./hooknostic.js";'] : []),
    ...(components ? ['import components from "./hooknostic-agent-plugin.js";'] : []),
    `const plugins = [${[...(hooks ? ["hooks"] : []), ...(components ? ["components"] : [])].join(", ")}];`,
    `export default { id: ${JSON.stringify(`hooknostic.package.${name ?? "hooks"}`)}, async setup(ctx) {`,
    "  const cleanups = [];",
    "  try { for (const plugin of plugins) { const cleanup = await plugin.setup(ctx); if (cleanup) cleanups.push(cleanup); } }",
    "  catch (error) { await Promise.allSettled(cleanups.map(cleanup => cleanup())); throw error; }",
    "  return async () => { await Promise.allSettled(cleanups.map(cleanup => cleanup())); };",
    "} };",
    "",
  ].join("\n");
}

function injector(source: AgentPluginPackage, servers: Record<string, unknown>): string {
  const skills = source.skills.map((skill) => ({ ...skill, id: `${source.manifest.name}/${skill.name}` }));
  return `import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "package");
const launcher = join(here, "hooknostic-runtime", "mcp-launcher.mjs");
const servers = JSON.parse(${JSON.stringify(JSON.stringify(servers))});
const skills = ${JSON.stringify(skills)};
${conversion}
const resolve = value => value.split(${JSON.stringify(RUNTIME_LAUNCHER)}).join(launcher).split(${JSON.stringify(RUNTIME_PLUGIN_ROOT)}).join(root);
export default { id: ${JSON.stringify(`hooknostic.components.${source.manifest.name}`)}, async setup(ctx) {
  if (Object.keys(servers).length) await ctx.mcp.transform(editor => {
    for (const [name, server] of Object.entries(servers)) editor.set(name, nativeServer(server.type === "local" ? {
      ...server, command: server.command.map(resolve), cwd: resolve(server.cwd),
    } : server));
  });
  const values = skills.map(skill => ({ id: skill.id, name: skill.name, description: skill.description,
    path: join(root, skill.manifestPath),
    content: readFileSync(join(root, skill.manifestPath), "utf8").replace(/^---\\r?\\n[\\s\\S]*?\\r?\\n---\\r?\\n/, ""),
  }));
  if (values.length) await ctx.skill.transform(editor => { for (const skill of values) editor.add(skill); });
} };\n`;
}

export const opencodeV2Projector: AgentPluginProjector<TargetSpec> = {
  ...createOpenCodeAgentPluginProjector({ injector, entry: v2PackageEntry }),
  qualifiesSkillNames: false,
  profiles: opencodeV2ProjectProfiles.map((profile) => ({
    ...profile,
    components: {
      ...profile.components,
      "agent-plugin.manifest": { level: "exact" },
      "agent-plugin.skills": {
        level: "emulated",
        rationale:
          "Registers skill definitions with package-qualified IDs and their authored names through the v2 skill domain.",
      },
    },
  })),
};
