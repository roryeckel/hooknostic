import type { AgentPluginOmissionDeclaration } from "@hooknostic/agent-plugin";

/** Existing native-MCP limitation, declared separately for each transport. */
export const piMcpOmissions = {
  stdio: {
    id: "mcp-stdio-omitted",
    summary: "Stdio MCP servers are omitted because Pi has no native MCP channel.",
    evidence: ".capture/pi/README.md",
  },
  "streamable-http": {
    id: "mcp-streamable-http-omitted",
    summary: "Streamable HTTP MCP servers are omitted because Pi has no native MCP channel.",
    evidence: ".capture/pi/README.md",
  },
  sse: {
    id: "mcp-sse-omitted",
    summary: "SSE MCP servers are omitted because Pi has no native MCP channel.",
    evidence: ".capture/pi/README.md",
  },
} satisfies Record<string, AgentPluginOmissionDeclaration>;
