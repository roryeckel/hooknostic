import { readFile, writeFile, mkdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { register } from "node:module";
import { join } from "node:path";
register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url));
const { decodeOpenCodeV2 } = await import("../../packages/adapter-opencode/src/v2/decode.ts");
const { opencodeV2Harness } = await import("../../packages/adapter-opencode/src/v2/harness.ts");
const destination = new URL("../../fixtures/opencode/2.0/", import.meta.url);
const username = userInfo().username;
const redact = text => text.replaceAll(`Users\\\\${username}\\\\`, "Users\\\\user\\\\").replaceAll(`Users/${username}/`, "Users/user/");
const lifecycle = JSON.parse(await readFile(join(process.argv[2], "lifecycle.json"), "utf8"));
const sessions = JSON.parse(await readFile(join(process.argv[3], "sessions.json"), "utf8"));
const selections = [
  ...["generate", "compaction"].map(hook => [hook, lifecycle.records.find(row => row.hook === hook)]),
  ["compaction-ended", lifecycle.records.find(row => row.event.type === "session.compaction.ended")],
  ["permission-ask", sessions.outcomes[1].records.find(row => row.hook === "evaluate")],
  ...["failed", "interrupted"].map(type => [`execution-${type}`, sessions.outcomes.flatMap(row => row.records).find(row => row.event.type === `session.execution.${type}`)]),
];
for (const [name, row] of selections) {
  if (!row) throw new Error(`Missing ${name}`);
  const raw = JSON.parse(redact(JSON.stringify(row)));
  const { raw: ignored, ...canonical } = decodeOpenCodeV2(raw, { targetId: "opencode", harnessVersion: opencodeV2Harness.referenceVersion });
  await writeFile(new URL(`${name}.input.json`, destination), JSON.stringify(raw, null, 2) + "\n");
  await writeFile(new URL(`${name}.canonical.json`, destination), JSON.stringify(canonical, null, 2) + "\n");
}
await mkdir(new URL("session-audit/", destination), { recursive: true });
const observations = sessions.outcomes.map(({ mode, pending, executions, records }) => ({ mode, pending, executions,
  records: records.filter(row => row.hook === "evaluate" || ["permission.asked", "permission.replied"].includes(row.event.type)) }));
await writeFile(new URL("session-audit/permissions.json", destination), redact(JSON.stringify(observations, null, 2)) + "\n");
