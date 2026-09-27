import type { ProjectComponents } from "@hooknostic/agent-plugin";
import type { AgentPluginProjectionProfile } from "@hooknostic/agent-plugin";
import type { GeneratedArtifact, ProjectComponentOptions, ProjectIntegration } from "@hooknostic/core";
import { projectSkillFiles } from "@hooknostic/core";

import { piHarness } from "./harness.js";

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
  const result = projectSkillFiles(source, root, ".pi/skills");
  return result;
}

export const projectComponentProfiles: readonly AgentPluginProjectionProfile[] = [
  {
    range: piHarness.recommendedRange,
    components: {
      "agent-plugin.skills": {
        level: "exact",
        rationale:
          "pi implements the Agent Skills standard natively (SKILL.md + frontmatter; skills.js source 0.84.4) and discovers project-local skills from .pi/skills/.",
      },
      "agent-plugin.mcp.stdio": {
        level: "unsupported",
        rationale:
          "pi 0.84.x has no native MCP channel in its type surface; MCP arrives via third-party extensions, which a project integration cannot wire on the harness's behalf.",
      },
      "agent-plugin.mcp.streamable-http": {
        level: "unsupported",
        rationale:
          "pi 0.84.x has no native MCP channel in its type surface; MCP arrives via third-party extensions, which a project integration cannot wire on the harness's behalf.",
      },
      "agent-plugin.mcp.sse": {
        level: "unsupported",
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
        {
          version: "0.84.4",
          date: "2026-09-27",
          method: "captured",
          artifact: ".capture/pi/README.md",
          what: "pi package skill discovery verified by effect (installed package skill answered its prompt); project-local .pi/ discovery per loader.js and skills.js source.",
        },
      ],
    },
  },
];
