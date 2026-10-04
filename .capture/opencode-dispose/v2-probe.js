// Dispose probe for OpenCode 2.x: does `opencode run --standalone` call a
// plugin's cleanup, and does an async task started at the end of an execution
// survive the process exit? The hooknostic v2 shim dispatches turn.stop off
// its event subscription and drains that queue in cleanup, so this is the
// same shape without the dispatch.
//
// Copied into the scratch project's .opencode/plugins by drive-v2.mjs. It uses
// the structural plugin definition (`id`, `setup`), as ../opencode-v2 does.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const CAPTURED = process.env.HKN_CAPTURE_DIR;
const DELAY = Number(process.env.HKN_TASK_DELAY_MS ?? "3000");

function mark(name, extra = {}) {
  mkdirSync(CAPTURED, { recursive: true });
  appendFileSync(join(CAPTURED, "timeline.jsonl"), `${JSON.stringify({ t: Date.now(), mark: name, ...extra })}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default {
  id: "hooknostic.capture.dispose-v2",
  async setup(ctx) {
    mark("setup", { pid: process.pid });
    process.once("exit", (code) => mark("process.exit", { code, pid: process.pid }));
    const tasks = new Set();
    const controller = new AbortController();
    const loop = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event?.type !== "session.execution.succeeded") continue;
          mark("execution.succeeded");
          const task = (async () => {
            await sleep(DELAY);
            mark("task.done");
          })();
          tasks.add(task);
          void task.finally(() => tasks.delete(task));
        }
      } catch (error) {
        if (!controller.signal.aborted) mark("subscription.error", { error: String(error) });
      }
    })();
    return async () => {
      mark("cleanup.called", { inflight: tasks.size });
      controller.abort();
      await loop;
      await Promise.allSettled([...tasks]);
      mark("cleanup.returned");
    };
  },
};
