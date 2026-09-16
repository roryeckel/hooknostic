import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

function createServer() {
  const server = new McpServer({ name: "combined-example-greeter", version: "1.0.0" });

  server.registerTool(
    "greet",
    {
      title: "Greet someone",
      description: "Return a friendly greeting for a person.",
      inputSchema: z.object({
        name: z.string().trim().min(1).default("friend").describe("The person to greet"),
      }),
    },
    async ({ name }) => ({
      content: [{ type: "text", text: `Hello, ${name}!` }],
    }),
  );

  return server;
}

void serveStdio(createServer);
