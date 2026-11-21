// scripts/without-network.ps1's argument checks and its first refusal.
//
// The wrapper creates a local user and a firewall rule, and CI's Windows test
// job is elevated on a GitHub-hosted runner. So no test here may reach that
// setup, and each call is guarded twice:
// - every call uses -DryRun, which stops after the argument checks and the
//   refusals, before anything is created;
// - every call runs with GITHUB_ACTIONS and RUNNER_ENVIRONMENT emptied, so
//   the first refusal stops it even if -DryRun stopped working.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

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

it.skipIf(!shell)("accepts valid arguments, then refuses outside a GitHub-hosted runner", () => {
  expect(dryRun("-RequireEnv", "HOOKNOSTIC_PLAYBACK,HKN_RIPGREP_DIR", "-Run", "pnpm exec vitest run -t x")).toBe(
    "2 without-network: GitHub-hosted runners only: it creates a local user and a firewall rule",
  );
});
