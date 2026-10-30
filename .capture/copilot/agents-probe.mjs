// Driver for GitHub Copilot CLI custom-agent captures.
//
// usage: node .capture/copilot/agents-probe.mjs [--write]
//
// Creates a disposable project and two `--plugin-dir` packages, then asks the
// CLI for each agent by ID, by frontmatter name, from a plugin and from Claude's
// `.claude/agents` directory. Positive cases make a real model request through
// whatever provider COPILOT_PROVIDER_* configures (the owner uses a free BYOK
// endpoint); negative cases fail before a request. No credential is written
// here: the provider environment is supplied by the caller.
//
// The session event log is the record. A positive run must show
// `subagent.selected` with the expected agentName and tools, and the reply must
// contain the instruction token. `--write` stores a curated JSON record under
// `.capture/copilot/evidence/`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCopilotBinary, SCRATCH_ROOT } from "./probe.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(HERE, "evidence", "agents-1.0.102.json");
const ROOT = join(SCRATCH_ROOT, "agents");
const PROJECT = join(ROOT, "project");
const PLUGIN_ROOT = join(ROOT, "plugin-root");
const PLUGIN_NS = join(ROOT, "plugin-namespace");
const HOME = join(ROOT, "home");

const write = (base, path, contents) => {
  mkdirSync(dirname(join(base, path)), { recursive: true });
  writeFileSync(join(base, path), contents);
};

const agentFile = (name, token, extra = "") => `---
name: ${name}
description: Probe agent ${name}.
tools: ["read"]
${extra}---
Reply with exactly ${token}.
`;

const manifest = (name) => `${JSON.stringify({ name, version: "1.0.0", description: "agent probe" }, null, 2)}\n`;

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });

// Project agents: the `.agent.md` spelling, the legacy `.md` spelling, a
// same-ID Claude copy, a malformed file with no frontmatter, and a name that
// differs from its file stem.
write(PROJECT, ".github/agents/probe.agent.md", agentFile("probe-agent", "TOKEN-PROJECT-ID"));
write(PROJECT, ".github/agents/legacy.md", agentFile("legacy", "TOKEN-LEGACY"));
write(PROJECT, ".github/agents/shared.agent.md", agentFile("shared", "TOKEN-COPILOT"));
write(PROJECT, ".claude/agents/shared.md", agentFile("shared", "TOKEN-CLAUDE"));
write(PROJECT, ".claude/agents/foreign.md", agentFile("foreign", "TOKEN-FOREIGN"));
write(PROJECT, ".github/agents/malformed.md", "No frontmatter.\n");

// A package agent is loaded from the plugin root's agents/ directory under
// <plugin>:<name>; the client-extension namespace's agents/ tree is not.
write(PLUGIN_ROOT, "plugin.json", manifest("hooknostic-agents-probe"));
write(PLUGIN_ROOT, "agents/pkg.agent.md", agentFile("pkg", "TOKEN-PACKAGE"));
write(PLUGIN_NS, "plugin.json", manifest("hooknostic-agents-ns"));
write(PLUGIN_NS, "com.github.copilot/agents/ns.agent.md", agentFile("ns", "TOKEN-NAMESPACE"));

function sessionIds() {
  const state = join(HOME, "session-state");
  return existsSync(state) ? readdirSync(state) : [];
}

