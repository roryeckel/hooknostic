import type {
  AgentPluginIssue,
  AgentPluginPackage,
  AgentPluginProjectionFile,
  AgentPluginProjectionPlan,
  AgentPluginProjector,
} from "@hooknostic/agent-plugin";
import {
  AGENT_PLUGIN_MANIFEST_SCHEMA,
  assertPackageDelivery,
  componentSummary,
  materializedPackageFiles,
  projectPackageSkillTexts,
  withSkillInvocationPolicy,
} from "@hooknostic/agent-plugin";

import { copilotEnvironmentReferences, ENVIRONMENT_EXPANSION_DEVIATION } from "./mcp-expansion.js";
import { copilotValidationRecords } from "./profile.js";
import { COPILOT_SKILL_POLICY_RATIONALE, copilotSkillPolicy } from "./skill-policy.js";
import { COPILOT_SKILL_TEXT, copilotSkillDirectoryDegradation } from "./skill-text.js";

const CAPTURE = ".capture/copilot/README.md";
const HOOK_RUNTIME = "runtime/hooknostic.mjs";
const HOOKS_PATH = "com.github.copilot/hooks/hooks.json";

const SKILL_REFERENCE_DEGRADATION = {
  id: "skill-reference-unexpanded",
  summary:
    "A SKILL.md that holds ${PLUGIN_ROOT}, ${PLUGIN_DATA}, a CLAUDE_ variable or $CLAUDE_SESSION_ID reaches the model with that text as written: Copilot expands nothing in skill text, and the projection rewrites ${SKILL_DIR} in the body only. The loaded skill context does carry a `Base directory for this skill` line.",
  evidence: CAPTURE,
} as const;

const STDIO_ENVIRONMENT_DEVIATION = {
  id: ENVIRONMENT_EXPANSION_DEVIATION,
  summary:
    "Copilot expands set ambient environment variables in a stdio server's command, args, env values and cwd as well as the two Agent Plugins aliases, where Agent Plugins 1.0 defines only ${PLUGIN_ROOT} and ${PLUGIN_DATA} and requires other placeholder-like text to remain literal.",
  evidence: CAPTURE,
} as const;

const REMOTE_ENVIRONMENT_DEVIATION = {
  id: ENVIRONMENT_EXPANSION_DEVIATION,
  summary:
    "Copilot substitutes set ambient environment variables into a remote server's headers, where Agent Plugins 1.0 forbids all expansion in a package's url, header names and header values. The package aliases ${PLUGIN_ROOT} and ${PLUGIN_DATA} stayed literal.",
  evidence: CAPTURE,
} as const;

function hookArtifactPath(path: string): boolean {
  return path === HOOKS_PATH || path === HOOK_RUNTIME;
}

