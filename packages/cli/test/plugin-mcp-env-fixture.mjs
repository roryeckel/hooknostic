#!/usr/bin/env node
/** Constructed stdio MCP server used by Claude Agent Plugin projection playback. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

const capture = process.env.CAPTURE_PATH;
if (capture) {
  mkdirSync(dirname(capture), { recursive: true });
  writeFileSync(
    capture,
    JSON.stringify({
      cwd: process.cwd(),
      pluginRoot: process.env.PLUGIN_ROOT,
      pluginData: process.env.PLUGIN_DATA,
      capture,
      argv: process.argv.slice(2),
    }),
  );
}

const respond = (id, result) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    respond(request.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "hooknostic-plugin-env", version: "1.0.0" },
    });
  } else if (request.method === "tools/list") {
    respond(request.id, {
      tools: [
        {
          name: "projection_echo",
          description: "Return the Agent Plugin projection marker.",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
      ],
    });
  } else if (request.method === "tools/call") {
    respond(request.id, { content: [{ type: "text", text: "projection-mcp-marker" }] });
  } else if (request.method === "ping") {
    respond(request.id, {});
  }
});
