import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadFixture, loadFixtureFrom } from "@hooknostic/testkit";

import { CopilotDecodeError, decodeCopilot } from "./decode.js";
import { copilotHarness } from "./harness.js";

const FIXTURES = resolve(import.meta.dirname, "../../../fixtures/copilot/1.0");
const INVOCATION = { targetId: "copilot", harnessVersion: copilotHarness.referenceVersion };

function hintFor(stem: string): string | undefined {
  const path = resolve(FIXTURES, `${stem}.enrichment.json`);
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { nativeEvent?: string }).nativeEvent;
  } catch {
    return undefined;
  }
}

describe("decodeCopilot", () => {
  it("decodes every captured input to its canonical fixture", () => {
    const stems = readdirSync(FIXTURES)
      .filter((name) => name.endsWith(".input.json"))
      .map((name) => name.slice(0, -".input.json".length));
    expect(stems.length).toBeGreaterThan(0);
    const declined = JSON.parse(readFileSync(resolve(FIXTURES, "declined.json"), "utf8")) as Record<
      string,
      { error: string }
    >;
    for (const stem of stems) {
      if (Object.hasOwn(declined, stem)) continue;
      const input = loadFixtureFrom(resolve(FIXTURES, `${stem}.input.json`));
      const canonical = loadFixture<Record<string, unknown>>("copilot", "1.0", `${stem}.canonical.json`);
      expect(decodeCopilot(input, INVOCATION, hintFor(stem)), stem).toEqual({ ...canonical, raw: input });
    }
  });

  it("declines the captured events outside the portable vocabulary", () => {
    const declined = JSON.parse(readFileSync(resolve(FIXTURES, "declined.json"), "utf8")) as Record<
      string,
      { error: string }
    >;
    for (const [stem, entry] of Object.entries(declined)) {
      const input = loadFixtureFrom(resolve(FIXTURES, `${stem}.input.json`));
      expect(() => decodeCopilot(input, INVOCATION, hintFor(stem)), stem).toThrow(entry.error);
    }
  });

  it("requires a hint for a camelCase payload, which names no event", () => {
    const input = loadFixtureFrom(resolve(FIXTURES, "tool-before.input.json"));
    expect(() => decodeCopilot(input, INVOCATION)).toThrow(CopilotDecodeError);
    expect(() => decodeCopilot(input, INVOCATION)).toThrow(/no event hint/);
  });

  it("prefers a payload's stated PascalCase event name over the hint", () => {
    const input = loadFixtureFrom(resolve(FIXTURES, "session-start-pascal.input.json"));
    expect(decodeCopilot(input, INVOCATION, "preToolUse").harness.nativeEvent).toBe("SessionStart");
  });

  it("reads permissionRequest's toolInput, the one camelCase event with that key", () => {
    const input = loadFixtureFrom(resolve(FIXTURES, "permission-request.input.json"));
    const event = decodeCopilot(input, INVOCATION, "permissionRequest");
    expect(event.event).toBe("permission.request");
    if (event.event !== "permission.request") throw new Error("expected permission.request");
    expect(event.tool).toMatchObject({
      kind: "shell",
      nativeName: "powershell",
      input: { command: "echo camel-lifecycle" },
      shell: { command: "echo camel-lifecycle", commandKey: "command", dialect: "powershell" },
    });
  });

  it("reads the hybrid PascalCase SubagentStart payload, whose base fields stay camelCase", () => {
    const input = loadFixtureFrom(resolve(FIXTURES, "agent-start-pascal.input.json"));
    const event = decodeCopilot(input, INVOCATION, "SubagentStart");
    expect(event).toMatchObject({
      event: "agent.start",
      harness: { nativeEvent: "SubagentStart" },
      correlation: {
        agentId: "0273b257-e1cb-421a-8178-05be5c183cf8",
        parentAgentId: "eeae167f-52db-4447-8743-1eea15ded1e7",
      },
      agent: { id: "0273b257-e1cb-421a-8178-05be5c183cf8", type: "explore" },
    });
  });

  it("does not invent a turn or tool-call id no Copilot payload carries", () => {
    for (const stem of ["tool-before", "tool-after", "permission-request", "turn-stop"]) {
      const input = loadFixtureFrom(resolve(FIXTURES, `${stem}.input.json`));
      const event = decodeCopilot(input, INVOCATION, hintFor(stem));
      expect(event.correlation, stem).not.toHaveProperty("turnId");
      expect(event.correlation, stem).not.toHaveProperty("toolCallId");
    }
  });

  it("fails on a payload that is not an object or has no cwd", () => {
    expect(() => decodeCopilot("nope", INVOCATION, "sessionStart")).toThrow(CopilotDecodeError);
    expect(() => decodeCopilot({ sessionId: "s" }, INVOCATION, "sessionStart")).toThrow(/no cwd/);
  });
});
