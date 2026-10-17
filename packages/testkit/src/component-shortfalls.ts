import { expect } from "vitest";

import type { HarnessAdapter } from "@hooknostic/core";

/** Shared by the adapter contract and its synthetic regression tests. */
export function assertComponentShortfalls(
  adapter: Pick<HarnessAdapter, "agentPluginProjector" | "projectComponentProfiles">,
): void {
  const profiles = [...(adapter.agentPluginProjector?.profiles ?? []), ...(adapter.projectComponentProfiles ?? [])];
  const owners = new Map<string, { kind: string; component: string }>();
  for (const profile of profiles) {
    const validated = new Set(profile.source.validatedOn.map((record) => record.artifact));
    for (const [component, cell] of Object.entries(profile.components)) {
      const declared = [
        ...(cell.deviations ?? []).map((declaration) => ({ kind: "deviation", declaration })),
        ...(cell.degradations ?? []).map((declaration) => ({ kind: "degradation", declaration })),
        ...(cell.omission === undefined ? [] : [{ kind: "omission", declaration: cell.omission }]),
      ];
      if (cell.omission !== undefined)
        expect(cell.level, "only unsupported components declare omissions").toBe("unsupported");
      const ids = declared.map(({ declaration }) => declaration.id);
      expect(new Set(ids).size, `${profile.range} ${component} repeats a shortfall id`).toBe(ids.length);
      for (const { kind, declaration: deviation } of declared) {
        const label = `${profile.range} ${component} ${deviation.id}`;
        expect(deviation.id, label).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        expect(deviation.summary, `${label} needs a summary`).toBeTruthy();
        expect(validated.has(deviation.evidence), `${label} cites evidence no validatedOn record names`).toBe(true);
        const owner = owners.get(deviation.id);
        if (owner === undefined) {
          owners.set(deviation.id, { kind, component });
        } else {
          expect(kind, `${label} reuses the ${owner.kind} ID from ${owner.component}`).toBe(owner.kind);
          // A deviation can describe one harness behavior across transports
          // (Claude's environment expansion does). Omissions acknowledge one
          // component only; reusing an ID would silently waive another one.
          if (kind === "omission")
            expect(component, `${label} reuses the omission ID from ${owner.component}`).toBe(owner.component);
        }
      }
    }
  }
}
