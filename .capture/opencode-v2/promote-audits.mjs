// Reviewed, explicit promotion. OAuth credentials belong only to the local issuer.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { userInfo } from "node:os";
import { join } from "node:path";
register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url));
const { decodeOpenCodeV2 } = await import("../../packages/adapter-opencode/src/v2/decode.ts");
const { opencodeV2Harness } = await import("../../packages/adapter-opencode/src/v2/harness.ts");
const destination = new URL("../../fixtures/opencode/2.0/", import.meta.url);
const redact = text => text.replaceAll(`Users\\\\${userInfo().username}\\\\`, "Users\\\\user\\\\").replaceAll(`Users/${userInfo().username}/`, "Users/user/");
const read = async (root, name) => JSON.parse(await readFile(join(root, name), "utf8"));
const write = (name, data) => writeFile(new URL(name, destination), redact(JSON.stringify(data, null, 2)) + "\n");
const events = async root => (await readFile(join(root, "captured/events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
// `promote-audits.mjs subagent-background <subagent-root>`: only the 2.3.0
// background launch and the child's inbox item from one `subagent` drive. The
// reference-build audit files above are left as they are.
if (process.argv[2] === "subagent-background") {
  const rows = await events(process.argv[3]);
  const input = JSON.parse(redact(JSON.stringify(rows.find(row => row.hook === "execute.after" && row.event.tool === "subagent"))));
  if (input.event.result?.output?.status !== "running") throw new Error("not a background subagent launch");
  const { raw, ...canonical } = decodeOpenCodeV2(input, { targetId: "opencode", harnessVersion: opencodeV2Harness.referenceVersion });
  await write("tool-subagent-background-after.input.json", input);
  await write("tool-subagent-background-after.canonical.json", canonical);
  // An unmapped bus event, so not a *.input.json decode case (as turn-fields/).
  const inbox = rows.find(row => row.hook === "event" && row.event.type === "session.inbox.enqueued" &&
    row.event.data?.item?.payload?.metadata?.source === "subagent");
  if (inbox?.event.data.item.payload.metadata.childID !== input.event.result.output.sessionID) throw new Error("no inbox item for the child");
  await mkdir(new URL("subagent-background/", destination), { recursive: true });
  await write("subagent-background/inbox-subagent-completed.json", inbox);
  process.exit(0);
}
const [anthropic, responses, subagent, projectOAuth, packageOAuth, notifications] = process.argv.slice(2);
await mkdir(new URL("audits/", destination), { recursive: true });
const providers = [];
for (const [name, root] of [["anthropic-messages", anthropic], ["openai-responses-http", responses]]) {
  const capture = await read(root, "lifecycle.json");
  providers.push({ name, version: opencodeV2Harness.referenceVersion, date: "2026-09-26", requestCount: capture.requests.length,
    urls: capture.urls, errors: capture.errors,
    hooks: [...new Set(capture.records.map(row => row.hook))],
    allRequestsHaveContext: capture.requests.every(request => JSON.stringify(request).includes("hooknostic-context [model.request.before]")),
    compactionEvents: capture.records.filter(row => ["session.compaction.ended", "session.compaction.failed"].includes(row.event.type)),
    audits: capture.audits });
}
await write("audits/providers.json", providers);
const rows = (await readFile(join(subagent, "captured/events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
const input = JSON.parse(redact(JSON.stringify(rows.find(row => row.hook === "execute.after" && row.event.tool === "subagent"))));
const { raw, ...canonical } = decodeOpenCodeV2(input, { targetId: "opencode", harnessVersion: opencodeV2Harness.referenceVersion });
await write("tool-subagent-after.input.json", input);
await write("tool-subagent-after.canonical.json", canonical);
for (const [mode, root] of [["project", projectOAuth], ["package", packageOAuth]]) {
  const capture = await read(root, "oauth.json");
  await write(`audits/oauth-${mode}.json`, { version: opencodeV2Harness.referenceVersion, date: "2026-09-26",
    remote: await read(root, "remote.json"), server: capture.server, status: capture.status,
    modelReceivedOutput: JSON.stringify(capture.requests).includes("hooknostic-oauth-output") });
}
await write("audits/notifications.json", (await readFile(join(notifications, "notifications.jsonl"), "utf8")).trim().split("\n").map(JSON.parse));
