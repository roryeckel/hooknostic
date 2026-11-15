import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { HarnessAdapter } from "@hooknostic/core";
import { bundleRuntime, dispatcherRuntimePolicy, levelsFromMatrix } from "@hooknostic/core";
import type { HookEventName } from "@hooknostic/sdk";
import { DEFAULT_COMPATIBILITY, DEFAULT_RUNTIME } from "@hooknostic/sdk";

const require = createRequire(import.meta.url);

/** The hook id and message the probe handler throws with. */
export const HANDLER_ERROR_PROBE = {
  hookId: "hooknostic-error-probe",
  message: "probe handler threw on purpose",
} as const;

/** The whole line `formatHandlerErrors` writes for the probe, whatever its code or kind. */
export const HANDLER_ERROR_LINE = new RegExp(
  `^hooknostic \\S+ \\[${HANDLER_ERROR_PROBE.hookId}\\]: ${HANDLER_ERROR_PROBE.message}$`,
  "m",
);

interface DriverBase {
  /** The portable event the input decodes to; the probe hook listens on it. */
  event: HookEventName;
  /** A captured native input in the adapter's fixture directory, by file name. */
  input: string;
}

/** A harness that spawns the artifact: the input goes to stdin, the report to stderr. */
export interface CommandShimDriver extends DriverBase {
  execution: "command";
  /** Arguments the harness passes after the artifact path. */
  args?: readonly string[];
}

/** A harness that imports the artifact: the report goes to console.error. */
export interface ModuleShimDriver extends DriverBase {
  execution: "module";
  /**
   * Stand in for the host: hand the artifact's default export what the
   * harness hands it, then deliver `native` the way the harness does. Resolves
   * once the callback has settled.
   */
  deliver(exported: unknown, native: unknown): Promise<void>;
}

export type HandlerErrorDriver = CommandShimDriver | ModuleShimDriver;

export interface HandlerErrorOptions {
  /** Absolute path to the fixture directory `driver.input` is read from. */
  fixturesDir: string;
  /** Range to resolve capabilities at. Defaults to `harness.recommendedRange`. */
  version?: string;
}

/**
 * The obligation #175 broke: fail-open is the contract, fail-silent is not.
 * A handler that throws must be named on the channel the harness gives the
 * shim, and the call must still go through.
 *
 * The artifact is the one a build ships: the adapter's own `shimEntry`,
 * bundled with its own aliases. A command shim is spawned and its stderr read;
 * an imported one is loaded in-process and `console.error` read, the one
 * channel that does not corrupt a TUI's alternate screen. Only the host's
 * calling convention comes from the driver, because nothing on
 * `HarnessAdapter` describes it; how the artifact runs is checked against
 * `shimExecution`, so a driver cannot model the wrong one.
 */
