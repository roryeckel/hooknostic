import { harnessLaneId, harnessLanes } from "./harness-lanes.mjs";
const harnesses = Object.fromEntries(
  Object.entries(harnessLanes).map(([id, lane]) => [
    id,
    {
      module: lane.module.replace("profile.ts", "harness.ts"),
      exportName: lane.harnessExport,
    },
  ]),
);

const id = process.argv[2];
const entry = harnesses[harnessLaneId(id)];
if (entry === undefined) {
  process.stderr.write(
    `usage: node --experimental-strip-types ${process.argv[1]} <${Object.keys(harnesses).join("|")}>\n`,
  );
  process.exit(2);
}

const imported = await import(new URL(entry.module, import.meta.url));
const metadata = imported[entry.exportName];
if (metadata === undefined || typeof metadata.referenceVersion !== "string") {
  throw new Error(`${id}: harness metadata has no referenceVersion`);
}
process.stdout.write(`${metadata.referenceVersion}\n`);
