import process from "node:process";
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === "initialize" ? {
    protocolVersion: request.params.protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: "sample", version: "1.0.0" },
  } : request.method === "tools/list" ? { tools: [{
    name: "sample_message",
    description: "Return a synthetic example message.",
    inputSchema: { type: "object", properties: {} },
  }] } : { content: [{ type: "text", text: "Hello from a repository-local MCP server." }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
