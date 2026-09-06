import { parseArgs } from "node:util";
import type { AdapterRegistry } from "@hooknostic/core";
import { runBuild } from "./build.js";
import type { CommandIO } from "./check.js";
import { runCheck } from "./check.js";
import { runDoctor } from "./doctor.js";
import { runInspect } from "./inspect.js";
import { defaultAdapterRegistry } from "./registry.js";

export const CLI_USAGE = `hooknostic — portable lifecycle hooks for coding-agent harnesses

Usage:
  hooknostic check   [--config <path>] [--target <a,b>] [--json]
  hooknostic build   [--config <path>] [--target <a,b>] [--json]
  hooknostic doctor  [--json]
  hooknostic inspect <target> [--capability <id> | --component <id>] [--version <range>] [--json]

Options:
  --config <path>     Path to hooknostic.config.ts (default ./hooknostic.config.ts)
  --target <a,b>      Narrow the configured target set (never adds targets)
  --capability <id>   Inspect a single capability
  --component <id>    Inspect a single Agent Plugin component
  --version <range>   Harness version range for inspect
  --json              Machine-readable output
  -h, --help          Show this help
`;

export interface RunCliOptions {
  registry?: AdapterRegistry;
  io?: CommandIO;
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
        target: { type: "string" },
        capability: { type: "string" },
        component: { type: "string" },
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
      ? parsed.values["target"].split(",").map((t) => t.trim()).filter(Boolean)
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
    switch (command) {
      case "check":
        return await runCheck({
          ...(typeof parsed.values["config"] === "string"
            ? { config: parsed.values["config"] }
            : {}),
          ...(targets ? { targets } : {}),
          ...(parsed.values["json"] ? { json: true } : {}),
          registry,
          io,
        });
      case "build":
        return await runBuild({
          ...(typeof parsed.values["config"] === "string"
            ? { config: parsed.values["config"] }
            : {}),
          ...(targets ? { targets } : {}),
          ...(parsed.values["json"] ? { json: true } : {}),
          registry,
          io,
        });
      case "doctor":
        return await runDoctor({
          ...(parsed.values["json"] ? { json: true } : {}),
          registry,
          io,
        });
      case "inspect": {
        const target = parsed.positionals[0];
        if (target === undefined) {
          io.stderr("inspect requires a target, e.g. `hooknostic inspect claude`.");
          return 2;
        }
        return await runInspect({
          target,
          ...(typeof parsed.values["capability"] === "string"
            ? { capability: parsed.values["capability"] }
            : {}),
          ...(typeof parsed.values["component"] === "string"
            ? { component: parsed.values["component"] }
            : {}),
          ...(typeof parsed.values["version"] === "string"
            ? { version: parsed.values["version"] }
            : {}),
          ...(parsed.values["json"] ? { json: true } : {}),
          registry,
          io,
        });
      }
      default:
        io.stderr(`unknown command "${command}"`);
        io.stderr(CLI_USAGE);
        return 2;
    }
  } catch (error) {
    // Commands report expected failures as diagnostics; anything else must
    // still yield an exit code and a message rather than an uncaught exception.
    io.stderr(
      `hooknostic: unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    return 1;
  }
}
