import type { AgentPluginPackage, AgentPluginProjectionProfile, AgentPluginProjector } from "@hooknostic/agent-plugin";
import { skillInvocationPolicyProfiles, withSkillInvocationPolicy } from "@hooknostic/agent-plugin";
import type { HarnessAdapter, TargetSpec } from "@hooknostic/core";

import { PRIMARY_AGENT_MODEL_IGNORED, projectComponents, projectIntegrationWith } from "../project.js";
import {
  AGENT_NAME_UNQUALIFIED,
  createOpenCodeAgentPluginProjector,
  type OpenCodePackageAgent,
  RUNTIME_LAUNCHER,
  RUNTIME_PLUGIN_ROOT,
} from "../project-agent-plugin.js";
import { OPENCODE_SKILL_REFERENCE_DEGRADATION, OPENCODE_SKILL_TEXT_RATIONALE } from "../skill-text.js";
import {
  AGENT_REQUEST_IGNORED,
  nativeAgentDegradations,
  packageAgentNative,
  packageAgentTranslation,
} from "./agent-native.js";
import { opencodeV2Harness } from "./harness.js";
import {
  OPENCODE_V2_SKILL_POLICY_RATIONALE,
  opencodeV2NewerSkillPolicyValidation,
  opencodeV2PackageSkillPolicyValidation,
  opencodeV2ProjectSkillPolicyValidation,
  opencodeV2SkillPolicy,
} from "./skill-policy.js";

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

const nativeOpenCodeV2ProjectProfiles: readonly AgentPluginProjectionProfile[] = [
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
      "agents.definition": {
        level: "exact",
        rationale:
          "Written to .opencode/agents/<name>.md with the definition's mode, which v2 needs because it defaults an agent to primary. As a subagent or all, the subagent tool's description offers it to the parent with its description, the instructions replace the provider's base prompt, and tool events inside the child carry the agent's name.",
      },
      "agents.default": {
        level: "exact",
        rationale:
          "The project's components plugin calls the agent editor's default() with the agent's name, and OpenCode starts every session in the project as it; sync refuses a project whose opencode.json or opencode.jsonc already names a default_agent.",
      },
      "agents.primary": {
        level: "exact",
        rationale:
          "With mode: primary or all, opencode run --agent <name> and default_agent run the session as the agent, on its instructions in place of the provider prompt, and its tool events name it; a primary agent is absent from the subagent tool. v2 also runs a mode: subagent agent as the session when named, which the contract does not promise.",
      },
      "agents.native": {
        level: "exact",
        rationale:
          "native.opencode fields are written into the frontmatter. Native model selections and variants, step caps and permission rules take effect. A subagent keeps its own permissions; subagent and execute remain available unless denied too. Primary sessions keep their configured model, and per-agent request overlays survive on the agent but are not sent in model requests; both limitations are reported per active definition.",
        degradations: [
          {
            id: PRIMARY_AGENT_MODEL_IGNORED,
            summary:
              "OpenCode 2.0.17 runs a session started as the agent on the configured model, so a native.opencode.model reaches the agent only when it runs as a subagent.",
            evidence: ".capture/agents",
          },
          {
            id: AGENT_REQUEST_IGNORED,
            summary:
              "OpenCode preserves per-agent request headers and body overlays but does not send them in model requests on the validated build.",
            evidence: ".capture/agents",
          },
        ],
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
          date: "2026-09-29",
          method: "live-probe",
          artifact: ".capture/agents",
          what: "With mode: primary or all, a project agent ran as the session through run --agent and through default_agent, on its body in place of the provider prompt, and its tool events carried agent: <name>; the session ran on the configured model rather than the agent's native model. Primary agents were absent from the subagent tool and all agents present, and run --agent also ran a mode: subagent agent as the session. A mode: primary definition synchronized by Hooknostic's project delivery, and one a built package registered as <plugin>-<name>, each ran as the session through run --agent on the configured model (packages/cli/test/agent-definition-playback.test.ts). A plugin whose agent transform called the editor's default(<name>) started the session as that agent without --agent. With components.defaultAgent naming a synchronized mode: primary definition, a session started with no --agent ran as it (packages/cli/test/agent-definition-playback.test.ts, generated-default).",
        },
        {
          version: opencodeV2Harness.referenceVersion,
          date: "2026-09-29",
          method: "live-probe",
          artifact: ".capture/agents",
          what: "A project .opencode/agents file was offered to the parent through the subagent tool with its description; its body replaced the provider prompt, its model reached the child request, steps: 2 ended the child after two turns, permissions deny rules for edit and shell removed edit, write and shell from its tools, and tool events inside the child carried agent: <name>. A definition synchronized by Hooknostic's project delivery was delegated to and ran on its instructions and native model, and without mode: subagent the subagent tool could not select it (packages/cli/test/agent-definition-playback.test.ts). A plugin's agent transform upserted an unknown id through update; a package built with a portable definition beside its root and named in opencode.json plugins registered it that way as <plugin>-<name>, which was offered, delegated to and ran on its instructions, on the parent's model -- and again, without mode: subagent it could not be selected.",
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
        {
          version: opencodeV2Harness.referenceVersion,
          date: "2026-10-17",
          method: "live-probe",
          artifact: ".capture/agents",
          what: "Native project files, an independent package transform, and generated packages ran against loopback models. String/structured model selections and variants reached subagent requests; primary sessions kept the configured model. Steps 2 versus 4 capped model turns, an expanded home-path read deny prevented the scratch secret reaching the model, and the longer control read the permitted seed file. Package inventory preserved color/hidden, appended permission defaults and a seeded guard, merged request maps without losing settings, and removed a seeded qualified agent for disabled:true. Per-agent request headers/body were preserved but absent from actual model requests on both routes, while the variant body overlay reached the server (.capture/agents/native-v2.mjs).",
        },
      ],
    },
  },
];
export const opencodeV2ProjectProfiles = skillInvocationPolicyProfiles(
  nativeOpenCodeV2ProjectProfiles,
  opencodeV2ProjectSkillPolicyValidation,
  OPENCODE_V2_SKILL_POLICY_RATIONALE,
  "exact",
  [opencodeV2NewerSkillPolicyValidation],
);

