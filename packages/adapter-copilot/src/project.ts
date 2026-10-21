import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { AgentPluginProjectionProfile, ProjectComponents } from "@hooknostic/agent-plugin";
import {
  contentsText,
  projectSkillText,
  SKILL_REFERENCE_UNEXPANDED,
  unexpandedSkillReferenceReason,
} from "@hooknostic/agent-plugin";
import type {
  GeneratedArtifact,
  McpLauncherServer,
  ProjectComponentOptions,
  ProjectEntry,
  ProjectIntegration,
} from "@hooknostic/core";
import { MCP_LAUNCHER_FILE, projectMcpLauncher, projectSkillFiles } from "@hooknostic/core";

import { copilotHarness } from "./harness.js";
import {
  copilotEnvironmentReferences,
  declaresEnvironmentExpansion,
  ENVIRONMENT_EXPANSION_DEVIATION,
  environmentExpansionReason,
} from "./mcp-expansion.js";
import { copilotValidationRecords } from "./profile.js";
import { copilotSkillPolicy, copilotSkillPolicyProfiles } from "./skill-policy.js";
import { COPILOT_SKILL_TEXT, copilotSkillDirectoryDegradation } from "./skill-text.js";

const CAPTURE = ".capture/copilot/README.md";

const SKILL_REFERENCE_DEGRADATION = {
  id: SKILL_REFERENCE_UNEXPANDED,
  summary:
    "A SKILL.md that holds ${PLUGIN_ROOT}, ${PLUGIN_DATA}, a CLAUDE_ variable or $CLAUDE_SESSION_ID reaches the model with that text as written: Copilot expands nothing in skill text, and the projection rewrites ${SKILL_DIR} in the body only. The loaded skill context does carry a `Base directory for this skill` line.",
  evidence: CAPTURE,
} as const;

const REMOTE_ENVIRONMENT_DEVIATION = {
  id: ENVIRONMENT_EXPANSION_DEVIATION,
  summary:
    "Copilot substitutes set ambient environment variables, including ${NAME:-fallback}, into a remote server's url query or header values, where Agent Plugins 1.0 requires the text to reach the client literally. The package aliases ${PLUGIN_ROOT} and ${PLUGIN_DATA} stayed literal. Header-name expansion was not captured.",
  evidence: CAPTURE,
} as const;

/** The compiled hook document lives here in the build output; sync relocates it. */
const COMPILED_HOOKS_PATH = "hooks/hooknostic.json";

/**
 * Repository integration: `.github/hooks/hooknostic.json` is a whole file
 * Hooknostic owns, unlike an inline `hooks` block in someone else's
 * `.github/copilot/settings.json`. Its runtime argument is rewritten from the
 * build output to a path relative to the project root, because Copilot does
 * not expand a project-directory variable in a hook's exec args (captured).
 */
const COPILOT_PROJECT_GUIDANCE = [
  "Start Copilot at the project root: repository hooks are read from the session's working directory, not the git root, and a linked worktree's own .github/hooks is the one it reads.",
  "Trust the folder (--trust-folder or COPILOT_ALLOW_ALL=true) or repository hooks are skipped silently, and restart the CLI after synchronization: hook files are loaded at startup.",
];

export function projectIntegration(artifacts: readonly GeneratedArtifact[], output: string): ProjectIntegration {
  const manifest = artifacts.find((artifact) => artifact.path === COMPILED_HOOKS_PATH);
  // A components-only project (skills and/or MCP, no portable hooks) compiles
  // no hooks document. Integration still has work to do, so return no hook
  // file rather than failing the target.
  if (manifest === undefined) {
    return { files: [], entries: [], guidance: COPILOT_PROJECT_GUIDANCE };
  }
  const document = JSON.parse(contentsText(manifest.contents)) as {
    version: number;
    hooks: Record<string, { args?: unknown }[]>;
  };
  const runtime = output === "." ? "runtime/hooknostic.mjs" : `${output}/runtime/hooknostic.mjs`;
  for (const entries of Object.values(document.hooks)) {
    for (const entry of entries) {
      if (!Array.isArray(entry.args) || typeof entry.args[0] !== "string") {
        throw new Error("expected every compiled hook entry to carry an exec arg list");
      }
      entry.args[0] = runtime;
    }
  }
  return {
    files: [
      {
        path: ".github/hooks/hooknostic.json",
        contents: `${JSON.stringify(document, null, 2)}\n`,
      },
    ],
    entries: [],
    guidance: COPILOT_PROJECT_GUIDANCE,
  };
}

