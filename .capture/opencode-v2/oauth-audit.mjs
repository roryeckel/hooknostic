import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function auditOAuth({ api, wait, records, model, project, root }) {
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
  const { data: { id } } = await api("/session", { location: { directory: project }, model: { id: "hooknostic-playback", providerID: "playback" }, permissions: [{ action: "*", resource: "*", effect: "allow" }] });
  await api(`/session/${id}/prompt`, { text: "Execute the protected loopback MCP tool." });
  await wait(async () => (await records()).some(row => row.event.type === "session.execution.succeeded" && row.event.data.sessionID === id));
  await writeFile(join(root, "oauth.json"), JSON.stringify({ server, integration, attempt, status, requests: model.requests, errors: model.errors }, null, 2));
}
