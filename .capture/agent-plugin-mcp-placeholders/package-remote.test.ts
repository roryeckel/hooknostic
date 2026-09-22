import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { runProcess, startModelPlayback } from "../../packages/cli/test/harness-playback.js";

function withoutCredentials(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AZURE_OPENAI_API_KEY",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_VERTEX",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
  ])
    delete env[name];
  return env;
}

test("captures Claude package remote MCP placeholder expansion", async () => {
  const requests: { method?: string; url?: string; authorization?: string; probeHeaders?: Record<string, string> }[] =
    [];
  const sockets = new Set<Socket>();
  const transport = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    // Node lower-cases header names; only the probe's own are recorded.
    const probeHeaders = Object.fromEntries(
      Object.entries(request.headers).filter(([name]) => name.startsWith("x-probe")),
    ) as Record<string, string>;
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      ...(Object.keys(probeHeaders).length === 0 ? {} : { probeHeaders }),
    });
    const rpc = body === "" ? {} : (JSON.parse(body) as { id?: unknown; method?: string; params?: { protocolVersion?: string } });
    if (rpc.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const result =
      rpc.method === "initialize"
        ? {
            protocolVersion: rpc.params?.protocolVersion ?? "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "hooknostic-package-environment-probe", version: "1.0.0" },
          }
        : rpc.method === "tools/list"
          ? { tools: [] }
          : {};
    response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "hooknostic-package-environment-probe" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  transport.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolvePromise, reject) => {
    transport.once("error", reject);
    transport.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = transport.address() as AddressInfo;
  const transportBase = `http://127.0.0.1:${address.port}`;
  const model = await startModelPlayback("anthropic-messages", "rewrite", [{ kind: "text", text: "done" }]);
  const root = await mkdtemp(join(tmpdir(), "hooknostic-claude-package-env-probe-"));
  try {
    const plugin = join(root, "plugin");
    const configDir = join(root, "claude-config");
    await mkdir(join(plugin, ".claude-plugin"), { recursive: true });
    await mkdir(configDir);
    await writeFile(
      join(plugin, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "placeholder-probe", version: "1.0.0", description: "Synthetic package placeholder probe" }),
    );
    await writeFile(
      join(plugin, ".mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            known: {
              type: "http",
              url: `${transportBase}/known/\${SYNTHETIC_REMOTE_PATH}`,
              headers: { Authorization: "Bearer ${SYNTHETIC_REMOTE_HEADER}" },
            },
            reserved: {
              type: "http",
              url: `${transportBase}/reserved/\${PLUGIN_ROOT}`,
              headers: { Authorization: "Bearer ${PLUGIN_DATA}" },
            },
            unknown: {
              type: "http",
              url: `${transportBase}/unknown/\${HOOKNOSTIC_UNSET}`,
              headers: { Authorization: "Bearer ${HOOKNOSTIC_UNSET}" },
            },
            // The documented default form, with the name set and unset.
            defaultedKnown: {
              type: "http",
              url: `${transportBase}/defaulted-known/\${SYNTHETIC_REMOTE_PATH:-fallback-path}`,
              headers: { Authorization: "Bearer ${SYNTHETIC_REMOTE_HEADER:-fallback-header}" },
            },
            defaultedUnknown: {
              type: "http",
              url: `${transportBase}/defaulted-unknown/\${HOOKNOSTIC_UNSET:-fallback-path}`,
              headers: { Authorization: "Bearer ${HOOKNOSTIC_UNSET:-fallback-header}" },
            },
            // A literal brace is not a legal header-name character, so the
            // unset case also shows whether Claude connects at all.
            headerNameKnown: {
              type: "http",
              url: `${transportBase}/header-name-known`,
              headers: { "X-Probe-${SYNTHETIC_HEADER_NAME}": "name-probe" },
            },
            headerNameUnknown: {
              type: "http",
              url: `${transportBase}/header-name-unknown`,
              headers: { "X-Probe-${HOOKNOSTIC_UNSET}": "name-probe" },
            },
          },
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(configDir, ".claude.json"),
      JSON.stringify({ hasCompletedOnboarding: true, customApiKeyResponses: { approved: ["hooknostic-playback"], rejected: [] } }),
    );
    const result = await runProcess(
      "claude",
      [
        "-p",
        "Reply with done.",
        "--model",
        "hooknostic-playback",
        "--dangerously-skip-permissions",
        "--max-turns",
        "1",
        "--plugin-dir",
        plugin,
      ],
      {
        cwd: root,
        timeoutMs: 90_000,
        env: {
          ...withoutCredentials(),
          CLAUDE_CONFIG_DIR: configDir,
          ANTHROPIC_API_KEY: "hooknostic-playback",
          ANTHROPIC_BASE_URL: model.baseUrl,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
          DISABLE_AUTOUPDATER: "1",
          DISABLE_TELEMETRY: "1",
          SYNTHETIC_REMOTE_PATH: "expanded-path",
          SYNTHETIC_REMOTE_HEADER: "expanded-header",
          SYNTHETIC_HEADER_NAME: "expanded-name",
          PLUGIN_ROOT: "ambient-plugin-root",
          PLUGIN_DATA: "ambient-plugin-data",
        },
      },
    );
    const version = await runProcess("claude", ["--version"], { cwd: root, env: withoutCredentials() });
    // Neither header-name server reaches the transport, so its status line is
    // the evidence of what Claude did with the name.
    const list = await runProcess("claude", ["--plugin-dir", plugin, "mcp", "list"], {
      cwd: root,
      timeoutMs: 90_000,
      env: {
        ...withoutCredentials(),
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
        DISABLE_TELEMETRY: "1",
        SYNTHETIC_HEADER_NAME: "expanded-name",
      },
    });
    const headerNameStatus = list.stdout
      .split(/\r?\n/)
      .filter((line) => line.includes(":headerName"))
      .map((line) => line.replace(/127\.0\.0\.1:\d+/, "127.0.0.1:<port>").trim());
    const normalized = {
      claudeVersion: version.stdout.trim(),
      headerNameStatus,
      requests: requests.map(({ method, url, authorization, probeHeaders }) => ({
        method,
        url,
        authorization,
        ...(probeHeaders === undefined ? {} : { probeHeaders }),
      })),
    };
    await writeFile(join(import.meta.dirname, "remote-observations.json"), `${JSON.stringify(normalized, null, 2)}\n`);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(model.errors).toEqual([]);
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: "/known/expanded-path", authorization: "Bearer expanded-header" }),
        expect.objectContaining({ url: "/reserved/ambient-plugin-root", authorization: "Bearer ambient-plugin-data" }),
        expect.objectContaining({ url: "/unknown/$%7BHOOKNOSTIC_UNSET%7D", authorization: "Bearer ${HOOKNOSTIC_UNSET}" }),
        expect.objectContaining({ url: "/defaulted-known/expanded-path", authorization: "Bearer expanded-header" }),
        expect.objectContaining({ url: "/defaulted-unknown/fallback-path", authorization: "Bearer fallback-header" }),
      ]),
    );
    // Header names are not expanded: the literal is refused as an invalid
    // name whether or not the variable is set, and nothing is sent.
    expect(requests.some((request) => request.url?.startsWith("/header-name"))).toBe(false);
    expect(headerNameStatus).toEqual([
      expect.stringContaining("Invalid header name: 'X-Probe-${SYNTHETIC_HEADER_NAME}'"),
      expect.stringContaining("Invalid header name: 'X-Probe-${HOOKNOSTIC_UNSET}'"),
    ]);
  } finally {
    await model.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolvePromise) => transport.close(() => resolvePromise()));
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
