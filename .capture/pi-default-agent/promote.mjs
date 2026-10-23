// Publish bounded native observations, retaining raw requests only in captured/.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createRedaction } from "../shell-dialects/redaction.mjs";

const here = fileURLToPath(new URL("./", import.meta.url));
const platform = process.argv[2] ?? process.platform;
const source = join(here, "captured", platform);
const metadata = JSON.parse(readFileSync(join(source, "metadata.json"), "utf8"));
const summary = JSON.parse(readFileSync(join(source, "summary.json"), "utf8"));
const redaction = createRedaction(metadata.account);
redaction.recordCapture(metadata);
const evidence = join(here, "evidence");
mkdirSync(evidence, { recursive: true });
writeFileSync(
  join(evidence, platform + ".json"),
  redaction.published(JSON.stringify(redaction.redact(summary), null, 2) + "\n"),
);
console.log(`Promoted ${summary.observations.length} native Pi observations for ${platform}.`);
