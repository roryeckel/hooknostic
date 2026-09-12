#!/usr/bin/env node
/**
 * Minimal stdio MCP fixture server for harness playback (ADR-0010).
 *
 * Serves exactly one tool, `hooknostic_echo`, which returns a fixed string
 * containing the sentinel the mcp-stdio scenario asserts on. Speaks the MCP
 * 2024-11-05 JSON-RPC framing (Content-Length headers are intentionally NOT
 * used; MCP stdio is newline-delimited JSON).
 *
 * Constructed test infrastructure, not captured evidence: it exists so a
 * harness's MCP-only channels (Codex `updatedMCPToolOutput`) can be driven
 * by the playback lane without any network or credentials.
 */
import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "hooknostic-mcp-fixture", version: "0.1.0" };

const TOOLS = [
  {
    name: "hooknostic_echo",
    description: "Echo the hooknostic playback sentinel. Takes no arguments.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

const TOOL_RESULT = {
  content: [{ type: "text", text: "hooknostic-mcp-tool-output" }],
};

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

const interface_ = createInterface({ input: process.stdin });
interface_.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (request.id === undefined) return; // notification
  switch (request.method) {
    case "initialize":
      respond(request.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      break;
    case "notifications/initialized":
      break;
    case "tools/list":
      respond(request.id, { tools: TOOLS });
      break;
    case "tools/call":
      respond(request.id, TOOL_RESULT);
      break;
    case "ping":
      respond(request.id, {});
      break;
    default:
      respondError(request.id, -32601, `method not supported: ${String(request.method)}`);
      break;
  }
});
interface_.on("close", () => process.exit(0));
