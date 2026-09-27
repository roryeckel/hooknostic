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
  ["audit-provider", "packages/adapter-opencode/src/v2/shim.ts", '["context", "title", "generate"]', '["context", "title"]', playback, "provider-"],
  ["audit-responses-stream", "packages/cli/test/harness-playback.ts", readFileSync("packages/cli/test/harness-playback.ts", "utf8").match(/    const text = action.text \?\? "playback complete";[\s\S]+?    events.push\(\{/)[0], '    events.push({', playback, "provider-responses"],
  ["audit-subagent", "packages/adapter-opencode/src/v2/toolmap.ts", 'subagent: "agent"', 'subagent: "other"', playback, "subagent result"],
  ["audit-notifications", ".capture/opencode-v2/notification-server.js", 'await registration.events.emit("message", { text: "hooknostic-server-notification" });', 'await Promise.resolve();', playback, "companion TUI notification"],
  ["audit-oauth-refresh", ".capture/opencode-v2/oauth-mcp.mjs", 'Date.now() < expires', 'true', playback, "OAuth"],
  ["audit-error-drift", "scripts/compare-capture-shapes.mjs", 'event.status === "error"', 'false', "scripts/compare-capture-shapes.test.mjs", "separates v2 typed"],
  ["generation-context", "packages/adapter-opencode/src/v2/shim.ts", '["context", "title", "generate"]', '["context", "title"]', playback, "reloads registrations"],
  ["compaction-context", "packages/adapter-opencode/src/v2/shim.ts", 'await run("compaction", e, true)', 'await Promise.resolve()', playback, "reloads registrations"],
  ["compaction-before", "packages/adapter-opencode/src/v2/shim.ts", 'await run("compaction", e);', 'await Promise.resolve();', playback, "reloads registrations"],
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
  ["stop-event-queue", "packages/adapter-opencode/src/v2/shim.ts", 'enqueue(sessionID, () => run("event", event));', 'await run("event", event);', unit, "running turn.stop hook"],
  ["nested-serves", "packages/adapter-opencode/src/v2/project.ts", "(serves(ctx.location.directory) ? plugin.setup(ctx) : undefined)", "plugin.setup(ctx)", "packages/adapter-opencode/src/v2/project.test.ts", "nested checkouts"],
  ["nested-serves-playback", "packages/adapter-opencode/src/v2/project.ts", "(serves(ctx.location.directory) ? plugin.setup(ctx) : undefined)", "plugin.setup(ctx)", playback, "nested checkout from its own copy"],
  ["nested-id", "packages/adapter-opencode/src/v2/project.ts", "id: plugin.id + suffix", "id: plugin.id", "packages/adapter-opencode/src/v2/project.test.ts", "distinct id"],
  ["nested-id-playback", "packages/adapter-opencode/src/v2/project.ts", "id: plugin.id + suffix", "id: plugin.id", playback, "nested checkout from its own copy"],
  ["nested-components", "packages/adapter-opencode/src/v2/project.ts", "  if (!serves(ctx.location.directory)) return;\n", "", "packages/adapter-opencode/src/v2/project.test.ts", "nested checkouts"],
  ["location-filter", "packages/adapter-opencode/src/v2/shim.ts", "            } else if (!local.has(sessionID)) continue;", "            }", unit, "another location"],
  ["location-filter-playback", "packages/adapter-opencode/src/v2/shim.ts", "            } else if (!local.has(sessionID)) continue;", "            }", playback, "nested checkout from its own copy"],
  ["location-created", "packages/adapter-opencode/src/v2/shim.ts", "comparable(location.directory) !== here) continue;", "false) continue;", unit, "another location"],
  ["location-prompt", "packages/adapter-opencode/src/v2/shim.ts", 'if (typeof e.sessionID === "string") local.add(e.sessionID);', "", unit, "prompted through this instance"],
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
];
for (const [name, path, before, after, file, pattern] of cases) {
  if (process.argv.length > 2 && !process.argv.slice(2).includes(name)) continue;
  const original = readFileSync(path);
  const source = original.toString("utf8");
  if (!source.includes(before)) throw new Error(`mutant anchor missing: ${name}`);
  const report = join(root, name + ".json");
  try {
    writeFileSync(path, source.replaceAll(before, after));
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
    if (result.status === 0 || !failed.length) throw new Error(`mutant survived: ${name}`);
  } finally {
    writeFileSync(path, original);
  }
}
console.log(`Mutation reports: ${root}`);
