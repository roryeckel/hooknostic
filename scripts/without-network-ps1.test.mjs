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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
// Retried: on Windows a child that has just been stopped can hold its files for a moment.
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

// Parses a PowerShell script, then runs $body against its syntax tree. $body
// must print one JSON object; a parse error is reported as parseErrors.
const parse = (name, target, body) => {
  const file = join(dir, `${name}.ps1`);
  writeFileSync(
    file,
    `param([string]$Target)
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Target, [ref]$tokens, [ref]$errors)
if ($errors.Count) {
  [ordered]@{ parseErrors = @($errors | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" }) } | ConvertTo-Json -Depth 3 -Compress
  exit 0
}
${body}
`,
  );
  const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-File", file, "-Target", target], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim());
};

it.skipIf(!shell)("keeps the user, rule, scratch and lane setup under one try/finally", () => {
  const parsed = parse(
    "try-finally",
    script,
    String.raw`
$found = @($ast.FindAll({
  param($n)
  $n -is [System.Management.Automation.Language.TryStatementAst] -and
    $n.Finally -and $n.Body.Extent.Text.Contains('New-LocalUser')
}, $true))
if ($found.Count -ne 1) {
  [ordered]@{ found = $found.Count } | ConvertTo-Json -Compress
  exit 0
}
$statement = $found[0]
[ordered]@{
  found = $found.Count
  body = $statement.Body.Extent.Text
  finally = $statement.Finally.Extent.Text
  after = $ast.Extent.Text.Substring($statement.Extent.EndOffset)
} | ConvertTo-Json -Compress
`,
  );
  expect(parsed.parseErrors).toBeUndefined();
  expect(parsed.found).toBe(1);
  for (const name of ["New-LocalUser", "New-NetFirewallRule", "Start-Process", "Watch-Lane"]) {
    expect(parsed.body).toContain(name);
  }
  // The finally runs the cleanup helper, and only then does a successful lane
  // report its own code.
  expect(parsed.finally).toContain("Invoke-LaneCleanup");
  expect(parsed.after).toContain('"without-network: the lane exited $code');
  expect(parsed.after).toMatch(/exit \$code\s*$/);
});

// Loads only Read-New and Watch-Lane from the script, starts a node child
// with its output redirected to files, as the wrapper does, and watches it.
const harness = join(dir, "harness.ps1");
writeFileSync(
  harness,
  `param($Script, $Child, $Limit, $Poll)
$ErrorActionPreference = 'Stop'
# Console.Out, which Read-New writes, goes to a file: 12 MB through a pipe
# into node took over 90 s on a loaded Windows runner.
$sink = New-Object IO.StreamWriter("$Child.streamed", $false, (New-Object Text.UTF8Encoding($false)))
[Console]::SetOut($sink)
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$null, [ref]$null)
$wanted = { param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in 'Read-New', 'Watch-Lane' }
foreach ($f in $ast.FindAll($wanted, $true)) { . ([scriptblock]::Create($f.Extent.Text)) }
$out = "$Child.out"; $err = "$Child.err"
$timer = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath node -ArgumentList ('"' + $Child + '"') -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -NoNewWindow
$null = $p.Handle
$code = Watch-Lane -Process $p -Paths $out, $err -LimitSeconds $Limit -Timer $timer -Stop { Stop-Process -Id $p.Id -Force } -PollMilliseconds $Poll
[Console]::Out.WriteLine("harness: exit $code; child exited $($p.HasExited)")
$sink.Close()
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
    { encoding: "utf8", timeout: 90_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return readFileSync(`${child}.streamed`, "utf8").split(/\r?\n/);
};

it.skipIf(!shell)(
  "streams every line the lane writes, while it writes, with multi-byte characters whole",
  () => {
    // The lane writes without pause, 20 lines a write, as fast as it can,
    // and is polled every 100 ms. So every read lands while it is writing,
    // and on a fast machine each finds far more than 64 KiB: 2-byte
    // characters keep splitting across reads, and the original body's
    // read-then-length window is wide. It writes for 1.5 s, and on until it
    // has 20,000 lines, which the test requires: CI's Windows test job wrote
    // only 6,480 lines in 1.5 s (run 44878091388). It stops at 10 s whatever
    // it has. So the cost is bounded by time, not by a line count: 200,000
    // fixed lines took 39.7 s there. The last line comes just before the
    // exit, after the last poll.
    //
    // It catches the reviewed defect, the original Read-New (ReadToEnd, then
    // the file's length), every time. A known survivor: $fs.Length in place
    // of $fs.Position inside the current read loop. Its window is the
    // microseconds between the last Read returning 0 and that call. This
    // test hits it only some of the time (killed in 3 of 12 local runs over
    // two rounds, none under PowerShell 7.7), and hitting it reliably would
    // take a hook inside Read-New, so the test is no proof against that
    // variant.
    const lines = watch(
      "lines",
      `import { writeSync } from "node:fs";
const start = Date.now();
let i = 0;
while ((Date.now() - start < 1500 || i < 20_000) && Date.now() - start < 10_000) {
  let chunk = "";
  for (const stop = i + 20; i < stop; i++) chunk += \`\${i} \${"é".repeat(20)}\\n\`;
  writeSync(1, chunk);
}
writeSync(2, \`done \${i}\\n\`);
process.exit(3);`,
      600,
      100,
    );
    const total = Number(lines.find((line) => line.startsWith("done "))?.slice(5));
    expect(total).toBeGreaterThanOrEqual(20_000);
    const streamed = lines.filter((line) => /^\d+ /.test(line));
    const gaps = streamed.filter((line, index) => line !== `${index} ${"é".repeat(20)}`);
    expect({
      streamed: streamed.length,
      first: gaps[0],
      replacement: lines.some((line) => line.includes("\uFFFD")),
    }).toEqual({ streamed: total, first: undefined, replacement: false });
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
