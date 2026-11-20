import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { afterAll, expect, it } from "vitest";

import { HOOKNOSTIC_VERSION } from "@hooknostic/core";

import { runCli } from "./cli.js";
import { runDoctor } from "./doctor.js";
import { defaultAdapterRegistry } from "./registry.js";

const REPO = resolve(import.meta.dirname, "../../..");
const OTHER = "0.11.9";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })));
});

/**
 * The local-project example outside the workspace, with a registry-style copy
 * of the built SDK from another release; returns its config.
 */
async function skewedLocalProject(): Promise<string> {
  expect(OTHER).not.toBe(HOOKNOSTIC_VERSION);
  const root = await mkdtemp(join(tmpdir(), "hooknostic-cli-skew-"));
  roots.push(root);
  await cp(join(REPO, "examples/local-project"), root, {
    recursive: true,
    filter: (src) => basename(src) !== "node_modules",
  });
  const sdk = join(root, "node_modules/@hooknostic/sdk");
  // What the package publishes ("files"), so the bundler finds its notice.
  await cp(join(REPO, "packages/sdk/dist"), join(sdk, "dist"), { recursive: true });
  await cp(join(REPO, "packages/sdk/LICENSE"), join(sdk, "LICENSE"));
  const manifest = JSON.parse(await readFile(join(REPO, "packages/sdk/package.json"), "utf8")) as object;
  await writeFile(join(sdk, "package.json"), JSON.stringify({ ...manifest, version: OTHER }, null, 2));
  return join(root, "hooknostic.config.ts");
}

async function cli(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, { io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) } });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** The HN110 headers a command printed: one per HN110, printed as `check` prints it (#260). */
const hn110Lines = (output: string) => output.split("\n").filter((line) => line.startsWith("HN110 "));
const HN110_HEADER = "HN110 CLI and project SDK on different releases [warn]";
/** HN110's message, as the indented line of its printed diagnostic. */
const HN110_MESSAGE = `\n  this hooknostic is ${HOOKNOSTIC_VERSION}, `;

it("warns HN110 from sync and verify without failing either (#194)", { timeout: 120_000 }, async () => {
  const config = await skewedLocalProject();
  for (const command of ["sync", "verify"]) {
    const { code, out, err } = await cli([command, "--config", config]);
    expect(code, out + err).toBe(0);
    // Once per run: buildProject reports it, and runProject does not repeat it.
    expect(hn110Lines(out + "\n" + err)).toEqual([HN110_HEADER]);
    expect(out).toContain(HN110_MESSAGE);
    // A blank line, as `check` prints one, separates the last diagnostic's
    // remediation from the command's own lines (#260).
    expect(out).toMatch(/\n {2}Remediation: [^\n]*\n\n(?=\S)/);
  }
});

// Three builds of five targets (sync, then verify inside each doctor run),
// where its neighbours budget 120 s for two: Windows runners are slow here (#262).
it(
  "doctor warns HN110 once, beside its version line, for a project with project targets (#257)",
  {
    timeout: 180_000,
  },
  async () => {
    const config = await skewedLocalProject();
    const synced = await cli(["sync", "--config", config]);
    expect(synced.code, synced.out + synced.err).toBe(0);
    // No harness detected, without spawning one: the harness entries alone fail
    // doctor, so `project.ok` is where HN110 could have failed it.
    const registry = defaultAdapterRegistry();
    for (const [id, adapter] of Object.entries(registry))
      registry[id] = { ...adapter, detect: async () => ({ installed: false }) };

    const human = { out: [] as string[], err: [] as string[] };
    const code = await runDoctor({
      config,
      registry,
      io: { stdout: (text) => human.out.push(text), stderr: (text) => human.err.push(text) },
    });
    expect(code, human.out.join("\n") + human.err.join("\n")).toBe(2);
    // The project's verify reports it too; doctor prints it once, after its version line.
    expect(hn110Lines(human.out.join("\n"))).toEqual([HN110_HEADER]);
    expect(human.out[1]).toMatch(/^HN110 CLI and project SDK on different releases \[warn\]\n/);
    expect(human.out[1]).toContain(HN110_MESSAGE);

    const machine: string[] = [];
    expect(
      await runDoctor({ config, json: true, registry, io: { stdout: (text) => machine.push(text), stderr: () => {} } }),
    ).toBe(code);
    const payload = JSON.parse(machine.join("")) as {
      configurationErrors: string[];
      diagnostics: { code: string; message: string }[];
      project: { ok: boolean; diagnostics: { code: string; message: string }[] };
    };
    expect(payload.configurationErrors).toEqual([]);
    expect(payload.project.ok).toBe(true);
    expect(payload.diagnostics.map((d) => d.code)).toEqual(["HN110"]);
    // The project report keeps its own copy, as sync and verify report it.
    expect(payload.project.diagnostics.filter((d) => d.code === "HN110")).toEqual(payload.diagnostics);
  },
);

it("warns HN110 from sync, verify and recover when the config fails to load (#194)", { timeout: 120_000 }, async () => {
  const config = await skewedLocalProject();
  await writeFile(config, 'import { notInThisSdk } from "@hooknostic/sdk";\nexport default notInThisSdk({});\n');
  // recover shares runProject's load-failure branch, where the skew may explain the failure.
  for (const command of ["sync", "verify", "recover"]) {
    const human = await cli([command, "--config", config]);
    expect(human.code, human.out + human.err).toBe(2);
    expect(human.err).toContain("notInThisSdk");
    expect(hn110Lines(human.out)).toEqual([HN110_HEADER]);
    expect(human.out).toContain(HN110_MESSAGE);

    const json = await cli([command, "--config", config, "--json"]);
    expect(json.code, json.out + json.err).toBe(2);
    const report = JSON.parse(json.out) as { errors: string[]; diagnostics: { code: string }[] };
    expect(report.errors).toHaveLength(1);
    // The load's HN501 follows, as buildProject orders them (#260).
    expect(report.diagnostics.map((d) => d.code)).toEqual(["HN110", "HN501"]);
  }
});
