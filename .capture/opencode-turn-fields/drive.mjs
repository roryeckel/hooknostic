#!/usr/bin/env node
// Turn-field capture for OpenCode 1.x with no model spend: the real harness
// runs against the loopback playback model, which makes one shell call and
// then answers with a marker text. See README.md for the question and record.
//
//   node --experimental-strip-types .capture/opencode-turn-fields/drive.mjs
//
// Every state directory is redirected into a fresh OS-temp root, printed on
// stdout, so an OpenCode 2 install beside this one cannot share its state.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
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

const version = (await runProcess("opencode", ["--version"], { cwd: REPO, env: process.env })).stdout.trim();
const root = mkdtempSync(join(realpathSync(tmpdir()), "hkn-turn-fields-"));
const scratch = join(root, "project");
mkdirSync(join(scratch, ".opencode", "plugins"), { recursive: true });
copyFileSync(
  new URL(".opencode/plugins/probe.js", import.meta.url),
  join(scratch, ".opencode", "plugins", "probe.js"),
);
console.log(JSON.stringify({ root, version }));
await prepareOpenCodePluginDependency(scratch, version);

const server = await startModelPlayback("openai-chat", "rewrite", [
  { kind: "tool", disposition: "rewrite" },
  { kind: "text", text: "hooknostic-final-answer" },
]);
try {
  writeOpencodeConfig(scratch, server.baseUrl, "hooknostic-playback", "hooknostic-playback");
  await runProcess("git", ["init"], { cwd: scratch, env: process.env, timeoutMs: 30_000 });
  const result = await runProcess(
    "opencode",
    ["run", "Use the shell once, then answer.", "--model", "drift/hooknostic-playback"],
    {
      cwd: scratch,
      timeoutMs: 120_000,
      env: {
        ...withoutCredentials(),
        HOME: root,
        USERPROFILE: root,
        PWD: scratch,
        HKN_CAPTURE_DIR: join(root, "captured"),
        XDG_CONFIG_HOME: openCodePlaybackConfigHome(scratch),
        XDG_DATA_HOME: join(root, "data"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_STATE_HOME: join(root, "state"),
      },
    },
  );
  const messages = readFileSync(join(root, "captured", "messages.jsonl"), "utf8").trim().split("\n");
  console.log(
    JSON.stringify({ code: result.code, requests: server.requests.length, errors: server.errors, idles: messages.length }),
  );
} finally {
  await server.close();
}
