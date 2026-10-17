import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type PhaseDetails = { command?: string; args?: string[]; cwd?: string; code?: number | null; error?: string };

/** Persist progress immediately: the test's outer timeout can kill the driver before finally runs. */
export function createPlaybackDiagnostics(root: string, effect: string) {
  let currentPhase = "bootstrap";
  let failed = false;
  const started = Date.now();

  function record(phase: string, status: "started" | "completed" | "failed", details: PhaseDetails = {}) {
    currentPhase = phase;
    const entry = {
      timestamp: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      effect,
      phase,
      status,
      ...details,
    };
    const line = JSON.stringify(entry) + "\n";
    appendFileSync(join(root, "phases.jsonl"), line);
    writeFileSync(join(root, "current-phase.json"), line);
    process.stderr.write(`[opencode-v2 phase] ${line}`);
  }

  function fail(error: unknown) {
    if (failed) return;
    failed = true;
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    record(currentPhase, "failed", { error: message });
    writeFileSync(join(root, "failure.json"), JSON.stringify({ phase: currentPhase, error: message }) + "\n");
  }

  return {
    start(phase: string, details: PhaseDetails = {}) {
      record(phase, "started", details);
    },
    complete(phase: string, details: PhaseDetails = {}) {
      record(phase, "completed", details);
    },
    fail,
    async run<T>(phase: string, operation: () => Promise<T>, details: PhaseDetails = {}): Promise<T> {
      record(phase, "started", details);
      try {
        const result = await operation();
        record(phase, "completed", details);
        return result;
      } catch (error) {
        fail(error);
        throw error;
      }
    },
    output(phase: string, stream: "stdout" | "stderr", chunk: string) {
      appendFileSync(join(root, `${phase}.${stream}.log`), chunk);
      process.stderr.write(`[opencode-v2 ${phase} ${stream}] ${chunk}`);
    },
    snapshot(name: string, value: unknown) {
      writeFileSync(join(root, name), JSON.stringify(value, null, 2) + "\n");
    },
  };
}
