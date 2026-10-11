/**
 * Every shipped adapter must pass the same contract.
 *
 * The obligations live in `@hooknostic/testkit` so an adapter published from
 * another repository is held to them too. Registration iterates the default
 * registry itself: there is no per-adapter row to forget, which closes the one
 * gap the previous SUBJECTS array admitted it could not catch. Fixture paths
 * and audit ranges derive from each adapter's own `harness` metadata.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { SHELL_DIALECTS } from "@hooknostic/sdk";
import {
  adapterFixturesDir,
  describeAdapterContract,
  describeScenarioCoverage,
  scenarioById,
} from "@hooknostic/testkit";

import { defaultAdapterRegistry } from "./registry.js";

const adapters = Object.values(defaultAdapterRegistry()).flatMap((adapter) =>
  adapter.harnessFamilies
    ? adapter.harnessFamilies.map(
        (harness) =>
          adapter.resolveTarget!({
            id: adapter.id,
            version: harness.recommendedRange,
            delivery: "project",
            output: ".",
          }).adapter!,
      )
    : [adapter],
);

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

for (const adapter of adapters) {
  describeAdapterContract(adapter, { fixturesDir: adapterFixturesDir(adapter) });
  describeScenarioCoverage(adapter);
}

describe("scheduled scenario limitations", () => {
  it("declares non-silent limits for the unsupported Codex playback drivers", () => {
    expect(scenarioById("tool-before-approval")?.inconclusiveByHarness?.["codex"]).toMatch(
      /interactive approval driver/,
    );
    expect(scenarioById("permission-request")?.inconclusiveByHarness?.["codex"]).toMatch(
      /interactive permission driver/,
    );
    expect(scenarioById("agent-subagent")?.inconclusiveByHarness?.["codex"]).toMatch(/hook-trust bypass/);
    expect(scenarioById("context-compact")?.inconclusiveByHarness?.["claude"]).toMatch(/cannot deterministically fill/);
  });
});

describe("shell dialect evidence (ADR-0029)", () => {
  it("has a fixture carrying every dialect the vocabulary names", () => {
    // A family joins SHELL_DIALECTS with a captured case behind it, never ahead of one.
    const carried = new Set<string>();
    for (const adapter of adapters) {
      const dir = adapterFixturesDir(adapter);
      for (const name of readdirSync(dir).filter((file) => file.endsWith(".canonical.json"))) {
        const dialect = (
          JSON.parse(readFileSync(resolve(dir, name), "utf8")) as { tool?: { shell?: { dialect?: string } } }
        ).tool?.shell?.dialect;
        if (dialect !== undefined) carried.add(dialect);
      }
    }
    expect([...carried].sort()).toEqual([...SHELL_DIALECTS].sort());
  });
});

describe("validation evidence", () => {
  it("points every validatedOn artifact at an existing tracked path", () => {
    // Repo-local (a third party's evidence lives in its own tree): this is
    // what stops "fixtures/codex/0.148" from outliving the directory.
    for (const adapter of adapters) {
      const resolution = adapter.capabilities({
        id: adapter.id,
        version: adapter.harness.recommendedRange,
        delivery: "project",
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
