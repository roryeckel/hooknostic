// Constructed loopback replies. Captures come from OpenCode, not this server.
import { createServer } from "node:http";

export async function startSessionModel() {
  const requests = [], errors = [];
  let mode = "tool";
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    requests.push(request);
    const agent = request.tools?.length;
    if (agent && mode === "hang") return;
    if (agent && mode === "fail") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "hooknostic-model-failure", type: "invalid_request_error" } }));
      return;
    }
    const tool = agent && !request.messages.some(message => message.role === "tool");
    const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: "call_session_probe", type: "function",
      function: { name: "shell", arguments: JSON.stringify({ command: `node -e "require('node:fs').appendFileSync('permission-executed.txt','executed\\n')"` }) } }] }
      : { role: "assistant", content: "session probe complete" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }])
      res.write(`data: ${JSON.stringify({ id: "chatcmpl-session", object: "chat.completion.chunk", created: 0, model: "hooknostic-playback", choices: [choice] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests, errors,
    setMode(value) { mode = value; },
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
