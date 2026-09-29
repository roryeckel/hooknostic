import { parseDocument, stringify } from "yaml";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Split a Markdown document into its YAML frontmatter and body.
 *
 * `label` names the document in errors (`SKILL.md`, a subagent file). Aliases
 * are refused rather than expanded (`maxAliasCount: 0`): nothing a portable
 * frontmatter needs is worth a billion-laughs expansion inside a build.
 */
export function parseMarkdownFrontmatter(text: string, label: string): { data: unknown; body: string } {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    throw new Error(`${label} must begin with YAML frontmatter`);
  }
  const match = FRONTMATTER.exec(text);
  if (!match) throw new Error(`${label} has no closing frontmatter delimiter`);
  const document = parseDocument(match[1] ?? "");
  if (document.errors.length > 0) throw new Error(document.errors[0]!.message);
  return { data: document.toJS({ maxAliasCount: 0 }) as unknown, body: text.slice(match[0].length) };
}

/**
 * The inverse, for generated native files: `fields` as YAML frontmatter, then
 * `body`. Deterministic for a given input -- keys keep their order -- and never
 * folds a long scalar, so a single-line description stays on one line for
 * whatever YAML reader the harness uses. LF line endings throughout.
 */
export function renderMarkdownFrontmatter(fields: Readonly<Record<string, unknown>>, body: string): string {
  const yaml = stringify(fields, { lineWidth: 0, aliasDuplicateObjects: false });
  return `---\n${yaml}---\n${body.endsWith("\n") ? body : `${body}\n`}`;
}
