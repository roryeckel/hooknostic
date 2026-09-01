/**
 * Every shipped adapter must pass the same contract.
 *
 * The obligations live in `@hooknostic/testkit` so an adapter published from
 * another repository is held to them too. Registration iterates the default
 * registry itself: there is no per-adapter row to forget, which closes the one
 * gap the previous SUBJECTS array admitted it could not catch. Fixture paths
 * and audit ranges derive from each adapter's own `harness` metadata.
 */
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { adapterFixturesDir, describeAdapterContract, describeScenarioCoverage } from "@hooknostic/testkit";
import { defaultAdapterRegistry } from "./registry.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

for (const adapter of Object.values(defaultAdapterRegistry())) {
  describeAdapterContract(adapter, { fixturesDir: adapterFixturesDir(adapter) });
  describeScenarioCoverage(adapter);
}

describe("validation evidence", () => {
  it("points every validatedOn artifact at an existing tracked path", () => {
    // Repo-local (a third party's evidence lives in its own tree): this is
    // what stops "fixtures/codex/0.148" from outliving the directory.
    for (const adapter of Object.values(defaultAdapterRegistry())) {
      const resolution = adapter.capabilities({
        id: adapter.id,
        version: adapter.harness.recommendedRange,
        mode: "local",
        output: ".",
      });
      for (const profile of resolution.profilesUsed) {
        for (const record of profile.source.validatedOn) {
          if (record.artifact === undefined) continue;
          expect(
            existsSync(resolve(REPO_ROOT, record.artifact)),
            `${adapter.id} ${profile.range}: artifact ${record.artifact} does not exist`,
          ).toBe(true);
          expect(
            execFileSync("git", ["ls-files", "--", record.artifact], {
              cwd: REPO_ROOT,
              encoding: "utf8",
            }).trim(),
            `${adapter.id} ${profile.range}: artifact ${record.artifact} is not tracked`,
          ).not.toBe("");
        }
      }
    }
  });
});
