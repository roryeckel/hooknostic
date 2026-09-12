import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

it("bundles all compiler prerequisites before playback and drift verification", () => {
  const scripts = JSON.parse(read("package.json")).scripts;
  expect(scripts.bundle).toBe(
    "pnpm --filter @hooknostic/agent-plugin run bundle && pnpm --filter @hooknostic/sdk run bundle && pnpm --filter hooknostic run bundle",
  );
  expect(scripts.pretest).toBe("pnpm run bundle");
  expect(read(".github/workflows/ci.yml")).toContain("run: pnpm run bundle");
  expect(read(".github/workflows/harness-watch.yml").match(/run: pnpm run bundle/g)).toHaveLength(2);
});

it("keeps formatting a pinned root script and a CI gate", () => {
  const scripts = JSON.parse(read("package.json")).scripts;
  expect(scripts.format).toBe("prettier --write .");
  expect(scripts["format:check"]).toBe("prettier --check .");
  expect(read(".github/workflows/ci.yml")).toContain("run: pnpm format:check");
});

it("wires the draft gate to CI workflow runs instead of all checks on its own commit", () => {
  const draft = read(".github/workflows/release-draft.yml");
  expect(draft).toContain("actions: read");
  expect(draft).toContain('node scripts/wait-for-ci.mjs "${{ github.repository }}" "$SHA"');
  expect(draft).not.toContain("/check-runs");
});

it("makes bootstrap attachment and OIDC publication mutually exclusive behind the existing guards", () => {
  const publish = read(".github/workflows/release-publish.yml");
  expect(publish).toContain("vars.NPM_PUBLICATION_MODE || 'oidc'");
  expect(publish).toContain("bootstrap|oidc)");
  expect(publish).toContain("if: steps.publication.outputs.mode == 'bootstrap'");
  expect(publish).toContain("node scripts/bootstrap-release.mjs");
  const steps = publish.split(/\n {6}- name: /);
  const mode = steps.find((step) => step.startsWith("Validate publication mode"));
  expect(mode).toContain("id: publication");
  expect(mode).toContain("vars.NPM_PUBLICATION_MODE || 'oidc'");
  expect(mode).toContain('echo "mode=$NPM_PUBLICATION_MODE" >> "$GITHUB_OUTPUT"');
  const publishing = steps.filter((step) => /pnpm publish/.test(step) && /working-directory:/.test(step));
  expect(publishing).toHaveLength(3);
  for (const step of publishing) expect(step).toContain("if: steps.publication.outputs.mode == 'oidc'");
  expect(publish).toContain("environment: npm");
  expect(publish).toContain("private === true");
  expect(publish).toContain("scripts/set-versions.mjs --check");
});
