/**
 * Fixture-coverage audit (design §15.4, Appendix C): no adapter may
 * advertise an observable event without at least one native input fixture
 * whose decoded canonical event exercises it, and every non-exact capability
 * cell must carry a rationale.
 */
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { HookEventName } from "@hooknostic/sdk";
import { HOOK_EVENT_NAMES } from "@hooknostic/sdk";
import type { HarnessAdapter } from "@hooknostic/core";
import { claudeAdapter } from "@hooknostic/adapter-claude";
import { codexAdapter } from "@hooknostic/adapter-codex";
import { opencodeAdapter } from "@hooknostic/adapter-opencode";
import { fixturePath, loadFixture } from "@hooknostic/testkit";

const SUBJECTS: { adapter: HarnessAdapter; fixtureDir: [string, string]; version: string }[] = [
  { adapter: claudeAdapter(), fixtureDir: ["claude", "2.1"], version: ">=2.1 <3" },
  { adapter: codexAdapter(), fixtureDir: ["codex", "0.148"], version: ">=0.148 <1" },
  { adapter: opencodeAdapter(), fixtureDir: ["opencode", "1.18"], version: ">=1.18 <2" },
];

describe.each(SUBJECTS)("fixture coverage: $adapter.id", ({ adapter, fixtureDir, version }) => {
  const resolved = adapter.capabilities({
    id: adapter.id,
    version,
    mode: "local",
    output: ".",
  });
  const matrix = resolved.matrix ?? {};

  const observedEvents = HOOK_EVENT_NAMES.filter(
    (event) => matrix[`${event}.observe` as keyof typeof matrix] !== undefined,
  );

  const [harness, harnessVersion] = fixtureDir;
  const fixtureNames = readdirSync(fixturePath(harness, harnessVersion, ".")).filter(
    (name) => name.endsWith(".canonical.json"),
  );
  const coveredEvents = new Set<HookEventName>(
    fixtureNames.map(
      (name) => loadFixture<{ event: HookEventName }>(harness, harnessVersion, name).event,
    ),
  );

  it("has a native input fixture for every advertised observable event", () => {
    const missing = observedEvents.filter((event) => !coveredEvents.has(event));
    expect(missing, `events without fixtures: ${missing.join(", ")}`).toEqual([]);
  });

  it("does not carry fixtures for events the adapter cannot observe", () => {
    const phantom = [...coveredEvents].filter((event) => !observedEvents.includes(event));
    expect(phantom, `fixtures for unadvertised events: ${phantom.join(", ")}`).toEqual([]);
  });

  it("annotates every non-exact capability with a rationale", () => {
    for (const [id, entry] of Object.entries(matrix)) {
      if (entry.level !== "exact") {
        expect(entry.rationale, `capability ${id} needs a rationale`).toBeTruthy();
      }
    }
  });

  it("records provenance on every capability profile", () => {
    for (const profile of resolved.profilesUsed) {
      expect(profile.source?.date, `profile ${profile.range} needs source date`).toBeTruthy();
      expect(profile.source?.references?.length).toBeGreaterThan(0);
    }
  });
});
