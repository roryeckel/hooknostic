import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { claudeHarness } from "@hooknostic/adapter-claude";
import { buildProject } from "@hooknostic/core";

import { runCli } from "./cli.js";
import { defaultAdapterRegistry } from "./registry.js";

// #193: every command but dispatch evaluates the config and the hook source
// under the command-shim guard. These spawn the built CLI, as a user runs it.

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CLI_BIN = resolve(HERE, "../bin/hooknostic.mjs");
const CLI_INDEX = pathToFileURL(resolve(HERE, "../dist/index.js")).href;
// A failure that is not caught leaves the child to this timeout, which kills it.
const SPAWN_TIMEOUT_MS = 20_000;
// A test of several spawns outlasts its children's timeouts, run a few at a
// time, so a child left hanging fails on its signal rather than on this.
const SPAWNS_TIMEOUT_MS = 120_000;

const TARGETS = `{ claude: { version: ${JSON.stringify(claudeHarness.recommendedRange)}, delivery: "project", output: ".hooknostic/artifacts/claude" } }`;
const CONFIG_EXPORT = `export default { project: { root: "." }, entry: "./hooks.ts", targets: ${TARGETS} };`;
const ENTRY_EXPORT = `export default { name: "probe", hooks: [{ event: "prompt.before", id: "p", capabilities: {}, run() {} }] };`;

type Subject = "config" | "entry";

interface Fixture {
  /** Replaces the config module; by default a valid one. */
  config?: string;
  /** Replaces the entry module; by default a valid one. */
  entry?: string;
}

/** A fixture whose `subject` runs `prelude` before its valid default export. */
const atLoad = (subject: Subject, prelude: string): Fixture =>
  subject === "config" ? { config: `${prelude}\n${CONFIG_EXPORT}` } : { entry: `${prelude}\n${ENTRY_EXPORT}` };

interface Run {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Every output line, trimmed. */
  lines: string[];
  configPath: string;
  entryPath: string;
  /** Staged-module directories the run left in its temp directory. */
  evalDirs: string[];
}

interface RunOptions {
  debug?: boolean;
  closeStdoutEarly?: boolean;
  /** Written to the child's stdin; by default it is closed empty. */
  input?: string;
  /** More files for the project directory, by name. */
  files?: Record<string, string>;
  /** What node runs instead of the CLI: its arguments, given the project's paths. */
  node?: (paths: { dir: string; configPath: string }) => string[];
}

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

// Each run's temp directory: the CLI stages each module it evaluates in a
// hooknostic-eval-* directory there, which must never outlive it.
let evalDirsLeft: string[] = [];
afterEach(() => {
  const left = evalDirsLeft;
  evalDirsLeft = [];
  expect(left).toEqual([]);
});

async function run(args: string[], fixture: Fixture, options: RunOptions = {}): Promise<Run> {
  const dir = await mkdtemp(join(tmpdir(), "hooknostic-evalguard-"));
  tempDirs.push(dir);
  const temp = join(dir, ".tmp");
  await mkdir(temp);
  const configPath = join(dir, "hooknostic.config.ts");
  const entryPath = join(dir, "hooks.ts");
  await writeFile(configPath, fixture.config ?? CONFIG_EXPORT);
  await writeFile(entryPath, fixture.entry ?? ENTRY_EXPORT);
  for (const [name, contents] of Object.entries(options.files ?? {})) await writeFile(join(dir, name), contents);
  const argv = options.node?.({ dir, configPath }) ?? [CLI_BIN, ...args, "--config", configPath];
  const child = spawn(process.execPath, argv, {
    cwd: dir,
    timeout: SPAWN_TIMEOUT_MS,
    env: {
      ...process.env,
      HOOKNOSTIC_DEBUG: options.debug ? "1" : "",
      TEMP: temp,
      TMP: temp,
      TMPDIR: temp,
    },
  });
  child.stdin.end(options.input ?? "");
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  // As `| head` does: the consumer goes once it has read what it wanted.
  if (options.closeStdoutEarly) child.stdout.once("data", () => child.stdout.destroy());
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const [status, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((done) =>
    child.on("close", (code, killedBy) => done([code, killedBy])),
  );
  stdout = stdout.replace(/\r\n/g, "\n");
  stderr = stderr.replace(/\r\n/g, "\n");
  const evalDirs = (await readdir(temp)).filter((name) => name.startsWith("hooknostic-eval-"));
  for (const name of evalDirs) evalDirsLeft.push(`${args[0]}: ${name}`);
  const lines = `${stdout}\n${stderr}`.split("\n").map((line) => line.trim());
  return { status, signal, stdout, stderr, lines, configPath, entryPath, evalDirs };
}

/** Runs `cases` a few at a time: each is a CLI process bundling with esbuild. */
async function runAll<T>(cases: T[], each: (item: T) => Promise<Run>): Promise<Run[]> {
  const results: Run[] = new Array(cases.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, cases.length) }, async () => {
      while (next < cases.length) {
        const index = next++;
        results[index] = await each(cases[index]!);
      }
    }),
  );
  return results;
}

