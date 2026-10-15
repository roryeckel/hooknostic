import { describe, expect, it, vi } from "vitest";

import { AGENT_PLUGIN_MANIFEST_SCHEMA, type AgentPluginPackage, contentsText } from "@hooknostic/agent-plugin";
import { resolveAgentPluginProjection } from "@hooknostic/core";
import { definePlugin, hook } from "@hooknostic/sdk";
import { loadFixture } from "@hooknostic/testkit";

import { decodePi } from "./decode.js";
import { piHarness } from "./harness.js";
import { piAdapter } from "./index.js";
import { piCapabilityProfiles } from "./profile.js";
import { piAgentPluginProjector } from "./project-agent-plugin.js";
import { createHooknosticExtension } from "./shim.js";
import { classifyPiTool } from "./toolmap.js";

const encoder = new TextEncoder();
const target = { id: "pi", delivery: "package" as const, version: piHarness.referenceVersion, output: "dist" };
const levels = Object.fromEntries(
  Object.entries(piCapabilityProfiles[0]!.matrix).map(([id, cell]) => [id, cell.level]),
);
function packageWith(body: string, policy?: boolean): AgentPluginPackage {
  return {
    specVersion: "1.0.0",
    root: "/portable",
    contentDigest: "sha256:probe",
    manifest: { $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "pi-feature-probe", version: "1.0.0" },
    skills: [
      {
        name: "review",
        description: "Review",
        directory: "skills/review",
        manifestPath: "skills/review/SKILL.md",
        ...(policy === undefined ? {} : { policy: { allowImplicitInvocation: policy } }),
      },
    ],
    files: [{ path: "skills/review/SKILL.md", mode: 0o644, contents: encoder.encode(body) }],
  };
}
const project = (source: AgentPluginPackage, version = target.version) =>
  piAgentPluginProjector.project(source, {
    target: { ...target, version },
    hookArtifacts: [],
    onUnsupported: "error",
    support: resolveAgentPluginProjection({ ...target, version }, piAgentPluginProjector).matrix!,
  });

