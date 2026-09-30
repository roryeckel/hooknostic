import type { CapabilityMatrix, CapabilityProfile, FieldMatrix } from "@hooknostic/core";

/**
 * Shared by both stop events: `systemMessage` is accepted on the wire and never
 * rendered, which is the one place the three harnesses genuinely diverge.
 */
const NOTIFY_ACCEPTED_AND_DISCARDED =
  'systemMessage is accepted by the stop.command.output / subagent-stop.command.output wire schemas -- a live 0.148.0 run validates cleanly and logs "Stop Completed" -- but 0.148.0 has no rendering path for it and the message appears nowhere. Accepted-and-discarded is not support: claiming it would make a portable hook lose every notice on this target, silently.';

/**
 * Every Codex capability cell except agent identity, which splits the data
 * by version (ADR-0030): below 0.156.1 no hook was observed inside a
 * subagent at all.
 */
const codexMatrix: CapabilityMatrix = {
  "session.start.observe": { level: "exact" },
  "session.start.context.add": { level: "exact" },

  "session.end.observe": { level: "exact" },

  "prompt.before.observe": { level: "exact" },
  "prompt.before.block": { level: "exact" },
  "prompt.before.context.add": { level: "exact" },

  // Codex exposes no per-model-request lifecycle point: no hook sits
  // between system-prompt assembly and the model request. model.request.before
  // is therefore absent entirely rather than rated unsupported -- a defined
  // .observe cell would advertise the event and require a native fixture.
  // Capability analysis rejects a hook on it first (HN202).

  "tool.before.observe": {
    level: "exact",
    rationale:
      "tool-path coverage, not a security boundary: hosted tools (e.g. web_search) bypass hooks and write_stdin does not re-trigger PreToolUse. " +
      "Under Code Mode (tool_mode code_mode_only, which the gpt-5.6 catalog models carry) the model's exec script never reaches a hook; " +
      "each tool call the script makes does, one by one (observed on 0.156.1, .capture/codex-code-mode).",
  },
  "tool.before.block": {
    level: "exact",
    rationale:
      "Code Mode does not route around it: a nested tools.exec_command reaches PreToolUse as Bash/{command}, is selected by the " +
      "generated shell matcher, and a deny stops it (payload captured, dispatch and deny verified live on 0.156.1, " +
      ".capture/codex-code-mode). The exec " +
      "script has no filesystem, process, or network API of its own (codex-rs source), so its side effects all pass through such calls.",
  },
  "tool.before.requestApproval": {
    level: "exact",
    rationale: 'permissionDecision "ask" surfaces a native approval prompt.',
  },
  "tool.before.input.replace": {
    level: "exact",
    rationale:
      'vendor protocol requires permissionDecision "allow" alongside updatedInput, so a rewrite also resolves the permission decision.',
  },
  "tool.before.context.add": { level: "exact" },

  "tool.after.observe": { level: "exact" },
  // The output parser strictly rejects updatedMCPToolOutput from a
  // PostToolUse hook (fails open, run status Failed; captured live on
  // 0.151.0 and pinned by upstream's own
  // unsupported_updated_mcp_tool_output_fails_open test). The
  // updatedMCPToolOutput encoding stays in apply.ts as defensive wire
  // correctness, but no hook can deliver an output replacement here.
  // The output parser strictly rejects updatedMCPToolOutput from a
  // PostToolUse hook (fails open, run status Failed; captured live on
  // 0.151.0 and pinned by upstream's own
  // unsupported_updated_mcp_tool_output_fails_open test). The
  // updatedMCPToolOutput encoding stays in apply.ts as defensive wire
  // correctness, but no hook can deliver an output replacement here; the
  // mcp-stdio playback drive is the inverted watch. The MCP connector
  // path (not hooks) is the only output-replacement surface upstream.
  "tool.after.output.replace": {
    level: "unsupported",
    rationale:
      "the hook engine strictly rejects updatedMCPToolOutput from a PostToolUse hook " +
      '(fails open: run logs "PostToolUse hook returned unsupported updatedMCPToolOutput", ' +
      "status Failed; captured live on 0.151.0, .capture/codex-tools, and pinned by upstream " +
      "codex-rs unsupported_updated_mcp_tool_output_fails_open). Only additionalContext is " +
      "honoured on this event; the MCP connector path is the only output-replacement surface.",
  },
  "tool.after.blockContinuation": { level: "exact" },
  "tool.after.context.add": { level: "exact" },

  // No PostToolUseFailure equivalent in 0.148.0 → tool.error unsupported.

  "permission.request.observe": { level: "exact" },
  "permission.request.block": {
    level: "exact",
    rationale: 'hookSpecificOutput.decision.behavior "deny" with message.',
  },
  // PermissionRequest output wire has no additionalContext channel.

  "context.compact.before.observe": { level: "exact" },
  // pre-compact output wire exposes no decision; `continue:false` halts
  // the turn rather than the compaction → block unsupported.

  "context.compact.after.observe": { level: "exact" },

  "agent.start.observe": { level: "exact" },

  "agent.stop.observe": { level: "exact" },
  "agent.stop.prevent": { level: "exact" },

  "turn.stop.observe": { level: "exact" },
  "turn.stop.prevent": { level: "exact" },

  // Stated explicitly rather than left absent. Absent would resolve to the
  // same level, but `hooknostic inspect` can only print a rationale that
  // belongs to an entry -- and "we checked, and it does not work" is worth
  // more to a user than silence.
  "turn.stop.notify": {
    level: "unsupported",
    rationale: NOTIFY_ACCEPTED_AND_DISCARDED,
  },
  "agent.stop.notify": {
    level: "unsupported",
    rationale: NOTIFY_ACCEPTED_AND_DISCARDED,
  },
};

