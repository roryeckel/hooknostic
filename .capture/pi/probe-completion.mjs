// Real Pi RPC completion edges against a credential-free, fault-injected loopback.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { register } from "node:module";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url).href);
const { spawnIntact, runProcess, startModelPlayback, writePiProviderExtension } =
  await import("../../packages/cli/test/harness-playback.ts");
const { withoutCredentials } = await import("../../scripts/drive-capture-session.mjs");
const { piHarness } = await import("../../packages/adapter-pi/src/harness.ts");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const executable = process.env.HKN_PI_BINARY ?? "pi";
const projectArgument = process.argv.indexOf("--project");
const root = mkdtempSync(join(tmpdir(), "hkn-pi-completion-"));
const project = projectArgument >= 0 ? resolve(process.argv[projectArgument + 1]) : join(root, "project");
const outputArgument = process.argv.indexOf("--output");
const output =
  outputArgument >= 0
    ? resolve(process.argv[outputArgument + 1])
    : join(repo, ".capture/pi/captured-completion", process.platform + ".json");
const capturePath = join(root, "settled.jsonl");
const events = [];
const requests = [];
let fault = "success";
let phase;
let client;
let proxy;
let playback;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const replies = ["BASELINE", "AFTER_ERROR", "AFTER_ABORT", "RETRY", "AFTER_RETRY_ABORT", "RESUMED"];

async function waitFor(test, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = test();
    if (value) return value;
    if (client?.error) throw client.error;
    if (client?.closed) throw new Error(`${label}: Pi exited ${client.code}: ${client.stderr}`);
    await delay(25);
  }
  throw new Error(`Timed out: ${label}; ${client?.stderr}`);
}

function startClient(provider, env, sessionFile) {
  const child = spawnIntact(
    executable,
    [
      "--mode",
      "rpc",
      "--provider",
      "hooknostic-playback",
      "--model",
      "hooknostic-playback",
      "-e",
      provider,
      "-e",
      fileURLToPath(new URL("./completion-context.js", import.meta.url)),
      "--no-skills",
      "--approve",
      ...(sessionFile ? ["--session", sessionFile] : []),
    ],
    { cwd: project, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  const state = { child, closed: false, code: null, stderr: "", rows: [], count: 0 };
  let pending = "";
  child.stdout.on("data", (data) => {
    pending += data;
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines.filter(Boolean)) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        state.error = new Error("Invalid Pi RPC output: " + line.slice(0, 1000));
        return;
      }
      state.rows.push(event);
      if (event.type === "auto_retry_start" || event.type === "auto_retry_end" || event.type === "agent_settled")
        events.push({ phase, event });
      if (event.type === "auto_retry_start" && phase === "retry") fault = "success";
    }
  });
  child.stderr.on("data", (data) => {
    state.stderr += data;
  });
  child.stdin.on("error", (error) => {
    state.stderr += error.message;
  });
  child.on("error", (error) => {
    state.stderr += error.message;
    state.closed = true;
  });
  child.on("close", (code) => {
    state.code = code;
    state.closed = true;
  });
  state.command = async (type, extra = {}) => {
    const id = String(++state.count);
    child.stdin.write(JSON.stringify({ id, type, ...extra }) + "\n");
    const response = await waitFor(() => state.rows.find((row) => row.type === "response" && row.id === id), type);
    if (!response.success) throw new Error(`${type}: ${response.error}`);
    return response.data;
  };
  return state;
}

async function stopClient() {
  const state = client;
  state.child.stdin.end();
  const deadline = Date.now() + 5000;
  while (!state.closed && Date.now() < deadline) await delay(25);
  if (!state.closed) {
    await killClient(state);
    throw new Error("Pi did not close after stdin EOF");
  }
  if (state.code !== 0) throw new Error(`Pi exit ${state.code}: ${state.stderr}`);
  client = undefined;
}

async function killClient(state) {
  if (process.platform === "win32" && state.child.pid) {
    await runProcess("taskkill", ["/pid", String(state.child.pid), "/T", "/F"], {
      cwd: project,
      env: withoutCredentials(),
      timeoutMs: 5000,
    });
  } else state.child.kill("SIGKILL");
  const deadline = Date.now() + 5000;
  while (!state.closed && Date.now() < deadline) await delay(25);
}

async function prompt(name, mode, action) {
  phase = name;
  fault = mode;
  const offset = client.rows.length;
  const requestOffset = requests.length;
  await client.command("prompt", { message: name });
  if (action === "abort") {
    await waitFor(() => requests.length > requestOffset, "pending model request");
    await client.command("abort");
  } else if (action === "abort-retry") {
    await waitFor(() => client.rows.slice(offset).some((row) => row.type === "auto_retry_start"), "retry backoff");
    await client.command("abort_retry");
  }
  await waitFor(() => client.rows.slice(offset).some((row) => row.type === "agent_settled"), name + " settled");
}