const nativeCopilotAgentPluginProjector: AgentPluginProjector = {
  /**
   * Copilot reads client-specific components from com.github.copilot, and the
   * compiled hook document lands in its hooks/ directory.
   */
  namespace: "com.github.copilot",
  packageRoot: ".",
  profiles: [
    {
      range: ">=1.0 <2",
      components: {
        "agent-plugin.manifest": { level: "exact" },
        "agent-plugin.skills": {
          level: "exact",
          rationale:
            "Copied as authored, except that ${SKILL_DIR} in a SKILL.md body becomes an explicit model-substituted placeholder; Copilot shows a loaded skill's body as written while supplying its Base directory.",
          degradations: [SKILL_REFERENCE_DEGRADATION, copilotSkillDirectoryDegradation],
        },
        "agent-plugin.skills.invocation-policy": {
          level: "unsupported",
          rationale: COPILOT_SKILL_POLICY_RATIONALE,
        },
        "agent-plugin.mcp.stdio": {
          level: "exact",
          deviations: [STDIO_ENVIRONMENT_DEVIATION],
        },
        "agent-plugin.mcp.streamable-http": {
          level: "exact",
          deviations: [REMOTE_ENVIRONMENT_DEVIATION],
        },
        "agent-plugin.mcp.sse": {
          level: "exact",
          deviations: [REMOTE_ENVIRONMENT_DEVIATION],
        },
        "agent-plugin.client-extension.files": {
          level: "exact",
          rationale:
            "Files under com.github.copilot are read by Copilot from a plugin root; its agents/, commands/, rules/, hooks/ and lsp.json components and the manifest's extensions.com.github.copilot object all live there.",
        },
        "agent-plugin.runtime-package": {
          level: "unsupported",
          rationale:
            "A captured local marketplace install and the --plugin-dir route both load the plugin live from its source and copy nothing, so no package.json install runs. A locked dependency install is unavailable on this harness; bundle Node component dependencies instead.",
        },
      },
      source: {
        date: "2026-10-20",
        validatedOn: copilotValidationRecords,
        notes: [
          "https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-cli-plugins (fetched 2026-10-20)",
          "https://agent-plugins.org/specification (fetched 2026-10-20)",
        ],
      },
    },
  ],
  async project(source: AgentPluginPackage, context): Promise<AgentPluginProjectionPlan> {
    assertPackageDelivery("copilot", context.target.delivery);
    const files: AgentPluginProjectionFile[] = [];
    const copiedPaths: string[] = [];
    const issues: AgentPluginIssue[] = [];
    const omissions: AgentPluginProjectionPlan["summary"]["omissions"] = [];

    // The portable manifest is the package's manifest; Hooknostic regenerates
    // it so the Agent Plugins schema cannot be lost in a merged document.
    const manifest = {
      ...source.manifest,
      $schema: AGENT_PLUGIN_MANIFEST_SCHEMA,
    };

    const skillTexts = projectPackageSkillTexts(
      source.skills,
      (path) => source.files.find((file) => file.path === path)?.contents,
      COPILOT_SKILL_TEXT,
      "GitHub Copilot CLI",
    );

    // A component this harness cannot deliver must not reach it. The runtime
    // package install is unsupported (captured: a loaded plugin is not copied
    // and no install runs), so its two install inputs are dropped while the
    // rest of the author's files still ship.
    const runtimePackagePaths = new Set(
      [context.runtimePackage?.manifest, context.runtimePackage?.lockfile].filter(
        (path): path is string => path !== undefined,
      ),
    );

    for (const file of source.files) {
      if (file.path === "plugin.json") continue;
      if (hookArtifactPath(file.path)) continue;
      if (runtimePackagePaths.has(file.path)) continue;
      const rewritten = skillTexts.rewritten.get(file.path);
      files.push({
        path: file.path,
        contents: rewritten ?? file.contents,
        ...(file.mode === undefined ? {} : { mode: file.mode }),
      });
      if (rewritten === undefined) copiedPaths.push(file.path);
    }

    const materialized = materializedPackageFiles(context.materializedTrees, {
      prefix: "",
      claimed: new Set(files.map((file) => file.path)),
    });
    issues.push(...materialized.issues);
    files.push(...materialized.files);

    files.push({ path: "plugin.json", contents: `${JSON.stringify(manifest, null, 2)}\n` });
    // Every compiled hook artifact is the hook channel. `plugin.json` is
    // rewritten above; the hooks document and the runtime are carried verbatim.
    for (const artifact of context.hookArtifacts) {
      if (artifact.path === "plugin.json") continue;
      files.push({
        path: artifact.path,
        contents: artifact.contents,
        ...(artifact.mode === undefined ? {} : { mode: artifact.mode }),
        ...(artifact.executable === undefined ? {} : { executable: artifact.executable }),
      });
    }

    const counts = componentSummary(source, {
      namespace: this.namespace,
      hasRuntimePackage: context.runtimePackage !== undefined,
      skipped: (component, discovered) => (component === "agent-plugin.runtime-package" ? discovered : 0),
    });
    const deviations = copilotProjectionDeviations(source, context.support) ?? [];

    return {
      files,
      ...(source.directories === undefined ? {} : { directories: source.directories }),
      issues,
      summary: {
        components: counts,
        omissions,
        copiedPaths: [...new Set(copiedPaths)].sort((a, b) => a.localeCompare(b)),
        ...(skillTexts.degradations.length > 0 ? { degradations: skillTexts.degradations } : {}),
        ...(deviations.length > 0 ? { deviations } : {}),
      },
    };
  },
};

export const copilotAgentPluginProjector = withSkillInvocationPolicy(
  nativeCopilotAgentPluginProjector,
  "copilot",
  copilotSkillPolicy,
);

/** Exposed for tests that want the projector without the policy wrapper. */
export { nativeCopilotAgentPluginProjector };

/**
 * The remote declarations the profile records a deviation for stay visible to
 * the projection: the adapter reports each server whose ambient reference the
 * harness will expand, rather than silently editing the author's text.
 */
export function copilotProjectionDeviations(
  source: AgentPluginPackage,
  support: Readonly<Partial<Record<string, { deviations?: readonly { id: string }[] }>>>,
): AgentPluginProjectionPlan["summary"]["deviations"] {
  const declared = (component: string) =>
    support[component]?.deviations?.some((deviation) => deviation.id === ENVIRONMENT_EXPANSION_DEVIATION) === true;
  const deviations: NonNullable<AgentPluginProjectionPlan["summary"]["deviations"]> = [];
  for (const [name, server] of Object.entries(source.mcp?.mcpServers ?? {})) {
    if (!declared(`agent-plugin.mcp.${server.type}`)) continue;
    const references = copilotEnvironmentReferences(server);
    if (references.length === 0) continue;
    const where = server.type === "stdio" ? "command, args, env or cwd" : "url or headers";
    deviations.push({
      id: ENVIRONMENT_EXPANSION_DEVIATION,
      component: `agent-plugin.mcp.${server.type}`,
      name,
      path: `mcp.json#${name}`,
      reason: `server ${JSON.stringify(name)} declares ${references.map((reference) => `\${${reference}}`).join(", ")} in its ${where}, which Copilot expands from ambient environment.`,
    });
  }
  return deviations.length > 0 ? deviations : undefined;
}
