#!/usr/bin/env node
// Drift-lane session driver (issue #1 plan §6): drive one real harness session
// with the committed tee-capture templates attached, then structurally compare
// the captured native payloads against committed fixtures via
// scripts/compare-capture-shapes.mjs.
//
//   node --experimental-strip-types scripts/drive-capture-session.mjs \
//     <claude|codex|opencode> [--transport playback|llm] [--scratch <dir>]
//
// Exit codes (propagated from the comparator):
//   0 clean            4 drift            5 inconclusive
//   2 usage/unknown harness               6 drive failure (harness crash,
//                                            empty capture, sidecar probe fail)
// The workflow treats 4 and 5 as reportable outcomes, never job failures.
// ADVISORY ONLY: this script never writes fixtures and never upgrades
// provenance — "clean" is a confidence note; drift routes humans to the
// harness-capture skill.
//
// Transports (review round 5):
// - playback (default, free): the loopback model server from
//   packages/cli/test/harness-playback.ts drives the model side. The harness
//   is real and its hook payloads are real native output; no secrets.
// - llm (paid, explicit dispatch only): same session shape, model side is the
//   owner's OpenAI-compatible endpoint; claude and codex reach it through a
//   LiteLLM sidecar (/v1/messages and /v1/responses), opencode directly.
//   What only this adds: real model tool-call emission patterns through the
//   real provider path. Probe failure → exit 5, never a false verdict.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { flattenCaptured, isEntrypoint, listCaptured } from "./drive-capture-session-utils.mjs";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));

// ---------------------------------------------------------------------------
// Workspace loader hooks: import unbuilt TS + shadow vitest so the driver can
// reuse startModelPlayback from packages/cli/test/harness-playback.ts without
// vitest (the hook lives in ts-resolve-hook.mjs, the stub in vitest-stub.mjs).
// ---------------------------------------------------------------------------

const hookUrl = new URL("ts-resolve-hook.mjs", import.meta.url).href;
register(hookUrl);

const {
  openCodePlaybackConfigHome,
  prepareOpenCodePluginDependency,
  startModelPlayback,
  runProcess,
  writePiProviderExtension,
} = await import(pathToFileURL(join(REPO, "packages/cli/test/harness-playback.ts")).href);

const DRIVE_PROMPT = "Use the shell tool exactly once to print the word drift-probe, then stop.";
const DRIVE_TIMEOUT_MS = 120_000;

/** Credential-scrubbed environment: the drive must never see model tokens. */
function withoutCredentials() {
  const env = { ...process.env };
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AZURE_OPENAI_API_KEY",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_VERTEX",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "HARNESS_LLM_API_KEY",
  ]) {
    delete env[name];
  }
  return env;
}

function tomlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

// Tee template source per harness, mirroring .capture/ layout (plan §5).
const TEE_TEMPLATE_DIRS = {
  claude: ".capture/claude",
  codex: ".capture/codex-capture",
  opencode: ".capture/opencode-capture",
};

// Fixture dir per harness relative to fixtures/<harness>/ — mirrors
// compare-capture-shapes.mjs's FIXTURE_DIRS (which prefix fixtures/<harness>/).
const FIXTURE_DIRS = {
  pi: "0.84",
  claude: "2.1",
  codex: "0.148",
  opencode: "1.18",
};

