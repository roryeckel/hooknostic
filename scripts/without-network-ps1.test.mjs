// scripts/without-network.ps1's argument checks, its first refusal, and the
// functions that stream a lane's output and stop it at its limit.
//
// The wrapper creates a local user and a firewall rule, and CI's Windows test
// job is elevated on a GitHub-hosted runner. So no test here may reach that
// setup:
// - every call of the script uses -DryRun, which stops after the argument
//   checks and the refusals, before anything is created, and runs with
//   GITHUB_ACTIONS and RUNNER_ENVIRONMENT emptied, so the first refusal stops
//   it even if -DryRun stopped working;
// - the streaming tests never run the script. They lift the Read-New and
//   Watch-Lane definitions out of its syntax tree and run only those, on a
//   node child of their own.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, expect, it } from "vitest";

const script = fileURLToPath(new URL("without-network.ps1", import.meta.url));
const shell = ["pwsh", ...(process.platform === "win32" ? ["powershell"] : [])].find(
  (candidate) => spawnSync(candidate, ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8" }).status === 0,
);
const dryRun = (...args) => {
  const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-File", script, "-DryRun", ...args], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_ACTIONS: "", RUNNER_ENVIRONMENT: "" },
  });
  return `${result.status} ${(result.stdout + result.stderr).trim()}`;
};

it.skipIf(!shell)("refuses an empty or malformed required list, and a missing command", () => {
  const empty = "2 without-network: no required variables: pass -RequireEnv A,B (an empty list checks nothing)";
  expect(dryRun("-Run", "node -v")).toBe(empty);
  expect(dryRun("-RequireEnv", " , ", "-Run", "node -v")).toBe(empty);
  expect(dryRun("-RequireEnv", "HOOKNOSTIC_PLAYBACK,A-B", "-Run", "node -v")).toBe(
    "2 without-network: not a variable name: A-B",
  );
  expect(dryRun("-RequireEnv", "HOOKNOSTIC_PLAYBACK", "-Run", "  ")).toBe(
    "2 without-network: no command: pass -Run '<command line>'",
  );
});

it.skipIf(!shell)("refuses a step budget with no room for its own stop", () => {
  const refusal = (got) =>
    `2 without-network: no room to stop the lane: pass -StepTimeoutMinutes, the step's timeout-minutes, above 2 (got ${got})`;
  expect(dryRun("-RequireEnv", "HOOKNOSTIC_PLAYBACK", "-Run", "node -v")).toBe(refusal(0));
  expect(dryRun("-StepTimeoutMinutes", "2", "-RequireEnv", "HOOKNOSTIC_PLAYBACK", "-Run", "node -v")).toBe(refusal(2));
  // 3 minutes leaves 2 for the lane and 1 in reserve: accepted, so the next refusal speaks.
  expect(dryRun("-StepTimeoutMinutes", "3", "-RequireEnv", "HOOKNOSTIC_PLAYBACK", "-Run", "node -v")).toBe(
    "2 without-network: GitHub-hosted runners only: it creates a local user and a firewall rule",
  );
});

it.skipIf(!shell)("accepts valid arguments, then refuses outside a GitHub-hosted runner", () => {
  expect(
    dryRun(
      "-StepTimeoutMinutes",
      "11",
      "-RequireEnv",
      "HOOKNOSTIC_PLAYBACK,HKN_RIPGREP_DIR",
      "-Run",
      "pnpm exec vitest run -t x",
    ),
  ).toBe("2 without-network: GitHub-hosted runners only: it creates a local user and a firewall rule");
});

const dir = mkdtempSync(join(tmpdir(), "without-network-ps1-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Loads only Read-New and Watch-Lane from the script, starts a node child
// with its output redirected to files, as the wrapper does, and watches it.
const harness = join(dir, "harness.ps1");
writeFileSync(
  harness,
  `param($Script, $Child, $Limit, $Poll)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$null, [ref]$null)
$wanted = { param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in 'Read-New', 'Watch-Lane' }
foreach ($f in $ast.FindAll($wanted, $true)) { . ([scriptblock]::Create($f.Extent.Text)) }
$out = "$Child.out"; $err = "$Child.err"
$timer = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath node -ArgumentList ('"' + $Child + '"') -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -NoNewWindow
$null = $p.Handle
$code = Watch-Lane -Process $p -Paths $out, $err -LimitSeconds $Limit -Timer $timer -Stop { Stop-Process -Id $p.Id -Force } -PollMilliseconds $Poll
[Console]::Out.WriteLine("harness: exit $code; child exited $($p.HasExited)")
`,
);
const watch = (name, source, limit, poll) => {
  const child = join(dir, `${name}.mjs`);
  writeFileSync(child, source);
  const result = spawnSync(
    shell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      harness,
      "-Script",
      script,
      "-Child",
      child,
      "-Limit",
      limit,
      "-Poll",
      poll,
    ],
    { encoding: "utf8", timeout: 90_000, maxBuffer: 256 * 1024 * 1024 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.split(/\r?\n/);
};

it.skipIf(!shell)(
  "streams every line the lane writes, while it writes, with multi-byte characters whole",
  () => {
    // Written in bursts over a few seconds and polled every 100 ms, so each
    // read finds far more than 64 KiB and lands while the lane is writing;
    // 2-byte characters, so those 64 KiB reads keep splitting one. The last
    // line comes just before the exit, after the last poll.
    const total = 200_000;
    const lines = watch(
      "lines",
      `import { writeSync } from "node:fs";
let i = 0;
const burst = () => {
  for (const end = Math.min(i + 2000, ${total}); i < end; i++) writeSync(1, \`\${i} \${"é".repeat(20)}\\n\`);
  if (i < ${total}) setTimeout(burst, 1);
  else { writeSync(2, "done\\n"); process.exit(3); }
};
burst();`,
      600,
      100,
    );
    const streamed = lines.filter((line) => /^\d+ /.test(line));
    const gaps = streamed.filter((line, index) => line !== `${index} ${"é".repeat(20)}`);
    expect({ streamed: streamed.length, first: gaps[0], replacement: lines.some((l) => l.includes("�")) }).toEqual({
      streamed: total,
      first: undefined,
      replacement: false,
    });
    expect(lines).toContain("done");
    expect(lines).toContain("harness: exit 3; child exited True");
  },
  120_000,
);

it.skipIf(!shell)(
  "stops a lane at its limit: says so, runs the stop, and returns 124",
  () => {
    const started = Date.now();
    const lines = watch(
      "hang",
      // Ends itself after 40 s, so a broken limit fails the test instead of leaving it behind.
      `setInterval(() => console.log("tick"), 100);
setTimeout(() => process.exit(0), 40_000);`,
      3,
      200,
    );
    expect(lines).toContain("without-network: the lane ran past its limit of 3 s; stopping the user's processes");
    expect(lines).toContain("harness: exit 124; child exited True");
    expect(lines).toContain("tick");
    expect(Date.now() - started).toBeLessThan(25_000);
  },
  120_000,
);
