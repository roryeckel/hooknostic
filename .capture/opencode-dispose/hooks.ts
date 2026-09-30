// The portable plugin the `shim` modes of drive.mjs compile with the real
// OpenCode 1.x shim: one turn.stop hook that reads the turn's last message,
// waits HKN_TASK_DELAY_MS and records what it saw.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { definePlugin, hook } from "@hooknostic/sdk";

export default definePlugin({
  name: "dispose-capture",
  version: "0.0.0",
  hooks: [
    hook("turn.stop", {
      id: "slow-stop",
      fields: ["lastMessage"],
      timeoutMs: 8_000,
      async run(event) {
        const dir = process.env.HKN_CAPTURE_DIR ?? ".";
        const mark = (name: string, extra: Record<string, unknown> = {}) => {
          mkdirSync(dir, { recursive: true });
          appendFileSync(join(dir, "timeline.jsonl"), `${JSON.stringify({ t: Date.now(), mark: name, ...extra })}\n`);
        };
        mark("hook.start", { lastMessage: event.lastMessage ?? null });
        await new Promise((resolve) => setTimeout(resolve, Number(process.env.HKN_TASK_DELAY_MS ?? "3000")));
        mark("hook.done");
      },
    }),
  ],
});
