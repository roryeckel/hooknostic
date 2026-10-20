import { realpath } from "node:fs/promises";
import * as nodePath from "node:path";
import { resolve } from "node:path";

import type { ProjectComponents } from "@hooknostic/agent-plugin";
import type { AgentPluginProjectionProfile } from "@hooknostic/agent-plugin";
import {
  RELATIVE_SKILL_TEXT,
  SKILL_REFERENCE_UNEXPANDED,
  skillInvocationPolicyProfiles,
} from "@hooknostic/agent-plugin";
import type { GeneratedArtifact, ProjectComponentOptions, ProjectIntegration } from "@hooknostic/core";
import { MCP_LAUNCHER_FILE, portableRelative, projectMcpLauncher, projectSkillFiles } from "@hooknostic/core";

import {
  legacyPiMcpCells,
  nativePiMcpCells,
  nativePiMcpValidations,
  type PiMcpCells,
  piMcpExtensionSource,
  piNamespace,
  translatePiMcp,
} from "./mcp.js";
import { PI_LEGACY_RANGE, PI_RANGE, piFeatureValidation, piLegacyFeatureValidation } from "./profile.js";
import {
  PI_SKILL_POLICY_RATIONALE,
  piLegacyProjectSkillPolicyValidation,
  piProjectSkillPolicyValidation,
} from "./skill-policy.js";

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
      // Both generated modules are hashed for ownership, so checkout must not
      // convert either one's line endings.
      contents: ".gitattributes -text\nhooknostic.js -text\nhooknostic-mcp.js -text\n",
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
 *
 * MCP servers (pi 1.x, .capture/pi-mcp) are registered by a generated
 * `.pi/extensions/hooknostic-mcp.js`, stdio ones through the shared launcher
 * under the output, so the project's `.pi/mcp.json` stays the user's. pi
 * 0.84 has no native MCP channel; its profile rates every transport
 * unsupported, and core reports those servers as skipped.
 */
export async function projectComponents(
  source: ProjectComponents,
  root: string,
  output: string,
  _config: string,
  options: ProjectComponentOptions,
): Promise<ProjectIntegration> {
  const result = projectSkillFiles(source, root, ".pi/skills", { target: RELATIVE_SKILL_TEXT, harness: "Pi" });
  if (!source.mcp) return result;
  // Core always resolves the matrix for the target range; a caller without
  // one (a direct integration call) gets the reference build's cells.
  const support: NonNullable<ProjectComponentOptions["support"]> = options.support ?? nativePiMcpCells;
  const mcp = translatePiMcp(source.mcp.config.mcpServers, support, new Set(options.mcpProjectCwdServers));
  // An unsupported transport is core's to report. An omission inside a
  // supported one goes to core as a project omission, which applies
  // components.onUnsupported and moves the server from emitted to skipped.
  const omissions = mcp.omitted.filter((omission) => support[omission.component]?.level !== "unsupported");
  if (omissions.length > 0) result.omissions = [...(result.omissions ?? []), ...omissions];
  if (mcp.registrations.length === 0) return result;
  // Between real paths, as the launcher's own offsets are: the loaded source
  // root is already canonical, and the generated module takes its own
  // directory's real path, so a project reached through a junction or symlink
  // puts neither end of an offset on the wrong side of it.
  const projectRoot = await realpath(root);
  if (mcp.launcherServers.length > 0) {
    const launcher = await projectMcpLauncher(source, projectRoot, output, mcp.launcherServers);
    result.files.push(...launcher.files);
  }
  result.files.push({
    path: MCP_EXTENSION_PATH,
    contents: piMcpExtensionSource({
      registrations: mcp.registrations,
      rootFromHere: piExtensionsRelative(projectRoot, source.mcp.root),
      launcherFromHere: piExtensionsRelative(projectRoot, resolve(projectRoot, output, MCP_LAUNCHER_FILE)),
      // A project's own declarations resolve their ${NAME} references from the
      // launch environment, as on the other targets; a package's never do.
      resolveEnvironment: source.origin === "direct",
    }),
  });
  // pi gives a .pi/mcp.json server precedence over a registered one whose name
  // differs only in `-` and `_`, so an unowned entry under any such spelling
  // would silently replace ours. The user-level ~/.pi/agent/mcp.json has the
  // same precedence but is outside the project, so no sync can check it.
  result.absent = [
    ...(result.absent ?? []),
    ...mcp.registrations.map(({ name }) => ({ path: ".pi/mcp.json", key: ["mcpServers", name], fold: piNamespace })),
  ];
  return result;
}

