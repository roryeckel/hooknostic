import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@hooknostic/core";
import { defaultAdapterRegistry } from "./registry.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const EXAMPLES = resolve(REPO_ROOT, "examples");

describe("example configs", () => {
  // Examples are consumer-shaped product surface, so they carry literal
  // version ranges like a real consumer would -- but an unenforced literal is
  // exactly what drifted in the docs before. loadConfig (not a grep) so the
  // check also proves each example config still parses.
  it("target every adapter at its recommended range", async () => {
    const registry = defaultAdapterRegistry();
    const dirs = readdirSync(EXAMPLES, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      const configPath = resolve(EXAMPLES, dir, "hooknostic.config.ts");
      const loaded = await loadConfig(configPath);
      expect(loaded.diagnostics, `${dir}: config must load cleanly`).toEqual([]);
      for (const [id, target] of Object.entries(loaded.config?.targets ?? {})) {
        const adapter = registry[id];
        expect(adapter, `${dir}: unknown target ${id}`).toBeDefined();
        expect(
          target.version,
          `${dir}: ${id} target should use the recommended range`,
        ).toBe(adapter!.harness.recommendedRange);
      }
    }
  });
});
