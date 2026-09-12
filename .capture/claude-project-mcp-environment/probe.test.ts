import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runProcess, startModelPlayback } from "../../packages/cli/test/harness-playback.js";

function withoutCredentials(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of [
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AZURE_OPENAI_API_KEY",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_VERTEX",
    "GOOGLE_APPLICATION_CREDENTIALS", "OPENAI_API_KEY", "OPENROUTER_API_KEY",
  ]) delete env[name];
  return env;
}

test("captures Claude project MCP environment-reference behavior", async () => {
  const requests: { method?: string; url?: string; authorization?: string }[] = [];
  const sockets = new Set<Socket>();
  const transport = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    const rpc = body === "" ? {} : JSON.parse(body) as { id?: unknown; method?: string; params?: { protocolVersion?: string } };
    if (rpc.id === undefined) { response.writeHead(202).end(); return; }
    const result = rpc.method === "initialize"
      ? { protocolVersion: rpc.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "hooknostic-environment-probe", version: "1.0.0" } }
      : rpc.method === "tools/list" ? { tools: [] } : {};
    response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "hooknostic-environment-probe" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  transport.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { transport.once("error", reject); transport.listen(0, "127.0.0.1", resolve); });
  const address = transport.address() as AddressInfo;
  const transportBase = `http://127.0.0.1:${address.port}`;
  const model = await startModelPlayback("anthropic-messages", "rewrite", [{ kind: "text", text: "done" }]);
  const root = await mkdtemp(join(tmpdir(), "hooknostic-claude-env-probe-"));
  try {
    const configDir = join(root, "claude-config");
    await mkdir(configDir);
    await writeFile(join(configDir, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, customApiKeyResponses: { approved: ["hooknostic-playback"], rejected: [] } }));
    const variants = {
      rawSet: { url: transportBase + "/raw-set/${HOOKNOSTIC_CAPTURE_PATH}", headers: { Authorization: "Bearer ${HOOKNOSTIC_CAPTURE_HEADER}" } },
      rawUnset: { url: transportBase + "/raw-unset/${HOOKNOSTIC_CAPTURE_UNSET}", headers: { Authorization: "Bearer ${HOOKNOSTIC_CAPTURE_UNSET}" } },
      percentEncoded: { url: transportBase + "/percent/%24%7BHOOKNOSTIC_CAPTURE_PATH%7D", headers: { Authorization: "Bearer %24%7BHOOKNOSTIC_CAPTURE_HEADER%7D" } },
      backslash: { url: transportBase + "/backslash/\\${HOOKNOSTIC_CAPTURE_PATH}", headers: { Authorization: "Bearer \\${HOOKNOSTIC_CAPTURE_HEADER}" } },
      doubledDollar: { url: transportBase + "/doubled-dollar/$${HOOKNOSTIC_CAPTURE_PATH}", headers: { Authorization: "Bearer $${HOOKNOSTIC_CAPTURE_HEADER}" } },
    };
    const config = join(root, "mcp.json");
    await writeFile(config, JSON.stringify({ mcpServers: Object.fromEntries(Object.entries(variants).map(([name, server]) => [name, { type: "http", ...server }])) }, null, 2));
    const result = await runProcess("claude", ["-p", "Reply with done.", "--model", "hooknostic-playback", "--dangerously-skip-permissions", "--max-turns", "1", "--strict-mcp-config", "--mcp-config", config], {
      cwd: root,
      timeoutMs: 90_000,
      env: {
        ...withoutCredentials(), CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_API_KEY: "hooknostic-playback", ANTHROPIC_BASE_URL: model.baseUrl,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
        DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1",
        HOOKNOSTIC_CAPTURE_PATH: "expanded-path", HOOKNOSTIC_CAPTURE_HEADER: "expanded-header",
      },
    });
    const version = await runProcess("claude", ["--version"], { cwd: root, env: withoutCredentials() });
    console.log(JSON.stringify({ claudeVersion: version.stdout.trim(), exitCode: result.code, requests, stderr: result.stderr }, null, 2));
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(model.errors).toEqual([]);
    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "/raw-set/expanded-path", authorization: "Bearer expanded-header" }),
      expect.objectContaining({ url: "/raw-unset/$%7BHOOKNOSTIC_CAPTURE_UNSET%7D", authorization: "Bearer ${HOOKNOSTIC_CAPTURE_UNSET}" }),
      expect.objectContaining({ url: "/percent/%24%7BHOOKNOSTIC_CAPTURE_PATH%7D", authorization: "Bearer %24%7BHOOKNOSTIC_CAPTURE_HEADER%7D" }),
      expect.objectContaining({ url: "/backslash//expanded-path", authorization: "Bearer \\expanded-header" }),
      expect.objectContaining({ url: "/doubled-dollar/$expanded-path", authorization: "Bearer $expanded-header" }),
    ]));
  } finally {
    await model.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => transport.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