function prepareScratch(repo, harness, scratchOverride) {
  const scratch = resolve(scratchOverride ?? join(mkdtempSync(join(tmpdir(), "hkn-drift-")), harness));
  if (harness === "pi") {
    // Copy only the passive tee, never ignored captures or user settings.
    mkdirSync(scratch, { recursive: true });
    cpSync(join(repo, ".capture/pi/hooknostic-capture.ts"), join(scratch, "hooknostic-capture.ts"));
    rmSync(join(scratch, "captured"), { recursive: true, force: true });
    mkdirSync(join(scratch, "captured"), { recursive: true });
    return scratch;
  }
  const template = join(repo, TEE_TEMPLATE_DIRS[harness]);
  cpSync(template, scratch, { recursive: true });
  rmSync(join(scratch, "captured"), { recursive: true, force: true });
  mkdirSync(join(scratch, "captured"), { recursive: true });
  if (harness === "codex") {
    // Instantiate the hooks template with the scratch path (the
    // ${CAPTURE_DIR} placeholder pattern; codex hook commands carry no
    // project-dir variable, so the absolute path must be baked in here).
    const tpl = readFileSync(join(scratch, ".codex", "hooks.json.template"), "utf8");
    writeFileSync(
      join(scratch, ".codex", "hooks.json"),
      tpl.replaceAll("${CAPTURE_DIR}", scratch.replaceAll("\\", "/")),
      "utf8",
    );
  }
  if (harness === "opencode") {
    // OpenCode auto-loads plugins from .opencode/plugins/ only — the template
    // root copy is documentation; the loadable copy goes where the harness
    // looks (smoke-proven layout from the step-6 template README). The plugin
    // tees relative to its own directory (HKN_CAPTURE_DIR unset), so point the
    // comparator at the load location's captured/ dir.
    mkdirSync(join(scratch, ".opencode", "plugins"), { recursive: true });
    cpSync(join(scratch, "hooknostic-capture.js"), join(scratch, ".opencode", "plugins", "hooknostic-capture.js"));
  }
  return scratch;
}

// ---------------------------------------------------------------------------
// Transport: playback (free). Loopback model server per protocol.
// ---------------------------------------------------------------------------

const PLAYBACK_PROTOCOLS = {
  pi: "openai-chat",
  claude: "anthropic-messages",
  codex: "openai-responses",
  opencode: "openai-chat",
};

// ---------------------------------------------------------------------------
// Transport: llm (paid). claude/codex via a LiteLLM sidecar, opencode direct.
// ---------------------------------------------------------------------------

/**
 * The driver does not start the sidecar: the workflow owns it (pinned version,
 * container/service step). The driver receives
 * HARNESS_LLM_MODEL, HARNESS_LLM_PROXY_URL (the local LiteLLM sidecar), and
 * HARNESS_LLM_PROXY_KEY (a disposable local proxy credential). The upstream
 * API key stays in LiteLLM and is never inherited by a harness process.
 * Probe-before-drive: a failing endpoint exits 5 (inconclusive), never a
 * fabricated verdict.
 */
function llmConfig() {
  const model = process.env["HARNESS_LLM_MODEL"];
  const proxyUrl = process.env["HARNESS_LLM_PROXY_URL"]?.replace(/\/$/, "");
  if (model === undefined || proxyUrl === undefined) {
    throw new Error("llm transport requires HARNESS_LLM_MODEL and HARNESS_LLM_PROXY_URL");
  }
  return {
    model,
    proxyUrl,
    proxyKey: process.env["HARNESS_LLM_PROXY_KEY"] ?? "hooknostic-drift",
  };
}

async function probeEndpoint(url, headers, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`endpoint ${url} responded ${response.status}: ${text.slice(0, 200)}`);
  }
  await response.text();
}

/** Per-harness probe of the model path this transport will actually use. */
async function probeLlmPath(harness, config) {
  if (harness === "claude") {
    // LiteLLM /v1/messages: Anthropic Messages → upstream chat completions.
    await probeEndpoint(
      `${config.proxyUrl}/v1/messages`,
      {
        "x-api-key": config.proxyKey,
        "anthropic-version": "2023-06-01",
      },
      {
        model: config.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      },
    );
    return;
  }
  if (harness === "codex") {
    // LiteLLM /v1/responses: Responses API → upstream chat completions.
    await probeEndpoint(
      `${config.proxyUrl}/v1/responses`,
      {
        authorization: `Bearer ${config.proxyKey}`,
      },
      { model: config.model, input: "ping", max_output_tokens: 16 },
    );
    return;
  }
  // opencode: OpenAI-compatible chat completions directly.
  await probeEndpoint(
    `${config.proxyUrl}/v1/chat/completions`,
    {
      authorization: `Bearer ${config.proxyKey}`,
    },
    {
      model: config.model,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 16,
    },
  );
}

// ---------------------------------------------------------------------------
// Per-harness drives. Wiring mirrors packages/cli/test/harness-playback.test.ts
// (the capture-skill traps: codex trust + responses wire, opencode PWD).
// ---------------------------------------------------------------------------

