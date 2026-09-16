// Capture-only. Proves whether an installed Codex plugin can resolve a
// dependency declared in its own package.json + package-lock.json.
// Writes a marker next to itself rather than logging: stdout belongs to MCP.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let outcome;
try {
  const mod = await import("is-number");
  outcome = `resolved:${String((mod.default ?? mod)(42))}`;
} catch (error) {
  outcome = `failed:${error.code ?? error.constructor.name}`;
}
writeFileSync(join(here, "..", "probe-marker.txt"), outcome + "\n");
