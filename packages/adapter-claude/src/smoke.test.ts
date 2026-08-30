/**
 * Real-harness smoke test: bundles a plugin shim and loads it into the
 * locally installed Claude Code via project-settings command hooks (the same
 * command-hook protocol a plugin artifact uses).
 *
 * Opt-in: set HOOKNOSTIC_SMOKE=1 (or "claude"). Requires the `claude` CLI on
 * PATH and takes ~1 minute of real model time (sonnet).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { claudeHarness } from "./harness.js";
import { bundleRuntime } from "@hooknostic/core";
import { claudeShimEntrySource, claudeCapabilityProfiles } from "./index.js";

const execFileAsync = promisify(execFile);

const smokeFlag = process.env["HOOKNOSTIC_SMOKE"] ?? "";
const enabled = smokeFlag === "1" || smokeFlag.split(",").includes("claude");

const PACKAGES = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const ALIAS = {
  "@hooknostic/sdk": join(PACKAGES, "sdk/src/index.ts"),
  "@hooknostic/runtime": join(PACKAGES, "runtime/src/index.ts"),
  "@hooknostic/adapter-claude/shim": join(PACKAGES, "adapter-claude/src/shim.ts"),
};

const HOOKS_SOURCE = `
import { definePlugin, hook, block, replaceInput, addContext } from "@hooknostic/sdk";

export default definePlugin({
  name: "smoke",
  hooks: [
    hook("tool.before", {
      id: "smoke-guard",
      match: { kind: "shell" },
      capabilities: {
        "tool.before.block": "required",
        "tool.before.input.replace": "optional",
      },
      async run(event, ctx) {
        const { command = "" } = event.tool.input as { command?: string };
        if (command.includes("forbidden-marker")) {
          return block("hooknostic smoke: this command is blocked");
        }
        if (
          ctx.capabilities.has("tool.before.input.replace") &&
          command.includes("hooknostic-original")
        ) {
          return replaceInput({
            ...(event.tool.input as object),
            command: command.replace("hooknostic-original", "hooknostic-rewritten"),
          });
        }
      },
    }),
    hook("session.start", {
      id: "smoke-context",
      capabilities: { "session.start.context.add": "optional" },
      async run(_event, ctx) {
        if (!ctx.capabilities.has("session.start.context.add")) return;
        return addContext("hooknostic smoke token: hooknostic-context-7c4f1");
      },
    }),
  ],
});
`;

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe.skipIf(!enabled)("Claude Code smoke (real harness)", () => {
  it(
    "block, input rewrite, and session context all function in a live session",
    { timeout: 300_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "hooknostic-smoke-claude-"));
      tempDirs.push(dir);

      // 1. Bundle the shim exactly as the build pipeline will.
      await writeFile(join(dir, "hooks.ts"), HOOKS_SOURCE, "utf8");
      const levels = Object.fromEntries(
        Object.entries(claudeCapabilityProfiles[0]!.matrix).map(([id, e]) => [id, e.level]),
      );
      const bundle = await bundleRuntime({
        source: claudeShimEntrySource({
          entryImportPath: join(dir, "hooks.ts").replaceAll("\\", "/"),
          capabilities: levels,
          policy: { onHookError: "continue", timeoutMs: 5000 },
          harnessVersion: claudeHarness.referenceVersion,
        }),
        resolveDir: dir,
        alias: ALIAS,
      });
      const bundlePath = join(dir, "hooknostic.mjs");
      await writeFile(bundlePath, bundle.code, "utf8");

      // 2. Wire it as project-settings command hooks (same protocol as the
      //    plugin's hooks.json, exec form).
      await mkdir(join(dir, ".claude"), { recursive: true });
      const hookEntry = () => [
        {
          hooks: [
            { type: "command", command: "node", args: [bundlePath], timeout: 30 },
          ],
        },
      ];
      await writeFile(
        join(dir, ".claude", "settings.json"),
        JSON.stringify(
          {
            hooks: {
              SessionStart: hookEntry(),
              PreToolUse: hookEntry(),
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      // 3. Drive a real session.
      const prompt =
        "Do these steps in order and do not retry failures. " +
        "1) Run this exact bash command: echo hooknostic-original. Report its stdout verbatim. " +
        "2) Run this exact bash command: echo made-it > forbidden-marker.txt (if it is blocked, say so and move on). " +
        "3) If your context contains a hooknostic smoke token, repeat it verbatim. Then stop.";
      // claude ships as a real executable; invoking without a shell keeps
      // the prompt's special characters (">", parentheses) intact.
      const { stdout } = await execFileAsync(
        "claude",
        ["-p", prompt, "--model", "sonnet", "--allowedTools", "Bash(echo:*)"],
        { cwd: dir, timeout: 280_000 },
      );

      // Input rewrite observable: the executed command echoed the rewritten
      // marker, which only exists if updatedInput was honored.
      expect(stdout).toContain("hooknostic-rewritten");
      // Block observable: the marker file was never created.
      expect(existsSync(join(dir, "forbidden-marker.txt"))).toBe(false);
      // Session context observable: the token reached the model.
      expect(stdout).toContain("hooknostic-context-7c4f1");
    },
  );
});
