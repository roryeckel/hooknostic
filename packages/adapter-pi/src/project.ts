import type { ProjectComponents } from "@hooknostic/agent-plugin";
import type { AgentPluginProjectionProfile } from "@hooknostic/agent-plugin";
import {
  RELATIVE_SKILL_TEXT,
  SKILL_REFERENCE_UNEXPANDED,
  skillInvocationPolicyProfiles,
} from "@hooknostic/agent-plugin";
import type { GeneratedArtifact, ProjectComponentOptions, ProjectIntegration } from "@hooknostic/core";
import { projectAgentFiles, projectSkillFiles } from "@hooknostic/core";

import { piHarness } from "./harness.js";
import { piMcpOmissions } from "./omissions.js";
import { piFeatureValidation } from "./profile.js";
import { PI_SKILL_POLICY_RATIONALE, piProjectSkillPolicyValidation } from "./skill-policy.js";

/**
 * Project wiring: `.pi/extensions/hooknostic.js` re-exports the runtime
 * artifact wherever the build placed it. pi discovers `*.ts`/`*.js` in
 * `.pi/extensions/` (one level; loader.js source, 0.84.4).
 */
export function projectIntegration(artifacts: readonly GeneratedArtifact[], output: string): ProjectIntegration {
  const importPath = (path: string): string =>
    path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
  const files = [
    {
      path: ".pi/extensions/.gitattributes",
      contents: ".gitattributes -text\nhooknostic.js -text\n",
    },
    ...artifacts
      .filter((a) => a.path.startsWith(".pi/extensions/"))
      .map((a) => ({
        path: a.path,
        contents: `export { default } from ${JSON.stringify("../../" + importPath(output + "/" + a.path))};\n`,
      })),
  ];
  return {
    files,
    entries: [],
    guidance: [
      "Start pi in the project (or /reload) to discover .pi/extensions; execution has not been observed by this command.",
    ],
  };
}

/**
 * Project components. pi discovers skills through its own directories and the
 * `pi` package manifest -- a project integration has no skills key to
 * declare, so the filtered inventory is copied to `.pi/skills/` where pi's
 * project-local discovery finds it (skills.js source: SKILL.md folders).
 * pi has no native MCP channel (0.84.4 type surface has no MCP machinery;
 * MCP arrives via third-party extensions), so the MCP component is reported
 * unsupported rather than translated into something that would not load.
 */
export async function projectComponents(
  source: ProjectComponents,
  root: string,
  _output: string,
  _config: string,
  _options: ProjectComponentOptions,
): Promise<ProjectIntegration> {
  const result = projectSkillFiles(source, root, ".pi/skills", { target: RELATIVE_SKILL_TEXT, harness: "Pi" });
  const defaultAgent = source.agents?.find((agent) => agent.name === source.defaultAgent);
  if (defaultAgent !== undefined) {
    result.files.push(
      ...projectAgentFiles([defaultAgent], ".pi", (agent) => ({
        file: "APPEND_SYSTEM.md",
        contents: agent.instructions,
      })).files,
    );
    result.guidance.push(
      `Start Pi at the trusted project root to use the ${defaultAgent.name} default role from .pi/APPEND_SYSTEM.md. ` +
        "It preserves Pi's base prompt or .pi/SYSTEM.md, shadows the global APPEND_SYSTEM.md, and is bypassed by --append-system-prompt. " +
        "Only instructions are projected; model, thinking and tools keep their native defaults. " +
        "This does not offer delegation, named agent selection, or agent-scoped hooks.",
    );
  }
  return result;
}

