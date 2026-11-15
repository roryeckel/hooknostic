#!/usr/bin/env node
// What does OpenCode 2.x do when a plugin hook callback throws an ordinary
// Error (not a deliberate block)? No model spend: the binary runs against the
// loopback playback model, which scripts one shell call that writes
// hooknostic-tool.txt, then text. The plugin is throw-plugin.js, not the
// hooknostic shim. See README.md.
//
//   node --experimental-strip-types drive.mjs [case...]
//
// Cases are `run:<domain>`, `run-logs:<domain>` (run with --print-logs) and
// `serve-<allow|ask>:<domain>`; the default is all of them. <domain> is
// `none` or `<domain>:<hook>` as in throw-plugin.js. HKN_OPENCODE_BINARY picks
// the binary (default `opencode` on PATH); HKN_REPO the hooknostic checkout
// (default: two levels up, as when committed under .capture/<name>/).
// HKN_RAW_DIR, if set, receives each case's raw stdout, stderr, trace and
// model requests. Prints one JSON line per case.
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.env.HKN_REPO ? pathToFileURL(process.env.HKN_REPO.replace(/[\\/]?$/, "/")) : new URL("../../", import.meta.url);
register(new URL("scripts/ts-resolve-hook.mjs", repo).href);
const { runProcess, startModelPlayback } = await import(new URL("packages/cli/test/harness-playback.ts", repo).href);

const MESSAGE = "hkn-probe-internal-error";
const SUMMARY =
  "## Objective\n- Exercise offline hooks.\n## Requirements\n- Use the loopback model.\n## Decisions\n- Keep the probe isolated.\n## Work State\n### Completed\n- Ran the shell probe.\n### Active\n- None.\n### Blocked\n- None.\n## Next Move\n1. Finish the probe.\n## Relevant Files\n- hooknostic-tool.txt\n## Important Context\n- hooknostic-valid-compaction-summary";
