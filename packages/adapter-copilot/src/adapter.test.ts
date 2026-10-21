import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { describeAdapterContract, loadFixtureFrom } from "@hooknostic/testkit";

import { copilotHarness } from "./harness.js";
import { copilotAdapter } from "./index.js";

describeAdapterContract(copilotAdapter(), {
  fixturesDir: resolve(import.meta.dirname, "../../../fixtures/copilot/1.0"),
  version: copilotHarness.recommendedRange,
});

describe("Copilot public runtime", () => {
  it("decodes a camelCase payload when the caller supplies the native event hint", async () => {
    const input = loadFixtureFrom(
      resolve(import.meta.dirname, "../../../fixtures/copilot/1.0/session-start.input.json"),
    );
    const event = await copilotAdapter().runtime.decode(input, { targetId: "copilot" }, "sessionStart");
    expect(event.event).toBe("session.start");
    expect(event.harness.nativeEvent).toBe("sessionStart");
  });
});
