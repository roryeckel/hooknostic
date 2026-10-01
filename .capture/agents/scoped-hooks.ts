// Hooks for the .capture/agents `scoped` case (ADR-0030), all scoped to agents.
//
// - `probe-only` blocks the probe subagent's first tool call -- its read of
//   seed.txt, or on Codex its shell write -- and lets its second through. The
//   parent's own delegation call must never be blocked.
// - `nobody` is scoped to an agent that never runs, and must block nothing.
// - `probe-after` appends what it saw to HKN_SCOPE_TRACE, which must hold the
//   probe's events and no one else's.
//
// Each block reason is a marker the drive looks for in the model requests.
// scoped-lifecycle-hooks.ts adds the subagent lifecycle, for the harnesses
// that have one.
import { appendFileSync } from "node:fs";

import type { HookDefinition, HookEvent } from "@hooknostic/sdk";
import { block, definePlugin, hook } from "@hooknostic/sdk";

export const trace = (event: HookEvent): void => {
  const path = process.env["HKN_SCOPE_TRACE"];
  if (path === undefined) return;
  const tool = "tool" in event ? event.tool.nativeName : undefined;
  appendFileSync(path, `${JSON.stringify({ event: event.event, agentType: event.correlation.agentType ?? null, tool })}\n`);
};

export const toolHooks: HookDefinition[] = [
  hook("tool.before", {
    id: "probe-only",
    agents: { include: ["hn-probe"] },
    capabilities: { block: "required" },
    run: ({ tool }) => {
      const guarded =
        (tool.file?.paths ?? []).some((path) => path.endsWith("seed.txt")) ||
        (tool.shell?.command ?? "").includes("hn-child-write");
      return guarded ? block("HKN-SCOPED-BLOCK") : undefined;
    },
  }),
  hook("tool.before", {
    id: "nobody",
    agents: { include: ["hn-nobody"] },
    capabilities: { block: "required" },
    run: () => block("HKN-UNSCOPED-BLOCK"),
  }),
  hook("tool.after", { id: "probe-after", agents: { include: ["hn-probe"] }, run: trace }),
];

export default definePlugin({ name: "hn-scope", hooks: toolHooks });
