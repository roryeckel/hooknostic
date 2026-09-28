// Constructed model responses drive real hook-boundary captures. No external model.
import { createServer } from "node:http";
import { join } from "node:path";

export async function startToolModel(project, mcpOnly = false, remote = false, audit = false) {
  const requests = [], errors = [];
  let index = 0, baseUrl;
  const actions = audit === "patch" ? [
    // Offered instead of edit/write when the model id looks like a GPT model.
    ["patch", { patchText: "*** Begin Patch\n*** Add File: added.txt\n+hooknostic probe\n*** Update File: probe.txt\n@@\n-hooknostic-before-edit\n+hooknostic-after-edit\n*** End Patch" }],
  ] : audit === "subagent" ? [
    ["subagent", { agent: "general", description: "Offline child result capture", prompt: "hooknostic-child-task: return the scripted child result." }],
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
    const child = audit === "subagent" && request.messages?.some(message => message.role === "user" && JSON.stringify(message.content).includes("hooknostic-child-task"));
    const action = tools.length && !child ? actions[index++] : undefined;
    let delta = { role: "assistant", content: child ? "hooknostic-child-result" : "tool capture complete" };
    if (action) {
      const [name, args] = action;
      if (!tools.some(tool => tool.function?.name === name)) errors.push(`Missing tool ${name}`);
      delta = { role: "assistant", tool_calls: [{ index: 0, id: `call_probe_${index}`, type: "function",
        function: { name, arguments: JSON.stringify(typeof args === "function" ? args() : args) } }] };
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
