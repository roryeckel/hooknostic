// Prove native-agent regressions fail under controlled defects, then restore sources.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { register } from "node:module";

register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url));
const { runProcess } = await import("../../packages/cli/test/harness-playback.ts");
const files = {
  codex: "packages/adapter-codex/src/agent-native.ts",
  v1: "packages/adapter-opencode/src/agent-native.ts",
  core: "packages/core/src/build.ts",
  codexProject: "packages/adapter-codex/src/project.ts",
  v1Project: "packages/adapter-opencode/src/project.ts",
  v1Package: "packages/adapter-opencode/src/project-agent-plugin.ts",
};
const root = new URL("../../", import.meta.url);
const sources = new Map(await Promise.all(Object.values(files).map(async (path) => [path, await readFile(new URL(path, root), "utf8")])));
const out = new URL("./captured/native-audit-mutations/", import.meta.url);
await mkdir(out, { recursive: true });
const unit = ["packages/adapter-codex/src/agent-native.test.ts", "packages/adapter-opencode/src/agent-native.test.ts", "packages/core/src/project-agents.test.ts"];
const mutants = [
  { name: "accept-invalid-codex", file: files.codex, from: "const errors = new Set<string>();", to: "return []; const errors = new Set<string>();" },
  { name: "reject-valid-codex", file: files.codex, from: "const errors = new Set<string>();", to: 'return ["mutant"]; const errors = new Set<string>();' },
  { name: "mutate-valid-codex", file: files.codex, from: 'const native = agent.native["codex"];', to: 'const native = agent.native["codex"]; if (native) native.model = "mutated";' },
  { name: "skip-newer-schema", file: files.codex, from: "if (!intersects(target.version, families[index]!)) continue;", to: "if (index === 1 || !intersects(target.version, families[index]!)) continue;" },
  { name: "silence-ignored-codex", file: files.codex, from: "const ignored = ignoredFields(native, range);", to: "const ignored: string[] = [];" },
  { name: "ignore-codex-version", file: files.codex, from: "const bounded = intersects(range, families[1]!);", to: "const bounded = true;" },
  { name: "ignore-codex-declaration", file: files.codex, from: "cell?.degradations?.some((item) => item.id === AGENT_FIELD_IGNORED)", to: "true" },
  { name: "ignore-codex-primary-route", file: files.codex, from: "servesAsSubagent(agent.mode) &&", to: "true &&" },
  { name: "silence-default-shortfall", file: files.codex, from: "agent.name === defaultAgent &&", to: "false &&" },
  { name: "bypass-native-validation", file: files.core, from: "adapter.agents?.validateNative?.(agent, target)", to: "undefined" },
  { name: "warn-invalid-native", file: files.core, from: '...(adapter.agents?.validateNative?.(agent, target) ?? []).map((message): Diagnostic => ({\n      code: "HN503",\n      severity: "error",', to: '...(adapter.agents?.validateNative?.(agent, target) ?? []).map((message): Diagnostic => ({\n      code: "HN503",\n      severity: onInvalid,' },
  { name: "validate-excluded-agent", file: files.core, from: "nativeAgentDiagnostics(\n                selectedSource.agents ?? [],", to: "nativeAgentDiagnostics(\n                componentSource?.agents ?? []," },
  { name: "ignore-requested-version", file: files.core, from: "harnessVersion: config.targets[id]!.version,", to: "" },
  { name: "silence-v1-caps", file: files.v1, from: "return agents.flatMap((agent) => {", to: "return []; return agents.flatMap((agent) => {" },
  { name: "degrade-v1-primary", file: files.v1, from: "if (!servesAsSubagent(agent.mode)) return [];", to: "if (false) return [];" },
  { name: "ignore-v1-declaration", file: files.v1, from: "if (!cell?.degradations?.some((item) => item.id === AGENT_STEP_LIMIT_IGNORED)) return [];", to: "if (false) return [];" },
  { name: "drop-v1-provider-option", file: files.v1, from: 'const native = agent.native["opencode"] ?? {};', to: 'const native = agent.native["opencode"] ?? {}; delete native.custom_provider_option;' },
  { name: "drop-v1-project-fields", file: files.v1Project, from: "...Object.fromEntries(native)", to: "...{}", playback: "opencode-v1", pattern: "generated-steps" },
  { name: "drop-v1-package-fields", file: files.v1Package, from: "...agent.native,", to: "...{},", playback: "opencode-v1", pattern: "packaged-steps" },
  { name: "drop-codex-fields", file: files.codexProject, from: "...Object.fromEntries(native)", to: "...{}", playback: "codex", pattern: "generated-sandbox" },
];
const results = [];
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;
try {
  for (const mutant of mutants.filter((item) => only === undefined || item.name === only)) {
    const source = sources.get(mutant.file);
    assert.equal(source.split(mutant.from).length, 2, `Mutant must match once: ${mutant.name}`);
    await writeFile(new URL(mutant.file, root), source.replace(mutant.from, mutant.to));
    const result = await runProcess("pnpm", ["exec", "vitest", "run", ...unit], { env: process.env, timeoutMs: 120_000 });
    await writeFile(new URL(`${mutant.name}.txt`, out), result.stdout + result.stderr);
    assert.notEqual(result.code, 0, `Mutant survived: ${mutant.name}`);
    assert.match(result.stdout + result.stderr, /AssertionError/, `Must fail an assertion: ${mutant.name}`);
    results.push({ name: mutant.name, exit: result.code });
    console.log(`${mutant.name}: expected assertion failure (${result.code})`);
    if (mutant.playback) {
      const playback = await runProcess("pnpm", ["exec", "vitest", "run", "packages/cli/test/agent-definition-playback.test.ts", "-t", mutant.pattern], { env: { ...process.env, HOOKNOSTIC_PLAYBACK: mutant.playback }, timeoutMs: 210_000 });
      await writeFile(new URL(`${mutant.name}-playback.txt`, out), playback.stdout + playback.stderr);
      assert.notEqual(playback.code, 0, `Live mutant survived: ${mutant.name}`);
      assert.match(playback.stdout + playback.stderr, /AssertionError/);
      assert.doesNotMatch(playback.stdout + playback.stderr, /timed out/);
      results.push({ name: `${mutant.name}-playback`, exit: playback.code });
      console.log(`${mutant.name}-playback: expected assertion failure (${playback.code})`);
    }
    await writeFile(new URL(mutant.file, root), source);
  }
} finally {
  for (const [path, source] of sources) await writeFile(new URL(path, root), source);
}
assert.ok(results.length, "No matching mutation");
await writeFile(new URL(only === undefined ? "results.json" : `results-${only}.json`, out), JSON.stringify({ results, restored: true }, null, 2) + "\n");
console.log(`Verified ${results.length} expected failures; all sources restored.`);