const loadFailure = (result: Run, subject: Subject, message: string) =>
  `failed to load ${subject} ${subject === "config" ? result.configPath : result.entryPath}: ${message}`;

/** Node's own report of an uncaught error: a stack frame, or the version banner. */
const NODE_TRACE = /^\s+at |^Node\.js v|node:internal/m;

const SHAPES = {
  exit: {
    prelude: `process.exit(3);`,
    message: (subject: Subject) =>
      subject === "config" ? "the config called process.exit(3)" : "the hook source called process.exit(3)",
  },
  reject: { prelude: `Promise.reject(new Error("load rejection"));`, message: () => "load rejection" },
  timer: {
    prelude: `setTimeout(() => { throw new Error("load timer threw"); }, 0);`,
    message: () => "load timer threw",
  },
};

const LATE_REJECTION = `setTimeout(() => Promise.reject(new Error("late")), 10);`;

describe("a failure while the config or hook source loads", () => {
  it(
    "fails that load as HN501 and exits 2, for check and build, on every path out of the load",
    async () => {
      const cases = (["check", "build"] as const).flatMap((command) =>
        (["config", "entry"] as const).flatMap((subject) =>
          Object.entries(SHAPES).map(([shape, { prelude, message }]) => ({
            command,
            subject,
            shape,
            prelude,
            message,
          })),
        ),
      );
      const results = await runAll(cases, ({ command, subject, prelude }) => run([command], atLoad(subject, prelude)));

      const seen = results.map((result, index) => {
        const { command, subject, shape, message } = cases[index]!;
        return {
          id: `${command} ${subject} ${shape}`,
          status: result.status,
          reported: result.lines.includes(loadFailure(result, subject, message(subject))),
          trace: NODE_TRACE.test(result.stderr),
        };
      });
      expect(seen).toEqual(
        cases.map(({ command, subject, shape }) => ({
          id: `${command} ${subject} ${shape}`,
          status: 2,
          reported: true,
          trace: false,
        })),
      );
    },
    SPAWNS_TIMEOUT_MS,
  );

  it(
    "names the config, not the hook source, when the config calls process.exit",
    async () => {
      const cases = [
        ["check", `process.exit(3);`, 3],
        ["build", `process.exit(3);`, 3],
        ["sync", `process.exit(3);`, 3],
        // An exit the guard intercepts outside the import's own stack.
        ["check", `setTimeout(() => process.exit(5), 0);`, 5],
      ] as const;
      const results = await runAll([...cases], ([command, prelude]) => run([command], atLoad("config", prelude)));

      expect(
        results.map((result, index) => ({
          status: result.status,
          reported: result.lines.includes(
            loadFailure(result, "config", `the config called process.exit(${cases[index]![2]})`),
          ),
          hookSource: /hook source/.test(result.stdout + result.stderr),
        })),
      ).toEqual(Array(4).fill({ status: 2, reported: true, hookSource: false }));
    },
    SPAWNS_TIMEOUT_MS,
  );

  it(
    "fails a load that can never settle, naming what it waits on",
    async () => {
      const cases = [
        ["config", atLoad("config", `await new Promise(() => {});`), "its top-level await never settles"],
        ["entry", atLoad("entry", `await new Promise(() => {});`), "its top-level await never settles"],
        ["config", { config: `export default { then() {} };` }, "its default export is a thenable that never settles"],
        ["entry", { entry: `export default { then() {} };` }, "its default export is a thenable that never settles"],
      ] as const;
      const results = await runAll([...cases], ([, fixture]) => run(["check"], fixture));

      expect(
        results.map((result, index) => ({
          status: result.status,
          reported: result.lines.includes(loadFailure(result, cases[index]![0], cases[index]![2])),
          nodeWarning: /unsettled top-level await/.test(result.stderr),
        })),
      ).toEqual(Array(4).fill({ status: 2, reported: true, nodeWarning: false }));
    },
    SPAWNS_TIMEOUT_MS,
  );

  it("renders a rejection whose value cannot be inspected", async () => {
    const result = await run(["check"], atLoad("config", `Promise.reject(Object.create(null));`));

    expect(result.status).toBe(2);
    expect(result.lines).toContain(loadFailure(result, "config", "uninspectable thrown value"));
  });

  it("reports the entry's own exit after a config's exit escaped while it loaded", async () => {
    // The config's exit(3) comes after its load, as a stray; the entry's
    // exit(3) at load must still fail the entry's load, not leave silently.
    const result = await run(["check"], {
      config: `let n = 0; const t = setInterval(() => { if (++n === 3) { clearInterval(t); process.exit(3); } }, 0);\n${CONFIG_EXPORT}`,
      entry: `process.exit(3);\n${ENTRY_EXPORT}`,
    });

    expect(result.status).toBe(2);
    expect(result.lines).toContain(loadFailure(result, "entry", "the hook source called process.exit(3)"));
  });
});

