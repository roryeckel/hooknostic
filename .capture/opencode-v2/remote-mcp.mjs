// Minimal constructed MCP peers, solely on loopback. No OAuth or external service.
import { createServer } from "node:http";

export async function startRemoteMcp() {
  const requests = [];
  let stream;
  const result = body => {
    if (body.method === "initialize") return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "hooknostic-remote", version: "1.0.0" } };
    if (body.method === "tools/list") return { tools: [{ name: "hooknostic_echo", description: "Echo the remote fixture sentinel", inputSchema: { type: "object", properties: {}, required: [] } }] };
    if (body.method === "tools/call") return { content: [{ type: "text", text: "hooknostic-remote-output" }] };
    return {};
  };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    requests.push({ method: req.method, path: req.url, headers: req.headers, body });
    if (path === "/sse" && req.method === "GET") {
      stream = res;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write("event: endpoint\ndata: /messages\n\n");
      return;
    }
    if (path === "/sse") { res.writeHead(405); res.end(); return; }
    if (path === "/http" && req.method !== "POST") { res.writeHead(405); res.end(); return; }
    if (body.id === undefined) { res.writeHead(202); res.end(); return; }
    const message = { jsonrpc: "2.0", id: body.id, result: result(body) };
    if (path === "/messages") {
      stream.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
      res.writeHead(202); res.end();
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(message));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
