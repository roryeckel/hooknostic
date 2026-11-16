// Deliberate defects must fail focused tests. Always restore the original bytes.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
const vitest = join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");
const root = mkdtempSync(join(tmpdir(), "hooknostic-v2-mutants-"));
const unit = "packages/adapter-opencode/src/v2/adapter.test.ts";
const playback = "packages/cli/test/opencode-v2-playback.test.ts";
const cases = [
  ["audit-error-decode", "packages/adapter-opencode/src/v2/decode.ts", 'event.status === "error"', 'event.status === "not-an-error"', unit, "tool-read-error|error-only"],
  ["audit-error-registration", "packages/adapter-opencode/src/v2/shim.ts", ' || events.has("tool.error")', '', unit, "error-only"],
  ["audit-result", "packages/adapter-opencode/src/v2/apply.ts", 'JSON.stringify(effect.output)', 'String(effect.output)', playback, "rich output"],
  ["audit-provider", "packages/adapter-opencode/src/v2/shim.ts", '["title", "generate"]', '["title"]', playback, "provider-"],
  ["audit-responses-stream", "packages/cli/test/harness-playback.ts", readFileSync("packages/cli/test/harness-playback.ts", "utf8").match(/    const text = action.text \?\? "playback complete";[\s\S]+?    events.push\(\{/)[0], '    events.push({', playback, "provider-responses"],
  ["audit-subagent", "packages/adapter-opencode/src/v2/toolmap.ts", 'subagent: "agent"', 'subagent: "other"', playback, "subagent result"],
  // Killed on the reference build, which this moves past the boundary.
  ["subagent-background-boundary", "packages/adapter-opencode/src/v2/profile.ts", 'version: "2.3.0",\n          date: "2026-11-16",\n          method: "captured",', 'version: "2.0.17",\n          date: "2026-11-16",\n          method: "captured",', playback, "subagent result"],
  // The late-child test kills it from 2.3.0, where a child's result starts an
  // unprompted parent execution; on every build the stop test's prevention
  // continuation, which no prompt starts either, does.
  ["subagent-late-turn-id", "packages/adapter-opencode/src/v2/shim.ts", "const prompt = pendingPrompts.get(sessionID);\n                  pendingPrompts.delete(sessionID);", "const prompt = pendingPrompts.get(sessionID);", playback, "late background child|prevents and notifies"],
  ["audit-notifications", ".capture/opencode-v2/notification-server.js", 'await registration.events.emit("message", { text: "hooknostic-server-notification" });', 'await Promise.resolve();', playback, "companion TUI notification"],
  ["audit-oauth-refresh", ".capture/opencode-v2/oauth-mcp.mjs", 'Date.now() < expires', 'true', playback, "OAuth"],
  ["audit-error-drift", "scripts/compare-capture-shapes.mjs", 'event.status === "error"', 'false', "scripts/compare-capture-shapes.test.mjs", "separates v2 typed"],
  ["generation-context", "packages/adapter-opencode/src/v2/shim.ts", '["title", "generate"]', '["title"]', playback, "reloads registrations"],
  ["compaction-context", "packages/adapter-opencode/src/v2/shim.ts", 'await runFailingOpen("compaction", e, true)', 'await Promise.resolve()', playback, "reloads registrations"],
  ["compaction-before", "packages/adapter-opencode/src/v2/shim.ts", 'await runFailingOpen("compaction", e);', 'await Promise.resolve();', playback, "reloads registrations"],
  ["compaction-after", "packages/adapter-opencode/src/v2/decode.ts", 'event.type === "session.compaction.ended"', 'event.type === "unmapped.compaction"', playback, "reloads registrations"],
  ["permission-filter", "packages/adapter-opencode/src/v2/decode.ts", 'event.effect === "ask"', 'true', playback, "ask-only permissions"],
  ["permission-effect", "packages/adapter-opencode/src/v2/shim.ts", 'native.effect = "deny";', 'native.effect = "allow";', playback, "sessions-deny observes"],
  ["failed-stop", "packages/adapter-opencode/src/v2/decode.ts", ', "session.execution.failed"', '', playback, "sessions observes"],
  ["interrupted-stop", "packages/adapter-opencode/src/v2/decode.ts", ', "session.execution.interrupted"', '', playback, "sessions observes"],
  ["session-fixtures", "packages/adapter-opencode/src/v2/decode.ts", '["context", "title", "generate"]', '["context", "title"]', unit, "generate.input.json"],
  ["session-drift", "scripts/compare-capture-shapes.mjs", "payloads = captured.filter(mapped);", 'payloads = captured.filter(payload => EXPECTED_VARIANTS["opencode-v2"].includes(variantOf(harness, payload)));', "scripts/compare-capture-shapes.test.mjs", "newly supported session route"],
  ["remote-project", "packages/adapter-opencode/src/v2/project.ts", 'const config = {}; configure(config);', 'const config = {};', playback, "project-remote executes"],
  ["remote-package", "packages/adapter-opencode/src/v2/project.ts", ': server));', ': { ...server, headers: {} }));', playback, "package-remote executes"],
  ["remote-sse-control", ".capture/opencode-v2/remote-mcp.mjs", 'const path = new URL(req.url, "http://127.0.0.1").pathname;', 'const path = req.url;', playback, "missing legacy SSE fallback"],
  ["mcp-namespace", "packages/adapter-opencode/src/v2/toolmap.ts", ': "other";', ': nativeName.includes("_") ? "mcp" : "other";', unit, "connected server namespace|tool-custom-namespace"],
  ["mcp-block", ".capture/opencode-v2-mcp/guard.ts", 'return block("hooknostic-mcp-denied")', 'return undefined', playback, "guards the exact MCP name"],
  ["mcp-match", ".capture/opencode-v2-mcp/guard.ts", 'match: { nativeName: "hooknostic_hooknostic_echo" },', 'match: {},', playback, "guards the exact MCP name"],
  ["tool-kinds", "packages/adapter-opencode/src/v2/toolmap.ts", 'kinds[nativeName]!', '"other"', unit, "tool-.*input.json"],
  ["shell-cwd", "packages/adapter-opencode/src/v2/toolmap.ts", ', cwdKey: "workdir"', '', unit, "tool-shell-workdir"],
  ["outer-boundary", "packages/adapter-opencode/src/v2/toolmap.ts", ': "other";', ': "mcp";', unit, "unknown and Code Mode|tool-(execute|skill|mcp-inner)"],
  ["tool-playback", "packages/adapter-opencode/src/v2/toolmap.ts", 'kinds[nativeName]!', '"other"', playback, "classifies captured tools"],
  ["registry-loading", ".capture/opencode-v2/drive.mjs", 'plugins: [packagePath]', 'plugins: []', playback, "scoped npm coordinate"],
  ["stop-success-gate", "packages/adapter-opencode/src/v2/shim.ts", 'native.type !== "session.execution.succeeded" || ', '', unit, "turn.stop posting"],
  ["stop-success-playback", "packages/adapter-opencode/src/v2/shim.ts", 'native.type !== "session.execution.succeeded" || ', '', playback, "prevents and notifies"],
  ["stop-child-gate", "packages/adapter-opencode/src/v2/shim.ts", ' || children.has(sessionID)', '', unit, "turn.stop posting"],
  ["stop-child-playback", "packages/adapter-opencode/src/v2/shim.ts", ' || children.has(sessionID)', '', playback, "prevents and notifies"],
  ["stop-notify-resume", "packages/adapter-opencode/src/v2/apply.ts", '[{ text: effect.message, resume: false }]', '[{ text: effect.message, resume: true }]', playback, "prevents and notifies"],
  ["stop-notice-order", "packages/adapter-opencode/src/v2/apply.ts", 'synthetic.push({ text: terminal.reason', 'synthetic.unshift({ text: terminal.reason', unit, "turn.stop posting"],
  ["stop-post-catch", "packages/adapter-opencode/src/v2/shim.ts", "      try {\n        await withTimeout(Promise.resolve(ctx.session.synthetic({ sessionID, text, resume })));\n      } catch {\n        // Fail open: a stop event is the worst place to break the session.\n      }", "      await withTimeout(Promise.resolve(ctx.session.synthetic({ sessionID, text, resume })));", unit, "notice before it fails"],
  ["stop-event-queue", "packages/adapter-opencode/src/v2/shim.ts", 'enqueue(sessionID, () => run("event", event, false, execution));', 'await run("event", event, false, execution);', unit, "running turn.stop hook"],
  ["nested-serves", "packages/adapter-opencode/src/v2/project.ts", "(serves(ctx.location.directory) ? plugin.setup(ctx) : undefined)", "plugin.setup(ctx)", "packages/adapter-opencode/src/v2/project.test.ts", "nested checkouts"],
  ["nested-serves-playback", "packages/adapter-opencode/src/v2/project.ts", "(serves(ctx.location.directory) ? plugin.setup(ctx) : undefined)", "plugin.setup(ctx)", playback, "nested checkout from its own copy"],
  ["nested-id", "packages/adapter-opencode/src/v2/project.ts", "id: plugin.id + suffix", "id: plugin.id", "packages/adapter-opencode/src/v2/project.test.ts", "distinct id"],
  ["nested-id-playback", "packages/adapter-opencode/src/v2/project.ts", "id: plugin.id + suffix", "id: plugin.id", playback, "nested checkout from its own copy"],
  ["nested-components", "packages/adapter-opencode/src/v2/project.ts", "  if (!serves(ctx.location.directory)) return;\n", "", "packages/adapter-opencode/src/v2/project.test.ts", "nested checkouts"],
  ["location-filter", "packages/adapter-opencode/src/v2/shim.ts", "            } else if (!local.has(sessionID)) continue;", "            }", unit, "another location"],
  ["location-filter-playback", "packages/adapter-opencode/src/v2/shim.ts", "            } else if (!local.has(sessionID)) continue;", "            }", playback, "nested checkout from its own copy"],
  ["location-created", "packages/adapter-opencode/src/v2/shim.ts", "comparable(location.directory) !== here) continue;", "false) continue;", unit, "another location"],
  ["location-prompt", "packages/adapter-opencode/src/v2/shim.ts", "if (sessionID !== undefined) local.add(sessionID);", "", unit, "prompted through this instance"],
  [
    "family",
    "packages/adapter-opencode/src/index.ts",
    "adapter = families.find((family) => isRangeFullyCovered(target.version, family.supportedHarnessVersions()));",
    "adapter = v1;",
    unit,
    "OpenCode family selection",
  ],
  ["raw", "packages/adapter-opencode/src/v2/decode.ts", "    raw,", "    raw: undefined,", unit, "input.json"],
  [
    "dispose",
    "packages/adapter-opencode/src/v2/shim.ts",
    "registrations.map((r) => r.dispose())",
    "registrations.map(async () => undefined)",
    unit,
    "disposes registrations",
  ],
  [
    "effects",
    "packages/adapter-opencode/src/v2/apply.ts",
    "  const application: OpenCodeV2Application = {};",
    "  return {}; const application: OpenCodeV2Application = {};",
    playback,
    "observable effect|hooks-only",
  ],
  [
    "components",
    "packages/adapter-opencode/src/v2/project.ts",
    "editor.set(name,",
    "false && editor.set(name,",
    playback,
    "loads skills",
  ],
  [
    "host-disabled-guard",
    "packages/adapter-opencode/src/v2/project.ts",
    "if (editor.get(name)?.disabled === true) continue;",
    "",
    "packages/adapter-opencode/src/v2/project.test.ts",
    "host disabled",
  ],
  [
    "host-disabled-inverted",
    "packages/adapter-opencode/src/v2/project.ts",
    "?.disabled === true",
    "?.disabled === false",
    "packages/adapter-opencode/src/v2/project.test.ts",
    "host left enabled",
  ],
  [
    "host-disabled-presence",
    "packages/adapter-opencode/src/v2/project.ts",
    "editor.get(name)?.disabled === true",
    "editor.get(name) !== undefined",
    "packages/adapter-opencode/src/v2/project.test.ts",
    "host left enabled",
  ],
  [
    "host-disabled-playback",
    "packages/adapter-opencode/src/v2/project.ts",
    "if (editor.get(name)?.disabled === true) continue;",
    "",
    playback,
    "host-disabled projected MCP server",
  ],
  [
    "reload",
    ".capture/opencode-v2/lifecycle.mjs",
    'if (index) await api("/location/reload", {});',
    'if (false) await api("/location/reload", {});',
    playback,
    "reloads registrations",
  ],
  [
    "lanes",
    "scripts/harness-lanes.mjs",
    'pkg: "@opencode/cli"',
    'pkg: "opencode-ai"',
    "scripts/harness-lanes.test.mjs",
    "independent metadata",
  ],
  [
    "drift",
    "scripts/compare-capture-shapes.mjs",
    "payloads = captured.filter(mapped);",
    'payloads = captured.filter(payload => EXPECTED_VARIANTS["opencode-v2"].includes(variantOf(harness, payload)));',
    "scripts/compare-capture-shapes.test.mjs",
    "unfamiliar tool",
  ],
  [
    "separate-outputs",
    "packages/sdk/src/schemas.ts",
    'config.project === undefined || target.delivery !== "project"',
    'target.delivery !== "project"',
    "packages/sdk/src/schemas.test.ts",
    "separate family artifacts",
  ],
  // A child's completion as agent.stop (#231). The unit tests replay both
  // captured subagent sequences, foreground and background.
  ["agent-stop-decode", "packages/adapter-opencode/src/v2/decode.ts", "enrichment.child !== undefined &&", "false && enrichment.child !== undefined &&", unit, "subagent-stop.input.json"],
  ["agent-stop-session", "packages/adapter-opencode/src/v2/decode.ts", "session: { id: parentID, cwd", "session: { id: sessionID, cwd", unit, "subagent-stop.input.json"],
  ["agent-stop-subscription", "packages/adapter-opencode/src/v2/shim.ts", '    events.has("agent.stop") ||\n', "", unit, "U2:"],
  ["agent-stop-parent-link", "packages/adapter-opencode/src/v2/shim.ts", "{ parentID: data.parentID, agent: data.agent }", "{ agent: data.agent }", unit, "U2:"],
  ["agent-stop-completion-filter", "packages/adapter-opencode/src/v2/shim.ts", ' && childStops.has(String(event.type))', "", unit, "U2:"],
  ["agent-stop-text", "packages/adapter-opencode/src/v2/shim.ts", ' || declares("agent.stop", "lastMessage")', "", unit, "U3:"],
  ["agent-stop-post-guard", "packages/adapter-opencode/src/v2/shim.ts", '    if (event.event !== "turn.stop") return;\n', "", unit, "U4:"],
  ["agent-stop-child-turn-stop", "packages/adapter-opencode/src/v2/shim.ts", 'enqueue(sessionID, () => run("event", event, false, execution));', 'if (!children.has(sessionID)) enqueue(sessionID, () => run("event", event, false, execution));', unit, "U5:"],
  ["agent-stop-succeeded-only", "packages/adapter-opencode/src/v2/shim.ts", 'new Set(["session.execution.succeeded", "session.execution.failed"])', 'new Set(["session.execution.succeeded"])', unit, "U6:"],
  ["agent-stop-parent-link-playback", "packages/adapter-opencode/src/v2/shim.ts", "{ parentID: data.parentID, agent: data.agent }", "{ agent: data.agent }", playback, "one agent.stop under its parent"],
  [
    "agent-stop-order",
    "packages/adapter-opencode/src/v2/shim.ts",
    '              enqueue(sessionID, () => run("event", event, false, execution));\n              // The child\'s own turn.stop first, then its agent.stop, in the\n              // same queue. Both report the same execution.\n              const child = children.get(sessionID);\n              if (child !== undefined && events.has("agent.stop") && childStops.has(String(event.type)))\n                enqueue(sessionID, () => run("event", event, false, execution, child));',
    '              const child = children.get(sessionID);\n              if (child !== undefined && events.has("agent.stop") && childStops.has(String(event.type)))\n                enqueue(sessionID, () => run("event", event, false, execution, child));\n              enqueue(sessionID, () => run("event", event, false, execution));',
    playback,
    "late background child",
  ],
  ["agent-stop-succeeded-only-playback", "packages/adapter-opencode/src/v2/shim.ts", 'new Set(["session.execution.succeeded", "session.execution.failed"])', 'new Set(["session.execution.succeeded"])', playback, "failed before any text"],
  // Pins the follow-up claim: a child reported once would drop the second.
  ["agent-stop-once-per-child", "packages/adapter-opencode/src/v2/shim.ts", "const child = children.get(sessionID);", "const child = children.get(sessionID); children.delete(sessionID);", playback, "followed-up subagent"],
  // Keyed by session alone, the child's agent.stop takes the parent's one
  // prevention, and the stop drive times out waiting for it.
  [
    "agent-stop-prevent-key",
    "packages/cli/test/harness-playback.ts",
    '!preventedSessions.has("${event}:" + (event.session.id ?? ""))) {\n          preventedSessions.add("${event}:" + (event.session.id ?? ""));',
    '!preventedSessions.has(event.session.id ?? "")) {\n          preventedSessions.add(event.session.id ?? "");',
    playback,
    "prevents and notifies",
  ],
  // Rated prevention reaches the post; only the guard keeps it off the parent.
  [
    "agent-stop-post-guard-playback",
    [
      ["packages/adapter-opencode/src/v2/shim.ts", '    if (event.event !== "turn.stop") return;\n', ""],
      ["packages/adapter-opencode/src/v2/profile.ts", '"agent.stop.prevent": {\n        level: "unsupported",', '"agent.stop.prevent": {\n        level: "approximate",'],
    ],
    undefined,
    undefined,
    playback,
    "prevents and notifies",
  ],
];
for (const [name, path, before, after, file, pattern] of cases) {
  if (process.argv.length > 2 && !process.argv.slice(2).includes(name)) continue;
  // One edit, or several (each [path, before, after]) for a mutant spanning files.
  const edits = Array.isArray(path) ? path : [[path, before, after]];
  const originals = edits.map(([path]) => [path, readFileSync(path)]);
  for (const [path, before] of edits)
    if (!readFileSync(path, "utf8").includes(before)) throw new Error(`mutant anchor missing: ${name}`);
  const report = join(root, name + ".json");
  try {
    for (const [path, before, after] of edits) writeFileSync(path, readFileSync(path, "utf8").replaceAll(before, after));
    const result = spawnSync(
      process.execPath,
      [vitest, "run", file, "-t", pattern, "--reporter=json", "--outputFile=" + report],
      { encoding: "utf8", timeout: 240000, env: { ...process.env, HOOKNOSTIC_PLAYBACK: "opencode-v2" } },
    );
    const data = JSON.parse(readFileSync(report, "utf8"));
    const failed = data.testResults.flatMap((suite) =>
      suite.assertionResults.filter((test) => test.status === "failed").map((test) => test.fullName),
    );
    console.log(JSON.stringify({ name, exit: result.status, failed }));
    // The drive refuses a binary other than the expected build before exercising
    // any mutant; that setup failure must not count as a killed mutant.
    if (JSON.stringify(data.testResults).includes("opencode-v2 playback binary mismatch"))
      throw new Error(`playback binary mismatch, mutant not exercised: ${name}`);
    if (result.status === 0 || !failed.length) throw new Error(`mutant survived: ${name}`);
  } finally {
    for (const [path, original] of originals) writeFileSync(path, original);
  }
}
console.log(`Mutation reports: ${root}`);
