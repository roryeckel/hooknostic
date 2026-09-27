import { mkdir, readFile, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { userInfo } from "node:os";
import { join } from "node:path";
register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url));
const { decodeOpenCodeV2 } = await import("../../packages/adapter-opencode/src/v2/decode.ts");
const { opencodeV2Harness } = await import("../../packages/adapter-opencode/src/v2/harness.ts");
const destination = new URL("../../fixtures/opencode/2.0/", import.meta.url);
const username = userInfo().username;
const redact = text => text.replaceAll(`Users\\\\${username}\\\\`, "Users\\\\user\\\\").replaceAll(`Users/${username}/`, "Users/user/");
const stops = JSON.parse(await readFile(join(process.argv[2], "stops.json"), "utf8"));
const event = (type, sessionID) => stops.records.find(row => row.hook === "event" && row.event.type === type && row.event.data?.sessionID === sessionID);
const selections = [
  ["session-created-child", event("session.created", stops.child.childID)],
  ["execution-interrupted-user", event("session.execution.interrupted", stops.interrupt.sessionID)],
];
for (const [name, row] of selections) {
  if (!row) throw new Error(`Missing ${name}`);
  const raw = JSON.parse(redact(JSON.stringify(row)));
  const { raw: ignored, ...canonical } = decodeOpenCodeV2(raw, { targetId: "opencode", harnessVersion: opencodeV2Harness.referenceVersion });
  await writeFile(new URL(`${name}.input.json`, destination), JSON.stringify(raw, null, 2) + "\n");
  await writeFile(new URL(`${name}.canonical.json`, destination), JSON.stringify(canonical, null, 2) + "\n");
}
await mkdir(new URL("stop-audit/", destination), { recursive: true });
const { prevent, interrupt, fail, child } = stops;
const { created, ...lineage } = child;
await writeFile(new URL("stop-audit/outcomes.json", destination),
  redact(JSON.stringify({ prevent, interrupt, fail, child: lineage }, null, 2)) + "\n");
