// Driver for GitHub Copilot CLI hook captures.
//
// usage: node .capture/copilot/probe.mjs <probe> [--prompt <text>] [--keep]
//
// Each probe builds a disposable git repository under scratch/<probe>, writes
// `.github/hooks/hooknostic.json` with a teeing entry per hook event, points
// COPILOT_HOME at a private directory, and drives `copilot -p`. Raw payloads
// land in scratch/<probe>/captured/<label>.jsonl. Nothing here talks to a
// provider other than the one the environment configures for Copilot; the
// repository's capture record says which model produced each session.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEE = join(HERE, "tee.mjs");
const ROOT = resolve(HERE, "../..");

/**
 * Scratch lives outside the repository: Copilot loads repository hooks from
 * the git root, so a nested project would inherit this checkout's own hooks
 * instead of the probe's.
 */
export const SCRATCH_ROOT = join(tmpdir(), "hooknostic-copilot-capture");
export const CAPTURE_ROOT = join(HERE, "captured");

/** Hook events the adapter observes, in the camelCase spelling. */
export const CAMEL_EVENTS = [
  "sessionStart",
  "sessionEnd",
  "userPromptSubmitted",
  "userPromptTransformed",
  "preToolUse",
  "permissionRequest",
  "postToolUse",
  "postToolUseFailure",
  "preCompact",
  "agentStop",
  "subagentStart",
  "subagentStop",
  "errorOccurred",
  "notification",
];

/** The VS Code compatible (PascalCase) spelling, where one exists. */
export const PASCAL_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "PreCompact",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "ErrorOccurred",
];

function entry(captureDir, label, output, exitCode, form = "exec") {
  if (form === "command") {
    const parts = [process.execPath, TEE, captureDir, label, output ?? "", String(exitCode ?? 0)]
      .map((part) => `"${part.replaceAll('"', '\\"')}"`)
      .join(" ");
    return { type: "command", bash: parts, powershell: parts, timeoutSec: 30 };
  }
  const args = [TEE, captureDir, label, output ?? "", String(exitCode ?? 0)];
  return { type: "command", exec: process.execPath, args, timeoutSec: 30 };
}

/**
 * Probe definitions. `hooks` maps a native event name to the label and output
 * of its tee entry; `prompt` is what the session runs.
 */
