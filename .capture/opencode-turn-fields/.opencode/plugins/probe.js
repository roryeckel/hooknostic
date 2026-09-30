// Turn-field probe for OpenCode 1.x: what can a plugin learn, at session.idle,
// about the turn that just ended -- the final assistant text and the id of the
// prompt it answered?
//
// It tees chat.message (the prompt's messageID) and every bus event, and at
// session.idle reads the session back with client.session.messages, recording
// the response verbatim. A `.js` extension is required: the 1.x loader scans
// *.ts / *.js only.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const CAPTURED = process.env.HKN_CAPTURE_DIR;

function record(file, value) {
  mkdirSync(CAPTURED, { recursive: true });
  const seen = new WeakSet();
  appendFileSync(
    join(CAPTURED, file),
    `${JSON.stringify(value, (_key, member) => {
      if (typeof member === "bigint") return String(member);
      if (member && typeof member === "object") {
        if (seen.has(member)) return "[circular]";
        seen.add(member);
      }
      return member;
    })}\n`,
    "utf8",
  );
}

export const TurnFieldsProbe = async (input) => {
  const client = input?.client;
  return {
    "chat.message": async (callbackInput, output) => {
      record("chat.message.jsonl", { hook: "chat.message", directory: input.directory, input: callbackInput, output });
    },
    event: async ({ event }) => {
      record("events.jsonl", { type: event?.type, properties: event?.properties });
      if (event?.type !== "session.idle") return;
      const sessionID = event?.properties?.sessionID;
      try {
        const response = await client.session.messages({ path: { id: sessionID } });
        record("messages.jsonl", {
          sessionID,
          responseKeys: response && typeof response === "object" ? Object.keys(response) : typeof response,
          data: response?.data,
          error: response?.error,
        });
      } catch (error) {
        record("messages.jsonl", { sessionID, thrown: String(error) });
      }
    },
  };
};

export default TurnFieldsProbe;
