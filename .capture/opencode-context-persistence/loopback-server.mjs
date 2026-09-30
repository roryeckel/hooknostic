// Recording OpenAI-compatible loopback. Writes every request body to captured/requests.jsonl.
import { createServer } from "node:http";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "captured", "requests.jsonl");
// captured/ is gitignored, so it does not exist on a fresh checkout and the
// documented procedure starts this server first.
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, "");

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    appendFileSync(out, JSON.stringify({ url: req.url, body: safe(body) }) + "\n");
    const wantsStream = (() => { try { return JSON.parse(body).stream === true; } catch { return false; } })();
    if (wantsStream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const id = "chatcmpl-probe";
      const base = { id, object: "chat.completion.chunk", created: 0, model: "probe" };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-probe", object: "chat.completion", created: 0, model: "probe",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
});

function safe(s) { try { return JSON.parse(s); } catch { return s; } }

server.listen(0, "127.0.0.1", () => {
  writeFileSync(join(here, "port.txt"), String(server.address().port));
  process.stderr.write(`[probe-server] listening on ${server.address().port}\n`);
});
