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
  contentsText,
  isJsonObject,
  isRejectedSkillPath,
  materializedPackageFiles,
  projectPackageSkillTexts,
  withSkillInvocationPolicy,
} from "@hooknostic/agent-plugin";

import { copilotHarness } from "./harness.js";
import { copilotHookEntryProblem } from "./hook-entries.js";
import { copilotEnvironmentReferences, ENVIRONMENT_EXPANSION_DEVIATION } from "./mcp-expansion.js";
import { copilotValidationRecords } from "./profile.js";
import { copilotSkillPolicy, copilotSkillPolicyProfiles } from "./skill-policy.js";
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
    "Copilot expands ${PLUGIN_ROOT} and ${PLUGIN_DATA} in a stdio command, which Agent Plugins 1.0 explicitly excludes, and expands ${NAME}, ${NAME:-fallback} and bare $NAME references to set ambient variables or the aliases in command, args, env values and cwd, where the specification requires other placeholder-like text to remain literal.",
  evidence: CAPTURE,
} as const;

const REMOTE_ENVIRONMENT_DEVIATION = {
  id: ENVIRONMENT_EXPANSION_DEVIATION,
  summary:
    "Copilot substitutes ${NAME}, ${NAME:-fallback} and bare $NAME references to set ambient variables into a remote server's url or header values, where Agent Plugins 1.0 requires the text to reach the client literally; ${PLUGIN_ROOT:-fallback} took its fallback. The exact and bare package aliases stayed literal, and header names were never expanded.",
  evidence: CAPTURE,
} as const;

