// scoped-hooks.ts plus the subagent lifecycle, scoped to the probe, for the
// harnesses that dispatch one (Claude Code and Codex).
import { definePlugin, hook } from "@hooknostic/sdk";

import { toolHooks, trace } from "./scoped-hooks.ts";

export default definePlugin({
  name: "hn-scope",
  hooks: [
    ...toolHooks,
    hook("agent.start", { id: "probe-start", agents: { include: ["hn-probe"] }, run: trace }),
    hook("agent.stop", { id: "probe-stop", agents: { include: ["hn-probe"] }, run: trace }),
  ],
});
