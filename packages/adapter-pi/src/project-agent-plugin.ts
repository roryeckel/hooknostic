import type {
  AgentPluginIssue,
  AgentPluginProjectionFile,
  AgentPluginProjectionPlan,
  AgentPluginProjectionProfile,
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
import type { McpLauncherDocument, TargetSpec } from "@hooknostic/core";
import { bundleMcpLauncher, MCP_LAUNCHER_FILE, MCP_SERVERS_FILE } from "@hooknostic/core";

import { PACKAGE_EXTENSION_PATH, PACKAGE_MANIFEST_PATH } from "./generate.js";
import { legacyPiMcpCells, nativePiMcpCells, type PiMcpCells, piMcpExtensionSource, translatePiMcp } from "./mcp.js";
import { piFeatureValidation, piLegacyFeatureValidation } from "./profile.js";
import {
  PI_SKILL_POLICY_RATIONALE,
  piLegacyPackageSkillPolicyValidation,
  piPackageSkillPolicyValidation,
  piSkillPolicy,
} from "./skill-policy.js";

const PACKAGE_DIR = "package";
const PACKAGE_BOUNDARY = `${PACKAGE_DIR}/package.json`;
/** The generated extension registering the package's MCP servers, beside the hooks extension. */
const MCP_EXTENSION_PATH = "hooknostic-mcp.js";
/** The launcher and its servers document, a sibling of the copied package rather than inside it. */
const LAUNCHER_DIR = "hooknostic-runtime";
const LAUNCHER_PATH = `${LAUNCHER_DIR}/${MCP_LAUNCHER_FILE}`;
const LAUNCHER_SERVERS_PATH = `${LAUNCHER_DIR}/${MCP_SERVERS_FILE}`;

/** Both lines rate the same package components; only the MCP rationale differs. */
const piPackageComponents = (mcp: PiMcpCells): AgentPluginProjectionProfile["components"] => ({
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
        summary: "Pi leaves Claude and Agent Plugin placeholders literal; frontmatter references cannot be rewritten.",
        evidence: piFeatureValidation.artifact,
      },
    ],
  },
  ...mcp,
  "agent-plugin.client-extension.files": {
    level: "unsupported",
    rationale: "pi does not read Agent Plugins client-extension namespaces.",
  },
  "agent-plugin.runtime-package": {
    level: "unsupported",
    rationale:
      "A local-path pi package is referenced in place, with no npm install. An npm-sourced package is installed, but pi does not perform a locked npm ci of the portable runtime manifest and lockfile; this component is not delivered on both routes.",
  },
});

