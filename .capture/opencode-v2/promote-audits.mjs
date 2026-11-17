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
// `promote-audits.mjs subagent-stop <foreground-root> <background-root>`: two
// `subagent` drives, the first on a build that runs the child in the
// foreground (the reference build), the second on one that runs it in the
// background (2.3.0 or later). The foreground child's completion becomes the
// `subagent-stop` decode case, with the shim's enrichment beside it; each
// drive's prompts and session events, in capture order, become a replay
// sequence named for the build.
if (process.argv[2] === "subagent-stop") {
  await mkdir(new URL("subagent-stop/", destination), { recursive: true });
  for (const [root, expected] of [[process.argv[3], "completed"], [process.argv[4], "running"]]) {
    const rows = JSON.parse(redact(JSON.stringify(await events(root))));
    const launch = rows.find(row => row.hook === "execute.after" && row.event.tool === "subagent");
    if (launch?.event.result?.output?.status !== expected) throw new Error(`${root}: subagent launch is not ${expected}`);
    const created = rows.find(row => row.hook === "event" && row.event.type === "session.created" && row.event.data?.parentID);
    const child = created?.event.data.sessionID;
    if (child !== launch.event.result.output.sessionID) throw new Error(`${root}: no session.created for the child`);
    const sequence = rows.filter(row => row.hook === "prompt" || (row.hook === "event" && String(row.event.type).startsWith("session.")));
    await writeFile(new URL(`subagent-stop/events-${created.event.data.version}.jsonl`, destination), sequence.map(row => JSON.stringify(row)).join("\n") + "\n");
    if (expected !== "completed") continue;
    const input = rows.find(row => row.hook === "event" && row.event.type === "session.execution.succeeded" && row.event.data?.sessionID === child);
    const text = rows.filter(row => row.hook === "event" && row.event.type === "session.text.ended" && row.event.data?.sessionID === child)
      .map(row => ({ assistantMessageID: row.event.data.assistantMessageID, ordinal: row.event.data.ordinal, text: row.event.data.text }));
    // What the shim hands the decoder: the child's parent and agent from its
    // session.created, and its buffered text.
    const enrichment = { child: { parentID: created.event.data.parentID, agent: created.event.data.agent }, execution: { text } };
    const { raw, ...canonical } = decodeOpenCodeV2(input, { targetId: "opencode", harnessVersion: opencodeV2Harness.referenceVersion }, enrichment);
    if (canonical.event !== "agent.stop") throw new Error(`${root}: the child's completion did not decode as agent.stop`);
    await write("subagent-stop.input.json", input);
    await write("subagent-stop.enrichment.json", enrichment);
    await write("subagent-stop.canonical.json", canonical);
    // From the same drive (#232): the child's session.created as agent.start,
    // and the same completion as the child's own turn.stop with its agent ids.
    // The enrichment is what the shim hands the decoder for each.
    const start = { child: enrichment.child };
    const started = decodeOpenCodeV2(created, { targetId: "opencode", harnessVersion: opencodeV2Harness.referenceVersion }, start);
    if (started.event !== "agent.start") throw new Error(`${root}: the child's session.created did not decode as agent.start`);
    await write("subagent-start.input.json", created);
    await write("subagent-start.enrichment.json", start);
    await write("subagent-start.canonical.json", (({ raw, ...rest }) => rest)(started));
    const own = { subagent: enrichment.child, execution: enrichment.execution };
    const stopped = decodeOpenCodeV2(input, { targetId: "opencode", harnessVersion: opencodeV2Harness.referenceVersion }, own);
    if (stopped.event !== "turn.stop" || stopped.correlation.agentId !== child) throw new Error(`${root}: the child's turn.stop carries no agent id`);
    await write("turn-stop-subagent.input.json", input);
    await write("turn-stop-subagent.enrichment.json", own);
    await write("turn-stop-subagent.canonical.json", (({ raw, ...rest }) => rest)(stopped));
  }
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
