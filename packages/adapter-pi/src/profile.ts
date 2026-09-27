import type { CapabilityProfile } from "@hooknostic/core";

/**
 * pi capability data. pi extensions are persistent in-process modules (like
 * OpenCode plugins), so the generated shim never exposes module lifetime as
 * portable state (ADR-0002). Every rated cell below traces to
 * `.capture/pi/README.md` (captured / verified-by-effect on 0.84.4) or to the
 * installed package's published type definitions (schema-derived); absent
 * cells are unsupported, by omission.
 *
 * pi has no permission-ask mechanism and no native MCP channel in 0.84.x --
 * those capabilities are deliberately unrated rather than approximated.
 */
export const piCapabilityProfiles: CapabilityProfile[] = [
  {
    range: ">=0.84 <1",
    source: {
      date: "2026-09-27",
      validatedOn: [
        // scheduled-playback:begin
        // scheduled-playback:end
        {
          version: "0.84.4",
          date: "2026-09-27",
          method: "captured",
          artifact: "fixtures/pi/0.84",
          what: "before-agent-start-isolated: before_agent_start captured in a fresh project and agent home against the loopback model: no user skills, context files, or third-party tool snippets; retained alongside the original populated fixture",
        },
        {
          version: "0.84.4",
          date: "2026-09-27",
          method: "captured",
          artifact: "fixtures/pi/0.84",
          what: "live extension event payloads incl. in-place tool_call input mutation and tool_result replacement",
        },
        {
          version: "0.84.4",
          date: "2026-09-27",
          method: "live-probe",
          artifact: ".capture/pi/README.md",
          what: 'verified by effect: tool_call block, input rewrite, tool_result replace, system-prompt injection, session_before_compact {cancel:true}, turn injection via sendMessage({triggerTurn:true}), context {messages} replacement; input {action:"handled"} proven NOT a reliable prompt block (mid-stream only, first-token suppression hangs print mode)',
        },
        {
          version: "0.84.4",
          date: "2026-09-27",
          method: "schema-derived",
          artifact: ".capture/pi/README.md",
          what: "installed @earendil-works/pi-coding-agent 0.84.4 type definitions and loader/compaction source: event surface, tool input shapes, extension discovery rules",
        },
        {
          version: "0.84.4",
          date: "2026-09-27",
          method: "live-probe",
          artifact: ".capture/pi/README.md",
          what: "Halogen Qwen 3.8 Flash Next drove a real bash exchange in an isolated Pi session; both streaming requests succeeded, the command marker was observed in tool_result, and captured lifecycle/tool shapes matched the committed fixtures. This direct provider probe does not validate the scheduled llm transport or unexercised effects.",
        },
      ],
      notes: [
        "https://pi.dev/ (fetched 2026-09-27); installed package dist type definitions are the schema-derived source",
      ],
    },
    matrix: {
      "session.start.observe": {
        level: "exact",
      },
      "prompt.before.observe": {
        level: "exact",
      },
      "prompt.before.context.add": {
        level: "exact",
        rationale:
          "before_agent_start result {message} injects a custom message that rides along into the turn (verified by effect on 0.84.4)",
      },
      "model.request.before.observe": {
        level: "exact",
        rationale:
          "the context event fires before each LLM call with the message array the call will use -- the same per-call semantics as model.request.before (a single user turn produces several)",
      },
      "model.request.before.context.add": {
        level: "exact",
        rationale:
          "context result {messages} replaces the message array (AgentMessage[], which carries no system role): injected context rides as a custom message the model sees verbatim (verified by effect on 0.84.4; a system-role entry would be dropped by pi's message conversion)",
      },
      "tool.before.observe": {
        level: "exact",
      },
      "tool.before.block": {
        level: "exact",
        rationale:
          "tool_call result {block: true, reason} blocks execution and surfaces the reason to the model (verified by effect on 0.84.4)",
      },
      "tool.before.input.replace": {
        level: "exact",
        rationale:
          "tool_call event.input is mutated in place and the harness executes the mutated input without re-validation (verified by effect on 0.84.4)",
      },
      "tool.after.observe": {
        level: "exact",
      },
      "tool.after.output.replace": {
        level: "approximate",
        rationale:
          "tool_result result {content} replaces text output the model sees (verified by effect on 0.84.4); non-string portable outputs are JSON-serialized into one text part, changing their type and semantics",
      },
      "tool.error.observe": {
        level: "emulated",
        rationale:
          "pi has no dedicated tool-error event; a failed tool surfaces through tool_result with isError: true (captured, fixtures/pi/0.84/tool-result-error)",
      },
      "context.compact.before.observe": {
        level: "exact",
      },
      "context.compact.before.block": {
        level: "exact",
        rationale: "session_before_compact result {cancel: true} suppresses compaction (verified by effect on 0.84.4)",
      },
      "context.compact.after.observe": {
        level: "exact",
      },
      "turn.stop.observe": {
        level: "emulated",
        rationale:
          "pi has no idle event; agent_settled fires after an agent run fully settles (no retry, compaction, or queued continuation remains), the closest semantic match to a turn boundary",
      },
      "turn.stop.prevent": {
        level: "emulated",
        rationale:
          "no stop-prevention channel exists; prevent is delivered by sendMessage({triggerTurn: true}) from agent_settled, which starts another agent turn (verified by effect on 0.84.4)",
      },
      "session.end.observe": {
        level: "emulated",
        rationale:
          "session_shutdown fires before the extension runtime is torn down on quit, reload, or session replacement -- the closest pi channel to a session end, and per-reload rather than strictly per-session",
      },
      // agent.start/agent.stop are deliberately unrated: pi's agent_start/
      // agent_end are per-prompt loop events, not subagent lifecycles, and the
      // portable events are subagent-scoped (Claude maps them to
      // SubagentStart/SubagentStop). No pi channel maps to them.
    },
  },
];
