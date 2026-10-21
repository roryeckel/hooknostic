import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { dispatch } from "@hooknostic/runtime";
import { addContext, block, definePlugin, hook, replaceOutput } from "@hooknostic/sdk";
import { loadFixtureFrom } from "@hooknostic/testkit";

import { applyCopilot } from "./apply.js";
import { decodeCopilot } from "./decode.js";
import { copilotHarness } from "./harness.js";
import { copilotFileCodec, copilotShellCodec } from "./toolmap.js";

const FIXTURES = join(import.meta.dirname, "../../../fixtures/copilot/1.0");
const INVOCATION = { targetId: "copilot", harnessVersion: copilotHarness.referenceVersion };

function input(name: string): unknown {
  return loadFixtureFrom(join(FIXTURES, name));
}

async function dispatchAndApply(
  eventName: "tool.before" | "tool.after" | "session.start",
  spec: Record<string, unknown>,
  capabilities: Record<string, "exact">,
  fixture: string,
  hint: string | undefined,
) {
  const plugin = definePlugin({ name: "roundtrip", hooks: [hook(eventName, spec as never)] });
  const nativeEvent = input(fixture);
  const event = decodeCopilot(nativeEvent, INVOCATION, hint);
  const result = await dispatch(plugin.hooks, event, {
    targetId: "copilot",
    harness: event.harness,
    capabilities,
    shellCodec: copilotShellCodec,
    fileCodec: copilotFileCodec,
  });
  return applyCopilot(result, nativeEvent, INVOCATION);
}

describe("Copilot golden round-trip", () => {
  it("native preToolUse -> decode -> block handler -> native deny", async () => {
    const native = await dispatchAndApply(
      "tool.before",
      {
        id: "guard",
        capabilities: { "tool.before.block": "required" },
        async run() {
          return block("roundtrip deny");
        },
      },
      { "tool.before.observe": "exact", "tool.before.block": "exact" },
      "tool-before.input.json",
      "preToolUse",
    );
    expect(native.body).toEqual({ permissionDecision: "deny", permissionDecisionReason: "roundtrip deny" });
  });

  it("native postToolUse -> decode -> output replacement -> native modifiedResult", async () => {
    const native = await dispatchAndApply(
      "tool.after",
      {
        id: "replace",
        capabilities: { "tool.after.output.replace": "required" },
        async run() {
          return replaceOutput("roundtrip output");
        },
      },
      { "tool.after.observe": "exact", "tool.after.output.replace": "exact" },
      "tool-after.input.json",
      "postToolUse",
    );
    expect(native.body).toEqual({ modifiedResult: { resultType: "success", textResultForLlm: "roundtrip output" } });
  });

  it("native sessionStart -> decode -> context -> native additionalContext", async () => {
    const native = await dispatchAndApply(
      "session.start",
      {
        id: "context",
        capabilities: { "session.start.context.add": "required" },
        async run() {
          return addContext("roundtrip context");
        },
      },
      { "session.start.observe": "exact", "session.start.context.add": "exact" },
      "session-start.input.json",
      "sessionStart",
    );
    expect(native.body).toEqual({ additionalContext: "roundtrip context" });
  });

  it("round-trips a PascalCase event too", async () => {
    const native = await dispatchAndApply(
      "session.start",
      {
        id: "context",
        capabilities: { "session.start.context.add": "required" },
        async run() {
          return addContext("pascal roundtrip");
        },
      },
      { "session.start.observe": "exact", "session.start.context.add": "exact" },
      "session-start-pascal.input.json",
      undefined,
    );
    expect(native.body).toEqual({ additionalContext: "pascal roundtrip" });
  });
});
