import { readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import type { HarnessAdapter } from "@hooknostic/core";
import { buildPluginIR, rangeCoversVersion } from "@hooknostic/core";
import type { HookEventName, ToolInvocation } from "@hooknostic/sdk";
import { ALL_CAPABILITY_IDS, DEFAULT_RUNTIME, definePlugin, hook, HOOK_EVENT_NAMES } from "@hooknostic/sdk";

import { loadFixtureFrom } from "./fixtures.js";

export interface AdapterContractOptions {
  /**
   * Absolute path to this adapter's fixture directory — the one holding its
   * `*.canonical.json` files. Taken as a path rather than a (harness, version)
   * pair so an adapter living outside this repository can run the suite.
   */
  fixturesDir: string;
  /** Version range to resolve capabilities at. Defaults to the adapter's
   * `harness.recommendedRange`; pass explicitly to audit another range. */
  version?: string;
  delivery?: "package" | "project";
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
export function describeAdapterContract(adapter: HarnessAdapter, options: AdapterContractOptions): void {
  describe(`adapter contract: ${adapter.id}`, () => {
    const resolved = adapter.capabilities({
      id: adapter.id,
      version: options.version ?? adapter.harness.recommendedRange,
      delivery: options.delivery ?? "project",
      output: ".",
    });
    const matrix = resolved.matrix ?? {};

    const observedEvents = HOOK_EVENT_NAMES.filter(
      (event) => matrix[`${event}.observe` as keyof typeof matrix] !== undefined,
    );
    const fixtureNames = readdirSync(options.fixturesDir).filter((name) => name.endsWith(".canonical.json"));
    const coveredEvents = new Set<HookEventName>(
      fixtureNames.map((name) => loadFixtureFrom<{ event: HookEventName }>(join(options.fixturesDir, name)).event),
    );

    it("declares project integration and independently evidenced component support", () => {
      if (!adapter.supportedDeliveries().includes("project")) return;
      expect(adapter.projectIntegration).toBeTypeOf("function");
      expect(adapter.projectPaths?.length).toBeGreaterThan(0);
      // HN107 matches these against what integration writes, so a path the
      // adapter never writes would silently never warn.
      for (const path of adapter.rootCheckoutProjectPaths ?? []) expect(adapter.projectPaths).toContain(path);
      expect(adapter.projectComponents).toBeTypeOf("function");
      expect(adapter.projectComponentProfiles?.length).toBeGreaterThan(0);
      for (const profile of adapter.projectComponentProfiles ?? []) {
        expect(profile.source.validatedOn.length).toBeGreaterThan(0);
        for (const record of profile.source.validatedOn) expect(record.artifact).toBeTruthy();
        for (const cell of Object.values(profile.components)) {
          if (cell.level !== "exact") expect(cell.rationale).toBeTruthy();
        }
      }
    });

    // A deviation is a harness fact like any level (ADR-0019), so it cites a
    // capture the same profile records as a validation, rather than evidence
    // that exists only in the declaration. A degradation (ADR-0021) cites the
    // capture that makes its translation necessary. Both share one id space,
    // because `components.accept` names them the same way.
    it("declares each Agent Plugin deviation and degradation with a stable id and validated evidence", () => {
      const profiles = [...(adapter.agentPluginProjector?.profiles ?? []), ...(adapter.projectComponentProfiles ?? [])];
      for (const profile of profiles) {
        const validated = new Set(profile.source.validatedOn.map((record) => record.artifact));
        for (const [component, cell] of Object.entries(profile.components)) {
          const declared = [...(cell.deviations ?? []), ...(cell.degradations ?? [])];
          const ids = declared.map((deviation) => deviation.id);
          expect(new Set(ids).size, `${profile.range} ${component} repeats a deviation or degradation id`).toBe(
            ids.length,
          );
          for (const deviation of declared) {
            const label = `${profile.range} ${component} ${deviation.id}`;
            expect(deviation.id, label).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
            expect(deviation.summary, `${label} needs a summary`).toBeTruthy();
            expect(validated.has(deviation.evidence), `${label} cites evidence no validatedOn record names`).toBe(true);
          }
        }
      }
    });

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
        expect(profile.source.date, `profile ${profile.range} needs source date`).toBeTruthy();
        // Structured records, not prose: at least one validation event, and
        // at least one of them captured -- doc-derived-only support is not
        // validation.
        expect(profile.source.validatedOn.length, `profile ${profile.range} needs validatedOn records`).toBeGreaterThan(
          0,
        );
        expect(
          profile.source.validatedOn.some((record) => record.method === "captured"),
          `profile ${profile.range} needs at least one captured record`,
        ).toBe(true);
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
        expect(unknown, `profile ${profile.range}: unregistered capability ids: ${unknown.join(", ")}`).toEqual([]);
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

    it("classifies the tool of every fixture exactly as its decoder did", () => {
      // `hooknostic dispatch` builds a test event's whole tool view from
      // classifyTool (ADR-0023), so it must reproduce the decoder's output, not
      // an approximation of it.
      for (const name of fixtureNames) {
        const tool = loadFixtureFrom<{ tool?: ToolInvocation }>(join(options.fixturesDir, name)).tool;
        if (tool === undefined) continue;
        expect(adapter.classifyTool, `${name} has a tool but adapter has no classifyTool`).toBeDefined();
        expect(adapter.classifyTool!(tool.nativeName, tool.input), name).toEqual(tool);
      }
    });

    it("backs every shell shape table entry with a fixture", () => {
      // Coverage from the TABLE side. The round-trip obligation above iterates
      // fixtures, so a new ShellShapes entry shipped without a shell-bearing
      // fixture was silently uncovered -- exactly the gap the obligation is
      // advertised to close. Case-insensitive name match, because adapters may
      // normalize tool names (OpenCode lowercases) and the testkit does not
      // see the normalizer.
      const shapes = adapter.shellShapes ?? {};
      const shellFixtureNames = new Set(
        fixtureNames
          .map(
            (name) =>
              loadFixtureFrom<{ tool?: { nativeName?: string; shell?: unknown } }>(join(options.fixturesDir, name))
                .tool,
          )
          .filter((tool) => tool?.shell !== undefined)
          .map((tool) => tool!.nativeName!.toLowerCase()),
      );
      const uncovered = Object.keys(shapes).filter((key) => !shellFixtureNames.has(key.toLowerCase()));
      expect(uncovered, `shape entries with no fixture: ${uncovered.join(", ")}`).toEqual([]);
    });

    it("re-derives the file view of every fixture through its codec", () => {
      // ADR-0026: wherever a canonical fixture advertises tool.file, the
      // adapter's file codec must exist and reproduce it from the fixture's own
      // input -- the same obligation the shell view carries, read side only.
      for (const name of fixtureNames) {
        const tool = loadFixtureFrom<{ tool?: { nativeName: string; input: unknown; file?: unknown } }>(
          join(options.fixturesDir, name),
        ).tool;
        if (tool?.file === undefined) continue;
        expect(adapter.fileCodec, `${name} has tool.file but adapter has no file codec`).toBeDefined();
        expect(
          adapter.fileCodec!.classify(tool.nativeName, tool.input),
          `${name}: codec does not classify its own fixture`,
        ).toEqual(tool.file);
      }
    });

    it("backs every file shape table entry with a fixture", () => {
      // Table-side coverage, as for shell shapes: an entry with no fixture
      // carrying the view is a claim nothing checks.
      const covered = new Set(
        fixtureNames
          .map(
            (name) =>
              loadFixtureFrom<{ tool?: { nativeName?: string; file?: unknown } }>(join(options.fixturesDir, name)).tool,
          )
          .filter((tool) => tool?.file !== undefined)
          .map((tool) => tool!.nativeName!.toLowerCase()),
      );
      const uncovered = Object.keys(adapter.fileShapes ?? {}).filter((key) => !covered.has(key.toLowerCase()));
      expect(uncovered, `file shape entries with no fixture: ${uncovered.join(", ")}`).toEqual([]);
    });

    it("keeps its harness metadata consistent with its profiles and fixtures", () => {
      const meta = adapter.harness;
      // fixtureDir pins the one name that was previously derived from nothing.
      expect(basename(options.fixturesDir), "fixturesDir basename must equal harness.fixtureDir").toBe(meta.fixtureDir);
      // recommendedRange must resolve cleanly (i.e. be a subset of profile
      // coverage) -- HN203 here means the recommendation outruns the evidence.
      const atRecommended = adapter.capabilities({
        id: adapter.id,
        version: meta.recommendedRange,
        delivery: options.delivery ?? "project",
        output: ".",
      });
      expect(
        atRecommended.diagnostics.map((d) => d.code),
        `recommendedRange ${meta.recommendedRange} must resolve without diagnostics`,
      ).toEqual([]);
      expect(
        rangeCoversVersion(meta.recommendedRange, meta.referenceVersion),
        `referenceVersion ${meta.referenceVersion} must satisfy recommendedRange`,
      ).toBe(true);
      // The build tests exercise referenceVersion; it must be a captured
      // build, not an inferred one.
      const records = resolved.profilesUsed.flatMap((profile) => profile.source.validatedOn);
      expect(
        records.some((r) => r.version === meta.referenceVersion && r.method === "captured"),
        `referenceVersion ${meta.referenceVersion} needs a captured validatedOn record`,
      ).toBe(true);
    });

    it("claims validation only for versions inside some profile range", () => {
      for (const profile of resolved.profilesUsed) {
        for (const record of profile.source.validatedOn) {
          expect(
            adapter.supportedHarnessVersions().some((range) => rangeCoversVersion(range, record.version)),
            `validatedOn ${record.version} (${record.method}) falls outside every profile range`,
          ).toBe(true);
        }
      }
    });

    // ctx.plugin.root is resolved from where hookRuntimePath says the runtime is
    // (ADR-0020); if compile() put it anywhere else, every hook would be handed
    // a path to some other directory, and nothing else would notice.
    it("places the hook runtime where hookRuntimePath says, on every delivery", async () => {
      if (adapter.hookRuntimePath === undefined) return;
      const event = observedEvents[0];
      if (event === undefined) return;
      const { ir } = buildPluginIR(definePlugin({ name: "contract", hooks: [hook(event, { id: "h", run() {} })] }));
      const bundle = { code: "// contract runtime\n" };
      // A delivery may be established on only part of the adapter's range
      // (Codex plugin hooks start at 0.153), so each is audited at the first
      // range the adapter itself declares that compiles it.
      const ranges = [
        ...new Set([
          options.version ?? adapter.harness.recommendedRange,
          ...(adapter.agentPluginProjector?.profiles ?? []).map((profile) => profile.range),
          ...adapter.supportedHarnessVersions(),
        ]),
      ];
      for (const delivery of adapter.supportedDeliveries()) {
        let artifacts: Awaited<ReturnType<HarnessAdapter["compile"]>> | undefined;
        for (const version of ranges) {
          try {
            const target = { id: adapter.id, version, delivery, output: "." };
            artifacts = await adapter.compile(ir!, target, bundle, { runtime: DEFAULT_RUNTIME });
            break;
          } catch {
            // Not established at this range; try the next.
          }
        }
        expect(artifacts, `${delivery} compiles at no declared range`).toBeDefined();
        const runtimes = artifacts!.filter((artifact) => artifact.contents === bundle.code).map((a) => a.path);
        expect(runtimes, delivery).toEqual([adapter.hookRuntimePath(delivery)]);
      }
    });

    it("declares how its artifact is executed", () => {
      // shimExecution decides whether a bundled CLI main guard is a hazard
      // (HN502) and whether process.execPath is the host rather than Node.
      expect(["command", "module"]).toContain(adapter.shimExecution);
      expect(adapter.supportedDeliveries().length).toBeGreaterThan(0);
    });
  });
}