export const projectOpenCodeV2Components: NonNullable<HarnessAdapter["projectComponents"]> = async (...args) => {
  const result = await projectComponents(
    ...args,
    // v2 has no config hook: the default agent goes through the agent editor's
    // default(), which starts sessions as it (.capture/agents inject-default).
    (body, { defaultAgent }) => `${body}\n${scopeImports}\nconst own = root;\n${scope}\n${conversion}
export default { id: "hooknostic.components" + suffix, async setup(ctx) {
  if (!serves(ctx.location.directory)) return;
  const config = {}; configure(config);
  await ctx.mcp.transform(editor => {
    for (const [name, server] of Object.entries(config.mcp ?? {})) editor.set(name, nativeServer(server));
  });
${defaultAgent === undefined ? "" : `  await ctx.agent.transform(editor => editor.default(${JSON.stringify(defaultAgent)}));\n`}} };\n`,
  );
  const degradations = nativeAgentDegradations(args[0].agents ?? [], args[4].support?.["agents.native"]).filter(
    (item) => item.id === AGENT_REQUEST_IGNORED,
  );
  if (degradations.length > 0) (result.degradations ??= []).push(...degradations);
  return result;
};

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

function injector(
  source: AgentPluginPackage,
  servers: Record<string, unknown>,
  agents: readonly OpenCodePackageAgent[],
): string {
  const skills = source.skills.map((skill) => ({ ...skill, id: `${source.manifest.name}/${skill.name}` }));
  // The agent editor has no add, and update on an unknown id upserts it; the id
  // is the name the subagent tool selects and --agent runs (.capture/agents).
  // The native configuration is validated and its model lowered before emission;
  // home paths, request maps and permission rules are applied on the consuming host.
  const definitions = agents.map((agent) => ({
    id: agent.name,
    description: agent.description,
    mode: agent.mode,
    system: agent.instructions,
    native: agent.native,
  }));
  return `import { readFileSync } from "node:fs";
import { dirname, join${definitions.length === 0 ? "" : ", posix, win32"} } from "node:path";
${definitions.length === 0 ? "" : 'import { homedir } from "node:os";\n'}import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "package");
const launcher = join(here, "hooknostic-runtime", "mcp-launcher.mjs");
const servers = JSON.parse(${JSON.stringify(JSON.stringify(servers))});
const skills = ${JSON.stringify(skills)};
${definitions.length === 0 ? "" : `const agents = JSON.parse(${JSON.stringify(JSON.stringify(definitions))});\n${packageAgentTranslation}\n`}${conversion}
const resolve = value => value.split(${JSON.stringify(RUNTIME_LAUNCHER)}).join(launcher).split(${JSON.stringify(RUNTIME_PLUGIN_ROOT)}).join(root);
export default { id: ${JSON.stringify(`hooknostic.components.${source.manifest.name}`)}, async setup(ctx) {
  if (Object.keys(servers).length) await ctx.mcp.transform(editor => {
    for (const [name, server] of Object.entries(servers)) editor.set(name, nativeServer(server.type === "local" ? {
      ...server, command: server.command.map(resolve), cwd: resolve(server.cwd),
    } : server));
  });
  const values = skills.map(skill => ({ id: skill.id, name: skill.name, description: skill.description,
    ...(skill.policy === undefined ? {} : { autoinvoke: skill.policy.allowImplicitInvocation }),
    path: join(root, skill.manifestPath),
    content: readFileSync(join(root, skill.manifestPath), "utf8").replace(/^---\\r?\\n[\\s\\S]*?\\r?\\n---\\r?\\n/, ""),
  }));
  if (values.length) await ctx.skill.transform(editor => { for (const skill of values) editor.add(skill); });
${definitions.length === 0 ? "" : "  await ctx.agent.transform(editor => { for (const agent of agents) registerAgent(editor, agent); });\n"}} };\n`;
}

