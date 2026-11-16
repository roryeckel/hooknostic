import { rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

import type { AdapterRegistry, EvaluationGuard } from "@hooknostic/core";
import { EvaluationStalledError, loadConfig, runProject, setEvaluationGuard } from "@hooknostic/core";
import type { CommandShimGuard } from "@hooknostic/runtime";
import {
  claimProtocolStdout,
  debugEnabled,
  errorMessage,
  exitCodeText,
  finishCommandShim,
  formatInternalError,
  guardCommandShim,
  HookSourceExitError,
  isInstance,
} from "@hooknostic/runtime";

import { runBuild } from "./build.js";
import type { CommandIO } from "./check.js";
import { runCheck } from "./check.js";
import { runDispatchWith } from "./dispatch.js";
import { runDoctor } from "./doctor.js";
import { runInit } from "./init.js";
import { inspectFailure, runInspect } from "./inspect.js";
import { defaultAdapterRegistry } from "./registry.js";

export const CLI_USAGE = `hooknostic — portable hooks, skills, and MCP for coding agents

Usage:
  hooknostic check   [--config <path>] [--target <a,b>] [--json]
  hooknostic build   [--config <path>] [--target <a,b>] [--json]
  hooknostic init --local [--config <path>] [--json]
  hooknostic sync [--config <path>] [--dry-run] [--json]
  hooknostic verify [--config <path>] [--json]
  hooknostic recover [--config <path>] [--json]
  hooknostic doctor  [--config <path>] [--json]
  hooknostic inspect <target> [--capability <id> | --component <id> | --field <id>] [--version <range>] [--delivery <project|package>] [--config <path>] [--json]
  hooknostic dispatch --target <id> [--events <path>] [--config <path>] [--unguarded]

Options:
  --config <path>     Path to hooknostic.config.ts (default ./hooknostic.config.ts)
  --target <a,b>      Narrow the configured target set (never adds targets)
  --events <path>     JSON Lines of portable events to dispatch (default: stdin)
  --capability <id>   Inspect a single capability
  --component <id>    Inspect a single Agent Plugin component
  --field <id>        Inspect a single optional event field, e.g. turn.stop.lastMessage
  --version <range>   Harness version range for inspect
  --delivery <scope>  Project or package component support for inspect
  --unguarded         dispatch: let the hook source's process.exit and uncaught errors end the run
  --json              Machine-readable output
  -h, --help          Show this help
`;

export interface RunCliOptions {
  registry?: AdapterRegistry;
  io?: CommandIO;
}

async function readStdin(): Promise<string> {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/**
 * Remove `directory` when the process exits. Dispatch removes its staged
 * hooks when it returns, and every command a module it evaluated, but user
 * code can end the process before then; an `exit` listener still runs, and
 * must be synchronous and never throw.
 */
function removeAtExit(directory: string): void {
  process.on("exit", () => {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best effort: a leftover temp directory is not worth failing the exit.
    }
  });
}

/**
 * Run `hooknostic dispatch`'s hooks under the command-shim guard (#189), so a
 * hook source that exits, rejects, or throws from a timer is reported
 * against the event it interrupted rather than ending the run. One guard for
 * the run, since it owns process listeners, scoped per event. A load that
 * never settles fails dispatch with 2 (#201).
 *
 * Exit codes: dispatch's own 2 stands; otherwise 1 when anything was
 * reported outside a handler, else 0. Until the run finishes, leaving is 1:
 * the results are not all out.
 */
function guardDispatch() {
  // The config's load only: dispatch loads the hook source outside any window (#201).
  const windows: LoadWindows = {};
  let strays = 0;
  let label: string | undefined;
  let execution: "command" | "module" | undefined;
  let adapter: string | undefined;
  let finishedWith: number | undefined;
  // A module target's shim runs in the harness's process and does not
  // intercept process.exit, so there an exit gets a note. Queued here when
  // intercepted, and folded into the guard's own report of it when there is
  // one, so one exit is never two lines.
  let queued: unknown[] = [];
  let noted: unknown[] = [];
  // Only facts about our own shim: what the harness then does is not captured.
  // The adapter's shim, not the configured target's key, which may be any name.
  const clause = () => `the ${adapter} shim runs in the harness's process and does not intercept it`;
  const guard = guardCommandShim(
    (error) => {
      // The config's own diagnostic reports it.
      if (failOpenLoad(windows, error)) return undefined;
      strays += 1;
      // After a clean finish, a stray still fails the run; a 2 stays a 2.
      if (finishedWith === 0) guard.decide(1);
      let text = formatInternalError(error, { ...(label === undefined ? {} : { hook: label }), stack: debugEnabled() });
      if (isInstance(error, HookSourceExitError)) {
        const at = queued.findIndex((code) => Object.is(code, error.code));
        if (at !== -1) {
          queued.splice(at, 1);
          // On the first line, ahead of any stack.
          const end = text.indexOf("\n");
          text = end === -1 ? `${text}; ${clause()}` : `${text.slice(0, end)}; ${clause()}${text.slice(end)}`;
        }
      }
      return text;
    },
    {
      onExit(code) {
        if (execution !== "module" || label === undefined || noted.some((seen) => Object.is(seen, code))) return;
        noted.push(code);
        queued.push(code);
      },
    },
  );
  // Before anything can end the process.
  guard.decide(1);
  // The config loads in a window, as every command's does: a failure in it,
  // or a loop that empties under it, is the config's HN501 (#201).
  const evaluation: EvaluationGuard = {
    watch: (directory, work) => watchLoad(guard, windows, directory, work),
  };
  return {
    evaluation,
    // The hook source gets a stall check only, so what its loads do stays
    // attributed to the event, as a command shim's would be.
    watchStall,
    onEventStart(index: number, shim: { id: string; execution: "command" | "module" | undefined }) {
      label = `event ${index + 1}`;
      adapter = shim.id;
      execution = shim.execution;
      queued = [];
      noted = [];
      guard.scope();
    },
    async onEventEnd() {
      // A zero-delay tail or a microtask rejection lands while its event is
      // still the current one.
      await delay(0);
      for (const code of queued) {
        strays += 1;
        await guard.write(
          `hooknostic dispatch [${label}]: intercepted process.exit(${exitCodeText(code)}); ${clause()}\n`,
        );
      }
      queued = [];
      label = undefined;
    },
    /** Leave with dispatch's code, or 1 for anything reported; returns the code. */
    finish(code: number): number {
      finishedWith = code !== 0 ? code : strays > 0 ? 1 : 0;
      guard.finish(finishedWith);
      return finishedWith;
    },
    /** Leave with 2 after an unexpected throw. */
    fail() {
      finishedWith = 2;
      guard.finish(2);
    },
  };
}

// As claimProtocolStdout's release bounds its own flush: well inside the
// harness allowance, and only ever waited out by a stream that is stuck.
const FLUSH_BOUND_MS = 500;

/**
 * Wait out earlier writes to `stream`, for at most FLUSH_BOUND_MS: user code
 * may have replaced `write` with one that never calls back, and the forced
 * exit that ends a leaked handle comes only after this. A stream a handler
 * ended or destroyed is skipped. The timer stays referenced: with a stuck
 * stream nothing else may keep the loop alive until it fires.
 */
function flush(stream: NodeJS.WriteStream): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    flushed(stream).finally(() => clearTimeout(timer)),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, FLUSH_BOUND_MS);
    }),
  ]);
}

