import { appendFileSync } from "node:fs";
import { Notifications } from "./rpc.js";
export default { id: "hooknostic.notification-probe", async setup(ctx) {
  const registration = await ctx.rpc.register(Notifications, { send: async () => {
    await registration.events.emit("message", { text: "hooknostic-server-notification" });
    appendFileSync(process.env.HKN_NOTIFICATION_TRACE, JSON.stringify({ phase: "server-emitted" }) + "\n");
    return {};
  } });
  return () => registration.dispose();
} };
