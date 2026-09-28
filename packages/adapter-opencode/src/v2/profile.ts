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
        // scheduled-playback:begin
        {
          version: "2.0.18",
          date: "2026-09-28",
          method: "live-probe",
          artifact: ".capture/harness-playback",
          what: "scheduled model-free playback vs a newer build: artifact discovery, rewrite/block markers, and lifecycle events verified",
        },
        // scheduled-playback:end
      ],
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
          "Via execution succeeded, failed and interrupted events. These report execution completion, including manual compaction; they are asynchronous observations and cannot prevent completion. The subscription delivers every location's sessions, so only sessions created in or prompted through the plugin's location dispatch; a session first seen after a plugin reload is attributed at its next prompt.",
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