function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      // A consumer that closed the pipe early (`| head`) fails this write
      // (EPIPE, or ENOTCONN or ECONNRESET on macOS), and the command is
      // finishing anyway: the guard must not see it as an uncaught error, and
      // turn the exit code into 2.
      stream.on("error", () => {});
      while (stream.writableCorked > 0) stream.uncork();
      if (stream.writableEnded || stream.destroyed) return resolve();
      stream.write("", () => resolve());
    } catch {
      resolve();
    }
  });
}

/** A module load in its window: what the guard's `describe` fails instead of reporting. */
interface LoadWindow {
  failed: boolean;
  fail(error: unknown): void;
}

/** The load whose window is open, if any; shared by a guard's `describe` and `watchLoad`. */
interface LoadWindows {
  current?: LoadWindow | undefined;
}

/**
 * For a guard's `describe`: fail the load whose window is open with `error`,
 * so its own diagnostic reports it. False when there is none, or it already
 * failed, and the caller reports `error` itself.
 */
function failOpenLoad(windows: LoadWindows, error: unknown): boolean {
  const open = windows.current;
  if (open === undefined || open.failed) return false;
  open.fail(error);
  return true;
}

/**
 * Settle as `work`, one module load, does, within its window (#193): the
 * import, adopting the default export, and one zero-delay drain. It rejects
 * first with a failure `failOpenLoad` routes to it, or with an
 * {@link EvaluationStalledError} should the event loop empty while it is
 * pending. `directory`, the staged module, is removed even if the process
 * ends first. Install `guard` before the first load.
 */
