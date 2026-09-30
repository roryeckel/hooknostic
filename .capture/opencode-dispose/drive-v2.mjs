#!/usr/bin/env node
// Dispose capture for OpenCode 2.x with no model spend: `run --standalone`
// against the loopback playback model, with v2-probe.js loaded from the
// scratch project. See README.md.
//
//   node --experimental-strip-types .capture/opencode-dispose/drive-v2.mjs [standalone|service]
//
// `standalone` (the default) runs with a private server; `service` uses the
// background service of the isolated state, which is stopped afterwards.
//
// Every state directory is redirected into a fresh OS-temp root, printed on
// stdout. Set HKN_OPENCODE_BINARY to the native executable; on Windows the
// default is the side-by-side install under %LOCALAPPDATA%\opencode2.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url).href);
const { startModelPlayback } = await import("../../packages/cli/test/harness-playback.ts");

const executable =
  process.env.HKN_OPENCODE_BINARY ??
  (process.platform === "win32"
    ? join(process.env.LOCALAPPDATA, "opencode2", "node_modules", "@opencode", "cli", "bin", "opencode.exe")
    : "opencode2");
const mode = process.argv[2] ?? "standalone";
const root = mkdtempSync(join(realpathSync(tmpdir()), `hkn-dispose-v2-${mode}-`));
const project = join(root, "project");
mkdirSync(join(project, ".opencode", "plugins"), { recursive: true });
copyFileSync(new URL("v2-probe.js", import.meta.url), join(project, ".opencode", "plugins", "probe.js"));
const model = await startModelPlayback("openai-chat", "rewrite", [{ kind: "text", text: "hooknostic-final-answer" }]);
writeFileSync(
  join(project, "opencode.json"),
  JSON.stringify({
    model: "playback/hooknostic-playback",
    providers: {
      playback: {
        name: "Playback",
        env: ["HKN_PLAYBACK_KEY"],
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `${model.baseUrl}/v1` },
        models: { "hooknostic-playback": { name: "Playback", limit: { context: 128000, output: 4096 } } },
      },
    },
  }),
);
const env = {
  ...process.env,
  HOME: root,
  USERPROFILE: root,
  PWD: project,
  HKN_CAPTURE_DIR: join(root, "captured"),
  HKN_TASK_DELAY_MS: "3000",
  HKN_PLAYBACK_KEY: "local-playback",
  XDG_DATA_HOME: join(root, "data"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_STATE_HOME: join(root, "state"),
};
for (const name of Object.keys(env)) {
  if (/API_KEY|AUTH_TOKEN|SECRET|TOKEN|OPENCODE/.test(name) && name !== "HKN_PLAYBACK_KEY") delete env[name];
}
const capture = (args) =>
  new Promise((resolve) => {
    const child = spawn(executable, args, { cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("exit", () => resolve(out.trim()));
  });
const version = await capture(["--version"]);
console.log(JSON.stringify({ root, version, mode, service: await capture(["service", "status"]) }));
try {
  if (mode === "service") {
    // The managed service has one fixed port per state directory, and the
    // user's own service may hold the default, so the isolated one gets its own.
    const port = await new Promise((resolve) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const { port: free } = probe.address();
        probe.close(() => resolve(free));
      });
    });
    console.log(JSON.stringify({ port, set: await capture(["service", "set", "port", String(port)]) }));
    console.log(JSON.stringify({ serviceStart: await capture(["service", "start"]) }));
  }
  const started = Date.now();
  const args = ["run", ...(mode === "standalone" ? ["--standalone"] : []), "--auto", "--format", "json", "Answer in one line."];
  const child = spawn(executable, args, {
    cwd: project,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stdout.resume();
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill(), 60_000);
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  clearTimeout(timer);
  const closed = Date.now();
  // Give a detached child, if the host leaves one, the task's delay to finish.
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const file = join(root, "captured", "timeline.jsonl");
  const timeline = existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  const done = timeline.find((entry) => entry.mark === "execution.succeeded")?.t;
  const since = (t) => (done === undefined ? undefined : t - done);
  console.log(
    JSON.stringify({
      code,
      runPid: child.pid,
      stderr: stderr.slice(-800),
      requests: model.requests.length,
      errors: model.errors,
      marks: timeline.map((entry) => ({ ...entry, t: since(entry.t) })),
      succeededToExit: since(closed),
      runMs: closed - started,
    }),
  );
} finally {
  if (mode === "service") console.log(JSON.stringify({ serviceStop: await capture(["service", "stop"]) }));
  await model.close();
}
