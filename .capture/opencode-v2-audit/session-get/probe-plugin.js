// #232 probe plugin: can a v2 server plugin call ctx.session.get, from the
// prompt hook and from the event subscription, how long does it take, and does
// it return the parent of a child this instance never saw created? Records to
// $HKN_CAPTURE_DIR/probe.jsonl; one line per setup, prompt, tool hook, watched
// event and lookup, tagged with the plugin instance.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

let instances = 0;
const WATCH = new Set([
  "session.created",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

export default {
  id: "hooknostic.probe232",
  async setup(ctx) {
    const inst = `${process.pid}#${++instances}@${Date.now() % 100000}`;
    const out = join(process.env.HKN_CAPTURE_DIR, "probe.jsonl");
    const rec = (kind, data) =>
      appendFileSync(out, JSON.stringify({ t: Math.round(performance.now()), inst, kind, ...data }) + "\n");
    rec("setup", {
      dir: ctx.location.directory,
      get: typeof ctx.session?.get,
      sessionKeys: Object.keys(ctx.session ?? {}).sort(),
    });
    const limit = Number(process.env.HKN_GET_TIMEOUT_MS ?? 2000);
    const timed = async (label, sessionID) => {
      const t0 = performance.now();
      let timer;
      try {
        const result = await Promise.race([
          Promise.resolve(ctx.session.get({ sessionID })),
          new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`timeout ${limit}`)), limit))),
        ]);
        // Recorded either way: whether the result is the record itself or wrapped in { data }.
        const info = result && typeof result === "object" && "data" in result ? result.data : result;
        rec("get", {
          label,
          sessionID,
          ms: +(performance.now() - t0).toFixed(1),
          ok: true,
          resultKeys: Object.keys(result ?? {}).sort(),
          parentID: info?.parentID,
          agent: info?.agent,
          loc: info?.location?.directory,
          title: info?.title,
        });
        return info;
      } catch (error) {
        rec("get", {
          label,
          sessionID,
          ms: +(performance.now() - t0).toFixed(1),
          ok: false,
          name: error?.name,
          tag: error?._tag,
          err: String(error?.message ?? error).slice(0, 300),
        });
      } finally {
        clearTimeout(timer);
      }
    };
    await timed("bogus-at-setup", "ses_0000000000000hooknosticBogus");
    const inline = process.env.HKN_GET_INLINE === "1";
    const created = new Set();
    await ctx.session.hook("prompt", async (e) => {
      rec("prompt", { sessionID: e.sessionID });
      // Awaited inside the prompt hook: does a lookup here deadlock or delay admission?
      await timed(`in-prompt${created.has(e.sessionID) ? "" : ":unseen"}`, e.sessionID);
    });
    await ctx.tool.hook("execute.before", async (e) => rec("execute.before", { sessionID: e.sessionID, tool: e.tool }));
    await ctx.tool.hook("execute.after", async (e) =>
      rec("execute.after", { sessionID: e.sessionID, tool: e.tool, status: e.result?.output?.status ?? e.status }),
    );
    const controller = new AbortController();
    let n = 0;
    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
          n++;
          if (!WATCH.has(ev.type)) continue;
          const d = ev.data ?? {};
          const sid = d.sessionID;
          rec("event", {
            n,
            id: ev.id,
            type: ev.type,
            sessionID: sid,
            parentID: d.parentID,
            agent: d.agent,
            loc: (d.location ?? ev.location)?.directory,
          });
          if (typeof sid !== "string") continue;
          // From the event path too, for the latency and to see what it would find.
          let label;
          if (ev.type === "session.created") {
            created.add(sid);
            label = "on-created";
          } else if (!created.has(sid)) label = `unknown:${ev.type}`;
          else continue;
          const work = timed(label, sid);
          if (inline) await work;
        }
      } catch (error) {
        if (!controller.signal.aborted) rec("subscription-error", { err: String(error) });
      }
    })();
    return () => {
      rec("cleanup", {});
      controller.abort();
    };
  },
};