describe("a handle user code leaks", () => {
  const LEAK = `setInterval(() => {}, 60_000);`;

  it(
    "cannot hold open a command whose load failed",
    async () => {
      const cases = [
        ...[["check"], ["build"], ["sync"], ["verify"], ["recover"], ["doctor"], ["inspect", "claude"]].map(
          (args) => [args, "config"] as const,
        ),
        ...[["check"], ["build"], ["sync"], ["verify"], ["doctor"]].map((args) => [args, "entry"] as const),
      ];
      const results = await runAll(cases, ([args, subject]) =>
        run(args, atLoad(subject, `${LEAK} throw new Error("top-level throw");`)),
      );

      expect(
        results.map((result, index) => ({
          id: `${cases[index]![0][0]} ${cases[index]![1]}`,
          signal: result.signal,
          status: result.status,
          reported: /top-level throw/.test(result.stdout + result.stderr),
        })),
      ).toEqual(
        cases.map(([args, subject]) => ({ id: `${args[0]} ${subject}`, signal: null, status: 2, reported: true })),
      );
    },
    SPAWNS_TIMEOUT_MS,
  );

  it("cannot hold open a command whose output never reports flushed", async () => {
    // A write that drops its callback: the command's last flush never hears back.
    const result = await run(
      ["check"],
      atLoad(
        "config",
        `const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, encoding) => write(chunk, typeof encoding === "string" ? encoding : undefined);
${LEAK}`,
      ),
    );

    expect({ signal: result.signal, status: result.status }).toEqual({ signal: null, status: 0 });
    expect(result.stdout).toContain("check passed");
  });

  it("cannot hold open a command that succeeded", async () => {
    const result = await run(["build"], atLoad("entry", LEAK));

    expect({ signal: result.signal, status: result.status }).toEqual({ signal: null, status: 0 });
  });
});

describe("a failure after the config or hook source loaded", () => {
  it("is reported as internal and exits 2, after the command's own output", async () => {
    const result = await run(["recover"], atLoad("config", LATE_REJECTION));

    expect(result.status).toBe(2);
    expect(result.lines).toContain("recover succeeded.");
    expect(result.lines).toContain("hooknostic internal: late");
  });

  it("cannot end the command early with an exit of its own", async () => {
    const result = await run(
      ["recover"],
      atLoad("config", `(async () => { await new Promise((r) => setTimeout(r, 10)); process.exit(4); })();`),
    );

    expect(result.status).toBe(2);
    expect(result.lines).toContain("recover succeeded.");
    expect(result.lines).toContain("hooknostic internal: the hook source called process.exit(4)");
  });

  it("cannot leave with its own code from an uncaughtException listener of its own", async () => {
    // The guard cannot unwind an exit from inside that emit, so it leaves.
    const result = await run(
      ["check"],
      atLoad(
        "config",
        `process.on("uncaughtException", () => process.exit(0)); setTimeout(() => { throw new Error("t"); }, 0);`,
      ),
    );

    expect(result.status).toBe(2);
    expect(result.lines).toContain("hooknostic internal: the hook source called process.exit(0)");
  });
});

describe("a consumer that closes stdout early", () => {
  it(
    "does not fail a command that evaluated user code",
    async () => {
      const results = await runAll([["build", "--json"], ["check", "--json"], ["build"]], (args) =>
        run(args, {}, { closeStdoutEarly: true }),
      );

      expect(results.map((result) => ({ status: result.status, stderr: result.stderr }))).toEqual(
        Array(3).fill({ status: 0, stderr: "" }),
      );
    },
    SPAWNS_TIMEOUT_MS,
  );
});

describe("the hook source's default export", () => {
  it(
    "is reported as HN501 when reading it throws",
    async () => {
      const getters = {
        error: [`throw new Error("getter threw");`, "getter threw"],
        "null prototype": [`throw Object.create(null);`, "uninspectable thrown value"],
        // Validation reads `hooks` once, and building the IR again.
        "second read": [`if (++reads > 1) throw new Error("second read threw"); return [];`, "second read threw"],
      } as const;
      const cases = (["check", "build", "doctor"] as const).flatMap((command) =>
        Object.entries(getters).map(([shape, [body, message]]) => ({ command, shape, body, message })),
      );
      const results = await runAll(cases, ({ command, body }) =>
        run([command], { entry: `let reads = 0;\nexport default { name: "probe", get hooks() { ${body} } };` }),
      );

      expect(
        results.map((result, index) => ({
          id: `${cases[index]!.command} ${cases[index]!.shape}`,
          status: result.status,
          reported: result.lines.includes(
            `invalid plugin source: reading the default export threw: ${cases[index]!.message}`,
          ),
        })),
      ).toEqual(cases.map(({ command, shape }) => ({ id: `${command} ${shape}`, status: 2, reported: true })));
    },
    SPAWNS_TIMEOUT_MS,
  );
});

