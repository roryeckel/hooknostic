import type { CapabilityProfile } from "@hooknostic/core";

export const opencodeV2CapabilityProfiles: CapabilityProfile[] = [
  {
    range: ">=2.0.17 <3",
    source: {
      date: "2026-09-26",
      validatedOn: [
        {
          version: "2.0.32",
          date: "2026-10-17",
          method: "live-probe",
          artifact: ".capture/opencode-v2-audit",
          what: "An isolated OAuth playback listed tools after refresh while the first model turn still received an unknown-tool result; the next captured model request carried a native catalog update advertising the tool (oauth-catalog-readiness.json). The scripted model permits two retries after that observed update and still requires a protected tools/call with the refreshed bearer.",
        },
        {
          version: "2.0.32",
          date: "2026-10-17",
          method: "captured",
          artifact: "fixtures/opencode/2.0/tool-custom-error.input.json",
          what: "Windows loopback recapture: a plain custom Error is wrapped as Tool.Error and delivered through execute.after (tool-custom-error); project and relocated-package tools/call HTTP requests preserve the declared endpoint and headers without appending codemode=false (remote/playback-recapture.json).",
        },
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
          version: "2.3.0",
          date: "2026-11-16",
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
          version: "2.0.20",
          date: "2026-10-10",
          method: "captured",
          artifact: "fixtures/opencode/2.0",
          what: "tool-before-shell-cmd and tool-before-shell-tcsh: execute.before payloads from sessions whose context hook stated the shell tool's shell, cmd on Windows and tcsh on Linux. Pins the stated shell as the source of tool.shell.dialect, and tcsh as a shell with none (ADR-0029).",
        },
        {
          version: "2.0.17",
          date: "2026-10-10",
          method: "live-probe",
          artifact: ".capture/shell-dialects",
          what: "Windows loopback shell interpreter probe on the reference build: the context hook's shell tool description stated powershell before the call, and powershell.exe ran.",
        },
        {
          version: "2.0.20",
          date: "2026-10-10",
          method: "live-probe",
          artifact: ".capture/shell-dialects",
          what: "Linux container shell interpreter probe: the shell tool ran bash, zsh and tcsh by SHELL, and bash where SHELL named fish or was unset; the context hook stated each by name before the call, and shell.created carried its path after.",
        },
        {
          version: "2.0.20",
          date: "2026-10-10",
          method: "live-probe",
          artifact: ".capture/shell-dialects",
          what: "Windows loopback shell interpreter probe: one shell tool ran powershell.exe, Git for Windows bash.exe, cmd.exe and pwsh.exe by host configuration under identical execute.before input, and the context hook stated each shell by name before the call.",
        },
        {
          version: "2.0.20",
          date: "2026-10-11",
          method: "live-probe",
          artifact: ".capture/shell-dialects",
          what: "macOS runner shell interpreter recapture: with SHELL naming bash, the shell tool ran bash and the context hook stated bash before the call, naming the platform macOS; shell.created carried /bin/bash. No other macOS configuration was captured.",
        },
        {
          version: "2.0.22",
          date: "2026-10-04",
          method: "captured",
          artifact: "fixtures/opencode/2.0/context-max-tokens.input.json",
          what: "Linux isolated harness-watch playback capture: the context callback carries numeric event.options.maxTokens (4096). The native envelope is preserved in raw; no token-limit effect or normalized field is claimed.",
        },
        {
          version: "2.0.17",
          date: "2026-10-30",
          method: "live-probe",
          artifact: ".capture/opencode-notice",
          what: "Windows loopback session-start notice probe, server-only project plugin (no ./tui entry), under the TUI, an attached TUI, run and serve: ctx has no ui or attention at runtime; an RPC events.emit reaches the event stream but no built-in TUI renders it; session.synthetic resume:false at session.created is not rendered and reaches the model with the next prompt. No route showed the user a notice the model did not see. On serve, plugin setup ran only after the first prompt.",
        },
        {
          version: "2.2.0",
          date: "2026-10-30",
          method: "live-probe",
          artifact: ".capture/opencode-notice",
          what: "The 2.0.17 session-start notice probe repeated with the same results: a server-only plugin has no user-only route. The companion ./tui RPC route (.capture/opencode-v2 notifications) still renders a server-emitted notice and makes no model request; attention.notify still returns attention_disabled under scratch defaults.",
        },
        {
          version: "2.0.17",
          date: "2026-11-14",
          method: "live-probe",
          artifact: ".capture/opencode-v2-plugin-stderr",
          what: "Windows loopback handler-error probe, isolated state: the shim's console.error report of a throwing tool.before handler reached run's stderr only under run --standalone --print-logs. Under --standalone alone, or with --log-level debug, it reached neither stream nor opencode.log; the call failed open in every mode. The TUI and the background service were not measured.",
        },
        {
          version: "2.2.7",
          date: "2026-11-14",
          method: "live-probe",
          artifact: ".capture/opencode-v2-plugin-stderr",
          what: "The 2.0.17 handler-error probe repeated with the same results: the report is visible only under run --standalone --print-logs.",
        },
        {
          version: "2.0.17",
          date: "2026-11-14",
          method: "live-probe",
          artifact: ".capture/opencode-v2-plugin-throw",
          what: "Windows loopback probe, isolated state, a plain Error from one plugin callback at a time: execute.before and permission evaluate (allowed, and ask, which then raised no pending permission) denied the call with the message as the model-visible tool error; execute.after replaced the ran tool's result with it; prompt failed run with exit 1 and no model request; context failed the execution (exit 1); generate answered 500; compaction failed. title was dropped and the session succeeded; an unhandled rejection from an event-subscription loop was only logged.",
        },
        {
          version: "2.2.7",
          date: "2026-11-14",
          method: "live-probe",
          artifact: ".capture/opencode-v2-plugin-throw",
          what: "The 2.0.17 plugin-throw probe repeated with the same results on every domain.",
        },
        {
          version: "2.3.0",
          date: "2026-11-16",
          method: "captured",
          artifact: "fixtures/opencode/2.0/tool-subagent-background-after.input.json",
          what: "Windows loopback subagent drive, isolated state: every subagent runs in the background. execute.after fires as the child starts, with result.output.status running and a launch notice as content, so tool.after reports the notice. The child's result reaches the parent later as a user-role `<subagent>` message, from a synthetic session.inbox.enqueued item with metadata.source subagent (subagent-background/inbox-subagent-completed.json). 2.2.7 still ran the child in the foreground.",
        },
        {
          version: "2.3.0",
          date: "2026-11-16",
          method: "live-probe",
          artifact: ".capture/opencode-v2-audit",
          what: "Background children over the loopback model, Windows, isolated state. With the child's reply 3 s late (subagent-late drive), the parent's execution ended first, run --standalone waited for the child, and its `<subagent>` message started a second parent execution that no prompt hook started: three turn.stop dispatches, the last without turnId. On the serve stop drive with the child 6 s late, prevention did not wait for it, the child's result started a third parent execution, and the earlier notice reached the model in that execution's request. 2.2.7 ran both drives' children in the foreground.",
        },
        {
          version: "2.0.17",
          date: "2026-11-16",
          method: "captured",
          artifact: "fixtures/opencode/2.0/subagent-stop.input.json",
          what: "Windows loopback subagent drive, isolated state, foreground child: the plugin's event subscription received the child's session.created (parentID, agent), its session.text.ended and its own session.execution.succeeded ({ sessionID } only), all before the parent's execution ended. The completion, with the remembered parent, agent and text, decodes as agent.stop under the parent (subagent-stop/events-2.0.17.jsonl).",
        },
        {
          version: "2.3.0",
          date: "2026-11-16",
          method: "captured",
          artifact: "fixtures/opencode/2.0/subagent-stop/events-2.3.0.jsonl",
          what: "The same subagent drive with a background child: its session.created (parentID, agent), text and own session.execution.succeeded reached the subscription as on 2.0.17, and its result reached the parent as a subagent inbox item. Replayed, the child's completion dispatches its own turn.stop and then agent.stop under the parent.",
        },
        {
          version: "2.0.17",
          date: "2026-11-16",
          method: "live-probe",
          artifact: ".capture/opencode-v2-audit",
          what: "Child completions over the loopback model, Windows, isolated state. A child whose model request failed with HTTP 400 dispatched agent.stop with no lastMessage (subagent-fail). A follow-up to the same child by sessionID dispatched a second agent.stop with the same agent.id and the follow-up's text (subagent-followup). With the opt-in background argument (subagent-opt-in), a child that finished while run was still going dispatched agent.stop; with its reply 3 s late, run --standalone exited first, the child only started, and neither its turn.stop nor agent.stop dispatched.",
        },
        {
          version: "2.2.6",
          date: "2026-11-16",
          method: "live-probe",
          artifact: ".capture/opencode-v2-audit",
          what: "The 2.0.17 opt-in background probe with the child's reply 3 s late: run --standalone waited for the child, which dispatched its turn.stop and agent.stop, and its result started a second parent execution.",
        },
        {
          version: "2.0.17",
          date: "2026-11-16",
          method: "captured",
          artifact: "fixtures/opencode/2.0/subagent-start.input.json",
          what: "From the same subagent drive as subagent-stop: the child's session.created (parentID, agent) decodes as agent.start under the parent, and its completion, with the remembered parent, as the child's own turn.stop carrying correlation.agentId and correlation.parentAgentId (turn-stop-subagent). Replayed, agent.start precedes the child's session.start.",
        },
        {
          version: "2.0.17",
          date: "2026-11-16",
          method: "live-probe",
          artifact: ".capture/opencode-v2-audit",
          what: "session.get over serve, Windows, isolated state (session-get probe): a function returning the stored record, with parentID and agent for a child, in a median 0.5 ms. The child's prompt hook ran before its session.created reached the subscription. After an idle reload the new instance saw a follow-up child's prompt and completion but not its creation, and the shim, looking the child up at its prompt, dispatched its turn.stop with agent ids and one agent.stop, and posted nothing for it under prevention. The API dropped a child's parentID. A reload while a child ran left the old instance alive: both dispatched later stops.",
        },
        {
          version: "2.2.6",
          date: "2026-11-16",
          method: "live-probe",
          artifact: ".capture/opencode-v2-audit",
          what: "The 2.0.17 session.get probe and shim drives repeated: the follow-up after an idle reload was recovered, as was a child created through the API with parentID before lazy setup. A reload while a child ran: the old instance handled its completion, then was disposed. An API child for another location was put in the parent's.",
        },
        {
          version: "2.3.0",
          date: "2026-11-16",
          method: "live-probe",
          artifact: ".capture/opencode-v2-audit",
          what: "The 2.2.6 results repeated, except a reload while a background child ran: the old instance was disposed before the child completed, and the new one saw only the completion, so neither the child's turn.stop nor its agent.stop was reported.",
        },
        {
          version: "2.0.17",
          date: "2026-11-16",
          method: "live-probe",
          artifact: ".capture/opencode-v2-audit",
          what: "Plugin reloads over serve, Windows, isolated state (#236; session-get probe and the subagent-reload-running playback drives). A reload while an execution ran left the old plugin instance alive for good. Both instances received every later event with the same event id, and neither received an event published before its own setup. Through the shim: a session created and prompted while both lived reported one session.start and one turn.stop, with its prompt's turn id (two of each before); a follow-up to a child that ran across the reload reported each completion's turn.stop and agent.stop once (three of each for two completions before); a new child created after the reload, which both instances saw created, reported one agent.start and one session.start (two before); stop prevention reached the session started meanwhile once (twice before), and never a child.",
        },
        {
          version: "2.2.6",
          date: "2026-11-16",
          method: "live-probe",
          artifact: ".capture/opencode-v2-audit",
          what: "The 2.0.17 reload drives repeated: the old instance was kept until the running execution ended (about 3.9 s after the new one's setup), then disposed. The session prompted meanwhile reported each start and stop once (twice before). The parent's turn.stop after the reload, missed before, was reported once with its turn id, and took stop prevention.",
        },
        {
          version: "2.3.0",
          date: "2026-11-16",
          method: "live-probe",
          artifact: ".capture/opencode-v2-audit",
          what: "The 2.0.17 reload drives repeated. The old instance was disposed before the running background child's completion reached the new instance, 12 to 27 ms before it in 8 of 8 probe runs (and in 35 of 35 during planning), and the old instance never received that completion. The shim handed the child, its parent and the running execution to the new instance at disposal, which reported the child's turn.stop, with its last message and agent ids, its agent.stop, and the parent's follow-on turn.stop, all missed before.",
        },
        {
          version: "2.0.17",
          date: "2026-11-17",
          method: "live-probe",
          artifact: ".capture/opencode-v2-audit",
          what: "subagent-reload-running-steer drive (#236 review): after a reload while a child ran, a prompt to the parent and one to the child, both steered into executions the old instance still ran, with stop prevention on. Through the shim the child's turn.stop and agent.stop carried its last message, the turn.stop the id of the prompt that started the execution, and no stop carried a steered prompt's id; before, the new instance reported the child's stop without either.",
        },
        {
          version: "2.2.6",
          date: "2026-11-17",
          method: "live-probe",
          artifact: ".capture/opencode-v2-audit",
          what: "The 2.0.17 steer drive repeated, with the same results before and after.",
        },
        {
          version: "2.3.0",
          date: "2026-11-17",
          method: "live-probe",
          artifact: ".capture/opencode-v2-audit",
          what: "The 2.0.17 steer drive repeated, the parent's prevention continuation answering 1.5 s late so the steered parent execution ended while the old instance lived. Through the shim no stop carried a steered prompt's id; before, a later parent stop carried the steered parent prompt's id (3 of 3 runs). The child's stop had its text and turn id before and after, through the handover.",
        },
        {
          version: "2.0.17",
          date: "2026-11-17",
          method: "live-probe",
          artifact: ".capture/opencode-v2-audit",
          what: "The steer drive's traces before the fix, read again (#236, second review): besides the child's stop without text or turn id, the parent's prevention continuation carried the steered parent prompt's id, in 2 of 2 runs; on 2.2.6 no stop carried a steered id in 2 runs. With every instance now tracking the executions it sees start, the steer drive passed 10 of 10 runs on 2.0.17, 2.2.6 and 2.3.0.",
        },
        {
          version: "2.0.17",
          date: "2026-11-20",
          method: "live-probe",
          artifact: ".capture/opencode-v2",
          what: "ripgrep pre-seed (#264), tools drive on Windows, Linux (WSL) and a macOS arm64 runner: unseeded, glob/grep logged downloading ripgrep at INFO and cached it as $XDG_CACHE_HOME/opencode/bin/rg (rg.exe on Windows); with the pinned build seeded there, nothing was downloaded, the seeded binary ran and both tools completed.",
        },
        {
          version: "2.3.2",
          date: "2026-11-20",
          method: "live-probe",
          artifact: ".capture/opencode-v2",
          what: "ripgrep pre-seed (#264), tools drive on Linux (WSL): unseeded, the harness logged downloading ripgrep at INFO and cached it as $XDG_CACHE_HOME/opencode/bin/rg; seeded there, it logged no download and glob/grep completed. This build logs no process spawns, so which rg ran is not recorded.",
        },
        {
          version: "2.4.0",
          date: "2026-11-23",
          method: "captured",
          artifact: "fixtures/opencode/2.0/subagent-background/inbox-background-result.json",
          what: "Windows loopback subagent drive, isolated state (#303): the background child's result reaches the parent as a user-role `<background-result kind=\"subagent\" ...>` message instead of `<subagent ...>`, from the same synthetic session.inbox.enqueued item with metadata.source subagent. Launch notice, tool.after, agent.stop and the parent's extra execution are unchanged. 2.3.2 still sent `<subagent ...>`; 2.4.1 sends the new wrapper. No decoder or shim reads the wrapper.",
        },
        {
          version: "2.4.0",
          date: "2026-11-23",
          method: "captured",
          artifact: "fixtures/opencode/2.0/remote/observations-server-discover.json",
          what: "Windows loopback remote MCP drive (#303): each remote server now receives a POST server/discover (mcp-protocol-version 2026-07-28) before initialize. The constructed Streamable HTTP peer answered it with an empty result; OpenCode then initialized, listed and called the tool with the declared headers. The legacy SSE endpoint answered both POSTs 405 and got no fallback GET, as before; 2.3.2 sent initialize alone. 2.4.1 behaved the same.",
        },
        {
          version: "2.4.1",
          date: "2026-11-23",
          method: "captured",
          artifact: "fixtures/opencode/2.0/tool-before-watch-linux.input.json",
          what: "Linux isolated harness-watch playback capture (run 45213265898, #303), compared with the 2.0.17 fixtures; which build changed each field is not established. Shell execute.before adds top-level codemode and info; the advertised shell input keys (command, workdir) are unchanged, so tool.shell decodes as before. Shell execute.after's result.output drops exit, truncated and status and adds exitCode and wallTimeSeconds; result.metadata still carries status, truncated and exit, and tool.after reads result.content, which is unchanged. The context callback's messages drop metadata and its tools add generate_image and generate_video (tool-after-watch-linux, context-watch-linux). Raw forms are preserved; no capability changes.",
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
      "agent.stop.agent.id": {
        level: "exact",
        rationale: "the child's session id, which its execution completion carries.",
      },
      "agent.stop.correlation.agentId": {
        level: "exact",
        rationale: "the child's session id, as agent.id.",
      },
      "agent.stop.agent.type": {
        level: "emulated",
        rationale:
          "the agent named by the child's session.created, remembered from the event subscription, or found by session.get when the plugin never saw it (see agent.stop.observe); the completion does not carry it.",
      },
      "agent.stop.correlation.parentAgentId": {
        level: "emulated",
        rationale:
          "the parent's session id, from the child's session.created parentID, remembered from the event subscription, or found by session.get when the plugin never saw it (see agent.stop.observe); also the event's session.id.",
      },
      "agent.stop.lastMessage": {
        level: "emulated",
        rationale:
          "assembled as turn.stop.lastMessage is, from the child's own session.text.ended events, and only when an agent.stop hook declares it. Absent when the child failed before it ended any text.",
      },
      "agent.start.agent.id": {
        level: "exact",
        rationale: "the child's session id, from its session.created.",
      },
      "agent.start.correlation.agentId": {
        level: "exact",
        rationale: "the child's session id, as agent.id.",
      },
      "agent.start.agent.type": {
        level: "exact",
        rationale: "the agent the child's session.created names.",
      },
      "agent.start.correlation.parentAgentId": {
        level: "exact",
        rationale: "the parentID the child's session.created carries; also the event's session.id.",
      },
      "turn.stop.correlation.agentId": {
        level: "exact",
        rationale:
          "on a subagent child's own turn.stop only: the child's session id, which the completion carries. Set for a child whose session.created the plugin saw in its own location, or whose parent session.get found when the child's prompt reached this plugin instance (see agent.stop.observe). Absent on a top-level session's turn.stop.",
      },
      "turn.stop.correlation.parentAgentId": {
        level: "emulated",
        rationale:
          "on a subagent child's own turn.stop only: the parent's session id, remembered from the child's session.created or found by session.get, for the same children as correlation.agentId. The completion does not carry it.",
      },
      "prompt.before.correlation.turnId": {
        level: "exact",
        rationale: "the prompt hook's messageID, the id of the user message it admits.",
      },
      "turn.stop.lastMessage": {
        level: "emulated",
        rationale:
          "execution completion carries only the session id. The shim buffers the session.text.ended events of each execution from the event subscription and joins, in ordinal order, the text of the last assistant message that produced any (one message per model step, as on Claude). Only sessions the plugin tracks, only while subscribed, and only when a turn.stop hook declares this field. A failed or interrupted execution reports whatever text had ended. After a plugin reload, an execution the old plugin instance still runs reaches the new instance with the text it collected: when a prompt is steered into it at the new instance, which takes a copy at that prompt, or when the old instance is disposed, which hands it to the newest live instance, merged at the session's next event; a segment both buffered is kept once. Text that ended after the old instance stopped reading events and before the new one knew the session is missing.",
      },
      "turn.stop.correlation.turnId": {
        level: "emulated",
        rationale:
          "the messageID of the prompt that started the execution, remembered from the prompt hook: the id prompt.before reports. Absent for an execution no prompt hook started, such as a stop-prevention continuation (session.synthetic) or one a background subagent's result starts in its idle parent (observed on 2.3.0, where every subagent runs in the background, and on 2.0.17 and 2.2.6 for a child given the tool's opt-in background argument; before 2.3.0 a subagent runs in the foreground by default), and when the instance that reports the stop neither took the prompt nor got the execution from the instance that did (after a plugin reload, a session the new instance knows only from its session.created, whose prompt the old instance took). An execution still running across a plugin reload keeps the id of the prompt that started it, whether the new instance takes it over at a steered prompt or from the handover; where the old instance's hooks read no turn id, it is missing. After a reload that adds the first subscribing hook, the old instance tracked no execution, and a prompt steered into one can lend its id to a later execution: wrong, as before #236 (see turn.stop.observe). A prompt admitted while an execution runs changes nothing and is handed to no later execution, which then reports none; that includes a prompt the new instance took while the old one still ran the execution, or after it handed that execution over. If a handed-over execution had in fact ended unheard (see turn.stop.observe on the order of disposal), the next prompt's execution reports no id: missing, never wrong.",
      },
    },
    matrix: {
      "session.start.observe": {
        level: "approximate",
        rationale:
          "Via the live session.created subscription, for sessions created in the plugin's own location. A server session created before lazy plugin setup is missed; plugin setup itself is not a session start. While a reloaded plugin's old instance still runs (until the running execution ends on 2.2.6 and 2.3.0; for good on 2.0.17), a session created meanwhile is reported once, by the newest instance (observed on all three; twice before).",
      },
      "session.start.notify": {
        level: "unsupported",
        rationale:
          "A server plugin has no user-only channel: ctx has no ui or attention at runtime, no built-in TUI renders an RPC event, and session.synthetic resume:false is not shown and reaches the model. Only a companion ./tui entry can show one, and Hooknostic generates none (.capture/opencode-notice).",
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
      "tool.after.observe": {
        level: "exact",
        rationale:
          "Via execute.after, with the tool's own result. For a subagent call (kind agent) that is the child's final response when the child runs in the foreground, the default up to 2.2.7. For a background child it is the launch notice, with raw result.output.status running: every child from 2.3.0, and one given the tool's opt-in background argument on 2.0.17 and 2.2.6, the earlier builds where that argument was probed. The child's result then reaches the parent as a user-role `<subagent>` message (`<background-result kind=\"subagent\">` from 2.4.0) that no tool hook sees; agent.stop reports the child's completion, with its last message as lastMessage when declared.",
      },
      "tool.error.observe": {
        level: "approximate",
        rationale:
          "Via execute.after status error, captured for a missing-file read. Plain custom exceptions bypassed this callback in the initial capture and were wrapped as Tool.Error in a later recapture, so error coverage varies across validated builds; shell nonzero exits are completed results.",
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
          "Via execution succeeded, failed and interrupted events. These report execution completion, including manual compaction; they are asynchronous observations and cannot prevent completion. The subscription delivers every location's sessions, so only sessions created in or prompted through the plugin's location dispatch; a session first seen after a plugin reload is attributed at its next prompt, unless the plugin's previous instance in this server process handed it over when disposed (below). That prompt, like the first prompt of any session whose session.created the plugin did not see (a top-level serve session created before lazy setup included), starts a session.get lookup (see agent.stop.observe), and a completion arriving while it is pending waits for it in that session's own queue, at most 2 s (about 0.5 ms measured). The completion carries only the session id; lastMessage and correlation.turnId are assembled from earlier events, see the field ratings. Hooks run in the server process: through the background service a hook still running when `opencode run` exits completes there, but `run --standalone` terminates its private server without calling plugin cleanup, so such a hook is cut off. Up to 2.2.7 a subagent runs in the foreground by default; from 2.3.0 it always runs in the background, as one given the tool's opt-in background argument did on 2.0.17 and 2.2.6. With a background child one prompt can end in several top-level completions (observed on 2.3.0, and with an opt-in child on 2.0.17 and 2.2.6): the parent's execution can end before its child, and the child's result then starts another, which dispatches its own turn.stop. A subagent child's own completion dispatches turn.stop under the child's session id, carrying the child as correlation.agentId and its parent as correlation.parentAgentId, and a succeeded or failed one then also dispatches agent.stop under the parent's (see agent.stop.observe, which says which children are recognized). After a plugin reload while an execution runs, OpenCode keeps the old plugin instance until that execution ends (2.2.6, 2.3.0) or for good (2.0.17), and both receive every event with the same event id. Each start, stop and compaction event then dispatches once, keyed by that id: from the newest instance that knows the session, which runs the hooks as last loaded; prompts reach the new instance, and one steered into an execution the old instance still runs makes the new instance take over that execution's text and prompt id (observed on all three builds; before, the new instance reported such a stop without them on 2.0.17 and 2.2.6, and a later stop of the session could carry the steered prompt's id, observed on 2.0.17 and 2.3.0). Every instance tracks the executions it sees start, whatever its hooks declare, so this holds when the reload added hooks that read the turn's fields: the text and prompt id are then missing, never wrong (unit-tested). An old instance with no subscribing hook tracks nothing, so a reload that adds the first subscribing hook can still leave a steered prompt's id to a later execution, as before #236. Any newer instance with a subscribing hook counts, whatever its own hooks; a newer instance with none is not counted, so the old one keeps dispatching with the old hooks. A disposed instance hands the sessions it knew, with their running executions, to the newest live instance of the same plugin, location and plugin root in the server process (at most 256; running executions are kept before others). Observed on 2.3.0: the old instance is disposed before a running child's completion reaches the new one, in every capture. In the worst case, a build that delivers the completion first: if the old instance still receives it, it dispatches it, and the claim keeps that to one dispatch; it is missed only when the host stops delivering events to the old instance before calling its cleanup, and then the new instance skips it because it does not know the session yet, not because of the claim. An accepted, documented limit (#238 records the reasoning): a second reload while the newer instance still has a hook running, or an event queued or pending, can drop an event that the older instance would have reported (a stop, or a session.start, agent.start or context.compact.after), since the older one yielded. Narrower: an older instance disposed with an event it claimed still queued drops it, and a newer instance that learned the session from a prompt only after that claim does not report it either, where before this it did. Not across a server restart or between two Hooknostic releases, where each instance dispatches as before.",
      },
      "turn.stop.prevent": {
        level: "approximate",
        rationale:
          "No native stop hook. After a succeeded execution, the reason is admitted with session.synthetic and resume, which starts a new execution carrying it as a user-role message; the first execution has already completed. Failed and interrupted executions and child sessions (session.created parentID) post nothing, so an interrupt is never overridden. There is no stop_hook_active flag or block cap: a hook that always prevents loops. Requires a session that outlives the event. A child is recognized as agent.stop.observe says: one whose session.created the plugin did not see is recognized once its prompt reaches this plugin instance, and then posts nothing either, and so is a background child still running across a plugin reload, handed to the plugin's new instance (observed on 2.3.0). A stop is prevented at most once while a reloaded plugin's old instance still runs: the instance that dispatches it posts (observed on all three; twice before). Best-effort: a silent no-op without a session id or if the post fails. Prevention does not wait for a background subagent: the continuation can run and stop again before the child's result arrives and starts another execution (observed on 2.3.0, where every subagent runs in the background). Earlier builds run a subagent in the foreground by default. A child given their opt-in background argument, probed on 2.0.17 and 2.2.6 for agent.stop and the run cut-off, started another parent execution there too when it finished after its parent; prevention timing with such a child was not probed.",
      },
      "turn.stop.notify": {
        level: "approximate",
        rationale:
          "No user-only channel for server plugins; toast and attention are TUI-only. The message is admitted to the session inbox with session.synthetic resume:false and starts no execution, but neither the TUI nor the message API shows it until the session next runs, when it arrives as a user-role message the model reads. Posted under the same succeeded, top-level-session conditions as turn.stop.prevent. The next run can also be one a background subagent's result starts, so the notice can reach the model without another user prompt (observed on 2.3.0, where every subagent runs in the background). On 2.0.17 and 2.2.6 a child given the opt-in background argument that finished after its parent also started such a run, but whether a pending notice reached it was not probed. Best-effort.",
      },
      "agent.start.observe": {
        level: "approximate",
        rationale:
          "No subagent start callback. A child's session.created (with parentID), seen on the event subscription in the plugin's own location, dispatches agent.start under the parent's session id, just before the child's own session.start. Asynchronous and observe-only: the child already exists, and its own prompt.before has already been dispatched; the dispatch is not ordered with the parent's tool.after, which a background child's launch notice can precede or follow. To stop a subagent from starting, block tool.before for kind agent. A follow-up to an existing child (the subagent tool's sessionID) creates no session and dispatches none, nor does a child recognized only by session.get (see agent.stop.observe). On 2.0.17, after a plugin reload while an execution runs leaves the old instance alive, a child created later is seen by both instances, and its agent.start is dispatched once, by the newest (observed; twice before). Up to 2.2.7 a subagent runs in the foreground by default; from 2.3.0 it always runs in the background, as one given the tool's opt-in background argument did on 2.0.17 and 2.2.6.",
      },
      "agent.stop.observe": {
        level: "approximate",
        rationale:
          "No subagent stop callback. A child session's own execution succeeded or failed event, for a recognized child, dispatches agent.stop under the parent's session id, right after the child's own turn.stop, which still fires under the child's session id. A child is recognized when the plugin saw its session.created (with parentID) in its own location, or, when it did not (a child created before a plugin reload, or through the API before lazy plugin setup), once the child's next prompt reaches this plugin instance: the prompt hook then looks up its parent with session.get, bounded at 2 s, and a lookup that fails, times out or finds no parent in this location leaves the child unrecognized. A background child still running when the plugin reloads, whose prompt went through the old instance, is recognized through the old instance's handover (observed on 2.3.0, where the old instance was disposed before the child completed; see turn.stop.observe for the order this relies on); not across a server restart, nor between two Hooknostic releases, where the session.get lookup at its next prompt still applies, as it does to a child handed over without its parent. Not recognized: a child in another location, which was not reproduced (subagent children took the parent's location in every capture). On 2.0.17 the API dropped a new session's parentID. An interrupted child is not reported. Asynchronous: the child's result has already gone back to the parent or been queued for it. Each completion dispatches, so a follow-up to the same child (the subagent tool's sessionID) dispatches again with the same agent.id. Hooks run in the server process, so a background child still running when `opencode run --standalone` exits is cut off and dispatches nothing: observed on 2.0.17 with the opt-in background argument, while 2.2.6 waited for the same late child. On 2.0.17 a plugin reload while an execution runs leaves the old plugin instance alive; each completion still dispatches its turn.stop and agent.stop once (observed; twice before).",
      },
      "agent.stop.prevent": {
        level: "unsupported",
        rationale:
          "The child has already completed and its result has already gone back to the parent, or been queued for it, when the event arrives. A child takes no stop prevention, and a post to the parent would steer the parent instead, so the shim posts nothing for agent.stop.",
      },
      "agent.stop.notify": {
        level: "unsupported",
        rationale:
          "A server plugin has no user-only channel (see session.start.notify), and the shim posts nothing for agent.stop: a child takes no posts, and a post to the parent would reach its model.",
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
          "Via session.compaction.ended on the event subscription after a successful summary, for sessions of the plugin's location; failures are excluded. Once while a reloaded plugin's old instance still runs, by the same rule as turn.stop.observe (unit-tested; not captured during a reload).",
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
