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
// - subagent-reload-restart and -restart-stop (#236): as subagent-reload and
//   -stop, but the server is restarted with the same state instead of the
//   location reloaded, so no plugin instance can hand the child over.
// - subagent-reload-running and -running-stop (#236): below.
export const REASON = "stop prevented once by harness playback";
export const NOTICE = "hooknostic-notify-marker";

export async function auditReload({ api, wait, records, model, project, restart, mode }) {
  // Distinct event ids: on 2.0.17 a leaked old capture instance records every
  // event a second time, with the same id (#236).
  const count = async (sessionID, type) =>
    new Set((await records()).filter((row) => row.hook === "event" && row.event.type === `session.execution.${type}` &&
      row.event.data?.sessionID === sessionID).map((row) => row.event.id)).size;
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

  if (mode.startsWith("subagent-reload-running")) return auditRunning({ api, wait, records, model, create, prompt, count, outcome, quiet, mode });

  const parent = (await create()).id;
  await prompt(parent, "hooknostic-first-parent: delegate the child task once, then stop.");
  const createdRow = await wait(async () => (await records()).find((row) => row.hook === "event" &&
    row.event.type === "session.created" && row.event.data?.parentID === parent));
  const childID = createdRow.event.data.sessionID;
  await wait(async () => (await count(childID, "succeeded")) >= 1);
  await quiet(parent, childID);
  const before = await outcome(childID);
  if (mode.startsWith("subagent-reload-restart")) {
    // A new server process with the same state: no plugin instance carries
    // anything over, so only the session.get lookup at the child's prompt
    // can recognize it (#236).
    await restart();
  } else {
    // The old instance is disposed when the capture plugin's cleanup is recorded.
    const disposed = await cleanups();
    await api("/location/reload", {});
    await wait(async () => (await cleanups()) > disposed);
  }
  const reloadedAt = (await records()).length;
  await prompt(parent, "hooknostic-follow-up-parent: follow up with the same child, then stop.");
  await wait(async () => (await count(childID, "succeeded")) >= before.succeeded + 1);
  await quiet(parent, childID);
  const audit = { parentID: parent, childID, reloadedAt, childBefore: before, childAfter: await outcome(childID) };
  if (mode === "subagent-reload-stop" || mode === "subagent-reload-restart-stop") {
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

// #236: a reload while a child runs (its first reply 4 s late), so OpenCode
// keeps the old plugin instance until that execution ends (2.2.6, 2.3.0) or
// for good (2.0.17), and both hear every event. While both live, a fresh
// top-level session is prompted; after it, the parent follows up the same
// child, then delegates a new one. With -stop, prevention and notices are on.
async function auditRunning({ api, wait, records, model, create, prompt, count, outcome, quiet, mode }) {
  const rows = async (hook) => (await records()).filter((row) => row.hook === hook).length;
  // A transport timeout before the reload has tested nothing yet: marked, so
  // the playback test may drive once more (opencode-v2-playback.test.ts).
  const beforeReload = async (work) => {
    try {
      return await work();
    } catch (error) {
      if (error?.name === "TimeoutError") throw new Error(`hooknostic-transport-timeout-before-reload: ${error}`);
      throw error;
    }
  };
  const { parent, childID } = await beforeReload(async () => {
    const parent = (await create()).id;
    await prompt(parent, "hooknostic-first-parent: delegate the child task once, then stop.");
    const createdRow = await wait(async () => (await records()).find((row) => row.hook === "event" &&
      row.event.type === "session.created" && row.event.data?.parentID === parent));
    return { parent, childID: createdRow.event.data.sessionID };
  });
  const setups = await rows("setup");
  await api("/location/reload", {});
  // The new instance is set up; the old one still runs the child.
  await wait(async () => (await rows("setup")) > setups);
  const reloadedAt = (await records()).length;
  const freshID = (await create()).id;
  await prompt(freshID, "hooknostic-fresh: answer in text.");
  await wait(async () => (await count(freshID, "succeeded")) >= 1);
  const all = await records();
  const freshDone = all.findIndex((row) => row.hook === "event" && row.event.type === "session.execution.succeeded" &&
    row.event.data?.sessionID === freshID);
  const firstCleanup = all.findIndex((row) => row.hook === "cleanup");
  // Overlap: the old instance was not yet disposed when the fresh session completed.
  const overlap = firstCleanup === -1 || firstCleanup > freshDone;
  await wait(async () => (await count(childID, "succeeded")) >= 1);
  await quiet(parent, childID, freshID);
  await prompt(parent, "hooknostic-follow-up-parent: follow up with the same child, then stop.");
  await wait(async () => (await count(childID, "succeeded")) >= 2);
  await quiet(parent, childID, freshID);
  await prompt(parent, "hooknostic-new-child-parent: delegate a new child, then stop.");
  const secondRow = await wait(async () => (await records()).find((row) => row.hook === "event" &&
    row.event.type === "session.created" && row.event.data?.parentID === parent && row.event.data.sessionID !== childID));
  const secondID = secondRow.event.data.sessionID;
  await wait(async () => (await count(secondID, "succeeded")) >= 1);
  await quiet(parent, childID, freshID, secondID);
  const audit = {
    parentID: parent, childID, freshID, secondID, reloadedAt, overlap,
    cleanups: await rows("cleanup"), setups: await rows("setup"),
    parent: await outcome(parent), child: await outcome(childID), fresh: await outcome(freshID), second: await outcome(secondID),
  };
  if (mode === "subagent-reload-running-stop") {
    const users = (request) => (request.messages ?? []).filter((message) => message.role === "user").map((message) => JSON.stringify(message.content ?? ""));
    const posts = (request) => users(request).filter((text) => text.includes(REASON) || text.includes(NOTICE)).length;
    const fresh = model.requests.filter((request) => users(request).some((text) => text.includes("hooknostic-fresh")));
    const children = model.requests.filter((request) => users(request).some((text) => text.includes("hooknostic-child-task")));
    // The most stop reasons any one fresh request carried: each post is a user message, kept in the history.
    audit.freshReasons = Math.max(0, ...fresh.map((request) => users(request).filter((text) => text.includes(REASON)).length));
    audit.childPosts = children.reduce((sum, request) => sum + posts(request), 0);
  }
  return audit;
}
