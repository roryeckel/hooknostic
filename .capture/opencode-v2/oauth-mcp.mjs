// Constructed OAuth issuer + protected MCP resource. Every endpoint is loopback.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

export async function startOAuthMcp() {
  const requests = [], errors = [];
  let url, authorization, expires = 0, refreshed = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    const address = new URL(req.url, url);
    const body = text ? req.headers["content-type"]?.includes("application/x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(text)) : JSON.parse(text) : {};
    requests.push({ method: req.method, path: req.url, headers: req.headers, body });
    const json = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (address.pathname === "/.well-known/oauth-protected-resource") return json(200, { resource: url + "/http", authorization_servers: [url], scopes_supported: ["mcp:tools"] });
    if (address.pathname === "/.well-known/oauth-authorization-server") return json(200, {
      issuer: url, authorization_endpoint: url + "/authorize", token_endpoint: url + "/token", registration_endpoint: url + "/register",
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"], scopes_supported: ["mcp:tools"],
    });
    if (address.pathname === "/register") return json(201, { ...body, client_id: "hooknostic-local-client", token_endpoint_auth_method: "none" });
    if (address.pathname === "/authorize") {
      authorization = Object.fromEntries(address.searchParams);
      const target = new URL(authorization.redirect_uri);
      if (!["127.0.0.1", "localhost"].includes(target.hostname) || authorization.code_challenge_method !== "S256" || !authorization.state) return json(400, { error: "invalid_request" });
      target.searchParams.set("code", "hooknostic-local-code"); target.searchParams.set("state", authorization.state);
      res.writeHead(302, { location: target.href }); res.end(); return;
    }
    if (address.pathname === "/token") {
      if (body.grant_type === "authorization_code") {
        if (body.code !== "hooknostic-local-code" || createHash("sha256").update(body.code_verifier ?? "").digest("base64url") !== authorization?.code_challenge) {
          errors.push("PKCE mismatch"); return json(400, { error: "invalid_grant" });
        }
      } else if (body.grant_type === "refresh_token" && body.refresh_token === "hooknostic-local-refresh") refreshed = true;
      else { errors.push("Unexpected token grant"); return json(400, { error: "invalid_grant" }); }
      expires = Date.now() + 1000;
      return json(200, { access_token: refreshed ? "hooknostic-refreshed-access" : "hooknostic-initial-access", refresh_token: "hooknostic-local-refresh", token_type: "Bearer", expires_in: refreshed ? 3600 : 1, scope: "mcp:tools" });
    }
    if (address.pathname !== "/http") return json(404, {});
    if (!(req.headers.authorization === "Bearer hooknostic-refreshed-access" || (req.headers.authorization === "Bearer hooknostic-initial-access" && Date.now() < expires))) {
      res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${url}/.well-known/oauth-protected-resource"` }); res.end(); return;
    }
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    if (body.id === undefined) { res.writeHead(202); res.end(); return; }
    const result = body.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "hooknostic-oauth", version: "1.0.0" } }
      : body.method === "tools/list" ? { tools: [{ name: "hooknostic_echo", description: "Offline protected echo", inputSchema: { type: "object", properties: {} } }] }
      : body.method === "tools/call" ? { content: [{ type: "text", text: "hooknostic-oauth-output" }] } : {};
    json(200, { jsonrpc: "2.0", id: body.id, result });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  return { url, requests, errors, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
