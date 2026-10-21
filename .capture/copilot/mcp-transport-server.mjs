// Minimal MCP transports for the GitHub Copilot capture project.
//
// Streamable HTTP and legacy SSE, just enough of the protocol for Copilot's
// client to initialize, list one tool, and call it. Every request's headers are
// recorded so a probe can show whether the harness expanded placeholders in
// them.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const TOOL = {
  name: "probe_echo",
  description: "Echo a message back with the transport and headers it arrived on.",
  inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
};

function reply(request, transport, headers) {
  if (request.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: `probe-${transport}`, version: "1.0.0" },
      },
    };
  }
  if (request.method === "tools/list") {
    return { jsonrpc: "2.0", id: request.id, result: { tools: [TOOL] } };
  }
  if (request.method === "tools/call") {
    const message = request.params?.arguments?.message ?? "(none)";
    const shown = Object.entries(headers)
      .filter(([name]) => name.startsWith("x-probe-"))
      .map(([name, value]) => `${name}=${value}`)
      .join(",");
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{ type: "text", text: `transport=${transport}|message=${message}|headers=${shown}` }],
      },
    };
  }
  // notifications/initialized and anything else the client sends.
  if (request.id === undefined) return undefined;
  return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } };
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}

/**
 * Start both transports on one ephemeral port.
 * Returns { port, close, log }.
 */
export async function startMcpTransports(options = {}) {
  const log = [];
  const record = (entry) => {
    log.push(entry);
    if (options.logPath !== undefined) appendFileSync(options.logPath, `${JSON.stringify(entry)}\n`);
  };
  const streams = new Map();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    record({ method: request.method, path: url.pathname, headers: request.headers, at: Date.now() });

    if (request.method === "GET" && url.pathname === "/sse") {
      const sessionId = randomUUID();
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);
      streams.set(sessionId, response);
      request.on("close", () => streams.delete(sessionId));
      return;
    }

    if (request.method === "GET" && url.pathname === "/mcp") {
      // Streamable HTTP's optional server-initiated stream: keep it open.
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      return;
    }

    const body = await readBody(request);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const requests = Array.isArray(parsed) ? parsed : [parsed];

    if (request.method === "POST" && url.pathname === "/messages") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const stream = streams.get(sessionId);
      for (const item of requests) {
        const answer = reply(item, "sse", request.headers);
        if (answer !== undefined && stream !== undefined) stream.write(`event: message\ndata: ${JSON.stringify(answer)}\n\n`);
      }
      response.writeHead(202).end();
      return;
    }

    if (request.method === "POST" && url.pathname === "/mcp") {
      const answers = requests.map((item) => reply(item, "streamable-http", request.headers)).filter((item) => item !== undefined);
      if (answers.length === 0) {
        response.writeHead(202).end();
        return;
      }
      // The streamable HTTP transport identifies a session through this header
      // on the initialize response; a client that does not receive one may
      // treat the server as failed.
      const initialized = requests.some((item) => item.method === "initialize");
      response.writeHead(200, {
        "content-type": "application/json",
        ...(initialized ? { "mcp-session-id": randomUUID() } : {}),
      });
      response.end(JSON.stringify(answers.length === 1 ? answers[0] : answers));
      return;
    }

    response.writeHead(404).end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    log,
    close: () =>
      new Promise((resolve) => {
        for (const stream of streams.values()) stream.end();
        server.close(() => resolve());
      }),
  };
}

