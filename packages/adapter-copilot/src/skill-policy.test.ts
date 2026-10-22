import { describe, expect, it } from "vitest";

import type { AgentPluginFile } from "@hooknostic/agent-plugin";

import { copilotSkillPolicy } from "./skill-policy.js";

const encoder = new TextEncoder();

function skill(frontmatter: string): AgentPluginFile[] {
  return [
    {
      path: "SKILL.md",
      contents: encoder.encode(`---\nname: gated\ndescription: Gated probe.\n${frontmatter}---\n\nGated body.\n`),
      mode: 0o644,
    },
  ];
}

function text(files: readonly AgentPluginFile[]): string {
  return new TextDecoder().decode(files.find((file) => file.path === "SKILL.md")!.contents);
}

describe("Copilot skill invocation policy", () => {
  it("adds the native gate after the portable declaration and preserves the body", () => {
    const files = skill('metadata:\n  hooknostic/allow-implicit-invocation: "false"\n');
    const projected = copilotSkillPolicy(files, { allowImplicitInvocation: false });
    expect(text(projected)).toContain("disable-model-invocation: true");
    expect(text(projected)).toContain('hooknostic/allow-implicit-invocation: "false"');
    expect(text(projected)).toContain("Gated body.");
  });

  it("clears the native gate when implicit invocation is allowed", () => {
    const files = skill('disable-model-invocation: true\nmetadata:\n  hooknostic/allow-implicit-invocation: "true"\n');
    const projected = copilotSkillPolicy(files, { allowImplicitInvocation: true });
    expect(text(projected)).toContain("disable-model-invocation: false");
  });
});
