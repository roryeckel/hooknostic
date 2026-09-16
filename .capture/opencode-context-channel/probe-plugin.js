// Vanilla @opencode-ai/plugin probe. No repo imports.
// Exercises BOTH candidate injection channels with distinct markers so the
// recorded request body says which one actually reaches the model.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const CAP = join(process.env.PROBE_DIR ?? process.cwd(), "captured");
// The tee below swallows errors so a probe can never break a harness callback --
// which means a missing directory would silently record nothing. Create it once.
try {
  mkdirSync(CAP, { recursive: true });
} catch {}
const tee = (hook, payload) => {
  try { appendFileSync(join(CAP, `${hook}.jsonl`), JSON.stringify(payload) + "\n"); } catch {}
};

export const ProbePlugin = async () => {
  let transformCalls = 0;
  let paramsCalls = 0;
  return {
    "experimental.chat.system.transform": async (input, output) => {
      transformCalls += 1;
      const before = Array.isArray(output.system) ? output.system.length : -1;
      // PUSH, never reassign - the harness holds a reference to this array.
      output.system.push(`HOOKNOSTIC_PROBE_SYSTEM_TRANSFORM [${transformCalls}]`);
      tee("system-transform", {
        hook: "experimental.chat.system.transform",
        call: transformCalls,
        sessionID: input?.sessionID ?? null,
        sessionIDPresent: input?.sessionID !== undefined,
        systemLenBefore: before,
        systemLenAfter: output.system.length,
        outputKeys: Object.keys(output),
      });
    },
    "chat.params": async (input, output) => {
      paramsCalls += 1;
      // The NEGATIVE CONTROL: the channel a widely copied plugin approach uses.
      output.options.systemPrompt = "HOOKNOSTIC_PROBE_CHAT_PARAMS";
      tee("chat-params", {
        hook: "chat.params",
        call: paramsCalls,
        agent: input?.agent ?? null,
        outputKeys: Object.keys(output),
        optionsKeys: Object.keys(output.options ?? {}),
      });
    },
    "chat.message": async (input, output) => {
      tee("chat-message", { hook: "chat.message", outputKeys: Object.keys(output ?? {}) });
    },
  };
};
