import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function auditOAuth({ api, wait, records, model, remote, project, root }) {
  const listed = () => remote.requests.some(row => row.body.method === "tools/list" && row.headers.authorization === "Bearer hooknostic-refreshed-access");
  const server = await wait(async () => (await api("/mcp")).data.find(server => server.name === "http" && server.status.status === "needs_auth"));
  const integration = (await api(`/integration/${encodeURIComponent(server.integrationID)}`)).data;
  const method = integration.methods.find(method => method.type === "oauth");
  const prefix = `/integration/${encodeURIComponent(integration.id)}/connect/oauth`;
  const attempt = (await api(prefix, { methodID: method.id })).data;
  // Drive our own issuer, with no browser/account/network outside loopback.
  const authorize = new URL(attempt.url);
  if (authorize.hostname !== "127.0.0.1") throw new Error("Non-loopback authorization URL");
  const response = await fetch(authorize, { redirect: "manual" });
  const callback = new URL(response.headers.get("location"));
  if (!["127.0.0.1", "localhost"].includes(callback.hostname)) throw new Error("Non-loopback callback");
  const completed = await fetch(callback, { redirect: "manual" });
  if (!completed.ok) throw new Error(`Callback failed: ${completed.status}`);
  const status = await wait(async () => {
    const status = (await api(`${prefix}/${attempt.attemptID}`)).data;
    if (status.status === "failed") throw new Error(JSON.stringify(status));
    return status.status === "complete" && status;
  });
  await wait(async () => (await api("/mcp")).data.some(server => server.name === "http" && server.status.status === "connected"));
  // Force expiry, then reconnect through the real auth cache/refresh path.
  await new Promise(resolve => setTimeout(resolve, 1200));
  await api("/experimental/mcp/http/disconnect", {});
  await api("/experimental/mcp/http/connect", {});
  await wait(async () => (await api("/mcp")).data.some(server => server.name === "http" && server.status.status === "connected"));
  // `connected` can precede tool registration; prompt only once the refreshed connection has listed its tools.
  await wait(async () => listed());
  const { data: { id } } = await api("/session", { location: { directory: project }, model: { id: "hooknostic-playback", providerID: "playback" }, permissions: [{ action: "*", resource: "*", effect: "allow" }] });
  await api(`/session/${id}/prompt`, { text: "Execute the protected loopback MCP tool." });
  await wait(async () => (await records()).some(row => row.event.type === "session.execution.succeeded" && row.event.data.sessionID === id));
  // A succeeded execution does not prove the tool ran: the model may have called an unregistered tool.
  const called = await wait(async () => remote.requests.some(row => row.body.method === "tools/call")).catch(() => false);
  if (!called) {
    const last = model.requests.at(-1)?.messages?.slice(-2);
    throw new Error("MCP tools/call never reached the protected server\n" + JSON.stringify({ last, records: (await records()).map(row => row.event?.type ?? row.hook) }));
  }
  await writeFile(join(root, "oauth.json"), JSON.stringify({ server, integration, attempt, status, requests: model.requests, errors: model.errors }, null, 2));
}
