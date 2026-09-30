import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { minimatch } from "minimatch";

import { parseMarkdownFrontmatter } from "./frontmatter.js";
import { isAgentSkillName } from "./names.js";
import type { AgentPluginIssue } from "./types.js";

/** The Hooknostic Agent Definition version this loader reads (docs/spec/agents/0.1.md). */
export const AGENT_DEFINITION_FORMAT_VERSION = "0.1" as const;

/**
 * Top-level keys a 0.1 file may not use, because a later version may define
 * them. Named rather than folded into "unknown field" so an author reaching for
 * a portable `model` or `tools` is told where the value belongs today.
 */
export const AGENT_DEFINITION_RESERVED_KEYS = [
  "readOnly",
  "tools",
  "model",
  "maxTurns",
  "skills",
  "mcp",
  "hooks",
] as const;

/**
 * Where a harness offers the agent (ADR-0027, decision 9): for delegation
 * (`subagent`, the default), as the agent a session runs as (`primary`), or
 * both (`all`). The values are OpenCode's, the one harness with such a field.
 */
export const AGENT_MODES = ["subagent", "primary", "all"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

/** Whether a definition in `mode` is offered for delegation. */
export function servesAsSubagent(mode: AgentMode): boolean {
  return mode !== "primary";
}

/** Whether a definition in `mode` is offered as the agent a session runs as. */
export function servesAsPrimary(mode: AgentMode): boolean {
  return mode !== "subagent";
}

/**
 * The mode a definition keeps on a target that cannot run a session as an
 * agent: an `all` definition is still a subagent there, and a `primary` one has
 * nothing left to deliver (`undefined`).
 */
export function withoutPrimary(mode: AgentMode): AgentMode | undefined {
  return mode === "primary" ? undefined : "subagent";
}

/**
 * Why no projector delivers `components.defaultAgent` (ADR-0027, decision 10),
 * for the omission each reports.
 */
export const DEFAULT_AGENT_NOT_PACKAGED =
  "a package does not set the default agent, because it would start every session of every user who enables it as that agent; deliver the default to a project target";

/**
 * One agent definition, parsed into the model the specification defines.
 * Adapters translate from this, never from the file, so a future source format
 * mapping onto the same model reaches every harness without translator changes.
 */
export interface AgentDefinition {
  name: string;
  description: string;
  /** `subagent` when the file does not say. */
  mode: AgentMode;
  /** The Markdown body, line endings normalized to LF. */
  instructions: string;
  /** Harness-only fields keyed by harness identifier; empty when the file has none. */
  native: Record<string, Record<string, unknown>>;
  /** Absolute path of the definition file. */
  source: string;
}

export interface LoadAgentDefinitionsOptions {
  /** Directories holding flat `<name>.md` definition files. */
  directories: readonly string[];
  /** Globs matched case-insensitively against each file name, relative to its directory. */
  exclude?: readonly string[];
}

const KEYS = new Set(["name", "description", "mode", "native"]);
const RESERVED = new Set<string>(AGENT_DEFINITION_RESERVED_KEYS);
const HARNESS_KEY = /^[a-z][a-z0-9-]*$/;
const MATCH = { dot: true, nocase: true, nonegate: true, nocomment: true } as const;

function mapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates one file's frontmatter and body into a definition; throws the first problem found. */
function parseDefinition(text: string, stem: string, source: string): AgentDefinition {
  const { data, body } = parseMarkdownFrontmatter(text, "an agent definition");
  if (!mapping(data)) throw new Error("frontmatter must be a mapping");
  for (const key of Object.keys(data)) {
    if (RESERVED.has(key)) {
      throw new Error(
        `\`${key}\` is reserved for a later version of the agent definition format; put a harness's own field under native.<harness>`,
      );
    }
    if (!KEYS.has(key)) throw new Error(`frontmatter contains an unknown field \`${key}\``);
  }
  const { name, description, mode = "subagent", native } = data;
  if (typeof name !== "string" || !isAgentSkillName(name)) {
    throw new Error("name must use lowercase letters and digits in hyphen-separated runs, at most 64 characters");
  }
  if (name !== stem) throw new Error(`name ${JSON.stringify(name)} must equal the file name ${JSON.stringify(stem)}`);
  if (typeof description !== "string" || description.length === 0 || description.length > 1024) {
    throw new Error("description must contain 1-1024 characters");
  }
  if (/[\r\n]/.test(description)) throw new Error("description must be a single line");
  if (!(AGENT_MODES as readonly unknown[]).includes(mode)) {
    throw new Error(`mode must be one of ${AGENT_MODES.join(", ")}`);
  }
  const blocks: Record<string, Record<string, unknown>> = Object.create(null) as Record<
    string,
    Record<string, unknown>
  >;
  if (native !== undefined) {
    if (!mapping(native)) throw new Error("native must map harness identifiers to mappings of that harness's fields");
    for (const [harness, fields] of Object.entries(native)) {
      if (!HARNESS_KEY.test(harness))
        throw new Error(`native key ${JSON.stringify(harness)} is not a harness identifier`);
      if (!mapping(fields)) throw new Error(`native.${harness} must be a mapping of that harness's fields`);
      // defineProperty, not assignment: a harness named __proto__ must not
      // reach the inherited setter and vanish.
      Object.defineProperty(blocks, harness, { value: fields, enumerable: true, writable: true, configurable: true });
    }
  }
  const instructions = body.replace(/\r\n?/g, "\n");
  if (instructions.trim() === "") throw new Error("the instructions (the body after the frontmatter) are empty");
  return { name, description, mode: mode as AgentMode, instructions, native: blocks, source };
}

/**
 * Load every definition in the configured directories.
 *
 * A definition is a `.md` file directly inside a directory: the specification
 * does not scan subdirectories, and a nested file is reported as information so
 * an author used to a recursive harness scan is not left guessing. Invalid files
 * are `warn` issues, which a build maps through `components.onInvalid`, exactly
 * as it does a malformed skill.
 */
export async function loadAgentDefinitions(
  options: LoadAgentDefinitionsOptions,
): Promise<{ agents: AgentDefinition[]; issues: AgentPluginIssue[] }> {
  const issues: AgentPluginIssue[] = [];
  const agents: AgentDefinition[] = [];
  const names = new Map<string, string>();
  for (const configured of options.directories) {
    const directory = resolve(configured);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      issues.push({
        severity: "error",
        scope: "agent",
        component: "agents.definition",
        path: directory,
        message: `could not read agent directory ${JSON.stringify(directory)}: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      if ((options.exclude ?? []).some((pattern) => minimatch(entry.name, pattern, MATCH))) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        issues.push({
          severity: "info",
          scope: "agent",
          component: "agents.definition",
          path,
          message: `subdirectory ${JSON.stringify(entry.name)} is not scanned; agent definitions sit directly in ${JSON.stringify(directory)}`,
        });
        continue;
      }
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      const stem = entry.name.slice(0, -".md".length);
      let definition: AgentDefinition;
      try {
        definition = parseDefinition(await readFile(path, "utf8"), stem, path);
      } catch (error) {
        issues.push({
          severity: "warn",
          scope: "agent",
          component: "agents.definition",
          path,
          message: `agent ${JSON.stringify(stem)} is invalid and was skipped: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      const first = names.get(definition.name);
      if (first !== undefined) {
        issues.push({
          severity: "error",
          scope: "agent",
          component: "agents.definition",
          path,
          message: `duplicate agent name ${JSON.stringify(definition.name)}, also defined in ${JSON.stringify(first)}`,
        });
        continue;
      }
      names.set(definition.name, path);
      agents.push(definition);
    }
  }
  return { agents, issues };
}