/** The generated extension registering the project's MCP servers. */
const MCP_EXTENSION_PATH = ".pi/extensions/hooknostic-mcp.js";

/**
 * The path the generated `.pi/extensions` module resolves against its own
 * directory to reach `target`: relative where one exists, absolute across
 * Windows drives and UNC shares (portableRelative). Prefixing a root-relative
 * offset with `../../` would corrupt that absolute form.
 */
export function piExtensionsRelative(
  projectRoot: string,
  target: string,
  paths: Pick<typeof nodePath, "join" | "parse" | "relative" | "resolve" | "sep"> = nodePath,
): string {
  return portableRelative(paths.join(projectRoot, ".pi", "extensions"), target, paths);
}

/** Both lines rate the same components; only the MCP cells differ. */
const piProjectComponents = (mcp: PiMcpCells): AgentPluginProjectionProfile["components"] => ({
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
  ...mcp,
  "agent-plugin.client-extension.files": {
    level: "unsupported",
    rationale: "pi reads no portable client-extension namespace; extensions are the only code surface.",
  },
  "agent-plugin.runtime-package": {
    level: "unsupported",
    rationale:
      "pi loads project extensions from .pi/extensions/ with no install step, so a manifest and lockfile written beside the extension would leave no node_modules. Bundle a Node component's dependencies into the generated artifact.",
  },
});

const legacyProjectComponentProfile: AgentPluginProjectionProfile = {
  range: PI_LEGACY_RANGE,
  components: piProjectComponents(
    legacyPiMcpCells(
      "pi 0.84.x has no native MCP channel in its type surface; MCP arrives via third-party extensions, which a project integration cannot wire on the harness's behalf.",
    ),
  ),
  source: {
    date: "2026-09-27",
    validatedOn: [
      piLegacyFeatureValidation,
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
    ],
  },
};

const projectComponentProfile: AgentPluginProjectionProfile = {
  range: PI_RANGE,
  components: piProjectComponents(nativePiMcpCells),
  source: {
    date: "2026-10-19",
    validatedOn: [
      piFeatureValidation,
      ...nativePiMcpValidations,
      {
        version: "1.3.0",
        date: "2026-10-19",
        method: "live-probe",
        artifact: ".capture/harness-playback/",
        what: "HOOKNOSTIC_PLAYBACK=pi project sync in a fresh project: the skill reached model input from pi's discovery path and the generated .pi/extensions hook rewrote a shell command against the loopback model",
      },
      {
        version: "1.3.0",
        date: "2026-10-19",
        method: "live-probe",
        artifact: ".capture/harness-playback/",
        what: "HOOKNOSTIC_PLAYBACK=pi repository-local integration: the generated .pi/extensions/hooknostic-mcp.js registered a direct source's stdio server through the launcher (absolute PLUGIN_ROOT, PLUGIN_DATA under .hooknostic/data, the project-anchored cwd, and ${NAME:-default} args resolved) and its streamable HTTP server with the URL and a header resolved from the environment and a literal $ preserved; a server naming a missing variable was disabled with a warning, and a codemode script's calls to both reached the hooks as mcp tools",
      },
    ],
  },
};

export const projectComponentProfiles = [
  ...skillInvocationPolicyProfiles(
    [legacyProjectComponentProfile],
    piLegacyProjectSkillPolicyValidation,
    PI_SKILL_POLICY_RATIONALE,
  ),
  ...skillInvocationPolicyProfiles(
    [projectComponentProfile],
    piProjectSkillPolicyValidation,
    PI_SKILL_POLICY_RATIONALE,
  ),
];