async function driveClaude(scratch, model) {
  return runProcess(
    "claude",
    [
      "-p",
      DRIVE_PROMPT,
      "--model",
      "hooknostic-drift",
      "--settings",
      join(scratch, ".claude", "settings.json"),
      "--dangerously-skip-permissions",
      "--max-turns",
      "6",
    ],
    {
      cwd: scratch,
      timeoutMs: DRIVE_TIMEOUT_MS,
      env: {
        ...withoutCredentials(),
        // Claude always needs a nonempty proxy-facing key (playback parity:
        // harness-playback.test.ts:84). This is only the disposable local
        // LiteLLM credential, never the upstream API key.
        ANTHROPIC_API_KEY: model.key ?? "hooknostic-drift",
        ANTHROPIC_BASE_URL: model.url,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
        DISABLE_AUTOUPDATER: "1",
        DISABLE_TELEMETRY: "1",
      },
    },
  );
}

async function drivePi(scratch, baseUrl) {
  const provider = await writePiProviderExtension(scratch, baseUrl);
  return runProcess(
    "pi",
    [
      "--provider",
      "hooknostic-playback",
      "--model",
      "hooknostic-playback",
      "-e",
      provider,
      "-e",
      join(scratch, "hooknostic-capture.ts"),
      "--approve",
      "--no-session",
      "-p",
      DRIVE_PROMPT,
    ],
    {
      cwd: scratch,
      timeoutMs: DRIVE_TIMEOUT_MS,
      env: {
        ...withoutCredentials(),
        PI_CODING_AGENT_DIR: join(scratch, "pi-home"),
        HKN_CAPTURE_DIR: join(scratch, "captured"),
        HKN_PI_PROBE: "tee",
      },
    },
  );
}

async function driveCodex(scratch, model) {
  const q = tomlLiteral;
  // Codex refuses to run outside a git repo ("Not inside a trusted directory")
  // — git init in the scratch dir is a capture-skill trap, same as the
  // playback lane (harness-playback.test.ts:296).
  await runProcess("git", ["init"], { cwd: scratch, env: process.env, timeoutMs: 30_000 });
  return runProcess(
    "codex",
    [
      "exec",
      "-",
      "--dangerously-bypass-hook-trust",
      "--color",
      "never",
      "-c",
      `model="${model.name}"`,
      "-c",
      'model_provider="hooknostic_drift"',
      "-c",
      'approval_policy="never"',
      "-c",
      'sandbox_mode="danger-full-access"',
      "-c",
      'model_providers.hooknostic_drift.name="Hooknostic Drift"',
      "-c",
      `model_providers.hooknostic_drift.base_url=${q(model.baseUrl)}`,
      "-c",
      'model_providers.hooknostic_drift.wire_api="responses"',
      // env_key names the env var carrying the disposable local proxy
      // credential; an empty env_key with requires_openai_auth=false is how the
      // loopback lane runs.
      ...(model.key !== undefined
        ? ["-c", 'model_providers.hooknostic_drift.env_key="HARNESS_LLM_PROXY_KEY"']
        : ["-c", "model_providers.hooknostic_drift.requires_openai_auth=false"]),
      "-c",
      "model_providers.hooknostic_drift.request_max_retries=0",
      "-c",
      "model_providers.hooknostic_drift.stream_max_retries=0",
      "-c",
      `projects={${q(scratch)}={trust_level=${q("trusted")}}}`,
    ],
    {
      cwd: scratch,
      input: DRIVE_PROMPT,
      timeoutMs: DRIVE_TIMEOUT_MS,
      env: {
        ...withoutCredentials(),
        ...(model.key !== undefined ? { HARNESS_LLM_PROXY_KEY: model.key } : {}),
      },
    },
  );
}

async function driveOpencode(scratch, modelLabel) {
  // The PWD-precedence trap: OpenCode trusts inherited PWD over the spawn cwd,
  // so plugins/config resolve against the scratch dir only if PWD says so.
  await runProcess("git", ["init"], { cwd: scratch, env: process.env, timeoutMs: 30_000 });
  return runProcess(
    "opencode",
    ["run", DRIVE_PROMPT, "--model", `drift/${modelLabel}`, "--print-logs", "--log-level", "DEBUG"],
    {
      cwd: scratch,
      timeoutMs: DRIVE_TIMEOUT_MS,
      env: {
        ...withoutCredentials(),
        PWD: scratch,
        XDG_CONFIG_HOME: openCodePlaybackConfigHome(scratch),
      },
    },
  );
}

