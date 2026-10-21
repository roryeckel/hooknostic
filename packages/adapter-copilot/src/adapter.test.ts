import { resolve } from "node:path";

import { describeAdapterContract } from "@hooknostic/testkit";

import { copilotAdapter } from "./index.js";

describeAdapterContract(copilotAdapter(), {
  fixturesDir: resolve(import.meta.dirname, "../../../fixtures/copilot/1.0"),
  version: ">=1.0 <2",
});