const RUN_DOMAINS = [
  "none",
  "tool:execute.before",
  "tool:execute.after",
  "session:prompt",
  "session:context",
  "session:title",
  "permission:evaluate",
  "event:loop",
];
const SERVE_CASES = [
  "serve-allow:none",
  "serve-ask:none",
  "serve-allow:permission:evaluate",
  "serve-ask:permission:evaluate",
  "serve-allow:session:generate",
  "serve-allow:session:compaction",
  "serve-allow:event:loop",
];
const ALL = [...RUN_DOMAINS.flatMap((d) => [`run:${d}`, `run-logs:${d}`]), ...SERVE_CASES];
const binary = process.env.HKN_OPENCODE_BINARY ?? "opencode";
const cases = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ALL;
const COMPLETIONS = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}
const rows = async (path) =>
  (await readFile(path, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
const toolResults = (requests) =>
  requests.flatMap((r) =>
    (Array.isArray(r.messages) ? r.messages : [])
      .filter((m) => m.role === "tool")
      .map((m) => String(typeof m.content === "string" ? m.content : JSON.stringify(m.content)).slice(0, 300)),
  );

async function serveDrive({ project, env, permission, trace, ask }) {
  const server = spawn(binary, ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], {
    cwd: project,
    env: { ...env, OPENCODE_SERVER_PASSWORD: "hooknostic-local" },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "",
    exit;
  server.stdout.on("data", (c) => (stdout += c));
  server.stderr.on("data", (c) => (stderr += c));
  const done = new Promise((r) => server.on("exit", (code) => r((exit = code))));
  const wait = async (predicate, ms = 30_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
      const v = await predicate();
      if (v) return v;
      if (exit !== undefined) return undefined;
    }
    return undefined;
  };
  const out = {};
  try {
    const url = await wait(() => /http:\/\/127\.0\.0\.1:\d+/.exec(stdout + stderr)?.[0]);
    if (!url) throw new Error("no server url\n" + stdout + stderr);
    const api = async (path, body) => {
      try {
        const res = await fetch(url + "/api" + path, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Basic " + Buffer.from("opencode:hooknostic-local").toString("base64"),
            "x-opencode-directory": encodeURIComponent(project),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(30_000),
        });
        const text = await res.text();
        return { status: res.status, body: text.slice(0, 400), json: (() => { try { return JSON.parse(text); } catch { return undefined; } })() };
      } catch (error) {
        return { status: null, body: String(error).slice(0, 400) };
      }
    };
    const created = await api("/session", {
      location: { directory: project },
      model: { id: "hooknostic-playback", providerID: "playback" },
      permissions: [{ action: "*", resource: "*", effect: permission }],
    });
    const id = created.json?.data?.id;
    out.session = { status: created.status, id };
    out.prompt = (({ status, body }) => ({ status, body }))(await api(`/session/${id}/prompt`, { text: "Use the shell once, then stop." }));
    const completed = async () =>
      (await rows(trace)).find((r) => r.hook === "event" && COMPLETIONS.includes(r.type) && r.sessionID === id);
    if (ask) {
      const pending = await wait(async () => (await api(`/session/${id}/permission`)).json?.data?.[0] ?? (await completed()), 20_000);
      if (pending && pending.id) {
        out.pendingPermission = { id: pending.id, action: pending.action };
        out.reply = (await api(`/session/${id}/permission/${pending.id}/reply`, { decision: "once" })).status;
      } else out.pendingPermission = null;
    }
    out.completion = (await wait(completed))?.type ?? null;
    for (const kind of ["generate", "compact"]) {
      const res = await api(`/session/${id}/${kind}`, kind === "generate" ? { prompt: "Summarize the session." } : {});
      out[kind] = { status: res.status, body: res.body.slice(0, 200) };
      if (kind === "compact")
        out.compactionEvent =
          (
            await wait(async () =>
              (await rows(trace)).find(
                (r) => r.hook === "event" && ["session.compaction.ended", "session.compaction.failed"].includes(r.type),
              ),
            15_000)
          )?.type ?? null;
    }
    // Is the server still serving after the throw?
    await sleep(1000);
    out.aliveAfter = exit === undefined ? (await api("/session")).status : `exited ${exit}`;
  } finally {
    server.kill();
    await Promise.race([done, sleep(5000)]);
  }
  return { ...out, serverExit: exit ?? "killed", stdout, stderr };
}

for (const name of cases) {
  const [mode, ...rest] = name.split(":");
  const domain = rest.join(":");
  const root = await mkdtemp(join(await realpath(tmpdir()), `hkn-v2-throw-`));
  const project = join(root, "project");
  await mkdir(join(project, ".opencode/plugins"), { recursive: true });
  await copyFile(new URL("throw-plugin.js", import.meta.url), join(project, ".opencode/plugins/throw.js"));
  const trace = join(root, "trace.jsonl");
  const env = {
    ...process.env,
    PWD: project,
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    HKN_PLAYBACK_KEY: "loopback",
    HKN_THROW: domain,
    HKN_THROW_TRACE: trace,
  };
  for (const key of Object.keys(env)) if (/API_KEY|AUTH_TOKEN|SECRET|TOKEN|^OPENCODE|^HOOKNOSTIC/.test(key)) delete env[key];
  const version = (await runProcess(binary, ["--version"], { cwd: root, env })).stdout.trim().replace(/^opencode v/, "");
  const model = await startModelPlayback("openai-chat", "rewrite", [{ kind: "tool", disposition: "rewrite" }, { kind: "text", text: SUMMARY }]);
  let record = { case: name, version, platform: process.platform };
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
    let stdout = "",
      stderr = "";
    if (mode === "run" || mode === "run-logs") {
      const args = ["run", "--standalone", ...(mode === "run-logs" ? ["--print-logs"] : []), "--auto", "--format", "json", "Use the shell once, then stop."];
      record.args = args;
      try {
        const result = await runProcess(binary, args, { cwd: project, env, timeoutMs: 90_000 });
        record.code = result.code;
        ({ stdout, stderr } = result);
      } catch (error) {
        record.code = "timeout";
        stderr = String(error);
      }
    } else {
      const permission = mode === "serve-ask" ? "ask" : "allow";
      record.args = ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0", "--print-logs", `(session permissions: ${permission})`];
      const served = await serveDrive({ project, env, permission, trace, ask: permission === "ask" });
      ({ stdout, stderr } = served);
      delete served.stdout;
      delete served.stderr;
      record = { ...record, ...served };
    }
    const traced = await rows(trace);
    const state = (await files(root)).filter((f) => !f.startsWith(project));
    const cache = join(root, "cache");
    const logs = [];
    for (const f of state.filter((f) => !f.startsWith(cache)))
      if ((await readFile(f, "utf8").catch(() => "")).includes(MESSAGE)) logs.push(relative(root, f));
    const agent = model.requests.filter((r) => Array.isArray(r.tools) && r.tools.length > 0).length;
    Object.assign(record, {
      threw: traced.filter((r) => r.threw).length,
      fired: [...new Set(traced.map((r) => r.hook))].filter((h) => h !== "event"),
      evaluateEffects: traced.filter((r) => r.hook === "permission:evaluate").map((r) => r.effect),
      completions: traced.filter((r) => r.hook === "event" && COMPLETIONS.includes(r.type)).map((r) => r.type),
      toolRan: (await readFile(join(project, "hooknostic-tool.txt"), "utf8").catch(() => "")).includes("hooknostic-original"),
      agentRequests: agent,
      auxiliaryRequests: model.requests.length - agent,
      modelSawMessage: JSON.stringify(model.requests).includes(MESSAGE),
      toolResults: toolResults(model.requests),
      stderrMentions: stderr.includes(MESSAGE),
      stderrLines: stderr.split(/\r?\n/).filter((l) => l.includes(MESSAGE)).map((l) => l.slice(0, 300)).slice(0, 4),
      stdoutMentions: stdout.includes(MESSAGE),
      stdoutLines: stdout.split(/\r?\n/).filter((l) => l.includes(MESSAGE)).map((l) => l.slice(0, 300)).slice(0, 4),
      stdoutEventTypes: [...new Set(stdout.split(/\r?\n/).flatMap((l) => { try { return [JSON.parse(l).type]; } catch { return []; } }))],
      logFiles: state.filter((f) => f.endsWith(".log")).map((f) => relative(root, f)),
      stateFilesMentioning: logs,
      modelErrors: model.errors,
    });
    if (process.env.HKN_RAW_DIR) {
      const raw = join(process.env.HKN_RAW_DIR, version, name.replace(/[:]/g, "_"));
      await mkdir(raw, { recursive: true });
      await writeFile(join(raw, "stdout.txt"), stdout);
      await writeFile(join(raw, "stderr.txt"), stderr);
      await writeFile(join(raw, "trace.jsonl"), await readFile(trace, "utf8").catch(() => ""));
      await writeFile(join(raw, "requests.json"), JSON.stringify(model.requests, null, 2));
      await writeFile(join(raw, "record.json"), JSON.stringify(record, null, 2));
      for (const f of record.logFiles) await copyFile(join(root, f), join(raw, f.replace(/[\\/]/g, "_")));
    }
  } finally {
    await model.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  }
  console.log(JSON.stringify(record));
}
