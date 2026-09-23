import { describe, expect, it } from "vitest";

import type { AgentPluginSkill } from "@hooknostic/agent-plugin";

import { qualifiedSkillNames, renameSkillManifest } from "./skill-names.js";

const skill = (name: string): AgentPluginSkill => ({
  name,
  description: "d",
  directory: `skills/${name}`,
  manifestPath: `skills/${name}/SKILL.md`,
});

const names = (plugin: string, ...skills: string[]) =>
  qualifiedSkillNames(plugin, skills.map(skill)).map(({ name, kept }) => (kept === undefined ? name : `${name}!`));

const rename = (text: string, from = "status", to = "alpha-status") => {
  const result = renameSkillManifest(new TextEncoder().encode(text), from, to);
  return result === undefined ? undefined : new TextDecoder().decode(result);
};

describe("qualified skill names", () => {
  it("prefixes each skill with its plugin", () => {
    expect(names("alpha", "status", "audit")).toEqual(["alpha-status", "alpha-audit"]);
  });

  it("leaves a skill already named for its plugin", () => {
    expect(names("alpha", "alpha-maintenance", "alpha")).toEqual(["alpha-maintenance", "alpha"]);
  });

  it("does not mistake a longer plugin name for the prefix", () => {
    expect(names("alp", "alpha-status")).toEqual(["alp-alpha-status"]);
  });

  it("keeps a name the prefix would push past the Agent Skills limit", () => {
    const long = "a".repeat(59);
    expect(names("alpha", long)).toEqual([`${long}!`]);
    expect(names("alpha", "a".repeat(58))).toEqual([`alpha-${"a".repeat(58)}`]);
  });

  // A plugin name may contain `.`; a skill name may not.
  it("spells a dotted plugin name with hyphens", () => {
    expect(names("com.acme", "status", "com-acme-audit")).toEqual(["com-acme-status", "com-acme-audit"]);
  });

  it("keeps a name the plugin name cannot qualify validly", () => {
    // `a.-b` is a valid plugin name, and `a--b-status` is no skill name.
    expect(names("a.-b", "status")).toEqual(["status!"]);
    expect(qualifiedSkillNames("a.-b", [skill("status")])[0]?.kept).toBe(
      '"a--b-status" is not a valid Agent Skills name',
    );
  });

  it("keeps both names when prefixing one would duplicate another", () => {
    expect(names("alpha", "status", "alpha-status", "audit")).toEqual(["status!", "alpha-status", "alpha-audit"]);
  });
});

describe("skill manifest rename", () => {
  it("changes only the name value", () => {
    expect(rename("---\nname: status\ndescription: Show status\n---\n\n# status\nname: status\n")).toBe(
      "---\nname: alpha-status\ndescription: Show status\n---\n\n# status\nname: status\n",
    );
  });

  it("keeps quoting, a comment and CRLF line endings", () => {
    expect(rename("---\r\ndescription: x\r\nname:  'status'  # id\r\n---\r\nbody\r\n")).toBe(
      "---\r\ndescription: x\r\nname:  'alpha-status'  # id\r\n---\r\nbody\r\n",
    );
    expect(rename('---\nname: "status"\n---\n')).toBe('---\nname: "alpha-status"\n---\n');
  });

  it("ignores a nested name key", () => {
    expect(rename("---\nmetadata:\n  name: status\nname: status\n---\n")).toBe(
      "---\nmetadata:\n  name: status\nname: alpha-status\n---\n",
    );
  });

  it("declines what it cannot rewrite with certainty", () => {
    expect(rename("no frontmatter\nname: status\n")).toBeUndefined();
    expect(rename("---\nname: >-\n  status\n---\n")).toBeUndefined();
    expect(rename("---\nname: statuses\n---\n")).toBeUndefined();
    expect(rename("---\nname: status\nname : status\n---\n")).toBeUndefined();
    expect(rename("---\nname: 'status\"\n---\n")).toBeUndefined();
  });
});
