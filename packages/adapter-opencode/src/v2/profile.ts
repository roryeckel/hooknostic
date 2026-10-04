import type { CapabilityProfile } from "@hooknostic/core";

export const opencodeV2CapabilityProfiles: CapabilityProfile[] = [
  {
    range: ">=2.0.17 <3",
    source: {
      date: "2026-09-26",
      validatedOn: [
        {
          version: "2.0.17",
          date: "2026-09-26",
          method: "captured",
          artifact: "fixtures/opencode/2.0",
          what: "Windows private-server hook captures against a loopback model: session start, prompt, shell before/after, title/context and execution success.",
        },
        {
          version: "2.0.17",
          date: "2026-09-26",
          method: "live-probe",
          artifact: ".capture/opencode-v2",
          what: "Blocking prevents prompt admission and tool execution; command mutation writes the replacement marker; replacement tool content and system text reach recorded model requests. Private-server reload disposes and re-registers hooks; session IDs remain distinct.",
        },
        {
          version: "2.0.17",
          date: "2026-09-26",
          method: "captured",
          artifact: "fixtures/opencode/2.0",
          what: "File read/write/edit/glob/grep and webfetch hook boundaries, shell workdir, skill loading and Code Mode MCP execution. Websearch and subagent names captured before deliberate blocking; no execution claim. Code Mode emits both outer execute and inner MCP tool hooks; MCP identity is not normalized from the ambiguous tool name.",
        },
        {
          version: "2.0.17",
          date: "2026-09-26",
          method: "live-probe",
          artifact: ".capture/opencode-v2-mcp",
          what: "An MCP tool and a custom tool share the same connected-server namespace and registry shape, so namespace/name inference is declined. A generated portable nativeName guard blocks the inner MCP call: allowed control records one server tools/call, denied run records none; the custom tool completes in both runs.",
        },
        {
          version: "2.0.17",
          date: "2026-09-26",
          method: "live-probe",
          artifact: ".capture/opencode-v2-session",
          what: "Separate generation and successful compaction requests receive portable context; compaction before/after are observed. Ask-only permission denial prevents execution with an allow control. HTTP failure and interruption dispatch turn completion; reload preserves separate session context.",
        },
        {
          version: "2.0.17",
          date: "2026-09-26",
          method: "live-probe",
          artifact: ".capture/opencode-v2-audit",
          what: "Typed missing-file failures dispatch tool.error; plain custom exceptions bypass execute.after. Text and serialized object replacements reach the model while raw structured output survives. Anthropic Messages and OpenAI Responses HTTP separately exercise ordinary/title/generation/compaction context. A foreground subagent returns its result to the parent. Native companion TUI RPC renders a toast and disposes on exit; a generated user-only notification remains unsupported.",
        },
        {
          version: "2.0.17",
          date: "2026-09-26",
          method: "live-probe",
          artifact: ".capture/opencode-v2",
          what: "Persistent serve sessions (stop drive; fixtures/opencode/2.0/stop-audit): after a succeeded execution, synthetic with resume starts exactly one more execution whose request carries the stop reason as a user-role message; resume:false starts none, is not rendered by the real TUI meanwhile, and reaches the model with the next user prompt. A user interrupt, a model failure and a subagent child (session.created parentID) post nothing. synthetic does not run the prompt hook.",
        },
        {
          version: "2.0.17",
          date: "2026-09-26",
          method: "live-probe",
          artifact: ".capture/opencode-v2",
          what: "Nested drive: one server hosts a session in an outer checkout and one in a checkout nested inside it, each with generated project wiring. The subscription of the plugin instance for the nested location received the outer session's session.created and execution events; hook callbacks were location-scoped. With location filtering each session dispatched only its own copy's hooks.",
        },
        {
          version: "2.0.17",
          date: "2026-09-27",
          method: "captured",
          artifact: "fixtures/opencode/2.0",
          what: "A GPT-like model id swaps edit/write for patch, whose patchText carries a Codex-grammar patch that applied (tool-patch-before/after, .capture/opencode-v2 tools-patch)",
        },
        {
          version: "2.0.18",
          date: "2026-09-28",
          method: "captured",
          artifact: "fixtures/opencode/2.0",
          what: "Turn fields over the loopback model (observe drive, isolated state): the plugin's event subscription receives session.execution.started, session.step.*, session.text.started/delta/ended ({ sessionID, assistantMessageID, ordinal, text }) and then session.execution.succeeded ({ sessionID } only). Each model step has its own assistantMessageID; the prompt hook's messageID matches session.inbox.enqueued's inboxID (turn-fields/events.jsonl, execution-succeeded-with-turn).",
        },
        {
          version: "2.0.18",
          date: "2026-09-30",
          method: "live-probe",
          artifact: ".capture/opencode-dispose",
          what: "One-shot run over the loopback model, isolated state, Windows: plugins run in a server process, not the run process. With --standalone the private server was terminated when run exited 0.7 s after session.execution.succeeded; the plugin's cleanup was never called and a 3 s task started at succeeded never finished. Through the background service (its own port) run exited 41 ms after succeeded and the task finished in the service 3 s later.",
        },
        // scheduled-playback:begin
        {
          version: "2.0.22",
          date: "2026-10-04",
          method: "live-probe",
          artifact: ".capture/harness-playback",
          what: "scheduled model-free playback vs a newer build: artifact discovery, rewrite/block markers, and lifecycle events verified",
        },
        // scheduled-playback:end
        {
          version: "2.0.20",
          date: "2026-10-04",
          method: "live-probe",
          artifact: ".capture/shell-dialects",
          what: "Windows loopback shell interpreter probe: execute.before shell payload and executed Node process ancestry establish Windows powershell.exe for this isolated configuration.",
        },
        {
          version: "2.0.20",
          date: "2026-10-04",
          method: "live-probe",
          artifact: ".capture/shell-dialects",
          what: "macOS loopback shell interpreter probe: captured execute.before shell payload and executed Node process ancestry establish /bin/bash for this isolated GitHub runner configuration.",
        },
        {
          version: "2.0.22",
          date: "2026-10-04",
          method: "captured",
          artifact: "fixtures/opencode/2.0/context-max-tokens.input.json",
          what: "Linux isolated harness-watch playback capture: the context callback carries numeric event.options.maxTokens (4096). The native envelope is preserved in raw; no token-limit effect or normalized field is claimed.",
        },
      ],
    },
    // Optional event fields (ADR-0027). The turn fields rest on the 2.0.18
    // capture in .capture/opencode-v2 (observe drive, event subscription).
    fields: {
      "tool.before.correlation.toolCallId": { level: "exact" },
      "tool.after.correlation.toolCallId": { level: "exact" },
      "tool.error.correlation.toolCallId": { level: "exact" },
      "tool.error.error.message": { level: "exact" },
      "permission.request.correlation.toolCallId": { level: "exact" },
      "prompt.before.correlation.turnId": {
        level: "exact",
        rationale: "the prompt hook's messageID, the id of the user message it admits.",
      },
      "turn.stop.lastMessage": {
        level: "emulated",
        rationale:
          "execution completion carries only the session id. The shim buffers the session.text.ended events of each execution from the event subscription and joins, in ordinal order, the text of the last assistant message that produced any (one message per model step, as on Claude). Only sessions the plugin tracks, only while subscribed, and only when a turn.stop hook declares this field. A failed or interrupted execution reports whatever text had ended.",
      },
      "turn.stop.correlation.turnId": {
        level: "emulated",
        rationale:
          "the messageID of the prompt that started the execution, remembered from the prompt hook: the id prompt.before reports. Absent for an execution no prompt hook started, such as a stop-prevention continuation (session.synthetic), and when the plugin did not see the prompt. A prompt admitted while an execution runs changes nothing and is handed to no later execution, which then reports none.",
      },
    },
    matrix: {
      "session.start.observe": {
        level: "approximate",
        rationale:
          "Via the live session.created subscription, for sessions created in the plugin's own location. A server session created before lazy plugin setup is missed; plugin setup itself is not a session start.",
      },
      "prompt.before.observe": { level: "exact" },
      "prompt.before.block": {
        level: "exact",
        rationale: "Throwing from the prompt hook prevents admission; the probe recorded zero model requests.",
      },
      "tool.before.observe": { level: "exact" },
      "tool.before.block": {
        level: "exact",
        rationale: "Throwing from execute.before prevents the tool from executing.",
      },
      "tool.before.input.replace": {
        level: "exact",
        rationale: "Mutating event.input before execution changes the executed command.",
      },
      "tool.after.observe": { level: "exact" },
      "tool.error.observe": {
        level: "approximate",
        rationale:
          "Via execute.after status error, captured for a missing-file read. A plain JavaScript exception from a custom tool bypassed this callback; shell nonzero exits are completed results.",
      },
      "tool.after.output.replace": {
        level: "approximate",
        rationale:
          "Replaces model-visible result.content; non-string portable values are serialized, and structured result.output and metadata remain native.",
      },
      "model.request.before.observe": {
        level: "approximate",
        rationale:
          "Captured context, title, generate and compaction callbacks cover the four audited request routes. Callback cadence is not guaranteed to match HTTP retries or other provider paths.",
      },
      "model.request.before.context.add": {
        level: "approximate",
        rationale:
          "Text system parts reach ordinary, title, generation and successful compaction requests on OpenAI-compatible, Anthropic Messages and OpenAI Responses HTTP paths. WebSocket and other provider paths are unverified.",
      },
      "turn.stop.observe": {
        level: "approximate",
        rationale:
          "Via execution succeeded, failed and interrupted events. These report execution completion, including manual compaction; they are asynchronous observations and cannot prevent completion. The subscription delivers every location's sessions, so only sessions created in or prompted through the plugin's location dispatch; a session first seen after a plugin reload is attributed at its next prompt. The completion carries only the session id; lastMessage and correlation.turnId are assembled from earlier events, see the field ratings. Hooks run in the server process: through the background service a hook still running when `opencode run` exits completes there, but `run --standalone` terminates its private server without calling plugin cleanup, so such a hook is cut off.",
      },
      "turn.stop.prevent": {
        level: "approximate",
        rationale:
          "No native stop hook. After a succeeded execution, the reason is admitted with session.synthetic and resume, which starts a new execution carrying it as a user-role message; the first execution has already completed. Failed and interrupted executions and child sessions (session.created parentID) post nothing, so an interrupt is never overridden. There is no stop_hook_active flag or block cap: a hook that always prevents loops. Requires a session that outlives the event; a child created before plugin setup is not recognized. Best-effort: a silent no-op without a session id or if the post fails.",
      },
      "turn.stop.notify": {
        level: "approximate",
        rationale:
          "No user-only channel for server plugins; toast and attention are TUI-only. The message is admitted to the session inbox with session.synthetic resume:false and starts no execution, but neither the TUI nor the message API shows it until the session next runs, when it arrives as a user-role message the model reads. Posted under the same succeeded, top-level-session conditions as turn.stop.prevent. Best-effort.",
      },
      "context.compact.before.observe": {
        level: "exact",
        rationale: "Via the captured compaction callback before summary generation.",
      },
      "context.compact.before.context.add": {
        level: "exact",
        rationale: "Added system text reaches the summary request and compaction completes successfully.",
      },
      "context.compact.after.observe": {
        level: "emulated",
        rationale:
          "Via session.compaction.ended on the event subscription after a successful summary, for sessions of the plugin's location; failures are excluded.",
      },
      "permission.request.observe": {
        level: "approximate",
        rationale:
          "Only permission evaluations with effect ask are dispatched. This is before the approval UI; allow/deny policy decisions are excluded. The payload has action/resources and a call ID, but no tool name or input, so tool stays unknown/other and the native fields remain in raw.",
      },
      "permission.request.block": {
        level: "approximate",
        rationale:
          "Changing an ask evaluation to deny prevents execution without showing approval. Applies only to pending ask decisions, with the same missing tool identity as observation.",
      },
    },
  },
];