/**
 * Project components. Copilot discovers skills in `.agents/skills` (as well as
 * `.github/skills` and `.claude/skills`), reads project MCP servers from
 * `.github/mcp.json`, and expands no project directory variable in a hook.
 *
 * Every stdio server goes through the shared launcher: a project `.mcp.json`
 * has no variable naming a package root, and `${PLUGIN_ROOT}` in its args stays
 * literal (captured), so a package server addressed that way would not start.
 * Direct-source declarations are given the launcher too, which resolves the
 * source root, cwd and environment references in one place. Remote servers are
 * native (`http` for Streamable HTTP, `sse` for SSE).
 */
export async function projectComponents(
  source: ProjectComponents,
  root: string,
  output: string,
  _config?: string,
  options: ProjectComponentOptions = {},
): Promise<ProjectIntegration> {
  // Copilot discovers these trees itself. A skill authored there is in place:
  // copying it to .agents/skills would list the same name twice and rewrite a
  // file Hooknostic does not own. `discoveryDirectories` tells the core policy
  // planner the same thing for gated skills. Paths are canonicalized because a
  // discovery directory may be a symlink or junction to a shared tree, and a
  // lexical comparison would copy the same skill under `.agents/skills`.
  const canonical = (path: string): string => {
    try {
      return realpathSync.native(path);
    } catch {
      return resolve(path);
    }
  };
  const nativeRoots = [".github/skills", ".claude/skills"].map((directory) => resolve(root, directory));
  const authoredInPlace = (sourcePath: string, name: string): boolean => {
    const canonicalSource = canonical(sourcePath);
    return nativeRoots.some((directory) => {
      // The discovery root may be a junction to a shared tree, or one skill
      // under it may be. Compare the specific skill directory as well as the
      // root, so both shapes are recognized as the same authored source.
      const linked = canonical(resolve(directory, name));
      const offset = relative(canonical(directory), canonicalSource);
      const underRoot = offset === "" || (!isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`));
      return linked === canonicalSource || underRoot;
    });
  };
  const nativeSkills = new Set<string>();
  const skillSource: ProjectComponents = {
    ...source,
    skills: source.skills.flatMap((skill) => {
      if (!authoredInPlace(skill.source, skill.name)) return [skill];
      nativeSkills.add(skill.name);
      const destination = resolve(root, ".agents/skills", skill.name);
      // Present the native skill at the destination path only when the two
      // resolve to the same physical directory. The shared projector then
      // relinquishes ownership and does not delete the authored source.
      // A native skill elsewhere is dropped from the copy set: an older
      // generated copy at the destination stays owned and is removed by
      // reconciliation, rather than being relinquished as if it were the
      // source.
      return canonical(skill.source) === canonical(destination) ? [{ ...skill, source: destination }] : [];
    }),
  };
  const result = projectSkillFiles(skillSource, root, ".agents/skills", {
    target: COPILOT_SKILL_TEXT,
    harness: "GitHub Copilot CLI",
  });
  if (nativeSkills.size > 0 && result.degradations !== undefined) {
    // The helper reports the degradation at the destination path it was given;
    // the file is really at the native discovery path, reported below.
    result.degradations = result.degradations.filter(
      (degradation) => degradation.name === undefined || !nativeSkills.has(degradation.name),
    );
  }

  // Hooknostic does not own an authored native skill, but it still owes the
  // report: Copilot shows that text as written. This is the same degradation a
  // copied skill gets for a reference the target will not expand, with the
  // in-place reason that says why ${SKILL_DIR} cannot be rewritten here.
  for (const skill of source.skills.filter((candidate) => authoredInPlace(candidate.source, candidate.name))) {
    if (canonical(skill.source) !== canonical(resolve(root, ".agents/skills", skill.name))) {
      for (const file of skill.files) {
        if (file.mode === 0o755) (result.unappliedModes ??= []).push({ skill: skill.name, path: file.path });
      }
    }
    const manifest = skill.files.find((file) => file.path === "SKILL.md");
    if (manifest === undefined) continue;
    const projected = projectSkillText(manifest.contents, COPILOT_SKILL_TEXT, { rewrite: false });
    if (projected.unexpanded.length === 0) continue;
    (result.degradations ??= []).push({
      id: SKILL_REFERENCE_UNEXPANDED,
      component: "agent-plugin.skills",
      name: skill.name,
      path: `${relative(root, skill.source).replaceAll("\\", "/")}/SKILL.md`,
      reason: unexpandedSkillReferenceReason(skill.name, projected.unexpanded, "GitHub Copilot CLI", {
        inPlace: true,
        ...(projected.inFrontmatter ? { inFrontmatter: true } : {}),
      }),
    });
  }
  if (!source.mcp) return result;

  const stdio: McpLauncherServer[] = [];
  for (const [name, server] of Object.entries(source.mcp.config.mcpServers)) {
    if (server.type !== "stdio") continue;
    stdio.push({
      name,
      command: server.command,
      ...(server.args === undefined ? {} : { args: server.args }),
      ...(server.env === undefined ? {} : { env: server.env }),
      ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
    });
  }
  if (stdio.length > 0) {
    const launcher = await projectMcpLauncher(source, root, output, stdio);
    result.files.push(...launcher.files);
    const launcherPath = output === "." ? `./${MCP_LAUNCHER_FILE}` : `./${output}/${MCP_LAUNCHER_FILE}`;
    const entries: ProjectEntry[] = stdio.map((server, index) => ({
      path: ".github/mcp.json",
      key: ["mcpServers", server.name],
      kind: "property" as const,
      value: { type: "stdio", command: "node", args: [launcherPath, String(index)] },
    }));
    result.entries.push(...entries);
  }

  for (const [name, server] of Object.entries(source.mcp.config.mcpServers)) {
    if (server.type === "stdio") continue;
    const component = `agent-plugin.mcp.${server.type}` as const;
    if (source.origin === "package") {
      const references = copilotEnvironmentReferences(server);
      if (references.length > 0 && declaresEnvironmentExpansion(options.support?.[component])) {
        (result.deviations ??= []).push({
          id: ENVIRONMENT_EXPANSION_DEVIATION,
          component,
          name,
          path: `mcp.json#${name}`,
          reason: environmentExpansionReason(name, references),
        });
      }
    }
    result.entries.push({
      path: ".github/mcp.json",
      key: ["mcpServers", name],
      kind: "property",
      value: {
        type: server.type === "streamable-http" ? "http" : "sse",
        url: server.url,
        ...(server.headers === undefined ? {} : { headers: server.headers }),
      },
    });
  }
  result.guidance.push("Approve project MCP servers in the CLI; .github/mcp.json is read when the session starts.");
  return result;
}

