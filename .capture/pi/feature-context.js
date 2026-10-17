// Record context read APIs at lifecycle boundaries, apart from the native event.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

export default function (pi) {
  for (const name of ["before_agent_start", "agent_settled"]) {
    pi.on(name, (event, ctx) => {
      appendFileSync(
        join(process.env.HKN_CAPTURE_DIR, "session-context.jsonl"),
        JSON.stringify({
          event,
          sessionId: ctx.sessionManager.getSessionId(),
          branch: ctx.sessionManager.getBranch(),
        }) + "\n",
      );
    });
  }
}
