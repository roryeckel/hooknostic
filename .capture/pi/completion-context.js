// Record each settled RPC run beside its native session branch.
import { appendFileSync } from "node:fs";

export default function (pi) {
  let prompt;
  pi.on("before_agent_start", (event) => {
    prompt = event.prompt;
  });
  pi.on("agent_settled", (event, ctx) => {
    appendFileSync(
      process.env.HKN_PI_COMPLETION_CAPTURE,
      JSON.stringify({
        prompt,
        native: { event, ctx: { cwd: ctx.cwd, mode: ctx.mode } },
        branch: ctx.sessionManager.getBranch(),
      }) + "\n",
    );
  });
}
