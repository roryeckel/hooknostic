import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { pluginRootFrom } from "./plugin-root.js";

describe("pluginRootFrom", () => {
  const runtime = pathToFileURL(resolve("plugin root", "runtime", "hooknostic.mjs")).href;

  it("resolves the offset against the runtime's directory, not the process cwd", () => {
    expect(pluginRootFrom(runtime, "..")).toBe(resolve("plugin root"));
    expect(pluginRootFrom(runtime, "../package")).toBe(join(resolve("plugin root"), "package"));
    expect(pluginRootFrom(runtime, ".")).toBe(join(resolve("plugin root"), "runtime"));
  });
});
