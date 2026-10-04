import type { AgentPluginPackage, AgentPluginProjectionProfile, AgentPluginProjector } from "@hooknostic/agent-plugin";
import type { HarnessAdapter, TargetSpec } from "@hooknostic/core";

import { projectComponents, projectIntegrationWith } from "../project.js";
import { createOpenCodeAgentPluginProjector, RUNTIME_LAUNCHER, RUNTIME_PLUGIN_ROOT } from "../project-agent-plugin.js";
import { OPENCODE_SKILL_REFERENCE_DEGRADATION, OPENCODE_SKILL_TEXT_RATIONALE } from "../skill-text.js";
import { opencodeV2Harness } from "./harness.js";

// v2 loads .opencode/plugins from every ancestor of the session directory and
// keeps the outermost copy of an id (.capture/opencode-v2, nested drive), so
// each checkout's copy takes its own id and serves only sessions whose nearest
// integration it owns. Expects dirname/resolve and `own` (its checkout root).
const scopeImports = `import { existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";`;
const scope = `const canonical = (path) => { try { return realpathSync.native(path); } catch { return resolve(path); } };
const serves = (directory) => {
  for (let dir = resolve(directory); ; dir = dirname(dir)) {
    if (existsSync(resolve(dir, ".hooknostic", "integration.json"))) return canonical(dir) === canonical(own);
    if (dirname(dir) === dir) return true;
  }
};
const suffix = "." + createHash("sha256").update(canonical(own)).digest("hex").slice(0, 12);`;

export const projectOpenCodeV2Integration: NonNullable<HarnessAdapter["projectIntegration"]> = projectIntegrationWith(
  (importPath) => `${scopeImports}
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import plugin from ${JSON.stringify(importPath)};
const own = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
${scope}
export default { id: plugin.id + suffix, setup: (ctx) => (serves(ctx.location.directory) ? plugin.setup(ctx) : undefined) };
`,
);

const conversion = `const nativeServer = (server) => {
  const { enabled, timeout, ...rest } = server;
  return { ...rest, ...(enabled === undefined ? {} : { disabled: !enabled }),
    ...(timeout === undefined ? {} : { timeout: { startup: timeout } }) };
};`;

export const opencodeV2ProjectProfiles: readonly AgentPluginProjectionProfile[] = [
  {
    range: opencodeV2Harness.recommendedRange,
    components: {
      "agent-plugin.skills": {
        level: "exact",
        rationale: `Copied into .agents/skills as authored, except that ${OPENCODE_SKILL_TEXT_RATIONALE} A skill already at its destination is discovered in place and not rewritten.`,
        degradations: [OPENCODE_SKILL_REFERENCE_DEGRADATION],
      },
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
          version: "2.0.20",
          date: "2026-10-04",
          method: "live-probe",
          artifact: ".capture/skill-invocation",
          what: "On Windows with isolated state and a loopback model, permission.skill deny omitted the named project skill and returned permission.rejected for a forced skill-tool call that succeeded without the rule. Claude frontmatter and Codex policy alone did not hide the controls. Explicit UI invocation and plugin-supplied v2 rules were not tested.",
        },
        {
          version: "2.0.18",
          date: "2026-09-30",
          method: "live-probe",
          artifact: ".capture/skill-directory",
          what: 'Over the loopback model with isolated state, the skill tool (argument id) loaded a project skill from .agents/skills and handed the model its body with every ${...} as written (${CLAUDE_SKILL_DIR}, ${CLAUDE_PLUGIN_ROOT}, ${CLAUDE_PLUGIN_DATA}, ${CLAUDE_SESSION_ID}, ${SKILL_DIR}, ${PLUGIN_ROOT}, ${PLUGIN_DATA}, ${HOME}), followed by "Base directory for this skill: <absolute path>" and "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory."',
        },
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
        {
          version: opencodeV2Harness.referenceVersion,
          date: "2026-09-26",
          method: "live-probe",
          artifact: ".capture/opencode-v2",
          what: "Nested drive: a session in a checkout nested inside another loads both checkouts' .opencode/plugins. With a shared id the outer copy stayed active and the nested copy failed as a duplicate; with per-checkout ids both stay active and only the copy owning the nearest integration serves the session.",
        },
      ],
    },
  },
];

export const projectOpenCodeV2Components: NonNullable<HarnessAdapter["projectComponents"]> = (...args) =>
  projectComponents(
    ...args,
    (body) => `${body}\n${scopeImports}\nconst own = root;\n${scope}\n${conversion}
export default { id: "hooknostic.components" + suffix, async setup(ctx) {
  if (!serves(ctx.location.directory)) return;
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
        rationale: `Registers skill definitions with package-qualified IDs and their authored names through the v2 skill domain. ${OPENCODE_SKILL_TEXT_RATIONALE}`,
        degradations: [OPENCODE_SKILL_REFERENCE_DEGRADATION],
      },
    },
  })),
};