/** The pi manifest points only at accepted skills, not a directory containing rejected SKILL.md files. */
const nativePiAgentPluginProjector: AgentPluginProjector<TargetSpec> = {
  namespace: "",
  packageRoot: PACKAGE_DIR,
  profiles: [
    {
      range: ">=0.84 <1",
      components: piPackageComponents(
        legacyPiMcpCells(
          "pi has no native MCP channel in 0.84.4; third-party extensions cannot establish a portable MCP package contract.",
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
    {
      range: ">=1 <2",
      components: piPackageComponents(nativePiMcpCells),
      source: {
        date: "2026-10-19",
        validatedOn: [
          piFeatureValidation,
          {
            version: "1.3.0",
            date: "2026-10-19",
            method: "schema-derived",
            artifact: ".capture/pi/README.md",
            what: "installed @earendil-works/pi-coding-agent 1.3.0 docs/mcp.md and resolve-config-value source: native MCP since 0.99.0, registered by extensions or read from mcp.json files; stdio and streamable HTTP only, with SSE rejected; $ and $! escape pi's value expansion",
          },
          {
            version: "1.3.0",
            date: "2026-10-19",
            method: "live-probe",
            artifact: ".capture/pi-mcp/README.md",
            what: "Loopback pi sessions with a recording MCP server: pi.registerMcpServer from a -e extension, a pi package extension, and a trusted project .pi/mcp.json each started the stdio server (an untrusted one did not); args reached it literally except ~/, env values merged over the parent environment with $NAME, ${NAME}, $ and $! resolved, an unset reference silently kept the server from starting, and an explicit cwd was honoured. Streamable HTTP header values honoured $ and $!, and a codemode script's MCP call reached tool_call and tool_result as a nested call",
          },
          {
            version: "1.3.0",
            date: "2026-10-19",
            method: "live-probe",
            artifact: ".capture/harness-playback/",
            what: "HOOKNOSTIC_PLAYBACK=pi: the projected package installed through pi install -l --approve by local path and by npm coordinate from a local read-only registry loaded its skill into model input and honoured its compiled hook's shell rewrite against the loopback model",
          },
          {
            version: "1.3.0",
            date: "2026-10-19",
            method: "live-probe",
            artifact: ".capture/harness-playback/",
            what: "HOOKNOSTIC_PLAYBACK=pi, by local path and by npm coordinate: the package's generated hooknostic-mcp.js registered its stdio server through the launcher, which bound PLUGIN_ROOT to the installed author package and an absolute PLUGIN_DATA outside it and passed $literal and ~/ arguments as written, and its streamable HTTP server, whose header beginning with ! and holding ${NAME} and $ arrived as written although the variable was set; a codemode script's calls to both reached the hooks as mcp tools",
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

    // Native MCP (pi 1.x, .capture/pi-mcp): a generated extension registers the
    // servers, stdio ones through the shared launcher. A transport the target
    // range cannot represent -- every one on 0.84, SSE on 1.x -- is omitted
    // with its cell's rationale.
    const mcp = translatePiMcp(source.mcp?.mcpServers ?? {}, context.support);
    for (const omission of mcp.omitted) {
      omissions.push(omission);
      // Core reports an unsupported cell. An omission inside a supported
      // transport would otherwise pass without a diagnostic.
      if (context.support[omission.component]?.level === "unsupported") continue;
      issues.push({
        severity: context.onUnsupported,
        scope: "projection",
        component: omission.component,
        path: `mcp.json#${omission.name}`,
        message: `MCP server ${JSON.stringify(omission.name)} was omitted: ${omission.reason}.`,
      });
    }
    const hasMcp = mcp.registrations.length > 0;
    if (hasMcp) {
      files.push({
        path: MCP_EXTENSION_PATH,
        contents: piMcpExtensionSource({
          registrations: mcp.registrations,
          rootFromHere: PACKAGE_DIR,
          launcherFromHere: LAUNCHER_PATH,
          resolveEnvironment: false,
        }),
      });
    }
    if (mcp.launcherServers.length > 0) {
      const document: McpLauncherDocument = { plugin: source.manifest.name, servers: mcp.launcherServers };
      files.push({ path: LAUNCHER_SERVERS_PATH, contents: `${JSON.stringify(document, null, 2)}\n` });
      files.push({
        path: LAUNCHER_PATH,
        contents: await bundleMcpLauncher({
          frontEnd: "self-resolving",
          rootOffset: `../${PACKAGE_DIR}`,
          pluginName: source.manifest.name,
        }),
      });
    }
    const extensions = [
      ...(hasHooks ? [`./${PACKAGE_EXTENSION_PATH}`] : []),
      ...(hasMcp ? [`./${MCP_EXTENSION_PATH}`] : []),
    ];
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
        ...(extensions.length > 0 ? { extensions } : {}),
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
        component.startsWith("agent-plugin.mcp.")
          ? mcp.omitted.filter((omission) => omission.component === component).length
          : component === "agent-plugin.runtime-package"
            ? discovered
            : 0,
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
    profiles: [
      ...skillInvocationPolicyProfiles(
        nativePiAgentPluginProjector.profiles.filter((profile) => profile.range === ">=0.84 <1"),
        piLegacyPackageSkillPolicyValidation,
        PI_SKILL_POLICY_RATIONALE,
      ),
      ...skillInvocationPolicyProfiles(
        nativePiAgentPluginProjector.profiles.filter((profile) => profile.range === ">=1 <2"),
        piPackageSkillPolicyValidation,
        PI_SKILL_POLICY_RATIONALE,
      ),
    ],
  },
  "pi",
  piSkillPolicy,
);
