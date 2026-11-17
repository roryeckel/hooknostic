import { setTimeout as delay } from "node:timers/promises";

// The playback artifact prevents each session's first stop and notifies on later ones.
const REASON = "stop prevented once by harness playback";
const NOTICE = "hooknostic-notify-marker";

export async function auditStops({ api, wait, records, model, project }) {
  const count = async (sessionID, type) =>
    (await records()).filter((row) => row.hook === "event" && row.event.type === `session.execution.${type}` &&
      row.event.data?.sessionID === sessionID).length;
  const outcome = async (sessionID) => Object.fromEntries(await Promise.all(
    ["started", "succeeded", "failed", "interrupted"].map(async (type) => [type, await count(sessionID, type)])));
  const userRequests = (text) => model.requests.filter((request) =>
    request.messages?.some((message) => message.role === "user" && JSON.stringify(message.content).includes(text)));
  const session = async () => (await api("/session", {
    location: { directory: project }, model: { id: "hooknostic-playback", providerID: "playback" },
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
  })).data.id;
  // A post would start another execution within milliseconds; this is the window it has to show up in.
  const settle = () => delay(3000);
  const prompt = (id, text) => api(`/session/${id}/prompt`, { text });

  model.setMode("tool");
  const top = await session();
  await prompt(top, "Run the shell probe once, then stop.");
  await wait(async () => (await count(top, "succeeded")) >= 2);
  await settle();
  const prevent = { sessionID: top, ...(await outcome(top)), reasonRequests: userRequests(REASON).length,
    noticeRequestsBeforeFollowUp: userRequests(NOTICE).length };
  await prompt(top, "Continue.");
  await wait(async () => (await count(top, "succeeded")) >= 3);
  prevent.noticeRequestsAfterFollowUp = userRequests(NOTICE).length;

  const unsuccessful = {};
  for (const mode of ["interrupt", "fail"]) {
    model.setMode(mode === "interrupt" ? "hang" : "fail");
    const id = await session();
    const before = model.requests.length;
    await prompt(id, "Run the shell probe once, then stop.");
    if (mode === "interrupt") {
      await wait(() => model.requests.slice(before).some((request) => request.tools?.length));
      await api(`/session/${id}/interrupt`, {});
    }
    await wait(async () => (await count(id, mode === "interrupt" ? "interrupted" : "failed")) >= 1);
    await settle();
    unsuccessful[mode] = { sessionID: id, ...(await outcome(id)) };
  }

  // From 2.3.0 every subagent runs in the background: the parent's executions
  // can end before the child does, and the child's result, if the parent is idle
  // by then, starts one more (.capture/opencode-v2-audit). So wait for the child
  // itself and then for an idle parent, rather than for a parent count that holds
  // only when the child finishes first. On earlier builds the child finishes
  // inside the parent's first execution, and both waits are already met.
  model.setMode("subagent");
  const parent = await session();
  const delegate = "Delegate the child task once, then stop.";
  await prompt(parent, delegate);
  await wait(async () => (await count(parent, "succeeded")) >= 2);
  const created = await wait(async () => (await records()).find((row) => row.hook === "event" &&
    row.event.type === "session.created" && row.event.data?.parentID === parent));
  const childID = created.event.data.sessionID;
  await wait(async () => (await count(childID, "succeeded")) >= 1);
  await settle();
  await wait(async () => {
    const { started, succeeded, failed, interrupted } = await outcome(parent);
    return started === succeeded + failed + interrupted;
  });
  // What the parent was told at launch: "running" from 2.3.0, "completed" before.
  const launch = (await records()).find((row) => row.hook === "execute.after" && row.event.tool === "subagent" &&
    row.event.sessionID === parent)?.event.result?.output?.status ?? null;
  // The parent's last request holds its whole history: how many user messages
  // carry the stop reason there. Only the parent's own prevention should; a
  // post under the parent's id from the child's agent.stop would add one, even
  // when it joins a running execution and starts none.
  const lastParentRequest = model.requests.filter((request) => request.messages?.some((message) =>
    message.role === "user" && JSON.stringify(message.content).includes(delegate))).at(-1);
  const reasonMessages = lastParentRequest?.messages.filter((message) => message.role === "user" &&
    JSON.stringify(message.content).includes(REASON)).length ?? 0;
  const child = { parentID: parent, parent: await outcome(parent), created: created.event, childID,
    child: await outcome(childID), launch, reasonMessages,
    subagentMessageRequests: model.requests.filter((request) => request.messages?.some((message) => message.role === "user" &&
      typeof message.content === "string" && message.content.startsWith(`<subagent sessionID="${childID}"`))).length };

  return { prevent, ...unsuccessful, child };
}
