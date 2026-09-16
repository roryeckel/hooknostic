import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { type HarnessAdapter, runProject } from "@hooknostic/core";
import { makeFakeAdapter } from "@hooknostic/testkit";

import { resolveOnPath, runDoctor } from "./doctor.js";

function fakeIO() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) },
    out,
    err,
  };
}

function adapterDetecting(version: string | undefined): HarnessAdapter {
  const base = makeFakeAdapter({
    id: "fake",
    profiles: [
      {
        range: ">=1.0 <2",
        matrix: { "session.start.observe": { level: "exact" } },
        source: {
          date: "2026-01-01",
          validatedOn: [
            {
              version: "1.2.0",
              date: "2026-01-15",
              method: "captured",
              what: "synthetic capture",
            },
          ],
        },
      },
    ],
    harness: {
      displayName: "Fake",
      recommendedRange: ">=1.2 <2",
      fixtureDir: "fake",
      referenceVersion: "1.2.0",
    },
  });
  return {
    ...base,
    async detect() {
      return version === undefined ? { installed: false } : { installed: true, version };
    },
  };
}

async function statusFor(installed: string | undefined): Promise<Record<string, unknown>> {
  const { io, out } = fakeIO();
  await runDoctor({ json: true, registry: { fake: adapterDetecting(installed) }, io });
  const payload = JSON.parse(out.join("")) as { harnesses: Record<string, unknown>[] };
  return payload.harnesses[0]!;
}

describe("doctor version comparison", () => {
  it("reports ok inside the recommended range", async () => {
    expect(await statusFor("1.3.0")).toMatchObject({ status: "ok", recommendedRange: ">=1.2 <2" });
  });

  it("distinguishes validated-but-outside-recommended from outside-validated", async () => {
    // 1.1.0 satisfies the validated ">=1.0 <2" but not the recommended
    // ">=1.2 <2" -- its own advisory, previously indistinguishable from ok.
    expect(await statusFor("1.1.0")).toMatchObject({ status: "outside-recommended" });
    expect(await statusFor("0.9.0")).toMatchObject({ status: "outside-validated" });
    expect(await statusFor("3.0.0")).toMatchObject({ status: "newer-than-validated" });
  });

  it("reports the newest validated build so OUR staleness is visible", async () => {
    const entry = await statusFor("1.5.0");
    expect(entry["newestValidated"]).toMatchObject({ version: "1.2.0", method: "captured" });
    // Human output carries the drift note for an in-range-but-newer install.
    const { io, out } = fakeIO();
    await runDoctor({ registry: { fake: adapterDetecting("1.5.0") }, io });
    expect(out.join("\n")).toContain("newer than the newest validated build (1.2.0");
    expect(out.join("\n")).toContain("docs/harness-support.md");
  });

  it("keeps not-detected reporting intact", async () => {
    expect(await statusFor(undefined)).toMatchObject({ status: "not-detected", installed: false });
  });

  it("accepts a clean empty-target project cleanup state", async () => {
    const root = await mkdtemp(join(tmpdir(), "hooknostic-doctor-empty-"));
    try {
      const configPath = join(root, "hooknostic.config.ts");
      await writeFile(join(root, "hooks.ts"), `export default { name: "empty-project", hooks: [] };`);
      await writeFile(configPath, `export default { project: { root: "." }, entry: "./hooks.ts", targets: {} };`);
      expect((await runProject({ command: "sync", configPath, registry: {} })).ok).toBe(true);

      const { io, out } = fakeIO();
      expect(await runDoctor({ config: configPath, json: true, registry: {}, io })).toBe(0);
      const payload = JSON.parse(out.join(""));
      expect(payload.configurationErrors).toEqual([]);
      expect(payload.project).toMatchObject({ ok: true, drift: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("resolveOnPath", () => {
  const separator = process.platform === "win32" ? ";" : ":";

  it("finds a command that is present, and reports one that is not", async () => {
    const root = await mkdtemp(join(tmpdir(), "hooknostic-path-"));
    try {
      await writeFile(join(root, "present"), "");
      const env = { PATH: root } as NodeJS.ProcessEnv;

      expect(resolveOnPath("present", env)).toBe(join(root, "present"));
      expect(resolveOnPath("absent", env)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("searches PATH entries in order", async () => {
    const first = await mkdtemp(join(tmpdir(), "hooknostic-path-a-"));
    const second = await mkdtemp(join(tmpdir(), "hooknostic-path-b-"));
    try {
      await writeFile(join(first, "tool"), "");
      await writeFile(join(second, "tool"), "");
      const env = { PATH: [first, second].join(separator) } as NodeJS.ProcessEnv;

      expect(resolveOnPath("tool", env)).toBe(join(first, "tool"));
    } finally {
      await rm(first, { recursive: true, force: true });
      await rm(second, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")(
    "resolves a Windows command shim, which is how npx and bun exist there",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "hooknostic-path-shim-"));
      try {
        // No `npx.exe` exists on Windows -- only `npx.cmd`. A bare-name check
        // would call the single most common MCP runner missing.
        await writeFile(join(root, "shim.CMD"), "");
        const env = { PATH: root, PATHEXT: ".COM;.EXE;.BAT;.CMD" } as NodeJS.ProcessEnv;

        expect(resolveOnPath("shim", env)).toBe(join(root, "shim.CMD"));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("reports nothing when PATH is unset rather than throwing", () => {
    expect(resolveOnPath("anything", {} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
