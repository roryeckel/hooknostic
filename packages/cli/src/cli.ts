import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import type { AdapterRegistry } from "@hooknostic/core";
import { loadConfig, runProject } from "@hooknostic/core";
import { claimProtocolStdout, finishCommandShim } from "@hooknostic/runtime";

import { runBuild } from "./build.js";
import type { CommandIO } from "./check.js";
import { runCheck } from "./check.js";
import { runDispatch } from "./dispatch.js";
import { runDoctor } from "./doctor.js";
import { runInit } from "./init.js";
import { runInspect } from "./inspect.js";
import { defaultAdapterRegistry } from "./registry.js";

export const CLI_USAGE = `hooknostic — portable lifecycle hooks for coding-agent harnesses

Usage:
  hooknostic check   [--config <path>] [--target <a,b>] [--json]
  hooknostic build   [--config <path>] [--target <a,b>] [--json]
  hooknostic init --local [--config <path>] [--json]
  hooknostic sync [--config <path>] [--dry-run] [--json]
  hooknostic verify [--config <path>] [--json]
  hooknostic recover [--config <path>] [--json]
  hooknostic doctor  [--config <path>] [--json]
  hooknostic inspect <target> [--capability <id> | --component <id>] [--version <range>] [--delivery <project|package>] [--config <path>] [--json]
  hooknostic dispatch --target <id> [--events <path>] [--config <path>]

Options:
  --config <path>     Path to hooknostic.config.ts (default ./hooknostic.config.ts)
  --target <a,b>      Narrow the configured target set (never adds targets)
  --events <path>     JSON Lines of portable events to dispatch (default: stdin)
  --capability <id>   Inspect a single capability
  --component <id>    Inspect a single Agent Plugin component
  --version <range>   Harness version range for inspect
  --delivery <scope>  Project or package component support for inspect
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
        delivery: { type: "string" },
        events: { type: "string" },
        version: { type: "string" },
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
          const configured = loaded.config.targets[target];
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
        // of the result lines, and a handle one leaks cannot hold the process open.
        const protocol = options?.io === undefined ? claimProtocolStdout() : undefined;
        const writes: Promise<void>[] = [];
        const code = await runDispatch({
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
        });
        if (protocol !== undefined) {
          // Written before the forced-exit fallback can fire: it would truncate a pipe.
          await Promise.all(writes);
          await protocol.release();
          finishCommandShim(code);
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
