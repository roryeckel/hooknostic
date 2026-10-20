// Generate canonical fixtures (decode result minus `raw`) from the input
// fixtures using the adapter's own decoder — the same rule the opencode
// fixtures follow (canonical = decode minus raw). One-off; kept for
// reproducibility. Run from the repo root:
//   node --experimental-strip-types .capture/pi/make-canonical.mjs
// Only inputs listed in the fixture directory's declined.json may fail to
// decode; any other decode error stops generation.
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url));
const packageSource = (pkg, file) => pathToFileURL(join(here, "..", "..", "packages", pkg, "src", file)).href;
const { decodePi, PiDecodeError } = await import(packageSource("adapter-pi", "decode.ts"));
const { piHarness } = await import(packageSource("adapter-pi", "harness.ts"));
const { applyCanonicalFixturePlan, planCanonicalFixtures } = await import(packageSource("testkit", "fixtures.ts"));
const fixturesDir = join(here, "..", "..", "fixtures", "pi", piHarness.fixtureDir);

const INVOCATION = { targetId: "pi", harnessVersion: piHarness.referenceVersion };

const plan = planCanonicalFixtures({
  fixturesDir,
  decode: (input, enrichment) => decodePi(input, INVOCATION, enrichment),
  isDecline: (error) => error instanceof PiDecodeError,
});
applyCanonicalFixturePlan(fixturesDir, plan);
for (const name of plan.writes.keys()) console.log(`wrote ${name}`);
for (const name of plan.stale) console.log(`removed ${name} (declined input)`);
