import type { CapabilityProfile } from "@hooknostic/core";

/**
 * Claude Code capability data. Non-exact levels carry rationale; per-fixture
 * provenance (captured vs doc-derived cells) lives in
 * fixtures/claude/2.1/README.md. Version facts live in `source.validatedOn`,
 * not prose.
 */
export const claudeCapabilityProfiles: CapabilityProfile[] = [
  {
    range: ">=2.0 <3",
    source: {
      date: "2026-08-29",
      validatedOn: [
        {
          version: "2.1.306",
          date: "2026-10-21",
          method: "live-probe",
          artifact: ".capture/harness-playback/claude-tool-search-306.json",
          what: "Windows loopback playback initially advertises ToolSearch without the fixture MCP schema. Searching by the scripted tool's suffix exposes its full name and schema in the next model request; the projected-plugin and fixture MCP calls then execute. Processed model-request evidence only, not a hook-payload shape change.",
        },
        {
          version: "2.1.238",
          date: "2026-10-21",
          method: "live-probe",
          artifact: ".capture/copilot/README.md",
          what: "A root .mcp.json shared with GitHub Copilot CLI: an entry with cwd ran in the project with the key ignored, disabledMcpjsonServers in .claude/settings.json kept the named server from starting, and .github/copilot/settings.json was ignored (claude-mcp-fence-probe.mjs).",
        },
        {
          version: "2.1.306",
          date: "2026-10-21",
          method: "live-probe",
          artifact: ".capture/copilot/README.md",
          what: "The same shared root .mcp.json behavior on the current build: cwd accepted and ignored, disabledMcpjsonServers honoured, Copilot's settings file ignored (claude-mcp-fence-probe.mjs).",
        },
        {
          version: "2.1.238",
          date: "2026-10-21",
          method: "live-probe",
          artifact: ".capture/copilot/README.md",
          what: "Project hook entries with a non-numeric timeoutSec (the key that makes GitHub Copilot CLI drop the file's hooks): Claude ignored the key, ran the SessionStart entry, and applied the same settings file's env (claude-tolerance-probe.mjs).",
        },
        {
          version: "2.1.306",
          date: "2026-10-21",
          method: "live-probe",
          artifact: ".capture/copilot/README.md",
          what: "The same non-numeric timeoutSec tolerance on the current build: the entry ran and the settings file's env reached it (claude-tolerance-probe.mjs).",
        },
        {
          version: "2.1.295",
          date: "2026-10-17",
          method: "live-probe",
          artifact: ".capture/harness-playback",
          what: "Windows ConPTY trust selection repaints only the cursor, with labels retained in earlier writes (claude-windows-trust-295.json). With a reconstructed terminal screen, both interactive permission denial and hook-requested approval passed against the loopback model on Node 22.22.2.",
        },
        {
          version: "2.1.238",
          date: "2026-08-20",
          method: "captured",
          artifact: "fixtures/claude/2.1",
          what: "hook payload fixtures for every observable event, captured on Windows",
        },
        {
          version: "2.1.250",
          date: "2026-08-29",
          method: "live-probe",
          artifact: ".capture/claude-output",
          what: "Stop/SubagentStop output semantics (systemMessage rendering) verified live",
        },
        {
          version: "2.1.250",
          date: "2026-08-30",
          method: "captured",
          artifact: "fixtures/claude/2.1",
          what: "PowerShell PreToolUse payload; pins that PowerShell shares Bash's command key",
        },
        {
          version: "2.1.250",
          date: "2026-09-01",
          method: "live-probe",
          artifact: "packages/cli/test/harness-playback.test.ts",
          what: "PermissionRequest deny honored end to end in an interactive pty session only when encoded as hookSpecificOutput.decision.behavior; the permissionDecision spelling is silently ignored there (matches upstream anthropics/claude-code#19298)",
        },
        {
          version: "2.1.263",
          date: "2026-09-07",
          method: "live-probe",
          artifact: ".capture/harness-playback",
          what: "Windows PTY approval probe: PreToolUse permissionDecision ask overrides preallowed Bash and requires confirmation; escalate is rejected as invalid",
        },
        {
          version: "2.1.238",
          date: "2026-09-27",
          method: "live-probe",
          artifact: ".capture/claude-permission-mode",
          what: "Interactive sessions start in the prompting mode (hook permission_mode default, PermissionRequest fires), and --permission-mode manual keeps it; an inherited CLAUDE_CODE_CHILD_SESSION turns transcript saving off",
        },
        {
          version: "2.1.283",
          date: "2026-09-27",
          method: "live-probe",
          artifact: ".capture/claude-permission-mode",
          what: "Interactive sessions start in auto mode: the scripted Bash call reaches PreToolUse with permission_mode auto and PermissionRequest never fires; --permission-mode manual restores the prompting mode and PermissionRequest, and the pty playback scenarios pass with it",
        },
        {
          version: "2.1.283",
          date: "2026-09-27",
          method: "captured",
          artifact: "fixtures/claude/2.1",
          what: "Write, Edit and NotebookEdit PreToolUse payloads over the loopback model (.capture/file-tools): Write/Edit name the path file_path, NotebookEdit notebook_path; MultiEdit is no longer advertised",
        },
        {
          version: "2.1.283",
          date: "2026-09-29",
          method: "captured",
          artifact: "fixtures/claude/2.1",
          what: "Tool payloads inside a delegated project subagent (.capture/agents): they carry agent_id and agent_type, the parent's carry neither. SubagentStart and SubagentStop fired around a child that finished, but no SubagentStop was dispatched when the child's maxTurns ended it",
        },
        {
          version: "2.1.283",
          date: "2026-09-29",
          method: "live-probe",
          artifact: ".capture/agents",
          what: "The scoped case: hooks built with agents: { include: [\"hn-probe\"] } blocked the delegated subagent's first Read and let its second through, never touched the parent's Agent call, and a guard scoped to another agent never ran; scoped tool.after, agent.start and agent.stop hooks saw the subagent's events and no others (packages/cli/test/harness-playback.test.ts, agent-scope).",
        },
        {
          version: "2.1.238",
          date: "2026-09-29",
          method: "live-probe",
          artifact: ".capture/agents",
          what: "At the reference build, the scoped case behaved the same: the subagent's guarded read was blocked, the parent's call was not, and the scoped traces saw only the subagent.",
        },
        {
          version: "2.1.283",
          date: "2026-09-29",
          method: "captured",
          artifact: "fixtures/claude/2.1",
          what: "A session started with --agent (.capture/agents primary-flag): every event carries agent_type, the agent's name, and none carries agent_id, which a subagent's events do (fixtures pre-tool-read-primary-agent, session-start-primary-agent).",
        },
        {
          version: "2.1.283",
          date: "2026-09-29",
          method: "live-probe",
          artifact: ".capture/agents",
          what: "The scoped-primary case: hooks scoped to a mode: primary definition, with the session started as it, blocked the session's own guarded read and let its next through, a guard scoped to another agent never ran, and the scoped tool.after trace named the agent (packages/cli/test/agent-definition-playback.test.ts).",
        },
        {
          version: "2.1.238",
          date: "2026-09-29",
          method: "live-probe",
          artifact: ".capture/agents",
          what: "At the reference build, the scoped-primary case behaved the same: the session's guarded read was blocked and the trace named the agent.",
        },
        // scheduled-playback: at most one rolling live-probe record, rewritten
        // in place by scripts/record-playback-validation.mjs (harness-watch
        // workflow). Git history is the audit trail; see ADR-0009 and
        // .capture/harness-playback/README.md. Keep field order stable.
        // scheduled-playback:begin
        {
          version: "2.1.310",
          date: "2026-10-26",
          method: "live-probe",
          artifact: ".capture/harness-playback",
          what: "scheduled model-free playback vs a newer build: artifact discovery, rewrite/block markers, and lifecycle events verified",
        },
        // scheduled-playback:end
        {
          version: "2.1.286",
          date: "2026-10-04",
          method: "live-probe",
          artifact: ".capture/shell-dialects",
          what: "Windows loopback shell interpreter probe: native Bash payload and executed Node process ancestry establish Git for Windows bash.exe for this configuration; PowerShell was not advertised by the discovery turn.",
        },
        {
          version: "2.1.286",
          date: "2026-10-04",
          method: "live-probe",
          artifact: ".capture/shell-dialects",
          what: "macOS loopback shell interpreter probe: captured native Bash payload and executed Node process ancestry establish /bin/bash for this GitHub runner configuration; PowerShell was not advertised by discovery.",
        },
        {
          version: "2.1.238",
          date: "2026-10-10",
          method: "live-probe",
          artifact: ".capture/shell-dialects",
          what: "Windows loopback shell interpreter probe on the reference build: the Bash tool ran Git for Windows bash.exe.",
        },
        {
          version: "2.1.295",
          date: "2026-10-10",
          method: "live-probe",
          artifact: ".capture/shell-dialects",
          what: "Linux container shell interpreter probe: Bash ran bash or zsh in nine host configurations: SHELL unset or naming bash, zsh, fish or tcsh, and CLAUDE_CODE_SHELL naming zsh, fish, tcsh or pwsh. Where the shell named was neither bash nor zsh it ran one of those two.",
        },
        {
          version: "2.1.295",
          date: "2026-10-10",
          method: "live-probe",
          artifact: ".capture/shell-dialects",
          what: "Windows loopback shell interpreter probe: with CLAUDE_CODE_USE_POWERSHELL_TOOL=1 the PowerShell tool was advertised and ran Windows powershell.exe, or pwsh.exe when that was first on PATH, under identical hook input. Bash ran Git for Windows bash.exe beside it, and also with Git removed from PATH, with ProgramFiles, ProgramFiles(x86), ProgramW6432 and LOCALAPPDATA redirected to an empty directory as well, and with CLAUDE_CODE_GIT_BASH_PATH naming a missing file, cmd.exe or powershell.exe. Establishes the dialect each tool name pins (ADR-0029); no environment on this host stood in for one without Git for Windows, which the next record covers.",
        },
        {
          version: "2.1.295",
          date: "2026-10-10",
          method: "live-probe",
          artifact: ".capture/shell-dialects",
          what: "Windows Sandbox shell interpreter probe on a host with no Git for Windows: of eight host configurations, six started, and in each PowerShell was the only shell tool advertised, without the opt-in, and ran Windows powershell.exe. That includes CLAUDE_CODE_GIT_BASH_PATH naming a missing file, cmd.exe or powershell.exe, and CLAUDE_CODE_SHELL or SHELL naming powershell.exe. The two that set CLAUDE_CODE_USE_POWERSHELL_TOOL=0 exited before any model request, reporting that Git Bash was not found. So no Bash call reaches a hook there for the posix pin to be wrong about (ADR-0029).",
        },
        {
          version: "2.1.295",
          date: "2026-10-11",
          method: "live-probe",
          artifact: ".capture/shell-dialects",
          what: "macOS runner shell interpreter recapture: with SHELL naming bash, Bash was the only shell tool advertised and ran bash, as it did on 2.1.286.",
        },
        {
          version: "2.1.296",
          date: "2026-10-11",
          method: "live-probe",
          artifact: ".capture/harness-playback",
          what: "A -p run's first model request preceded a plugin stdio MCP server's connection: it listed WaitForMcpServers and the plugin's HTTP and SSE tools, and not the stdio tool. After a WaitForMcpServers call with no arguments the next request listed it, and the server had started with the projected root, working directory and data directory. The Claude playback lane passes on this build once its model makes that call.",
        },
      ],
      notes: [
        "https://code.claude.com/docs/en/hooks (fetched 2026-08-20)",
        // What Anthropic documents for a Windows host without Git for Windows; the sandbox capture agrees.
        "https://code.claude.com/docs/en/setup and https://code.claude.com/docs/en/tools-reference (fetched 2026-10-10): the Bash tool needs Git Bash, and a Windows host without Git for Windows runs shell commands through the PowerShell tool",
      ],
    },
    // Optional event fields (ADR-0027): exactly what the captured fixtures in
    // fixtures/claude/2.1 carry. prompt_id is on every payload except
    // SessionStart; agent_id is captured on subagent lifecycle events and
    // the subagent's tool events (pre/post-tool-read-subagent, 2.1.283).
    fields: {
      "session.start.how": { level: "exact" },
      "session.end.reason": { level: "exact" },
      "session.end.correlation.turnId": { level: "exact" },
      "prompt.before.correlation.turnId": { level: "exact" },
      "tool.before.correlation.turnId": { level: "exact" },
      "tool.before.correlation.toolCallId": { level: "exact" },
      "tool.before.correlation.agentId": { level: "exact" },
      "tool.after.correlation.turnId": { level: "exact" },
      "tool.after.correlation.toolCallId": { level: "exact" },
      "tool.after.correlation.agentId": { level: "exact" },
      "tool.error.error.message": { level: "exact" },
      "tool.error.correlation.turnId": { level: "exact" },
      "tool.error.correlation.toolCallId": { level: "exact" },
      "permission.request.correlation.turnId": { level: "exact" },
      "permission.request.correlation.toolCallId": { level: "exact" },
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
    },
    matrix: {
      "session.start.observe": { level: "exact" },
      "session.start.context.add": { level: "exact" },

      "session.end.observe": { level: "exact" },

      "prompt.before.observe": { level: "exact" },
      "prompt.before.block": { level: "exact" },
      "prompt.before.context.add": { level: "exact" },

      // Claude Code exposes no per-model-request lifecycle point: no hook sits
      // between system-prompt assembly and the model request. model.request.before
      // is therefore absent entirely rather than rated unsupported -- a defined
      // .observe cell would advertise the event and require a native fixture.
      // Capability analysis rejects a hook on it first (HN202).

      "tool.before.observe": { level: "exact" },
      "tool.before.block": { level: "exact" },
      "tool.before.requestApproval": { level: "exact" },
      "tool.before.input.replace": { level: "exact" },
      "tool.before.context.add": { level: "exact" },
      // Inside a subagent the payload carries agent_type, and so does every
      // event of a session started as an agent; a plain session's carry none, so
      // a named agent is never confused with it (ADR-0035, fixtures
      // pre-tool-read-subagent, 2.1.238 and 2.1.283; .capture/agents primary-*).
      "tool.before.agent.identity": { level: "exact" },

      "tool.after.observe": { level: "exact" },
      // No documented tool_response replacement channel on PostToolUse.
      // (tool.after.output.replace intentionally absent → unsupported.)
      "tool.after.blockContinuation": {
        level: "approximate",
        rationale:
          "PostToolUse cannot block (the tool already ran, exit 2 is not honored); the reason is surfaced to the model via stderr, which usually but not deterministically stops continuation.",
      },
      "tool.after.context.add": { level: "exact" },
      "tool.after.agent.identity": { level: "exact" },

      "tool.error.observe": { level: "exact" },
      "tool.error.context.add": { level: "exact" },

      "permission.request.observe": {
        level: "exact",
        rationale:
          "fires on interactive permission prompts; headless -p sessions decide without prompting, so coverage is interactive-only.",
      },
      "permission.request.block": { level: "exact" },
      "permission.request.context.add": { level: "exact" },

      "context.compact.before.observe": { level: "exact" },
      "context.compact.before.block": { level: "exact" },
      // No context-injection channel at PreCompact → context.add unsupported.

      "context.compact.after.observe": { level: "exact" },

      "agent.start.observe": { level: "exact" },
      "agent.start.agent.identity": { level: "exact" },

      "agent.stop.observe": { level: "exact" },
      "agent.stop.prevent": { level: "exact" },
      "agent.stop.notify": { level: "exact" },
      "agent.stop.agent.identity": { level: "exact" },

      "turn.stop.observe": { level: "exact" },
      "turn.stop.prevent": { level: "exact" },
      "turn.stop.notify": { level: "exact" },
    },
  },
];
