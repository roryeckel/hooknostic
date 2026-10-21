import { resolve } from "node:path";

import { describeAdapterContract } from "@hooknostic/testkit";

import { copilotHarness } from "./harness.js";
import { copilotAdapter } from "./index.js";

describeAdapterContract(copilotAdapter(), {
  fixturesDir: resolve(import.meta.dirname, "../../../fixtures/copilot/1.0"),
  version: copilotHarness.recommendedRange,
});
