// #232 session.get probe driver: `serve` with only probe-plugin.js, a loopback
// model and the HTTP API. No credentials; isolated state under <root>.
// usage: node probe.mjs <opencode-executable> <scenario> <root>
// Scenarios: baseline, reload-mid-child, reload-mid-child-then-followup,
// reload-followup, api-child-presetup, otherloc-both. Writes <root>/outcome.json.
// Constructed timing: HKN_CHILD_DELAY_MS delays the child's model reply;
// HKN_TAIL_MS keeps the server up after the scenario (to see a late disposal).
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [executable, scenario, rootArgument] = process.argv.slice(2);
if (!executable || !scenario || !rootArgument) throw new Error("usage: probe.mjs <opencode-executable> <scenario> <root>");
const root = resolve(rootArgument);
await rm(root, { recursive: true, force: true });
const project = join(root, "project");
const other = join(root, "other");
const plugin = new URL("probe-plugin.js", import.meta.url);
await mkdir(join(project, ".opencode", "plugins"), { recursive: true });
await mkdir(join(other, ".opencode", "plugins"), { recursive: true });
await copyFile(plugin, join(project, ".opencode", "plugins", "probe.js"));
if (scenario === "otherloc-both") await copyFile(plugin, join(other, ".opencode", "plugins", "probe.js"));
const childDelay = Number(process.env.HKN_CHILD_DELAY_MS ?? 0);

// Loopback model: a parent prompt with the go marker calls the subagent tool
// once (the follow-up marker reuses the child's session id); a child answers.
const requests = [];
let childID,
  calls = 0;
