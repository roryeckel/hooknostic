import type { CapabilityProfile } from "@hooknostic/core";

/**
 * OpenCode capability data. Validated against opencode 1.18.18 and the
 * `@opencode-ai/plugin@1.18.19` published Hooks type definitions
 * (dist/index.d.ts, inspected 2026-08-20); vendor docs
 * (https://opencode.ai/docs/plugins, fetched 2026-08-20) as secondary source.
 *
 * OpenCode plugins are persistent in-process modules, not subprocesses; the
 * generated shim never exposes module lifetime as portable state (ADR-0002).
 */
export const opencodeCapabilityProfiles: CapabilityProfile[] = [
  {
    range: ">=1.10 <2",
    source: {
      date: "2026-08-29",
      references: [
        "@opencode-ai/plugin@1.18.19 dist/index.d.ts",
        "https://opencode.ai/docs/plugins",
        "fixtures/opencode/1.18",
        "opencode-ai 1.18.25 live plugin-client probe (.capture/opencode-client)",
      ],
    },
    matrix: {
      "session.start.observe": {
        level: "emulated",
        rationale:
          "observed via plugin initialization and session.created on the server event bus; there is no per-session subprocess start.",
      },
      // No context channel at session start → session.start.context.add unsupported.

      "session.end.observe": {
        level: "approximate",
        rationale:
          "closest signals are session.deleted/session.idle on the event bus; OpenCode sessions persist and may resume, so \"end\" is not a native concept.",
      },

      "prompt.before.observe": {
        level: "emulated",
        rationale:
          "observed via the chat.message callback when a user message is received; the callback cannot veto the prompt.",
      },
      // prompt.before.block / context.add unsupported.

      "tool.before.observe": { level: "exact" },
      "tool.before.block": {
        level: "exact",
        rationale: "throwing inside tool.execute.before aborts the tool call.",
      },
      // No ask-from-hook mechanism → requestApproval unsupported.
      "tool.before.input.replace": {
        level: "exact",
        rationale: "mutating output.args in tool.execute.before rewrites the tool input.",
      },
      // No model-visible context channel on tool events → context.add unsupported.

      "tool.after.observe": { level: "exact" },
      "tool.after.output.replace": {
        level: "approximate",
        rationale:
          "mutating output.output replaces string results exactly, but non-string replacements are JSON-serialized and therefore change type and semantics.",
      },
      // No block-continuation channel → unsupported.

      // No tool-failure callback → tool.error unsupported.

      "permission.request.observe": { level: "exact" },
      "permission.request.block": {
        level: "exact",
        rationale: "permission.ask exposes a mutable status output; \"deny\" blocks.",
      },

      "context.compact.before.observe": {
        level: "exact",
        rationale: "via experimental.session.compacting (experimental-prefixed upstream API).",
      },
      "context.compact.before.context.add": {
        level: "exact",
        rationale:
          "output.context strings are appended to the compaction prompt (experimental-prefixed upstream API).",
      },
      // Compaction cannot be blocked → context.compact.before.block unsupported.

      "context.compact.after.observe": {
        level: "emulated",
        rationale: "observed via session.compacted on the server event bus.",
      },

      // No subagent lifecycle callbacks → agent.start / agent.stop unsupported.

      "turn.stop.observe": {
        level: "approximate",
        rationale:
          "session.idle on the event bus approximates turn completion: it is one per turn when a turn ends normally, but an aborted turn fires it twice, so one turn ending can dispatch turn.stop more than once.",
      },

      "turn.stop.prevent": {
        level: "emulated",
        rationale:
          "no native stop-prevention channel; the reason is posted back into the session with client.session.promptAsync (no noReply), which makes the agent take another turn. Requires a session that outlives the event: under `opencode run` the process exits at session.idle before the posted turn can start, so prevention is inert there -- it works in an interactive session or against `opencode serve`. Also a silent no-op if the host supplies no client or the post fails. Unlike Claude and Codex there is no stop_hook_active flag and no block cap, so a hook that always prevents will loop -- it must carry its own terminating condition.",
      },

      "turn.stop.notify": {
        level: "approximate",
        rationale:
          "no user-only message channel; the message is posted with client.session.promptAsync noReply:true, which reaches the user without driving a turn but also appends it to the conversation as a user-role message, so the model reads it on the next turn. Best-effort: a silent no-op without a client.",
      },
    },
  },
];
