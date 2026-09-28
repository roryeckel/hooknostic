// Generate canonical fixtures (decode result minus `raw`) from the input
// fixtures using the adapter's own decoder — the same rule the opencode
// fixtures follow (canonical = decode minus raw). One-off; kept for
// reproducibility. Run from the repo root:
//   node --experimental-strip-types .capture/pi/make-canonical.mjs
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url));
const adapterSource = (file) => pathToFileURL(join(here, "..", "..", "packages", "adapter-pi", "src", file)).href;
const { decodePi } = await import(adapterSource("decode.ts"));
const { piHarness } = await import(adapterSource("harness.ts"));
const fixturesDir = join(here, "..", "..", "fixtures", "pi", piHarness.fixtureDir);

const INVOCATION = { targetId: "pi", harnessVersion: piHarness.referenceVersion };

for (const file of readdirSync(fixturesDir)) {
  if (!file.endsWith(".input.json")) continue;
  const input = JSON.parse(readFileSync(join(fixturesDir, file), "utf8"));
  const decoded = decodePi(input, INVOCATION);
  const { raw: _raw, ...canonical } = decoded;
  const out = join(fixturesDir, file.replace(".input.json", ".canonical.json"));
  writeFileSync(out, JSON.stringify(canonical, null, 2) + "\n", "utf8");
  console.log(`wrote ${file.replace(".input.json", ".canonical.json")}`);
}
