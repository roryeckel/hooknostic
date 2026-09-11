import { execFileSync } from "node:child_process";
import { renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { outputRoots } from "./renovate-artifacts.mjs";

// All invocations have the same working directory (ADR-0006). Remove old
// outputs first so a removed generator output becomes a real deletion.
export function buildExamples(cwd = fileURLToPath(new URL("../", import.meta.url)), run = execFileSync) {
  run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["build"], {
    cwd, stdio: "inherit", shell: process.platform === "win32",
  });
  for (const root of outputRoots) {
    const example = root.slice(0, -5);
    rmSync(resolve(cwd, root), { recursive: true, force: true });
    run(process.execPath, [
      "packages/cli/bin/hooknostic.mjs", "build", "--config",
      `${example}/hooknostic.config.ts`,
    ], { cwd, stdio: "inherit" });
    // Keep the complete committed result inside the writer's allowlist. The
    // CLI's public/default report location remains unchanged.
    renameSync(resolve(cwd, example, "hooknostic-build.json"), resolve(cwd, root, "hooknostic-build.json"));
  }
  run(process.execPath, ["packages/cli/bin/hooknostic.mjs", "sync", "--config", "examples/local-project/hooknostic.config.ts"], { cwd, stdio: "inherit" });
  run(process.execPath, ["packages/cli/bin/hooknostic.mjs", "verify", "--config", "examples/local-project/hooknostic.config.ts"], { cwd, stdio: "inherit" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildExamples();
