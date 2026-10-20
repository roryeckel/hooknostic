import type { CapabilityProfile } from "@hooknostic/core";

/** The 0.84.4 feature probes; profiles for `>=0.84 <1` cite them. */
export const piLegacyFeatureValidation = {
  version: "0.84.4",
  date: "2026-10-14",
  method: "live-probe" as const,
  artifact: ".capture/pi/FEATURES.md",
  what: "Isolated loopback probes: actual interpreters on Windows and Linux, file-tool hook payloads, project and installed-package skill text and invocation gates, and the settled session branch's final assistant message.",
};

const piLegacyCompletionEdgesValidation = {
  version: piLegacyFeatureValidation.version,
  date: "2026-10-14",
  method: "live-probe" as const,
  artifact: ".capture/pi/FEATURES.md",
  what: "Credential-free RPC probes on Windows reused one session across HTTP errors, in-flight cancellation, a successful retry, retry cancellation and subsequent successful turns, then reopened it from disk. Settled branch tips carried current success ids or unsuccessful messages; generated-extension playback verifies final fields and avoids stale responses.",
};

/** The reference build's feature probes (`.capture/pi/feature-evidence/1.3.0`). */
export const piFeatureValidation = {
  version: "1.3.0",
  date: "2026-10-19",
  method: "live-probe" as const,
  artifact: ".capture/pi/FEATURES.md",
  what: "The isolated loopback feature probes repeated on Windows and Linux: Git Bash or a shellPath-selected PowerShell and Windows PowerShell on Windows; bash, dash, zsh, fish, and tcsh on Linux; read/write/edit/grep/find/ls payloads; project, .agents, ancestor, and package skill gates; and the settled branch's final message all matched 0.84.4, apart from tool_result's added structuredContent.",
};

const piCompletionEdgesValidation = {
  version: piFeatureValidation.version,
  date: "2026-10-19",
  method: "live-probe" as const,
  artifact: ".capture/pi/FEATURES.md",
  what: "The nine-run RPC completion probe repeated on Windows: every branch tip kept its stopReason, the successful retry still settled once, and the reopened session appended its reply. agent_settled now also carries aborted, true only after in-flight cancellation.",
};

