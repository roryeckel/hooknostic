import type { CapabilityId } from "@hooknostic/sdk";
import { HOOK_EVENT_NAMES } from "@hooknostic/sdk";
import type { HarnessAdapter } from "@hooknostic/core";
import { describe, expect, it } from "vitest";

/**
 * The scenario registry: the executable contract between the capability
 * profiles and harness-watch's automated verification (ADR-0010).
 *
 * Every capability cell a profile rates must be exercised by at least one
 * scheduled scenario â€” supported cells by a scenario that asserts the
 * documented behavior, explicitly-unsupported cells by a scenario that
 * watches for the channel starting to work (an explicit "we checked, and it
 * does not work" is a claim, and claims drift). The registry is the single
 * source for three consumers:
 *
 * - `describeScenarioCoverage` (here) fails CI when a cell has no scenario;
 * - the playback suite (`packages/cli/test/harness-playback*.ts`) maps
 *   scenario ids onto loopback drives and assertions;
 * - harness-watch's drift comparator derives its expected variant set from
 *   the same entries, so a scenario and a fixture can never quietly diverge.
 *
 * Registry entries describe *what is driven and asserted*, never how the
 * harness should behave â€” every behavioral expectation comes from captured
 * evidence (fixtures, profile rationales), not from the registry.
 */

/**
 * How the scenario's harness session is driven.
 *
 * - `loopback` â€” model-free: the harness binary runs against the scripted
 *   loopback model server (`.capture/harness-playback/README.md`).
 * - `pty-approval` â€” real interactive TTY: approval/permission prompts only
 *   surface in interactive sessions.
 * - `mcp-stdio` â€” an in-repo stdio MCP fixture server is registered with the
 *   harness so MCP-only channels can fire.
 * - `compaction` â€” context growth until the harness compacts.
 * - `subagent` â€” a subagent-spawning tool call driven off the harness's own
 *   live tool schema.
 * - `opencode-serve` â€” OpenCode driven under `opencode serve` so the client
 *   channel outlives a turn (see `turn.stop.prevent`'s rationale).
 */
export type ScenarioDriver =
  | "loopback"
  | "pty-approval"
  | "mcp-stdio"
  | "compaction"
  | "subagent"
  | "opencode-serve";

export interface ScenarioDefinition {
  /** Stable id; the playback suite keys its drives and outcome JSON on this. */
  id: string;
  /** What the scenario proves, in consumer terms. */
  title: string;
  /**
   * Capability cells this scenario exercises. Attribution is per-adapter: a
   * listed cell only counts for an adapter whose resolved matrix actually
   * carries the cell â€” the registry stays harness-agnostic.
   */
  covers: readonly CapabilityId[];
  /** Default driver; `driverByHarness` overrides per harness id. */
  driver: ScenarioDriver;
  driverByHarness?: Partial<Record<string, ScenarioDriver>>;
}

const EVERY_EVENT_OBSERVE = Object.freeze(
  HOOK_EVENT_NAMES.map((event) => `${event}.observe`) as CapabilityId[],
);

/**
 * One entry per capability family, in event-vocabulary order. A scenario may
 * carry several cells (one drive exercises an effect family); a cell may
 * appear in several scenarios (observe cells ride along every drive).
 */
