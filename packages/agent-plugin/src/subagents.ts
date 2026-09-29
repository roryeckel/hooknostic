import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { minimatch } from "minimatch";

import { parseMarkdownFrontmatter } from "./frontmatter.js";
import { isAgentSkillName } from "./names.js";
import type { AgentPluginIssue } from "./types.js";

/** The Hooknostic Subagent Definition version this loader reads (docs/spec/subagents/0.1.md). */
export const SUBAGENT_FORMAT_VERSION = "0.1" as const;

/**
 * Top-level keys a 0.1 file may not use, because a later version may define
 * them. Named rather than folded into "unknown field" so an author reaching for
 * a portable `model` or `tools` is told where the value belongs today.
 */
export const SUBAGENT_RESERVED_KEYS = [
  "readOnly",
  "tools",
  "model",
  "maxTurns",
  "mode",
  "skills",
  "mcp",
  "hooks",
] as const;

/**
 * One subagent definition, parsed into the model the specification defines.
 * Adapters translate from this, never from the file, so a future source format
 * mapping onto the same model reaches every harness without translator changes.
 */
export interface SubagentDefinition {
  name: string;
  description: string;
  /** The Markdown body, line endings normalized to LF. */
  instructions: string;
  /** Harness-only fields keyed by harness identifier; empty when the file has none. */
  native: Record<string, Record<string, unknown>>;
  /** Absolute path of the definition file. */
  source: string;
}

export interface LoadSubagentsOptions {
  /** Directories holding flat `<name>.md` definition files. */
  directories: readonly string[];
  /** Globs matched case-insensitively against each file name, relative to its directory. */
  exclude?: readonly string[];
}

const KEYS = new Set(["name", "description", "native"]);
const RESERVED = new Set<string>(SUBAGENT_RESERVED_KEYS);
const HARNESS_KEY = /^[a-z][a-z0-9-]*$/;
const MATCH = { dot: true, nocase: true, nonegate: true, nocomment: true } as const;

function mapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates one file's frontmatter and body into a definition; throws the first problem found. */
function parseDefinition(text: string, stem: string, source: string): SubagentDefinition {
  const { data, body } = parseMarkdownFrontmatter(text, "a subagent definition");
  if (!mapping(data)) throw new Error("frontmatter must be a mapping");
  for (const key of Object.keys(data)) {
    if (RESERVED.has(key)) {
      throw new Error(
        `\`${key}\` is reserved for a later version of the subagent format; put a harness's own field under native.<harness>`,
      );
    }
    if (!KEYS.has(key)) throw new Error(`frontmatter contains an unknown field \`${key}\``);
  }
  const { name, description, native } = data;
  if (typeof name !== "string" || !isAgentSkillName(name)) {
    throw new Error("name must use lowercase letters and digits in hyphen-separated runs, at most 64 characters");
  }
  if (name !== stem) throw new Error(`name ${JSON.stringify(name)} must equal the file name ${JSON.stringify(stem)}`);
  if (typeof description !== "string" || description.length === 0 || description.length > 1024) {
    throw new Error("description must contain 1-1024 characters");
  }
  if (/[\r\n]/.test(description)) throw new Error("description must be a single line");
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
  return { name, description, instructions, native: blocks, source };
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
export async function loadSubagents(
  options: LoadSubagentsOptions,
): Promise<{ subagents: SubagentDefinition[]; issues: AgentPluginIssue[] }> {
  const issues: AgentPluginIssue[] = [];
  const subagents: SubagentDefinition[] = [];
  const names = new Map<string, string>();
  for (const configured of options.directories) {
    const directory = resolve(configured);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      issues.push({
        severity: "error",
        scope: "subagent",
        component: "subagents.definition",
        path: directory,
        message: `could not read subagent directory ${JSON.stringify(directory)}: ${error instanceof Error ? error.message : String(error)}`,
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
          scope: "subagent",
          component: "subagents.definition",
          path,
          message: `subdirectory ${JSON.stringify(entry.name)} is not scanned; subagent definitions sit directly in ${JSON.stringify(directory)}`,
        });
        continue;
      }
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      const stem = entry.name.slice(0, -".md".length);
      let definition: SubagentDefinition;
      try {
        definition = parseDefinition(await readFile(path, "utf8"), stem, path);
      } catch (error) {
        issues.push({
          severity: "warn",
          scope: "subagent",
          component: "subagents.definition",
          path,
          message: `subagent ${JSON.stringify(stem)} is invalid and was skipped: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      const first = names.get(definition.name);
      if (first !== undefined) {
        issues.push({
          severity: "error",
          scope: "subagent",
          component: "subagents.definition",
          path,
          message: `duplicate subagent name ${JSON.stringify(definition.name)}, also defined in ${JSON.stringify(first)}`,
        });
        continue;
      }
      names.set(definition.name, path);
      subagents.push(definition);
    }
  }
  return { subagents, issues };
}
