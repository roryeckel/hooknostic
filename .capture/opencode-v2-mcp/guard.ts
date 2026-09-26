import { appendFileSync } from "node:fs";
import { block, definePlugin, hook } from "@hooknostic/sdk";

// Exact name established by this fixture's hook capture. No MCP-kind inference.
export default definePlugin({
  name: "mcp-name-guard",
  hooks: [hook("tool.before", {
    id: "mcp-name-guard",
    match: { nativeName: "hooknostic_hooknostic_echo" },
    capabilities: { "tool.before.block": "required" },
    run(event) {
      appendFileSync(process.env.HKN_MCP_GUARD_TRACE!, JSON.stringify({
        kind: event.tool.kind, name: event.tool.nativeName, input: event.tool.input,
      }) + "\n");
      if (process.env.HKN_MCP_GUARD === "block") return block("hooknostic-mcp-denied");
    },
  })],
});
