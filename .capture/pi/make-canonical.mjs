// Generate canonical fixtures (decode result minus `raw`) from the input
// fixtures using the adapter's own decoder — the same rule the opencode
// fixtures follow (canonical = decode minus raw). One-off; kept for
// reproducibility. Run from the repo root:
//   node --experimental-strip-types .capture/pi/make-canonical.mjs
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "fixtures", "pi", "0.84");
const { decodePi } = await import(pathToFileURL(join(here, "..", "..", "packages", "adapter-pi", "src", "decode.ts")).href);

const INVOCATION = { targetId: "pi", harnessVersion: "0.84.4" };

for (const file of readdirSync(fixturesDir)) {
  if (!file.endsWith(".input.json")) continue;
  const input = JSON.parse(readFileSync(join(fixturesDir, file), "utf8"));
  const decoded = decodePi(input, INVOCATION);
  const { raw: _raw, ...canonical } = decoded;
  const out = join(fixturesDir, file.replace(".input.json", ".canonical.json"));
  writeFileSync(out, JSON.stringify(canonical, null, 2) + "\n", "utf8");
  console.log(`wrote ${file.replace(".input.json", ".canonical.json")}`);
}