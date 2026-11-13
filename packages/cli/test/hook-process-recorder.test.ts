import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defaultAdapterRegistry } from "../src/registry.js";
import { buildPlaybackArtifact, hookProcessRecorderEnv, hookProcessReport } from "./harness-playback.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hooknostic-recorder-"));
  dirs.push(dir);
  return dir;
}

/** Run `script` as a file named like a generated hook runtime, under the recorder. */
function runAsHook(
  dir: string,
  logPath: string,
  input: string,
  options: { kill?: boolean } = {},
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(dir, "hooknostic.mjs")], {
      cwd: dir,
      env: { ...process.env, ...hookProcessRecorderEnv(logPath, {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
    if (options.kill) {
      // Killed with its input still open: the timeout case, where the harness
      // terminates a hook that has not answered.
      child.stdout.once("data", () => child.kill("SIGKILL"));
    } else {
      child.stdin.end(input);
    }
    child.stdout.resume();
    child.stderr.resume();
  });
}

describe("hook process recorder", () => {
  it("reports a hook's exit code, stdout and stderr, which Codex never prints", async () => {
    const dir = await scratch();
    await writeFile(
      join(dir, "hooknostic.mjs"),
      `let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
process.stdout.write('{"reply":true}');
process.stderr.write("hooknostic: decode failed");
process.exitCode = 3;
`,
    );
    const logPath = join(dir, "hooks.jsonl");
    expect(await runAsHook(dir, logPath, JSON.stringify({ hook_event_name: "PreToolUse" }))).toBe(3);

    const report = await hookProcessReport(logPath);
    expect(report).toContain("hook processes (1):");
    expect(report).toMatch(/PreToolUse pid \d+: exit 3 after \d+ms \(node boot \d+ms, stdin read by \d+ms/);
    expect(report).toContain('stdout: "{\\"reply\\":true}"');
    expect(report).toContain('stderr: "hooknostic: decode failed"');
  });

  it("names a hook killed before it exited", async () => {
    const dir = await scratch();
    // Signals readiness, then waits on stdin that never closes.
    await writeFile(join(dir, "hooknostic.mjs"), `process.stdout.write("ready"); process.stdin.resume();\n`);
    const logPath = join(dir, "hooks.jsonl");
    await runAsHook(dir, logPath, "", { kill: true });

    const report = await hookProcessReport(logPath);
    expect(report).toMatch(/<event unread> pid \d+: NO EXIT RECORD -- killed or aborted/);
    expect(report).toContain("stdin never fully read");
  });

  it("says so when no hook process reached JavaScript", async () => {
    const dir = await scratch();
    expect(await hookProcessReport(join(dir, "hooks.jsonl"))).toBe(
      "hook processes: none recorded (no generated hook reached JavaScript)",
    );
  });

  it("ignores Node processes that are not a generated hook runtime", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "other.mjs"), "process.exitCode = 0;\n");
    const logPath = join(dir, "hooks.jsonl");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [join(dir, "other.mjs")], {
        env: { ...process.env, ...hookProcessRecorderEnv(logPath, {}) },
        stdio: "ignore",
      });
      child.on("error", reject);
      child.on("close", () => resolve());
    });
    expect(await hookProcessReport(logPath)).toContain("none recorded");
  });
});

describe("playback hook budgets", () => {
  // The Code Mode deny drive failed open in CI when Codex timed PreToolUse out
  // at a 2s native timeout while the hook process was still starting
  // (.capture/codex-hook-failure). The drives' budgets leave start-up room;
  // SessionEnd stays inside Codex's 3s cap.
  it("gives generated Codex hooks room for process start, within the SessionEnd cap", async () => {
    const dir = await scratch();
    const codex = defaultAdapterRegistry().codex;
    if (codex === undefined) throw new Error("codex adapter missing from the default registry");
    await buildPlaybackArtifact(codex, dir, { shellMatch: true });
    const hooksJson = JSON.parse(await readFile(join(dir, ".codex/hooks.json"), "utf8")) as {
      hooks: Record<string, { hooks: { timeout: number }[] }[]>;
    };
    const timeouts = Object.fromEntries(
      Object.entries(hooksJson.hooks).map(([event, groups]) => [event, groups[0]!.hooks[0]!.timeout]),
    );
    expect(timeouts["SessionEnd"]).toBe(3);
    for (const [event, seconds] of Object.entries(timeouts)) {
      if (event !== "SessionEnd") expect(seconds, event).toBe(11);
    }
  });
});