// The capability matrix both profiles rate, with rationales citing the build
// and fixture directory each profile's evidence comes from. `overrides`
// replaces a cell whose rationale differs on that line.
function piMatrix(
  version: string,
  fixtureDir: string,
  overrides: CapabilityProfile["matrix"] = {},
): CapabilityProfile["matrix"] {
  return {
    "session.start.observe": {
      level: "exact",
    },
    "prompt.before.observe": {
      level: "exact",
    },
    "prompt.before.context.add": {
      level: "exact",
      rationale: `before_agent_start result {message} injects a custom message that rides along into the turn (verified by effect on ${version})`,
    },
    "model.request.before.observe": {
      level: "exact",
      rationale:
        "the context event fires before each LLM call with the message array the call will use -- the same per-call semantics as model.request.before (a single user turn produces several)",
    },
    "model.request.before.context.add": {
      level: "exact",
      rationale: `context result {messages} replaces the message array (AgentMessage[], which carries no system role): injected context rides as a custom message the model sees verbatim (verified by effect on ${version}; a system-role entry would be dropped by pi's message conversion)`,
    },
    "tool.before.observe": {
      level: "exact",
    },
    "tool.before.block": {
      level: "exact",
      rationale: `tool_call result {block: true, reason} blocks execution and surfaces the reason to the model (verified by effect on ${version})`,
    },
    "tool.before.input.replace": {
      level: "exact",
      rationale: `tool_call event.input is mutated in place and the harness executes the mutated input without re-validation (verified by effect on ${version})`,
    },
    "tool.after.observe": {
      level: "exact",
    },
    "tool.after.output.replace": {
      level: "approximate",
      rationale: `tool_result result {content} replaces text output the model sees (verified by effect on ${version}); non-string portable outputs are JSON-serialized into one text part, changing their type and semantics`,
    },
    "tool.error.observe": {
      level: "emulated",
      rationale: `pi has no dedicated tool-error event; a failed tool surfaces through tool_result with isError: true (captured, fixtures/pi/${fixtureDir}/tool-result-error)`,
    },
    "context.compact.before.observe": {
      level: "exact",
    },
    "context.compact.before.block": {
      level: "exact",
      rationale: `session_before_compact result {cancel: true} suppresses compaction (verified by effect on ${version})`,
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
      rationale: `no stop-prevention channel exists; prevent is delivered by sendMessage({triggerTurn: true}) from agent_settled, which starts another agent turn (verified by effect on ${version})`,
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
    ...overrides,
  };
}

// These fields are already decoded verbatim in the captured session-start,
// session-shutdown, session-before-compact, and tool-* fixtures (ADR-0027).
const piFields: CapabilityProfile["fields"] = {
  "turn.stop.lastMessage": {
    level: "exact",
    rationale:
      "The shim reads the final successful assistant message from the settled context's sessionManager.getBranch(); native event.raw remains unchanged.",
  },
  "turn.stop.correlation.turnId": {
    level: "exact",
    rationale:
      "The native session entry id of the final successful assistant message; no prompt-side id is claimed because that entry does not yet exist before_agent_start.",
  },
  "session.start.how": { level: "exact" },
  "session.end.reason": { level: "exact" },
  "context.compact.before.trigger": { level: "exact" },
  "tool.before.correlation.toolCallId": { level: "exact" },
  "tool.after.correlation.toolCallId": { level: "exact" },
  "tool.error.correlation.toolCallId": { level: "exact" },
};

/**
 * pi capability data. pi extensions are persistent in-process modules (like
 * OpenCode plugins), so the generated shim never exposes module lifetime as
 * portable state (ADR-0002). Every rated cell traces to `.capture/pi/README.md`
 * (captured / verified-by-effect on the profile's builds) or to the installed
 * package's published type definitions (schema-derived); absent cells are
 * unsupported, by omission.
 *
 * pi has no permission-ask mechanism on either line, so that capability is
 * deliberately unrated rather than approximated. MCP servers are a projection
 * component, not a hook capability: 1.x's native MCP client is rated in
 * project.ts and project-agent-plugin.ts (`.capture/pi-mcp`), and its tools
 * classify as `mcp` (toolmap.ts). The scheduled-playback record rolls on the
 * `>=1 <2` profile, which holds the reference build.
 */
export const piCapabilityProfiles: CapabilityProfile[] = [
  {
    range: ">=0.84 <1",
    source: {
      date: "2026-09-27",
      validatedOn: [
        piLegacyFeatureValidation,
        piLegacyCompletionEdgesValidation,
        {
          version: "0.84.4",
          date: "2026-09-27",
          method: "captured",
          artifact: "fixtures/pi/0.84",
          what: "Windows --tools powershell loopback session captured the native {command} tool_call and tool_result payloads; shell normalization now uses that observed key",
        },
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
          what: "original effect probes verified tool_call block, input rewrite, tool_result replace, system-prompt injection, compaction cancel, turn injection, and context replacement; the driver's shell-split prompts invalidate its input-event cadence conclusion",
        },
        {
          version: "0.84.4",
          date: "2026-09-27",
          method: "live-probe",
          artifact: ".capture/pi/README.md",
          what: "isolated single-prompt loopback runs: one full-text input event per print-mode prompt; {action:handled} on that event suppressed before_agent_start, agent_start, and all model requests in both input probes; other modes remain unverified",
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
    fields: piFields,
    matrix: piMatrix("0.84.4", "0.84"),
  },
  {
    range: ">=1 <2",
    source: {
      date: "2026-10-19",
      validatedOn: [
        piFeatureValidation,
        piCompletionEdgesValidation,
        // scheduled-playback:begin
        // scheduled-playback:end
        {
          version: "1.3.0",
          date: "2026-10-19",
          method: "captured",
          artifact: "fixtures/pi/1.3",
          what: "Loopback sessions from .capture/pi/probe-sessions.mjs on Windows captured lifecycle, bash, PowerShell, exit-7 error, isolated and populated before_agent_start, RPC compaction, and cancelled compaction payloads; against 0.84.4 they add messageType, systemPromptOptions sections, structuredContent, and agent_settled.aborted, and remove nothing the adapter decodes",
        },
        {
          version: "1.3.0",
          date: "2026-10-19",
          method: "captured",
          artifact: "fixtures/pi/1.3",
          what: "before-agent-start-custom: a sendMessage({triggerTurn: true}) continuation from agent_settled fires a second before_agent_start with messageType custom, its message, and no prompt (0.84.4 fired none); prompt.before declines that run",
        },
        {
          version: "1.3.0",
          date: "2026-10-19",
          method: "live-probe",
          artifact: ".capture/pi/README.md",
          what: "compact-cancel: {cancel: true} from session_before_compact produced session_compact_failed with aborted: true, no session_compact, and no summarization request",
        },
        {
          version: "1.3.0",
          date: "2026-10-19",
          method: "live-probe",
          artifact: ".capture/harness-playback/",
          what: "HOOKNOSTIC_PLAYBACK=pi on Windows and the scheduled Linux run: tool block, shell rewrite, output replacement, prompt and per-request context, stop prevention, completion fields across errors, cancellation, retry and resume, and project and package skills with their hook all verified by effect",
        },
        {
          version: "1.3.0",
          date: "2026-10-19",
          method: "schema-derived",
          artifact: ".capture/pi/README.md",
          what: "installed @earendil-works/pi-coding-agent 1.3.0 type definitions and CHANGELOG from 0.85.0: no event the adapter maps was renamed or removed, tool input shapes are unchanged, no permission event exists, and native MCP arrived in 0.99.0",
        },
      ],
      notes: [
        "Installed package CHANGELOG.md and dist/core/extensions/types.d.ts (read 2026-10-19) are the schema-derived source; 1.2.0 made before_agent_start a messageType union",
      ],
    },
    fields: piFields,
    matrix: piMatrix("1.3.0", "1.3", {
      "prompt.before.observe": {
        level: "exact",
        rationale:
          "before_agent_start with messageType user carries the submitted prompt; a run started by a custom message has no user prompt and is declined",
      },
      "model.request.before.context.add": {
        level: "exact",
        rationale:
          "context result {messages} replaces the message array, from which pi withholds system messages since 0.87: injected context rides as a custom message the model sees verbatim (verified by effect on 1.3.0)",
      },
      "turn.stop.prevent": {
        level: "emulated",
        rationale:
          "no stop-prevention channel exists; prevent is delivered by sendMessage({triggerTurn: true}) from agent_settled, which starts another agent run (verified by effect on 1.3.0); since 1.2 that run fires a custom-message before_agent_start, which prompt.before declines",
      },
    }),
  },
];
