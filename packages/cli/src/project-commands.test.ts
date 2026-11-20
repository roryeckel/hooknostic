import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, it } from "vitest";

import { claudeHarness } from "@hooknostic/adapter-claude";

import { runCli } from "./cli.js";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })));
});

/** A scratch directory holding `config` as its hooknostic.config.ts, and an empty hook source. */
async function projectWith(config: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-cli-project-diagnostics-"));
  roots.push(root);
  await writeFile(join(root, "hooks.ts"), `export default { name: "project-diagnostics", hooks: [] };`);
  const path = join(root, "hooknostic.config.ts");
  await writeFile(path, config);
  return path;
}

async function cli(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, { io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) } });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

// The project commands print a diagnostic as `check` does, remediation included (#260).
it.each(["sync", "verify", "recover"])(
  "%s prints a config load failure's remediation, and lists it in --json beside the unchanged error (#260)",
  async (command) => {
    // Fails before runProject reads project.root, so it needs none.
    const config = await projectWith(`throw new Error("boom");\n`);
    const failure = `failed to load config ${config}: boom`;

    const human = await cli([command, "--config", config]);
    expect(human.code, human.out + human.err).toBe(2);
    expect(human.out).toMatch(/^HN501 invalid configuration \[error\]$/m);
    expect(human.out).toContain(`\n  ${failure}\n`);
    expect(human.out).toContain(
      "\n  Remediation: the config must be a TypeScript module whose default export is defineConfig({...}).",
    );
    // Then a blank line, as `check` separates the diagnostics from what follows.
    expect(human.out).toMatch(/\n {2}Remediation: [^\n]*\n$/);
    // The one-line summary stays on stderr.
    expect(human.err).toBe(failure);

    const json = await cli([command, "--config", config, "--json"]);
    expect(json.code, json.out + json.err).toBe(2);
    const report = JSON.parse(json.out) as { errors: string[]; diagnostics: unknown[] };
    expect(report.errors).toEqual([failure]);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HN501",
        severity: "error",
        message: failure,
        remediation: expect.stringContaining("defineConfig"),
      }),
    );
  },
  60_000,
);

it("sync prints a build diagnostic's remediation (#260)", { timeout: 60_000 }, async () => {
  // `toString` is inherited from Object.prototype, so no adapter is registered for it (#195).
  const config = await projectWith(
    `export default { project: { root: "." }, entry: "./hooks.ts", targets: { claude: { adapter: "toString", version: ${JSON.stringify(claudeHarness.recommendedRange)}, delivery: "project", output: ".hooknostic/artifacts/claude" } } };\n`,
  );
  const human = await cli(["sync", "--config", config]);
  expect(human.code, human.out + human.err).toBe(2);
  expect(human.out).toMatch(/^HN501 invalid configuration \[error\]$/m);
  expect(human.out).toContain('\n  no adapter is registered for target "claude".\n');
  expect(human.out).toContain("\n  Remediation: available adapters: ");
});
