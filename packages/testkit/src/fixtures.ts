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
