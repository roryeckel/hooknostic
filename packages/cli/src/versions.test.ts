import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultAdapterRegistry } from "./registry.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

function packageVersion(relDir: string): string {
  const manifest = JSON.parse(
    readFileSync(resolve(REPO_ROOT, relDir, "package.json"), "utf8"),
  ) as { version: string };
  return manifest.version;
}

describe("workspace version lockstep", () => {
  // Assert rather than derive: importing package.json into adapter source was
  // rejected because the CLI bundle would resolve the WRONG manifest via
  // createRequire (import.meta.url becomes the bundle), failing silently in
  // the published artifact while passing in tests. scripts/set-versions.mjs
  // rewrites the inlined literals; this test is what catches a missed one.
  it("keeps every adapterVersion equal to its package.json and the root", () => {
    const root = packageVersion(".");
    for (const adapter of Object.values(defaultAdapterRegistry())) {
      const pkg = packageVersion(`packages/adapter-${adapter.id}`);
      expect(adapter.adapterVersion, `adapter-${adapter.id} constant vs package.json`).toBe(pkg);
      expect(pkg, `adapter-${adapter.id} package.json vs root`).toBe(root);
    }
  });

  it("versions every workspace package in lockstep with the root", () => {
    const root = packageVersion(".");
    for (const dir of [
      "packages/sdk",
      "packages/agent-plugin",
      "packages/core",
      "packages/runtime",
      "packages/cli",
      "packages/testkit",
      "packages/adapter-claude",
      "packages/adapter-codex",
      "packages/adapter-opencode",
    ]) {
      expect(packageVersion(dir), dir).toBe(root);
    }
  });

  it("keeps exactly three packages publishable: agent-plugin, sdk, and cli", () => {
    // The executable publish-surface statement. It outlives the private:true
    // guard fields: when they are removed for the first public release, this
    // still pins WHICH packages may ship.
    const publishable: string[] = [];
    for (const dir of [
      "packages/sdk",
      "packages/agent-plugin",
      "packages/core",
      "packages/runtime",
      "packages/cli",
      "packages/testkit",
      "packages/adapter-claude",
      "packages/adapter-codex",
      "packages/adapter-opencode",
    ]) {
      const manifest = JSON.parse(
        readFileSync(resolve(REPO_ROOT, dir, "package.json"), "utf8"),
      ) as { name: string; private?: boolean };
      if (manifest.private !== true) publishable.push(manifest.name);
    }
    // While unreleased, all three ALSO carry private:true as the
    // never-publish guard, so nothing is publishable yet. The first public
    // release removes exactly those fields; either state passes, any
    // additional publishable package fails.
    const allowed = [[], ["@hooknostic/agent-plugin", "@hooknostic/sdk", "hooknostic"]];
    expect(allowed).toContainEqual(publishable.sort());
  });

  it("keeps both release workflows guarded by all three public packages", () => {
    const guard = "for pkg in packages/agent-plugin packages/sdk packages/cli; do";
    for (const workflow of ["release-draft.yml", "release-publish.yml"]) {
      expect(
        readFileSync(resolve(REPO_ROOT, ".github/workflows", workflow), "utf8"),
        workflow,
      ).toContain(guard);
    }
  });
});