export const SCENARIOS: readonly ScenarioDefinition[] = [
  {
    id: "lifecycle-observe",
    title:
      "every advertised observable event reaches the artifact and normalizes to its canonical event name",
    covers: EVERY_EVENT_OBSERVE,
    driver: "loopback",
  },
  {
    id: "session-start-context-add",
    title: "session-start injected context reaches the model in the first agent request",
    covers: ["session.start.context.add"],
    driver: "loopback",
  },
  {
    id: "prompt-before-block",
    title: "blocking the prompt aborts the turn before any agent model request is made",
    covers: ["prompt.before.block"],
    driver: "loopback",
  },
  {
    id: "prompt-before-context-add",
    title: "prompt-prepended context reaches the model in the first agent request",
    covers: ["prompt.before.context.add"],
    driver: "loopback",
  },
  {
    id: "tool-before-block",
    title: "blocking a pending tool call prevents its process from executing",
    covers: ["tool.before.block"],
    driver: "loopback",
  },
  {
    id: "tool-before-rewrite",
    title: "rewriting the shell command rewrites what the harness spawns",
    covers: ["tool.before.input.replace"],
    driver: "loopback",
  },
  {
    id: "tool-before-approval",
    title: "asking for approval surfaces the harness's native interactive prompt",
    covers: ["tool.before.requestApproval"],
    driver: "pty-approval",
  },
  {
    id: "tool-before-context-add",
    title: "tool-call-time injected context reaches the model with the tool result",
    covers: ["tool.before.context.add"],
    driver: "loopback",
  },
  {
    id: "tool-after-context-add",
    title: "post-tool injected context reaches the model on the next request",
    covers: ["tool.after.context.add"],
    driver: "loopback",
  },
  {
    id: "tool-after-block-continuation",
    title: "blocking continuation surfaces the block reason to the model, which decides whether to stop",
    covers: ["tool.after.blockContinuation"],
    driver: "loopback",
  },
  {
    id: "tool-after-output-replace",
    title: "replacing the tool output replaces what the model sees (or stays rejected where explicitly unsupported)",
    covers: ["tool.after.output.replace"],
    driver: "loopback",
    // Captured live on 0.151.0 (.capture/codex-tools): the hook engine
    // strictly rejects updatedMCPToolOutput from a PostToolUse hook (fails
    // open). The codex lane is an inverted watch: the drive must observe the
    // rejection, not a replaced output.
    driverByHarness: { codex: "mcp-stdio" },
  },
  {
    id: "tool-error",
    title: "a failing shell command dispatches tool.error and injected error context reaches the model",
    covers: ["tool.error.observe", "tool.error.context.add"],
    driver: "loopback",
  },
  {
    id: "permission-request",
    title: "an interactive permission prompt is observable and deniable from a hook",
    covers: [
      "permission.request.observe",
      "permission.request.block",
      "permission.request.context.add",
    ],
    driver: "pty-approval",
    // Captured live on 1.18.25 (.capture/opencode-permission): OpenCode's
    // permission ask surfaces as the permission.asked bus event whether or
    // not a terminal is attached, and the deny is delivered via the client
    // reply API -- so the serve lane drives it headlessly (the dedicated
    // permission.ask callback never fires; upstream anomalyco/opencode #9229).
    driverByHarness: { opencode: "opencode-serve" },
  },
  {
    id: "context-compact",
    title: "compaction dispatches its before/after hooks; blocking and context injection honoured where claimed",
    covers: [
      "context.compact.before.observe",
      "context.compact.before.block",
      "context.compact.before.context.add",
      "context.compact.after.observe",
    ],
    driver: "compaction",
  },
  {
    id: "agent-subagent",
    title: "a spawned subagent dispatches agent start/stop",
    covers: ["agent.start.observe", "agent.stop.observe"],
    driver: "subagent",
  },
  {
    id: "stop-prevent",
    title: "preventing the first stop makes the harness take another model turn",
    covers: ["agent.stop.prevent", "turn.stop.prevent"],
    driver: "loopback",
    driverByHarness: { opencode: "opencode-serve" },
  },
  {
    id: "stop-notify",
    title: "stop-time notifications surface where claimed, and stay inert where explicitly unsupported",
    covers: ["agent.stop.notify", "turn.stop.notify"],
    driver: "loopback",
    // OpenCode's notify channel posts into the session via promptAsync
    // (noReply); only a session that outlives the turn exposes the
    // transcript it lands in (see turn.stop.prevent's rationale).
    driverByHarness: { opencode: "opencode-serve" },
  },
  {
    id: "shell-tool-variants",
    title: "every shell shape the adapter classifies and fixtures capture is drivable and observable end to end",
    covers: ["tool.before.observe", "tool.after.observe"],
    driver: "loopback",
  },
];