try {
  for (const path of [project, join(project, ".git"), join(project, ".pi"), join(root, "agent")])
    mkdirSync(path, { recursive: true });
  writeFileSync(
    join(project, ".pi/settings.json"),
    JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 25 } }),
  );
  const env = {
    ...withoutCredentials(),
    HOME: root,
    USERPROFILE: root,
    PI_CODING_AGENT_DIR: join(root, "agent"),
    HKN_PI_COMPLETION_CAPTURE: capturePath,
  };
  const detected = await runProcess(executable, ["--version"], { cwd: project, env });
  const version = detected.stdout.trim();
  // Scheduled playback may intentionally exercise a newer candidate build.
  const expectedVersion =
    projectArgument >= 0
      ? (process.env.HOOKNOSTIC_PLAYBACK_VERSION ?? piHarness.referenceVersion)
      : piHarness.referenceVersion;
  if (detected.code !== 0 || version !== expectedVersion)
    throw new Error(`Expected Pi ${expectedVersion}; found ${version}`);
  playback = await startModelPlayback(
    "openai-chat",
    "rewrite",
    replies.map((name) => ({ kind: "text", text: "COMPLETION_" + name })),
  );
  proxy = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const selected = fault;
    requests.push({ phase, fault: selected, body: JSON.parse(body.toString()) });
    if (selected === "hold") return;
    if (selected === "error" || selected === "retry") {
      response.writeHead(selected === "error" ? 400 : 503, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: selected === "error" ? "completion probe bad request" : "completion probe overloaded" },
        }),
      );
      return;
    }
    const result = await fetch(playback.baseUrl + request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    response.writeHead(result.status, { "content-type": result.headers.get("content-type") });
    for await (const chunk of result.body) response.write(chunk);
    response.end();
  });
  await new Promise((done) => proxy.listen(0, "127.0.0.1", done));
  const provider = await writePiProviderExtension(project, `http://127.0.0.1:${proxy.address().port}`);
  client = startClient(provider, env);
  await prompt("baseline", "success");
  await prompt("error", "error");
  await prompt("after-error", "success");
  await prompt("aborted", "hold", "abort");
  await prompt("after-abort", "success");
  await prompt("retry", "retry");
  await prompt("retry-aborted", "retry", "abort-retry");
  await prompt("after-retry-abort", "success");
  const { sessionFile } = await client.command("get_state");
  if (!sessionFile) throw new Error("No persisted session to reopen");
  await stopClient();
  client = startClient(provider, env, sessionFile);
  await prompt("resumed", "success");
  await stopClient();
  const cases = readFileSync(capturePath, "utf8").trim().split("\n").map(JSON.parse);
  if (
    cases.length !== 9 ||
    !events.some(({ phase, event }) => phase === "retry" && event.type === "auto_retry_end" && event.success)
  )
    throw new Error("Incomplete completion probe");
  const expected = {
    baseline: "BASELINE",
    "after-error": "AFTER_ERROR",
    "after-abort": "AFTER_ABORT",
    retry: "RETRY",
    "after-retry-abort": "AFTER_RETRY_ABORT",
    resumed: "RESUMED",
  };
  for (const entry of cases) {
    const leaf = entry.branch.filter((row) => row.type === "message").at(-1)?.message;
    if (expected[entry.prompt]) {
      if (
        leaf?.stopReason !== "stop" ||
        leaf.content.map((part) => part.text ?? "").join("\n") !== "COMPLETION_" + expected[entry.prompt]
      )
        throw new Error("Unexpected completion: " + entry.prompt);
    } else if (leaf?.stopReason !== (entry.prompt === "aborted" ? "aborted" : "error"))
      throw new Error("Unexpected failure outcome: " + entry.prompt);
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(
    output,
    JSON.stringify(
      {
        version,
        date: new Date().toISOString(),
        platform: process.platform,
        account: userInfo().username,
        home: homedir(),
        cases,
        events,
        requests,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      version,
      cases: cases.map(({ prompt, branch }) => ({
        prompt,
        stopReason: branch.filter((entry) => entry.type === "message").at(-1)?.message.stopReason,
      })),
      modelRequests: requests.length,
      output,
    }),
  );
} finally {
  if (client && !client.closed) {
    client.child.stdin.destroy();
    await killClient(client);
  }
  proxy?.closeAllConnections();
  if (proxy) await new Promise((done) => proxy.close(done));
  if (playback) await playback.close();
  if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("hkn-pi-completion-"))
    throw new Error("Unexpected scratch root");
  rmSync(root, { recursive: true, force: true });
}
