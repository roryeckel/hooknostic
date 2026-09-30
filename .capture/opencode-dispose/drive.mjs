#!/usr/bin/env node
// Dispose capture for OpenCode 1.x with no model spend: the real harness runs
// against the loopback playback model, which answers one line of text. The
// probe plugin starts an idle-time task and returns (or withholds) dispose;
// see README.md for the question and record.
//
//   node --experimental-strip-types .capture/opencode-dispose/drive.mjs [await|none|hang|shim|shim-nodispose ...]
//
// `shim` compiles hooks.ts with the real OpenCode 1.x shim from this checkout
// (run `pnpm run bundle` first); `shim-nodispose` removes the `dispose` it
// returns, which is the shim as it was before.
//
// Every state directory is redirected into a fresh OS-temp root per mode,
// printed on stdout, so an OpenCode 2 install beside this one cannot share its
// state and one mode's records cannot leak into the next.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(fileURLToPath(new URL("../..", import.meta.url)));
register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url).href);
const { prepareOpenCodePluginDependency, runProcess, startModelPlayback, openCodePlaybackConfigHome } = await import(
  pathToFileURL(join(REPO, "packages/cli/test/harness-playback.ts")).href
);
const { withoutCredentials, writeOpencodeConfig } = await import(
  pathToFileURL(join(REPO, "scripts/drive-capture-session.mjs")).href
);

const { bundleRuntime } = await import(pathToFileURL(join(REPO, "packages/core/src/index.ts")).href);
const { opencodeV1Adapter } = await import(pathToFileURL(join(REPO, "packages/adapter-opencode/src/index.ts")).href);

/** The shim's module, compiled the way a build does, into the project's plugins. */
async function writeShim(scratch, mode) {
  const adapter = opencodeV1Adapter();
  const target = { id: "opencode", version: adapter.harness.referenceVersion, delivery: "project", output: "." };
  const capabilities = Object.fromEntries(
    Object.entries(adapter.capabilities(target).matrix ?? {}).map(([id, entry]) => [id, entry.level]),
  );
  const entry = join(scratch, "hooks.ts");
  copyFileSync(new URL("hooks.ts", import.meta.url), entry);
  let source = adapter.shimEntry({
    entryImportPath: entry.replaceAll("\\", "/"),
    capabilities,
    minimumCapabilityLevel: "approximate",
    policy: { onHookError: "continue", timeoutMs: 5_000 },
    harnessVersion: adapter.harness.referenceVersion,
  });
  if (mode === "shim-nodispose") {
    source = source.replace(
      "export const HooknosticPlugin = async (input) =>",
      "export const HooknosticPlugin = async (input) => withoutDispose(",
    );
    source = source.replace("  }, input);", "  }, input));\nconst withoutDispose = ({ dispose, ...hooks }) => hooks;");
  }
  const bundle = await bundleRuntime({
    source,
    resolveDir: scratch,
    alias: {
      ...adapter.shimAliases(),
      "@hooknostic/sdk": createRequire(join(REPO, "packages/cli/package.json")).resolve("@hooknostic/sdk"),
    },
  });
  writeFileSync(join(scratch, ".opencode", "plugins", "hooknostic.js"), bundle.code);
}

const modes = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["await", "none", "hang"];
const version = (await runProcess("opencode", ["--version"], { cwd: REPO, env: process.env })).stdout.trim();
console.log(JSON.stringify({ version }));

for (const mode of modes) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), `hkn-dispose-${mode}-`));
  const scratch = join(root, "project");
  mkdirSync(join(scratch, ".opencode", "plugins"), { recursive: true });
  if (mode.startsWith("shim")) await writeShim(scratch, mode);
  else
    copyFileSync(
      new URL(".opencode/plugins/probe.js", import.meta.url),
      join(scratch, ".opencode", "plugins", "probe.js"),
    );
  await prepareOpenCodePluginDependency(scratch, version);
  const server = await startModelPlayback("openai-chat", "rewrite", [
    { kind: "text", text: "hooknostic-final-answer" },
  ]);
  try {
    writeOpencodeConfig(scratch, server.baseUrl, "hooknostic-playback", "hooknostic-playback");
    await runProcess("git", ["init"], { cwd: scratch, env: process.env, timeoutMs: 30_000 });
    const started = Date.now();
    const result = await runProcess(
      "opencode",
      ["run", "Answer in one line.", "--model", "drift/hooknostic-playback"],
      {
        cwd: scratch,
        timeoutMs: 120_000,
        env: {
          ...withoutCredentials(),
          HOME: root,
          USERPROFILE: root,
          PWD: scratch,
          HKN_CAPTURE_DIR: join(root, "captured"),
          HKN_DISPOSE_MODE: mode,
          HKN_TASK_DELAY_MS: "3000",
          XDG_CONFIG_HOME: openCodePlaybackConfigHome(scratch),
          XDG_DATA_HOME: join(root, "data"),
          XDG_CACHE_HOME: join(root, "cache"),
          XDG_STATE_HOME: join(root, "state"),
        },
      },
    );
    const closed = Date.now();
    const file = join(root, "captured", "timeline.jsonl");
    const timeline = existsSync(file)
      ? readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
    const at = (name) => timeline.find((entry) => entry.mark === name)?.t;
    const idle = at("session.idle") ?? at("hook.start");
    const since = (t) => (t === undefined || idle === undefined ? undefined : t - idle);
    console.log(
      JSON.stringify({
        mode,
        root,
        code: result.code,
        requests: server.requests.length,
        errors: server.errors,
        marks: timeline.map((entry) => ({ ...entry, t: since(entry.t) })),
        idleToClose: since(closed),
        runMs: closed - started,
      }),
    );
  } finally {
    await server.close();
  }
}
