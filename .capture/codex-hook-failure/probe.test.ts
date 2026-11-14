// Drives the Code Mode deny scenario through `codex app-server`, whose
// `hook/completed` notification carries what `codex exec` drops: each hook
// run's status, duration, and Codex's own error entries. See README.md.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, test } from "vitest";

import { defaultAdapterRegistry } from "../../packages/cli/src/registry.js";
import {
  buildPlaybackArtifact,
  hookProcessRecorderEnv,
  hookProcessReport,
  playbackModelInfo,
  runProcess,
  spawnIntact,
  startModelPlayback,
} from "../../packages/cli/test/harness-playback.js";

function withoutCredentials(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (/TOKEN|SECRET|PASSWORD|API_KEY|ANTHROPIC|OPENAI|CODEX_HOME|AI_PAT/i.test(name)) delete env[name];
  return env;
}

const toml = (value: string) => `'${value.replaceAll("'", "''")}'`;
const RUNS = Number(process.env["HOOKNOSTIC_PROBE_RUNS"] ?? "1");
const OUT = process.env["HOOKNOSTIC_PROBE_OUT"];
// The playback budget the CI failure ran with: a 1s allowance on every hook, so
// a 2s native timeout at the 1s handler budget below. Set both to the drives'
// current values to compare (ADR-0039).
const HOOK_TIMEOUT_MS = Number(process.env["HOOKNOSTIC_PROBE_HOOK_TIMEOUT_MS"] ?? "1000");
const PROCESS_ALLOWANCE_MS = Number(process.env["HOOKNOSTIC_PROBE_PROCESS_ALLOWANCE_MS"] ?? "1000");

interface HookRun {
  eventName: string;
  status: string;
  statusMessage: string | null;
  durationMs: number | null;
  entries: { kind: string; text: string }[];
}

class AppServer {
  private nextId = 1;
  private readonly pending = new Map<number, (message: Record<string, unknown>) => void>();
  readonly notifications: { method: string; params: Record<string, unknown> }[] = [];
  private turnDone?: () => void;
  readonly stderr: string[] = [];

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    createInterface({ input: child.stdout }).on("line", (line) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof message["id"] === "number" && ("result" in message || "error" in message)) {
        this.pending.get(message["id"])?.(message);
        this.pending.delete(message["id"]);
      } else if (typeof message["method"] === "string") {
        this.notifications.push({
          method: message["method"],
          params: (message["params"] ?? {}) as Record<string, unknown>,
        });
        if (message["method"] === "turn/completed") this.turnDone?.();
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.stderr.push(chunk));
  }

  request(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 60_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if ("error" in message) reject(new Error(`${method}: ${JSON.stringify(message["error"])}`));
        else resolve(message["result"] as Record<string, unknown>);
      });
    });
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(JSON.stringify({ method, ...(params === undefined ? {} : { params }) }) + "\n");
  }

  turnCompleted(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("turn/completed timed out")), 90_000);
      this.turnDone = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  hookRuns(): HookRun[] {
    return this.notifications
      .filter((notification) => notification.method === "hook/completed")
      .map((notification) => notification.params["run"] as HookRun);
  }
}