const nativeProjectComponentProfiles: readonly AgentPluginProjectionProfile[] = copilotSkillPolicyProfiles(
  {
    range: copilotHarness.recommendedRange,
    components: {
      "agent-plugin.manifest": {
        level: "unsupported",
        rationale:
          "Project delivery writes .github/hooks/hooknostic.json, a skills tree and .github/mcp.json. Copilot reads a plugin.json only from an installed plugin or a --plugin-dir directory, which project delivery does not create.",
      },
      "agent-plugin.skills": {
        level: "exact",
        rationale:
          "Copied into .agents/skills as authored, except that ${SKILL_DIR} in a SKILL.md body becomes an explicit model-substituted placeholder; Copilot shows a loaded skill's body as written while supplying its Base directory. A skill already at its destination is discovered in place and not rewritten.",
        degradations: [SKILL_REFERENCE_DEGRADATION, copilotSkillDirectoryDegradation],
      },
      "agent-plugin.mcp.stdio": {
        level: "emulated",
        rationale:
          "A generated Node launcher resolves the source root, working directory and the package's PLUGIN_ROOT/PLUGIN_DATA text, because a project .github/mcp.json has no variable naming a package root and Copilot left ${PLUGIN_ROOT} literal there. Copilot sees only the launcher. Dependencies are supplied by the project.",
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
        level: "unsupported",
        rationale:
          "Project integration writes .github/hooks, .agents/skills and .github/mcp.json. Copilot reads com.github.copilot components from an installed plugin's root, and project delivery installs nothing, so there is no surface at project scope that would read them. Deliver the package to reach them.",
      },
      "agent-plugin.runtime-package": {
        level: "unsupported",
        rationale:
          "Project delivery installs nothing. The captured local marketplace and --plugin-dir routes load a plugin live and copy no directory, so a package.json and lockfile written beside the projected files would be read by nothing and no node_modules would appear. Bundle a Node component's dependencies instead.",
      },
    },
    source: {
      date: "2026-10-20",
      validatedOn: copilotValidationRecords,
      notes: [
        "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers (fetched 2026-10-20)",
        "https://agent-plugins.org/specification (fetched 2026-10-20)",
      ],
    },
  },
  { inPlace: true },
);

export const projectComponentProfiles = nativeProjectComponentProfiles;

/** The native field this target would use when the policy cell is supported. */
export const copilotProjectSkillPolicy = copilotSkillPolicy;