const PROBES = {
  // Passive capture of every camelCase event in one session.
  "camel-lifecycle": {
    hooks: Object.fromEntries(CAMEL_EVENTS.map((event) => [event, { label: event }])),
    prompt: "Run the shell command: echo camel-lifecycle. Then reply DONE.",
  },
  // Passive capture of every PascalCase event beside the camelCase ones, to
  // establish whether both spellings fire and what each payload looks like.
  "pascal-lifecycle": {
    hooks: Object.fromEntries([
      ...CAMEL_EVENTS.map((event) => [event, { label: `camel-${event}` }]),
      ...PASCAL_EVENTS.map((event) => [event, { label: `pascal-${event}` }]),
    ]),
    prompt: "Run the shell command: echo pascal-lifecycle. Then reply DONE.",
  },
  // Tool argument shapes across the built-in file/search/web/agent tools.
  "tool-shapes": {
    hooks: { preToolUse: { label: "preToolUse" }, postToolUse: { label: "postToolUse" } },
    prompt:
      "Do these steps in order, using exactly one tool call each: " +
      "1) create a file named probe.txt containing the text hello-probe; " +
      "2) view probe.txt; " +
      "3) edit probe.txt so hello-probe becomes goodbye-probe; " +
      "4) glob for *.txt; " +
      "5) grep for goodbye in probe.txt; " +
      "6) fetch https://example.com and tell me its title. " +
      "Then reply DONE.",
  },
  // Shell tool names and arguments, including the Windows powershell tool.
  "shell-shapes": {
    hooks: { preToolUse: { label: "preToolUse" }, postToolUse: { label: "postToolUse" } },
    prompt: "Use a shell tool exactly once to run: echo shell-shapes. Then reply DONE.",
  },
  // Interpreter identity: each shell tool reports its own process path, so the
  // executing interpreter is observable by effect. `cliArgs` restricts the
  // advertised tool set where the probe needs one specific shell tool.
  "shell-interpreter-powershell": {
    hooks: { preToolUse: { label: "preToolUse" } },
    cliArgs: ["--available-tools", "powershell"],
    prompt:
      "Use the shell tool exactly once to run: " +
      "(Get-Process -Id $PID).Path; $PSVersionTable.PSVersion.ToString(); $PSHOME. Then reply DONE.",
  },
  "shell-interpreter-bash": {
    hooks: { preToolUse: { label: "preToolUse" } },
    cliArgs: ["--excluded-tools", "powershell"],
    prompt:
      "Use the bash tool exactly once to run: bash --version | head -1; command -v bash; echo BASH_VAR=$BASH. " +
      "Then reply DONE.",
  },
  // A subagent: agent.start / agent.stop payload shape and scoped fields.
  "subagent": {
    hooks: {
      subagentStart: { label: "subagentStart" },
      subagentStop: { label: "subagentStop" },
      preToolUse: { label: "preToolUse" },
      agentStop: { label: "agentStop" },
    },
    prompt:
      "Use the task tool exactly once with agent_type \"explore\" and this prompt: \"Reply with the single word PONG " +
      "and nothing else.\" Then reply DONE.",
  },
  // A model-call error: errorOccurred payload shape.
  "error-model": {
    hooks: {
      sessionStart: { label: "sessionStart" },
      errorOccurred: { label: "errorOccurred" },
      sessionEnd: { label: "sessionEnd" },
    },
    env: { COPILOT_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1" },
    prompt: "Reply ERROR-PROBE and nothing else.",
  },
  "tool-failure": {
    hooks: { preToolUse: { label: "preToolUse" }, postToolUseFailure: { label: "postToolUseFailure" } },
    prompt:
      "Use the view tool exactly once on the path does-not-exist.txt in the current directory, then reply DONE. " +
      "Do not use any other tool.",
  },
  // preToolUse deny through the documented JSON decision.
  "effect-deny-json": {
    hooks: {
      preToolUse: {
        label: "preToolUse",
        output: JSON.stringify({ permissionDecision: "deny", permissionDecisionReason: "hooknostic-capture-deny" }),
      },
    },
    prompt: "Run the shell command: echo marker-deny-json. Then reply DONE.",
  },
  // preToolUse deny through exit 2.
  "effect-deny-exit2": {
    hooks: { preToolUse: { label: "preToolUse", exitCode: 2 } },
    prompt: "Run the shell command: echo marker-deny-exit2. Then reply DONE.",
  },
  // preToolUse ask through the documented JSON decision.
  "effect-ask-json": {
    hooks: {
      preToolUse: {
        label: "preToolUse",
        output: JSON.stringify({ permissionDecision: "ask", permissionDecisionReason: "hooknostic-capture-ask" }),
      },
    },
    prompt: "Run the shell command: echo marker-ask-json. Then reply DONE.",
  },
  // preToolUse input rewrite: the rewritten command must be what runs.
  "effect-modified-args": {
    hooks: {
      preToolUse: {
        label: "preToolUse",
        output: JSON.stringify({
          permissionDecision: "allow",
          modifiedArgs: { command: "echo marker-modified-args", description: "rewritten" },
        }),
      },
    },
    prompt: "Use a shell tool exactly once to run: echo original-command. Then reply DONE.",
  },
  // sessionStart context injection: the model must repeat the token.
  "effect-session-context": {
    hooks: {
      sessionStart: {
        label: "sessionStart",
        output: JSON.stringify({ additionalContext: "hooknostic-session-context-token-7f3a" }),
      },
    },
    prompt:
      "Reply with the exact value of any token beginning hooknostic-session-context that appears in your " +
      "instructions. If none appears, reply NONE.",
  },
  // postToolUse output replacement and context injection.
  "effect-tool-after": {
    hooks: {
      postToolUse: {
        label: "postToolUse",
        output: JSON.stringify({
          modifiedResult: { resultType: "success", textResultForLlm: "hooknostic-replaced-output-9c1d" },
          additionalContext: "hooknostic-tool-context-4b2e",
        }),
      },
    },
    prompt: "Use a shell tool exactly once to run: echo real-output. Then quote its output exactly, then reply DONE.",
  },
  // agentStop block: the hook forces another turn.
  "effect-stop-block": {
    hooks: {
      agentStop: {
        label: "agentStop",
        output: JSON.stringify({ decision: "block", reason: "hooknostic-stop-block-continue: reply SECOND-TURN" }),
      },
    },
    prompt: "Reply FIRST-TURN and nothing else.",
  },
  // agentStop notification-ish output: prove which fields are consumed.
  "effect-stop-allow": {
    hooks: {
      agentStop: {
        label: "agentStop",
        output: JSON.stringify({ decision: "allow", reason: "hooknostic-stop-allow-reason" }),
      },
    },
    prompt: "Reply STOP-ALLOW and nothing else.",
  },
  // permissionRequest allow and deny.
  "effect-permission-allow": {
    hooks: {
      permissionRequest: { label: "permissionRequest", output: JSON.stringify({ behavior: "allow" }) },
    },
    prompt: "Run the shell command: echo marker-permission-allow. Then reply DONE.",
  },
  "effect-permission-deny": {
    hooks: {
      permissionRequest: {
        label: "permissionRequest",
        output: JSON.stringify({ behavior: "deny", message: "hooknostic-permission-deny" }),
      },
    },
    prompt: "Run the shell command: echo marker-permission-deny. Then reply DONE.",
  },
  // prompt.before exit-2 block attempt.
  "effect-prompt-block": {
    hooks: { userPromptSubmitted: { label: "userPromptSubmitted", exitCode: 2 } },
    prompt: "Reply PROMPT-WAS-NOT-BLOCKED and nothing else.",
  },
  // Multiple entries on one event: which output wins?
  "effect-merge": {
    hooks: {
      preToolUse: [
        {
          label: "preToolUse-first",
          output: JSON.stringify({ permissionDecision: "deny", permissionDecisionReason: "hooknostic-first-deny" }),
        },
        {
          label: "preToolUse-second",
          output: JSON.stringify({ permissionDecision: "allow", modifiedArgs: { command: "echo marker-merge" } }),
        },
      ],
    },
    prompt: "Use a shell tool exactly once to run: echo original-merge. Then reply DONE.",
  },
  // A stdio MCP server declared in the workspace `.mcp.json`: tool name and
  // whether the hook payload states the server/tool split.
  "mcp-stdio": {
    hooks: { preToolUse: { label: "preToolUse" }, postToolUse: { label: "postToolUse" } },
    files: (scratch) => ({
      "mcp-server.mjs": MCP_SERVER,
      ".mcp.json": `${JSON.stringify(
        { mcpServers: { probe: { command: process.execPath, args: [join(scratch, "mcp-server.mjs")] } } },
        null,
        2,
      )}\n`,
    }),
    prompt:
      "Use the probe_echo tool from the probe MCP server exactly once with message MCP-PROBE, then reply DONE. " +
      "Do not use any other tool.",
  },
  // A legacy Copilot plugin loaded with --plugin-dir: does its hooks.json run,
  // and does its skill load?
  "plugin-legacy": {
    hooks: { sessionStart: { label: "sessionStart" } },
    files: () => ({
      "plugin/plugin.json": PLUGIN_FILES["plugin.json"],
      "plugin/skills/probe-skill/SKILL.md": PLUGIN_FILES["skills/probe-skill/SKILL.md"],
      "plugin/hooks.json": JSON.stringify(
        {
          version: 1,
          hooks: {
            sessionStart: [
              {
                type: "command",
                exec: process.execPath,
                args: [TEE, join(CAPTURE_ROOT, "plugin-legacy"), "plugin-sessionStart", "", "0"],
              },
            ],
          },
        },
        null,
        2,
      ),
    }),
    cliArgs: (scratch) => ["--plugin-dir", join(scratch, "plugin")],
    prompt:
      "If you have a skill named probe-skill, reply with the exact probe skill token it defines. Otherwise reply NO-SKILL.",
  },
  // Whether the cross-platform `command` field is honored, with trust granted.
  "command-fallback": {
    entryForm: "command",
    hooks: { sessionStart: { label: "sessionStart" }, preToolUse: { label: "preToolUse" } },
    prompt: "Run the shell command: echo command-fallback. Then reply DONE.",
  },
  // Whether repository hooks are gated on folder trust.
  "untrusted": {
    trustFolder: false,
    hooks: { sessionStart: { label: "sessionStart" }, preToolUse: { label: "preToolUse" } },
    prompt: "Run the shell command: echo untrusted. Then reply DONE.",
  },
  // Auto-compaction: a deliberately tiny prompt-token budget and a long tool
  // output should make the runtime compact, firing preCompact.
  "compact": {
    hooks: {
      sessionStart: { label: "sessionStart" },
      preCompact: { label: "preCompact" },
      postToolUse: { label: "postToolUse" },
      agentStop: { label: "agentStop" },
      sessionEnd: { label: "sessionEnd" },
    },
    env: { COPILOT_PROVIDER_MAX_PROMPT_TOKENS: "40000", COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: "2048" },
    prompt:
      "Do these steps: 1) run a shell command that prints the text COMPACT-FILLER 20000 times, one per line; " +
      "2) run a shell command that prints the text MORE-FILLER 20000 times, one per line; " +
      "3) summarize what you have done in one sentence.",
  },
  // Where an Agent Plugins 1.0 mcp.json expands placeholders: command, args,
  // env and cwd, and whether an ambient variable stays literal.
  "plugin-mcp-places": {
    hooks: {},
    files: () => ({
      "plugin/plugin.json": `${JSON.stringify(
        {
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: "hooknostic-probe-plugin",
          description: "Capture probe",
          version: "1.0.0",
        },
        null,
        2,
      )}\n`,
      "plugin/node-copy.exe": readFileSync(process.execPath),
      "plugin/mcp-server.mjs": MCP_SERVER,
      "plugin/mcp.json": `${JSON.stringify(
        {
          $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
          mcpServers: {
            probe: {
              type: "stdio",
              command: "${PLUGIN_ROOT}/node-copy.exe",
              args: [
                "${PLUGIN_ROOT}/mcp-server.mjs",
                "--arg-root",
                "${PLUGIN_ROOT}",
                "--arg-data",
                "${PLUGIN_DATA}",
                "--arg-ambient",
                "${USERPROFILE}",
              ],
              env: {
                ROOT_COPY: "${PLUGIN_ROOT}",
                DATA_COPY: "${PLUGIN_DATA}",
                AMBIENT_COPY: "${USERPROFILE}",
              },
              cwd: "${PLUGIN_DATA}",
            },
          },
        },
        null,
        2,
      )}\n`,
    }),
    cliArgs: (scratch) => ["--plugin-dir", join(scratch, "plugin")],
    prompt:
      "Use the probe_echo MCP tool from the probe server once with message PLACES-PROBE, quote its response " +
      "verbatim, then reply DONE.",
  },
  // PascalCase payloads for the file tools: the tool_name is Claude's name and
  // the input keys may or may not match the runtime tool's.
  "pascal-tool-shapes": {
    hooks: { PreToolUse: { label: "PreToolUse" }, PostToolUse: { label: "PostToolUse" } },
    prompt:
      "Do these steps in order, using exactly one tool call each: " +
      "1) create a file named pascal-probe.txt containing pascal-hello; " +
      "2) view pascal-probe.txt; " +
      "3) edit pascal-probe.txt so pascal-hello becomes pascal-goodbye. " +
      "Then reply DONE.",
  },
  // PascalCase subagent and error events.
  "pascal-subagent": {
    hooks: {
      SubagentStart: { label: "SubagentStart" },
      SubagentStop: { label: "SubagentStop" },
      Stop: { label: "Stop" },
    },
    prompt:
      "Use the task tool exactly once with agent_type \"explore\" and this prompt: \"Reply with the single word PONG " +
      "and nothing else.\" Then reply DONE.",
  },
  // preToolUse context injection: is additionalContext honored there?
  "effect-tool-before-context": {
    hooks: {
      preToolUse: {
        label: "preToolUse",
        output: JSON.stringify({ permissionDecision: "allow", additionalContext: "hooknostic-tool-before-token-8d2f" }),
      },
    },
    prompt:
      "Run the shell command: echo before-context. Then tell me whether you received any hooknostic-tool-before " +
      "token, quoting it exactly, or reply NONE.",
  },
  // userPromptSubmitted context injection: the docs say command-hook output is
  // dropped, including modifiedPrompt; check additionalContext too.
  "effect-prompt-context": {
    hooks: {
      userPromptSubmitted: {
        label: "userPromptSubmitted",
        output: JSON.stringify({ additionalContext: "hooknostic-prompt-token-5a1c" }),
      },
    },
    prompt:
      "Reply with the exact value of any token beginning hooknostic-prompt that appears in your instructions. " +
      "If none appears, reply NONE.",
  },
  // postToolUseFailure exit 2: stdout is appended to the failure shown to the agent.
  "effect-tool-error-context": {
    hooks: {
      postToolUseFailure: {
        label: "postToolUseFailure",
        output: "hooknostic-tool-error-token-3e9b",
        exitCode: 2,
      },
    },
    prompt:
      "Use the view tool exactly once on the path missing-file.txt, then tell me the exact guidance text you " +
      "received after the failure, quoting any hooknostic-tool-error token, or reply NONE.",
  },
  // subagentStop block: does a scoped agent hook force another subagent turn?
  "effect-subagent-stop": {
    hooks: {
      subagentStop: {
        label: "subagentStop",
        output: JSON.stringify({ decision: "block", reason: "Reply SUBAGENT-SECOND-TURN and nothing else." }),
      },
    },
    prompt:
      "Use the task tool exactly once with agent_type \"explore\" and this prompt: \"Reply SUBAGENT-FIRST-TURN and " +
      "nothing else.\" Then quote the subagent's final answer and reply DONE.",
  },
  // postToolUseFailure JSON additionalContext, exit 0 (the documented output field).
  "effect-tool-error-json": {
    hooks: {
      postToolUseFailure: {
        label: "postToolUseFailure",
        output: JSON.stringify({ additionalContext: "hooknostic-tool-error-json-token-6c4a" }),
      },
    },
    prompt:
      "Use the view tool exactly once on the path missing-file.txt, then tell me the exact guidance text you " +
      "received after the failure, quoting any hooknostic-tool-error-json token, or reply NONE.",
  },
  // Skill discovery locations, invocation policy, and skill-text expansion.
  "skills-policy": {
    hooks: {},
    files: () => ({
      ".github/skills/open/SKILL.md":
        "---\nname: open\ndescription: Unrestricted probe skill.\n---\n\nWhen asked for the open skill token, reply OPEN-SKILL-TOKEN.\n",
      ".github/skills/gated/SKILL.md":
        "---\nname: gated\ndescription: Probe skill withheld from automatic selection.\ndisable-model-invocation: true\n---\n\nWhen asked for the gated skill token, reply GATED-SKILL-TOKEN.\n",
      ".agents/skills/alt/SKILL.md":
        "---\nname: alt\ndescription: Probe skill in the portable agents directory.\n---\n\nWhen asked for the alt skill token, reply ALT-SKILL-TOKEN.\n",
    }),
    prompt:
      "List every skill name available to you, with its exact token if it has one. If a skill has no token, say none. " +
      "Do not use any tool.",
  },
  "skills-text": {
    hooks: {},
    files: () => ({
      ".agents/skills/dirprobe/SKILL.md":
        "---\nname: dirprobe\ndescription: Probe skill quoting path variables.\n---\n\nReply with the exact contents of this " +
        "line, character for character: TOKEN=${SKILL_DIR} ROOT=${PLUGIN_ROOT} DATA=${PLUGIN_DATA} SESSION=$CLAUDE_SESSION_ID\n",
    }),
    prompt: "Load the dirprobe skill and quote its TOKEN= line exactly, then reply DONE.",
  },
  "project-mcp-places": {
    hooks: { preToolUse: { label: "preToolUse" } },
    files: (scratch) => {
      mkdirSync(join(scratch, "sub"), { recursive: true });
      return {
        "mcp-server.mjs": MCP_SERVER,
        ".mcp.json": `${JSON.stringify(
          {
            mcpServers: {
              probe: {
                type: "stdio",
                command: process.execPath,
                args: [join(scratch, "mcp-server.mjs"), "--arg-ambient", "${USERPROFILE}"],
                env: { ROOT_COPY: "${PLUGIN_ROOT}", AMBIENT_COPY: "${USERPROFILE}" },
                cwd: join(scratch, "sub"),
              },
            },
          },
          null,
          2,
        )}\n`,
      };
    },
    prompt:
      "Use the probe_echo MCP tool from the probe server once with message PROJECT-PLACES, quote its response " +
      "verbatim, then reply DONE.",
  },
  "plugin-agent": {
    hooks: { sessionStart: { label: "sessionStart" } },
    files: () => ({
      "plugin/plugin.json": `${JSON.stringify(
        {
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: "hooknostic-probe-plugin",
          description: "Capture probe",
          version: "1.0.0",
        },
        null,
        2,
      )}\n`,
      "plugin/skills/probe-skill/SKILL.md": PLUGIN_FILES["skills/probe-skill/SKILL.md"],
      "plugin/mcp-server.mjs": MCP_SERVER,
      "plugin/mcp.json": `${JSON.stringify(
        {
          $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
          mcpServers: {
            probe: { type: "stdio", command: process.execPath, args: ["${PLUGIN_ROOT}/mcp-server.mjs"] },
          },
        },
        null,
        2,
      )}\n`,
      "plugin/com.github.copilot/hooks/hooks.json": JSON.stringify(
        {
          version: 1,
          hooks: {
            sessionStart: [
              {
                type: "command",
                exec: process.execPath,
                args: [TEE, join(CAPTURE_ROOT, "plugin-agent"), "plugin-sessionStart", "", "0"],
              },
            ],
          },
        },
        null,
        2,
      ),
    }),
    cliArgs: (scratch) => ["--plugin-dir", join(scratch, "plugin")],
    prompt:
      "Do both of these, then reply DONE: 1) if you have a skill named probe-skill, use it and report its exact " +
      "probe token; 2) use the probe_echo MCP tool from the probe server once with message AGENT-PROBE. " +
      "If a thing is missing, say MISSING for that step.",
  },
  // `${NAME:-fallback}` in a stdio declaration, one field per server so an
  // unresolved command or cwd cannot hide the other fields' result. The
  // startup log is the evidence; the session only has to start.
  "plugin-mcp-stdio-fallback": {
    hooks: {},
    env: {
      HOOKNOSTIC_PROBE_SET: "set-value",
      HOOKNOSTIC_PROBE_SUB: "fallback-cwd",
      HOOKNOSTIC_PROBE_NODE: process.execPath,
      HOOKNOSTIC_PROBE_DIR: join(SCRATCH_ROOT, "plugin-mcp-stdio-fallback", "plugin", "fallback-cwd"),
    },
    files: (scratch) => {
      mkdirSync(join(scratch, "plugin", "fallback-cwd"), { recursive: true });
      mkdirSync(join(scratch, "plugin", "$PLUGIN_DATA"), { recursive: true });
      const log = join(CAPTURE_ROOT, "plugin-mcp-stdio-fallback", "mcp-startup.jsonl");
      return {
        "plugin/plugin.json": AGENT_PLUGIN_MANIFEST,
        [`plugin/node-copy${process.platform === "win32" ? ".exe" : ""}`]: readFileSync(process.execPath),
        "plugin/mcp-server.mjs": MCP_SERVER,
        "plugin/mcp.json": stdioFallbackServers(join(scratch, "plugin"), "${PLUGIN_ROOT}/mcp-server.mjs", log),
      };
    },
    cliArgs: (scratch) => ["--plugin-dir", join(scratch, "plugin")],
    prompt: "Reply FALLBACK-PROBE and nothing else. Do not use any tool.",
  },
  "project-mcp-stdio-fallback": {
    hooks: {},
    env: {
      HOOKNOSTIC_PROBE_SET: "set-value",
      HOOKNOSTIC_PROBE_SUB: "fallback-cwd",
      HOOKNOSTIC_PROBE_NODE: process.execPath,
      HOOKNOSTIC_PROBE_DIR: join(SCRATCH_ROOT, "project-mcp-stdio-fallback", "fallback-cwd"),
    },
    files: (scratch) => {
      mkdirSync(join(scratch, "fallback-cwd"), { recursive: true });
      const log = join(CAPTURE_ROOT, "project-mcp-stdio-fallback", "mcp-startup.jsonl");
      return {
        "mcp-server.mjs": MCP_SERVER,
        ".github/mcp.json": stdioFallbackServers(scratch, join(scratch, "mcp-server.mjs"), log),
      };
    },
    prompt: "Reply FALLBACK-PROBE and nothing else. Do not use any tool.",
  },
  // Malformed entries in a repository hook file, beside well-formed ones: is a
  // bad item dropped alone, or does it take the file (or its event) with it?
  "hooks-malformed": {
    hooks: {},
    files: () => malformedHookFiles(join(CAPTURE_ROOT, "hooks-malformed"), ".github/hooks/"),
    prompt: "Reply MALFORMED-PROBE and nothing else. Do not use any tool.",
  },
  // The same question for an Agent Plugins package's com.github.copilot hooks:
  // one plugin with item-level faults, one with a structural fault.
  "plugin-hooks-malformed": {
    hooks: {},
    files: () => {
      const files = malformedHookFiles(join(CAPTURE_ROOT, "plugin-hooks-malformed"), "");
      return {
        "item-plugin/plugin.json": AGENT_PLUGIN_MANIFEST.replace("hooknostic-probe-plugin", "hooknostic-item-plugin"),
        "item-plugin/com.github.copilot/hooks/hooks.json": files["malformed.json"],
        "structural-plugin/plugin.json": AGENT_PLUGIN_MANIFEST.replace(
          "hooknostic-probe-plugin",
          "hooknostic-structural-plugin",
        ),
        "structural-plugin/com.github.copilot/hooks/hooks.json": files["structural.json"],
      };
    },
    cliArgs: (scratch) => [
      "--plugin-dir",
      join(scratch, "item-plugin"),
      "--plugin-dir",
      join(scratch, "structural-plugin"),
    ],
    prompt: "Reply MALFORMED-PROBE and nothing else. Do not use any tool.",
  },
  // Which entry shapes a plugin hooks.json accepts. One plugin per candidate,
  // each beside a teeing sibling: a fault rejects that plugin's whole file, so
  // the sibling fires only when the candidate is valid.
  "plugin-hooks-valid-shapes": {
    hooks: {},
    files: () => {
      const captured = join(CAPTURE_ROOT, "plugin-hooks-valid-shapes");
      const files = {};
      for (const [name, candidate] of Object.entries(pluginHookCandidates(captured))) {
        files[`${name}/plugin.json`] = AGENT_PLUGIN_MANIFEST.replace("hooknostic-probe-plugin", `hooknostic-${name}`);
        files[`${name}/com.github.copilot/hooks/hooks.json`] = `${JSON.stringify(
          {
            version: 1,
            hooks: {
              [candidate.event ?? "sessionStart"]: [
                candidate.entry,
                { type: "command", exec: process.execPath, args: [TEE, captured, `${name}-sibling`, "", "0"] },
              ],
            },
          },
          null,
          2,
        )}\n`;
      }
      return files;
    },
    cliArgs: (scratch) =>
      Object.keys(pluginHookCandidates("")).flatMap((name) => ["--plugin-dir", join(scratch, name)]),
    prompt: "Reply SHAPES-PROBE and nothing else. Do not use any tool.",
  },
  // The notification event: a background shell's completion should raise
  // notification_type shell_completed. Linux `bash` tool names (read_bash).
  "notification-async-shell": {
    hooks: {
      notification: { label: "notification" },
      postToolUse: { label: "postToolUse" },
      agentStop: { label: "agentStop" },
    },
    prompt:
      "Use the bash tool once in async (background) mode to run: sleep 3; echo hooknostic-async-done. " +
      "Then use read_bash on that shell, waiting up to 20 seconds, until it has finished. Then reply DONE.",
  },
  // The background shell finishes while the agent is busy in a second command.
  "notification-shell-while-busy": {
    hooks: { notification: { label: "notification" }, agentStop: { label: "agentStop" } },
    prompt:
      "Use the bash tool in async (background) mode to run: sleep 2; echo hooknostic-async-done. Do not read it. " +
      "Then use the bash tool normally (not async) to run: sleep 12; echo busy-done. Then reply DONE.",
  },
  // A background subagent's completion: notification_type agent_completed.
  "notification-background-agent": {
    hooks: { notification: { label: "notification" }, agentStop: { label: "agentStop" } },
    prompt:
      'Use the task tool once with agent_type "explore", mode "background", and the prompt "Reply PONG and nothing ' +
      'else." Then use the bash tool to run: sleep 15; echo waited. Then reply DONE.',
  },
  // A user-facing message on stop: is systemMessage shown, on either stop event?
  "effect-stop-system-message": {
    hooks: {
      agentStop: {
        label: "agentStop",
        output: JSON.stringify({ systemMessage: "hooknostic-stop-system-9f2e" }),
      },
      subagentStop: {
        label: "subagentStop",
        output: JSON.stringify({ systemMessage: "hooknostic-subagent-system-4d1a" }),
      },
    },
    prompt:
      "Use the task tool exactly once with agent_type \"explore\" and this prompt: \"Reply PONG and nothing else.\" " +
      "Then reply DONE.",
  },
  // postToolUse continuation control: decision block, then continue:false.
  "effect-tool-after-block": {
    hooks: {
      preToolUse: { label: "preToolUse" },
      postToolUse: {
        label: "postToolUse",
        output: JSON.stringify({ decision: "block", reason: "hooknostic-after-block-reason-1b7d" }),
      },
      agentStop: { label: "agentStop" },
    },
    prompt:
      "Run the shell command: echo after-block-one. Then run the shell command: echo after-block-two. " +
      "Then reply DONE, quoting any hooknostic-after-block token you received, or NONE.",
  },
  // Sequential calls: does a blocked first result stop the agent from making
  // the second?
  "effect-tool-after-block-sequential": {
    hooks: {
      preToolUse: { label: "preToolUse" },
      postToolUse: {
        label: "postToolUse",
        output: JSON.stringify({
          decision: "block",
          reason: "Policy stop: do not run any more tools. Reply HALTED and end your turn.",
        }),
      },
      agentStop: { label: "agentStop" },
    },
    prompt:
      "Do these one at a time, waiting for each result before starting the next: run the shell command " +
      "echo step-one; then run the shell command echo step-two; then run the shell command echo step-three. " +
      "Then reply DONE.",
  },
  // additionalContext beside a postToolUse block: delivered, or dropped?
  "effect-tool-after-block-context": {
    hooks: {
      postToolUse: {
        label: "postToolUse",
        output: JSON.stringify({
          decision: "block",
          reason: "hooknostic-after-block-reason-1b7d",
          additionalContext: "hooknostic-after-block-context-7d2a",
        }),
      },
    },
    prompt:
      "Run the shell command: echo block-context. Then quote every token beginning hooknostic- that you " +
      "received, or reply NONE.",
  },
  // userPromptSubmitted modifiedPrompt: the docs say config-file output is dropped.
  "effect-prompt-modified": {
    hooks: {
      userPromptSubmitted: {
        label: "userPromptSubmitted",
        output: JSON.stringify({ modifiedPrompt: "Reply with exactly MODIFIED-PROMPT-4b9d and nothing else." }),
      },
    },
    prompt: "Reply ORIGINAL-PROMPT and nothing else.",
  },
  "effect-tool-after-continue": {
    hooks: {
      preToolUse: { label: "preToolUse" },
      postToolUse: {
        label: "postToolUse",
        output: JSON.stringify({ continue: false, stopReason: "hooknostic-after-stop-reason-2c8e" }),
      },
      agentStop: { label: "agentStop" },
    },
    prompt:
      "Run the shell command: echo after-continue-one. Then run the shell command: echo after-continue-two. " +
      "Then reply DONE, quoting any hooknostic-after-stop token you received, or NONE.",
  },
  // userPromptTransformed: the documented modifiedTransformedPrompt, and
  // whether additionalContext or a block is honoured there.
  "effect-prompt-transformed": {
    hooks: {
      userPromptTransformed: {
        label: "userPromptTransformed",
        output: JSON.stringify({ modifiedTransformedPrompt: "Reply with exactly TRANSFORMED-PROMPT-7e3a and nothing else." }),
      },
    },
    prompt: "Reply ORIGINAL-PROMPT and nothing else.",
  },
  "effect-prompt-transformed-context": {
    hooks: {
      userPromptTransformed: {
        label: "userPromptTransformed",
        output: JSON.stringify({ additionalContext: "hooknostic-transformed-token-3f6b" }),
      },
    },
    prompt:
      "Reply with the exact value of any token beginning hooknostic-transformed that appears in your instructions. " +
      "If none appears, reply NONE.",
  },
  "effect-prompt-transformed-block": {
    hooks: {
      userPromptTransformed: {
        label: "userPromptTransformed",
        output: JSON.stringify({ decision: "block", reason: "hooknostic-transformed-block" }),
        exitCode: 2,
      },
      agentStop: { label: "agentStop" },
    },
    prompt: "Reply PROMPT-WAS-NOT-BLOCKED and nothing else.",
  },
  // userPromptSubmitted JSON block (exit 0), beside the captured exit-2 form.
  "effect-prompt-block-json": {
    hooks: {
      userPromptSubmitted: {
        label: "userPromptSubmitted",
        output: JSON.stringify({ decision: "block", reason: "hooknostic-prompt-block-json" }),
      },
      agentStop: { label: "agentStop" },
    },
    prompt: "Reply PROMPT-WAS-NOT-BLOCKED and nothing else.",
  },
  // permissionRequest: does additionalContext beside an allow reach the model?
  "effect-permission-context": {
    hooks: {
      permissionRequest: {
        label: "permissionRequest",
        output: JSON.stringify({ behavior: "allow", additionalContext: "hooknostic-permission-token-5e2c" }),
      },
    },
    prompt:
      "Run the shell command: echo marker-permission-context. Then tell me whether you received any " +
      "hooknostic-permission token, quoting it exactly, or reply NONE.",
  },
};

const AGENT_PLUGIN_MANIFEST = `${JSON.stringify(
  {
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "hooknostic-probe-plugin",
    description: "Capture probe",
    version: "1.0.0",
  },
  null,
  2,
)}\n`;

function stdioFallbackServers(base, serverPath, log) {
  return `${JSON.stringify(
    {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        // A missing variable's fallback is the real executable.
        cmd: {
          type: "stdio",
          command: `\${HOOKNOSTIC_PROBE_MISSING:-${process.execPath}}`,
          args: [serverPath, ...startupLog(log, "cmd")],
        },
        vals: {
          type: "stdio",
          command: process.execPath,
          args: [
            serverPath,
            ...startupLog(log, "vals"),
            "--arg-fallback",
            "${HOOKNOSTIC_PROBE_MISSING:-fallback-arg}",
            "--arg-set",
            "${HOOKNOSTIC_PROBE_SET:-fallback-arg}",
            "--arg-bare",
            "$HOOKNOSTIC_PROBE_SET",
            "--arg-percent",
            "%HOOKNOSTIC_PROBE_SET%",
            "--arg-bare-root",
            "$PLUGIN_ROOT",
            "--arg-bare-missing",
            "$HOOKNOSTIC_PROBE_MISSING",
            "--arg-bare-embedded",
            "x$HOOKNOSTIC_PROBE_SET-y",
            "--arg-alias-fallback",
            "${PLUGIN_ROOT:-fallback-root}",
          ],
          env: {
            FALLBACK_COPY: "${HOOKNOSTIC_PROBE_MISSING:-fallback-env}",
            SET_COPY: "${HOOKNOSTIC_PROBE_SET:-fallback-env}",
            BARE_COPY: "$HOOKNOSTIC_PROBE_SET",
            PERCENT_COPY: "%HOOKNOSTIC_PROBE_SET%",
          },
        },
        dir: {
          type: "stdio",
          command: process.execPath,
          args: [serverPath, ...startupLog(log, "dir")],
          cwd: `\${HOOKNOSTIC_PROBE_MISSING:-${join(base, "fallback-cwd")}}`,
        },
        // cwd controls: the same directory written literally, relatively, and
        // through a set ambient variable (HOOKNOSTIC_PROBE_DIR).
        dirliteral: {
          type: "stdio",
          command: process.execPath,
          args: [serverPath, ...startupLog(log, "dirliteral")],
          cwd: join(base, "fallback-cwd"),
        },
        dirrelative: {
          type: "stdio",
          command: process.execPath,
          args: [serverPath, ...startupLog(log, "dirrelative")],
          cwd: "fallback-cwd",
        },
        dirset: {
          type: "stdio",
          command: process.execPath,
          args: [serverPath, ...startupLog(log, "dirset")],
          cwd: "${HOOKNOSTIC_PROBE_DIR}",
        },
        // The package aliases as a cwd, for the plugin route.
        dirroot: {
          type: "stdio",
          command: process.execPath,
          args: [serverPath, ...startupLog(log, "dirroot")],
          cwd: "${PLUGIN_ROOT}/fallback-cwd",
        },
        dirdata: {
          type: "stdio",
          command: process.execPath,
          args: [serverPath, ...startupLog(log, "dirdata")],
          cwd: "${PLUGIN_DATA}",
        },
        // The spec's ./ form, and ambient references inside an alias-rooted cwd.
        dirdot: {
          type: "stdio",
          command: process.execPath,
          args: [serverPath, ...startupLog(log, "dirdot")],
          cwd: "./fallback-cwd",
        },
        dirrootset: {
          type: "stdio",
          command: process.execPath,
          args: [serverPath, ...startupLog(log, "dirrootset")],
          cwd: "${PLUGIN_ROOT}/${HOOKNOSTIC_PROBE_SUB}",
        },
        dirrootfallback: {
          type: "stdio",
          command: process.execPath,
          args: [serverPath, ...startupLog(log, "dirrootfallback")],
          cwd: "${PLUGIN_ROOT}/${HOOKNOSTIC_PROBE_MISSING:-fallback-cwd}",
        },
        // The bare $NAME form in command and in an alias-rooted cwd.
        cmdbare: {
          type: "stdio",
          command: "$HOOKNOSTIC_PROBE_NODE",
          args: [serverPath, ...startupLog(log, "cmdbare")],
        },
        dirrootbare: {
          type: "stdio",
          command: process.execPath,
          args: [serverPath, ...startupLog(log, "dirrootbare")],
          cwd: "${PLUGIN_ROOT}/$HOOKNOSTIC_PROBE_SUB",
        },
        // A bare package alias. The cwd's literal directory exists, so an
        // unexpanded value runs there and an expanded one does not.
        dirbarealias: {
          type: "stdio",
          command: process.execPath,
          args: [serverPath, ...startupLog(log, "dirbarealias")],
          cwd: "${PLUGIN_ROOT}/$PLUGIN_DATA",
        },
        envbarealias: {
          type: "stdio",
          command: process.execPath,
          args: [serverPath, ...startupLog(log, "envbarealias")],
          env: { BAREROOT_COPY: "$PLUGIN_ROOT", BAREDATA_COPY: "$PLUGIN_DATA" },
        },
        cmdbarealias: {
          type: "stdio",
          command: `$PLUGIN_ROOT/node-copy${process.platform === "win32" ? ".exe" : ""}`,
          args: [serverPath, ...startupLog(log, "cmdbarealias")],
        },
      },
    },
    null,
    2,
  )}\n`;
}

function pluginHookCandidates(captured) {
  const exec = (label, extra = {}) => ({
    type: "command",
    exec: process.execPath,
    args: [TEE, captured, label, "", "0"],
    ...extra,
  });
  return {
    "shape-control": { entry: exec("shape-control") },
    "shape-no-type": { entry: { exec: process.execPath, args: [TEE, captured, "shape-no-type", "", "0"] } },
    "shape-exec-no-args": { entry: { type: "command", exec: process.execPath } },
    "shape-exec-options": {
      entry: exec("shape-exec-options", { cwd: ".", env: { PROBE: "1" }, timeoutSec: 10 }),
    },
    "shape-timeout-alias": { entry: exec("shape-timeout-alias", { timeout: 10 }) },
    "shape-matcher": { entry: exec("shape-matcher", { matcher: "startup|new" }) },
    "shape-bad-matcher": { entry: exec("shape-bad-matcher", { matcher: "(" }) },
    "shape-unknown-field": { entry: exec("shape-unknown-field", { probeUnknown: true }) },
    "shape-shells": { entry: { type: "command", bash: "exit 0", powershell: "exit 0" } },
    "shape-bash-only": { entry: { type: "command", bash: "exit 0" } },
    "shape-powershell-only": { entry: { type: "command", powershell: "exit 0" } },
    "shape-command": { entry: { type: "command", command: "exit 0" } },
    "shape-prompt": { entry: { type: "prompt", prompt: "Reply SHAPES-PROBE and nothing else." } },
    "shape-http": { entry: { type: "http", url: "http://127.0.0.1:9/hook" } },
  };
}

function malformedHookFiles(captured, prefix) {
  const args = (label) => [TEE, captured, label, "", "0"];
  const tee = (label) => ({ type: "command", exec: process.execPath, args: args(label) });
  const file = (value) => `${JSON.stringify(value, null, 2)}\n`;
  return {
    [`${prefix}malformed.json`]: file({
      version: 1,
      hooks: {
        sessionStart: [
          42,
          "text",
          null,
          {},
          { type: "command" },
          { type: "command", args: args("no-exec") },
          { type: "bogus", exec: process.execPath, args: args("unknown-type") },
          { exec: process.execPath, args: args("no-type") },
          { type: "command", exec: process.execPath, args: args("string-timeout"), timeoutSec: "soon" },
          { type: "command", exec: process.execPath, args: "not-an-array" },
          { type: "command", exec: process.execPath, bash: "exit 0", args: args("exec-and-shell") },
          { type: "http" },
          { type: "prompt" },
          { type: "command", exec: process.execPath, args: [TEE, captured, 7, "", "0"] },
          { type: "command", exec: process.execPath, args: args("string-env"), env: "PROBE=1" },
          { type: "command", exec: process.execPath, args: args("number-env-value"), env: { PROBE: 1 } },
          { type: "command", exec: process.execPath, args: args("number-cwd"), cwd: 5 },
          { type: "command", exec: process.execPath, args: args("number-matcher"), matcher: 5 },
          { type: "command", exec: 42, args: args("number-exec") },
          { type: "command", bash: 42 },
          { type: "command", bash: "exit 0", env: "PROBE=1" },
          { type: "command", bash: "exit 0", cwd: 5 },
          { type: "command", bash: "exit 0", timeoutSec: "soon" },
          { type: "command", bash: "exit 0", timeout: "soon" },
          tee("valid-after-malformed"),
        ],
        agentStop: [{ type: "prompt", prompt: "Reply PROMPT-HOOK." }, tee("malformed-file-agentStop")],
        preToolUse: [{ type: "http", url: "http://example.invalid/hook" }],
      },
    }),
    [`${prefix}structural.json`]: file({
      version: 1,
      hooks: { sessionStart: { not: "an array" }, agentStop: [tee("structural-sibling-agentStop")] },
    }),
    [`${prefix}bad-version.json`]: file({ version: 2, hooks: { agentStop: [tee("bad-version-agentStop")] } }),
    [`${prefix}unknown-event.json`]: file({
      version: 1,
      hooks: { notAnEvent: [tee("unknown-event")], agentStop: [tee("unknown-event-sibling-agentStop")] },
    }),
  };
}

// A stdio server's launch, as Copilot spawned it: argv, cwd, and the *_COPY
// environment values, appended to the path after `--startup-log` before any
// MCP traffic. A server whose command or cwd did not resolve never writes one.
const startupLog = (path, label) => ["--startup-log", path, "--label", label];

const MCP_SERVER = `import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const logAt = process.argv.indexOf("--startup-log");
if (logAt !== -1) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.endsWith("_COPY")));
  appendFileSync(process.argv[logAt + 1], JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env }) + "\\n");
}
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const tools = [
  {
    name: "probe_echo",
    description: "Echo a message back, with the server's cwd and argv for capture.",
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
  },
];
createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return;
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1.0.0" } } });
  } else if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools } });
  } else if (request.method === "tools/call") {
    const message = request.params?.arguments?.message ?? "(none)";
    send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "mcp-echo:" + message + "|cwd=" + process.cwd() + "|argv=" + process.argv.slice(2).join(",") + "|root=" + (process.env.PLUGIN_ROOT ?? "") + "|data=" + (process.env.PLUGIN_DATA ?? "") + "|root_copy=" + (process.env.ROOT_COPY ?? "") + "|data_copy=" + (process.env.DATA_COPY ?? "") + "|ambient_copy=" + (process.env.AMBIENT_COPY ?? "") }] } });
  } else if (request.id !== undefined) {
    send({ jsonrpc: "2.0", id: request.id, result: {} });
  }
});
`;

const PLUGIN_FILES = {
  "plugin.json": `{\n  "name": "hooknostic-probe-plugin",\n  "description": "Capture probe",\n  "version": "1.0.0",\n  "skills": "skills/"\n}\n`,
  "skills/probe-skill/SKILL.md": `---\nname: probe-skill\ndescription: Answers the probe question with PROBE-SKILL-LOADED.\n---\n\nWhen asked for the probe skill token, reply exactly PROBE-SKILL-LOADED.\n`,
};

function resolveCopilotBinary() {

  if (process.env.COPILOT_BINARY !== undefined) return process.env.COPILOT_BINARY;
  const packageName = `@github/copilot-${process.platform}-${process.arch}`;
  const executable = process.platform === "win32" ? "copilot.exe" : "copilot";
  const roots = [];
  if (process.platform === "win32" && process.env.APPDATA !== undefined) {
    roots.push(join(process.env.APPDATA, "npm", "node_modules"));
  }
  try {
    roots.push(execFileSync("npm", ["root", "-g"], { encoding: "utf8", shell: true }).trim());
  } catch {
    // npm may not be spawnable without a shell; the platform root above covers it.
  }
  for (const root of roots) {
    const candidate = join(root, "@github", "copilot", "node_modules", ...packageName.split("/"), executable);
    if (existsSync(candidate)) return candidate;
  }
  return process.platform === "win32" ? "copilot.cmd" : "copilot";
}

function parseArgs(argv) {
  const probe = argv[0];
  const options = { probe, prompt: undefined, keep: false };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--prompt") options.prompt = argv[++i];
    else if (argv[i] === "--keep") options.keep = true;
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const probe = PROBES[options.probe];
  if (probe === undefined) {
    console.error(`unknown probe "${options.probe}"; known: ${Object.keys(PROBES).join(", ")}`);
    process.exit(2);
  }
  const scratch = join(SCRATCH_ROOT, options.probe);
  if (!options.keep) rmSync(scratch, { recursive: true, force: true });
  const captured = join(CAPTURE_ROOT, options.probe);
  rmSync(captured, { recursive: true, force: true });
  mkdirSync(join(scratch, ".github", "hooks"), { recursive: true });
  mkdirSync(join(scratch, ".copilot-home"), { recursive: true });
  mkdirSync(captured, { recursive: true });

  const hooks = {};
  for (const [event, spec] of Object.entries(probe.hooks)) {
    const specs = Array.isArray(spec) ? spec : [spec];
    hooks[event] = specs.map((item) => entry(captured, item.label, item.output, item.exitCode, probe.entryForm));
  }
  writeFileSync(join(scratch, ".github", "hooks", "hooknostic.json"), `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`);
  writeFileSync(join(scratch, "README.md"), "# copilot capture probe\n");
  const files = typeof probe.files === "function" ? probe.files(scratch) : (probe.files ?? {});
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(scratch, path)), { recursive: true });
    writeFileSync(join(scratch, path), contents);
  }

  execFileSync("git", ["init", "-q"], { cwd: scratch });
  execFileSync("git", ["add", "-A"], { cwd: scratch });
  execFileSync("git", ["-c", "user.email=capture@example.invalid", "-c", "user.name=capture", "commit", "-qm", "probe"], {
    cwd: scratch,
  });

  const prompt = options.prompt ?? probe.prompt;
  const cliArgs = typeof probe.cliArgs === "function" ? probe.cliArgs(scratch) : (probe.cliArgs ?? []);
  const result = spawnSync(
    resolveCopilotBinary(),
    [
      ...(probe.trustFolder === false ? [] : ["--trust-folder"]),
      "--allow-all-tools",
      "--disable-client-telemetry",
          "--no-auto-update",
      ...cliArgs,
      "-p",
      prompt,
    ],
    {
      cwd: scratch,
      env: { ...process.env, ...(probe.env ?? {}), COPILOT_HOME: join(scratch, ".copilot-home") },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error !== undefined) console.error(result.error);
  writeFileSync(join(scratch, "session.stdout.txt"), result.stdout ?? "");
  writeFileSync(join(scratch, "session.stderr.txt"), result.stderr ?? "");
  const labels = readdirSync(captured).sort();
  console.log(`probe=${options.probe} exit=${result.status} captured=${labels.join(",") || "(none)"}`);
  console.log(`stdout: ${(result.stdout ?? "").trim().slice(-1200)}`);
  if ((result.stderr ?? "").trim() !== "") console.log(`stderr: ${(result.stderr ?? "").trim().slice(-1200)}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}

export { PROBES, resolveCopilotBinary, ROOT };