function writeOpencodeConfig(scratch, baseUrl, apiKey, modelLabel) {
  writeFileSync(
    join(scratch, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        model: `drift/${modelLabel}`,
        enabled_providers: ["drift"],
        provider: {
          drift: {
            npm: "@ai-sdk/openai-compatible",
            name: "Hooknostic Drift",
            options: { baseURL: `${baseUrl}/v1`, apiKey },
            models: {
              [modelLabel]: {
                name: modelLabel,
                limit: { context: 32768, output: 4096 },
              },
            },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { harness: undefined, transport: "playback", scratch: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--transport") {
      opts.transport = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--scratch") {
      opts.scratch = argv[i + 1];
      i += 1;
    } else {
      opts.harness = argv[i];
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.harness === "opencode-v1") opts.harness = "opencode";
  if (opts.harness === "opencode-v2") {
    if (opts.transport !== "playback") {
      console.error("v2 paid drift capture is not established; use the offline playback transport");
      process.exit(5);
    }
    const scratch = opts.scratch ?? mkdtempSync(join(tmpdir(), "hkn-drift-v2-"));
    mkdirSync(scratch, { recursive: true });
    const result = await runProcess(
      process.execPath,
      ["--experimental-strip-types", join(REPO, ".capture/opencode-v2/drive.mjs"), "observe"],
      {
        cwd: REPO,
        env: { ...withoutCredentials(), HKN_CAPTURE_ROOT: scratch },
        timeoutMs: DRIVE_TIMEOUT_MS,
      },
    );
    console.log(result.stdout + result.stderr);
    const path = join(scratch, "captured/events.jsonl");
    if (result.code !== 0) process.exit(6);
    const captured = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const { compareCaptures, EXPECTED_VARIANTS, readJsonDir } = await import("./compare-capture-shapes.mjs");
    const comparison = compareCaptures({
      harness: "opencode-v2",
      captured,
      fixtures: readJsonDir(join(REPO, "fixtures/opencode/2.0"), { suffix: ".input.json" }),
      expectedVariants: EXPECTED_VARIANTS["opencode-v2"],
    });
    console.log(comparison.report);
    process.exit(comparison.verdict === "clean" ? 0 : comparison.verdict === "drift" ? 4 : 5);
  }
  if (opts.harness === undefined || !["claude", "codex", "opencode", "pi"].includes(opts.harness)) {
    process.stderr.write(
      `usage: node --experimental-strip-types ${process.argv[1]} <claude|codex|opencode|pi> [--transport playback|llm] [--scratch <dir>]\n`,
    );
    process.exit(2);
  }
  if (opts.transport !== "playback" && opts.transport !== "llm") {
    process.stderr.write(`unknown transport: ${opts.transport}\n`);
    process.exit(2);
  }
  if (opts.harness === "pi" && opts.transport === "llm") {
    console.error("Pi paid drift capture is not established; use --transport playback (inconclusive)");
    process.exit(5);
  }

  const scratch = prepareScratch(REPO, opts.harness, opts.scratch);
  console.log(`[drift] harness=${opts.harness} transport=${opts.transport} scratch=${scratch}`);
  if (opts.harness === "opencode") {
    const harnessVersion = process.env.HOOKNOSTIC_PLAYBACK_VERSION;
    if (harnessVersion === undefined || harnessVersion === "") {
      console.error("[drift] HOOKNOSTIC_PLAYBACK_VERSION is required for OpenCode");
      process.exit(6);
    }
    try {
      await prepareOpenCodePluginDependency(scratch, harnessVersion);
      console.log(`[drift] prepared @opencode-ai/plugin@${harnessVersion} in the scratch project`);
    } catch (error) {
      console.error(`[drift] OpenCode project dependency bootstrap failed: ${String(error)}`);
      process.exit(6);
    }
  }

  let modelSide;
  if (opts.transport === "playback") {
    modelSide = { kind: "playback" };
  } else {
    const config = llmConfig();
    try {
      await probeLlmPath(opts.harness, config);
    } catch (error) {
      console.error(`[drift] LLM endpoint probe failed: ${error.message}`);
      process.exit(5);
    }
    modelSide = { kind: "llm", config };
  }

  // Per-harness model wiring happens inside the drive functions; start the
  // loopback server for the playback transport first.
  let server;
  if (opts.transport === "playback") {
    server = await startModelPlayback(PLAYBACK_PROTOCOLS[opts.harness], "rewrite");
    console.log(`[drift] loopback model at ${server.baseUrl}`);
  }

  let result;
  try {
    if (opts.harness === "pi") {
      result = await drivePi(scratch, server.baseUrl);
    } else if (opts.harness === "claude") {
      const url =
        opts.transport === "playback"
          ? { url: server.baseUrl }
          : {
              url: modelSide.config.proxyUrl,
              key: modelSide.config.proxyKey,
            };
      result = await driveClaude(scratch, url);
    } else if (opts.harness === "codex") {
      const wired =
        opts.transport === "playback"
          ? { baseUrl: `${server.baseUrl}/v1`, name: "hooknostic-playback", key: undefined }
          : {
              baseUrl: `${modelSide.config.proxyUrl}/v1`,
              name: modelSide.config.model,
              key: modelSide.config.proxyKey,
            };
      result = await driveCodex(scratch, wired);
    } else {
      const base = opts.transport === "playback" ? server.baseUrl : modelSide.config.proxyUrl;
      const key = opts.transport === "playback" ? "hooknostic-playback" : modelSide.config.proxyKey;
      const modelLabel = opts.transport === "playback" ? "hooknostic-playback" : modelSide.config.model;
      writeOpencodeConfig(scratch, base, key, modelLabel);
      result = await driveOpencode(scratch, modelLabel);
    }
  } catch (error) {
    console.error(`[drift] harness drive failed: ${error.message}`);
    process.exitCode = 6;
    return;
  } finally {
    if (server !== undefined) await server.close();
  }

  console.log(`[drift] harness exit ${result.code}`);
  if ((result.stdout + result.stderr).trim() !== "") {
    const tail = (result.stdout + result.stderr).slice(-1200);
    console.log(`[drift] harness output tail:\n${tail}`);
  }
  if (result.code !== 0) {
    console.error("[drift] harness did not complete successfully");
    process.exit(6);
  }

  // The capture sink differs per tee: claude/codex hook commands write to
  // <scratch>/captured (import.meta.dirname-relative), the opencode plugin
  // tees next to its load location (.opencode/plugins/captured).
  const capturedDir =
    opts.harness === "opencode" ? join(scratch, ".opencode", "plugins", "captured") : join(scratch, "captured");
  const files = listCaptured(capturedDir);
  console.log(`[drift] captured files: ${files.join(", ") || "(NONE)"}`);
  if (files.length === 0) {
    console.error("[drift] no capture produced — the tee did not fire");
    process.exit(6);
  }
  const { dst, count } = flattenCaptured(capturedDir, opts.harness);
  console.log(`[drift] flattened ${count} payloads`);

  // Import the comparator as a module instead of spawning it: on Windows the
  // playback runProcess wraps spawns in shell:true, which mangles an unquoted
  // process.execPath containing spaces ("C:\Program Files\..."). Importing
  // keeps one exit contract — main() exits with the comparator's verdict code.
  const { compareCaptures, EXPECTED_VARIANTS, readJsonDir } = await import(
    new URL("compare-capture-shapes.mjs", import.meta.url).href
  );
  const captured = readJsonDir(dst);
  const fixtures = readJsonDir(join(REPO, "fixtures", opts.harness, FIXTURE_DIRS[opts.harness]), {
    suffix: ".input.json",
  });
  const { verdict, report } = compareCaptures({
    harness: opts.harness,
    captured,
    fixtures,
    expectedVariants: EXPECTED_VARIANTS[opts.harness] ?? [],
  });
  process.stdout.write(`${report}\n`);
  process.exit(verdict === "clean" ? 0 : verdict === "drift" ? 4 : 5);
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  await main();
}