const packageProjector = createOpenCodeAgentPluginProjector({ injector, entry: v2PackageEntry });
const nativeOpenCodeV2Projector: AgentPluginProjector<TargetSpec> = {
  ...packageProjector,
  async project(source, context) {
    const selections = context.agents?.map(packageAgentNative);
    const plan = await packageProjector.project(source, {
      ...context,
      ...(selections === undefined ? {} : { agents: selections.map((item) => item.agent) }),
    });
    plan.issues.push(...(selections ?? []).flatMap((item) => item.issues));
    const degradations = nativeAgentDegradations(context.agents ?? [], context.support["agents.native"]);
    if (degradations.length > 0) (plan.summary.degradations ??= []).push(...degradations);
    return plan;
  },
  qualifiesSkillNames: false,
  profiles: opencodeV2ProjectProfiles.map((profile) => ({
    ...profile,
    source: {
      ...profile.source,
      validatedOn: [
        ...profile.source.validatedOn,
        {
          version: opencodeV2Harness.referenceVersion,
          date: "2026-10-17",
          method: "live-probe",
          artifact: ".capture/agents",
          what: "The real interactive picker lists a visible primary agent and excludes a hidden primary agent registered through the package agent transform. A package built from native.opencode.hidden definitions preserves true and false in the host's agent inventory and produces the same picker result (.capture/agents/hidden-v2.mjs; packages/cli/test/agent-definition-playback.test.ts). No model requests were made.",
        },
        {
          version: opencodeV2Harness.referenceVersion,
          date: "2026-10-17",
          method: "schema-derived",
          artifact: ".capture/agents",
          what: "Package native-field validation derives from ConfigAgent.Info, ConfigModel.Selection, ConfigProvider.Request and Permission.Rule in the reference build's published source. Canonical v2 fields are validated; unknown/legacy keys and invalid shapes fail with authoring errors. Runtime translation follows the native config loader's model lowering, request-map merging, permission append/home expansion and disabled removal; behavior is separately live-probed in native-v2.mjs.",
        },
      ],
    },
    components: {
      ...profile.components,
      "agent-plugin.manifest": { level: "exact" },
      "agent-plugin.skills": {
        level: "emulated",
        rationale: `Registers skill definitions with package-qualified IDs and their authored names through the v2 skill domain. ${OPENCODE_SKILL_TEXT_RATIONALE}`,
        degradations: [OPENCODE_SKILL_REFERENCE_DEGRADATION],
      },
      "agents.definition": {
        level: "emulated",
        rationale:
          "Registered through the v2 agent domain, whose editor upserts an unknown id, with the definition's mode and the instructions as its system prompt. The id is the name the subagent tool selects, so each is named <plugin>-<name>, the nearest spelling of the plugin-qualified name Claude gives a plugin agent; the qualification is the projection's, not OpenCode's.",
        degradations: [
          {
            id: AGENT_NAME_UNQUALIFIED,
            summary:
              "An agent that cannot be named `<plugin>-<name>` -- the name would pass 64 characters or break the name rules, or duplicate another agent in the build -- keeps its bare id, which it shares with the project's agents and every other plugin's.",
            evidence: ".capture/agents",
          },
        ],
      },
      "agents.default": {
        level: "unsupported",
        rationale:
          "The agent editor's default() would do it from a package (.capture/agents inject-default), but Hooknostic does not make a package set the default agent: it would start every session of every user who enables the package as that agent. Deliver the default to a project target.",
      },
      "agents.primary": {
        level: "emulated",
        rationale:
          "An agent registered with mode: primary or all runs as the session through opencode run --agent <plugin>-<name>, on its instructions, and its tool events name it. The name is the projection's qualification, as for agents.definition.",
      },
      "agents.native": {
        level: "exact",
        rationale:
          "Native v2 agent configuration is translated through the agent editor: model selections become runtime references, hidden/color/steps are assigned, request maps merge, permission rules append with consuming-host home expansion, and disabled removes the qualified id. Unknown or invalid fields are rejected. A primary session keeps its configured model, and per-agent request overlays are retained but not sent to the model; both are reported per definition.",
        degradations: [
          {
            id: PRIMARY_AGENT_MODEL_IGNORED,
            summary:
              "A primary session uses its configured model rather than the agent's native model; the model applies to subagents.",
            evidence: ".capture/agents",
          },
          {
            id: AGENT_REQUEST_IGNORED,
            summary:
              "OpenCode preserves per-agent request headers and body overlays but does not send them in model requests on the validated build.",
            evidence: ".capture/agents",
          },
        ],
      },
    },
  })),
};
export const opencodeV2Projector = withSkillInvocationPolicy(
  {
    ...nativeOpenCodeV2Projector,
    profiles: skillInvocationPolicyProfiles(
      nativeOpenCodeV2Projector.profiles,
      opencodeV2PackageSkillPolicyValidation,
      OPENCODE_V2_SKILL_POLICY_RATIONALE,
      "exact",
      [opencodeV2NewerSkillPolicyValidation],
    ),
  },
  "opencode",
  opencodeV2SkillPolicy,
);
