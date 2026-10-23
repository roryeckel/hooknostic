import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import {
  type AgentDefinition,
  type AgentPluginDegradation,
  type AgentPluginMcpServer,
  type ProjectComponents,
  projectSkillText,
  SKILL_REFERENCE_UNEXPANDED,
  type SkillTextTarget,
  unexpandedSkillReferenceReason,
} from "@hooknostic/agent-plugin";

import { bundleMcpLauncher, MCP_LAUNCHER_FILE, MCP_SERVERS_FILE, type McpLauncherServer } from "./mcp-launcher.js";
import { portableRelative } from "./portable-path.js";
import type { ProjectIntegration } from "./project-files.js";

/**
 * One owned file per agent definition under `destination`, plus a `.gitattributes`
 * naming exactly those files. Ownership compares bytes, so git must never
 * rewrite their line endings. Naming files rather than `**` leaves an author's
 * own agents in the same directory alone. Rendering is the adapter's; this only
 * places what it returns.
 */
export function projectAgentFiles(
  agents: readonly AgentDefinition[],
  destination: string,
  render: (agent: AgentDefinition) => { file: string; contents: string },
): ProjectIntegration {
  if (agents.length === 0) return { files: [], entries: [], guidance: [] };
  const rendered = agents.map(render);
  const files = rendered.map(({ file, contents }) => ({ path: `${destination}/${file}`, contents, mode: 0o644 }));
  files.push({
    path: `${destination}/.gitattributes`,
    contents: [".gitattributes", ...rendered.map(({ file }) => file)].map((file) => `${file} -text\n`).join(""),
    mode: 0o644,
  });
  return { files, entries: [], guidance: [] };
}
/**
 * Copy each skill into the project's `destination` tree, writing the target's
 * form of `${SKILL_DIR}` into its SKILL.md body (ADR-0028). A skill that
 * already sits at its destination is discovered in place and left alone; its
 * references are only reported. Each skill whose text still holds a reference
 * the target shows as written is a `skill-reference-unexpanded` degradation.
 * A rewritten body token also reports the target's directory shortfall, if any.
 * An undefined text policy preserves bytes when expansion is not yet captured.
 */
export function projectSkillFiles(
  source: ProjectComponents,
  root: string,
  destination: string,
  text: { target: SkillTextTarget; harness: string } | undefined,
): ProjectIntegration {
  const relinquishFiles: string[] = [];
  const relinquishPrefixes: string[] = [];
  const unappliedModes: { skill: string; path: string }[] = [];
  const degradations: AgentPluginDegradation[] = [];
  const files = source.skills.flatMap((skill) => {
    const path = `${destination}/${skill.name}`;
    const canonical = (input: string) => {
      try {
        return realpathSync.native(input);
      } catch {
        return resolve(input);
      }
    };
    const inPlace = canonical(resolve(root, path)) === canonical(skill.source);
    const manifest = skill.files.find((file) => file.path === "SKILL.md");
    const projected =
      manifest === undefined || text === undefined
        ? undefined
        : projectSkillText(manifest.contents, text.target, { rewrite: !inPlace });
    if (text !== undefined && projected !== undefined && projected.unexpanded.length > 0) {
      degradations.push({
        id: SKILL_REFERENCE_UNEXPANDED,
        component: "agent-plugin.skills",
        name: skill.name,
        path: `${path}/SKILL.md`,
        reason: unexpandedSkillReferenceReason(skill.name, projected.unexpanded, text.harness, {
          inPlace,
          ...(projected.inFrontmatter ? { inFrontmatter: true } : {}),
        }),
      });
    }
    if (projected?.directoryDegradation) {
      degradations.push({
        ...projected.directoryDegradation,
        component: "agent-plugin.skills",
        name: skill.name,
        path: `${path}/SKILL.md`,
      });
    }
    if (inPlace) {
      relinquishPrefixes.push(path);
      // Derived rather than passed in: on both component routes 0755 is only
      // ever reached by declaration (ADR-0013 ignores the host bit), so a
      // declared entry is exactly a 0755 file here. Passing the declaration
      // down instead would give this function a second source of truth about
      // which files were named, free to disagree with the modes it is holding.
      for (const file of skill.files) {
        if (file.mode === 0o755) unappliedModes.push({ skill: skill.name, path: file.path });
      }
      return [];
    }
    return skill.files.map((file) => ({
      ...file,
      path: `${path}/${file.path}`,
      ...(file === manifest && projected?.contents !== undefined ? { contents: projected.contents } : {}),
    }));
  });
  if (files.length)
    files.push({
      path: `${destination}/.gitattributes`,
      contents: new TextEncoder().encode("** -text\n"),
      mode: 0o644,
    });
  else if (relinquishPrefixes.length) relinquishFiles.push(`${destination}/.gitattributes`);
  return {
    files,
    entries: [],
    guidance: [],
    ...(unappliedModes.length ? { unappliedModes } : {}),
    ...(degradations.length ? { degradations } : {}),
    ...(relinquishFiles.length ? { relinquishFiles } : {}),
    ...(relinquishPrefixes.length ? { relinquishPrefixes } : {}),
  };
}
/**
 * The `share` string for a server entry in a root `.mcp.json`: the server's
 * portable definition after the target's overrides, with keys in a stable
 * order. Every project launcher bundles the same front end and reads the same
 * record, so two targets whose definitions are equal emit entries that each
 * run correctly for either harness, and one entry serves both (ADR-0033).
 */
export function sharedMcpServerKey(server: AgentPluginMcpServer): string {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
          )
        : value;
  return JSON.stringify(stable(server));
}

export async function projectMcpLauncher(
  source: ProjectComponents,
  root: string,
  output: string,
  selectedServers?: McpLauncherServer[],
): Promise<ProjectIntegration> {
  if (!source.mcp) return { files: [], entries: [], guidance: [] };
  const servers =
    selectedServers ??
    Object.entries(source.mcp.config.mcpServers)
      .filter(([, s]) => s.type === "stdio")
      .map(([name, s]) => ({ name, ...s }));
  if (!servers.length) return { files: [], entries: [], guidance: [] };
  // The loaded MCP source and the runtime's import.meta.url are real paths.
  // Keep their relative offsets independent of the caller's project alias.
  root = await realpath(root);
  const relativeToOutput = (path: string) => portableRelative(resolve(root, output), path);
  const launcher = await bundleMcpLauncher({
    frontEnd: "self-resolving",
    rootOffset: relativeToOutput(source.mcp.root),
    dataOffset: relativeToOutput(resolve(root, ".hooknostic/data")),
    pluginName: "project",
    environmentReferences: source.origin === "direct",
  });
  return {
    files: [
      { path: `${output}/.gitattributes`, contents: "* -text\n" },
      { path: `${output}/${MCP_LAUNCHER_FILE}`, contents: launcher },
      {
        path: `${output}/${MCP_SERVERS_FILE}`,
        contents: JSON.stringify({ plugin: "project", servers }, null, 2) + "\n",
      },
    ],
    entries: [],
    guidance: [],
  };
}