async function drive(index: number) {
  const adapter = defaultAdapterRegistry().codex;
  if (adapter === undefined) throw new Error("codex adapter missing from the default registry");
  const version = /(\d+\.\d+\.\d+)/.exec(
    (await runProcess("codex", ["--version"], { cwd: tmpdir(), env: process.env, timeoutMs: 30_000 })).stdout,
  )?.[1];
  expect(version).toBeTypeOf("string");
  const root = await mkdtemp(join(tmpdir(), "hooknostic-codex-hook-failure-"));
  const dir = join(root, "project");
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const model = await startModelPlayback("openai-responses", "block", [
    { kind: "code", disposition: "block" },
    { kind: "text" },
  ]);
  try {
    const build = await buildPlaybackArtifact(adapter, dir, {
      version: version!,
      shellMatch: true,
      hookTimeoutMs: HOOK_TIMEOUT_MS,
      processAllowanceMs: PROCESS_ALLOWANCE_MS,
    });
    const preToolUseTimeout = (
      JSON.parse(await readFile(join(dir, ".codex/hooks.json"), "utf8")) as {
        hooks: { PreToolUse: { hooks: { timeout: number }[] }[] };
      }
    ).hooks.PreToolUse[0]!.hooks[0]!.timeout;
    await runProcess("git", ["init"], { cwd: dir, env: process.env, timeoutMs: 30_000 });
    const catalog = join(dir, "model-catalog.json");
    await writeFile(catalog, JSON.stringify({ models: [playbackModelInfo({ tool_mode: "code_mode_only" })] }));
    const hookLog = join(dir, "hook-processes.jsonl");
    const child = spawnIntact(
      "codex",
      [
        "app-server",
        "-c",
        'model="hooknostic-playback"',
        "-c",
        'model_provider="hooknostic_playback"',
        "-c",
        'approval_policy="never"',
        "-c",
        'sandbox_mode="danger-full-access"',
        "-c",
        'model_providers.hooknostic_playback.name="Hooknostic Playback"',
        "-c",
        `model_providers.hooknostic_playback.base_url=${toml(`${model.baseUrl}/v1`)}`,
        "-c",
        'model_providers.hooknostic_playback.wire_api="responses"',
        "-c",
        "model_providers.hooknostic_playback.requires_openai_auth=false",
        "-c",
        "model_providers.hooknostic_playback.request_max_retries=0",
        "-c",
        "model_providers.hooknostic_playback.stream_max_retries=0",
        "-c",
        `projects={${toml(dir)}={trust_level=${toml("trusted")}}}`,
        "-c",
        `model_catalog_json=${toml(catalog)}`,
      ],
      {
        cwd: dir,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...withoutCredentials(),
          CODEX_HOME: home,
          ...hookProcessRecorderEnv(hookLog),
          HOOKNOSTIC_PLAYBACK_TRACE: build.tracePath,
        },
      },
    );
    const server = new AppServer(child);
    try {
      await server.request("initialize", {
        clientInfo: { name: "hooknostic-probe", title: "hooknostic probe", version: "0.0.0" },
        capabilities: { experimentalApi: true },
      });
      server.notify("initialized");
      const started = await server.request("thread/start", { cwd: dir, config: { bypass_hook_trust: true } });
      const threadId = (started["thread"] as { id: string }).id;
      const done = server.turnCompleted();
      await server.request("turn/start", {
        threadId,
        input: [{ type: "text", text: "Use the shell tool once to create hooknostic-blocked.txt, then stop." }],
      });
      await done;
    } finally {
      child.stdin.end();
      child.kill();
    }
    const blockedFileWritten = await readFile(join(dir, "hooknostic-blocked.txt"), "utf8").then(
      () => true,
      () => false,
    );
    return {
      index,
      version,
      preToolUseTimeoutSeconds: preToolUseTimeout,
      blockedFileWritten,
      hookRuns: server.hookRuns().map((run) => ({
        eventName: run.eventName,
        status: run.status,
        statusMessage: run.statusMessage,
        durationMs: run.durationMs,
        entries: run.entries,
      })),
      hookProcesses: await hookProcessReport(hookLog),
      // Printed on an anomaly only: it carries this machine's paths.
      appServerStderr: () => server.stderr.join("").slice(-4000),
    };
  } finally {
    await model.close();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

test(
  "records Codex's own verdict for every hook run in the Code Mode deny drive",
  { timeout: 300_000 * Math.max(1, RUNS) },
  async () => {
    const drives = [];
    for (let index = 0; index < RUNS; index++) {
      const result = await drive(index);
      drives.push(result);
      const failed = result.hookRuns.filter((run) => run.status !== "completed" && run.status !== "blocked");
      if (failed.length > 0 || result.blockedFileWritten) {
        console.log(JSON.stringify({ index, failed, blockedFileWritten: result.blockedFileWritten }, null, 2));
        console.log(result.hookProcesses);
        console.log(result.appServerStderr());
      }
      // Functions (the stderr accessor) drop out of the JSON record.
      if (OUT) await writeFile(OUT, JSON.stringify(drives, null, 2));
    }
    expect(drives.length).toBe(RUNS);
  },
);
