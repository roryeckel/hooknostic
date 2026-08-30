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
      // looking like a considered decision in the profile source. Checked on
      // each profile's RAW matrix, not the resolved one: multi-profile
      // resolution reconstructs the matrix by iterating the registry, which
      // drops an unregistered key before this test could see it.
      const registered = new Set<string>(ALL_CAPABILITY_IDS);
      for (const profile of resolved.profilesUsed) {
        const unknown = Object.keys(profile.matrix).filter((id) => !registered.has(id));
        expect(
          unknown,
          `profile ${profile.range}: unregistered capability ids: ${unknown.join(", ")}`,
        ).toEqual([]);
      }
    });

    it("round-trips the shell view of every fixture through its codec", () => {
      // Two-way consistency as an adapter obligation, not a first-party
      // habit: wherever a canonical fixture advertises a normalized shell
      // view, the adapter's codec must (i) exist, (ii) re-derive that view
      // from the fixture's own input, and (iii) encode a command patch that
      // classifies back to the patched command under the same native key. A
      // fourth adapter shipping a one-way toolmap fails here.
      for (const name of fixtureNames) {
        const fixture = loadFixtureFrom<{
          tool?: { nativeName: string; input: unknown; shell?: { command: string } };
        }>(join(options.fixturesDir, name));
        const tool = fixture.tool;
        if (tool?.shell === undefined) continue;
        expect(adapter.shellCodec, `${name} has tool.shell but adapter has no codec`).toBeDefined();
        const classified = adapter.shellCodec!.classify(tool.nativeName, tool.input);
        expect(classified, `${name}: codec does not classify its own fixture`).toEqual(tool.shell);
        const encoded = adapter.shellCodec!.encode(tool.nativeName, tool.input, {
          command: "hooknostic-contract-probe",
        });
        expect(
          adapter.shellCodec!.classify(tool.nativeName, encoded)?.command,
          `${name}: encode does not round-trip through classify`,
        ).toBe("hooknostic-contract-probe");
      }
    });

    it("declares how its artifact is executed", () => {
      // shimExecution decides whether a bundled CLI main guard is a hazard
      // (HN502) and whether process.execPath is the host rather than Node.
      expect(["command", "module"]).toContain(adapter.shimExecution);
      expect(adapter.supportedModes().length).toBeGreaterThan(0);
    });
  });
}
