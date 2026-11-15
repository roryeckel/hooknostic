#!/usr/bin/env node
// Where does an OpenCode 2.x plugin's console.error go under `opencode run`?
// No model spend: the installed harness runs against the loopback playback
// model with the generated v2 shim of the playback plugin, whose tool.before
// handler throws (HOOKNOSTIC_PLAYBACK_EFFECTS=handler-error). See README.md.
//
//   node --experimental-strip-types .capture/opencode-v2-plugin-stderr/drive.mjs [mode...]
//
// Modes (default: all three):
//   standalone             run --standalone
//   standalone-print-logs  run --standalone --print-logs
//   standalone-debug       run --standalone --log-level debug (no --print-logs)
//
// Every state directory is redirected into a fresh OS-temp root per mode, and
// credential-shaped variables are removed. HKN_OPENCODE_BINARY selects the
// binary; the default is `opencode` on PATH. Prints one JSON line per mode.
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url).href);
const { buildPlaybackArtifact, PLAYBACK_HANDLER_ERROR, PLAYBACK_HANDLER_ERROR_LINE, runProcess, startModelPlayback } =
  await import("../../packages/cli/test/harness-playback.ts");
const { opencodeAdapter } = await import("../../packages/adapter-opencode/src/index.ts");
const { resolveTargetAdapter } = await import("../../packages/core/src/index.ts");

const MODES = {
  standalone: ["--standalone"],
  "standalone-print-logs": ["--standalone", "--print-logs"],
  "standalone-debug": ["--standalone", "--log-level", "debug"],
};
const binary = process.env.HKN_OPENCODE_BINARY ?? "opencode";
const modes = process.argv.slice(2).length > 0 ? process.argv.slice(2) : Object.keys(MODES);

async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

for (const mode of modes) {
  const flags = MODES[mode];
  if (flags === undefined) throw new Error(`unknown mode ${mode}`);
  const root = await mkdtemp(join(await realpath(tmpdir()), `hkn-v2-stderr-${mode}-`));
  const project = join(root, "project");
  await mkdir(project);
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
    HOOKNOSTIC_PLAYBACK_EFFECTS: "handler-error",
  };
  for (const key of Object.keys(env)) if (/API_KEY|AUTH_TOKEN|SECRET|TOKEN|^OPENCODE/.test(key)) delete env[key];
  const version = (await runProcess(binary, ["--version"], { cwd: root, env })).stdout.trim().replace(/^opencode v/, "");
  const adapter = resolveTargetAdapter(opencodeAdapter(), { id: "opencode", version, delivery: "project", output: "." })
    .adapter;
  const artifact = await buildPlaybackArtifact(adapter, project);
  env.HOOKNOSTIC_PLAYBACK_TRACE = artifact.tracePath;
  const model = await startModelPlayback("openai-chat", "rewrite");
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
    const args = ["run", ...flags, "--auto", "--format", "json", "Use the shell once, then stop."];
    const result = await runProcess(binary, args, { cwd: project, env, timeoutMs: 60_000 });
    // Every file the run left outside the project: the project holds the
    // plugin source and bundle, which contain the message as a literal, and
    // so does Bun's transpiler cache of that bundle, reported apart.
    const state = (await files(root)).filter((file) => !file.startsWith(project));
    const carrying = [];
    for (const file of state) if ((await readFile(file, "utf8")).includes(PLAYBACK_HANDLER_ERROR)) carrying.push(file);
    const cache = join(root, "cache");
    const trace = await readFile(artifact.tracePath, "utf8").catch(() => "");
    console.log(
      JSON.stringify({
        mode,
        version,
        platform: process.platform,
        args,
        code: result.code,
        toolBeforeDispatched: trace.includes('"event":"tool.before"'),
        failedOpen: (await readFile(join(project, "hooknostic-tool.txt"), "utf8").catch(() => "")).includes(
          "hooknostic-original",
        ),
        stderrLine: result.stderr.match(PLAYBACK_HANDLER_ERROR_LINE)?.[0] ?? null,
        stderrMentions: result.stderr.includes(PLAYBACK_HANDLER_ERROR),
        stdoutMentions: result.stdout.includes(PLAYBACK_HANDLER_ERROR),
        logFiles: state.filter((file) => file.endsWith(".log")).map((file) => relative(root, file)),
        stateFilesMentioning: carrying.filter((file) => !file.startsWith(cache)).map((file) => relative(root, file)),
        cacheFilesMentioning: carrying.filter((file) => file.startsWith(cache)).map((file) => relative(root, file)),
        modelErrors: model.errors,
      }),
    );
  } finally {
    await model.close();
  }
}
