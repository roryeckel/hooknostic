import { describe, expect, it } from "vitest";

import { type AdapterRegistry, type HarnessAdapter, registeredAdapter } from "./adapter.js";

describe("registeredAdapter", () => {
  // Never called: the lookup only has to hand back the registered object.
  const claude = { id: "claude" } as HarnessAdapter;
  const registry: AdapterRegistry = { claude };

  it("returns the adapter registered under its own key", () => {
    expect(registeredAdapter(registry, "claude")).toBe(claude);
  });

  it.each(["toString", "__proto__", "constructor", "hasOwnProperty"])(
    "treats %s, inherited from Object.prototype, as unregistered (#195)",
    (id) => {
      expect(registeredAdapter(registry, id)).toBeUndefined();
    },
  );
});
