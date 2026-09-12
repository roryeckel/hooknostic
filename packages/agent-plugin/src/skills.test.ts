import { describe, expect, it } from "vitest";

import { isRejectedSkillPath } from "./skills.js";
import {
  AGENT_PLUGIN_MANIFEST_SCHEMA,
  type AgentPluginFile,
  type AgentPluginPackage,
  type AgentPluginSkill,
} from "./types.js";

const encoder = new TextEncoder();
const file = (path: string): AgentPluginFile => ({
  path,
  contents: encoder.encode(path),
  mode: 0o644,
});

const skill = (directory: string): AgentPluginSkill => ({
  name: directory.slice("skills/".length),
  description: directory,
  directory,
  manifestPath: `${directory}/SKILL.md`,
});

function source(paths: string[], accepted: string[]): AgentPluginPackage {
  return {
    specVersion: "1.0.0",
    root: "/portable",
    manifest: { $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "pkg" },
    skills: accepted.map(skill),
    files: paths.map(file),
    contentDigest: "sha256:test",
  };
}

describe("isRejectedSkillPath", () => {
  it("matches every path inside a skill the loader rejected", () => {
    const rejected = isRejectedSkillPath(
      source(["skills/good/SKILL.md", "skills/broken/SKILL.md", "skills/broken/assets/logo.png"], ["skills/good"]),
    );
    expect(rejected("skills/broken/SKILL.md")).toBe(true);
    expect(rejected("skills/broken/assets/logo.png")).toBe(true);
    expect(rejected("skills/good/SKILL.md")).toBe(false);
  });

  // The case a bare "not in source.skills" test gets wrong: this package has
  // nothing rejected at all, and a shared-asset directory is not a skill.
  it("leaves a directory that never declared a skill alone", () => {
    const rejected = isRejectedSkillPath(
      source(["skills/good/SKILL.md", "skills/shared/logo.png", "skills/README.md"], ["skills/good"]),
    );
    expect(rejected("skills/shared/logo.png")).toBe(false);
    expect(rejected("skills/README.md")).toBe(false);
  });

  it("anchors on the separator in both prefix directions", () => {
    const rejected = isRejectedSkillPath(
      source(
        [
          "skills/review/SKILL.md",
          "skills/review-notes/SKILL.md",
          "skills/audit/SKILL.md",
          "skills/audit-draft/SKILL.md",
        ],
        ["skills/review-notes", "skills/audit"],
      ),
    );
    // A rejected directory that is a prefix of an accepted one, and an accepted
    // one that is a prefix of a rejected one: no startsWith formulation passes.
    expect(rejected("skills/review/SKILL.md")).toBe(true);
    expect(rejected("skills/review-notes/SKILL.md")).toBe(false);
    expect(rejected("skills/audit/SKILL.md")).toBe(false);
    expect(rejected("skills/audit-draft/SKILL.md")).toBe(true);
  });

  it("matches nothing outside the skills tree", () => {
    const rejected = isRejectedSkillPath(source(["src/server.mjs", "skillsy/SKILL.md", "skills/broken/SKILL.md"], []));
    expect(rejected("src/server.mjs")).toBe(false);
    expect(rejected("skillsy/SKILL.md")).toBe(false);
    expect(rejected("skills/broken/SKILL.md")).toBe(true);
  });
});
