import { describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@hooknostic/core";
import { makeFakeAdapter } from "@hooknostic/testkit";
import { runDoctor } from "./doctor.js";

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
});