async function watchLoad<T>(
  guard: CommandShimGuard,
  windows: LoadWindows,
  directory: string,
  work: Promise<T>,
): Promise<T> {
  // A failure that recurs in this load is reported against it too.
  guard.scope();
  removeAtExit(directory);
  let reject!: (error: unknown) => void;
  const failure = new Promise<never>((_, fail) => {
    reject = fail;
  });
  failure.catch(() => {});
  const self: LoadWindow = {
    failed: false,
    fail(error) {
      if (self.failed) return;
      self.failed = true;
      reject(error);
    },
  };
  // The loop emptied, so the load can never settle: with nothing left to
  // run, the process would exit 13 for a top-level await, or 0.
  const stalled = () => self.fail(new EvaluationStalledError());
  windows.current = self;
  process.on("beforeExit", stalled);
  try {
    const value = await Promise.race([work, failure]);
    // A microtask rejection or a zero-delay tail belongs to this load.
    await Promise.race([delay(0), failure]);
    return value;
  } finally {
    if (windows.current === self) windows.current = undefined;
    process.off("beforeExit", stalled);
  }
}

/**
 * Settle as `work`, one load of dispatch's hook source, does, or reject with
 * an {@link EvaluationStalledError} should the event loop empty while it is
 * pending (#201). Unlike `watchLoad`, no window: no routing, no drain.
 */
async function watchStall<T>(work: Promise<T>): Promise<T> {
  let stalled!: () => void;
  const stall = new Promise<never>((_, reject) => {
    stalled = () => reject(new EvaluationStalledError());
  });
  stall.catch(() => {});
  process.on("beforeExit", stalled);
  try {
    return await Promise.race([work, stall]);
  } finally {
    process.off("beforeExit", stalled);
  }
}

/**
 * Run the config and the hook source that a command other than dispatch
 * evaluates under the command-shim guard (#193). The guard is installed on
 * the first evaluation, since it owns process listeners, and kept for the
 * life of the process; a command that evaluates nothing runs as before.
 *
 * A process.exit, rejection, or timer throw inside a load's window fails
 * that load, which the command reports as HN501, and so does an event loop
 * that empties under it (`watchLoad`). One outside every window is a stray:
 * reported as an internal error, it makes the exit code at least 2. Strays
 * do not hold back what a command writes; build or sync may already have
 * written its output.
 *
 * Until the command finishes, leaving is 2: whatever ended the process, the
 * command did not.
 */
function guardEvaluation() {
  let guard: CommandShimGuard | undefined;
  const windows: LoadWindows = {};
  let finished: number | undefined;
  let strays = 0;
  const install = (): CommandShimGuard => {
    if (guard !== undefined) return guard;
    const installed = guardCommandShim((error) => {
      // The load's own diagnostic reports it.
      if (failOpenLoad(windows, error)) return undefined;
      strays += 1;
      // After the command finished, a stray still fails it; a 2 stays a 2.
      if (finished !== undefined && finished < 2) installed.decide(2);
      return formatInternalError(error, { stack: debugEnabled() });
    });
    // Before anything can end the process.
    installed.decide(2);
    guard = installed;
    return installed;
  };
  const evaluation: EvaluationGuard = {
    watch: (directory, work) => watchLoad(install(), windows, directory, work),
  };
  return {
    evaluation,
    installed: () => guard !== undefined,
    /** Report a throw that escaped the command, as a stray. */
    report: (error: unknown) => install().report(error),
    /** Leave with `code`, or 2 if anything strayed; returns the code. */
    async finish(code: number): Promise<number> {
      if (guard === undefined) return code;
      // The forced exit below must not cut a piped report short.
      await flush(process.stdout);
      await flush(process.stderr);
      // After the flush, so a stray during it still counts.
      const final = strays > 0 && code < 2 ? 2 : code;
      finished = final;
      guard.finish(final);
      return final;
    },
  };
}

