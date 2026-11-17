import { createHash } from "node:crypto";
import { access, appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import semver from "semver";
import { afterAll, describe, expect, it } from "vitest";

import { opencodeAdapter, opencodeV2CapabilityProfiles, opencodeV2Harness } from "@hooknostic/adapter-opencode";
import { resolveTargetAdapter } from "@hooknostic/core";

// @ts-expect-error The capture event reader is plain JavaScript.
import { readEventRecords } from "../../../.capture/opencode-v2/lifecycle.mjs";
// @ts-expect-error The constructed loopback model is plain JavaScript.
import { startToolModel } from "../../../.capture/opencode-v2/tool-model.mjs";
import {
  buildPlaybackArtifact,
  expectOpenCodeShellDialect,
  openCodeShellDialectExpectation,
  PLAYBACK_HANDLER_ERROR_LINE,
  PLAYBACK_INTERNAL_ERROR_LINE,
  PLAYBACK_STRAY_INTERNAL_ERROR_LINE,
  runProcess,
  startModelPlayback,
  traceEvents,
} from "./harness-playback.js";

const enabled = process.env["HOOKNOSTIC_PLAYBACK"] === "opencode-v2";
const version = process.env["HOOKNOSTIC_PLAYBACK_VERSION"] ?? opencodeV2Harness.referenceVersion;
const adapter = resolveTargetAdapter(opencodeAdapter(), {
  id: "opencode",
  version,
  delivery: "project",
  output: ".",
}).adapter!;
// The first build captured running every subagent in the background, read from
// its validation record rather than written here (ADR-0008). The build before
// it, 2.2.7, still ran the child in the foreground (.capture/opencode-v2-audit).
const backgroundSubagentCapture = opencodeV2CapabilityProfiles
  .flatMap((profile) => profile.source.validatedOn ?? [])
  .find((record) => record.artifact === "fixtures/opencode/2.0/tool-subagent-background-after.input.json");
const backgroundSubagents = () => {
  expect(backgroundSubagentCapture).toBeDefined();
  return semver.gte(version, backgroundSubagentCapture!.version);
};

async function toolModelDelta(baseUrl: string, messages: unknown[]) {
  const response = await fetch(baseUrl + "/chat/completions", {
    method: "POST",
    body: JSON.stringify({ tools: [{ type: "function", function: { name: "execute" } }], messages }),
  });
  const chunk = (await response.text()).split("\n").find((line) => line.startsWith("data: {"))!;
  return JSON.parse(chunk.slice(6)).choices[0].delta;
}

describe("OpenCode playback event records", () => {
  it("waits for a complete line while the capture is being appended", async () => {
    const root = await mkdtemp(join(tmpdir(), "hooknostic-event-records-"));
    const path = join(root, "events.jsonl");
    try {
      expect(await readEventRecords(path)).toEqual([]);
      await writeFile(path, '{"sequence":');
      expect(await readEventRecords(path)).toEqual([]);
      await appendFile(path, '1}\n{"sequence":');
      expect(await readEventRecords(path)).toEqual([{ sequence: 1 }]);
      await appendFile(path, "2}");
      expect(await readEventRecords(path)).toEqual([{ sequence: 1 }]);
      await appendFile(path, "\n");
      expect(await readEventRecords(path)).toEqual([{ sequence: 1 }, { sequence: 2 }]);
      // A completed malformed line must still fail instead of hiding corrupt capture data.
      await appendFile(path, '{"sequence":\n');
      await expect(readEventRecords(path)).rejects.toThrow(SyntaxError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("OpenCode OAuth playback readiness", () => {
  it("retries the MCP call after the captured tool-catalog update", async () => {
    const capture = JSON.parse(
      await readFile(
        new URL("../../../.capture/opencode-v2-audit/oauth-catalog-readiness.json", import.meta.url),
        "utf8",
      ),
    );
    const model = await startToolModel(".", false, "project-oauth");
    const request = (messages: unknown[]) => toolModelDelta(model.baseUrl, messages);
    try {
      const first = await request([]);
      const retried = await request([capture.failure, capture.update]);
      expect(retried.tool_calls).toEqual([
        expect.objectContaining({
          id: "call_probe_2",
          function: first.tool_calls[0].function,
        }),
      ]);
      const completed = await request([
        capture.failure,
        capture.update,
        { role: "tool", tool_call_id: "call_probe_2", content: "hooknostic-oauth-output" },
      ]);
      expect(completed.tool_calls).toBeUndefined();
      expect(model.errors).toEqual([]);
    } finally {
      await model.close();
    }
  });
  it("stops retrying when the advertised MCP tool remains unavailable", async () => {
    const capture = JSON.parse(
      await readFile(
        new URL("../../../.capture/opencode-v2-audit/oauth-catalog-readiness.json", import.meta.url),
        "utf8",
      ),
    );
    const model = await startToolModel(".", false, "project-oauth");
    try {
      for (let call = 1; call <= 3; call += 1) {
        const messages =
          call === 1 ? [] : [{ ...capture.failure, tool_call_id: `call_probe_${call - 1}` }, capture.update];
        const response = await toolModelDelta(model.baseUrl, messages);
        expect(response.tool_calls[0].id).toBe(`call_probe_${call}`);
      }
      const stopped = await toolModelDelta(model.baseUrl, [
        { ...capture.failure, tool_call_id: "call_probe_3" },
        capture.update,
      ]);
      expect(stopped.tool_calls).toBeUndefined();
      expect(model.errors).toEqual(["MCP tool unavailable after two catalog-update retries"]);
    } finally {
      await model.close();
    }
  });
});

describe.skipIf(!enabled)("OpenCode v2 offline playback", () => {
  /** The shell calls' dialects from the tools drive's trace, once it has run. */
  let toolsShellDialects: unknown[] | undefined;
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
    const messages = playback.requests.at(-1).messages as { role: string; content: unknown }[];
    const carriesResult = (role: string) =>
      messages.filter(
        (message) => message.role === role && JSON.stringify(message.content).includes("hooknostic-child-result"),
      );
    if (backgroundSubagents()) {
      // execute.after fires at launch, so tool.after sees the launch notice and
      // never the child's result, which reaches the parent as a user message.
      expect(resultEvent.result.output.status).toBe("running");
      expect(JSON.stringify(resultEvent.result)).not.toContain("hooknostic-child-result");
      expect(carriesResult("tool")).toEqual([]);
      expect(carriesResult("user")).toEqual([
        expect.objectContaining({
          content: expect.stringMatching(
            new RegExp(
              `^<subagent sessionID="${child}" state="completed"[^>]*>\\s*hooknostic-child-result\\s*</subagent>$`,
            ),
          ),
        }),
      ]);
      expect(captured).toContainEqual(
        expect.objectContaining({
          hook: "event",
          event: expect.objectContaining({
            type: "session.inbox.enqueued",
            data: expect.objectContaining({
              sessionID: resultEvent.sessionID,
              item: expect.objectContaining({
                type: "synthetic",
                payload: expect.objectContaining({
                  metadata: expect.objectContaining({ source: "subagent", childID: child, state: "completed" }),
                }),
              }),
            }),
          }),
        }),
      );
    } else {
      expect(resultEvent.result.output).toMatchObject({ status: "completed", output: "hooknostic-child-result" });
      expect(carriesResult("tool")).toHaveLength(1);
      expect(carriesResult("user")).toEqual([]);
    }
  }, 70000);
  // One `subagent*` drive: its hook captures and the generated hooks' trace.
  type TraceEntry = {
    event: string;
    nativeEvent?: string;
    toolKind?: string;
    turnId?: string;
    lastMessage?: string;
    sessionId?: string;
    agentId?: string;
    agentType?: string;
    correlationAgentId?: string;
    parentAgentId?: string;
    nativeId?: string;
    instance?: string;
  };
  async function driveSubagent(mode: string) {
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
    const playback = JSON.parse(await readFile(join(root, "result.json"), "utf8"));
    expect(playback.errors).toEqual([]);
    const captured = (await readFile(join(root, "captured/events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const trace = (await readFile(join(root, "trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TraceEntry);
    const created = captured.filter(
      (row) => row.hook === "event" && row.event.type === "session.created" && row.event.data?.parentID,
    );
    expect(created).toHaveLength(1);
    const { sessionID: child, parentID: parent, agent } = created[0].event.data;
    const executions = (type: string) =>
      captured.filter(
        (row) =>
          row.hook === "event" && row.event.type === `session.execution.${type}` && row.event.data?.sessionID === child,
      ).length;
    return { captured, trace, child, parent, agent, executions };
  }
  it("reports a finished subagent as one agent.stop under its parent, after the child's own turn.stop", async () => {
    const { trace, child, parent, agent, executions } = await driveSubagent("subagent");
    expect(executions("succeeded")).toBe(1);
    const stops = trace.filter((entry) => entry.event === "agent.stop");
    expect(stops).toEqual([
      expect.objectContaining({
        nativeEvent: "event",
        sessionId: parent,
        agentId: child,
        agentType: agent,
        correlationAgentId: child,
        parentAgentId: parent,
        lastMessage: "hooknostic-child-result",
      }),
    ]);
    expect(stops[0]).not.toHaveProperty("turnId");
    const childStop = trace.findIndex((entry) => entry.event === "turn.stop" && entry.sessionId === child);
    expect(childStop).toBeGreaterThanOrEqual(0);
    expect(trace[childStop + 1]).toMatchObject({ event: "agent.stop", agentId: child });
    // The child's creation is one agent.start under the parent (#232): after
    // the parent's subagent call, before the child's own session.start and stops.
    const starts = trace.filter((entry) => entry.event === "agent.start");
    expect(starts).toEqual([
      expect.objectContaining({
        nativeEvent: "event",
        sessionId: parent,
        agentId: child,
        agentType: agent,
        correlationAgentId: child,
        parentAgentId: parent,
      }),
    ]);
    const started = trace.indexOf(starts[0]!);
    expect(trace.findIndex((entry) => entry.event === "tool.before" && entry.toolKind === "agent")).toBeLessThan(
      started,
    );
    expect(trace.findIndex((entry) => entry.event === "session.start" && entry.sessionId === child)).toBeGreaterThan(
      started,
    );
    expect(childStop).toBeGreaterThan(started);
    // The child's own turn.stop names its agent ids; the parent's names none.
    expect(trace[childStop]).toMatchObject({ correlationAgentId: child, parentAgentId: parent });
    const parentStops = trace.filter((entry) => entry.event === "turn.stop" && entry.sessionId === parent);
    expect(parentStops.length).toBeGreaterThan(0);
    for (const entry of parentStops) {
      expect(entry.correlationAgentId).toBeUndefined();
      expect(entry.parentAgentId).toBeUndefined();
    }
  }, 70000);
  it("reports a subagent that failed before any text as agent.stop without a last message", async () => {
    const { trace, child, parent, executions } = await driveSubagent("subagent-fail");
    expect(executions("failed")).toBe(1);
    expect(executions("succeeded")).toBe(0);
    const stops = trace.filter((entry) => entry.event === "agent.stop");
    expect(stops).toEqual([expect.objectContaining({ sessionId: parent, agentId: child, parentAgentId: parent })]);
    expect(stops[0]).not.toHaveProperty("lastMessage");
  }, 70000);
  it("reports each completion of a followed-up subagent as its own agent.stop", async () => {
    const { trace, child, parent, executions } = await driveSubagent("subagent-followup");
    expect(executions("succeeded")).toBe(2);
    expect(
      trace
        .filter((entry) => entry.event === "agent.stop")
        .map(({ sessionId, agentId, lastMessage }) => ({ sessionId, agentId, lastMessage })),
    ).toEqual([
      { sessionId: parent, agentId: child, lastMessage: "hooknostic-child-result" },
      { sessionId: parent, agentId: child, lastMessage: "hooknostic-child-follow-up-result" },
    ]);
    // A follow-up creates no session, so the child started once.
    expect(trace.filter((entry) => entry.event === "agent.start").map(({ agentId }) => agentId)).toEqual([child]);
  }, 70000);
  it("reports each parent execution a late background child starts as its own turn stop", async () => {
    const result = await runProcess(
      process.execPath,
      ["--experimental-strip-types", ".capture/opencode-v2/drive.mjs", "subagent-late"],
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
    const parent = captured.find((row) => row.hook === "execute.after" && row.event.tool === "subagent").event
      .sessionID as string;
    const succeeded = captured.filter(
      (row) =>
        row.hook === "event" &&
        row.event.type === "session.execution.succeeded" &&
        row.event.data?.sessionID === parent,
    );
    const trace = (await readFile(join(root, "trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; turnId?: string; lastMessage?: string });
    const prompts = trace.filter((entry) => entry.event === "prompt.before").map((entry) => entry.turnId);
    const stops = trace.filter((entry) => entry.event === "turn.stop");
    // The parent's prompt and the child's; the child's stop carries its own.
    expect(prompts).toHaveLength(2);
    expect(prompts.every((id) => typeof id === "string")).toBe(true);
    if (backgroundSubagents()) {
      // The parent finished before the child, whose <subagent> message started a
      // second parent execution. No prompt hook started it, so it has no turn id.
      expect(succeeded).toHaveLength(2);
      expect(stops).toHaveLength(3);
      expect(stops.filter((entry) => entry.turnId === undefined)).toEqual([
        expect.objectContaining({ lastMessage: "tool capture complete" }),
      ]);
    } else {
      // In the foreground the parent waits for the child within one execution.
      expect(succeeded).toHaveLength(1);
      expect(stops).toHaveLength(2);
      expect(stops.every((entry) => typeof entry.turnId === "string")).toBe(true);
    }
    expect(stops.flatMap((entry) => (entry.turnId === undefined ? [] : [entry.turnId])).sort()).toEqual(
      [...prompts].sort(),
    );
    // The child's own turn.stop, then its agent.stop under the parent, however
    // late the child finishes.
    const child = captured.find(
      (row) => row.hook === "event" && row.event.type === "session.created" && row.event.data?.parentID === parent,
    ).event.data.sessionID as string;
    type Ids = {
      event: string;
      sessionId?: string;
      agentId?: string;
      correlationAgentId?: string;
      parentAgentId?: string;
    };
    const ordered = (trace as Ids[]).filter(
      (entry) => entry.event === "agent.stop" || (entry.event === "turn.stop" && entry.sessionId === child),
    );
    // The child's own turn.stop names its agent ids too (#232).
    expect(
      ordered.map(({ event, sessionId, agentId, correlationAgentId, parentAgentId }) => ({
        event,
        sessionId,
        agentId,
        correlationAgentId,
        parentAgentId,
      })),
    ).toEqual([
      { event: "turn.stop", sessionId: child, agentId: undefined, correlationAgentId: child, parentAgentId: parent },
      { event: "agent.stop", sessionId: parent, agentId: child, correlationAgentId: child, parentAgentId: parent },
    ]);
    // However many top-level executions the parent ran, none of its stops does.
    for (const entry of (trace as Ids[]).filter((row) => row.event === "turn.stop" && row.sessionId !== child))
      expect([entry.correlationAgentId, entry.parentAgentId]).toEqual([undefined, undefined]);
  }, 70000);
  // Children this plugin instance never saw created (#232), over `serve`.
  const runReload = (mode: string) =>
    runProcess(process.execPath, ["--experimental-strip-types", ".capture/opencode-v2/drive.mjs", mode], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      env: process.env,
      timeoutMs: 90000,
    });
  async function driveReload(mode: string, ran?: Awaited<ReturnType<typeof runReload>>) {
    const result = ran ?? (await runReload(mode));
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const { root } = JSON.parse(result.stdout.split("\n").find((line) => line.startsWith('{"root"'))!);
    const audit = JSON.parse(await readFile(join(root, "reload.json"), "utf8"));
    expect(audit.errors).toEqual([]);
    const trace = (await readFile(join(root, "trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TraceEntry);
    return { audit, trace };
  }
  // Since #236 the old instance hands the child over when it is disposed, so
  // the new one knows it before its prompt; the restart test below is where
  // only the lookup can recognize it.
  it("recognizes a followed-up subagent after a plugin reload", async () => {
    const { audit, trace } = await driveReload("subagent-reload");
    const { parentID: parent, childID: child } = audit;
    // The old instance was disposed (the capture plugin's cleanup ran) before
    // the follow-up, and the child then completed once more.
    const records = audit.records as { hook: string; event: { type?: string; data?: { sessionID?: string } } }[];
    const cleanup = records.findIndex((row) => row.hook === "cleanup");
    expect(cleanup).toBeGreaterThanOrEqual(0);
    expect(cleanup).toBeLessThan(audit.reloadedAt);
    const completions = records.flatMap((row, index) =>
      row.hook === "event" && row.event.type === "session.execution.succeeded" && row.event.data?.sessionID === child
        ? [index]
        : [],
    );
    expect(completions).toHaveLength(2);
    expect(completions[1]).toBeGreaterThan(audit.reloadedAt);
    // The new instance never saw the child created: no second agent.start,
    // but the follow-up's stops still name the child and its parent.
    expect(trace.filter((entry) => entry.event === "agent.start").map(({ agentId }) => agentId)).toEqual([child]);
    expect(
      trace
        .filter((entry) => entry.event === "turn.stop" && entry.sessionId === child)
        .map(({ correlationAgentId, parentAgentId, lastMessage }) => ({
          correlationAgentId,
          parentAgentId,
          lastMessage,
        })),
    ).toEqual([
      { correlationAgentId: child, parentAgentId: parent, lastMessage: "hooknostic-child-result" },
      { correlationAgentId: child, parentAgentId: parent, lastMessage: "hooknostic-child-follow-up-result" },
    ]);
    expect(
      trace
        .filter((entry) => entry.event === "agent.stop")
        .map(({ sessionId, agentId, agentType, lastMessage }) => ({ sessionId, agentId, agentType, lastMessage })),
    ).toEqual([
      { sessionId: parent, agentId: child, agentType: "general", lastMessage: "hooknostic-child-result" },
      { sessionId: parent, agentId: child, agentType: "general", lastMessage: "hooknostic-child-follow-up-result" },
    ]);
  }, 100000);
  it("recognizes a followed-up subagent after a server restart, by looking up its parent", async () => {
    // A new process: no plugin instance hands the child over (#236), so the
    // lookup at the child's prompt is what recognizes it, on every build.
    const { audit, trace } = await driveReload("subagent-reload-restart");
    const { parentID: parent, childID: child } = audit;
    const records = audit.records as { hook: string; event: { type?: string; data?: { sessionID?: string } } }[];
    expect(records.filter((row) => row.hook === "setup").length).toBeGreaterThanOrEqual(2);
    const completions = records.flatMap((row, index) =>
      row.hook === "event" && row.event.type === "session.execution.succeeded" && row.event.data?.sessionID === child
        ? [index]
        : [],
    );
    expect(completions).toHaveLength(2);
    expect(completions[1]).toBeGreaterThan(audit.reloadedAt);
    expect(trace.filter((entry) => entry.event === "agent.start").map(({ agentId }) => agentId)).toEqual([child]);
    expect(
      trace
        .filter((entry) => entry.event === "turn.stop" && entry.sessionId === child)
        .map(({ correlationAgentId, parentAgentId }) => ({ correlationAgentId, parentAgentId })),
    ).toEqual([
      { correlationAgentId: child, parentAgentId: parent },
      { correlationAgentId: child, parentAgentId: parent },
    ]);
    expect(
      trace
        .filter((entry) => entry.event === "agent.stop")
        .map(({ sessionId, agentId, agentType }) => ({ sessionId, agentId, agentType })),
    ).toEqual([
      { sessionId: parent, agentId: child, agentType: "general" },
      { sessionId: parent, agentId: child, agentType: "general" },
    ]);
  }, 100000);
  it("recognizes a subagent child created through the API before plugin setup, where the API keeps its parent", async () => {
    const { audit, trace } = await driveReload("subagent-api-child");
    const { parentID: parent, childID: child } = audit;
    expect(audit.child).toMatchObject({ started: 1, succeeded: 1 });
    const childStops = trace.filter((entry) => entry.event === "turn.stop" && entry.sessionId === child);
    expect(childStops).toHaveLength(1);
    // Created before setup, so never seen created: no agent.start either way.
    expect(trace.filter((entry) => entry.event === "agent.start")).toEqual([]);
    // Branch on what this build's API did, not on its version: 2.0.17 dropped
    // the parentID, so the session is no child there.
    if (audit.keptParentID) {
      expect(childStops[0]).toMatchObject({ correlationAgentId: child, parentAgentId: parent });
      expect(trace.filter((entry) => entry.event === "agent.stop")).toEqual([
        expect.objectContaining({ sessionId: parent, agentId: child, agentType: "general", parentAgentId: parent }),
      ]);
    } else {
      expect([childStops[0]!.correlationAgentId, childStops[0]!.parentAgentId]).toEqual([undefined, undefined]);
      expect(trace.filter((entry) => entry.event === "agent.stop")).toEqual([]);
    }
  }, 100000);
  it("a subagent recovered after a plugin reload takes no stop prevention or notice", async () => {
    await expectNoPostToRecoveredChild("subagent-reload-stop");
  }, 100000);
  // Since #236 the reload above hands the child over; after a restart only
  // the lookup links it, so only this one pins that the lookup stores it.
  it("a subagent recovered after a server restart takes no stop prevention or notice", async () => {
    await expectNoPostToRecoveredChild("subagent-reload-restart-stop");
  }, 100000);
  async function expectNoPostToRecoveredChild(mode: string) {
    // With prevention and notices on every stop: the child's own stops must
    // post nothing, so prompting it once more starts exactly one execution
    // whose request carries neither the reason nor the notice.
    const { audit, trace } = await driveReload(mode);
    expect(audit.childAfter).toMatchObject({ started: 2, succeeded: 2 });
    expect(audit.childFinal).toMatchObject({ started: 3, succeeded: 3 });
    expect(audit.childRequests).toBe(3);
    expect(audit.childPosts).toBe(0);
    expect(
      trace
        .filter((entry) => entry.event === "turn.stop" && entry.sessionId === audit.childID)
        .map(({ correlationAgentId }) => correlationAgentId),
    ).toEqual([audit.childID, audit.childID, audit.childID]);
  }
  // A reload while a child runs (#236): OpenCode keeps the old plugin instance
  // until that execution ends (2.2.6, 2.3.0) or for good (2.0.17), and both
  // hear every event, with the same event ids.
  type Row = { hook: string; event: { id?: string; type?: string; data?: { sessionID?: string } } };
  // Thrown by .capture/opencode-v2/reload-audit.mjs for a timeout before its reload.
  const TRANSPORT_BEFORE_RELOAD = "hooknostic-transport-timeout-before-reload";
  async function driveRunning(mode: string) {
    // At most one more drive for each of two host conditions, never for a
    // failed assertion. The overlap is the host's timing: once among the
    // captured 2.3.0 runs the old instance went before the new one was set
    // up. A transport timeout before the reload has hit a local server about
    // once in 80 drives; the drive marks it, and nothing was tested yet.
    const redrives = new Set<string>();
    for (;;) {
      const ran = await runReload(mode);
      if (ran.code !== 0 && !redrives.has("transport") && (ran.stdout + ran.stderr).includes(TRANSPORT_BEFORE_RELOAD)) {
        redrives.add("transport");
        console.log(`[#236 re-drive] ${mode}: transport timeout before the reload`);
        continue;
      }
      const drive = await driveReload(mode, ran);
      if (!drive.audit.overlap && !redrives.has("overlap")) {
        redrives.add("overlap");
        console.log(`[#236 re-drive] ${mode}: no overlap`);
        continue;
      }
      return drive;
    }
  }
  // Distinct: on 2.0.17 the leaked old capture instance records each event again, with the same id.
  const completionIds = (
    records: Row[],
    sessionID: string,
    types = /^session\.execution\.(succeeded|failed|interrupted)$/,
  ) =>
    [
      ...new Set(
        records
          .filter(
            (row) =>
              row.hook === "event" && types.test(row.event.type ?? "") && row.event.data?.sessionID === sessionID,
          )
          .map((row) => row.event.id!),
      ),
    ].sort();
  const dispatched = (trace: TraceEntry[], event: string, key: "sessionId" | "agentId", id: string) =>
    trace.filter((entry) => entry.event === event && entry[key] === id);
  it("reports a session started while a reloaded plugin's old instance still runs once (#236)", async () => {
    const { audit, trace } = await driveRunning("subagent-reload-running");
    expect(audit.overlap).toBe(true);
    const fresh = audit.freshID as string;
    expect(dispatched(trace, "session.start", "sessionId", fresh)).toHaveLength(1);
    const prompts = dispatched(trace, "prompt.before", "sessionId", fresh).map((entry) => entry.turnId);
    expect(prompts).toHaveLength(1);
    // From the instance that took its prompt, so with that prompt's turn id.
    expect(
      dispatched(trace, "turn.stop", "sessionId", fresh).map(({ nativeId, turnId }) => ({ nativeId, turnId })),
    ).toEqual(completionIds(audit.records, fresh).map((nativeId) => ({ nativeId, turnId: prompts[0] })));
  }, 200000);
  it("reports every completion once across a reload while a subagent runs (#236)", async () => {
    const { audit, trace } = await driveRunning("subagent-reload-running");
    const {
      parentID: parent,
      childID: child,
      secondID: second,
    } = audit as { parentID: string; childID: string; secondID: string };
    // One turn.stop per completion: the parent's, the child's (running across
    // the reload, then followed up) and the new child's.
    for (const session of [parent, child, second])
      expect(
        dispatched(trace, "turn.stop", "sessionId", session)
          .map((entry) => entry.nativeId)
          .sort(),
      ).toEqual(completionIds(audit.records, session!));
    // One agent.stop per succeeded or failed child completion.
    for (const agent of [child, second])
      expect(
        dispatched(trace, "agent.stop", "agentId", agent!)
          .map((entry) => entry.nativeId)
          .sort(),
      ).toEqual(completionIds(audit.records, agent!, /^session\.execution\.(succeeded|failed)$/));
    // Each child started once, though a leaked old instance (2.0.17) also sees the new one created.
    expect(trace.filter((entry) => entry.event === "agent.start").map((entry) => entry.agentId)).toEqual([
      child,
      second,
    ]);
    expect(dispatched(trace, "session.start", "sessionId", second!)).toHaveLength(1);
    // The child that ran across the reload keeps its text and agent ids.
    expect(dispatched(trace, "turn.stop", "sessionId", child!)[0]).toMatchObject({
      lastMessage: "hooknostic-child-result",
      correlationAgentId: child,
      parentAgentId: parent,
    });
    expect(dispatched(trace, "agent.stop", "agentId", child!)[0]).toMatchObject({
      sessionId: parent,
      agentType: "general",
      lastMessage: "hooknostic-child-result",
    });
    // Each parent prompt's turn id on exactly one parent stop: the instance
    // that took the prompt reported it.
    const parentStops = dispatched(trace, "turn.stop", "sessionId", parent!);
    for (const turnId of dispatched(trace, "prompt.before", "sessionId", parent!).map((entry) => entry.turnId))
      expect(parentStops.filter((entry) => entry.turnId === turnId)).toHaveLength(1);
  }, 200000);
  it("a prompt steered into an execution the old instance still runs keeps its text and turn id (#236)", async () => {
    const { audit, trace } = await driveRunning("subagent-reload-running-steer");
    expect(audit.overlap).toBe(true);
    const { parentID: parent, childID: child } = audit as { parentID: string; childID: string };
    console.log(
      `[#236 steer] ${JSON.stringify({ child: audit.child, parent: audit.parent, parentRunning: audit.parentRunning })}`,
    );
    const turnIds = (session: string) =>
      dispatched(trace, "prompt.before", "sessionId", session).map((entry) => entry.turnId);
    // The child's first prompt, through the old instance, and the one steered into its execution.
    const [original, steered] = turnIds(child);
    expect(turnIds(child)).toHaveLength(2);
    const childStops = dispatched(trace, "turn.stop", "sessionId", child);
    expect(childStops.map((entry) => entry.nativeId).sort()).toEqual(completionIds(audit.records, child));
    // The execution the old instance ran: its text, and the id of the prompt that started it.
    expect(childStops[0]).toMatchObject({ lastMessage: "hooknostic-child-result", turnId: original });
    expect(dispatched(trace, "agent.stop", "agentId", child)[0]).toMatchObject({
      lastMessage: "hooknostic-child-result",
    });
    // A prompt steered into a running execution starts none of its own, so its
    // id is on no stop: absent, never wrong. One the host ran as its own
    // execution is on that execution's stop. Branch on what the host did: the
    // session's next event after the prompt is a start, or a completion.
    const records = audit.records as Row[];
    const startedItsOwn = (session: string, turnId: string | undefined) => {
      const at = records.findIndex(
        (row) => row.hook === "prompt" && (row.event as { messageID?: string }).messageID === turnId,
      );
      const next = records
        .slice(at + 1)
        .find(
          (row) =>
            row.hook === "event" &&
            row.event.data?.sessionID === session &&
            /^session\.execution\./.test(row.event.type ?? ""),
        );
      return next?.event.type === "session.execution.started";
    };
    for (const [session, turnId] of [
      [child, steered],
      [parent, turnIds(parent).at(-1)],
    ] as const)
      expect(trace.filter((entry) => entry.event === "turn.stop" && entry.turnId === turnId)).toHaveLength(
        startedItsOwn(session, turnId) ? 1 : 0,
      );
  }, 200000);
  it("prevents a stop once across a reload, and never a subagent's (#236)", async () => {
    const { audit, trace } = await driveRunning("subagent-reload-running-stop");
    expect(audit.overlap).toBe(true);
    // Each instance would prevent the fresh session's stop: its model saw the reason once.
    expect(audit.freshReasons).toBe(1);
    expect(audit.childPosts).toBe(0);
    const stops = trace
      .filter((entry) => entry.event === "turn.stop" || entry.event === "agent.stop")
      .map((entry) => `${entry.event} ${entry.nativeId}`);
    expect(new Set(stops).size).toBe(stops.length);
  }, 200000);
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
    const errors = trace.filter((row) => row.event === "tool.error");
    expect(errors.filter((row) => row.tool.nativeName === "read")).toEqual([
      expect.objectContaining({
        tool: expect.objectContaining({ nativeName: "read", kind: "file.read" }),
        error: { message: "File not found: definitely-missing-hooknostic.txt" },
        correlation: { toolCallId: "call_probe_1" },
      }),
    ]);
    const customErrorCapture = opencodeV2CapabilityProfiles
      .flatMap((profile) => profile.source.validatedOn ?? [])
      .find((record) => record.artifact === "fixtures/opencode/2.0/tool-custom-error.input.json");
    expect(customErrorCapture).toBeDefined();
    const customErrors = errors.filter((row) => row.tool.nativeName === "probe_failure");
    // Require the recaptured behavior on that build and newer playback. The
    // exact transition between the two captured builds is not established.
    if (semver.gte(version, customErrorCapture!.version)) expect(customErrors).toHaveLength(1);
    else if (semver.eq(version, opencodeV2Harness.referenceVersion)) expect(customErrors).toHaveLength(0);
    else expect(customErrors.length).toBeLessThanOrEqual(1);
    if (customErrors.length) {
      expect(customErrors[0]).toMatchObject({
        error: { message: "hooknostic-thrown-tool-error" },
        correlation: { toolCallId: "call_probe_2" },
      });
    }
    expect(errors).toHaveLength(1 + customErrors.length);
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
    // Kept for the dialect test below rather than asserted here, so a reworded
    // statement fails a test of its own (ADR-0029).
    toolsShellDialects = trace
      .filter((row) => row.event === "tool.before" && row.toolNativeName === "shell")
      .map((row) => row.shellDialect);
    // Both envelopes are visible. Neither carries an authoritative MCP identity.
    expect(trace.some((row) => row.toolKind === "mcp")).toBe(false);
    const inner = completed.find((row) => row.event.tool === "hooknostic_hooknostic_echo");
    expect(inner.event.input).toEqual({});
    expect(inner.event.result.content).toEqual([{ type: "text", text: "hooknostic-mcp-tool-output" }]);
  }, 70000);
  it("gives a captured shell call the dialect of the shell this build said it runs", (context) => {
    if (toolsShellDialects === undefined) return context.skip("the tools drive did not run");
    const expectation = openCodeShellDialectExpectation();
    if ("skip" in expectation) return context.skip(expectation.skip);
    expectOpenCodeShellDialect(toolsShellDialects, expectation.dialect);
  });
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
  it("serves a nested checkout from its own copy and each location only its own sessions", async () => {
    const driver = fileURLToPath(new URL("../../../.capture/opencode-v2/drive.mjs", import.meta.url));
    const result = await runProcess(process.execPath, ["--experimental-strip-types", driver, "nested"], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      env: process.env,
      timeoutMs: 120000,
    });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const { root } = JSON.parse(result.stdout.split("\n").find((line) => line.startsWith('{"root"'))!);
    const capture = JSON.parse(await readFile(join(root, "nested.json"), "utf8"));
    // OpenCode loads both copies for the nested location; each must stay active under its own id.
    expect(capture.nested.plugins.map((p: { status: string }) => p.status)).toEqual(["active", "active"]);
    expect(new Set(capture.nested.plugins.map((p: { id: string }) => p.id)).size).toBe(2);
    expect(capture.outer.plugins).toHaveLength(1);
    for (const [location, dispatches] of Object.entries(capture) as [string, { dispatches: string[] }][]) {
      expect(dispatches.dispatches).toContain(`${location}:turn.stop`);
      expect(
        dispatches.dispatches.every((row) => row.startsWith(`${location}:`)),
        dispatches.dispatches.join(", "),
      ).toBe(true);
    }
  }, 150000);
  it("prevents and notifies only after a succeeded top-level execution", async () => {
    const driver = fileURLToPath(new URL("../../../.capture/opencode-v2/drive.mjs", import.meta.url));
    const result = await runProcess(process.execPath, ["--experimental-strip-types", driver, "stop"], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      env: process.env,
      timeoutMs: 120000,
    });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const { root } = JSON.parse(result.stdout.split("\n").find((line) => line.startsWith('{"root"'))!);
    const capture = JSON.parse(await readFile(join(root, "stops.json"), "utf8"));
    expect(capture.errors).toEqual([]);
    // Prevention starts exactly one more execution, carrying the reason as a
    // user-role message; the later notice starts none and reaches the model
    // only when the next user prompt runs.
    expect(capture.prevent).toMatchObject({ started: 2, succeeded: 2, reasonRequests: 1 });
    expect(capture.prevent.noticeRequestsBeforeFollowUp).toBe(0);
    expect(capture.prevent.noticeRequestsAfterFollowUp).toBeGreaterThan(0);
    expect(capture.interrupt).toMatchObject({ started: 1, interrupted: 1 });
    expect(capture.fail).toMatchObject({ started: 1, failed: 1 });
    expect(capture.child.created?.data.parentID).toBe(capture.child.parentID);
    expect(capture.child.child).toMatchObject({ started: 1, succeeded: 1 });
    // From 2.3.0 the child runs in the background. Its result reaches the parent
    // as a user message, and starts a third parent execution when it arrives
    // after the prevention continuation has ended; when it arrives sooner it
    // joins a running one. Earlier builds return it as the tool's result.
    const background = backgroundSubagents();
    expect(capture.child.launch).toBe(background ? "running" : "completed");
    expect(capture.child.subagentMessageRequests > 0).toBe(background);
    const extra = capture.child.parent.succeeded - 2;
    expect(extra).toBeGreaterThanOrEqual(0);
    expect(extra).toBeLessThanOrEqual(background ? 1 : 0);
    expect(capture.child.parent).toMatchObject({ started: 2 + extra, failed: 0, interrupted: 0 });
    const events = await traceEvents(join(root, "trace.jsonl"));
    // Every completion is still observed: three for the prevented session, one
    // each for the interrupt and the failure, and two (or three) parent plus one child.
    expect(events.filter((event) => event === "turn.stop")).toHaveLength(8 + extra);
    // session.synthetic does not run the prompt hook: six real prompts, including the child's.
    expect(events.filter((event) => event === "prompt.before")).toHaveLength(6);
    // ADR-0027: each prompt's execution reports that prompt's id; the two
    // synthetic continuations, and an execution a child's result starts, run
    // no prompt hook and report none. The interrupt and the failure end before
    // any text, so the six (or seven) other stops carry text.
    const trace = (await readFile(join(root, "trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; lastMessage?: string; turnId?: string });
    const stops = trace.filter((entry) => entry.event === "turn.stop");
    const prompts = trace.filter((entry) => entry.event === "prompt.before").map((entry) => entry.turnId);
    expect(prompts.every((id) => typeof id === "string")).toBe(true);
    expect(stops.flatMap((entry) => (entry.turnId === undefined ? [] : [entry.turnId])).sort()).toEqual(
      [...prompts].sort(),
    );
    expect(stops.filter((entry) => entry.turnId === undefined)).toEqual(
      Array.from({ length: 2 + extra }, () => expect.objectContaining({ lastMessage: expect.any(String) })),
    );
    expect(stops.filter((entry) => entry.lastMessage !== undefined)).toHaveLength(6 + extra);
    // The child's completion is also one agent.stop, under its parent. It
    // neither takes the parent's prevention nor posts: the counts above hold,
    // and the parent was told to keep working only by its own prevention.
    expect(capture.child.reasonMessages).toBe(1);
    expect(
      (trace as { event: string; sessionId?: string; agentId?: string }[])
        .filter((entry) => entry.event === "agent.stop")
        .map(({ sessionId, agentId }) => ({ sessionId, agentId })),
    ).toEqual([{ sessionId: capture.child.parentID, agentId: capture.child.childID }]);
  }, 150000);
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
        path: expect.any(String),
        headers: {
          "x-hooknostic": mode === "project-remote" ? "remote-expanded" : "${HKN_REMOTE_HEADER}",
        },
        body: { params: { name: "hooknostic_echo", arguments: {} } },
      });
      // The captured builds differ in whether they append codemode=false;
      // forwarding the declared endpoint and header is the portable contract.
      const url = new URL(calls[0].path, "http://127.0.0.1");
      expect(url.pathname).toBe("/http");
      expect([...url.searchParams.entries()]).toEqual(url.searchParams.has("codemode") ? [["codemode", "false"]] : []);
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
  // The host's own switch, not Hooknostic's: a same-named entry the host layer
  // disabled is left alone, and the sibling projected server still starts.
  it("leaves a host-disabled projected MCP server alone and keeps the rest working", async () => {
    const driver = fileURLToPath(new URL("../../../.capture/opencode-v2/drive.mjs", import.meta.url));
    const result = await runProcess(
      process.execPath,
      ["--experimental-strip-types", driver, "project-components-host-disabled"],
      {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        env: process.env,
        timeoutMs: 60000,
      },
    );
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const { root } = JSON.parse(result.stdout.split("\n").find((line) => line.startsWith('{"root"'))!);
    await expect(access(join(root, "project/portable/startup.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await access(join(root, "project/portable/startup-other.json"));
    const captured = (await readFile(join(root, "captured/events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(captured.find((row) => row.hook === "skills").event).toContainEqual(
      expect.objectContaining({ id: "greet" }),
    );
    expect(await readFile(join(root, "project/hooknostic-tool.txt"), "utf8")).toBe("hooknostic-rewritten");
    const playback = JSON.parse(await readFile(join(root, "result.json"), "utf8"));
    expect(playback.errors).toEqual([]);
    expect(playback.code).toBe(0);
  }, 70000);
  // The ADR-0015 default is preserved: an inherited entry the host left enabled is
  // Hooknostic's to replace, so this is what a presence-only guard would break.
  it("replaces a same-named projected MCP server the host left enabled", async () => {
    const driver = fileURLToPath(new URL("../../../.capture/opencode-v2/drive.mjs", import.meta.url));
    const result = await runProcess(
      process.execPath,
      ["--experimental-strip-types", driver, "project-components-host-enabled"],
      {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        env: process.env,
        timeoutMs: 60000,
      },
    );
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const { root } = JSON.parse(result.stdout.split("\n").find((line) => line.startsWith('{"root"'))!);
    await access(join(root, "project/portable/startup.json"));
    await access(join(root, "project/portable/startup-other.json"));
    const captured = (await readFile(join(root, "captured/events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(captured.find((row) => row.hook === "skills").event).toContainEqual(
      expect.objectContaining({ id: "greet" }),
    );
    expect(await readFile(join(root, "project/hooknostic-tool.txt"), "utf8")).toBe("hooknostic-rewritten");
    const playback = JSON.parse(await readFile(join(root, "result.json"), "utf8"));
    expect(playback.errors).toEqual([]);
    expect(playback.code).toBe(0);
  }, 70000);
  it.each(["rewrite", "block", "context", "output", "block-prompt", "handler-error", "internal-error"] as const)(
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
                  : effect === "handler-error" || effect === "internal-error"
                    ? effect
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
            // Observed on 2.0.17 and 2.2.7: run loads plugins in the
            // `serve --stdio` process it starts, and their console.error
            // reached run's stderr with --print-logs and neither stream nor
            // the log file without it (.capture/opencode-v2-plugin-stderr).
            ...(effect === "handler-error" || effect === "internal-error" ? ["--print-logs"] : []),
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
        // The throw comes before the rewrite, so failing open runs the call as the
        // model sent it. An internal error is the rewrite itself failing: without
        // the shim's guard the host denies the call and no file is written
        // (.capture/opencode-v2-plugin-throw).
        else
          expect(await readFile(join(project, "hooknostic-tool.txt"), "utf8")).toContain(
            effect === "handler-error" || effect === "internal-error" ? "hooknostic-original" : "hooknostic-rewritten",
          );
        // #175: in-process, the report's channel is console.error.
        if (effect === "handler-error") expect(result.stderr).toMatch(PLAYBACK_HANDLER_ERROR_LINE);
        if (effect === "internal-error") {
          expect(result.stderr).toMatch(PLAYBACK_INTERNAL_ERROR_LINE);
          // Only the constructed failure: nothing else, such as the subscription
          // ending as the host shuts down, may be reported as a defect.
          expect(result.stderr).not.toMatch(PLAYBACK_STRAY_INTERNAL_ERROR_LINE);
        }
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
