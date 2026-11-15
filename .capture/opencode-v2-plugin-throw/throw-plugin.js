// Minimal OpenCode 2.x plugin: records every callback it receives and, in the
// one callback named by HKN_THROW (`<domain>:<hook>`), throws a plain Error on
// every invocation. Not the hooknostic shim: this measures the host alone.
// Probe entrypoint: @opencode/plugin 2.0.17's Plugin.define is identity.
import { appendFileSync } from "node:fs";

const MESSAGE = "hkn-probe-internal-error";
const target = process.env.HKN_THROW ?? "none";
const note = (row) => appendFileSync(process.env.HKN_THROW_TRACE, JSON.stringify({ at: Date.now(), ...row }) + "\n");
const pick = (event) => {
  const out = {};
  for (const key of ["sessionID", "tool", "status", "effect", "action", "message"]) {
    try {
      if (event && typeof event[key] !== "object" && event[key] !== undefined) out[key] = event[key];
    } catch {}
  }
  return out;
};

export default {
  id: "hooknostic.probe.throw",
  async setup(ctx) {
    note({ hook: "setup", target });
    const callback = (key) => async (event) => {
      if (key === target) {
        note({ hook: key, threw: true, ...pick(event) });
        throw new Error(`${MESSAGE} [${key}]`);
      }
      note({ hook: key, ...pick(event) });
    };
    for (const name of ["prompt", "context", "title", "generate", "compaction"])
      await ctx.session.hook(name, callback(`session:${name}`));
    for (const name of ["execute.before", "execute.after"]) await ctx.tool.hook(name, callback(`tool:${name}`));
    await ctx.permission.hook("evaluate", callback("permission:evaluate"));
    const controller = new AbortController();
    // Recorder: never throws, so completion is observable in every mode.
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal }))
          note({ hook: "event", type: event.type, sessionID: event.data?.sessionID });
      } catch (error) {
        if (!controller.signal.aborted) note({ hook: "subscription.error", error: String(error) });
      }
    })();
    // The event domain: a subscriber whose loop body throws, uncaught, as a
    // shim without its own catch would. The rejection is unhandled.
    if (target === "event:loop")
      void (async () => {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "session.execution.started") {
            note({ hook: "event:loop", threw: true, type: event.type });
            throw new Error(`${MESSAGE} [event:loop]`);
          }
        }
      })();
    return () => {
      note({ hook: "cleanup" });
      controller.abort();
    };
  },
};