export function scenarioById(id: string): ScenarioDefinition | undefined {
  return SCENARIOS.find((scenario) => scenario.id === id);
}

export interface ScenarioCoverageGap {
  cell: CapabilityId;
  /** Why the cell needs a scenario. */
  requiredBecause: "supported" | "explicitly-unsupported";
  level: "exact" | "emulated" | "approximate" | "unsupported";
}

export interface ScenarioCoverageResult {
  resolvedCellCount: number;
  attributedCellCount: number;
  gaps: ScenarioCoverageGap[];
}

/**
 * Coverage audit: every cell in the adapter's resolved matrix at
 * `referenceVersion` (the build scheduled playback drives) must map to at
 * least one scenario. Non-unsupported cells need direct coverage; explicit
 * `unsupported` entries need inverted-watch coverage (a channel the adapter
 * documents as not working must stay not-working).
 */
export function assessScenarioCoverage(
  adapter: HarnessAdapter,
  scenarios: readonly ScenarioDefinition[] = SCENARIOS,
): ScenarioCoverageResult {
  const resolved = adapter.capabilities({
    id: adapter.id,
    version: adapter.harness.referenceVersion,
    mode: "local",
    output: ".",
  });
  if (resolved.matrix === undefined) {
    throw new Error(`${adapter.id}: capabilities did not resolve at referenceVersion`);
  }

  const attributed = new Set<CapabilityId>(
    scenarios.flatMap((scenario) => scenario.covers),
  );

  const gaps: ScenarioCoverageGap[] = [];
  for (const [cell, entry] of Object.entries(resolved.matrix)) {
    const id = cell as CapabilityId;
    if (attributed.has(id)) continue;
    gaps.push({
      cell: id,
      level: entry.level,
      requiredBecause: entry.level === "unsupported" ? "explicitly-unsupported" : "supported",
    });
  }

  return {
    resolvedCellCount: Object.keys(resolved.matrix).length,
    attributedCellCount: attributed.size,
    gaps,
  };
}

export interface ScenarioCoverageOptions {
  /**
   * Drivers that cannot run in a given environment record themselves here
   * instead of failing: an *untestable* scenario must never be silent, but it
   * is also not a contract breach. The scheduled workflow surfaces
   * `inconclusive` outcomes in its step summary every run.
   */
  unavailableDrivers?: readonly ScenarioDriver[];
}

/**
 * The vitest face of {@link assessScenarioCoverage}. Wire from the adapter
 * suite next to `describeAdapterContract` â€” registration order of the default
 * registry is what keeps a per-adapter row from being forgettable.
 */
export function describeScenarioCoverage(adapter: HarnessAdapter): void {
  describe(`scenario coverage: ${adapter.id}`, () => {
    it("maps every resolved capability cell to at least one scenario", () => {
      const { gaps } = assessScenarioCoverage(adapter);
      expect(
        gaps,
        `${adapter.id} cells without any scenario in the registry: ${gaps
          .map((gap) => `${gap.cell} (${gap.requiredBecause})`)
          .join(", ")}`,
      ).toEqual([]);
    });

    it("covers supported cells with a driver that can actually exercise them", () => {
      const RUNNABLE_DRIVERS = new Set<ScenarioDriver>([
        "loopback",
        "pty-approval",
        "mcp-stdio",
        "compaction",
        "subagent",
        "opencode-serve",
      ]);
      for (const scenario of SCENARIOS) {
        for (const cell of scenario.covers) {
          const driver = scenario.driverByHarness?.[adapter.id] ?? scenario.driver;
          expect(
            RUNNABLE_DRIVERS.has(driver),
            `scenario ${scenario.id} drives cell ${cell} via unknown driver "${driver}"`,
          ).toBe(true);
        }
      }
    });
  });
}

