import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES_ROOT = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../fixtures",
);

export function fixturePath(harness: string, version: string, name: string): string {
  return resolve(FIXTURES_ROOT, harness, version, name);
}

export function loadFixture<T = unknown>(
  harness: string,
  version: string,
  name: string,
): T {
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
