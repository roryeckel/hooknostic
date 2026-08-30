import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HookEventName } from "@hooknostic/sdk";
import { ALL_CAPABILITY_IDS, HOOK_EVENT_NAMES } from "@hooknostic/sdk";
import type { HarnessAdapter } from "@hooknostic/core";
import { loadFixtureFrom } from "./fixtures.js";

export interface AdapterContractOptions {
  /**
   * Absolute path to this adapter's fixture directory — the one holding its
   * `*.canonical.json` files. Taken as a path rather than a (harness, version)
   * pair so an adapter living outside this repository can run the suite.
   */
  fixturesDir: string;
  /** Version range to resolve capabilities at; should match the fixtures. */
  version: string;
  mode?: "plugin" | "local";
}

/**
 * The obligations every harness adapter must meet, as executable tests.
 *
 * These were previously prose: `docs/adding-an-adapter.md` listed them as a
 * checklist, `packages/core/src/adapter.ts` claimed they were "enforced by
 * testkit contract assertions", and the enforcement that did exist was four
 * copy-pasted `it()` blocks covering only the three first-party adapters. A
 * fourth adapter was audited by nothing.
 *
 * Call this from a test file in your adapter package:
 *
 * ```ts
 * describeAdapterContract(myAdapter(), {
 *   fixturesDir: resolve(import.meta.dirname, "../fixtures/2.1"),
 *   version: ">=2.1 <3",
 * });
 * ```
 */
export function describeAdapterContract(
  adapter: HarnessAdapter,
  options: AdapterContractOptions,
): void {
  describe(`adapter contract: ${adapter.id}`, () => {
    const resolved = adapter.capabilities({
      id: adapter.id,
      version: options.version,
      mode: options.mode ?? "local",
      output: ".",
    });
    const matrix = resolved.matrix ?? {};

    const observedEvents = HOOK_EVENT_NAMES.filter(
      (event) => matrix[`${event}.observe` as keyof typeof matrix] !== undefined,
    );
    const fixtureNames = readdirSync(options.fixturesDir).filter((name) =>
      name.endsWith(".canonical.json"),
    );
    const coveredEvents = new Set<HookEventName>(
      fixtureNames.map(
        (name) =>
          loadFixtureFrom<{ event: HookEventName }>(join(options.fixturesDir, name)).event,
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

    it("rates only registered capability ids", () => {
      // A typo'd id is not a loud failure: the matrix is Partial and absence
      // means unsupported, so `tool.before.blcok` silently rates nothing while
      // looking like a considered decision in the profile source.
      const registered = new Set<string>(ALL_CAPABILITY_IDS);
      const unknown = Object.keys(matrix).filter((id) => !registered.has(id));
      expect(unknown, `unregistered capability ids: ${unknown.join(", ")}`).toEqual([]);
    });

    it("declares how its artifact is executed", () => {
      // shimExecution decides whether a bundled CLI main guard is a hazard
      // (HN502) and whether process.execPath is the host rather than Node.
      expect(["command", "module"]).toContain(adapter.shimExecution);
      expect(adapter.supportedModes().length).toBeGreaterThan(0);
    });
  });
}