const nativeProjectComponentProfiles: readonly AgentPluginProjectionProfile[] = [
  {
    range: piHarness.recommendedRange,
    components: {
      "agents.definition": {
        level: "unsupported",
        rationale:
          "Pi has no captured native named-agent or delegation route. A selected primary-only default uses agents.default independently.",
      },
      "agents.primary": {
        level: "unsupported",
        rationale:
          "Pi has no captured native named primary-agent selection route; a fixed default role is handled separately.",
      },
      "agents.native": { level: "unsupported", rationale: "This adapter does not project native agent fields." },
      "agents.default": {
        level: "emulated",
        rationale:
          "The selected default's instructions are written to owned .pi/APPEND_SYSTEM.md, preserving the base or custom system prompt. Windows loopback capture establishes trusted project-root startup only: this file shadows the global append, --append-system-prompt bypasses it, and nested startup ignores it. No named selection, delegation, native settings, or agent identity is supplied; agent-scoped hooks remain unsupported.",
      },
      "agent-plugin.skills": {
        level: "exact",
        rationale:
          "Pi discovers .pi/skills and .agents/skills. Its explicit skill body tells the model to resolve references against the skill directory, so ${SKILL_DIR} projects to `.` in the body (ADR-0028).",
        degradations: [
          {
            id: SKILL_REFERENCE_UNEXPANDED,
            summary:
              "Pi leaves Claude and Agent Plugin placeholders literal; frontmatter references and an in-place ${SKILL_DIR} cannot be rewritten.",
            evidence: piFeatureValidation.artifact,
          },
        ],
      },
      "agent-plugin.mcp.stdio": {
        level: "unsupported",
        omission: piMcpOmissions.stdio,
        rationale:
          "pi 0.84.x has no native MCP channel in its type surface; MCP arrives via third-party extensions, which a project integration cannot wire on the harness's behalf.",
      },
      "agent-plugin.mcp.streamable-http": {
        level: "unsupported",
        omission: piMcpOmissions["streamable-http"],
        rationale:
          "pi 0.84.x has no native MCP channel in its type surface; MCP arrives via third-party extensions, which a project integration cannot wire on the harness's behalf.",
      },
      "agent-plugin.mcp.sse": {
        level: "unsupported",
        omission: piMcpOmissions.sse,
        rationale:
          "pi 0.84.x has no native MCP channel in its type surface; MCP arrives via third-party extensions, which a project integration cannot wire on the harness's behalf.",
      },
      "agent-plugin.client-extension.files": {
        level: "unsupported",
        rationale: "pi reads no portable client-extension namespace; extensions are the only code surface.",
      },
      "agent-plugin.runtime-package": {
        level: "unsupported",
        rationale:
          "pi loads project extensions from .pi/extensions/ with no install step, so a manifest and lockfile written beside the extension would leave no node_modules. Bundle a Node component's dependencies into the generated artifact.",
      },
    },
    source: {
      date: "2026-09-27",
      validatedOn: [
        piFeatureValidation,
        {
          version: "0.84.4",
          date: "2026-09-27",
          method: "live-probe",
          artifact: ".capture/pi/README.md",
          what: "project sync and verify in a fresh project; the discovered skill reached model input and the generated extension rewrote a shell command in Pi loopback playback",
        },
        {
          version: "0.84.4",
          date: "2026-09-27",
          method: "captured",
          artifact: ".capture/pi/README.md",
          what: "pi package skill discovery verified by effect (installed package skill answered its prompt); project-local .pi/ discovery per loader.js and skills.js source.",
        },
        {
          version: piHarness.referenceVersion,
          date: "2026-10-17",
          method: "live-probe",
          artifact: ".capture/pi-default-agent",
          what: "Windows loopback investigation of native project role emulation: prompt replacement and appending, trust, global and CLI precedence, nested working directories, model/thinking/tool defaults, and a minimal project prompt callback. Establishes the native append route's limits; named agents and delegation were not supplied.",
        },
        {
          version: piHarness.referenceVersion,
          date: "2026-10-17",
          method: "live-probe",
          artifact: ".capture/pi-default-agent/evidence/win32.json",
          what: "Generated-default prototype: core sync and verify deliver a portable primary default to .pi/APPEND_SYSTEM.md. Windows Pi startup receives its instructions at developer level with native or custom system prompts, project context and a projected skill; read executes normally. CLI append bypasses it; untrusted startup ignores it. Tool callbacks have no role identity (packages/cli/test/pi-default-agent-playback.test.ts).",
        },
      ],
    },
  },
];
export const projectComponentProfiles = skillInvocationPolicyProfiles(
  nativeProjectComponentProfiles,
  piProjectSkillPolicyValidation,
  PI_SKILL_POLICY_RATIONALE,
);
