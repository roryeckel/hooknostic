// Constructed model responses drive real hook-boundary captures. No external model.
import { createServer } from "node:http";
import { join } from "node:path";

export async function startToolModel(project, mcpOnly = false, remote = false, audit = false) {
  const requests = [], errors = [];
  let index = 0, callIndex = 0, registrationRetries = 0, baseUrl;
  const actions = audit === "patch" ? [
    // Offered instead of edit/write when the model id looks like a GPT model.
    ["patch", { patchText: "*** Begin Patch\n*** Add File: added.txt\n+hooknostic probe\n*** Update File: probe.txt\n@@\n-hooknostic-before-edit\n+hooknostic-after-edit\n*** End Patch" }],
  ] : audit === "subagent" || audit === "subagent-late" || audit === "subagent-fail" ? [
    ["subagent", { agent: "general", description: "Offline child result capture", prompt: "hooknostic-child-task: return the scripted child result." }],
  ] : audit === "subagent-followup" ? [
    ["subagent", { agent: "general", description: "Offline child result capture", prompt: "hooknostic-child-task: return the scripted child result." }],
    // The same child again, by the session id its first call reported.
    ["subagent", (request) => ({ agent: "general", description: "Offline child follow-up", prompt: "hooknostic-child-task: hooknostic-follow-up.",
      sessionID: JSON.stringify(request.messages.findLast(message => message.role === "tool")?.content ?? "").match(/ses_[A-Za-z0-9]+/)?.[0] })],
  ] : String(audit).startsWith("subagent-reload") || audit === "subagent-api-child" ? [
    // Chosen by the prompt's marker below, not in order: a reload drive's
    // parent also runs executions no prompt started (a stop prevention, or a
    // background child's result), and those must not use up a scripted call.
  ] : audit === "subagent-opt-in" ? [
    // The opt-in background argument the tool offers up to 2.2.7.
    ["subagent", { agent: "general", description: "Offline child result capture", prompt: "hooknostic-child-task: return the scripted child result.", background: true }],
  ] : audit ? [
    ["read", { path: "definitely-missing-hooknostic.txt" }],
    ["probe_failure", {}],
    ["probe_rich", {}],
    ["probe_object", {}],
  ] : remote ? [
    ["execute", { code: "return await tools.http.hooknostic_echo({})" }],
    ...(remote === "remote" || remote === "remote-legacy" ? [["execute", { code: "return await tools.sse.hooknostic_echo({})" }]] : []),
  ] : mcpOnly ? [
    ["execute", { code: "return await tools.hooknostic.hooknostic_echo({})" }],
    ["execute", { code: "return await tools.hooknostic.custom_echo({})" }],
  ] : [
    ["write", { path: "probe.txt", content: "hooknostic-before-edit" }],
    ["read", { path: "probe.txt" }],
    ["edit", { path: "probe.txt", oldString: "hooknostic-before-edit", newString: "hooknostic-after-edit" }],
    ["glob", { pattern: "probe.txt", path: project }],
    ["grep", { pattern: "hooknostic-after-edit", path: project, include: "probe.txt" }],
    ["shell", { command: 'node -e "process.stdout.write(process.cwd())"', workdir: join(project, "working directory") }],
    ["webfetch", () => ({ url: baseUrl + "/probe", format: "text" })],
    ["websearch", { query: "hooknostic-boundary-probe" }],
    ["subagent", { agent: "general", description: "Boundary capture only", prompt: "Do not execute; this call is blocked by the capture hook." }],
    ["skill", { id: "native" }],
    ["skill", { id: "hooknostic-injected" }],
    ["execute", { code: "return await tools.hooknostic.hooknostic_echo({})" }],
  ];
  const server = createServer(async (req, res) => {
    if (req.url === "/probe") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hooknostic-webfetch-result");
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    requests.push(request);
    const tools = request.tools ?? [];
    const child = String(audit).startsWith("subagent") && request.messages?.some(message => message.role === "user" && JSON.stringify(message.content).includes("hooknostic-child-task"));
    const followUp = child && JSON.stringify(request.messages.findLast(message => message.role === "user")?.content ?? "").includes("hooknostic-follow-up");
    const lastTool = request.messages?.findLast(message => message.role === "tool");
    // Captured OAuth startup can list tools before the model's catalog catches
    // up. Retry the scripted call only after its unknown-tool result and the
    // native catalog update, with fresh call IDs and a strict retry budget.
    const registrationPending = typeof remote === "string" && remote.endsWith("-oauth") && index === 1 &&
      lastTool?.tool_call_id === `call_probe_${callIndex}` &&
      typeof lastTool.content === "string" && lastTool.content.startsWith("Unknown tool 'http.hooknostic_echo'") &&
      request.messages.some(message => message.role === "user" && typeof message.content === "string" &&
        message.content.includes("<system-update>") && message.content.includes("tools.http.hooknostic_echo"));
    let action;
    if (registrationPending) {
      if (registrationRetries < 2) {
        registrationRetries += 1;
        action = actions[0];
      } else errors.push("MCP tool unavailable after two catalog-update retries");
    } else if (String(audit).startsWith("subagent-reload")) {
      // A new child for the first parent prompt, the same child again (by the
      // session id its call reported) for the follow-up; text otherwise.
      const last = request.messages?.at(-1);
      const said = last?.role === "user" ? JSON.stringify(last.content ?? "") : "";
      const first = request.messages?.find(message => message.role === "tool" && /ses_[A-Za-z0-9]+/.test(JSON.stringify(message.content ?? "")));
      action = !tools.length || child ? undefined
        : said.includes("hooknostic-first-parent") ? ["subagent", { agent: "general", description: "Offline child result capture", prompt: "hooknostic-child-task: return the scripted child result." }]
        : said.includes("hooknostic-follow-up-parent") ? ["subagent", { agent: "general", description: "Offline child follow-up", prompt: "hooknostic-child-task: hooknostic-follow-up.",
          sessionID: JSON.stringify(first?.content ?? "").match(/ses_[A-Za-z0-9]+/)?.[0] }]
        // #236: a new child, not a follow-up, after the reload.
        : said.includes("hooknostic-new-child-parent") ? ["subagent", { agent: "general", description: "Offline second child", prompt: "hooknostic-child-task: hooknostic-second-child." }]
        : undefined;
    } else action = tools.length && !child ? actions[index++] : undefined;
    // Constructed timing: the child answers 3 s late, so a background child
    // (2.3.0 and later) outlives its parent's first execution.
    if (child && audit === "subagent-late") await new Promise(resolve => setTimeout(resolve, 3000));
    // #236, constructed timing: in the steer drive the continuation a stop
    // prevention starts in the parent answers 1.5 s late, so a prompt to the
    // parent lands while it runs, and it ends while the old plugin instance
    // still lives (it holds the parent's execution; the child runs for 4 s).
    if (!child && audit === "subagent-reload-running-steer" &&
        JSON.stringify(request.messages?.at(-1)?.content ?? "").includes("stop prevented once by harness playback"))
      await new Promise(resolve => setTimeout(resolve, 1500));
    // #236, constructed timing: the first child answers 4 s late, so the plugin
    // reload lands while it runs and the old instance outlives the reload.
    if (child && String(audit).startsWith("subagent-reload-running") && !followUp &&
        !JSON.stringify(request.messages).includes("hooknostic-second-child") &&
        !JSON.stringify(request.messages).includes("hooknostic-steer"))
      await new Promise(resolve => setTimeout(resolve, 4000));
    // Constructed failure: HTTP 400 fails the child's execution at once (a 500
    // is retried for about 90 s before it fails).
    if (child && audit === "subagent-fail") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "hooknostic-child-failure", type: "invalid_request_error" } }));
      return;
    }
    // Constructed timing, off unless set: an opt-in background child answers
    // late, so it outlives its parent's execution.
    if (child && audit === "subagent-opt-in" && process.env.HKN_CHILD_DELAY_MS)
      await new Promise(resolve => setTimeout(resolve, Number(process.env.HKN_CHILD_DELAY_MS)));
    let delta = { role: "assistant", content: followUp ? "hooknostic-child-follow-up-result" : child ? "hooknostic-child-result" : "tool capture complete" };
    if (action) {
      const [name, args] = action;
      callIndex += 1;
      if (!tools.some(tool => tool.function?.name === name)) errors.push(`Missing tool ${name}`);
      const values = typeof args === "function" ? args(request) : args;
      if (name === "subagent" && "sessionID" in values && typeof values.sessionID !== "string") errors.push("No child session id to follow up");
      delta = { role: "assistant", tool_calls: [{ index: 0, id: `call_probe_${callIndex}`, type: "function",
        function: { name, arguments: JSON.stringify(values) } }] };
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: `chatcmpl-probe-${index}`, object: "chat.completion.chunk", created: 0, model: "hooknostic-playback" };
    for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: action ? "tool_calls" : "stop" }])
      res.write(`data: ${JSON.stringify({ ...base, choices: [choice] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, requests, errors, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
