import { parseArgs } from "node:util";
import type { AdapterRegistry } from "@hooknostic/core";
import type { CommandIO } from "./check.js";
import { runCheck } from "./check.js";
import { defaultAdapterRegistry } from "./registry.js";

export const CLI_USAGE = `hooknostic — portable lifecycle hooks for coding-agent harnesses

Usage:
  hooknostic check   [--config <path>] [--target <a,b>] [--json]
  hooknostic build   [--config <path>] [--target <a,b>] [--json]
  hooknostic doctor  [--json]
  hooknostic inspect <target> [--capability <id>] [--json]

Options:
  --config <path>     Path to hooknostic.config.ts (default ./hooknostic.config.ts)
  --target <a,b>      Narrow the configured target set (never adds targets)
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

  switch (command) {
    case "check":
      return runCheck({
        ...(typeof parsed.values["config"] === "string"
          ? { config: parsed.values["config"] }
          : {}),
        ...(targets ? { targets } : {}),
        ...(parsed.values["json"] ? { json: true } : {}),
        registry,
        io,
      });
    case "build":
    case "doctor":
    case "inspect":
      io.stderr(`"${command}" is not implemented yet.`);
      return 2;
    default:
      io.stderr(`unknown command "${command}"`);
      io.stderr(CLI_USAGE);
      return 2;
  }
}
