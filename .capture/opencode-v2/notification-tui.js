import { appendFileSync } from "node:fs";
import { Plugin } from "@opencode/plugin/tui";
import { Notifications } from "./rpc.js";

export default Plugin.define({ id: "hooknostic.notification-probe.tui", setup(ctx) {
  const record = value => appendFileSync(process.env.HKN_NOTIFICATION_TRACE, JSON.stringify(value) + "\n");
  record({ phase: "setup", version: ctx.app.version });
  const rpc = ctx.client.rpc(Notifications);
  const unsubscribe = rpc.events.on("message", event => {
    record({ phase: "client-received", event });
    ctx.ui.toast.show({ message: event.data.text, duration: 3000 });
  });
  const timer = setTimeout(async () => {
    try {
      const result = await ctx.attention.notify({ title: "Hooknostic capture", message: "hooknostic-notification-attention", notification: { when: "always" } });
      record({ phase: "attention", result });
      await rpc.send({});
    } catch (error) { record({ phase: "error", error }); }
  }, 1500);
  return () => { clearTimeout(timer); unsubscribe(); record({ phase: "cleanup" }); };
} });
