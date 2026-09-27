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

  model.setMode("subagent");
  const parent = await session();
  await prompt(parent, "Delegate the child task once, then stop.");
  await wait(async () => (await count(parent, "succeeded")) >= 2);
  await settle();
  const created = (await records()).find((row) => row.hook === "event" && row.event.type === "session.created" &&
    row.event.data?.parentID === parent);
  const child = { parentID: parent, parent: await outcome(parent), created: created?.event ?? null,
    ...(created ? { childID: created.event.data.sessionID, child: await outcome(created.event.data.sessionID) } : {}) };

  return { prevent, ...unsuccessful, child };
}
