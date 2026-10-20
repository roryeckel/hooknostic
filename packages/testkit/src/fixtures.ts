import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { HarnessAdapter } from "@hooknostic/core";

const FIXTURES_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../fixtures");

export function fixturePath(harness: string, version: string, name: string): string {
  return resolve(FIXTURES_ROOT, harness, version, name);
}

export function loadFixture<T = unknown>(harness: string, version: string, name: string): T {
  return JSON.parse(readFileSync(fixturePath(harness, version, name), "utf8")) as T;
}

/**
 * Load a fixture by absolute path.
 *
 * `fixturePath`/`loadFixture` resolve against this monorepo's `fixtures/`
 * directory, which an adapter published from elsewhere does not have. The
 * contract suite takes a directory instead so it can run anywhere.
 */
export function loadFixtureFrom<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/**
 * This monorepo's fixture directory for an adapter, derived from its own
 * metadata: `fixtures/<id>/<harness.fixtureDir>`. Repo-local convenience --
 * external adapters pass an explicit `fixturesDir` instead.
 */
export function adapterFixturesDir(adapter: HarnessAdapter): string {
  return resolve(FIXTURES_ROOT, adapter.id, adapter.harness.fixtureDir);
}

/** The canonical files a fixture directory should hold, and the ones it should not. */
export interface CanonicalFixturePlan {
  /** `<stem>.canonical.json` contents, keyed by file name. */
  writes: ReadonlyMap<string, unknown>;
  /** Canonical files beside a declined input, which no event backs. */
  stale: readonly string[];
}

/**
 * Plan the canonical fixtures (decode minus `raw`) for every `*.input.json` in
 * a directory. `declined.json`, when present, maps the stems of captured inputs
 * the adapter declines to `{reason, error}`. Only those may fail to decode, and
 * only with an error `isDecline` accepts whose message contains `error`, so a
 * declined capture that starts failing for another reason is caught. A declined
 * stem that decodes, or names no input, is an error. Any other decode failure
 * propagates, so a regression or a changed capture stops generation instead of
 * leaving an old canonical behind.
 */
export function planCanonicalFixtures(options: {
  fixturesDir: string;
  decode: (input: unknown, enrichment: unknown) => { raw?: unknown };
  isDecline: (error: unknown) => boolean;
}): CanonicalFixturePlan {
  const { fixturesDir } = options;
  const manifest = join(fixturesDir, "declined.json");
  const declined = new Map(
    Object.entries(
      existsSync(manifest) ? loadFixtureFrom<Record<string, { reason: string; error: string }>>(manifest) : {},
    ),
  );
  for (const [stem, entry] of declined) {
    if (typeof entry?.reason !== "string" || typeof entry.error !== "string" || entry.error === "") {
      throw new Error(`declined.json entry ${stem} needs a reason and a non-empty error message`);
    }
  }
  const writes = new Map<string, unknown>();
  const stale: string[] = [];
  const inputs = new Set<string>();
  for (const file of readdirSync(fixturesDir).sort()) {
    if (!file.endsWith(".input.json")) continue;
    const stem = file.slice(0, -".input.json".length);
    inputs.add(stem);
    const input = loadFixtureFrom(join(fixturesDir, file));
    const enrichmentPath = join(fixturesDir, `${stem}.enrichment.json`);
    const enrichment = existsSync(enrichmentPath) ? loadFixtureFrom(enrichmentPath) : {};
    const canonicalName = `${stem}.canonical.json`;
    const entry = declined.get(stem);
    if (entry === undefined) {
      const { raw: _raw, ...canonical } = options.decode(input, enrichment);
      writes.set(canonicalName, canonical);
      continue;
    }
    let decoded = false;
    try {
      options.decode(input, enrichment);
      decoded = true;
    } catch (error) {
      if (!options.isDecline(error) || !(error instanceof Error) || !error.message.includes(entry.error)) throw error;
    }
    if (decoded) throw new Error(`${file} is listed in declined.json but decodes`);
    if (existsSync(join(fixturesDir, canonicalName))) stale.push(canonicalName);
  }
  for (const stem of declined.keys()) {
    if (!inputs.has(stem)) throw new Error(`declined.json names ${stem}, which has no input fixture`);
  }
  return { writes, stale };
}

/** Write a plan's canonical files and remove its stale ones. */
export function applyCanonicalFixturePlan(fixturesDir: string, plan: CanonicalFixturePlan): void {
  for (const [name, canonical] of plan.writes) {
    writeFileSync(join(fixturesDir, name), JSON.stringify(canonical, null, 2) + "\n", "utf8");
  }
  for (const name of plan.stale) rmSync(join(fixturesDir, name));
}
