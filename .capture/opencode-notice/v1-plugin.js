// OpenCode 1.x session-start notice probe. Every route a server plugin has for
// putting text in front of the user is tried with a route-coded nonce, so a
// match on the screen, in a stream or in a model request names its route:
//
//   IT     client.tui.showToast at init
//   DT     client.tui.showToast three seconds after init
//   CT     client.tui.showToast at session.created
//   CP     client.tui.publish(tui.toast.show) six seconds after session.created
//   CA     client.tui.appendPrompt at session.created   (variant "append")
//   CN     client.session.promptAsync noReply            (variant "noreply")
//
// HKN_NOTICE carries the per-run nonce, HKN_NOTICE_VARIANT the variant and
// HKN_NOTICE_TRACE the JSONL file every call result lands in.
import { appendFileSync } from "node:fs";

const NOTICE = process.env.HKN_NOTICE ?? "HKN-NOTICE-unset";
const VARIANT = process.env.HKN_NOTICE_VARIANT ?? "toast";

function record(value) {
  appendFileSync(process.env.HKN_NOTICE_TRACE, `${JSON.stringify({ at: Date.now(), ...value })}\n`, "utf8");
}

async function attempt(route, call) {
  try {
    const result = await call();
    record({ route, ok: true, result: result?.data ?? result?.error ?? null, status: result?.response?.status });
  } catch (error) {
    record({ route, ok: false, error: String(error) });
  }
}

// The TUI shows one toast at a time and a newer one replaces it, so routes
// that share a moment are spaced out rather than fired together.
const toast = (client, code) =>
  attempt(code, () =>
    client.tui.showToast({ body: { title: "hooknostic", message: `${NOTICE}-${code}`, variant: "info", duration: 15000 } }),
  );
const later = (ms, run) => setTimeout(() => void run(), ms);

export const NoticeProbe = async ({ client }) => {
  record({
    phase: "init",
    variant: VARIANT,
    tui: Object.fromEntries(Object.entries(client?.tui ?? {}).map(([key, value]) => [key, typeof value])),
    tuiMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(client?.tui ?? {})).filter((name) => name !== "constructor"),
  });
  if (VARIANT === "toast") {
    // Not awaited: on 1.18.18 `opencode run`, awaiting this call inside init
    // hung the process with no output (README). HKN_NOTICE_AWAIT_INIT=1
    // restores the await to reproduce that.
    const init = toast(client, "IT");
    if (process.env.HKN_NOTICE_AWAIT_INIT === "1") await init;
    later(3000, () => toast(client, "DT"));
  }
  let fired = false;
  return {
    event: async ({ event }) => {
      if (event?.type !== "session.created" || fired) return;
      fired = true;
      const sessionID = event.properties?.info?.id;
      record({ phase: "session.created", sessionID });
      if (VARIANT === "toast") {
        await toast(client, "CT");
        later(6000, () =>
          attempt("CP", () =>
            client.tui.publish({
              body: { type: "tui.toast.show", properties: { message: `${NOTICE}-CP`, variant: "info", duration: 15000 } },
            }),
          ),
        );
      }
      if (VARIANT === "append") {
        await attempt("CA", () => client.tui.appendPrompt({ body: { text: `${NOTICE}-CA` } }));
      }
      if (VARIANT === "noreply") {
        await attempt("CN", () =>
          client.session.promptAsync({
            path: { id: sessionID },
            body: { noReply: true, parts: [{ type: "text", text: `${NOTICE}-CN` }] },
          }),
        );
      }
    },
  };
};
