import { describe, expect, it } from "vitest";

import {
  projectPackageSkillTexts,
  projectSkillText,
  RELATIVE_SKILL_TEXT,
  SKILL_REFERENCE_UNEXPANDED,
  type SkillTextTarget,
} from "./skill-text.js";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? undefined : new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);

const CLAUDE_LIKE: SkillTextTarget = {
  skillDirectory: "${CLAUDE_SKILL_DIR}",
  leavesLiteral: (name) => name === "PLUGIN_ROOT",
};

describe("projectSkillText", () => {
  it("writes the target's skill directory for every ${SKILL_DIR} in the body", () => {
    const text =
      '---\nname: status\ndescription: Status\n---\nRun `node "${SKILL_DIR}/scripts/a.mjs"` or ${SKILL_DIR}/b.\n';
    expect(decode(projectSkillText(encode(text), RELATIVE_SKILL_TEXT).contents)).toBe(
      '---\nname: status\ndescription: Status\n---\nRun `node "./scripts/a.mjs"` or ./b.\n',
    );
    expect(decode(projectSkillText(encode(text), CLAUDE_LIKE).contents)).toBe(
      '---\nname: status\ndescription: Status\n---\nRun `node "${CLAUDE_SKILL_DIR}/scripts/a.mjs"` or ${CLAUDE_SKILL_DIR}/b.\n',
    );
  });

  it("never rewrites the frontmatter, and reports a ${SKILL_DIR} left there", () => {
    const text = "---\nname: status\ndescription: Runs ${SKILL_DIR}/x\n---\nRun ${SKILL_DIR}/x.\n";
    const projected = projectSkillText(encode(text), RELATIVE_SKILL_TEXT);
    expect(decode(projected.contents)).toBe("---\nname: status\ndescription: Runs ${SKILL_DIR}/x\n---\nRun ./x.\n");
    expect(projected.unexpanded).toEqual(["${SKILL_DIR}"]);
    expect(projected.inFrontmatter).toBe(true);
  });

  it("reports every checked reference in the frontmatter, on every target, without rewriting it", () => {
    const text =
      "---\nname: status\ndescription: Run ${PLUGIN_ROOT}/x from ${CLAUDE_SKILL_DIR} in ${HOME}\n---\nNothing here.\n";
    const relative = projectSkillText(encode(text), RELATIVE_SKILL_TEXT);
    expect(relative).toEqual({ unexpanded: ["${PLUGIN_ROOT}", "${CLAUDE_SKILL_DIR}"], inFrontmatter: true });
    // Claude expands ${CLAUDE_SKILL_DIR} in a body, not in a description.
    expect(projectSkillText(encode(text), CLAUDE_LIKE)).toEqual({
      unexpanded: ["${PLUGIN_ROOT}", "${CLAUDE_SKILL_DIR}"],
      inFrontmatter: true,
    });
  });
  it("leaves the bytes alone when there is nothing to rewrite", () => {
    const projected = projectSkillText(encode("---\nname: a\ndescription: b\n---\nNo tokens.\n"), RELATIVE_SKILL_TEXT);
    expect(projected).toEqual({ unexpanded: [] });
  });

  it("keeps line endings and a byte-order mark", () => {
    const text = "\uFEFF---\r\nname: a\r\ndescription: b\r\n---\r\nRun ${SKILL_DIR}/x.\r\n";
    expect(decode(projectSkillText(encode(text), RELATIVE_SKILL_TEXT).contents)).toBe(
      "\uFEFF---\r\nname: a\r\ndescription: b\r\n---\r\nRun ./x.\r\n",
    );
  });

  it("reports what the target shows as written, once each, and nothing the shell expands", () => {
    const text =
      "---\nname: a\ndescription: b\n---\n" +
      'node "${CLAUDE_PLUGIN_ROOT}/x" "${PLUGIN_DATA}" "${HOME}" "${CLAUDE_PLUGIN_ROOT}" "${VAR:-x}" $PLUGIN_ROOT\n';
    expect(projectSkillText(encode(text), RELATIVE_SKILL_TEXT).unexpanded).toEqual([
      "${CLAUDE_PLUGIN_ROOT}",
      "${PLUGIN_DATA}",
    ]);
    expect(projectSkillText(encode(text), CLAUDE_LIKE).unexpanded).toEqual([]);
  });

  it("reports rather than rewrites a body ${SKILL_DIR} it may not rewrite", () => {
    const text = "---\nname: a\ndescription: b\n---\nRun ${SKILL_DIR}/x.\n";
    expect(projectSkillText(encode(text), RELATIVE_SKILL_TEXT, { rewrite: false })).toEqual({
      unexpanded: ["${SKILL_DIR}"],
    });
  });
});

describe("projectPackageSkillTexts", () => {
  it("returns each rewritten SKILL.md by path and one degradation per skill with references left", () => {
    const files = new Map([
      ["skills/a/SKILL.md", encode("---\nname: a\ndescription: a\n---\nRun ${SKILL_DIR}/x.\n")],
      ["skills/b/SKILL.md", encode("---\nname: b\ndescription: b\n---\nRun ${CLAUDE_SKILL_DIR}/x.\n")],
      ["skills/c/SKILL.md", encode("---\nname: c\ndescription: c\n---\nNothing.\n")],
    ]);
    const skills = ["a", "b", "c"].map((name) => ({
      name,
      description: name,
      directory: `skills/${name}`,
      manifestPath: `skills/${name}/SKILL.md`,
    }));
    const projected = projectPackageSkillTexts(skills, (path) => files.get(path), RELATIVE_SKILL_TEXT, "Codex");
    expect([...projected.rewritten.keys()]).toEqual(["skills/a/SKILL.md"]);
    expect(decode(projected.rewritten.get("skills/a/SKILL.md"))).toContain("Run ./x.");
    expect(projected.degradations).toEqual([
      {
        id: SKILL_REFERENCE_UNEXPANDED,
        component: "agent-plugin.skills",
        name: "b",
        path: "skills/b/SKILL.md",
        reason: 'skill "b" contains "${CLAUDE_SKILL_DIR}", which Codex shows the model as written.',
      },
    ]);
  });
});
