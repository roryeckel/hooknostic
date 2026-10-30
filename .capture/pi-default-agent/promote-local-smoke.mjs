// Keep failed completed attempts as well as successes: no success-only curation.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createRedaction } from "../shell-dialects/redaction.mjs";

const here = fileURLToPath(new URL("./", import.meta.url));
const platform = process.argv[2] ?? process.platform;
assert.ok(["win32", "linux", "darwin"].includes(platform));
const source = join(here, "captured/local-smoke");
const destination = join(here, "evidence");
const destinationPath = join(destination, `local-smoke-${platform}.json`);
// A fresh checkout may not have older ignored raw captures. Preserve its
// already-published attempts rather than replacing history with the new run.
const attempts = existsSync(destinationPath) ? JSON.parse(readFileSync(destinationPath, "utf8")).attempts : [];
for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!entry.isDirectory()) continue;
  const directory = join(source, entry.name);
  const summaryPath = join(directory, "summary.json");
  if (!existsSync(summaryPath)) continue;
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  if (summary.platform !== platform) continue;
  const metadata = JSON.parse(readFileSync(join(directory, "metadata.json"), "utf8"));
  const redaction = createRedaction(metadata.account);
  redaction.recordCapture(metadata);
  const promoted = JSON.parse(redaction.published(JSON.stringify(redaction.redact(summary))));
  if (!attempts.some((attempt) => attempt.date === promoted.date && attempt.roleMarker === promoted.roleMarker))
    attempts.push(promoted);
}
assert.ok(attempts.length > 0, "No completed smoke attempts to promote");
attempts.sort((a, b) => a.date.localeCompare(b.date));
mkdirSync(destination, { recursive: true });
writeFileSync(destinationPath, JSON.stringify({ attempts }, null, 2) + "\n");
console.log(`Promoted all ${attempts.length} completed local Pi smoke attempts for ${platform}.`);
