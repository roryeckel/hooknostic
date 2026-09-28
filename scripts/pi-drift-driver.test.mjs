import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { runProcess, startModelPlayback } from "../packages/cli/test/harness-playback.js";

const driver = fileURLToPath(new URL("./drive-capture-session.mjs", import.meta.url));
const captureDriver = fileURLToPath(new URL("../.capture/pi/run-capture.mjs", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [driver, "pi", ...args], { encoding: "utf8", timeout: 150_000 });

it("passes a quoted, multiword capture prompt to Pi as one argument", () => {
  const scratch = mkdtempSync(join(tmpdir(), "hooknostic-pi-capture-args-"));
  try {
    const bin = join(scratch, "bin");
    const agentDir = join(scratch, "pi-home");
    const captured = join(scratch, "captured");
    mkdirSync(bin);
    mkdirSync(agentDir);
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({ providers: { "ollama-localhost": { models: [{ id: "deepseek-v4.1-flash:cloud" }] } } }),
    );
    const stub = join(bin, "record-argv.mjs");
    writeFileSync(
      stub,
      'import { writeFileSync } from "node:fs"; writeFileSync(process.env.HKN_CAPTURE_DIR + "/argv.json", JSON.stringify(process.argv.slice(2))); process.exit(Number(process.env.HKN_FAKE_EXIT ?? 0));\n',
    );
    if (process.platform === "win32") {
      writeFileSync(join(bin, "pi.cmd"), '@node "%~dp0\\record-argv.mjs" %*\r\n');
    } else {
      const launcher = join(bin, "pi");
      writeFileSync(launcher, '#!/bin/sh\nexec node "$(dirname "$0")/record-argv.mjs" "$@"\n');
      chmodSync(launcher, 0o755);
    }
    const result = spawnSync(process.execPath, [captureDriver, "tee"], {
      cwd: scratch,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        PI_CODING_AGENT_DIR: agentDir,
        HKN_CAPTURE_DIR: captured,
      },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const argv = JSON.parse(readFileSync(join(captured, "argv.json"), "utf8"));
    expect(argv.at(-1)).toBe(
      "Create a file named hello.txt with the content 'hi from pi', then list the current directory using bash.",
    );
    const failed = spawnSync(process.execPath, [captureDriver, "tee"], {
      cwd: scratch,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        PI_CODING_AGENT_DIR: agentDir,
        HKN_CAPTURE_DIR: captured,
        HKN_FAKE_EXIT: "7",
      },
    });
    expect(failed.status, failed.stdout + failed.stderr).toBe(7);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

it("reports an unavailable Pi proxy path as inconclusive", () => {
  const result = spawnSync(process.execPath, [driver, "pi", "--transport", "llm"], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      HARNESS_LLM_MODEL: "hooknostic-playback",
      HARNESS_LLM_PROXY_URL: "http://127.0.0.1:1",
      HARNESS_LLM_PROXY_KEY: "playback",
    },
  });
  expect(result.status, result.stderr).toBe(5);
  expect(result.stderr).toContain("LLM endpoint probe failed");
});

it.skipIf(process.env.HOOKNOSTIC_PLAYBACK !== "pi")(
  "drives Pi through the paid-transport wiring against a local proxy fixture",
  async () => {
    const scratch = mkdtempSync(join(tmpdir(), "hooknostic-pi-proxy-test-"));
    const server = await startModelPlayback("openai-chat", "rewrite");
    try {
      const result = await runProcess(process.execPath, [driver, "pi", "--transport", "llm", "--scratch", scratch], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          ...process.env,
          HARNESS_LLM_MODEL: "hooknostic-drift-test",
          HARNESS_LLM_PROXY_URL: server.baseUrl,
          HARNESS_LLM_PROXY_KEY: "playback",
          HARNESS_LLM_API_KEY: "never-pass-to-pi",
        },
        timeoutMs: 150_000,
      });
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("Verdict: clean");
      expect(server.urls).toContain("POST /v1/chat/completions");
      expect(server.requests.some((request) => request.model === "hooknostic-drift-test")).toBe(true);
      const provider = readFileSync(join(scratch, "playback-provider.js"), "utf8");
      expect(provider).toContain('pi.registerProvider("hooknostic-drift"');
      expect(provider).not.toContain("never-pass-to-pi");
    } finally {
      await server.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  },
  150_000,
);

it.skipIf(process.env.HOOKNOSTIC_PLAYBACK !== "pi")(
  "captures and compares a real Pi loopback exchange",
  () => {
    const scratch = mkdtempSync(join(tmpdir(), "hooknostic-pi-drift-test-"));
    try {
      const result = run("--transport", "playback", "--scratch", scratch);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("Verdict: clean");
      const call = JSON.parse(readFileSync(join(scratch, "captured/tool_call.jsonl"), "utf8").trim());
      expect(call.payload.event.toolName).toBe("bash");
      expect(call.payload.event.input.command).toContain("hooknostic-original");
      expect(readFileSync(join(scratch, "hooknostic-tool.txt"), "utf8")).toBe("hooknostic-original");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
  150_000,
);
