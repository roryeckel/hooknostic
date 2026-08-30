// Capture probe: what does OpenCode actually hand a plugin, and does posting
// back into a session work?
//
// Everything in the OpenCode half of the notify/stop-prevention work rests on
// `client.session.promptAsync`, which is not in the vendored
// @opencode-ai/plugin type surface (it types `client` opaquely) and cannot be
// checked offline. Phase 1 answers "does it exist"; phase 2 answers "what does
// calling it do".
//
// A `.js` extension is required: the 1.18 loader scans *.ts / *.js only.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPTURED = join(HERE, "..", "..", "captured");
const VARIANT = process.env.HOOKNOSTIC_PROBE ?? "surface";

// Unique so a transcript grep is unambiguous about which field it came from.
const REPLY_NONCE = "HKN-R-7c4f1";
const NOTIFY_NONCE = "HKN-S-3ba90";

function record(file, value) {
  mkdirSync(CAPTURED, { recursive: true });
  appendFileSync(join(CAPTURED, file), `${JSON.stringify(value)}\n`, "utf8");
}

function describe(value) {
  if (!value || typeof value !== "object") return typeof value;
  return Object.fromEntries(
    Object.entries(value).map(([key, member]) => [key, typeof member]),
  );
}

export const Probe = async (input) => {
  mkdirSync(CAPTURED, { recursive: true });

  const client = input?.client;
  writeFileSync(
    join(CAPTURED, "client-surface.json"),
    `${JSON.stringify(
      {
        variant: VARIANT,
        inputKeys: Object.keys(input ?? {}),
        inputTypes: describe(input),
        clientKeys: Object.keys(client ?? {}),
        namespaces: Object.fromEntries(
          Object.entries(client ?? {})
            .filter(([, member]) => member && typeof member === "object")
            .map(([name, member]) => [name, describe(member)]),
        ),
        sessionPromptAsync: typeof client?.session?.promptAsync,
        sessionPrompt: typeof client?.session?.prompt,
        tuiShowToast: typeof client?.tui?.showToast,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // One shot only. `session.idle` fires again after a reply-driving post, so an
  // ungated probe would loop until the run times out.
  const sentinel = join(CAPTURED, `${VARIANT}.fired`);

  return {
    event: async ({ event }) => {
      record("events.jsonl", { type: event?.type, properties: event?.properties });
      if (event?.type !== "session.idle") return;
      if (VARIANT === "surface") return;

      const sessionID = event?.properties?.sessionID;

      // Second idle: the post already happened, so read the transcript back and
      // record whether an assistant turn actually ran. `opencode run` exits at
      // idle, so the CLI's own stdout cannot answer this.
      if (existsSync(sentinel)) {
        try {
          const messages = await client.session.messages({ path: { id: sessionID } });
          record("transcript.jsonl", {
            phase: "after-post",
            messages: (messages?.data ?? messages ?? []).map((entry) => ({
              role: entry?.info?.role ?? entry?.role,
              text: (entry?.parts ?? [])
                .filter((part) => part?.type === "text")
                .map((part) => part.text)
                .join(" ")
                .slice(0, 200),
            })),
          });
        } catch (error) {
          record("transcript.jsonl", { phase: "after-post", error: String(error) });
        }
        return;
      }
      writeFileSync(sentinel, "", "utf8");
      const attempt = { variant: VARIANT, sessionID };
      try {
        if (VARIANT === "toast") {
          await client.tui.showToast({
            body: { message: NOTIFY_NONCE, variant: "info" },
          });
        } else {
          const reply = VARIANT === "prevent";
          await client.session.promptAsync({
            path: { id: sessionID },
            body: {
              parts: [
                {
                  type: "text",
                  text: reply
                    ? `${REPLY_NONCE} reply with the single word continued`
                    : NOTIFY_NONCE,
                },
              ],
              ...(reply ? {} : { noReply: true }),
            },
          });
        }
        record("posts.jsonl", { ...attempt, ok: true });
        // `opencode run` exits as soon as this handler resolves, which is before
        // a queued turn can start. Holding the handler open is the only way to
        // observe whether the post actually drove one headlessly.
        const holdMs = Number(process.env.HOOKNOSTIC_PROBE_HOLD_MS ?? "0");
        if (holdMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, holdMs));
          try {
            const messages = await client.session.messages({ path: { id: sessionID } });
            record("transcript.jsonl", {
              phase: "after-hold",
              holdMs,
              messages: (messages?.data ?? messages ?? []).map((entry) => ({
                role: entry?.info?.role ?? entry?.role,
                text: (entry?.parts ?? [])
                  .filter((part) => part?.type === "text")
                  .map((part) => part.text)
                  .join(" ")
                  .slice(0, 200),
              })),
            });
          } catch (error) {
            record("transcript.jsonl", { phase: "after-hold", error: String(error) });
          }
        }
      } catch (error) {
        record("posts.jsonl", { ...attempt, ok: false, error: String(error) });
      }
    },
  };
};

export default Probe;