describe("with HOOKNOSTIC_DEBUG", () => {
  it(
    "exits as without it, and follows an internal report with its stack",
    async () => {
      const results = await runAll(
        [
          ...Object.values(SHAPES).map(({ prelude }) => [["check"], atLoad("config", prelude)] as const),
          [["recover"], atLoad("config", LATE_REJECTION)] as const,
        ],
        ([args, fixture]) => run([...args], fixture, { debug: true }),
      );
      const [exit, reject, timer, late] = results as [Run, Run, Run, Run];

      expect(results.map((result) => result.status)).toEqual([2, 2, 2, 2]);
      expect(exit.lines).toContain(loadFailure(exit, "config", "the config called process.exit(3)"));
      expect(reject.lines).toContain(loadFailure(reject, "config", "load rejection"));
      expect(timer.lines).toContain(loadFailure(timer, "config", "load timer threw"));
      const at = late.lines.indexOf("hooknostic internal: late");
      expect(at).not.toBe(-1);
      expect(late.lines.slice(at + 1, at + 3)).toEqual(["Error: late", expect.stringMatching(/^at /)]);
    },
    SPAWNS_TIMEOUT_MS,
  );
});

describe("without the guard", () => {
  it(
    "leaves no staged module behind a thenable default export that never settles",
    async () => {
      // buildProject in a process of its own, as a programmatic caller runs
      // it: the build never settles, and the process ends once its loop empties.
      const BUILD = `import { buildProject, defaultAdapterRegistry } from ${JSON.stringify(CLI_INDEX)};
void buildProject({ configPath: process.argv[2], registry: defaultAdapterRegistry() });`;
      const NEVER = `export default { then() {} };`;
      const cases = [
        ["buildProject, config", { config: NEVER }, "build"],
        ["buildProject, entry", { entry: NEVER }, "build"],
        // Dispatch keeps its own guard, which does not watch its loads (#201).
        ["dispatch, config", { config: NEVER }, "dispatch"],
      ] as const;
      const results = await runAll([...cases], ([, fixture, how]) =>
        how === "build"
          ? run(["buildProject"], fixture, {
              files: { "build-project.mjs": BUILD },
              node: ({ dir, configPath }) => [join(dir, "build-project.mjs"), configPath],
            })
          : run(["dispatch", "--target", "claude"], fixture, {
              input: `${JSON.stringify({ event: "prompt.before", prompt: "hi" })}\n`,
            }),
      );

      expect(
        results.map((result, index) => ({ id: cases[index]![0], signal: result.signal, left: result.evalDirs.length })),
      ).toEqual(cases.map(([id]) => ({ id, signal: null, left: 0 })));
    },
    SPAWNS_TIMEOUT_MS,
  );
});

describe("in-process callers", () => {
  it("own the process: runCli with an io, and buildProject, install nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hooknostic-evalguard-"));
    tempDirs.push(dir);
    const configPath = join(dir, "hooknostic.config.ts");
    await writeFile(configPath, CONFIG_EXPORT);
    await writeFile(join(dir, "hooks.ts"), ENTRY_EXPORT);
    const EVENTS = ["uncaughtExceptionMonitor", "uncaughtException", "unhandledRejection", "beforeExit", "exit"];
    const listeners = () => EVENTS.map((event) => [event, process.rawListeners(event)] as const);
    const before = listeners();
    const realExit = process.exit;
    // What a guard would capture, so one installed by mistake cannot end the worker.
    const exit = vi.fn() as unknown as typeof process.exit;
    process.exit = exit;
    try {
      const io = { stdout: () => {}, stderr: () => {} };
      const checked = await runCli(["check", "--config", configPath], { io });
      const built = await buildProject({ configPath, registry: defaultAdapterRegistry(), dryRun: true });

      expect({ checked, built: built.ok }).toEqual({ checked: 0, built: true });
      expect(process.exit).toBe(exit);
      expect(listeners().map(([event, now]) => [event, now.length])).toEqual(
        before.map(([event, then]) => [event, then.length]),
      );
    } finally {
      for (const [event, then] of before)
        for (const listener of process.rawListeners(event))
          if (!then.includes(listener)) process.off(event, listener as (...args: unknown[]) => void);
      process.exit = realExit;
      syncBuiltinESMExports();
    }
  });
});
