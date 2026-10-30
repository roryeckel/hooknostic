// OpenCode 2.x session-start notice probe: a server-only plugin (no `./tui`
// entry) tries every route on its live context for putting text in front of
// the user, with a route-coded nonce so a match names its route:
//
//   IU/CU  ctx.ui.toast.show            at setup / at session.created
//   IA/CA  ctx.attention.notify         at setup / at session.created
//   IR/CR  ctx.rpc.register + events.emit (no TUI subscriber exists)
//   CS     ctx.session.synthetic resume:false   (variant "synthetic")
//
// The setup record also lists every ctx path whose name suggests a user
// surface, so a route the typings omit would still show up. Identity export:
// @opencode/plugin's Plugin.define returns its argument.
import { appendFileSync } from "node:fs";

const NOTICE = process.env.HKN_NOTICE ?? "HKN-NOTICE-unset";
const VARIANT = process.env.HKN_NOTICE_VARIANT ?? "toast";
const SURFACE = /toast|notif|attention|ui$|tui|notice|message|alert|dialog|status/i;

function record(value) {
  appendFileSync(process.env.HKN_NOTICE_TRACE, `${JSON.stringify({ at: Date.now(), ...value })}\n`, "utf8");
}

function paths(value, prefix = "ctx", depth = 0, seen = new WeakSet()) {
  if (!value || (typeof value !== "object" && typeof value !== "function") || depth > 3 || seen.has(value)) return [];
  seen.add(value);
  return Object.keys(value).flatMap((key) => {
    const path = `${prefix}.${key}`;
    let member;
    try {
      member = value[key];
    } catch {
      return [`${path}:unreadable`];
    }
    return [`${path}:${typeof member}`, ...paths(member, path, depth + 1, seen)];
  });
}

async function attempt(route, call) {
  if (call === undefined) {
    record({ route, ok: false, absent: true });
    return;
  }
  try {
    record({ route, ok: true, result: (await call()) ?? null });
  } catch (error) {
    record({ route, ok: false, error: String(error?.message ?? error) });
  }
}

const Notices = {
  id: "hooknostic-notice-probe",
  methods: { ping: { input: { type: "object" }, output: { type: "object" } } },
  events: { message: { schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
};

function routes(ctx, registration, prefix) {
  const show = ctx.ui?.toast?.show;
  const notify = ctx.attention?.notify;
  return Promise.all([
    attempt(`${prefix}U`, show && (() => show({ message: `${NOTICE}-${prefix}U`, duration: 15000 }))),
    attempt(
      `${prefix}A`,
      notify &&
        (() =>
          notify({ title: "hooknostic", message: `${NOTICE}-${prefix}A`, notification: { when: "always" } })),
    ),
    attempt(`${prefix}R`, registration && (() => registration.events.emit("message", { text: `${NOTICE}-${prefix}R` }))),
  ]);
}

export default {
  id: "hooknostic.notice-probe",
  async setup(ctx) {
    const all = paths(ctx);
    record({
      phase: "setup",
      variant: VARIANT,
      version: ctx.app?.version,
      keys: Object.keys(ctx),
      surfaces: all.filter((path) => SURFACE.test(path.split(":")[0].split(".").pop())),
      rpc: all.filter((path) => path.startsWith("ctx.rpc.")),
    });
    let registration;
    try {
      registration = await ctx.rpc.register(Notices, { ping: async () => ({}) });
      record({ phase: "rpc.register", ok: true });
    } catch (error) {
      record({ phase: "rpc.register", ok: false, error: String(error?.message ?? error) });
    }
    if (VARIANT === "toast") await routes(ctx, registration, "I");
    const controller = new AbortController();
    let fired = false;
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type !== "session.created" || fired || event.data?.parentID) continue;
          fired = true;
          const sessionID = event.data?.sessionID;
          record({ phase: "session.created", sessionID });
          if (VARIANT === "toast") await routes(ctx, registration, "C");
          if (VARIANT === "synthetic") {
            await attempt("CS", () => ctx.session.synthetic({ sessionID, text: `${NOTICE}-CS`, resume: false }));
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) record({ phase: "subscribe", ok: false, error: String(error) });
      }
    })();
    return () => {
      controller.abort();
      registration?.dispose();
      record({ phase: "cleanup" });
    };
  },
};