const nativeCopilotAgentPluginProjector: AgentPluginProjector = {
  /**
   * Copilot reads client-specific components from com.github.copilot, and the
   * compiled hook document lands in its hooks/ directory.
   */
  namespace: "com.github.copilot",
  packageRoot: ".",
  profiles: copilotSkillPolicyProfiles(
    {
      range: copilotHarness.recommendedRange,
      components: {
        "agent-plugin.manifest": { level: "exact" },
        "agent-plugin.skills": {
          level: "exact",
          rationale:
            "Copied as authored, except that ${SKILL_DIR} in a SKILL.md body becomes an explicit model-substituted placeholder; Copilot shows a loaded skill's body as written while supplying its Base directory.",
          degradations: [SKILL_REFERENCE_DEGRADATION, copilotSkillDirectoryDegradation],
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
    { inPlace: false },
  ),
  async project(source: AgentPluginPackage, context): Promise<AgentPluginProjectionPlan> {
    assertPackageDelivery("copilot", context.target.delivery);
    const files: AgentPluginProjectionFile[] = [];
    const copiedPaths: string[] = [];
    const issues: AgentPluginIssue[] = [];
    const omissions: AgentPluginProjectionPlan["summary"]["omissions"] = [];

    // An author's own Copilot hooks are package data, not a portable component.
    // They are preserved and merged with the compiled dispatcher's entries; a
    // projection replaces the output, so dropping this file would silently
    // remove hooks the package shipped.
    const authoredHooksFile = source.files.find((file) => file.path === HOOKS_PATH);
    let authoredHooks: { version: 1; hooks: Record<string, unknown[]> } | undefined;
    if (authoredHooksFile !== undefined) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(authoredHooksFile.contents)) as unknown;
        if (!isJsonObject(parsed) || parsed["version"] !== 1 || !isJsonObject(parsed["hooks"])) {
          throw new Error("expected version 1 and an object hooks field");
        }
        const hooks: Record<string, unknown[]> = {};
        for (const [event, entries] of Object.entries(parsed["hooks"])) {
          if (!Array.isArray(entries)) throw new Error(`hooks.${event} must be an array`);
          for (const [index, entry] of entries.entries()) {
            const problem = copilotHookEntryProblem(event, entry);
            if (problem !== undefined) throw new Error(`hooks.${event}[${index}]: ${problem}`);
          }
          hooks[event] = entries;
        }
        authoredHooks = { version: 1, hooks };
      } catch (error) {
        issues.push({
          severity: "error",
          scope: "projection",
          path: HOOKS_PATH,
          message: `authored Copilot hooks are invalid and were not merged: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

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
    const rejectedSkill = isRejectedSkillPath(source);
    const generatedRuntime = context.hookArtifacts.some((artifact) => artifact.path === HOOK_RUNTIME);
    const authoredRuntime = source.files.some((file) => file.path === HOOK_RUNTIME);
    if (generatedRuntime && authoredRuntime) {
      issues.push({
        severity: "error",
        scope: "projection",
        path: HOOK_RUNTIME,
        message:
          "the package ships its own runtime/hooknostic.mjs and the compiled hook dispatcher uses the same path; rename the authored file, or the authored hook that invokes it would run the generated dispatcher instead",
      });
    }

    for (const file of source.files) {
      if (file.path === "plugin.json") continue;
      if (file.path === HOOKS_PATH) continue;
      if (file.path === HOOK_RUNTIME && generatedRuntime) continue;
      if (file.path === "mcp.json") continue;
      if (rejectedSkill(file.path)) continue;
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
    if (source.mcp !== undefined) {
      // Emit the loader's validated server map rather than copying the raw
      // document: an entry the loader skipped is not one this harness should
      // receive. An invalid top-level document leaves `source.mcp` undefined.
      files.push({ path: "mcp.json", contents: `${JSON.stringify(source.mcp, null, 2)}\n` });
    }

    // Merge the compiled dispatcher's entries into any authored hooks document,
    // author entries first: an author guard may still deny before the portable
    // hook runs, and Copilot runs every matching entry in order.
    const generatedHooksFile = context.hookArtifacts.find((artifact) => artifact.path === HOOKS_PATH);
    if (authoredHooks !== undefined || generatedHooksFile !== undefined) {
      const merged: Record<string, unknown[]> = { ...(authoredHooks?.hooks ?? {}) };
      if (generatedHooksFile !== undefined) {
        try {
          const parsed = JSON.parse(contentsText(generatedHooksFile.contents)) as unknown;
          if (!isJsonObject(parsed) || !isJsonObject(parsed["hooks"])) {
            throw new Error("compiled hooks document has no hooks object");
          }
          for (const [event, entries] of Object.entries(parsed["hooks"])) {
            if (!Array.isArray(entries)) throw new Error(`hooks.${event} must be an array`);
            for (const entry of entries) {
              if (
                !isJsonObject(entry) ||
                entry["type"] !== "command" ||
                entry["exec"] !== "node" ||
                !Array.isArray(entry["args"]) ||
                entry["args"].length !== 2 ||
                entry["args"][1] !== event ||
                (entry["args"][0] !== "runtime/hooknostic.mjs" &&
                  entry["args"][0] !== "${PLUGIN_ROOT}/runtime/hooknostic.mjs")
              ) {
                throw new Error(`compiled ${event} entry does not carry the generated dispatcher shape`);
              }
            }
            merged[event] = [...(merged[event] ?? []), ...entries];
          }
        } catch (error) {
          issues.push({
            severity: "error",
            scope: "projection",
            path: HOOKS_PATH,
            message: `compiled hooks could not be merged: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      files.push({
        path: HOOKS_PATH,
        contents: `${JSON.stringify({ ...(authoredHooks ?? {}), version: 1, hooks: merged }, null, 2)}\n`,
      });
    }

    // Every other compiled hook artifact is the hook channel: `plugin.json` is
    // rewritten above and the hooks document is merged above.
    for (const artifact of context.hookArtifacts) {
      if (artifact.path === "plugin.json" || artifact.path === HOOKS_PATH) continue;
      files.push({
        path: artifact.path,
        contents: artifact.contents,
        ...(artifact.mode === undefined ? {} : { mode: artifact.mode }),
        ...(artifact.executable === undefined ? {} : { executable: artifact.executable }),
      });
    }

    if (context.runtimePackage !== undefined) {
      omissions.push({
        component: "agent-plugin.runtime-package",
        reason:
          "Copilot loads a plugin live from its source and installs nothing (captured), so the manifest and lockfile were dropped; bundle Node component dependencies instead",
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
    const where = server.type === "stdio" ? "command, args, env or cwd" : "url or header values";
    deviations.push({
      id: ENVIRONMENT_EXPANSION_DEVIATION,
      component: `agent-plugin.mcp.${server.type}`,
      name,
      path: `mcp.json#${name}`,
      reason: `server ${JSON.stringify(name)} declares ${references.join(", ")} in its ${where}; Copilot expands ${server.type === "stdio" ? "every one of those references, where Agent Plugins 1.0 expands only the exact ${PLUGIN_ROOT} and ${PLUGIN_DATA} in args, env and cwd" : "those references there, which Agent Plugins 1.0 forbids"}.`,
    });
  }
  return deviations.length > 0 ? deviations : undefined;
}
