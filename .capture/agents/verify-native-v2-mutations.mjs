// Each unit regression and the live generated-package regression must reject a defect.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { register } from "node:module";

register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url));
const { runProcess } = await import("../../packages/cli/test/harness-playback.ts");
const path = new URL("../../packages/adapter-opencode/src/v2/agent-native.ts", import.meta.url);
const source = await readFile(path, "utf8");
const out = new URL("./captured/native-mutations/", import.meta.url);
await mkdir(out, { recursive: true });
const mutants = [
  { name: "drop-scalars", from: '["model", "hidden", "color", "steps"]', to: "[]" },
  { name: "replace-request", from: 'Object.assign(agent.request.headers, native.request.headers ?? {});', to: "agent.request = native.request;" },
  { name: "replace-permissions", from: "agent.permissions.push(...native.permissions.map(agentRule))", to: "agent.permissions = native.permissions.map(agentRule)" },
  { name: "skip-home-expansion", from: "const home = homedir();", to: "return rule; const home = homedir();", playback: true },
  { name: "ignore-disabled", from: "if (native.disabled === true)", to: "if (false)" },
  { name: "accept-invalid", from: "opencode: fields } }, issues };", to: "opencode: fields } }, issues: [] };" },
  { name: "silence-request-degradation", from: 'if (!cell?.degradations?.some((item) => item.id === AGENT_REQUEST_IGNORED))', to: "if (true)" },
  { name: "degrade-empty-request", from: "Object.keys(map).length > 0", to: "Object.keys(map).length >= 0" },
];
const results = [];
try {
  for (const mutant of mutants) {
    assert.equal(source.split(mutant.from).length, 2, "Mutant must match exactly once: " + mutant.name);
    await writeFile(path, source.replace(mutant.from, mutant.to));
    const unit = await runProcess("pnpm", ["exec", "vitest", "run", "packages/adapter-opencode/src/v2/project.test.ts"], { env: process.env, timeoutMs: 120_000 });
    await writeFile(new URL(`${mutant.name}.txt`, out), unit.stdout + unit.stderr);
    assert.notEqual(unit.code, 0, "Mutant survived: " + mutant.name);
    assert.match(unit.stdout + unit.stderr, /AssertionError/, "Must fail a regression assertion: " + mutant.name);
    results.push({ mutant: mutant.name, testExit: unit.code });
    if (mutant.playback) {
      const playback = await runProcess("pnpm", ["exec", "vitest", "run", "packages/cli/test/agent-definition-playback.test.ts", "-t", "remaining packaged native"], {
        env: { ...process.env, HOOKNOSTIC_PLAYBACK: "opencode-v2" }, timeoutMs: 210_000,
      });
      await writeFile(new URL("skip-home-expansion-playback.txt", out), playback.stdout + playback.stderr);
      assert.notEqual(playback.code, 0, "Live generated-package mutant survived");
      assert.match(playback.stdout + playback.stderr, /AssertionError/);
      assert.doesNotMatch(playback.stdout + playback.stderr, /timed out/);
      assert.match(playback.stdout + playback.stderr, /true !== false/);
      results.push({ mutant: "skip-home-expansion-playback", testExit: playback.code });
    }
  }
} finally { await writeFile(path, source); }
console.log(JSON.stringify({ results, restored: true }, null, 2));