function sessionEvents(ids) {
  const state = join(HOME, "session-state");
  return ids.flatMap((name) => {
    const log = join(state, name, "events.jsonl");
    if (!existsSync(log)) return [];
    return readFileSync(log, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  });
}

function run(label, args, expected) {
  const before = new Set(sessionIds());
  const result = spawnSync(resolveCopilotBinary(), ["--no-auto-update", "--trust-folder", "--allow-all-tools", ...args], {
    cwd: PROJECT,
    env: { ...process.env, COPILOT_HOME: HOME },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  const selected = sessionEvents(sessionIds().filter((id) => !before.has(id)))
    .filter((event) => event.type === "subagent.selected")
    .map((event) => event.data);
  const observed = {
    label,
    exit: result.status,
    reply: (result.stdout ?? "").trim().split(/\r?\n/).filter(Boolean).slice(0, 3),
    stderr: (result.stderr ?? "").trim().split(/\r?\n/).filter(Boolean).slice(0, 4),
    selected,
  };
  if (expected.exit !== undefined) {
    if (observed.exit !== expected.exit) throw new Error(`${label}: expected exit ${expected.exit}, got ${observed.exit}`);
  }
  if (expected.token !== undefined && !observed.reply.join(" ").includes(expected.token)) {
    throw new Error(`${label}: expected ${expected.token} in ${JSON.stringify(observed.reply)}`);
  }
  if (expected.agentName !== undefined && observed.selected[0]?.agentName !== expected.agentName) {
    throw new Error(
      `${label}: expected agentName ${expected.agentName}, got ${JSON.stringify(observed.selected[0] ?? null)}`,
    );
  }
  if (expected.tools !== undefined && JSON.stringify(observed.selected[0]?.tools) !== JSON.stringify(expected.tools)) {
    throw new Error(`${label}: expected tools ${JSON.stringify(expected.tools)}, got ${JSON.stringify(observed.selected[0])}`);
  }
  console.log(`${label}: exit=${observed.exit} agent=${observed.selected[0]?.agentName ?? "-"}`);
  return observed;
}

const observations = [];
const prompt = ["-p", "Reply with the token from your instructions."];
observations.push(run("project-by-id", ["--agent", "probe", ...prompt], {
  exit: 0,
  token: "TOKEN-PROJECT-ID",
  agentName: "probe-agent",
  tools: ["read"],
}));
observations.push(run("project-by-name", ["--agent", "probe-agent", ...prompt], {
  exit: 0,
  token: "TOKEN-PROJECT-ID",
  agentName: "probe-agent",
}));
observations.push(run("legacy-md-extension", ["--agent", "legacy", ...prompt], {
  exit: 0,
  token: "TOKEN-LEGACY",
  agentName: "legacy",
}));
observations.push(run("package-qualified", ["--plugin-dir", PLUGIN_ROOT, "--agent", "hooknostic-agents-probe:pkg", ...prompt], {
  exit: 0,
  token: "TOKEN-PACKAGE",
  agentName: "hooknostic-agents-probe:pkg",
}));
observations.push(run("foreign-claude-agent-is-loaded", ["--agent", "foreign", ...prompt], {
  exit: 0,
  token: "TOKEN-FOREIGN",
  agentName: "foreign",
}));
observations.push(run("project-copy-wins-over-claude", ["--agent", "shared", ...prompt], {
  exit: 0,
  token: "TOKEN-COPILOT",
  agentName: "shared",
}));
observations.push(run("missing-agent", ["--agent", "does-not-exist", ...prompt], { exit: 1 }));
observations.push(run("malformed-file", ["--agent", "malformed", ...prompt], { exit: 1 }));
observations.push(
  run("namespace-agents-tree-not-loaded", ["--plugin-dir", PLUGIN_NS, "--agent", "hooknostic-agents-ns:ns", ...prompt], {
    exit: 1,
  }),
);

const curated = {
  harness: "GitHub Copilot CLI",
  version: (spawnSync(resolveCopilotBinary(), ["--version", "--no-auto-update"], { encoding: "utf8" }).stdout ?? "").trim(),
  method: "live-probe",
  date: new Date().toISOString().slice(0, 10),
  questions: {
    projectPath: ".github/agents/<id>.agent.md and <id>.md both load; ID is the file stem, and --agent also accepts the frontmatter name",
    frontmatter: "name, description and tools were accepted; tools: [\"read\"] limited the selected agent to read",
    sessionSelection: "--agent <id> selected the file as the session's agent; subagent.selected recorded its name and tools",
    packagePath: "a --plugin-dir package's agents/<name>.agent.md loaded as <plugin>:<name>",
    defaultAgent: "no project or user setting starts a session as a custom agent; --agent and /agent are per session",
  },
  observations: observations.map(({ stderr: _stderr, ...observation }) => observation),
  limits: [
    "Windows only.",
    "No default-agent route was found in `copilot help config`; a setting outside that help was not searched.",
    "Delegation was established from the documented agent behaviour and the subagent.selected event, not from a model-initiated delegation.",
  ],
};

if (process.argv.includes("--write")) {
  mkdirSync(dirname(EVIDENCE), { recursive: true });
  writeFileSync(EVIDENCE, `${JSON.stringify(curated, null, 2)}\n`);
  console.log(`wrote ${resolve(EVIDENCE)}`);
}
