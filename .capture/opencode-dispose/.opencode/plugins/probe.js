// Dispose probe for OpenCode 1.x: does `opencode run` call and await a
// plugin's `dispose`, and does an async task started at session.idle survive
// the process exit when dispose awaits it?
//
// Every mark goes to timeline.jsonl with a wall-clock timestamp. At
// session.idle the probe starts a task that reads the session back with
// client.session.messages, waits HKN_TASK_DELAY_MS, and then records
// `task.done`. HKN_DISPOSE_MODE picks what the plugin returns:
//
//   await  dispose awaits every idle task (the shape the shim adopts)
//   none   no dispose at all (the shape the shim had)
//   hang   dispose awaits the tasks and then a further 25 s, to see whether
//          the host bounds a slow dispose
//
// A `.js` extension is required: the 1.x loader scans *.ts / *.js only.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const CAPTURED = process.env.HKN_CAPTURE_DIR;
const MODE = process.env.HKN_DISPOSE_MODE ?? "await";
const DELAY = Number(process.env.HKN_TASK_DELAY_MS ?? "3000");

function mark(name, extra = {}) {
  mkdirSync(CAPTURED, { recursive: true });
  appendFileSync(join(CAPTURED, "timeline.jsonl"), `${JSON.stringify({ t: Date.now(), mark: name, ...extra })}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const DisposeProbe = async (input) => {
  const client = input?.client;
  const tasks = new Set();
  mark("plugin.init", { mode: MODE, delay: DELAY });
  // Synchronous, so it lands even when the host calls process.exit().
  process.once("exit", (code) => mark("process.exit", { code }));
  const hooks = {
    event: async ({ event }) => {
      if (event?.type !== "session.idle") return;
      const sessionID = event?.properties?.sessionID;
      mark("session.idle", { sessionID });
      const task = (async () => {
        try {
          const response = await client.session.messages({ path: { id: sessionID } });
          const data = response?.data;
          mark("task.read", { messages: Array.isArray(data) ? data.length : typeof data });
        } catch (error) {
          mark("task.read.failed", { error: String(error) });
        }
        await sleep(DELAY);
        mark("task.done");
      })();
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    },
  };
  if (MODE === "none") return hooks;
  return {
    ...hooks,
    dispose: async () => {
      mark("dispose.called", { inflight: tasks.size });
      await Promise.allSettled([...tasks]);
      if (MODE === "hang") await sleep(25_000);
      mark("dispose.returned");
    },
  };
};

export default DisposeProbe;
