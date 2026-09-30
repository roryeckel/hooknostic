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
          version: "1.18.31",
          date: "2026-09-29",
          method: "live-probe",
          artifact: ".capture/agents",
          what: "Inside a delegated subagent, tool.execute.before and tool.execute.after carry only tool, sessionID and callID, as the parent's do; the running agent is named only on chat.message. A hook scoped to agents therefore cannot build (the scoped case, packages/cli/test/harness-playback.test.ts, agent-scope). The same held on 1.18.18.",
        },
        {
          version: "1.18.31",
          date: "2026-09-29",
          method: "live-probe",
          artifact: ".capture/agents",
          what: "A session started as a mode: primary agent names it only on chat.message too; its tool events carry no agent, so hooks scoped to it cannot build (the scoped-primary case, packages/cli/test/agent-definition-playback.test.ts). The same held on 1.18.18.",
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
        {
          version: "1.18.30",
          date: "2026-09-15",
          method: "live-probe",
          artifact: ".capture/opencode-context-channel",
          what:
            "experimental.chat.system.transform is a real model-visible channel: a string " +
            'pushed into output.system arrived as its own role:"system" message in the ' +
            "recorded request body. The sibling chat.params channel is NOT one -- " +
            "output.options.systemPrompt landed as a top-level JSON key beside model and " +
            "max_tokens, which no OpenAI-compatible API reads (this retires the widely " +
            "copied plugin approach whose success log is non-evidence). " +
            "Cadence is per model request, not per session: one user turn produced two " +
            "invocations, for the title-generation and build agents. input.sessionID was " +
            "present on both, though the published typings declare it optional, so the " +
            "decoder tolerates its absence. output carries exactly the one key system.",
        },
        {
          version: "1.14.17",
          date: "2026-09-15",
          method: "type-derived",
          artifact: ".capture/opencode-context-channel",
          what:
            "experimental.chat.system.transform is declared with an identical signature " +
            "(input { sessionID?, model }, output { system: string[] }) in the published " +
            "@opencode-ai/plugin typings at 1.14.17, 1.16.0 and 1.18.18. opencode-ai " +
            "publishes no 1.10.x-1.13.x release, so 1.14.17 is this profile range's floor in " +
            "practice and the callback is declared across all of it. Only the 1.18.30 " +
            "delivery behaviour is live-probed; the intervening versions rest on the type " +
            "declaration, which is why observe/context.add cite both records.",
        },
        {
          version: "1.18.30",
          date: "2026-09-15",
          method: "live-probe",
          artifact: ".capture/opencode-context-channel",
          what:
            "OpenAI-OAuth path: the same output.system push reaches the model even though " +
            "prepare() sends no system messages on it, joining the array into the " +
            "provider-options instructions field instead. Captured effect-level rather than " +
            "on the wire, because the OAuth path ignores a baseURL override and reaches " +
            "OpenAI directly: with no plugin the model answered the prompt normally, and " +
            "with an injected directive it returned the directive's token instead. So the " +
            "channel is provider-path independent, but its delivered shape is not.",
        },
        {
          version: "1.18.31",
          date: "2026-09-15",
          method: "live-probe",
          artifact: ".capture/harness-playback",
          what:
            "model.request.before delivery still holds on a build past the one it was " +
            "established on, through the repeatable offline lane rather than a one-off " +
            "probe: driven against a loopback model server, a string pushed into " +
            'output.system arrived as a role:"system" message in EVERY recorded request ' +
            "of the session, which is the per-request cadence cell itself and not merely " +
            "presence somewhere among them. Deliberately SCOPED -- openai-compatible " +
            "provider path, wire-level, one capability family. It re-confirms neither the " +
            "OpenAI-OAuth delivery shape nor the chat.params negative, both of which rest " +
            "on the 1.18.30 records above; and being a scoped record it does not raise the " +
            "scheduled-playback baseline, so harness-watch still owes this build a full " +
            "lane sweep (ADR-0009).",
        },
        {
          version: "1.18.31",
          date: "2026-09-27",
          method: "captured",
          artifact: "fixtures/opencode/1.18",
          what: "read, write, edit and apply_patch tool.execute.before payloads over the loopback model (.capture/file-tools): read/write/edit name the path filePath; a GPT-like model id swaps edit/write for apply_patch, whose patchText carries a Codex-grammar patch",
        },
        {
          version: "1.18.33",
          date: "2026-09-29",
          method: "captured",
          artifact: "fixtures/opencode/1.18",
          what: "chat.message, session.created, session.idle and bash tool.execute.before/after envelopes from a harness-watch drift session over the loopback model (.capture/harness-drift), replacing type-derived shapes: chat.message input carries model instead of agent/messageID, bus events carry event.id, the bash tool offers no description arg, and tool.execute.after metadata carries output/exit/truncated",
        },
        // scheduled-playback: at most one rolling live-probe record, rewritten
        // in place by scripts/record-playback-validation.mjs (harness-watch
        // workflow). Git history is the audit trail; see ADR-0009 and
        // .capture/harness-playback/README.md. Keep field order stable.
        // scheduled-playback:begin
        {
          version: "1.18.33",
          date: "2026-09-28",
          method: "live-probe",
          artifact: ".capture/harness-playback",
          what: "scheduled model-free playback vs a newer build: artifact discovery, rewrite/block markers, and lifecycle events verified",
        },
        // scheduled-playback:end
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
          'closest signals are session.deleted/session.idle on the event bus; OpenCode sessions persist and may resume, so "end" is not a native concept.',
      },

      "prompt.before.observe": {
        level: "emulated",
        rationale:
          "observed via the chat.message callback when a user message is received; the callback cannot veto the prompt.",
      },
      // prompt.before.block / context.add unsupported.

      "model.request.before.observe": {
        level: "exact",
        rationale:
          "via experimental.chat.system.transform (experimental-prefixed upstream API), which " +
          "fires once per model request -- exactly what the portable event names.",
      },
      "model.request.before.context.add": {
        level: "exact",
        rationale:
          "strings pushed into output.system reach the model as its system instructions on " +
          "both provider paths; only the wire SHAPE differs, so a hook must not assume one. " +
          "On an api-key/openai-compatible provider each string becomes its own " +
          'role:"system" message (captured live on 1.18.30, wire-level). On the ' +
          "OpenAI-OAuth path prepare() joins the same array into the provider-options " +
          "`instructions` field and sends NO system messages; that path ignores a baseURL " +
          "override and reaches OpenAI directly, so it was captured effect-level instead -- " +
          "an injected directive changed the model's answer (.capture/opencode-context-channel). " +
          "Push, never reassign: the harness passes the array it builds the request from. " +
          "Delivery is live-probed on 1.18.30 only; the callback and its signature are " +
          "type-derived across the range from 1.14.17, the earliest published release in it. " +
          "NOTE the sibling chat.params channel is NOT this -- its output.options bag is " +
          "spread into the request body as top-level JSON keys, so a systemPrompt written " +
          "there reaches the wire as a field no OpenAI-compatible API reads.",
      },

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
      "tool.before.agent.identity": {
        level: "unsupported",
        rationale:
          "tool.execute.before/after carry only tool, sessionID and callID, in a subagent as elsewhere; the running agent is named only on chat.message (ADR-0028, .capture/agents).",
      },

      "tool.after.observe": { level: "exact" },
      "tool.after.agent.identity": {
        level: "unsupported",
        rationale:
          "tool.execute.before/after carry only tool, sessionID and callID, in a subagent as elsewhere; the running agent is named only on chat.message (ADR-0028, .capture/agents).",
      },
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
          'denial posts client.postSessionIdPermissionsPermissionId { response: "reject" } ' +
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
        rationale: "output.context strings are appended to the compaction prompt (experimental-prefixed upstream API).",
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
