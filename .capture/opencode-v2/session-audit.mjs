import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function auditSessions({ api, wait, records, model, project, denied }) {
  const outcomes = [];
  for (const mode of ["allow", "ask-allow", "ask-reject", "deny", "fail", "interrupt"]) {
    model.setMode(mode === "fail" ? "fail" : mode === "interrupt" ? "hang" : "tool");
    const before = (await records()).length;
    const requestCount = model.requests.length;
    const count = async () => (await readFile(join(project, "permission-executed.txt"), "utf8").catch(() => "")).split("\n").filter(Boolean).length;
    const executedBefore = await count();
    const { data: { id } } = await api("/session", {
      location: { directory: project }, model: { id: "hooknostic-playback", providerID: "playback" },
      permissions: [{ action: "*", resource: "*", effect: mode.startsWith("ask") ? "ask" : mode === "deny" ? "deny" : "allow" }],
    });
    await api(`/session/${id}/prompt`, { text: "Run the shell probe once, then stop." });
    let pending;
    if (mode.startsWith("ask") && !denied) {
      pending = await wait(async () => (await api(`/session/${id}/permission`)).data[0]);
      await api(`/session/${id}/permission/${pending.id}/reply`, { decision: mode === "ask-allow" ? "once" : "reject" });
    }
    if (mode === "interrupt") {
      await wait(() => model.requests.slice(requestCount).some(request => request.tools?.length));
      await api(`/session/${id}/interrupt`, {});
    }
    await wait(async () => (await records()).slice(before).some(row => row.hook === "event" &&
      ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(row.event.type) && row.event.data.sessionID === id));
    outcomes.push({ mode, sessionID: id, pending, executions: await count() - executedBefore, records: (await records()).slice(before) });
  }
  return outcomes;
}
