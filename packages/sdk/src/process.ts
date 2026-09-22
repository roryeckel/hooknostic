import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";

/**
 * Run a subprocess from a hook, the way a hook should.
 *
 * Every hook that shells out needs the same four things, and each is easy to
 * get wrong in ways that fail silently under fail-open dispatch:
 *
 * - **Its output is captured, never inherited.** A command harness reads the
 *   hook's stdout as its reply; a child writing there corrupts it
 *   (docs/writing-hooks-safely.md).
 * - **It ends when the hook's budget does.** Pass `ctx.signal`: when dispatch
 *   abandons the hook, the child is killed too -- its whole tree, since a
 *   `.cmd` shim or a shell script leaves the real work in a grandchild that
 *   killing the direct child would orphan.
 * - **It starts on Windows.** Node refuses to spawn a `.cmd`/`.bat` file
 *   directly, and much of what a hook calls is one (`az`, `npx`, npm global
 *   shims). A bare command name is looked up on PATH with PATHEXT, and a batch
 *   file is run through `cmd.exe` with the argument escaping the MCP launcher
 *   uses, which was measured rather than reasoned (see core's mcp-launcher).
 * - **It never throws.** A missing program, a timeout or an abort is a result
 *   with a `failure`, so a hook can degrade to "no effect" without a
 *   try/catch around every call.
 *
 * Nothing is kept between calls (ADR-0002).
 */

export interface RunProcessOptions {
  /** Working directory; defaults to the hook process's own. */
  cwd?: string;
  /** Child environment; defaults to the hook process's own. */
  env?: Record<string, string | undefined>;
  /** Written to the child's stdin, which is then closed. Without it stdin is closed at once. */
  input?: string;
  /** Kills the child's process tree when aborted. Pass the hook's `ctx.signal`. */
  signal?: AbortSignal;
  /** A limit of the call's own, in milliseconds, in addition to `signal`. */
  timeoutMs?: number;
  /** Largest stdout or stderr kept, in bytes, before the child is killed. Default 1 MiB. */
  maxOutputBytes?: number;
}

export type ProcessFailureKind = "spawn" | "aborted" | "timeout" | "output-limit";

export interface ProcessResult {
  /** True when the child exited with code 0 and nothing cut it short. */
  ok: boolean;
  /** The exit code, or `null` when the child was killed or never started. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Why the call did not run to completion, when it did not. */
  failure?: {
    kind: ProcessFailureKind;
    message: string;
    /**
     * Set when the call cut the child short (abort, timeout, output limit):
     * `true` once its whole process tree is known to be gone, `false` when
     * only the direct child could be terminated, so something it started may
     * still be running. The message says why.
     */
    treeKilled?: boolean;
  };
}

/** cmd.exe metacharacters, as cross-spawn escapes them. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeCommand(command: string): string {
  return command.replace(CMD_META, "^$1");
}

/**
 * Quote one argument for `cmd.exe /s /c "..."`, then caret-escape it twice:
 * once for the outer cmd.exe and once for a batch file that forwards `%*` to
 * the program it wraps, which is what npm and `az` shims do.
 */
function escapeArgument(argument: string): string {
  let quoted = argument.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, "$1$1");
  quoted = `"${quoted}"`.replace(CMD_META, "^$1");
  return quoted.replace(CMD_META, "^$1");
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * One key per variable, as Windows has: `{ ...process.env, PATH: x }` over an
 * inherited `Path` holds both spellings, and the one written last is the one
 * the caller meant. Node would keep whichever sorts first instead, so the
 * command lookup and the child could each read a different PATH; handing the
 * child this same collapsed copy is what makes them agree.
 */
function windowsEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const byName = new Map<string, [string, string | undefined]>();
  for (const [key, value] of Object.entries(env)) {
    const name = key.toUpperCase();
    // Deleted first so the survivor takes the later position as well as value.
    byName.delete(name);
    byName.set(name, [key, value]);
  }
  return Object.fromEntries(byName.values());
}

/** Case-insensitive, because Windows spells it `Path` as often as `PATH`; `env` holds one spelling. */
function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/**
 * The cmd.exe that runs a batch file.
 *
 * It is how this helper runs a batch file, not the caller's program, so it
 * must not hinge on the caller's environment: a hook passing a minimal env (no
 * ComSpec, a PATH without System32) still gets one. Each candidate is checked
 * to exist, so a stale ComSpec anywhere falls through to the next rather than
 * failing the call: the caller's own choice, then the system's, then this
 * process's, and last a PATH lookup.
 */
function commandInterpreter(env: Record<string, string | undefined>): string {
  const systemRoot = envValue(env, "SYSTEMROOT") ?? process.env["SystemRoot"] ?? "C:\\Windows";
  const candidates = [envValue(env, "COMSPEC"), join(systemRoot, "System32", "cmd.exe"), process.env["ComSpec"]];
  return candidates.find((candidate) => candidate !== undefined && candidate !== "" && isFile(candidate)) ?? "cmd.exe";
}

/** A bare Windows command name resolved the way cmd.exe would, or the name unchanged. */
function resolveWindowsCommand(command: string, env: Record<string, string | undefined>): string {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) return command;
  const extensions = (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const candidates = extname(command) === "" ? extensions.map((extension) => command + extension) : [command];
  for (const directory of (envValue(env, "PATH") ?? "").split(delimiter)) {
    if (directory === "") continue;
    for (const candidate of candidates) {
      const path = join(directory, candidate);
      if (isFile(path)) return path;
    }
  }
  return command;
}

