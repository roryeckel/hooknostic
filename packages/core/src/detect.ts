import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { DetectionResult } from "./adapter.js";

const execFileAsync = promisify(execFile);

/**
 * Detection is advisory -- `doctor` reports it and nothing else consumes it --
 * so a harness that hangs on `--version` must not hang the CLI.
 */
const DETECT_TIMEOUT_MS = 15_000;

/**
 * The first `MAJOR.MINOR.PATCH` in the probe's output. Every harness so far
 * prints its version somewhere in a one-line banner ("codex-cli 0.151.0"),
 * and an adapter whose harness does not can implement `detect` itself.
 */
const VERSION_PATTERN = /(\d+\.\d+\.\d+)/;

/**
 * Only literals, so joining them into a shell line below cannot change the
 * command's meaning. Deliberately narrow: no spaces, quotes, or shell
 * metacharacters, which is every probe any adapter has needed.
 */
const SHELL_SAFE = /^[-A-Za-z0-9][-A-Za-z0-9._=]*$/;

export interface DetectCommandOptions {
  /** Probe arguments. Default `["--version"]`. Must be shell-safe literals. */
  args?: readonly string[];
  /** `detail` reported when the probe fails. Default names the binary. */
  notFoundDetail?: string;
}

/**
 * How a probe reaches `child_process`, split out so the DEP0190 property is
 * testable on both platforms from either one.
 *
 * The invariant: `shell` and a non-empty `args` are never both set. Node 24
 * deprecates that pairing because the args are concatenated onto the command
 * line rather than escaped -- putting the whole line in `file` is the fix, not
 * a workaround, since concatenation is what a shell spawn does either way.
 */
export function detectSpawnArgs(
  parts: readonly string[],
  platform: NodeJS.Platform,
): { file: string; args: string[]; shell: boolean } {
  return platform === "win32"
    ? { file: parts.join(" "), args: [], shell: true }
    : { file: parts[0] ?? "", args: parts.slice(1), shell: false };
}

/**
 * Run a harness CLI's version probe and report what it says.
 *
 * Shared by the bundled adapters, and the supported way for a third-party one
 * to implement {@link DetectionResult} -- the Windows path below is subtle
 * enough that duplicating it is how it goes wrong.
 *
 * On Windows the harness CLIs are usually npm PATHEXT shims (`codex.cmd`,
 * `opencode.cmd`) that `spawn` will not resolve without a shell; a native
 * install (`claude.exe`) resolves either way, so the shell path is the one
 * that covers both. Node 24 deprecates passing an args *array* alongside
 * `shell: true` (DEP0190 -- the args are concatenated onto the command line
 * rather than escaped), so the shell path passes the whole line as the command
 * and no args at all. Same spawn, no security deprecation printed over
 * `doctor`'s output on every run.
 *
 * @throws if any part would need shell quoting -- a programming error in the
 * calling adapter, deterministic on constant input, so it surfaces on the
 * first run rather than becoming an injection in the field.
 */
export async function detectCommandVersion(
  binary: string,
  options: DetectCommandOptions = {},
): Promise<DetectionResult> {
  const args = options.args ?? ["--version"];
  const parts = [binary, ...args];

  const unsafe = parts.filter((part) => !SHELL_SAFE.test(part));
  if (unsafe.length > 0) {
    throw new Error(
      `detectCommandVersion: ${unsafe.map((part) => JSON.stringify(part)).join(", ")} ` +
        `would need shell quoting; version probes must be plain literals`,
    );
  }

  const spawn = detectSpawnArgs(parts, process.platform);
  try {
    const { stdout } = await execFileAsync(spawn.file, spawn.args, {
      shell: spawn.shell,
      timeout: DETECT_TIMEOUT_MS,
    });
    const detail = stdout.trim();
    const version = VERSION_PATTERN.exec(stdout)?.[1];
    return version !== undefined ? { installed: true, version, detail } : { installed: true, detail };
  } catch {
    return {
      installed: false,
      detail: options.notFoundDetail ?? `${binary} not found on PATH`,
    };
  }
}
