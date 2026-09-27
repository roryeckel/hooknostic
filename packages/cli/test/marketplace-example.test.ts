import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { runBuild } from "../src/build.js";
import { defaultAdapterRegistry } from "../src/registry.js";
import { runProcess, startModelPlayback } from "./harness-playback.js";

const root = resolve(import.meta.dirname, "../../..");
const cleanup: string[] = [];
afterAll(async () => {
  for (const dir of cleanup) await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

async function example() {
  const source = await mkdtemp(join(root, "examples/.buildtest-marketplace-"));
  cleanup.push(source);
  const original = join(root, "examples/agent-plugin");
  await cp(original, source, {
    recursive: true,
    filter: (path) => !["dist", "node_modules", "hooknostic-build.json"].includes(basename(path)),
  });
  await symlink(join(original, "node_modules"), join(source, "node_modules"), "junction");
  const messages: string[] = [];
  expect(
    await runBuild({
      config: join(source, "hooknostic.config.ts"),
      registry: defaultAdapterRegistry(),
      io: { stdout: (s) => messages.push(s), stderr: (s) => messages.push(s) },
    }),
    messages.join("\n"),
  ).toBe(0);
  return source;
}

describe("marketplace example", () => {
  it("answers MCP calls after relocation without workspace dependencies", async () => {
    const source = await example();
    const destination = await mkdtemp(join(tmpdir(), "hooknostic-relocated-example-"));
    cleanup.push(destination);
    for (const id of ["claude", "codex", "opencode", "opencode-v1"]) {
      const output = join(destination, id);
      await cp(join(source, "dist", id), output, { recursive: true });
      const server = join(output, ...(id.startsWith("opencode") ? ["package"] : []), "bundled/greet-mcp.mjs");
      const notices = await readFile(
        join(output, ...(id.startsWith("opencode") ? ["package"] : []), "bundled/THIRD_PARTY_NOTICES.txt"),
        "utf8",
      );
      expect(notices).toContain("@modelcontextprotocol/server@");
      expect(notices).toContain("zod@");
      const result = await runProcess(process.execPath, [server], {
        cwd: destination,
        env: process.env,
        timeoutMs: 15_000,
        input:
          [
            {
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-03-26",
                capabilities: {},
                clientInfo: { name: "launch-test", version: "1" },
              },
            },
            { jsonrpc: "2.0", method: "notifications/initialized" },
            { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "greet", arguments: {} } },
          ]
            .map((entry) => JSON.stringify(entry))
            .join("\n") + "\n",
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout, id).toContain("Hello, friend!");
    }
  }, 120_000);

  it.skipIf(process.env["HOOKNOSTIC_REQUIRE_PACKAGE"] !== "1")(
    "runs the documented package through a marketplace install",
    async () => {
      const id = process.env["HOOKNOSTIC_PLAYBACK"];
      if (id !== "claude" && id !== "codex") throw new Error("Select claude or codex for marketplace verification");
      const source = await example();
      const dir = await mkdtemp(join(tmpdir(), "hooknostic-marketplace-"));
      cleanup.push(dir);
      const marketplace = join(dir, "marketplace");
      const project = join(dir, "unrelated-project");
      const configHome = join(dir, "config");
      await mkdir(project, { recursive: true });
      await mkdir(configHome);
      await cp(join(source, "dist", id), join(marketplace, "dist", id), { recursive: true });
      const metadata = join(marketplace, id === "claude" ? ".claude-plugin" : ".agents/plugins");
      await mkdir(metadata, { recursive: true });
      await cp(
        join(source, id === "claude" ? ".claude-plugin/marketplace.json" : ".agents/plugins/marketplace.json"),
        join(metadata, "marketplace.json"),
      );
      const env = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !/(API_KEY|AUTH_TOKEN|OAUTH_TOKEN)$/.test(key)),
        ),
        CODEX_HOME: configHome,
        HOME: configHome,
        USERPROFILE: configHome,
        CLAUDE_CONFIG_DIR: configHome,
        CLAUDE_CODE_PLUGIN_CACHE_DIR: join(dir, "cache"),
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
        OPENAI_API_KEY: "",
        OPENROUTER_API_KEY: "",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
        DISABLE_AUTOUPDATER: "1",
        DISABLE_TELEMETRY: "1",
      };
      for (const args of [
        ["plugin", "marketplace", "add", marketplace],
        ["plugin", id === "claude" ? "install" : "add", "combined-example@hooknostic-example"],
      ]) {
        const result = await runProcess(id, args, { cwd: project, env, timeoutMs: 60_000 });
        expect(result.code, result.stdout + result.stderr).toBe(0);
      }
      await runProcess("git", ["init"], { cwd: project, env, timeoutMs: 10_000 });
      // The marker is in the generated shell command; the production hook must deny it.
      const model = await startModelPlayback(id === "claude" ? "anthropic-messages" : "openai-responses", "rewrite", [
        { kind: "tool", marker: "HOOKNOSTIC_BLOCK_PROBE" },
        { kind: "tool", toolName: "greet" },
        { kind: "text", text: "marketplace verification complete" },
      ]);
      try {
        const args =
          id === "claude"
            ? [
                "-p",
                "Use the greet skill, then run the requested tools.",
                "--model",
                "hooknostic-playback",
                "--dangerously-skip-permissions",
                "--max-turns",
                "6",
              ]
            : [
                "exec",
                "Use the greet skill, then run the requested tools.",
                "--skip-git-repo-check",
                "--dangerously-bypass-hook-trust",
                "-c",
                'model="hooknostic-playback"',
                "-c",
                'model_provider="hooknostic_playback"',
                "-c",
                'approval_policy="never"',
                "-c",
                'sandbox_mode="danger-full-access"',
                "-c",
                'model_providers.hooknostic_playback.name="Hooknostic Playback"',
                "-c",
                `model_providers.hooknostic_playback.base_url=${JSON.stringify(model.baseUrl + "/v1")}`,
                "-c",
                'model_providers.hooknostic_playback.wire_api="responses"',
                "-c",
                "model_providers.hooknostic_playback.requires_openai_auth=false",
                "-c",
                `projects={${JSON.stringify(project)}={trust_level="trusted"}}`,
              ];
        const result = await runProcess(id, args, {
          cwd: project,
          env: { ...env, ANTHROPIC_API_KEY: "hooknostic-playback", ANTHROPIC_BASE_URL: model.baseUrl },
          timeoutMs: 120_000,
        });
        expect(result.code, result.stdout + result.stderr).toBe(0);
        expect(model.errors).toEqual([]);
        const requests = JSON.stringify(model.requests);
        expect(
          requests.includes("Greet the user by name and summarize the repo state."),
          "installed skill must reach model requests",
        ).toBe(true);
        expect(requests.includes("Hooknostic marketplace probe blocked."), "installed hook must deny the probe").toBe(
          true,
        );
        const replies = model.requests.flatMap((request) => {
          const messages = (request as Record<string, unknown>)["messages"] as { content?: unknown }[] | undefined;
          return (messages ?? [])
            .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
            .filter((part) => part.type === "tool_result");
        });
        expect(requests.includes("Hello, friend!"), JSON.stringify(replies).slice(-6000)).toBe(true);
        await expect(readFile(join(project, "HOOKNOSTIC_BLOCK_PROBE"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await model.close();
      }
    },
    300_000,
  );
});