/**
 * Kill a child and everything it started, and say whether that is known to
 * have worked.
 *
 * Resolves `undefined` once the tree is gone, or a reason when it may not be.
 * In that case the direct child has still been terminated, as a fallback, so
 * at worst a grandchild survives -- and the caller is told so rather than told
 * the call was cleanly stopped. taskkill can refuse (access denied under a
 * restricted token or a job object), and a process group can be out of reach.
 */
function killTree(child: ReturnType<typeof spawn>): Promise<string | undefined> {
  const pid = child.pid;
  if (pid === undefined) return Promise.resolve(undefined);
  const fallback = (reason: string) => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
    return `${reason}; only the direct child was terminated, so a process it started may still be running`;
  };
  if (process.platform !== "win32") {
    try {
      // The child leads its own process group (spawned detached), so this
      // reaches whatever it started as well.
      process.kill(-pid, "SIGKILL");
      return Promise.resolve(undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return Promise.resolve(undefined);
      return Promise.resolve(fallback(`the process group could not be killed (${(error as Error).message})`));
    }
  }
  return new Promise((resolveKill) => {
    let settled = false;
    const done = (reason: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveKill(reason === undefined ? undefined : fallback(reason));
    };
    // Bounded: a taskkill that hangs must not keep the hook's call open.
    const timer = setTimeout(() => done("taskkill did not finish"), 5_000);
    let killer: ReturnType<typeof spawn>;
    try {
      killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      done(`taskkill could not start (${(error as Error).message})`);
      return;
    }
    const output: Buffer[] = [];
    killer.stderr?.on("data", (chunk: Buffer) => output.push(chunk));
    killer.on("error", (error) => done(`taskkill could not start (${error.message})`));
    killer.on("close", (code) => {
      if (code === 0) return done(undefined);
      // 128: the child had already exited, and a tree cannot be walked from a
      // root that is gone -- so whatever it started is unaccounted for.
      if (code === 128) return done("the child had exited before taskkill could walk its tree");
      const said = Buffer.concat(output).toString("utf8").trim().split(/\r?\n/).at(-1);
      done(`taskkill failed (${said || `exit code ${code}`})`);
    });
  });
}

export function runProcess(
  command: string,
  args: readonly string[] = [],
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  const given = options.env ?? process.env;
  const env = process.platform === "win32" ? windowsEnvironment(given) : given;
  // Inline rather than a module constant, so a bundle that never calls this
  // carries none of it.
  const limit = options.maxOutputBytes ?? 1024 * 1024;

  let file = command;
  let argv = [...args];
  let verbatim = false;
  if (process.platform === "win32") {
    file = resolveWindowsCommand(command, env);
    if (/\.(cmd|bat)$/i.test(file)) {
      argv = ["/d", "/s", "/c", `"${[escapeCommand(file), ...args.map(escapeArgument)].join(" ")}"`];
      file = commandInterpreter(env);
      verbatim = true;
    }
  }

  return new Promise<ProcessResult>((resolvePromise) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const sizes = { stdout: 0, stderr: 0 };
    let settled = false;
    // Set while a kill is in flight, so an exit the kill itself causes does
    // not resolve first as an ordinary result.
    let stopping = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (exitCode: number | null, failure?: ProcessResult["failure"], fromStop = false) => {
      if (settled || (stopping && !fromStop)) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({
        ok: failure === undefined && exitCode === 0,
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        ...(failure === undefined ? {} : { failure }),
      });
    };

    if (options.signal?.aborted) {
      finish(null, { kind: "aborted", message: `${command} was not started: the hook was already aborted` });
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, argv, {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      finish(null, { kind: "spawn", message: error instanceof Error ? error.message : String(error) });
      return;
    }

    // Cutting a child short resolves once the kill has been confirmed or has
    // fallen back, not on `close`: a grandchild that outlives the kill can
    // hold the pipes open indefinitely.
    const stop = (failure: { kind: ProcessFailureKind; message: string }) => {
      if (settled || stopping) return;
      stopping = true;
      child.stdout?.destroy();
      child.stderr?.destroy();
      void killTree(child).then((uncertain) =>
        finish(
          null,
          uncertain === undefined
            ? { ...failure, treeKilled: true }
            : { ...failure, message: `${failure.message}; ${uncertain}`, treeKilled: false },
          true,
        ),
      );
    };
    function onAbort() {
      stop({ kind: "aborted", message: `${command} was stopped: the hook was aborted` });
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(
        () => stop({ kind: "timeout", message: `${command} timed out after ${options.timeoutMs}ms` }),
        options.timeoutMs,
      );
    }

    const collect = (name: "stdout" | "stderr", chunks: Buffer[]) => (chunk: Buffer) => {
      if (settled) return;
      sizes[name] += chunk.length;
      if (sizes[name] > limit) {
        chunks.push(chunk.subarray(0, chunk.length - (sizes[name] - limit)));
        stop({ kind: "output-limit", message: `${command} wrote more than ${limit} bytes to ${name}` });
        return;
      }
      chunks.push(chunk);
    };
    child.stdout?.on("data", collect("stdout", stdout));
    child.stderr?.on("data", collect("stderr", stderr));
    child.on("error", (error) => finish(null, { kind: "spawn", message: error.message }));
    child.on("close", (code) => finish(code));

    // A child that exits without reading its input closes the pipe under us.
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.input);
  });
}