/**
 * Run a `hooknostic` command line in the caller's process, and resolve with
 * its exit code. The caller keeps the process: this never replaces
 * `process.exit`, adds process listeners, takes over stdout, or forces an exit,
 * whether or not `options.io` is given. So a config or hook source that exits,
 * rejects, throws from a timer or leaks a handle affects the caller's process
 * as it would any code the caller imports; only the `hooknostic` command
 * guards against that (docs/design.md §10.3).
 */
export async function runCli(argv: string[], options?: RunCliOptions): Promise<number> {
  return runCommandLine(argv, options, { ownsProcess: false });
}

/**
 * The `hooknostic` command's entry (bin.ts). It owns its process, so it alone
 * installs what is process-global: the guard around what a command evaluates
 * (#193), dispatch's guard (#189), dispatch's claim on stdout, the exit-time
 * removal of staged modules, and the forced exit that ends a leaked handle.
 * Not exported from the package entry; tests may pass a registry.
 */
export async function main(argv: string[], options?: Pick<RunCliOptions, "registry">): Promise<number> {
  return runCommandLine(argv, options, { ownsProcess: true });
}

async function runCommandLine(
  argv: string[],
  options: RunCliOptions | undefined,
  { ownsProcess }: { ownsProcess: boolean },
): Promise<number> {
  // Dispatch keeps its own guard (#189).
  if (!ownsProcess || argv[0] === "dispatch") return runCommand(argv, options, ownsProcess);
  const guarded = guardEvaluation();
  setEvaluationGuard(guarded.evaluation);
  let code: number;
  try {
    code = await runCommand(argv, options, ownsProcess);
  } catch (error) {
    if (!guarded.installed()) throw error;
    await guarded.report(error);
    code = 2;
  } finally {
    setEvaluationGuard(undefined);
  }
  return guarded.finish(code);
}

