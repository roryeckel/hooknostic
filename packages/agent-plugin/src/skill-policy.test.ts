import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { AGENT_PLUGIN_MANIFEST_SCHEMA, loadAgentPlugin, loadProjectComponents, packageComponents } from "./index.js";
import { selectSkillPolicies, setSkillPolicyYaml, SKILL_INVOCATION_POLICY } from "./skill-policy.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const encode = (text: string) => new TextEncoder().encode(text);

describe("portable skill invocation metadata", () => {
  it.each([undefined, '"true"', '"false"', "false", '"no"'])(
    "validates packaged and direct %s declarations",
    async (value) => {
      const root = await mkdtemp(join(tmpdir(), "hkn-policy-parse-"));
      roots.push(root);
      await writeFile(
        join(root, "plugin.json"),
        JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "policy-probe" }),
      );
      await mkdir(join(root, "skills/review"), { recursive: true });
      await writeFile(
        join(root, "skills/review/SKILL.md"),
        `---\nname: review\ndescription: Review code\n${value === undefined ? "" : `metadata:\n  hooknostic/allow-implicit-invocation: ${value}\n`}---\nBody.\n`,
      );
      const packaged = await loadAgentPlugin({ root });
      const direct = await loadProjectComponents({ skills: [join(root, "skills")] });
      const valid = value === undefined || value === '"true"' || value === '"false"';
      for (const loaded of [packaged, direct])
        expect(loaded.issues.some((issue) => issue.severity === "error")).toBe(!valid);
      if (valid) {
        const expected = value === undefined ? undefined : { allowImplicitInvocation: value === '"true"' };
        expect(packaged.package!.skills[0]!.policy).toEqual(expected);
        expect(direct.source.skills[0]!.policy).toEqual(expected);
        expect(packageComponents(packaged.package!).skills[0]!.policy).toEqual(expected);
      }
      await writeFile(
        join(root, "skills/review/SKILL.md"),
        "---\nname: review\ndescription: Review code\ndisable-model-invocation: true\n---\nBody.\n",
      );
      const strict = await loadAgentPlugin({ root });
      expect(strict.issues).toContainEqual(expect.objectContaining({ severity: "warn", scope: "skill" }));
      expect(strict.package!.skills).toEqual([]);
      expect((await loadProjectComponents({ skills: [join(root, "skills")] })).issues).toEqual([]);
    },
  );

  it.each([false, true])("retains native YAML, modes, comments and opaque body bytes with BOM=%s", (bom) => {
    const header = encode(
      "---\r\nname: review\r\ndescription: Review code\r\nmetadata:\r\n  vendor/key: keep # comment\r\nuser-invocable: false\r\n---\r\n",
    );
    const body = new Uint8Array([13, 10, 0xff, 0x00, 65, 13, 10]);
    const original = new Uint8Array([...(bom ? [0xef, 0xbb, 0xbf] : []), ...header, ...body]);
    const files = [{ path: "SKILL.md", contents: original, mode: 0o755 }];
    const projected = setSkillPolicyYaml(files, "SKILL.md", ["metadata", "opencode/autoinvoke"], "false", true);
    const output = projected[0]!;
    const text = new TextDecoder().decode(output.contents);
    expect(parse(text.split("---")[1]!)).toMatchObject({
      metadata: { "vendor/key": "keep", "opencode/autoinvoke": "false" },
      "user-invocable": false,
    });
    expect(text).toContain("# comment\r\n");
    const outputHeader = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(
      new TextDecoder("utf-8", { ignoreBOM: true }).decode(output.contents),
    )![0];
    expect(output.contents.subarray(encode(outputHeader).length)).toEqual(body);
    expect(output.mode).toBe(0o755);
    expect(files[0]!.contents).toEqual(original);
    const sidecar = setSkillPolicyYaml(
      [
        {
          path: "agents/openai.yaml",
          contents: encode("interface:\n  display_name: Review\npolicy:\n  vendor: keep\n"),
          mode: 0o644,
        },
      ],
      "agents/openai.yaml",
      ["policy", "allow_implicit_invocation"],
      false,
    );
    expect(parse(new TextDecoder().decode(sidecar[0]!.contents))).toEqual({
      interface: { display_name: "Review" },
      policy: { vendor: "keep", allow_implicit_invocation: false },
    });
    expect(() =>
      setSkillPolicyYaml(
        [{ path: "agents/openai.yaml", contents: encode("policy: broken\n"), mode: 0o644 }],
        "agents/openai.yaml",
        ["policy", "allow_implicit_invocation"],
        false,
      ),
    ).toThrow("must be a mapping");
  });

  it("requires named acceptance to emit an unavailable gate, including in-place sources", () => {
    const skill = { name: "review", policy: { allowImplicitInvocation: false } };
    const options = { adapter: "test", support: { level: "unsupported" as const }, onUnsupported: "error" as const };
    const failed = selectSkillPolicies([skill], options);
    expect(failed.skills).toEqual([]);
    expect(failed.issues[0]!.severity).toBe("error");
    const omitted = selectSkillPolicies([skill], { ...options, onUnsupported: "warn" });
    expect(omitted.skills).toEqual([]);
    expect(omitted.omissions).toHaveLength(1);
    const accepted = selectSkillPolicies([skill], {
      ...options,
      accept: ["test:skill-implicit-invocation-unenforced"],
    });
    expect(accepted.skills).toEqual([{ name: "review" }]);
    expect(accepted.applied.size).toBe(0);
    expect(accepted.degradations).toEqual([
      expect.objectContaining({ component: SKILL_INVOCATION_POLICY, name: "review" }),
    ]);
    const inPlace = selectSkillPolicies([skill], { ...options, onUnsupported: "warn", inPlace: new Set(["review"]) });
    expect(inPlace.issues[0]!.severity).toBe("error");
    expect(inPlace.omissions).toEqual([]);
    expect(inPlace.issues[0]!.message).toContain("move it");
    expect(
      selectSkillPolicies([skill], {
        ...options,
        inPlace: new Set(["review"]),
        accept: ["test:skill-implicit-invocation-unenforced"],
      }).issues[0]!.severity,
    ).toBe("error");
    expect(
      selectSkillPolicies([skill], { ...options, inPlace: new Set(["review"]), accept: ["test:skill-policy-in-place"] })
        .skills,
    ).toEqual([{ name: "review" }]);
  });
});