const model = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  requests.push({ t: Date.now(), tools: (request.tools ?? []).length, last: request.messages?.at(-1)?.role });
  const isChild = (request.messages ?? []).some(
    (m) => m.role === "user" && JSON.stringify(m.content ?? "").includes("hooknostic-child-task"),
  );
  const last = request.messages?.at(-1);
  const lastUser = JSON.stringify(request.messages?.findLast((m) => m.role === "user")?.content ?? "");
  for (const m of request.messages ?? []) {
    const found = JSON.stringify(m.content ?? "").match(/ses_[A-Za-z0-9]+/);
    if (m.role === "tool" && found) childID = found[0];
  }
  let delta = { role: "assistant", content: isChild ? "hooknostic-child-result" : "parent done" };
  let action;
  if (isChild && childDelay) await delay(childDelay);
  if (!isChild && (request.tools ?? []).length && last?.role === "user" && /hooknostic-go/.test(lastUser)) {
    const follow = /hooknostic-go-follow-up/.test(lastUser);
    action = {
      agent: "general",
      description: follow ? "Probe follow-up" : "Probe child",
      prompt: follow ? "hooknostic-child-task: follow up." : "hooknostic-child-task: answer.",
      ...(follow && childID ? { sessionID: childID } : {}),
    };
    calls++;
    delta = {
      role: "assistant",
      tool_calls: [
        { index: 0, id: `call_probe_${calls}`, type: "function", function: { name: "subagent", arguments: JSON.stringify(action) } },
      ],
    };
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const head = { id: `p-${requests.length}`, object: "chat.completion.chunk", created: 0, model: "probe" };
  for (const choice of [
    { index: 0, delta, finish_reason: null },
    { index: 0, delta: {}, finish_reason: action ? "tool_calls" : "stop" },
  ])
    res.write(`data: ${JSON.stringify({ ...head, choices: [choice] })}\n\n`);
  res.end("data: [DONE]\n\n");
});
await new Promise((resolvePromise) => model.listen(0, "127.0.0.1", resolvePromise));
const config = {
  model: "playback/probe",
  providers: {
    playback: {
      name: "Playback",
      env: ["HKN_PLAYBACK_KEY"],
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${model.address().port}/v1` },
      models: { probe: { name: "Probe", limit: { context: 128000, output: 4096 } } },
    },
  },
};
await writeFile(join(project, "opencode.json"), JSON.stringify(config));
await writeFile(join(other, "opencode.json"), JSON.stringify(config));

const env = { ...process.env };
for (const name of Object.keys(env))
  if (/API_KEY|AUTH_TOKEN|SECRET|TOKEN|OPENCODE|OPENCHAMBER/i.test(name)) delete env[name];
Object.assign(env, {
  HOME: root,
  USERPROFILE: root,
  XDG_DATA_HOME: join(root, "data"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_STATE_HOME: join(root, "state"),
  HKN_CAPTURE_DIR: root,
  HKN_PLAYBACK_KEY: "local-playback",
  OPENCODE_SERVER_PASSWORD: "hooknostic-local",
});
const server = spawn(executable, ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], {
  cwd: project,
  env,
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});
let stdout = "",
  stderr = "";
server.stdout.on("data", (c) => (stdout += c));
server.stderr.on("data", (c) => (stderr += c));
const exited = new Promise((resolvePromise) => server.on("exit", resolvePromise));
const records = async () =>
  (await readFile(join(root, "probe.jsonl"), "utf8").catch(() => ""))
    .split("\n")
    .filter((l) => l.endsWith("}"))
    .map((l) => JSON.parse(l));
const wait = async (label, predicate, ms = 40000) => {
  for (let i = 0; i < ms / 100; i++) {
    const v = await predicate();
    if (v) return v;
    await delay(100);
  }
  throw new Error(`timeout: ${label}`);
};
const outcome = { scenario, childDelay, inline: process.env.HKN_GET_INLINE === "1", steps: [] };
const step = (s) => outcome.steps.push({ t: Date.now(), s });
try {
  const url = await wait("url", () => /http:\/\/127\.0\.0\.1:\d+/.exec(stdout + stderr)?.[0]);
  outcome.version = (stdout + stderr).match(/opencode v?(\d+\.\d+\.\d+)/)?.[1];
  const api = async (path, body, dir = project) => {
    const r = await fetch(url + "/api" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Basic " + Buffer.from("opencode:hooknostic-local").toString("base64"),
        "x-opencode-directory": encodeURIComponent(dir),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`${path} ${r.status} ${t}`);
    return t ? JSON.parse(t) : undefined;
  };
  const create = async (extra = {}, dir = project) => {
    const created = (
      await api(
        "/session",
        {
          location: { directory: dir },
          model: { id: "probe", providerID: "playback" },
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
          ...extra,
        },
        dir,
      )
    ).data;
    (outcome.created ??= []).push({ id: created.id, parentID: created.parentID, location: created.location?.directory });
    return created.id;
  };
  const succeeded = async (id, count = 1) =>
    (await records()).filter((r) => r.kind === "event" && r.type === "session.execution.succeeded" && r.sessionID === id)
      .length >= count;
  const childCreated = async () =>
    (await records()).find((r) => r.kind === "event" && r.type === "session.created" && r.parentID)?.sessionID;
  // Quiet: no new record for 1.5 s.
  const settle = async () => {
    let last = -1;
    for (let i = 0; i < 60; i++) {
      const n = (await records()).length;
      if (n === last) return;
      last = n;
      await delay(1500);
    }
  };

  if (scenario === "baseline" || scenario.startsWith("reload-mid-child")) {
    const parent = await create();
    outcome.parent = parent;
    await api(`/session/${parent}/prompt`, { text: "hooknostic-go" });
    step("prompted parent");
    const child = await wait("child created", childCreated);
    outcome.child = child;
    step("child created seen");
    if (scenario.startsWith("reload-mid-child")) {
      await api("/location/reload", {});
      step("reloaded");
    }
    await wait("child succeeded", () => succeeded(child), 60000);
    step("child succeeded seen");
    try {
      await wait("parent succeeded", () => succeeded(parent), 20000);
      step("parent succeeded seen");
    } catch {
      step("parent succeeded NOT seen in 20 s");
    }
    await settle();
    if (scenario === "reload-mid-child-then-followup") {
      await api(`/session/${parent}/prompt`, { text: "hooknostic-go-follow-up" });
      step("prompted follow-up");
      // Counted by event id: two live instances each record the same event.
      await wait(
        "child succeeded twice",
        async () =>
          (await records())
            .filter((r) => r.kind === "event" && r.type === "session.execution.succeeded" && r.sessionID === child)
            .reduce((ids, r) => ids.add(r.id), new Set()).size >= 2,
        60000,
      );
      await settle();
    }
  } else if (scenario === "reload-followup") {
    const parent = await create();
    outcome.parent = parent;
    await api(`/session/${parent}/prompt`, { text: "hooknostic-go" });
    const child = await wait("child created", childCreated);
    outcome.child = child;
    await wait("child succeeded", () => succeeded(child), 60000);
    await settle();
    await api("/location/reload", {});
    step("reloaded");
    await delay(1000);
    await api(`/session/${parent}/prompt`, { text: "hooknostic-go-follow-up" });
    step("prompted follow-up");
    await wait("child succeeded twice", () => succeeded(child, 2), 60000);
    await settle();
  } else if (scenario === "api-child-presetup") {
    // A child created through the API before any prompt, so before lazy plugin setup.
    const parent = await create();
    const child = await create({ parentID: parent, agent: "general", title: "API child" });
    outcome.parent = parent;
    outcome.child = child;
    step("created parent and child before any prompt");
    await delay(1500);
    await api(`/session/${child}/prompt`, { text: "hooknostic-child-task: answer." });
    step("prompted child directly");
    await wait("child succeeded", () => succeeded(child), 60000);
    await settle();
  } else if (scenario === "otherloc-both") {
    // Wake the project instance, then create a child of a project parent for
    // another location that has its own probe plugin.
    const parent = await create();
    outcome.parent = parent;
    await api(`/session/${parent}/prompt`, { text: "plain prompt" });
    await wait("parent succeeded", () => succeeded(parent));
    const child = await create(
      { parentID: parent, agent: "general", title: "Other-location child", location: { directory: other } },
      other,
    );
    outcome.child = child;
    step("created child for the other location");
    await api(`/session/${child}/prompt`, { text: "hooknostic-child-task: answer." }, other);
    await wait("child succeeded", () => succeeded(child), 60000);
    await settle();
  } else throw new Error("unknown scenario " + scenario);
  if (process.env.HKN_TAIL_MS) {
    await delay(Number(process.env.HKN_TAIL_MS));
    step(`tail ${process.env.HKN_TAIL_MS} ms`);
  }
  outcome.ok = true;
} catch (error) {
  outcome.ok = false;
  outcome.error = String(error.stack ?? error);
} finally {
  server.kill();
  await exited;
  model.close();
  model.closeAllConnections();
  outcome.records = await records();
  outcome.requests = requests;
  await writeFile(join(root, "outcome.json"), JSON.stringify(outcome, null, 2));
  console.log(JSON.stringify({ ok: outcome.ok, error: outcome.error?.split("\n")[0], records: outcome.records.length }));
}