async function runCommand(argv: string[], options: RunCliOptions | undefined, ownsProcess: boolean): Promise<number> {
  const io: CommandIO = options?.io ?? {
    stdout: (t) => console.log(t),
    stderr: (t) => console.error(t),
  };
  const registry = options?.registry ?? defaultAdapterRegistry();

  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h" || command === "help") {
    io.stdout(CLI_USAGE);
    return command ? 0 : 2;
  }

  let parsed: { values: Record<string, string | boolean | undefined>; positionals: string[] };
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        config: { type: "string" },
        "dry-run": { type: "boolean" },
        local: { type: "boolean" },
        target: { type: "string" },
        capability: { type: "string" },
        component: { type: "string" },
        field: { type: "string" },
        delivery: { type: "string" },
        events: { type: "string" },
        version: { type: "string" },
        unguarded: { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    io.stderr(CLI_USAGE);
    return 2;
  }

  if (parsed.values["help"]) {
    io.stdout(CLI_USAGE);
    return 0;
  }

  const targets =
    typeof parsed.values["target"] === "string"
      ? parsed.values["target"]
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined;

  if (
    (command === "check" || command === "build") &&
    typeof parsed.values["target"] === "string" &&
    targets?.length === 0
  ) {
    io.stderr("--target requires at least one non-empty target.");
    io.stderr(CLI_USAGE);
    return 2;
  }

  // A mistake in the command line: its message and the usage, as parseArgs's
  // own are reported, not the catch-all's "unexpected error" (#208). --json
  // keeps the line the catch-all printed, so JSON consumers see no change.
  const usage = (message: string): number => {
    if (parsed.values["json"]) io.stdout(JSON.stringify({ schemaVersion: 1, command, ok: false, errors: [message] }));
    else {
      io.stderr(message);
      io.stderr(CLI_USAGE);
    }
    return 2;
  };

  try {
    if (parsed.values["dry-run"] && command !== "sync") return usage("--dry-run is only supported by sync");
    if (parsed.values["unguarded"] && command !== "dispatch") return usage("--unguarded is only supported by dispatch");
    switch (command) {
      case "init":
        if (!parsed.values["local"]) return usage("init requires --local");
        return await runInit(
          typeof parsed.values["config"] === "string" ? parsed.values["config"] : undefined,
          registry,
          io,
          parsed.values["json"] === true,
        );
      case "sync":
      case "verify":
      case "recover": {
        const result = await runProject({
          command,
          configPath: resolve(
            typeof parsed.values["config"] === "string" ? parsed.values["config"] : "hooknostic.config.ts",
          ),
          registry,
          ...(targets === undefined ? {} : { targets }),
          dryRun: parsed.values["dry-run"] === true,
        });
        if (parsed.values["json"]) io.stdout(JSON.stringify({ schemaVersion: 1, command, ...result }, null, 2));
        else {
          for (const diagnostic of result.diagnostics)
            io.stdout(`${diagnostic.code} ${diagnostic.severity}: ${diagnostic.message}`);
          for (const [id, target] of Object.entries(result.targets ?? {})) {
            const exclusions = target.project?.authorExclusions;
            if (exclusions)
              io.stdout(
                `${id}: ${exclusions.matches.filter((match) => match.status === "omitted").length} author exclusions, ${exclusions.matches.filter((match) => match.status === "exposed").length} exposures`,
              );
          }
          for (const path of result.changes) io.stdout(`${command === "verify" ? "DRIFT" : "UPDATE"} ${path}`);
          for (const message of result.guidance) io.stdout(message);
          for (const message of result.errors) io.stderr(message);
          if (result.ok) io.stdout(`${command} succeeded${parsed.values["dry-run"] ? "; nothing written" : ""}.`);
        }
        return result.errors.length ? 2 : result.ok ? 0 : 1;
      }
      case "check":
        return await runCheck({
          ...(typeof parsed.values["config"] === "string" ? { config: parsed.values["config"] } : {}),
          ...(targets ? { targets } : {}),
          ...(parsed.values["json"] ? { json: true } : {}),
          registry,
          io,
        });
      case "build":
        return await runBuild({
          ...(typeof parsed.values["config"] === "string" ? { config: parsed.values["config"] } : {}),
          ...(targets ? { targets } : {}),
          ...(parsed.values["json"] ? { json: true } : {}),
          registry,
          io,
        });
      case "doctor":
        return await runDoctor({
          ...(typeof parsed.values["config"] === "string" ? { config: parsed.values["config"] } : {}),
          ...(parsed.values["json"] ? { json: true } : {}),
          registry,
          io,
        });
      case "inspect": {
        let target = parsed.positionals[0];
        if (target === undefined) {
          io.stderr("inspect requires a target, e.g. `hooknostic inspect claude`.");
          return 2;
        }
        if (typeof parsed.values["config"] === "string") {
          const loaded = await loadConfig(resolve(parsed.values["config"]));
          const report = { io, ...(parsed.values["json"] ? { json: true } : {}) };
          // A config that fails to load is HN501, printed as check prints it (#208).
          if (!loaded.config)
            return inspectFailure(
              report,
              loaded.diagnostics.map((d) => `${d.code}: ${d.message}`),
              loaded.diagnostics,
            );
          const configured = Object.hasOwn(loaded.config.targets, target) ? loaded.config.targets[target] : undefined;
          // dispatch's wording for the same mistake (dispatch.ts).
          if (!configured)
            return inspectFailure(report, [
              `target ${JSON.stringify(target)} is not configured; configured targets: ${Object.keys(loaded.config.targets).join(", ") || "none"}.`,
            ]);
          parsed.values["version"] ??= configured.version;
          parsed.values["delivery"] ??= configured.delivery;
          target = configured.adapter ?? target;
        }
        if (
          parsed.values["delivery"] !== undefined &&
          !["project", "package"].includes(String(parsed.values["delivery"]))
        )
          return usage("--delivery must be project or package");
        return await runInspect({
          ...(parsed.values["delivery"] === undefined
            ? {}
            : { delivery: parsed.values["delivery"] as "project" | "package" }),
          target,
          ...(typeof parsed.values["capability"] === "string" ? { capability: parsed.values["capability"] } : {}),
          ...(typeof parsed.values["component"] === "string" ? { component: parsed.values["component"] } : {}),
          ...(typeof parsed.values["field"] === "string" ? { field: parsed.values["field"] } : {}),
          ...(typeof parsed.values["version"] === "string" ? { version: parsed.values["version"] } : {}),
          ...(parsed.values["json"] ? { json: true } : {}),
          registry,
          io,
        });
      }
      case "dispatch": {
        const target = targets?.length === 1 ? targets[0] : undefined;
        if (target === undefined) {
          io.stderr("dispatch requires exactly one --target, e.g. `hooknostic dispatch --target claude`.");
          return 2;
        }
        let input: string;
        if (typeof parsed.values["events"] === "string") {
          // An unreadable events file is the user's mistake, exit 2 (#208).
          try {
            input = await readFile(resolve(parsed.values["events"]), "utf8");
          } catch (error) {
            io.stderr(`cannot read --events ${JSON.stringify(parsed.values["events"])}: ${errorMessage(error)}`);
            return 2;
          }
        } else input = await readStdin();
        // Hooks run in this process. The hooknostic command owns it, so it
        // treats them as a command shim does: their stdout stays out of the
        // result lines, a handle one leaks cannot hold the process open, and,
        // unless --unguarded, the hook source cannot end the run (#189).
        // The guard goes first: it owns process.exit before anything loads.
        const guarded = ownsProcess && parsed.values["unguarded"] !== true ? guardDispatch() : undefined;
        const protocol = ownsProcess ? claimProtocolStdout() : undefined;
        const writes: Promise<void>[] = [];
        let code: number;
        if (guarded !== undefined) setEvaluationGuard(guarded.evaluation);
        try {
          code = await runDispatchWith(
            {
              ...(typeof parsed.values["config"] === "string" ? { config: parsed.values["config"] } : {}),
              target,
              input,
              registry,
              io:
                protocol === undefined
                  ? io
                  : {
                      stdout: (text) => {
                        writes.push(protocol.writeReply(`${text}\n`));
                      },
                      stderr: io.stderr,
                    },
            },
            {
              ...(guarded === undefined
                ? {}
                : {
                    onEventStart: guarded.onEventStart,
                    onEventEnd: guarded.onEventEnd,
                    watchStall: guarded.watchStall,
                  }),
              ...(protocol === undefined ? {} : { onStaged: removeAtExit }),
            },
          );
          if (protocol !== undefined) {
            // Written before the forced-exit fallback can fire: it would truncate a pipe.
            // Inside the try: a consumer that closes stdout early (`| head`)
            // rejects a write (EPIPE, or ENOTCONN or ECONNRESET on macOS), and
            // the run must still finish.
            await Promise.all(writes);
            await protocol.release();
          }
        } catch (error) {
          // The catch below answers 2. Leave as a finished run does, so a
          // handle the config or hooks leaked cannot hold the CLI open, and
          // the guard's up-front 1 does not override the 2.
          if (protocol !== undefined) {
            await protocol.release().catch(() => {});
            if (guarded === undefined) finishCommandShim(2);
            else guarded.fail();
          }
          throw error;
        } finally {
          if (guarded !== undefined) setEvaluationGuard(undefined);
        }
        if (protocol !== undefined) {
          if (guarded === undefined) finishCommandShim(code);
          else code = guarded.finish(code);
        }
        return code;
      }
      default:
        io.stderr(`unknown command "${command}"`);
        io.stderr(CLI_USAGE);
        return 2;
    }
  } catch (error) {
    // Commands report expected failures as diagnostics; anything else must
    // still yield an exit code and a message rather than an uncaught exception.
    if (parsed.values["json"]) {
      io.stdout(
        JSON.stringify({
          schemaVersion: 1,
          command,
          ok: false,
          errors: [errorMessage(error)],
        }),
      );
      return 2;
    }
    io.stderr(`hooknostic: unexpected error: ${unexpectedErrorText(error)}`);
    return 2;
  }
}

/**
 * The catch-all's text: the stack of an Error that has one, else its message.
 * The value may be user code's, and a render that threw would reject runCli's
 * promise for an in-process caller (#199).
 */
function unexpectedErrorText(error: unknown): string {
  try {
    if (error instanceof Error) {
      const stack = error.stack;
      if (typeof stack === "string") return stack;
    }
  } catch {
    // A revoked proxy or a throwing `stack` getter; errorMessage tolerates both.
  }
  return errorMessage(error);
}