describe("Pi feature parity", () => {
  it.each(["error", "aborted", "retry-aborted"])(
    "does not expose an earlier response after the captured %s run",
    (name) => {
      const native = loadFixture("pi", piHarness.fixtureDir, `agent-settled-${name}.input.json`);
      const enrichment = loadFixture<{ branch: unknown[] }>(
        "pi",
        piHarness.fixtureDir,
        `agent-settled-${name}.enrichment.json`,
      );
      const decoded = decodePi(native, { targetId: "pi", harnessVersion: piHarness.referenceVersion }, enrichment);
      expect(decoded).not.toHaveProperty("lastMessage");
      expect(decoded.correlation.turnId).toBeUndefined();
      expect(decoded.raw).toBe(native);
    },
  );

  it.each(["retry", "resumed"])("selects the current response and id after the captured %s run", (name) => {
    const native = loadFixture("pi", piHarness.fixtureDir, `agent-settled-${name}.input.json`);
    const enrichment = loadFixture<{ branch: { id: string }[] }>(
      "pi",
      piHarness.fixtureDir,
      `agent-settled-${name}.enrichment.json`,
    );
    const decoded = decodePi(native, { targetId: "pi", harnessVersion: piHarness.referenceVersion }, enrichment);
    expect(decoded).toHaveProperty("lastMessage", "COMPLETION_" + name.toUpperCase());
    expect(decoded.correlation.turnId).toBe(enrichment.branch.at(-1)!.id);
    expect(decoded.raw).toBe(native);
  });

  it("pins only the shell tool whose interpreter family was established", () => {
    expect(classifyPiTool("powershell", { command: "echo probe" }).shell?.dialect).toBe("powershell");
    expect(classifyPiTool("bash", { command: "echo probe" }).shell?.dialect).toBeUndefined();
    expect(piAdapter().shellDialect?.source).toBe("tool");
  });

  it.each(["read", "edit", "write"])("normalizes the captured %s path without changing raw input", (name) => {
    const fixture = loadFixture<{ event: { input: unknown } }>(
      "pi",
      piHarness.fixtureDir,
      `tool-call-${name}.input.json`,
    );
    const input = fixture.event.input as { path: string };
    const tool = classifyPiTool(name, input);
    expect(tool.file).toEqual({ paths: [input.path], pathKey: "path" });
    expect(tool.input).toBe(input);
  });

  it("rederives a file view when the generated shim applies a rewrite", async () => {
    let run!: (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
    let seen;
    createHooknosticExtension(
      definePlugin({
        name: "probe",
        hooks: [
          hook("tool.before", {
            id: "rewrite",
            capabilities: { "input.replace": "required" },
            async run() {
              return { kind: "replaceInput" as const, input: { path: "after.txt", content: "ok" } };
            },
          }),
          hook("tool.before", {
            id: "observe",
            async run(event) {
              seen = event.tool.file;
            },
          }),
        ],
      }),
      { capabilities: levels },
    )({
      on: (_name, handler) => {
        run = handler;
      },
    });
    await run(
      { type: "tool_call", toolName: "write", input: { path: "before.txt", content: "ok" } },
      { cwd: "/project" },
    );
    expect(seen).toEqual({ paths: ["after.txt"], pathKey: "path" });
  });

  it("projects the skill directory and reports references Pi leaves literal", async () => {
    const plan = await project(
      packageWith(
        "---\nname: review\ndescription: Review\n---\nRun ${SKILL_DIR}/script.mjs and ${PLUGIN_ROOT}/data.\n",
      ),
    );
    const skill = plan.files.find((file) => file.path === "package/skills/review/SKILL.md")!;
    expect(contentsText(skill.contents)).toContain("Run ./script.mjs and ${PLUGIN_ROOT}/data.");
    expect(plan.summary.degradations).toEqual([
      expect.objectContaining({ id: "skill-reference-unexpanded", name: "review" }),
    ]);
    expect(plan.summary.copiedPaths).not.toContain(skill.path);
  });

  it.each([false, true])("projects allowImplicitInvocation=%s after the authored native setting", async (allowed) => {
    const body = "\nKeep body bytes.\r\n";
    const source = packageWith(
      `---\nname: review\ndescription: Review\ndisable-model-invocation: ${allowed}\n---\n${body}`,
      allowed,
    );
    const plan = await project(source);
    expect(plan.issues).toEqual([]);
    const skill = contentsText(plan.files.find((file) => file.path === "package/skills/review/SKILL.md")!.contents);
    expect(skill).toContain(`disable-model-invocation: ${!allowed}`);
    expect(skill.endsWith(body)).toBe(true);
    expect(plan.summary.components["agent-plugin.skills.invocation-policy"]?.emitted).toBe(1);
    // The whole recommended range includes builds predating this gate's capture.
    const older = await project(source, piHarness.recommendedRange);
    expect(older.files.some((file) => file.path.endsWith("skills/review/SKILL.md"))).toBe(false);
  });

  it("uses the captured settled session branch for declared final-response fields", async () => {
    let run!: (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
    let seen;
    const enrichment = loadFixture<{ branch: unknown[] }>(
      "pi",
      piHarness.fixtureDir,
      "agent-settled-with-message.enrichment.json",
    );
    createHooknosticExtension(
      definePlugin({
        name: "probe",
        hooks: [
          hook("turn.stop", {
            id: "final",
            fields: ["lastMessage", "correlation.turnId"],
            async run(event) {
              seen = event;
            },
          }),
        ],
      }),
      { capabilities: levels },
    )({
      on: (_name, handler) => {
        run = handler;
      },
    });
    await run({ type: "agent_settled" }, { cwd: "/project", sessionManager: { getBranch: () => enrichment.branch } });
    expect(seen).toMatchObject({
      lastMessage: "FEATURE_FINAL_REPLY",
      correlation: { turnId: expect.any(String) },
      raw: { event: { type: "agent_settled" }, ctx: { cwd: "/project" } },
    });
  });

  it("does not reuse a preceding final response when the branch ends differently", () => {
    const { branch } = loadFixture<{ branch: unknown[] }>(
      "pi",
      piHarness.fixtureDir,
      "agent-settled-with-message.enrichment.json",
    );
    const native = { event: { type: "agent_settled" }, ctx: { cwd: "/project" } };
    const invocation = { targetId: "pi", harnessVersion: piHarness.referenceVersion };
    expect(decodePi(native, invocation, { branch })).toHaveProperty("lastMessage", "FEATURE_FINAL_REPLY");
    // Synthetic defensive variants of the captured branch, not harness evidence.
    for (const message of [
      { role: "user", content: "next turn" },
      { role: "toolResult", content: [] },
      ...["error", "aborted", "toolUse"].map((stopReason) => ({
        role: "assistant",
        stopReason,
        content: [{ type: "text", text: "partial" }],
      })),
    ]) {
      const decoded = decodePi(native, invocation, { branch: [...branch, { type: "message", id: "next", message }] });
      expect(decoded).not.toHaveProperty("lastMessage");
      expect(decoded.correlation.turnId).toBeUndefined();
    }
  });

  it("reads the session only for declared fields and still runs when that read fails", async () => {
    const getBranch = vi.fn(() => {
      throw new Error("unavailable");
    });
    const context = { cwd: "/project", sessionManager: { getBranch } };
    for (const declared of [false, true]) {
      let run!: (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
      let seen;
      createHooknosticExtension(
        definePlugin({
          name: "probe",
          hooks: [
            hook("turn.stop", {
              id: "final",
              ...(declared ? { fields: ["lastMessage"] as const } : {}),
              async run(event) {
                seen = event;
              },
            }),
          ],
        }),
        { capabilities: levels },
      )({
        on: (_name, handler) => {
          run = handler;
        },
      });
      await run({ type: "agent_settled" }, context);
      expect(getBranch).toHaveBeenCalledTimes(declared ? 1 : 0);
      expect(seen).toMatchObject({ event: "turn.stop", correlation: {} });
      expect(seen).not.toHaveProperty("lastMessage");
    }
  });
});
