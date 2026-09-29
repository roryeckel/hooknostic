import { fileURLToPath } from "node:url";

import { expect } from "vitest";

import { opencodeAdapter, opencodeV1Adapter } from "@hooknostic/adapter-opencode";
import type { HarnessAdapter } from "@hooknostic/core";
import { resolveTargetAdapter } from "@hooknostic/core";

import { defaultAdapterRegistry } from "../src/registry.js";
import { runProcess } from "./harness-playback.js";

const repository = fileURLToPath(new URL("../../..", import.meta.url));

interface ScopedSummary {
  playbackErrors: string[];
  scope: { version: string; built: boolean; refusedBy: string[]; errors: string[] };
  blocks: { scopedInChild: boolean; scopedInParent: boolean; unscoped: boolean };
  childToolIdentity: boolean;
  scopeTrace: { event: string; agentType: string | null; tool?: string }[];
  parent: { childResultReturned: boolean };
  child: { requests: number };
}

/** The adapter a drive lane builds for, at the build it found installed. */
function laneAdapter(lane: string, version: string): HarnessAdapter {
  if (lane === "opencode-v1") return opencodeV1Adapter();
  if (lane === "opencode-v2") {
    return resolveTargetAdapter(opencodeAdapter(), { id: "opencode", version, delivery: "project", output: "." })
      .adapter!;
  }
  return defaultAdapterRegistry()[lane.startsWith("codex") ? "codex" : lane]!;
}

/**
 * The agent-scope scenario (ADR-0028), for one `.capture/agents` drive lane.
 *
 * The drive builds hooks scoped to its probe subagent for the harness build it
 * finds installed, so that build's own `agent.identity` level decides what is
 * expected. Where it is supported, a scoped guard must block the subagent's
 * guarded call and nothing of the parent's, a guard scoped to another agent must
 * never act, and scoped traces must see the subagent's events and no others.
 * Where it is not, the build must refuse the scope -- and the child's tool
 * events must still name no agent, so a harness that starts to is noticed.
 */
export async function expectAgentScope(lane: string): Promise<void> {
  const result = await runProcess(
    process.execPath,
    ["--experimental-strip-types", ".capture/agents/drive.mjs", lane, "--only", "scoped"],
    { cwd: repository, env: process.env, timeoutMs: 300_000 },
  );
  const output = result.stdout + result.stderr;
  expect(result.code, output).toBe(0);
  const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith("HKN-SUMMARY "));
  expect(line, output).toBeDefined();
  const summary = JSON.parse(line!.slice("HKN-SUMMARY ".length)) as ScopedSummary;
  expect(summary.playbackErrors).toEqual([]);

  const adapter = laneAdapter(lane, summary.scope.version);
  const matrix =
    adapter.capabilities({ id: adapter.id, version: summary.scope.version, delivery: "project", output: "." }).matrix ??
    {};
  const level = (id: string) => matrix[id as keyof typeof matrix]?.level ?? "unsupported";

  if (level("tool.before.agent.identity") === "unsupported") {
    expect(summary.scope.built, output).toBe(false);
    expect(summary.scope.refusedBy).toContain("HN201 tool.before.agent.identity");
    expect(summary.childToolIdentity, "the child's tool events now name the agent; revisit the profile").toBe(false);
    return;
  }

  expect(summary.scope.built, JSON.stringify(summary.scope)).toBe(true);
  expect(summary.child.requests, output).toBeGreaterThan(0);
  expect(summary.blocks).toEqual({ scopedInChild: true, scopedInParent: false, unscoped: false });
  expect(summary.parent.childResultReturned).toBe(true);
  expect(summary.scopeTrace.length, output).toBeGreaterThan(0);
  for (const row of summary.scopeTrace) expect(row.agentType, JSON.stringify(row)).toBe("hn-probe");
  const events = summary.scopeTrace.map((row) => row.event);
  expect(events).toContain("tool.after");
  if (level("agent.start.agent.identity") !== "unsupported") {
    expect(events).toEqual(expect.arrayContaining(["agent.start", "agent.stop"]));
  }
}
