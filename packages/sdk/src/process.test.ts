import type * as ChildProcess from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runProcess } from "./process.js";

// Lets a test make taskkill refuse, as it does under a restricted token or a
// job object, without needing such an environment.
const killer = vi.hoisted(() => ({ refuse: false }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], options: ChildProcess.SpawnOptions) =>
      killer.refuse && command === "taskkill"
        ? actual.spawn(process.execPath, ["-e", "console.error('ERROR: Access is denied.'); process.exit(1)"], options)
        : actual.spawn(command, args, options),
  };
});

const node = process.execPath;
const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "hooknostic-process-"));
  cleanup.push(dir);
  return dir;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("runProcess", () => {
  it("captures both streams and the exit code, feeding input and honouring cwd", async () => {
    const cwd = scratch();
    const result = await runProcess(
      node,
      [
        "-e",
        `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
          console.log(JSON.stringify({ input: s, cwd: require("path").basename(process.cwd()) }));
          console.error("to stderr");
        })`,
      ],
      { cwd, input: "héllo" },
    );
    expect(result).toMatchObject({ ok: true, exitCode: 0, stderr: "to stderr\n" });
    expect(JSON.parse(result.stdout)).toEqual({ input: "héllo", cwd: basename(cwd) });
    expect(result.failure).toBeUndefined();
  });

  it("reports a non-zero exit as a result, not a failure", async () => {
    const result = await runProcess(node, ["-e", "process.exit(3)"]);
    expect(result).toMatchObject({ ok: false, exitCode: 3 });
    expect(result.failure).toBeUndefined();
  });

  it("never throws for a program that does not exist", async () => {
    const result = await runProcess("hooknostic-no-such-program", ["x"]);
    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("spawn");
  });

  it("kills the whole tree when the signal aborts, and resolves at once", async (context) => {
    // A shell in the middle, the way an az.cmd or a hook script wraps the real
    // program: killing only the direct child leaves the grandchild running
    // and, holding the pipes, the call pending. (A Node child is no test: on
    // Windows libuv ties a Node process's own children to it with a job object.)
    const dir = scratch();
    const pidFile = join(dir, "grandchild.pid");
    writeFileSync(
      join(dir, "grand.js"),
      `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`,
    );
    let command: string;
    let args: string[];
    if (process.platform === "win32") {
      writeFileSync(join(dir, "wrap.cmd"), `@"${node}" "%~dp0grand.js"\r\n@echo done\r\n`);
      [command, args] = [join(dir, "wrap.cmd"), []];
    } else {
      writeFileSync(join(dir, "wrap.sh"), `"${node}" "$(dirname "$0")/grand.js"\necho done\n`);
      [command, args] = ["sh", [join(dir, "wrap.sh")]];
    }
    const controller = new AbortController();
    const pending = runProcess(command, args, { signal: controller.signal });
    await until(() => {
      try {
        return readFileSync(pidFile, "utf8") !== "";
      } catch {
        return false;
      }
    });
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    controller.abort();
    const result = await pending;
    expect(result.failure?.kind).toBe("aborted");
    expect(result.exitCode).toBeNull();
    if (result.failure?.treeKilled === false) {
      // Where taskkill is denied (a restricted token or job object) the
      // documented fallback applies instead: say so, and leave no grandchild
      // behind. The tree kill itself cannot be observed here, so the test is
      // reported skipped rather than passed.
      expect(result.failure.message).toContain("only the direct child was terminated");
      try {
        process.kill(grandchild);
      } catch {
        // Already gone, or out of reach for this process too.
      }
      context.skip();
    }
    expect(result.failure?.treeKilled).toBe(true);
    await until(() => !alive(grandchild), 5_000);
  });

  /** Start a child that records its own pid and runs until killed. */
  async function lingering(signal: AbortSignal) {
    const pidFile = join(scratch(), "child.pid");
    const pending = runProcess(
      node,
      [
        "-e",
        `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
      ],
      { signal },
    );
    await until(() => {
      try {
        return readFileSync(pidFile, "utf8") !== "";
      } catch {
        return false;
      }
    });
    return { pending, pid: Number(readFileSync(pidFile, "utf8")) };
  }

  it.runIf(process.platform === "win32")(
    "terminates the direct child when taskkill refuses, and says the tree may survive",
    async () => {
      killer.refuse = true;
      try {
        const controller = new AbortController();
        const { pending, pid } = await lingering(controller.signal);
        controller.abort();
        const result = await pending;
        expect(result.failure).toMatchObject({ kind: "aborted", treeKilled: false });
        expect(result.failure?.message).toContain("Access is denied");
        expect(result.failure?.message).toContain("only the direct child was terminated");
        await until(() => !alive(pid), 5_000);
      } finally {
        killer.refuse = false;
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "terminates the direct child when its process group is out of reach, and says so",
    async () => {
      const realKill = process.kill.bind(process);
      const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (typeof pid === "number" && pid < 0)
          throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
        return realKill(pid, signal);
      });
      try {
        const controller = new AbortController();
        const { pending, pid } = await lingering(controller.signal);
        controller.abort();
        const result = await pending;
        expect(result.failure).toMatchObject({ kind: "aborted", treeKilled: false });
        expect(result.failure?.message).toContain("only the direct child was terminated");
        spy.mockRestore();
        await until(() => !alive(pid), 5_000);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("does not start a program for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runProcess(node, ["-e", "require('fs').writeFileSync('should-not-exist', '')"], {
      signal: controller.signal,
      cwd: scratch(),
    });
    expect(result.failure?.kind).toBe("aborted");
  });

  it("stops at its own timeout", async () => {
    const started = Date.now();
    const result = await runProcess(node, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 200 });
    expect(result.failure?.kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("cuts off a child that writes more than the limit", async () => {
    const result = await runProcess(node, ["-e", "setInterval(() => process.stdout.write('x'.repeat(4096)), 1)"], {
      maxOutputBytes: 10_000,
    });
    expect(result.failure?.kind).toBe("output-limit");
    expect(result.stdout.length).toBe(10_000);
  });

  it.runIf(process.platform === "win32")(
    "runs a batch-file shim found on PATH, passing arguments through it unaltered",
    async () => {
      // The shape of an npm or az shim: a .cmd that forwards %* to a program.
      const dir = scratch();
      writeFileSync(join(dir, "echo.mjs"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
      writeFileSync(join(dir, "hn-echo.cmd"), `@"${node}" "%~dp0echo.mjs" %*\r\n`);
      // Quote-flipping cases matter most: an embedded quote turns cmd's quoting
      // off for what follows, so a metacharacter after it is live on the second
      // pass unless it was escaped twice.
      const args = [
        "plain",
        "with space",
        'a "quoted" word',
        'he said "a & b"',
        '" & echo INJECTED & "',
        "a&b|c",
        "(parens)",
        "caret^",
        "<angle>",
        "trailing\\",
        "",
      ];
      const result = await runProcess("hn-echo", args, {
        env: { ...process.env, PATH: `${dir}${delimiter}${process.env["PATH"] ?? ""}` },
      });
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual(args);
    },
  );

  it.runIf(process.platform === "win32")(
    "runs a batch file for a caller whose environment names no ComSpec and no System32",
    async () => {
      const dir = scratch();
      writeFileSync(join(dir, "ok.cmd"), "@echo ran\r\n");
      const result = await runProcess(join(dir, "ok.cmd"), [], { env: { PATH: dir } });
      expect(result.failure).toBeUndefined();
      expect(result.stdout.trim()).toBe("ran");
    },
  );

  it.runIf(process.platform === "win32")(
    "runs a batch file past a stale ComSpec, in the caller's environment or this process's",
    async () => {
      const dir = scratch();
      writeFileSync(join(dir, "ok.cmd"), "@echo ran\r\n");
      const stale = join(dir, "gone", "cmd.exe");
      const inherited = process.env["ComSpec"];
      process.env["ComSpec"] = stale;
      try {
        for (const env of [{ PATH: dir }, { PATH: dir, ComSpec: stale }]) {
          const result = await runProcess(join(dir, "ok.cmd"), [], { env });
          expect(result.failure, JSON.stringify(env)).toBeUndefined();
          expect(result.stdout.trim()).toBe("ran");
        }
      } finally {
        if (inherited === undefined) delete process.env["ComSpec"];
        else process.env["ComSpec"] = inherited;
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "looks a command up in the same PATH the child receives when the environment spells it twice",
    async () => {
      // `{ ...process.env, PATH: x }` over an inherited `Path` yields both
      // spellings. Whichever one the caller wrote last is the one they meant,
      // in either order, and the lookup and the child must agree on it.
      const dir = scratch();
      // Reports the first PATH entry the child itself sees, alongside its args.
      writeFileSync(
        join(dir, "echo.mjs"),
        `console.log(JSON.stringify([process.env.PATH.split(${JSON.stringify(delimiter)})[0], ...process.argv.slice(2)]));\n`,
      );
      writeFileSync(join(dir, "hn-echo.cmd"), `@"${node}" "%~dp0echo.mjs" %*\r\n`);
      const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
      const stale = process.env["PATH"] ?? "";
      const fresh = `${dir}${delimiter}${stale}`;
      for (const env of [
        { ...inherited, Path: stale, PATH: fresh },
        { ...inherited, PATH: stale, Path: fresh },
      ]) {
        const result = await runProcess("hn-echo", ["ok"], { env });
        expect(result.failure, JSON.stringify(Object.keys(env).filter((k) => /^path$/i.test(k)))).toBeUndefined();
        expect(JSON.parse(result.stdout)).toEqual([dir, "ok"]);
      }
    },
  );
});
