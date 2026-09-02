import type { CapabilityProfile } from "@hooknostic/core";

/**
 * OpenCode capability data. OpenCode plugins are persistent in-process
 * modules, not subprocesses; the generated shim never exposes module lifetime
 * as portable state (ADR-0002). Version facts live in `source.validatedOn`,
 * not prose.
 */
export const opencodeCapabilityProfiles: CapabilityProfile[] = [
  {
    range: ">=1.10 <2",
    source: {
      date: "2026-08-29",
      validatedOn: [
        {
          version: "1.18.18",
          date: "2026-08-20",
          method: "captured",
          artifact: "fixtures/opencode/1.18",
          what: "live plugin hook payloads incl. in-place args-mutation behaviour",
        },
        {
          version: "1.18.19",
          date: "2026-08-20",
          method: "type-derived",
          artifact: "fixtures/opencode/1.18",
          what: "@opencode-ai/plugin published Hooks type definitions (dist/index.d.ts)",
        },
        {
          version: "1.18.25",
          date: "2026-08-29",
          method: "live-probe",
          artifact: ".capture/opencode-client",
          what: "plugin-client probe: promptAsync notification channel and session.idle timing",
        },
        {
          version: "1.18.25",
          date: "2026-08-30",
          method: "live-probe",
          what:
            "PWD env precedence: opencode trusts an inherited PWD over the process cwd " +
            "and runs the session in PWD's project -- where plugins may not exist. " +
            "Spawners must set PWD to agree with cwd (see the smoke's runCommand).",
        },
        {
          version: "1.18.25",
          date: "2026-09-01",
          method: "captured",
          artifact: ".capture/opencode-permission",
          what:
            "permission.ask plugin hook NEVER fires (upstream anomalyco/opencode #9229): " +
            "observe arrives via the permission.asked bus event on the generic event " +
            "callback, and denial works via client.postSessionIdPermissionsPermissionId " +
            'response "reject" (API true, command not executed, turn halts). The 1.18 ' +
            "permission fixtures' callback-envelope shape is type-derived, not captured.",
        },
      ],
      notes: ["https://opencode.ai/docs/plugins (fetched 2026-08-20)"],
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

      "permission.request.observe": {
        level: "emulated",
        rationale:
          "observed via the permission.asked bus event on the generic event callback -- NOT " +
          "via the documented permission.ask hook, which never fires on 1.18.x (captured live " +
          "on 1.18.25, .capture/opencode-permission; upstream anomalyco/opencode #9229). The " +
          "emulation covers the normalizing view only: a permission.ask registration in a " +
          "user plugin would also never fire.",
      },
      "permission.request.block": {
        level: "approximate",
        rationale:
          "denial posts client.postSessionIdPermissionsPermissionId { response: \"reject\" } " +
          "from the permission.asked bus event (captured live on 1.18.25: API answers true, " +
          "the command does not run, the turn halts). Approximate because it is a round-trip " +
          "through the server API rather than an in-callback mutation, it is a silent no-op " +
          "without a client, and the documented output.status channel is unreachable on " +
          "1.18.x (the permission.ask callback never fires; upstream anomalyco/opencode #9229).",
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
        // approximate, not emulated: the mechanism does not merely differ, its
        // observable behaviour depends on how OpenCode was launched. Note this
        // sits at the same level as turn.stop.notify below, which is deliberate
        // -- notify still lands its message under `opencode run`, so rating
        // prevent higher would invert the two.
        level: "approximate",
        rationale:
          "no native stop-prevention channel; the reason is posted back into the session with client.session.promptAsync (no noReply), which makes the agent take another turn. Requires a session that outlives the event: under `opencode run` the process exits at session.idle before the posted turn can start, so prevention is inert there -- it works in an interactive session or against `opencode serve`. Also a silent no-op if the host supplies no client, if the bus event carries no session id, or if the post fails. Unlike Claude and Codex there is no stop_hook_active flag and no block cap, so a hook that always prevents will loop -- it must carry its own terminating condition.",
      },

      "turn.stop.notify": {
        level: "approximate",
        rationale:
          "no user-only message channel; the message is posted with client.session.promptAsync noReply:true, which reaches the user without driving a turn but also appends it to the conversation as a user-role message, so the model reads it on the next turn. Best-effort: a silent no-op without a client, without a session id on the bus event, or if the post fails.",
      },
    },
  },
];
