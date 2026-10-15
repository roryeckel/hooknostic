import type {
  AgentPluginIssue,
  AgentPluginProjectionFile,
  AgentPluginProjectionPlan,
  AgentPluginProjector,
} from "@hooknostic/agent-plugin";
import {
  assertPackageDelivery,
  componentSummary,
  isRejectedSkillPath,
  materializedPackageFiles,
  npmPublicationProblems,
  projectPackageSkillTexts,
  RELATIVE_SKILL_TEXT,
  SKILL_REFERENCE_UNEXPANDED,
  skillInvocationPolicyProfiles,
  withSkillInvocationPolicy,
} from "@hooknostic/agent-plugin";
import type { TargetSpec } from "@hooknostic/core";

import { PACKAGE_EXTENSION_PATH, PACKAGE_MANIFEST_PATH } from "./generate.js";
import { piHarness } from "./harness.js";
import { piFeatureValidation } from "./profile.js";
import { PI_SKILL_POLICY_RATIONALE, piPackageSkillPolicyValidation, piSkillPolicy } from "./skill-policy.js";

const PACKAGE_DIR = "package";
const PACKAGE_BOUNDARY = `${PACKAGE_DIR}/package.json`;

/** The pi manifest points only at accepted skills, not a directory containing rejected SKILL.md files. */
const nativePiAgentPluginProjector: AgentPluginProjector<TargetSpec> = {
  namespace: "",
  packageRoot: PACKAGE_DIR,
  profiles: [
    {
      range: piHarness.recommendedRange,
      components: {
        "agent-plugin.manifest": {
          level: "exact",
          rationale:
            "Portable package identity is emitted in the npm package.json; pi reads its pi resource declarations from the same file.",
        },
        "agent-plugin.skills": {
          level: "exact",
          rationale:
            "Accepted skills are named explicitly in the pi manifest. ${SKILL_DIR} projects to `.` in the body: Pi leaves references literal and tells the model to resolve relative paths against the skill directory (ADR-0028).",
          degradations: [
            {
              id: SKILL_REFERENCE_UNEXPANDED,
              summary:
                "Pi leaves Claude and Agent Plugin placeholders literal; frontmatter references cannot be rewritten.",
              evidence: piFeatureValidation.artifact,
            },
          ],
        },
        "agent-plugin.mcp.stdio": {
          level: "unsupported",
          rationale:
            "pi has no native MCP channel in 0.84.4; third-party extensions cannot establish a portable MCP package contract.",
        },
        "agent-plugin.mcp.streamable-http": {
          level: "unsupported",
          rationale:
            "pi has no native MCP channel in 0.84.4; third-party extensions cannot establish a portable MCP package contract.",
        },
        "agent-plugin.mcp.sse": {
          level: "unsupported",
          rationale:
            "pi has no native MCP channel in 0.84.4; third-party extensions cannot establish a portable MCP package contract.",
        },
        "agent-plugin.client-extension.files": {
          level: "unsupported",
          rationale: "pi does not read Agent Plugins client-extension namespaces.",
        },
        "agent-plugin.runtime-package": {
          level: "unsupported",
          rationale:
            "A local-path pi package is referenced in place, with no npm install. An npm-sourced package is installed, but pi does not perform a locked npm ci of the portable runtime manifest and lockfile; this component is not delivered on both routes.",
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
            what: "projected package installed by npm coordinate from a local read-only registry; Pi loaded its skill and honored its bundled hook in loopback playback",
          },
          {
            version: "0.84.4",
            date: "2026-09-27",
            method: "captured",
            artifact: ".capture/pi/README.md",
            what: "A local pi package declaring an extension and skill in its pi manifest loaded both, verified by marker file and model-visible skill; resource and install routes also inspected in the 0.84.4 package manager.",
          },
          {
            version: "0.84.4",
            date: "2026-09-27",
            method: "live-probe",
            artifact: ".capture/pi/README.md",
            what: "The projected package installed through an isolated local-path pi install loaded its skill into model input and honoured its compiled hook's shell rewrite against a loopback model.",
          },
        ],
      },
    },
  ],
  project: async (source, context): Promise<AgentPluginProjectionPlan> => {
    assertPackageDelivery("pi", context.target.delivery);
    const files: AgentPluginProjectionFile[] = [];
    const copiedPaths: string[] = [];
    const issues: AgentPluginIssue[] = [];
    const omissions: AgentPluginProjectionPlan["summary"]["omissions"] = [];
    const rejected = isRejectedSkillPath(source);
    const skillTexts = projectPackageSkillTexts(
      source.skills,
      (path) => source.files.find((file) => file.path === path)?.contents,
      RELATIVE_SKILL_TEXT,
      "Pi",
    );

    // Keep the author's files together, one level below the generated npm
    // manifest. The root manifest selects only the resources we validated.
    for (const file of source.files) {
      if (rejected(file.path)) continue;
      const path = `${PACKAGE_DIR}/${file.path}`;
      files.push({ path, contents: skillTexts.rewritten.get(file.path) ?? file.contents, mode: file.mode });
      if (!skillTexts.rewritten.has(file.path)) copiedPaths.push(path);
    }
    const materialized = materializedPackageFiles(context.materializedTrees, {
      prefix: `${PACKAGE_DIR}/`,
      claimed: new Set(files.map((file) => file.path)),
    });
    issues.push(...materialized.issues);
    files.push(...materialized.files);

    // The root is ESM for the bundled extension. Do not silently change an
    // author's .js files to ESM: without their own package.json Node would
    // otherwise inherit the generated root's type across the package/ tree.
    if (!copiedPaths.includes(PACKAGE_BOUNDARY) && !materialized.files.some((file) => file.path === PACKAGE_BOUNDARY)) {
      files.push({ path: PACKAGE_BOUNDARY, contents: '{"type":"commonjs"}\n' });
    }

    const hookPaths = new Set(context.hookArtifacts.map((artifact) => artifact.path.toLowerCase()));
    const hasHooks = hookPaths.has(PACKAGE_EXTENSION_PATH);
    const npmName = context.target.npmName ?? source.manifest.name;
    for (const problem of npmPublicationProblems({
      name: npmName,
      version: source.manifest.version,
      npmNameDeclared: context.target.npmName !== undefined,
    })) {
      issues.push({
        severity: problem.severity,
        scope: "projection",
        component: "agent-plugin.manifest",
        path: PACKAGE_MANIFEST_PATH,
        message: problem.message,
      });
    }
    const manifest = {
      name: npmName,
      ...(source.manifest.version === undefined ? {} : { version: source.manifest.version }),
      ...(source.manifest.description === undefined ? {} : { description: source.manifest.description }),
      ...(source.manifest.author === undefined ? {} : { author: source.manifest.author }),
      ...(source.manifest.homepage === undefined ? {} : { homepage: source.manifest.homepage }),
      ...(source.manifest.repository === undefined ? {} : { repository: source.manifest.repository }),
      ...(source.manifest.license === undefined ? {} : { license: source.manifest.license }),
      ...(source.manifest.keywords === undefined ? {} : { keywords: source.manifest.keywords }),
      type: "module",
      pi: {
        ...(hasHooks ? { extensions: [`./${PACKAGE_EXTENSION_PATH}`] } : {}),
        ...(source.skills.length > 0
          ? { skills: source.skills.map((skill) => `./${PACKAGE_DIR}/${skill.directory}`) }
          : {}),
      },
    };
    files.push({ path: PACKAGE_MANIFEST_PATH, contents: `${JSON.stringify(manifest, null, 2)}\n` });
    const taken = new Map(files.map((file) => [file.path.toLowerCase(), file.path]));
    for (const artifact of context.hookArtifacts) {
      if (artifact.path.toLowerCase() === PACKAGE_MANIFEST_PATH) continue;
      const occupied = taken.get(artifact.path.toLowerCase());
      if (occupied !== undefined) {
        issues.push({
          severity: "error",
          scope: "projection",
          path: artifact.path,
          message: `generated hook path ${JSON.stringify(artifact.path)} collides with ${JSON.stringify(occupied)}`,
        });
        continue;
      }
      taken.set(artifact.path.toLowerCase(), artifact.path);
      files.push({ ...artifact });
    }
    for (const [name, server] of Object.entries(source.mcp?.mcpServers ?? {})) {
      omissions.push({ component: `agent-plugin.mcp.${server.type}`, name, reason: "pi has no native MCP channel" });
    }
    if (context.runtimePackage !== undefined) {
      omissions.push({
        component: "agent-plugin.runtime-package",
        reason:
          "pi does not install the portable manifest and lockfile for local-path packages; bundle dependencies or materialize them explicitly",
      });
    }
    const counts = componentSummary(source, {
      hasRuntimePackage: context.runtimePackage !== undefined,
      skipped: (component, discovered) =>
        component.startsWith("agent-plugin.mcp.") || component === "agent-plugin.runtime-package" ? discovered : 0,
    });
    return {
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
      directories: (source.directories ?? [])
        .filter((directory) => !rejected(`${directory}/`))
        .map((directory) => `${PACKAGE_DIR}/${directory}`),
      issues,
      summary: {
        components: counts,
        omissions,
        copiedPaths: copiedPaths.sort((a, b) => a.localeCompare(b)),
        ...(skillTexts.degradations.length ? { degradations: skillTexts.degradations } : {}),
      },
    };
  },
};
export const piAgentPluginProjector = withSkillInvocationPolicy(
  {
    ...nativePiAgentPluginProjector,
    profiles: skillInvocationPolicyProfiles(
      nativePiAgentPluginProjector.profiles,
      piPackageSkillPolicyValidation,
      PI_SKILL_POLICY_RATIONALE,
    ),
  },
  "pi",
  piSkillPolicy,
);
