import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { planCanonicalFixtures } from "./fixtures.js";

class Decline extends Error {}

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function fixtures(files: Record<string, unknown>): string {
  dir = mkdtempSync(join(tmpdir(), "hkn-canonical-"));
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(value));
  return dir;
}

// Declines whatever input says so, with its message, and decodes the rest.
const decode = (input: unknown): { raw?: unknown } => {
  const value = input as { decline?: string; event: string };
  if (value.decline !== undefined) throw new Decline(value.decline);
  return { event: value.event, raw: input } as { raw?: unknown };
};
const isDecline = (error: unknown): boolean => error instanceof Decline;
const DECLINED = { reason: "the adapter declines it", error: "on purpose" };

describe("planCanonicalFixtures", () => {
  it("writes decode minus raw for every undeclined input", () => {
    const fixturesDir = fixtures({ "a.input.json": { event: "x" }, "b.input.json": { event: "y" } });
    const plan = planCanonicalFixtures({ fixturesDir, decode, isDecline });
    expect([...plan.writes]).toEqual([
      ["a.canonical.json", { event: "x" }],
      ["b.canonical.json", { event: "y" }],
    ]);
    expect(plan.stale).toEqual([]);
  });

  it("fails when an undeclined input stops decoding, whatever the error", () => {
    // A decoder regression or a changed capture must not pass as a decline
    // and leave the old canonical in place.
    const fixturesDir = fixtures({
      "a.input.json": { event: "x", decline: "declined on purpose" },
      "a.canonical.json": { event: "x" },
    });
    expect(() => planCanonicalFixtures({ fixturesDir, decode, isDecline })).toThrow(Decline);
  });

  it("marks a canonical beside a declined input stale", () => {
    const fixturesDir = fixtures({
      "declined.json": { a: DECLINED },
      "a.input.json": { event: "x", decline: "declined on purpose" },
      "a.canonical.json": { event: "x" },
      "b.input.json": { event: "y" },
    });
    const plan = planCanonicalFixtures({ fixturesDir, decode, isDecline });
    expect([...plan.writes.keys()]).toEqual(["b.canonical.json"]);
    expect(plan.stale).toEqual(["a.canonical.json"]);
  });

  it("marks a canonical with no input stale", () => {
    // An input renamed or removed leaves its canonical behind, which no
    // capture backs.
    const fixturesDir = fixtures({
      "renamed.input.json": { event: "x" },
      "original.canonical.json": { event: "x" },
      "original.enrichment.json": {},
    });
    const plan = planCanonicalFixtures({ fixturesDir, decode, isDecline });
    expect([...plan.writes.keys()]).toEqual(["renamed.canonical.json"]);
    expect(plan.stale).toEqual(["original.canonical.json"]);
  });

  it("propagates a declined input's failure that is not a decline", () => {
    const fixturesDir = fixtures({ "declined.json": { a: DECLINED }, "a.input.json": { event: "x" } });
    const broken = (): never => {
      throw new TypeError("decoder crashed");
    };
    expect(() => planCanonicalFixtures({ fixturesDir, decode: broken, isDecline })).toThrow(TypeError);
  });

  it("fails when a declined input fails with a different decline", () => {
    // The same error class for another reason (a malformed envelope, say) is
    // not the decline the manifest records.
    const fixturesDir = fixtures({
      "declined.json": { a: DECLINED },
      "a.input.json": { event: "x", decline: "native event has no ctx.cwd" },
    });
    expect(() => planCanonicalFixtures({ fixturesDir, decode, isDecline })).toThrow(/no ctx.cwd/);
  });

  it("rejects a declined.json entry without the error it expects", () => {
    const fixturesDir = fixtures({
      "declined.json": { a: { reason: "the adapter declines it" } },
      "a.input.json": { event: "x", decline: "declined on purpose" },
    });
    expect(() => planCanonicalFixtures({ fixturesDir, decode, isDecline })).toThrow(/needs a reason/);
  });

  it("fails when a declined input decodes", () => {
    const fixturesDir = fixtures({ "declined.json": { a: DECLINED }, "a.input.json": { event: "x" } });
    expect(() => planCanonicalFixtures({ fixturesDir, decode, isDecline })).toThrow(
      /listed in declined.json but decodes/,
    );
  });

  it("fails when declined.json names no input", () => {
    const fixturesDir = fixtures({ "declined.json": { gone: DECLINED } });
    expect(() => planCanonicalFixtures({ fixturesDir, decode, isDecline })).toThrow(/names gone/);
  });
});
