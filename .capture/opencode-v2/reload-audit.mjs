import { setTimeout as delay } from "node:timers/promises";

// Children a plugin instance never saw created (#232), over `serve`:
// - subagent-reload: a subagent child finishes, the location reloads (old
//   plugin instance disposed, confirmed by the capture plugin's cleanup
//   record), and the parent then follows up with the same child.
// - subagent-reload-stop: the same, with stop prevention and notices rated,
//   then one more prompt straight to the child, which would carry any post
//   the child had taken.
// - subagent-api-child: a child created through the API with a parentID
//   before any prompt, so before lazy plugin setup, then prompted directly.
export const REASON = "stop prevented once by harness playback";
export const NOTICE = "hooknostic-notify-marker";

export async function auditReload({ api, wait, records, model, project, mode }) {
  const count = async (sessionID, type) =>
    (await records()).filter((row) => row.hook === "event" && row.event.type === `session.execution.${type}` &&
      row.event.data?.sessionID === sessionID).length;
  const outcome = async (sessionID) => Object.fromEntries(await Promise.all(
    ["started", "succeeded", "failed", "interrupted"].map(async (type) => [type, await count(sessionID, type)])));
  // Idle: every execution started has ended, and nothing new for 1.5 s.
  const quiet = async (...sessions) => {
    let last;
    await wait(async () => {
      const outcomes = await Promise.all(sessions.map(outcome));
      const now = JSON.stringify(outcomes);
      const idle = outcomes.every((o) => o.started === o.succeeded + o.failed + o.interrupted);
      const settled = idle && now === last;
      last = now;
      if (!settled) await delay(1400);
      return settled;
    });
  };
  const create = async (extra = {}) => (await api("/session", {
    location: { directory: project }, model: { id: "hooknostic-playback", providerID: "playback" },
    permissions: [{ action: "*", resource: "*", effect: "allow" }], ...extra,
  })).data;
  const prompt = (id, text) => api(`/session/${id}/prompt`, { text });
  const cleanups = async () => (await records()).filter((row) => row.hook === "cleanup").length;

  if (mode === "subagent-api-child") {
    const parent = (await create()).id;
    const created = await create({ parentID: parent, agent: "general", title: "Offline API child" });
    await delay(500);
    await prompt(created.id, "hooknostic-child-task: return the scripted child result.");
    await wait(async () => (await count(created.id, "succeeded")) >= 1);
    await quiet(created.id);
    // 2.0.17 dropped the parentID; branch on what this build kept, not on its version.
    return { parentID: parent, childID: created.id, keptParentID: created.parentID === parent, child: await outcome(created.id) };
  }

  const parent = (await create()).id;
  await prompt(parent, "hooknostic-first-parent: delegate the child task once, then stop.");
  const createdRow = await wait(async () => (await records()).find((row) => row.hook === "event" &&
    row.event.type === "session.created" && row.event.data?.parentID === parent));
  const childID = createdRow.event.data.sessionID;
  await wait(async () => (await count(childID, "succeeded")) >= 1);
  await quiet(parent, childID);
  const before = await outcome(childID);
  // The old instance is disposed when the capture plugin's cleanup is recorded.
  const disposed = await cleanups();
  await api("/location/reload", {});
  await wait(async () => (await cleanups()) > disposed);
  const reloadedAt = (await records()).length;
  await prompt(parent, "hooknostic-follow-up-parent: follow up with the same child, then stop.");
  await wait(async () => (await count(childID, "succeeded")) >= before.succeeded + 1);
  await quiet(parent, childID);
  const audit = { parentID: parent, childID, reloadedAt, childBefore: before, childAfter: await outcome(childID) };
  if (mode === "subagent-reload-stop") {
    // Straight to the child: a notice it had been given would reach its model
    // now, and a prevention would already have started an execution.
    await prompt(childID, "hooknostic-child-task: return the scripted child result once more.");
    await wait(async () => (await count(childID, "succeeded")) >= audit.childAfter.succeeded + 1);
    await delay(3000);
    await quiet(parent, childID);
    audit.childFinal = await outcome(childID);
    const childRequests = model.requests.filter((request) => request.messages?.some((message) =>
      message.role === "user" && JSON.stringify(message.content).includes("hooknostic-child-task")));
    audit.childRequests = childRequests.length;
    audit.childPosts = childRequests.filter((request) => request.messages.some((message) => message.role === "user" &&
      (JSON.stringify(message.content).includes(REASON) || JSON.stringify(message.content).includes(NOTICE)))).length;
  }
  return audit;
}
