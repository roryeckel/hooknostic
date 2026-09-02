// One-shot capture driver: starts the loopback playback model server, wires
// the provider config, runs `opencode serve` with the permission probe, and
// drives a session that trips a bash permission ask. Modes: observe | deny.
// Usage: node run-capture.mjs observe|deny [waitMs]
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const mode = process.argv[2] ?? "observe";
const waitMs = Number(process.argv[3] ?? "60000");
const here = resolve(import.meta.dirname);
const scratch = mkdtempSync(join(tmpdir(), `hkn-perm-capture-${mode}-`));

// Hard exit: the driver must always terminate and print something. A hung
// teardown (taskkill, socket close, whatever) previously swallowed a fully
// successful capture when the shell timeout killed the process first.
const stage = (name) => console.error(`[stage] ${name} at ${new Date().toISOString()}`);
setTimeout(() => {
  console.error(JSON.stringify({ error: "watchdog expired", scratch, stage: "watchdog" }));
  process.exit(1);
}, waitMs + 90_000).unref();

// --- loopback playback model (openai-chat, SSE streaming; rewrite scenario) ---
// opencode's @ai-sdk/openai-compatible runtime expects streaming SSE chunks,
// not plain JSON completions (a plain-JSON server spins the agent loop forever
// -- observed 1600+ steps before this fix). Chunk shape mirrors the repo's
// chatTurn() in packages/cli/test/harness-playback.ts.
const requests = [];
let turn = 0;
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const url = req.url?.split("?")[0] ?? "";
    if (/\/v\d+\/models$/.test(url) || url === "/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ object: "model", id: "hooknostic-playback", owned_by: "hooknostic" }] }));
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    requests.push(body);
    const tools = body.tools ?? [];
    const isAgent = tools.length > 0;
    if (isAgent) turn += 1;
    const base = {
      id: `chatcmpl-playback-${turn}`,
      object: "chat.completion.chunk",
      created: 0,
      model: "hooknostic-playback",
    };
    const events = [];
    if (turn === 1 && isAgent) {
      // Turn 1: one bash tool call (mkdir the probe marker).
      const name = tools[0]?.function?.name ?? tools[0]?.name ?? "bash";
      events.push(
        { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_playback", type: "function", function: { name, arguments: "" } }] }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: "mkdir hooknostic-perm-probe" }) } }] }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      );
    } else {
      events.push(
        { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "playback complete" }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      );
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// --- assemble the capture project ---
mkdirSync(scratch, { recursive: true });
writeFileSync(
  join(scratch, "opencode.json"),
  readFileSync(join(here, "opencode.json.template"), "utf8").replaceAll("PORT_PLACEHOLDER", String(port)),
);
// plugin: copy the probe source (opencode loads .opencode/plugins/*.{ts,js})
mkdirSync(join(scratch, ".opencode", "plugins"), { recursive: true });
writeFileSync(join(scratch, ".opencode", "plugins", "perm-probe.ts"), readFileSync(join(here, ".opencode", "plugins", "perm-probe.ts"), "utf8"));

const env = {
  ...process.env,
  HKN_PERM_MODE: mode,
  HKN_CAPTURE_DIR: scratch,
  PWD: scratch,
  OPENCODE_SERVER_PASSWORD: "hkn-capture",
  OPENCODE_SERVER_USERNAME: "hooknostic",
};
delete env.OPENCODE;
delete env.OPENCODE_PID;
delete env.OPENCODE_BINARY;
delete env.OPENCODE_CONFIG_CONTENT;

const auth = { authorization: `Basic ${Buffer.from("hooknostic:hkn-capture").toString("base64")}` };
const servePort = 47461 + Number(process.pid % 100);
const serve = spawn("opencode", ["serve", "--port", String(servePort), "--print-logs"], {
  cwd: scratch, shell: process.platform === "win32", env, stdio: ["ignore", "pipe", "pipe"],
});
let serveLog = "";
const logPath = join(scratch, "serve.log");
serve.stdout.setEncoding("utf8").on("data", (d) => {
  serveLog += d;
  appendFileSync(logPath, d);
});
serve.stderr.setEncoding("utf8").on("data", (d) => {
  serveLog += d;
  appendFileSync(logPath, d);
});

const base = `http://127.0.0.1:${servePort}`;
const authHeaders = { ...auth, "content-type": "application/json" };
let ready = false;
for (let i = 0; i < 80; i += 1) {
  try {
    const probe = await fetch(`${base}/app`, { headers: auth });
    if (probe.ok) { ready = true; break; }
  } catch { /* retry */ }
  await new Promise((r) => setTimeout(r, 500));
}
if (!ready) {
  console.error(JSON.stringify({ error: "serve never ready", serveLog: serveLog.slice(-2000) }));
  spawn("taskkill", ["/pid", String(serve.pid), "/T", "/F"], { stdio: "ignore" });
  server.close();
  process.exit(1);
}

const created = await (await fetch(`${base}/session`, { method: "POST", headers: authHeaders, body: "{}" })).json();
stage("session created");
// Fire, don't await: opencode's POST message endpoint returns only when the
// turn completes, and in observe mode the pending permission ask blocks the
// turn forever (the endpoint hanging here is itself evidence the ask is a
// real, unanswered prompt). The capture signal is the probe's jsonl.
fetch(`${base}/session/${created.id}/message`, {
  method: "POST", headers: authHeaders,
  body: JSON.stringify({
    model: { providerID: "playback", modelID: "hooknostic-playback" },
    parts: [{ type: "text", text: "Use the bash tool exactly once to run: mkdir hooknostic-perm-probe. Then stop." }],
  }),
}).then((r) => appendFileSync(logPath, `\n[message-post] status ${r.status}\n`)).catch((e) => appendFileSync(logPath, `\n[message-post-error] ${e}\n`));
stage("prompt posted (async)");
// Wait for the capture to land: poll the probe's observed jsonl (in deny
// mode also the answered jsonl), then poll the transcript for the completion
// text so deny runs get the full before/after picture. Observe mode stops at
// the observed file -- the ask stays pending forever by design.
const deadline = Date.now() + waitMs;
const observedPath = join(scratch, "captured", "permission-observed.jsonl");
const answeredPath = join(scratch, "captured", "permission-answered.jsonl");
const waitUntil = async (predicate) => {
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};
const observed = await waitUntil(() => existsSync(observedPath));
stage(`observed jsonl: ${observed}`);
let transcript = [];
if (mode === "deny") {
  const answered = await waitUntil(() => existsSync(answeredPath));
  stage(`answered jsonl: ${answered}`);
  const done = await waitUntil(() =>
    transcript.some(
      (m) => m.info?.role === "assistant" && (m.parts ?? []).some((p) => p.type === "text" && p.text?.includes("playback complete")),
    ),
  );
  stage(`deny turn completed: ${done}`);
}
try {
  transcript = await (await fetch(`${base}/session/${created.id}/message`, { headers: auth, signal: AbortSignal.timeout(5000) })).json();
} catch { /* best effort */ }

const kill = spawn("taskkill", ["/pid", String(serve.pid), "/T", "/F"], { stdio: "ignore" });
await new Promise((r) => kill.on("close", r));
stage("serve killed");
// opencode's fetch agent holds keep-alive sockets to the loopback; close()
// alone waits on them and the driver never exits (observed: the driver hung
// after a successful capture, past the final console.log).
server.closeAllConnections();
server.close();
stage("loopback closed");

const capturedObserved = join(scratch, "captured", "permission-observed.jsonl");
const rendered = transcript.map((m) => ({ role: m.info?.role, text: (m.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join(" ") }));
console.log(JSON.stringify({
  mode,
  scratch,
  agentRequests: requests.filter((r) => (r.tools ?? []).length > 0).length,
  markerExists: existsSync(join(scratch, "hooknostic-perm-probe")),
  observedLines: existsSync(capturedObserved) ? readFileSync(capturedObserved, "utf8").trim().split("\n").filter(Boolean).length : 0,
  transcript: rendered,
  serveLogTail: serveLog.slice(-3000),
}, null, 2));