import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { opencodeAdapter, opencodeV2Harness } from "@hooknostic/adapter-opencode";
import { resolveTargetAdapter } from "@hooknostic/core";

import { buildPlaybackArtifact, runProcess, startModelPlayback, traceEvents } from "./harness-playback.js";

const enabled = process.env["HOOKNOSTIC_PLAYBACK"] === "opencode-v2";
const version = process.env["HOOKNOSTIC_PLAYBACK_VERSION"] ?? opencodeV2Harness.referenceVersion;
const adapter = resolveTargetAdapter(opencodeAdapter(), {
  id: "opencode",
  version,
  delivery: "project",
  output: ".",
}).adapter!;

describe.skipIf(!enabled)("OpenCode v2 offline playback", () => {
  it("renders a native companion TUI notification from server RPC and cleans up", async () => {
    const result = await runProcess(
      process.execPath,
      ["--experimental-strip-types", ".capture/opencode-v2/drive.mjs", "notifications"],
      {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        env: process.env,
        timeoutMs: 25000,
      },
    );
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const { root } = JSON.parse(result.stdout.split("\n").find((line) => line.startsWith('{"root"'))!);
    const trace = (await readFile(join(root, "notifications.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(trace.filter((row) => row.phase === "client-received")).toEqual([
      expect.objectContaining({ event: expect.objectContaining({ data: { text: "hooknostic-server-notification" } }) }),
    ]);
    expect(trace.at(-1)).toEqual({ phase: "cleanup" });
    expect(await readFile(join(root, "terminal.txt"), "utf8")).toContain("hooknostic-server-notification");
  }, 30000);
  it.each(["project-oauth", "package-oauth"])(
    "%s discovers OAuth, validates PKCE and refreshes before MCP execution",
    async (mode) => {
      const result = await runProcess(
        process.execPath,
        ["--experimental-strip-types", ".capture/opencode-v2/drive.mjs", mode],
        {
          cwd: fileURLToPath(new URL("../../..", import.meta.url)),
          env: process.env,
          timeoutMs: 60000,
        },
      );
      expect(result.code, result.stdout + result.stderr).toBe(0);
      const { root } = JSON.parse(result.stdout.split("\n").find((line) => line.startsWith('{"root"'))!);
      const capture = JSON.parse(await readFile(join(root, "oauth.json"), "utf8"));
      const remote = JSON.parse(await readFile(join(root, "remote.json"), "utf8"));
      expect(capture.errors).toEqual([]);
      expect(remote.errors).toEqual([]);
      expect(capture.server.status.status).toBe("needs_auth");
      expect(capture.status.status).toBe("complete");
      const paths = remote.requests.map((request: { path: string }) => request.path);
      expect(paths).toContain("/.well-known/oauth-protected-resource");
      expect(paths).toContain("/.well-known/oauth-authorization-server");
      expect(paths).toContain("/register");
      const grants = remote.requests.filter((row: { path: string }) => row.path === "/token");
      expect(grants.map((row: { body: { grant_type: string } }) => row.body.grant_type)).toEqual([
        "authorization_code",
        "refresh_token",
      ]);
      const authorize = new URL(
        paths.find((path: string) => path.startsWith("/authorize?")),
        "http://127.0.0.1",
      );
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
      expect(createHash("sha256").update(grants[0].body.code_verifier).digest("base64url")).toBe(
        authorize.searchParams.get("code_challenge"),
      );
      const calls = remote.requests.filter((row: { body: { method: string } }) => row.body.method === "tools/call");
      expect(calls).toHaveLength(1);
      expect(calls[0].headers.authorization).toBe("Bearer hooknostic-refreshed-access");
      expect(calls[0].body.params).toMatchObject({ name: "hooknostic_echo", arguments: {} });
      expect(JSON.stringify(capture.requests)).toContain("hooknostic-oauth-output");
    },
    70000,
  );
  it("returns a subagent result to its parent with distinct session context", async () => {
    const result = await runProcess(
      process.execPath,
      ["--experimental-strip-types", ".capture/opencode-v2/drive.mjs", "subagent"],
      {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        env: process.env,
        timeoutMs: 60000,
      },
    );
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const { root } = JSON.parse(result.stdout.split("\n").find((line) => line.startsWith('{"root"'))!);
    const playback = JSON.parse(await readFile(join(root, "result.json"), "utf8"));
    expect(playback.errors).toEqual([]);
    const captured = (await readFile(join(root, "captured/events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const resultEvent = captured.find((row) => row.hook === "execute.after" && row.event.tool === "subagent").event;
    expect(resultEvent.status).toBe("completed");
    expect(resultEvent.result.output.output).toBe("hooknostic-child-result");
    const child = resultEvent.result.output.sessionID;
    expect(child).not.toBe(resultEvent.sessionID);
    const trace = (await readFile(join(root, "trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(trace).toContainEqual(
      expect.objectContaining({ event: "tool.after", toolKind: "agent", toolNativeName: "subagent" }),
    );
    expect(captured.some((row) => row.hook === "context" && row.event.sessionID === child)).toBe(true);
    expect(playback.requests.at(-1).messages).toContainEqual(
      expect.objectContaining({ role: "tool", content: expect.stringContaining("hooknostic-child-result") }),
    );
  }, 70000);
  it("observes typed tool failures and replaces rich output in recorded requests", async () => {
    const result = await runProcess(
      process.execPath,
      ["--experimental-strip-types", ".capture/opencode-v2/drive.mjs", "results"],
      {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        env: process.env,
        timeoutMs: 60000,
      },
    );
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const { root } = JSON.parse(result.stdout.split("\n").find((line) => line.startsWith('{"root"'))!);
    const playback = JSON.parse(await readFile(join(root, "result.json"), "utf8"));
    expect(playback.errors).toEqual([]);
    const trace = (await readFile(join(root, "results.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(trace.filter((row) => row.event === "tool.error")).toEqual([
      expect.objectContaining({
        tool: expect.objectContaining({ nativeName: "read", kind: "file.read" }),
        error: { message: "File not found: definitely-missing-hooknostic.txt" },
        correlation: { toolCallId: "call_probe_1" },
      }),
    ]);
    for (const name of ["probe_rich", "probe_object"]) {
      const original = trace.find((row) => row.tool.nativeName === name);
      expect(original.output).toEqual([{ type: "text", text: "hooknostic-native-content" }]);
      expect(original.raw.event.result).toEqual({
        content: original.output,
        output: { secret: "hooknostic-native-structured" },
        metadata: { sentinel: "hooknostic-native-metadata" },
      });
    }
    const messages = playback.requests.at(-1).messages.filter((row: { role: string }) => row.role === "tool");
    expect(messages).toContainEqual({
      role: "tool",
      tool_call_id: "call_probe_3",
      content: "hooknostic-portable-text",
    });
    expect(messages).toContainEqual({
      role: "tool",
      tool_call_id: "call_probe_4",
      content: JSON.stringify({ portable: "hooknostic-portable-object", count: 2 }),
    });
    expect(JSON.stringify(messages)).toContain("hooknostic-thrown-tool-error");
    expect(JSON.stringify(messages)).not.toContain("hooknostic-native-content");
  }, 70000);
  afterAll(async () => {
    const path = process.env["HOOKNOSTIC_PLAYBACK_INCONCLUSIVE_PATH"];
    if (enabled && path) await writeFile(path, JSON.stringify({ harness: "opencode-v2", scenarios: [] }) + "\n");
  });
  it("guards the exact MCP name without blocking a custom tool in the same namespace", async () => {
    for (const mode of ["mcp-allow", "mcp-block"]) {
      const driver = fileURLToPath(new URL("../../../.capture/opencode-v2/drive.mjs", import.meta.url));
      const result = await runProcess(process.execPath, ["--experimental-strip-types", driver, mode], {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        env: process.env,
        timeoutMs: 60000,
      });
      expect(result.code, result.stdout + result.stderr).toBe(0);
      const { root } = JSON.parse(result.stdout.split("\n").find((line) => line.startsWith('{"root"'))!);
      const playback = JSON.parse(await readFile(join(root, "result.json"), "utf8"));
      expect(playback.errors).toEqual([]);
      const captured = (await readFile(join(root, "captured/events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const catalog = captured.find((row) => row.hook === "tool.registry").event;
      for (const name of ["hooknostic_echo", "custom_echo"])
        expect(catalog).toContainEqual(
          expect.objectContaining({
            name,
            id: `hooknostic_${name}`,
            options: { namespace: "hooknostic", codemode: true },
          }),
        );
      expect(captured.find((row) => row.hook === "mcp.registry").event.data).toEqual([
        { name: "hooknostic", status: { status: "connected" } },
      ]);
      const trace = (await readFile(join(root, "guard.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(trace).toEqual([{ kind: "other", name: "hooknostic_hooknostic_echo", input: {} }]);
      const requests = (
        await readFile(join(root, "mcp-calls.jsonl"), "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "";
          throw error;
        })
      )
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const modelRequests = JSON.stringify(playback.requests);
      expect(modelRequests).toContain("hooknostic-custom-output");
      if (mode === "mcp-allow") {
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ method: "tools/call", params: { name: "hooknostic_echo", arguments: {} } });
        expect(modelRequests).toContain("hooknostic-mcp-tool-output");
      } else {
        expect(requests).toEqual([]);
        expect(modelRequests).toContain("hooknostic-mcp-denied");
        expect(modelRequests).not.toContain("hooknostic-mcp-tool-output");
      }
    }
  }, 140000);
  it("classifies captured tools and preserves Code Mode's outer boundary", async () => {
    const driver = fileURLToPath(new URL("../../../.capture/opencode-v2/drive.mjs", import.meta.url));
    const result = await runProcess(process.execPath, ["--experimental-strip-types", driver, "tools"], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      env: process.env,
      timeoutMs: 60000,
    });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const { root } = JSON.parse(result.stdout.split("\n").find((line) => line.startsWith('{"root"'))!);
    const playback = JSON.parse(await readFile(join(root, "result.json"), "utf8"));
    expect(playback.errors).toEqual([]);
    expect(await readFile(join(root, "project/probe.txt"), "utf8")).toBe("hooknostic-after-edit");
    const captured = (await readFile(join(root, "captured/events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const completed = captured.filter((row) => row.hook === "execute.after" && row.event.status === "completed");
    expect(completed.find((row) => row.event.tool === "shell").event.result.output.output).toBe(
      join(root, "project/working directory"),
    );
    for (const name of ["write", "read", "edit", "glob", "grep", "webfetch", "skill", "execute"])
      expect(
        completed.some((row) => row.event.tool === name),
        name,
      ).toBe(true);
    const modelRequests = JSON.stringify(playback.requests);
    expect(modelRequests).toContain("hooknostic-webfetch-result");
    expect(modelRequests).toContain("hooknostic-mcp-tool-output");
    expect(modelRequests).toContain("<skill_content");
    expect(completed.filter((row) => row.event.tool === "skill").map((row) => row.event.input.id)).toEqual([
      "native",
      "hooknostic-injected",
    ]);
    expect(modelRequests).toContain("hooknostic-boundary-only");
    for (const name of ["websearch", "subagent"]) {
      expect(
        captured.some((row) => row.hook === "execute.before" && row.event.tool === name),
        name,
      ).toBe(true);
      expect(
        captured.some((row) => row.hook === "execute.after" && row.event.tool === name),
        name,
      ).toBe(false);
    }
    const trace = (await readFile(join(root, "trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const [toolNativeName, toolKind] of Object.entries({
      write: "file.write",
      read: "file.read",
      edit: "file.edit",
      glob: "file.read",
      grep: "file.read",
      shell: "shell",
      webfetch: "web.fetch",
      skill: "other",
      execute: "other",
      hooknostic_hooknostic_echo: "other",
    }))
      expect(trace).toContainEqual(expect.objectContaining({ event: "tool.before", toolNativeName, toolKind }));
    // Both envelopes are visible. Neither carries an authoritative MCP identity.
    expect(trace.some((row) => row.toolKind === "mcp")).toBe(false);
    const inner = completed.find((row) => row.event.tool === "hooknostic_hooknostic_echo");
    expect(inner.event.input).toEqual({});
    expect(inner.event.result.content).toEqual([{ type: "text", text: "hooknostic-mcp-tool-output" }]);
  }, 70000);
  it("loads a scoped npm coordinate from a read-only registry", async () => {
    const driver = fileURLToPath(new URL("../../../.capture/opencode-v2/drive.mjs", import.meta.url));
    const result = await runProcess(process.execPath, ["--experimental-strip-types", driver, "package-registry"], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      env: process.env,
      timeoutMs: 60000,
    });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const { root } = JSON.parse(result.stdout.split("\n").find((line) => line.startsWith('{"root"'))!);
    const requests = JSON.parse(await readFile(join(root, "registry.json"), "utf8"));
    expect(requests).toContainEqual({ method: "GET", path: "/@hooknostic-probe/v2" });
    expect(requests).toContainEqual({ method: "GET", path: "/fixture.tgz" });
    expect(requests.every((request: { method: string }) => request.method === "GET")).toBe(true);
    const config = JSON.parse(await readFile(join(root, "project/opencode.json"), "utf8"));
    const manifest = JSON.parse(await readFile(join(root, "package-source/package.json"), "utf8"));
    expect(config.plugins).toEqual([`${manifest.name}@${manifest.version}`]);
    const startup = JSON.parse(await readFile(join(root, "mcp-startup.json"), "utf8"));
    const location = relative(join(root, "cache"), startup.root);
    expect(isAbsolute(location) || location.startsWith("..")).toBe(false);
    expect(startup.cwd).toBe(join(startup.root, "src"));
    expect(startup.marker).toBe("package-marker");
    const captured = (await readFile(join(root, "captured/events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(captured.find((row) => row.hook === "mcp").event.data).toContainEqual(
      expect.objectContaining({ status: { status: "connected" } }),
    );
    expect(await readFile(join(root, "project/hooknostic-tool.txt"), "utf8")).toBe("hooknostic-rewritten");
  }, 70000);
  it.each(["lifecycle", "provider-anthropic", "provider-responses"])(
    "%s disposes and reloads registrations across separate sessions",
    async (mode) => {
      const driver = fileURLToPath(new URL("../../../.capture/opencode-v2/drive.mjs", import.meta.url));
      const result = await runProcess(process.execPath, ["--experimental-strip-types", driver, mode], {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        env: process.env,
        timeoutMs: 60000,
      });
      expect(result.code, result.stdout + result.stderr).toBe(0);
      const { root } = JSON.parse(result.stdout.split("\n").find((line) => line.startsWith('{"root"'))!);
      const capture = JSON.parse(await readFile(join(root, "lifecycle.json"), "utf8"));
      expect(capture.errors).toEqual([]);
      const path =
        mode === "provider-anthropic"
          ? "/v1/messages"
          : mode === "provider-responses"
            ? "/v1/responses"
            : "/v1/chat/completions";
      expect(capture.urls.length).toBeGreaterThan(0);
      expect(capture.urls.every((url: string) => url === `POST ${path}`)).toBe(true);
      for (const hook of ["context", "title", "generate", "compaction"])
        expect(
          capture.records.some((row: { hook: string }) => row.hook === hook),
          hook,
        ).toBe(true);
      expect(
        capture.requests.every((request: unknown) =>
          JSON.stringify(request).includes("hooknostic-context [model.request.before]"),
        ),
      ).toBe(true);
      expect(await readFile(join(root, "project/hooknostic-tool.txt"), "utf8")).toBe("hooknostic-rewritten");
      expect(capture.records.filter((row: { hook: string }) => row.hook === "setup")).toHaveLength(2);
      expect(capture.records.filter((row: { hook: string }) => row.hook === "cleanup")).toHaveLength(1);
      expect(
        capture.records
          .filter((row: { hook: string }) => row.hook === "prompt")
          .map((row: { event: { sessionID: string } }) => row.event.sessionID),
      ).toEqual(capture.sessions);
      expect(new Set(capture.sessions).size).toBe(2);
      expect((await traceEvents(join(root, "trace.jsonl"))).filter((event) => event === "prompt.before")).toHaveLength(
        2,
      );
      for (const kind of ["generate", "compact"]) {
        expect(capture.audits[kind].error).toBeUndefined();
        expect(capture.audits[kind].requests).toBeGreaterThan(0);
        expect(capture.audits[kind].contextRequests).toBe(capture.audits[kind].requests);
      }
      expect(capture.audits.compact.compactContextRequests).toBe(capture.audits.compact.requests);
      expect(
        capture.records.some((row: { event: { type: string } }) => row.event.type === "session.compaction.failed"),
      ).toBe(false);
      expect(capture.records).toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({
            type: "session.compaction.ended",
            data: expect.objectContaining({ text: expect.stringContaining("hooknostic-valid-compaction-summary") }),
          }),
        }),
      );
      const events = await traceEvents(join(root, "trace.jsonl"));
      expect(events.filter((event) => event === "context.compact.before")).toHaveLength(1);
      expect(events.filter((event) => event === "context.compact.after")).toHaveLength(1);
    },
    70000,
  );
  it.each(["sessions", "sessions-deny"])(
    "%s observes ask-only permissions and all execution outcomes",
    async (mode) => {
      const driver = fileURLToPath(new URL("../../../.capture/opencode-v2/drive.mjs", import.meta.url));
      const result = await runProcess(process.execPath, ["--experimental-strip-types", driver, mode], {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        env: process.env,
        timeoutMs: 60000,
      });
      expect(result.code, result.stdout + result.stderr).toBe(0);
      const { root } = JSON.parse(result.stdout.split("\n").find((line) => line.startsWith('{"root"'))!);
      const capture = JSON.parse(await readFile(join(root, "sessions.json"), "utf8"));
      expect(capture.errors).toEqual([]);
      expect(capture.outcomes.map((row: { executions: number }) => row.executions)).toEqual(
        mode === "sessions" ? [1, 1, 0, 0, 0, 0] : [1, 0, 0, 0, 0, 0],
      );
      for (const [index, type] of [
        [4, "failed"],
        [5, "interrupted"],
      ] as const)
        expect(capture.outcomes[index].records).toContainEqual(
          expect.objectContaining({ event: expect.objectContaining({ type: `session.execution.${type}` }) }),
        );
      const events = await traceEvents(join(root, "trace.jsonl"));
      expect(events.filter((event) => event === "permission.request")).toHaveLength(2);
      expect(events.filter((event) => event === "turn.stop")).toHaveLength(6);
      // The first session may precede lazy setup. Subsequent sessions are
      // created after the first prompt has completed and must be observed.
      for (const outcome of capture.outcomes.slice(1)) {
        expect(outcome.records).toContainEqual(
          expect.objectContaining({
            hook: "event",
            event: expect.objectContaining({
              type: "session.created",
              data: expect.objectContaining({ sessionID: outcome.sessionID }),
            }),
          }),
        );
      }
      const starts = capture.outcomes.flatMap((outcome: { records: { hook: string; event: { type: string } }[] }) =>
        outcome.records.filter((row) => row.hook === "event" && row.event.type === "session.created"),
      );
      expect(events.filter((event) => event === "session.start")).toHaveLength(starts.length);
    },
    70000,
  );
  it.each(["project-remote", "package-remote"])(
    "%s executes Streamable HTTP with the declared headers",
    async (mode) => {
      const driver = fileURLToPath(new URL("../../../.capture/opencode-v2/drive.mjs", import.meta.url));
      const result = await runProcess(process.execPath, ["--experimental-strip-types", driver, mode], {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        env: process.env,
        timeoutMs: 60000,
      });
      expect(result.code, result.stdout + result.stderr).toBe(0);
      const { root } = JSON.parse(result.stdout.split("\n").find((line) => line.startsWith('{"root"'))!);
      const requests = JSON.parse(await readFile(join(root, "remote.json"), "utf8"));
      const calls = requests.filter((row: { body: { method: string } }) => row.body.method === "tools/call");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        method: "POST",
        path: "/http?codemode=false",
        headers: {
          "x-hooknostic": mode === "project-remote" ? "remote-expanded" : "${HKN_REMOTE_HEADER}",
        },
        body: { params: { name: "hooknostic_echo", arguments: {} } },
      });
      const playback = JSON.parse(await readFile(join(root, "result.json"), "utf8"));
      expect(playback.errors).toEqual([]);
      expect(JSON.stringify(playback.requests)).toContain("hooknostic-remote-output");
      if (mode === "project-remote") {
        expect(requests.some((row: { path: string }) => row.path.includes("missing"))).toBe(false);
        const records = (await readFile(join(root, "captured/events.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(records.find((row) => row.hook === "mcp").event.data).toContainEqual(
          expect.objectContaining({ name: "missing", status: { status: "disabled" } }),
        );
      }
    },
    70000,
  );
  it.each(["remote", "remote-legacy"])(
    "%s records the missing legacy SSE fallback",
    async (mode) => {
      const driver = fileURLToPath(new URL("../../../.capture/opencode-v2/drive.mjs", import.meta.url));
      const result = await runProcess(process.execPath, ["--experimental-strip-types", driver, mode], {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        env: process.env,
        timeoutMs: 60000,
      });
      expect(result.code, result.stdout + result.stderr).toBe(0);
      const { root } = JSON.parse(result.stdout.split("\n").find((line) => line.startsWith('{"root"'))!);
      const requests = JSON.parse(await readFile(join(root, "remote.json"), "utf8"));
      const sse = requests.filter((row: { path: string }) => row.path.startsWith("/sse"));
      expect(sse.map((row: { method: string }) => row.method)).toEqual(["POST"]);
      const records = (await readFile(join(root, "captured/events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.find((row) => row.hook === "mcp").event.data).toContainEqual(
        expect.objectContaining({ name: "sse", status: expect.objectContaining({ status: "failed" }) }),
      );
    },
    70000,
  );
  it("loads a hooks-only package installed from a local tarball", async () => {
    const driver = fileURLToPath(new URL("../../../.capture/opencode-v2/drive.mjs", import.meta.url));
    const result = await runProcess(process.execPath, ["--experimental-strip-types", driver, "package-hooks"], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      env: process.env,
      timeoutMs: 60000,
    });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const { root } = JSON.parse(result.stdout.split("\n").find((line) => line.startsWith('{"root"'))!);
    expect(await readFile(join(root, "project/hooknostic-tool.txt"), "utf8")).toBe("hooknostic-rewritten");
  }, 70000);
  it.each(["project-components", "package", "package-components"])(
    "%s loads skills and connects MCP",
    async (mode) => {
      const driver = fileURLToPath(new URL("../../../.capture/opencode-v2/drive.mjs", import.meta.url));
      const result = await runProcess(process.execPath, ["--experimental-strip-types", driver, mode], {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        env: process.env,
        timeoutMs: 60000,
      });
      expect(result.code, result.stdout + result.stderr).toBe(0);
      const { root } = JSON.parse(result.stdout.split("\n").find((line) => line.startsWith('{"root"'))!);
      const captured = (await readFile(join(root, "captured/events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const startup = JSON.parse(await readFile(join(root, "mcp-startup.json"), "utf8"));
      const mcpRoot =
        mode === "project-components"
          ? join(root, "project/portable")
          : join(root, "relocated/node_modules/@hooknostic-probe/v2/package");
      expect(startup.root).toBe(mcpRoot);
      expect(startup.cwd).toBe(mode === "project-components" ? mcpRoot : join(mcpRoot, "src"));
      expect(startup.marker).toBe(mode === "project-components" ? "project-marker" : "package-marker");
      const servers = captured.find((row) => row.hook === "mcp").event.data;
      expect(servers).toContainEqual(expect.objectContaining({ status: { status: "connected" } }));
      const skills = captured.find((row) => row.hook === "skills").event;
      expect(skills).toContainEqual(
        expect.objectContaining({
          id:
            mode === "components"
              ? "hooknostic-injected"
              : mode === "project-components"
                ? "greet"
                : "combined-example/greet",
        }),
      );
      expect(await readFile(join(root, "project/hooknostic-tool.txt"), "utf8")).toBe(
        ["package", "project-components"].includes(mode) ? "hooknostic-rewritten" : "hooknostic-original",
      );
    },
    70000,
  );
  it.each(["rewrite", "block", "context", "output", "block-prompt"] as const)(
    "%s reaches its observable effect",
    async (effect) => {
      const root = await mkdtemp(join(await realpath(tmpdir()), "hooknostic-v2-playback-"));
      const project = join(root, "project");
      await mkdir(project);
      const artifact = await buildPlaybackArtifact(adapter, project);
      const model = await startModelPlayback("openai-chat", effect === "block" ? "block" : "rewrite");
      try {
        await writeFile(
          join(project, "opencode.json"),
          JSON.stringify({
            model: "playback/hooknostic-playback",
            providers: {
              playback: {
                env: ["HKN_PLAYBACK_KEY"],
                package: "@opencode/ai/providers/openai-compatible",
                settings: { baseURL: model.baseUrl + "/v1" },
                models: { "hooknostic-playback": { limit: { context: 128000, output: 4096 } } },
              },
            },
          }),
        );
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          PWD: project,
          HOME: root,
          USERPROFILE: root,
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_DATA_HOME: join(root, "data"),
          XDG_CACHE_HOME: join(root, "cache"),
          XDG_STATE_HOME: join(root, "state"),
          HKN_PLAYBACK_KEY: "loopback",
          HOOKNOSTIC_PLAYBACK_TRACE: artifact.tracePath,
          HOOKNOSTIC_PLAYBACK_EFFECTS:
            effect === "context"
              ? "context-add"
              : effect === "output"
                ? "replace-outputs"
                : effect === "block-prompt"
                  ? "block-prompt"
                  : "",
        };
        for (const key of Object.keys(env)) if (/API_KEY|AUTH_TOKEN|SECRET|TOKEN|^OPENCODE/.test(key)) delete env[key];
        const binary = process.env["HKN_OPENCODE_BINARY"] ?? "opencode";
        const detected = await runProcess(binary, ["--version"], { cwd: root, env });
        expect(detected.stdout.trim()).toBe(`opencode v${version}`);
        const result = await runProcess(
          binary,
          [
            "run",
            "--standalone",
            "--auto",
            "--format",
            "json",
            effect === "block-prompt" ? "hooknostic-block-this-prompt" : "Use the shell once, then stop.",
          ],
          { cwd: project, env, timeoutMs: 45000 },
        );
        if (effect === "block-prompt") {
          expect(result.code).not.toBe(0);
          expect(model.requests).toHaveLength(0);
          expect(await traceEvents(artifact.tracePath)).toContain("prompt.before");
          return;
        }
        expect(result.code, result.stdout + result.stderr).toBe(0);
        expect(model.errors).toEqual([]);
        const events = await traceEvents(artifact.tracePath);
        expect(events).toContain("tool.before");
        expect(events).toContain("prompt.before");
        expect(events).toContain("turn.stop");
        // Session-start delivery is checked after lazy setup in the sessions
        // probe; the first standalone session can precede plugin subscription.
        if (effect !== "block") expect(events).toContain("tool.after");
        expect(model.requests.length).toBeGreaterThan(1);
        if (effect === "block")
          expect(await readFile(join(project, "hooknostic-blocked.txt"), "utf8").catch(() => null)).toBeNull();
        else expect(await readFile(join(project, "hooknostic-tool.txt"), "utf8")).toContain("hooknostic-rewritten");
        if (effect === "context")
          expect(
            model.requests.every((request) =>
              JSON.stringify(request).includes("hooknostic-context [model.request.before]"),
            ),
          ).toBe(true);
        if (effect === "output") expect(JSON.stringify(model.requests)).toContain("hooknostic-replaced-tool-output");
      } finally {
        await model.close();
      }
    },
    60000,
  );
});