// Optional event fields (ADR-0027): exactly what the fixtures in
// fixtures/codex/0.148 carry, captured or schema-derived as its README
// records per fixture. turn_id is absent from SessionStart and SessionEnd,
// and the PermissionRequest schema has no tool_use_id.
const codexFields: FieldMatrix = {
  "session.start.how": { level: "exact" },
  "session.end.reason": { level: "exact" },
  "prompt.before.correlation.turnId": { level: "exact" },
  "tool.before.correlation.turnId": { level: "exact" },
  "tool.before.correlation.toolCallId": { level: "exact" },
  "tool.after.correlation.turnId": { level: "exact" },
  "tool.after.correlation.toolCallId": { level: "exact" },
  "permission.request.correlation.turnId": { level: "exact" },
  "context.compact.before.trigger": { level: "exact" },
  "context.compact.before.correlation.turnId": { level: "exact" },
  "context.compact.after.correlation.turnId": { level: "exact" },
  "agent.start.agent.id": { level: "exact" },
  "agent.start.agent.type": { level: "exact" },
  "agent.start.correlation.turnId": { level: "exact" },
  "agent.start.correlation.agentId": { level: "exact" },
  "agent.stop.agent.id": { level: "exact" },
  "agent.stop.agent.type": { level: "exact" },
  "agent.stop.lastMessage": { level: "exact" },
  "agent.stop.correlation.turnId": { level: "exact" },
  "agent.stop.correlation.agentId": { level: "exact" },
  "turn.stop.lastMessage": { level: "exact" },
  "turn.stop.correlation.turnId": { level: "exact" },
};

/** What a hook scoped to agents relies on, per ADR-0030. */
const AGENT_IDENTITY_EVENTS = ["tool.before", "tool.after", "agent.start", "agent.stop"] as const;

const NO_HOOK_INSIDE_A_SUBAGENT =
  "On 0.148.0 no hook fired inside a spawned subagent: its shell command ran and wrote a file with no PreToolUse, and neither SubagentStart nor SubagentStop fired (.capture/agents, under --dangerously-bypass-hook-trust). A hook scoped to a subagent would never run.";

/** From 0.156.1: captured inside a subagent for tool.before, tool.after and the lifecycle events. */
const agentIdentityFrom0156: CapabilityMatrix = {
  "tool.before.agent.identity": { level: "exact" },
  "tool.after.agent.identity": { level: "exact" },
  "agent.start.agent.identity": { level: "exact" },
  "agent.stop.agent.identity": { level: "exact" },
};

/**
 * Codex CLI capability data. Where docs and the binary disagreed, the binary
 * won (e.g. `permissionDecision` uses "ask", not an escalate variant). Version
 * facts live in `source.validatedOn`, not prose.
 *
 * `plugin_hooks` was read as removed from the 0.148.0 binary. It is not gone on
 * 0.153.2 -- an installed plugin's hook runs (`.capture/codex-plugin-hooks`) --
 * so do not restate that; the reason hooks still cannot ship in a projected
 * package is manifest precedence, recorded on the projector.
 */
