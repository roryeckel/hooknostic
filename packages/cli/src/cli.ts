import { rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

import type { AdapterRegistry } from "@hooknostic/core";
import { loadConfig, runProject } from "@hooknostic/core";
import {
  claimProtocolStdout,
  debugEnabled,
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
import { runInspect } from "./inspect.js";
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
 * hooks when it returns, but a hook source can end the process before then;
 * an `exit` listener still runs, and must be synchronous and never throw.
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
 * the run, since it owns process listeners, scoped per event.
 *
 * Exit codes: dispatch's own 2 stands; otherwise 1 when anything was
 * reported outside a handler, else 0. Until the run finishes, leaving is 1:
 * the results are not all out.
 */
function guardDispatch() {
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
  return {
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

export async function runCli(argv: string[], options?: RunCliOptions): Promise<number> {
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

  try {
    if (parsed.values["dry-run"] && command !== "sync") throw new Error("--dry-run is only supported by sync");
    if (parsed.values["unguarded"] && command !== "dispatch")
      throw new Error("--unguarded is only supported by dispatch");
    switch (command) {
      case "init":
        if (!parsed.values["local"]) throw new Error("init requires --local");
        return await runInit(
          typeof parsed.values["config"] === "string" ? parsed.values["config"] : "hooknostic.config.ts",
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
          if (!loaded.config) throw new Error(loaded.diagnostics.map((d) => d.message).join("\n"));
          const configured = Object.hasOwn(loaded.config.targets, target) ? loaded.config.targets[target] : undefined;
          if (!configured) throw new Error(`target ${target} is not configured`);
          parsed.values["version"] ??= configured.version;
          parsed.values["delivery"] ??= configured.delivery;
          target = configured.adapter ?? target;
        }
        if (
          parsed.values["delivery"] !== undefined &&
          !["project", "package"].includes(String(parsed.values["delivery"]))
        )
          throw new Error("--delivery must be project or package");
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
        const input =
          typeof parsed.values["events"] === "string"
            ? await readFile(resolve(parsed.values["events"]), "utf8")
            : await readStdin();
        // Hooks run in this process. Without an injected io this is the real
        // CLI, so it treats them as a command shim does: their stdout stays out
        // of the result lines, a handle one leaks cannot hold the process open,
        // and, unless --unguarded, the hook source cannot end the run (#189).
        // The guard goes first: it owns process.exit before anything loads.
        const guarded = options?.io === undefined && parsed.values["unguarded"] !== true ? guardDispatch() : undefined;
        const protocol = options?.io === undefined ? claimProtocolStdout() : undefined;
        const writes: Promise<void>[] = [];
        let code: number;
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
              ...(guarded === undefined ? {} : { onEventStart: guarded.onEventStart, onEventEnd: guarded.onEventEnd }),
              ...(protocol === undefined ? {} : { onStaged: removeAtExit }),
            },
          );
          if (protocol !== undefined) {
            // Written before the forced-exit fallback can fire: it would truncate a pipe.
            // Inside the try: a consumer that closes stdout early (`| head`)
            // rejects a write with EPIPE, and the run must still finish.
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
          errors: [error instanceof Error ? error.message : String(error)],
        }),
      );
      return 2;
    }
    io.stderr(
      `hooknostic: unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    return 2;
  }
}