export function describeHandlerErrorReporting(
  adapter: HarnessAdapter,
  driver: HandlerErrorDriver,
  options: HandlerErrorOptions,
): void {
  const channel = driver.execution === "command" ? "stderr" : "console.error";
  describe(`handler error reporting: ${adapter.harness.displayName}`, () => {
    it(`names a throwing ${driver.event} handler on ${channel} and fails open`, async () => {
      expect(driver.execution, "the driver runs the artifact the way shimExecution says").toBe(adapter.shimExecution);
      expect(adapter.shimEntry, "a shim entry to build").toBeTypeOf("function");
      const dir = await mkdtemp(join(tmpdir(), "hooknostic-handler-error-"));
      try {
        const artifact = await buildProbeArtifact(adapter, driver.event, dir, options.version);
        const input = await readFile(join(options.fixturesDir, driver.input), "utf8");
        if (driver.execution === "command") {
          const result = await runCommand(artifact, driver.args ?? [], input);
          expect(result.code, result.stderr).toBe(0);
          expect(result.stderr).toMatch(HANDLER_ERROR_LINE);
          return;
        }
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          const loaded = (await import(/* @vite-ignore */ pathToFileURL(artifact).href)) as { default?: unknown };
          await expect(driver.deliver(loaded.default, JSON.parse(input))).resolves.toBeUndefined();
          const written = error.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
          expect(written).toMatch(HANDLER_ERROR_LINE);
        } finally {
          error.mockRestore();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    // A host that imports the artifact owns its process; a command shim owns
    // its own, and the hook source shares it (#186).
    if (driver.execution !== "command") return;
    for (const failure of HOOK_SOURCE_FAILURES) {
      it(`reports a hook source's ${failure.name} on stderr and fails open`, async () => {
        const dir = await mkdtemp(join(tmpdir(), "hooknostic-handler-error-"));
        try {
          const artifact = await buildProbeArtifact(adapter, driver.event, dir, options.version, failure.top);
          const input = await readFile(join(options.fixturesDir, driver.input), "utf8");
          const result = await runCommand(artifact, driver.args ?? [], input);
          expect(result.code, result.stderr).toBe(0);
          expect(result.stderr).toMatch(internalErrorLine(failure.message));
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    }
  });
}

/** What a hook source can do to the process a command shim shares with it. */
const HOOK_SOURCE_FAILURES = [
  {
    name: "top-level rejection",
    top: `Promise.reject(new Error("probe source rejected on purpose"));`,
    message: "probe source rejected on purpose",
  },
  { name: "process.exit(2)", top: "process.exit(2);", message: "the hook source called process.exit(2)" },
] as const;

/** The whole line `formatInternalError` writes for `message`, with or without a hook name. */
function internalErrorLine(message: string): RegExp {
  return new RegExp(`^hooknostic internal(?: \\[[^\\]]+\\])?: ${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m");
}

async function buildProbeArtifact(
  adapter: HarnessAdapter,
  event: HookEventName,
  dir: string,
  version = adapter.harness.recommendedRange,
  top = "",
): Promise<string> {
  const entryPath = join(dir, "hooks.ts");
  await writeFile(
    entryPath,
    [
      `import { definePlugin, hook } from "@hooknostic/sdk";`,
      top,
      `export default definePlugin({ name: "handler-error-probe", hooks: [`,
      `  hook(${JSON.stringify(event)}, { id: ${JSON.stringify(HANDLER_ERROR_PROBE.hookId)}, run() {`,
      `    throw new Error(${JSON.stringify(HANDLER_ERROR_PROBE.message)});`,
      `  } }),`,
      `] });`,
      "",
    ].join("\n"),
    "utf8",
  );
  const target = { id: adapter.id, version, delivery: "project" as const, output: "." };
  // The options `build` passes (packages/core/src/build.ts) for a default
  // config: a target named after the adapter, no plugin root.
  const bundle = await bundleRuntime({
    source: adapter.shimEntry!({
      targetId: adapter.id,
      entryImportPath: entryPath.replaceAll("\\", "/"),
      capabilities: levelsFromMatrix(adapter.capabilities(target).matrix ?? {}),
      minimumCapabilityLevel: DEFAULT_COMPATIBILITY.minimum,
      // continue, so the failure is reported rather than turned into a block.
      policy: dispatcherRuntimePolicy({ ...DEFAULT_RUNTIME, onHookError: "continue" }),
      targetRange: version,
    }),
    resolveDir: dir,
    alias: {
      ...adapter.shimAliases?.(),
      // The probe lives in a scratch directory with no node_modules.
      "@hooknostic/sdk": require.resolve("@hooknostic/sdk"),
    },
  });
  const artifact = join(dir, "hooknostic.mjs");
  await writeFile(artifact, bundle.code, "utf8");
  return artifact;
}

function runCommand(
  artifact: string,
  args: readonly string[],
  input: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [artifact, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      // A debug trace would also land on stderr; keep the channel to the report.
      env: { ...process.env, HOOKNOSTIC_DEBUG: "" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`${artifact} did not exit`));
    }, 10_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
    // A shim that exits before reading all of stdin makes the write fail
    // with EPIPE; the exit code and stderr are the verdict, not the write.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