export const codexCapabilityProfiles: CapabilityProfile[] = [
  {
    range: ">=0.140 <0.156.1",
    source: {
      date: "2026-08-29",
      validatedOn: [
        {
          version: "0.153.2",
          date: "2026-09-08",
          method: "live-probe",
          artifact: ".capture/codex-plugin-hooks",
          what: 'Hook EFFECTS survive the installed-plugin delivery boundary, not just hook invocation: driven through the offline playback lane, a tool.before deny stopped the tool running and a tool.before input rewrite reached the spawned command. The capability matrix resolves by version and ignores mode, so this is what lets mode: "plugin" advertise the same write channels the local .codex/hooks.json route evidences.',
        },
        {
          version: "0.148.0",
          date: "2026-08-20",
          method: "captured",
          artifact: "fixtures/codex/0.148",
          what: "hook payload fixtures via a trusted teeing project, captured on Windows",
        },
        {
          version: "0.148.0",
          date: "2026-08-20",
          method: "schema-derived",
          artifact: "fixtures/codex/0.148",
          what: "wire JSON Schemas embedded in the binary (*.command.input/output)",
        },
        {
          version: "0.148.0",
          date: "2026-08-29",
          method: "live-probe",
          artifact: ".capture/codex-output",
          what: "Stop output semantics: systemMessage accepted-and-discarded, never rendered",
        },
        {
          version: "0.151.0",
          date: "2026-08-30",
          method: "router-log",
          artifact: ".capture/codex-tools",
          what:
            "exec_command router args (cmd/workdir); NOTE the hook boundary translates " +
            "these calls to Bash/command payloads and drops workdir",
        },
        {
          version: "0.151.0",
          date: "2026-08-30",
          method: "live-probe",
          artifact: ".capture/codex-tools",
          what: "updatedInput write channel verified honoured (rewritten command reached spawn)",
        },
        {
          version: "0.151.0",
          date: "2026-09-02",
          method: "live-probe",
          artifact: ".capture/codex-tools",
          what:
            "PostToolUse updatedMCPToolOutput is REJECTED by the hook engine (fails open with " +
            '"PostToolUse hook returned unsupported updatedMCPToolOutput", run status Failed; ' +
            "matches upstream codex-rs hooks/src/events/post_tool_use.rs " +
            "unsupported_updated_mcp_tool_output_fails_open). tool.after.output.replace is " +
            "therefore unsupported on the hook channel; the output parser also shows the MCP " +
            "connector path (not hooks) is the only output-replacement surface.",
        },
        {
          version: "0.153.2",
          date: "2026-09-14",
          method: "live-probe",
          artifact: ".capture/codex-hook-matcher",
          what:
            "Project PreToolUse matcher is honoured for a shell call on Windows and compared against the " +
            "hook-boundary tool name (Bash, not exec_command); exact word lists and anchored regexes match, " +
            "a bare prefix does not. Non-shell tools, other tool events, MCP names, and POSIX are uncaptured.",
        },
        {
          version: "0.153.2",
          date: "2026-09-14",
          method: "live-probe",
          artifact: ".capture/codex-hook-matcher",
          what:
            "The same PreToolUse matcher probe on Linux x64 (WSL2) produced an identical dispatch table: " +
            "matched against the hook-boundary name Bash, word lists and anchored regexes match, a bare prefix does not. macOS is uncaptured.",
        },
        {
          version: "0.148.0",
          date: "2026-09-29",
          method: "live-probe",
          artifact: ".capture/agents",
          what:
            "The subagent drive under --dangerously-bypass-hook-trust, with session -c overrides and with an isolated " +
            "CODEX_HOME alike: a spawned custom agent's shell command ran and wrote its file, and no hook fired inside the " +
            "child -- no PreToolUse for it, no SubagentStart or SubagentStop. Whether persisted hook trust changes this is not " +
            "established.",
        },
      ],
      notes: ["https://learn.chatgpt.com/docs/hooks (fetched 2026-08-20)"],
    },
    fields: {
      ...codexFields,
      "tool.before.correlation.agentId": { level: "unsupported", rationale: NO_HOOK_INSIDE_A_SUBAGENT },
      "tool.after.correlation.agentId": { level: "unsupported", rationale: NO_HOOK_INSIDE_A_SUBAGENT },
    },
    matrix: {
      ...codexMatrix,
      ...Object.fromEntries(
        AGENT_IDENTITY_EVENTS.map((event) => [
          `${event}.agent.identity`,
          { level: "unsupported", rationale: NO_HOOK_INSIDE_A_SUBAGENT },
        ]),
      ),
    },
  },
  {
    range: ">=0.156.1 <1",
    source: {
      date: "2026-09-29",
      validatedOn: [
        {
          version: "0.156.1",
          date: "2026-09-27",
          method: "captured",
          artifact: ".capture/codex-code-mode",
          what:
            "Code Mode hook payloads on Windows (loopback model; tool_mode code_mode_only -- the gpt-5.6-luna catalog value -- and " +
            "code_mode): a nested tools.exec_command reaches PreToolUse and PostToolUse as Bash/{command} with tool_use_id " +
            "exec-<uuid> -- the direct call's payload shape, also with the live call's workdir/shell/yield arguments.",
        },
        {
          version: "0.156.1",
          date: "2026-09-27",
          method: "live-probe",
          artifact: ".capture/codex-code-mode",
          what:
            "Code Mode dispatch on Windows, the same drives: the model's outer exec custom tool call reached neither a catch-all " +
            "PreToolUse/PostToolUse group nor one matching exec -- an observed absence, which codex-rs source agrees with " +
            "(freeform payloads carry no hook payload) -- while the generated Bash|exec_command|shell matcher selected each nested call.",
        },
        {
          version: "0.156.1",
          date: "2026-09-27",
          method: "live-probe",
          artifact: ".capture/codex-code-mode",
          what:
            "Hook EFFECTS inside Code Mode, through the offline playback lane with a code_mode_only catalog (the model was offered exec " +
            'and no direct exec_command): a generated match: { kind: "shell" } guard, native matcher included, denied a nested ' +
            "tools.exec_command so its marker never appeared, and its input rewrite reached the spawned command.",
        },
        {
          version: "0.156.1",
          date: "2026-09-27",
          method: "live-probe",
          artifact: ".capture/codex-worktree-hooks",
          what:
            "In a linked git worktree Codex never loads the worktree's own .codex/hooks.json -- not with the worktree explicitly " +
            "trusted, not nested inside the root checkout -- and runs the root checkout's .codex/hooks.json instead, or no hooks at " +
            "all when that has none. A Codex artifact generated into a linked worktree is inert there.",
        },
        {
          version: "0.156.1",
          date: "2026-09-27",
          method: "captured",
          artifact: "fixtures/codex/0.148",
          what: "apply_patch (add, update with move, delete, multi-file) and view_image PreToolUse payloads over the loopback model (.capture/file-tools): apply_patch reaches hooks as tool_input.command holding the raw patch text, view_image as tool_input.path",
        },
        {
          version: "0.156.1",
          date: "2026-09-29",
          method: "captured",
          artifact: "fixtures/codex/0.148",
          what:
            "Subagent hook payloads over the loopback model (.capture/agents): once the parent waited on a spawned custom agent, " +
            "SubagentStart and SubagentStop fired live with agent_id and agent_type, and the child's own Bash PreToolUse/PostToolUse " +
            "carried the same identity; the parent's wait reaches hooks as multi_agent_v1wait_agent.",
        },
        {
          version: "0.156.1",
          date: "2026-09-29",
          method: "live-probe",
          artifact: ".capture/agents",
          what: "The scoped case, built for 0.156.1: a tool.before guard scoped to the spawned custom agent blocked its shell write, which never landed, and let its next command run; it never touched the parent's spawn_agent, and a guard scoped to another agent never ran. Scoped tool.after, agent.start and agent.stop hooks saw only the subagent (packages/cli/test/harness-playback.test.ts, agent-scope).",
        },
        // scheduled-playback: at most one rolling live-probe record, rewritten
        // in place by scripts/record-playback-validation.mjs (harness-watch
        // workflow). Git history is the audit trail; see ADR-0009 and
        // .capture/harness-playback/README.md. Keep field order stable.
        // scheduled-playback:begin
        {
          version: "0.158.0",
          date: "2026-09-28",
          method: "live-probe",
          artifact: ".capture/harness-playback",
          what: "scheduled model-free playback vs a newer build: artifact discovery, rewrite/block markers, and lifecycle events verified",
        },
        // scheduled-playback:end
      ],
      notes: ["https://learn.chatgpt.com/docs/hooks (fetched 2026-08-20)"],
    },
    // The child's tool payloads carry agent_id from 0.156.1, captured in
    // fixtures/codex/0.148/pre/post-tool-bash-subagent (.capture/agents).
    fields: {
      ...codexFields,
      "tool.before.correlation.agentId": { level: "exact" },
      "tool.after.correlation.agentId": { level: "exact" },
    },
    matrix: { ...codexMatrix, ...agentIdentityFrom0156 },
  },
];
