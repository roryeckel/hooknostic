#!/usr/bin/env node
// Constructed stdio MCP server for the pi MCP capture. It records how pi
// started it -- argv, cwd, and the environment names and values the probe
// asks about -- then serves `probe_echo`, plus two failing tools: `probe_fail`
// returns an MCP tool error result (isError) and `probe_throw` answers with a
// JSON-RPC error. The recording is evidence of what pi passed to the child;
// the server itself is test infrastructure.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

const record = process.env.HKN_MCP_RECORD;
if (record) {
  mkdirSync(dirname(record), { recursive: true });
  const watched = (process.env.HKN_MCP_WATCH ?? "").split(",").filter(Boolean);
  appendFileSync(
    record,
    JSON.stringify({
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      env: Object.fromEntries(watched.map((name) => [name, process.env[name] ?? null])),
      hasPath: Object.keys(process.env).some((name) => name.toUpperCase() === "PATH"),
      envCount: Object.keys(process.env).length,
    }) + "\n",
  );
}

const respond = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    respond(request.id, {
      protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "hooknostic-pi-mcp-probe", version: "1.0.0" },
    });
  } else if (request.method === "tools/list") {
    respond(request.id, {
      tools: [
        {
          name: "probe_echo",
          description: "Return the pi MCP probe marker. Takes no arguments.",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
        {
          name: "probe_fail",
          description: "Fail with an MCP tool error result. Takes no arguments.",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
        {
          name: "probe_throw",
          description: "Fail with a JSON-RPC error. Takes no arguments.",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
      ],
    });
  } else if (request.method === "tools/call" && request.params?.name === "probe_fail") {
    respond(request.id, { content: [{ type: "text", text: "pi-mcp-probe-failure" }], isError: true });
  } else if (request.method === "tools/call" && request.params?.name === "probe_throw") {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "pi-mcp-probe-rpc-error" } })}\n`,
    );
  } else if (request.method === "tools/call") {
    respond(request.id, { content: [{ type: "text", text: "pi-mcp-probe-output" }] });
  } else {
    respond(request.id, {});
  }
});
