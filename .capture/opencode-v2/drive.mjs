import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, copyFile, writeFile, readdir, realpath } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url));
const effect = process.argv[2] ?? "observe";
const artifactDir = process.env.HKN_PLAYBACK_ARTIFACT_DIR ?? tmpdir();
await mkdir(artifactDir, { recursive: true });
const root = process.env.HKN_CAPTURE_ROOT ?? (await mkdtemp(join(await realpath(artifactDir), "hooknostic-v2-")));
await mkdir(root, { recursive: true });
console.log(JSON.stringify({ root, effect }));
const { createPlaybackDiagnostics } = await import("../../packages/cli/test/playback-diagnostics.ts");
const diagnostics = createPlaybackDiagnostics(root, effect);
process.on("uncaughtExceptionMonitor", error => diagnostics.fail(error));
const { startModelPlayback, buildPlaybackArtifact, runProcess } = await diagnostics.run(
  "load-playback-helpers", () => import("../../packages/cli/test/harness-playback.ts"),
);
async function runCaptureProcess(phase, command, args, options) {
  return diagnostics.run(phase, async () => {
    const result = await runProcess(command, args, {
      ...options,
      onOutput: (stream, chunk) => diagnostics.output(phase, stream, chunk),
    });
    if (result.code !== 0) throw new Error(`${command} exited ${result.code}\n${result.stdout}${result.stderr}`);
    return result;
  }, { command, args, cwd: options.cwd });
}
// The native tool set can depend on the model id (a GPT-like id swaps edit/write
// for apply_patch on v1), so a capture may ask for a different one.
const modelId = process.env.HKN_MODEL_ID ?? "hooknostic-playback";
const project = join(root, "project");
diagnostics.start("prepare-project");
const remote = effect.endsWith("-oauth") ? await (await import("./oauth-mcp.mjs")).startOAuthMcp() : effect.includes("remote") ? await (await import("./remote-mcp.mjs")).startRemoteMcp() : undefined;
const remoteServers = remote ? Object.fromEntries(["http"].map(type => [type, {
  type: type === "http" ? "streamable-http" : "sse",
  url: remote.url + "/" + ((effect === "project-remote" || effect === "project-oauth") ? "${HKN_REMOTE_PATH:-http}" : type),
  headers: { "x-hooknostic": (effect === "project-remote" || effect === "project-oauth") ? "${HKN_REMOTE_HEADER:-remote-default}" : "${HKN_REMOTE_HEADER}" },
}])) : undefined;
await mkdir(join(project, ".opencode/plugins"), { recursive: true });
await copyFile(new URL("capture.js", import.meta.url), join(project, ".opencode/plugins/capture.js"));
const serverProbe = Buffer.concat([
  Buffer.from(
    'import { writeFileSync as recordStartup } from "node:fs";\nrecordStartup(new URL("./startup.json", import.meta.url), JSON.stringify({ cwd: process.cwd(), marker: process.env.HKN_MCP_ENV, root: process.env.HKN_MCP_ROOT }));\n',
  ),
  Buffer.from(
    (await readFile(new URL("../../packages/cli/test/mcp-fixture-server.mjs", import.meta.url), "utf8")).replace(
      /^#!.*\n/,
      "",
    ),
  ),
]);
let packagePath, registry;
diagnostics.complete("prepare-project");
if (effect === "notifications") {
  diagnostics.start("prepare-notification-package");
  packagePath = join(project, "notification-probe");
  await mkdir(packagePath);
  await writeFile(join(packagePath, "package.json"), JSON.stringify({ name: "hooknostic-notification-probe", type: "module", exports: { ".": "./index.js", "./tui": "./tui.js" } }));
  await copyFile(new URL("notification-server.js", import.meta.url), join(packagePath, "index.js"));
  await copyFile(new URL("notification-rpc.js", import.meta.url), join(packagePath, "rpc.js"));
  await copyFile(new URL("notification-tui.js", import.meta.url), join(packagePath, "tui.js"));
  diagnostics.complete("prepare-notification-package");
}
if (
  effect === "artifact" ||
  effect === "results" ||
  effect === "subagent" ||
  effect === "tools" ||
  effect.startsWith("mcp-") ||
  effect === "lifecycle" ||
  effect.startsWith("provider-") ||
  effect.startsWith("sessions") ||
  effect === "stop" ||
  effect === "project-components" ||
  (effect === "project-remote" || effect === "project-oauth") ||
  effect.startsWith("package")
) {
  diagnostics.start("resolve-adapter");
  const { opencodeAdapter, opencodeV2Harness } = await import("../../packages/adapter-opencode/src/index.ts");
  const { resolveTargetAdapter, resolveAgentPluginProjection } = await import("../../packages/core/src/index.ts");
  const target = {
    id: "opencode",
    version: opencodeV2Harness.referenceVersion,
    delivery: effect.startsWith("package") ? "package" : "project",
    output: ".",
    npmName: "@hooknostic-probe/v2",
  };
  const adapter = resolveTargetAdapter(opencodeAdapter(), target).adapter;
  const output = effect.startsWith("package") ? join(root, "package-source") : project;
  diagnostics.complete("resolve-adapter");
  let components;
  if (effect === "project-components" || (effect === "project-remote" || effect === "project-oauth")) {
    diagnostics.start("load-project-components");
    const { loadProjectComponents } = await import("../../packages/agent-plugin/src/index.ts");
    await mkdir(join(project, "portable/skills/greet"), { recursive: true });
    await writeFile(
      join(project, "portable/skills/greet/SKILL.md"),
      "---\nname: greet\ndescription: Generated skill probe\n---\nGreet the user.\n",
    );
    await writeFile(join(project, "portable/server.mjs"), serverProbe);
    await writeFile(
      join(project, "portable/mcp.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {
          ...(remoteServers ?? {
          greeter: {
            type: "stdio",
            command: "node",
            args: ["${PLUGIN_ROOT}/server.mjs"],
            env: { HKN_MCP_ENV: "${HKN_MISSING_PROBE_ENV:-project-marker}", HKN_MCP_ROOT: "${PLUGIN_ROOT}" },
            cwd: "${PLUGIN_ROOT}",
          },
          }),
          ...(remote ? { missing: { type: "streamable-http", url: remote.url + "/missing", headers: { "x-missing": "${HKN_MISSING_REMOTE_HEADER}" } } } : {}),
        },
      }),
    );
    const loaded = await loadProjectComponents({
      skills: [join(project, "portable/skills")],
      mcp: join(project, "portable/mcp.json"),
    });
    if (loaded.issues.length) throw new Error(JSON.stringify(loaded.issues));
    components = loaded.source;
    diagnostics.complete("load-project-components");
  }
  await diagnostics.run("build-artifact", () => buildPlaybackArtifact(adapter, output, {
    delivery: target.delivery,
    ...(components ? { project: true, components, componentOptions: { mcpStartupTimeoutMs: { greeter: 10000 } } } : {}),
  }));
  if (effect.startsWith("mcp-")) await diagnostics.run("build-mcp-guard", async () => (await import("../opencode-v2-mcp/build-guard.mjs")).buildGuard(adapter, output));
  if (effect === "results") await diagnostics.run("build-results", async () => (await import("./build-results.mjs")).buildResults(adapter, output));
  if (effect.startsWith("package") && effect !== "package-hooks") {
    diagnostics.start("load-agent-plugin");
    const { loadAgentPlugin } = await import("../../packages/agent-plugin/src/index.ts");
    const source = await loadAgentPlugin({
      root: fileURLToPath(new URL("../../examples/agent-plugin", import.meta.url)),
      exclude: [".claude-plugin/**", ".agents/plugins/**", "build/**", "runtime/**"],
    });
    diagnostics.complete("load-agent-plugin");
    diagnostics.start("project-package");
    const serverFile = source.package.files.find((file) => file.path === "src/greet-mcp.mjs");
    serverFile.contents = new Uint8Array(serverProbe);
    // The example bundles MCP at build time; this capture substitutes its own
    // dependency-free server, so redirect the declaration with the file.
    source.package.mcp.mcpServers.greeter.args = ["${PLUGIN_ROOT}/src/greet-mcp.mjs"];
    source.package.mcp.mcpServers.greeter.env = { HKN_MCP_ENV: "package-marker", HKN_MCP_ROOT: "${PLUGIN_ROOT}" };
    source.package.mcp.mcpServers.greeter.cwd = "${PLUGIN_ROOT}/src";
    if (remote) source.package.mcp.mcpServers = remoteServers;
    const hookArtifacts =
      effect === "package-components"
        ? []
        : await Promise.all(
            ["hooknostic.js", "index.js", "package.json"].map(async (path) => ({
              path,
              contents: await readFile(join(output, path), "utf8"),
            })),
          );
    const plan = await adapter.agentPluginProjector.project(source.package, {
      target,
      hookArtifacts,
      onUnsupported: "error",
      support: resolveAgentPluginProjection(target, adapter.agentPluginProjector).matrix,
    });
    for (const file of plan.files) {
      await mkdir(join(output, file.path, ".."), { recursive: true });
      await writeFile(join(output, file.path), file.contents);
    }
    diagnostics.complete("project-package");
  }
  if (effect.startsWith("package")) {
    await runCaptureProcess("pnpm-pack", "pnpm", ["pack", "--pack-destination", root], { cwd: output, env: process.env });
    const tarball = (await readdir(root)).find((name) => name.endsWith(".tgz"));
    const manifest = JSON.parse(await readFile(join(output, "package.json"), "utf8"));
    if (effect === "package-registry") {
      registry = await (await import("./registry.mjs")).startRegistry(manifest, await readFile(join(root, tarball)));
      packagePath = `${manifest.name}@${manifest.version}`;
    } else {
      const installed = join(root, "relocated");
      await mkdir(installed);
      await writeFile(join(installed, "package.json"), JSON.stringify({ private: true }));
      await runCaptureProcess(
        "npm-install",
        "npm",
        ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", join(root, tarball)],
        { cwd: installed, env: process.env },
      );
      packagePath = join(installed, "node_modules", manifest.name);
    }
  }
}
diagnostics.start("prepare-native-config");
// The patch probe updates a file that must already exist.
if (effect === "tools-patch") await writeFile(join(project, "probe.txt"), "hooknostic-before-edit\n");
if (effect === "components" || effect === "tools" || effect.startsWith("mcp-")) {
  await mkdir(join(project, "working directory"), { recursive: true });
  for (const dir of [".agents/skills/native", "injected"]) {
    await mkdir(join(project, dir), { recursive: true });
    await writeFile(
      join(project, dir, "SKILL.md"),
      "---\nname: hooknostic-native\ndescription: Native probe\n---\nProbe content.\n",
    );
  }
  await copyFile(
    new URL("../../packages/cli/test/mcp-fixture-server.mjs", import.meta.url),
    join(project, "server.mjs"),
  );
  if (effect.startsWith("mcp-")) {
    const server = await readFile(join(project, "server.mjs"), "utf8");
    await writeFile(join(project, "server.mjs"), server
      .replace('import { createInterface }', 'import { appendFileSync } from "node:fs";\nimport { createInterface }')
      .replace('case "tools/call":', 'case "tools/call":\n      appendFileSync(process.env.HKN_MCP_CALLS, JSON.stringify(request) + "\\n");'));
  }
}
const model = effect.startsWith("sessions") || effect === "stop" || effect === "nested" ? await (await import("./session-model.mjs")).startSessionModel() : effect === "tools" || effect === "tools-patch" || effect.startsWith("mcp-") || remote || effect.startsWith("results") || effect === "subagent"
  ? await (await import("./tool-model.mjs")).startToolModel(project, effect.startsWith("mcp-"), remote ? effect : false, effect === "subagent" ? "subagent" : effect === "tools-patch" ? "patch" : effect.startsWith("results"))
  : await startModelPlayback(effect === "provider-anthropic" ? "anthropic-messages" : effect === "provider-responses" ? "openai-responses" : "openai-chat", effect === "fail" ? "fail" : "rewrite", effect === "lifecycle" || effect.startsWith("provider-") ? [
      { kind: "tool", disposition: "rewrite" },
      { kind: "text", text: "## Objective\n- Exercise offline hooks.\n## Requirements\n- Use the loopback model.\n## Decisions\n- Keep the probe isolated.\n## Work State\n### Completed\n- Ran the shell probe.\n### Active\n- None.\n### Blocked\n- None.\n## Next Move\n1. Finish the probe.\n## Relevant Files\n- hooknostic-tool.txt\n## Important Context\n- hooknostic-valid-compaction-summary" },
    ] : undefined);
await writeFile(
  join(project, "opencode.json"),
  JSON.stringify({
    ...(packagePath ? { plugins: [packagePath] } : {}),
    model: `playback/${modelId}`,
    providers: {
      playback: {
        name: "Playback",
        env: ["HKN_PLAYBACK_KEY"],
        package: effect === "provider-anthropic" ? "@opencode/ai/providers/anthropic" : effect === "provider-responses" ? "@opencode/ai/providers/openai" : "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: model.baseUrl + "/v1", ...(effect === "provider-responses" ? { transport: "http" } : {}) },
        models: { [modelId]: { name: "Playback", limit: { context: 128000, output: 4096 } } },
      },
    },
  }),
);
const env = {
  ...process.env,
  HOME: root,
  USERPROFILE: root,
  PWD: project,
  HKN_NODE_BINARY: process.execPath,
  HKN_CAPTURE_DIR: join(root, "captured"),
  HKN_PROBE_EFFECT: effect,
  HOOKNOSTIC_PLAYBACK_TRACE: join(root, "trace.jsonl"),
  HKN_PLAYBACK_KEY: "local-playback",
  HKN_MCP_CALLS: join(root, "mcp-calls.jsonl"),
  HKN_RESULTS_TRACE: join(root, "results.jsonl"),
  HKN_NOTIFICATION_TRACE: join(root, "notifications.jsonl"),
  HKN_MCP_GUARD_TRACE: join(root, "guard.jsonl"),
  HKN_MCP_GUARD: effect === "mcp-block" ? "block" : "allow",
  ...(remote ? { HKN_REMOTE_ORIGIN: remote.url, HKN_REMOTE_HEADER: "remote-expanded" } : {}),
  XDG_DATA_HOME: join(root, "data"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_STATE_HOME: join(root, "state"),
};
if (registry) {
  await writeFile(join(root, ".npmrc"), `registry=${registry.baseUrl}/\n`);
  env.npm_config_registry = registry.baseUrl + "/";
  env.NPM_CONFIG_REGISTRY = registry.baseUrl + "/";
  env.npm_config_userconfig = join(root, ".npmrc");
  env.npm_config_cache = join(root, "npm-cache");
}
for (const name of Object.keys(env)) {
  if (/API_KEY|AUTH_TOKEN|SECRET|TOKEN|OPENCODE/.test(name) && name !== "HKN_PLAYBACK_KEY") delete env[name];
}
diagnostics.complete("prepare-native-config");
// Save loopback observations while the harness runs, before an outer timeout can kill this process.
function snapshotRequests() {
  diagnostics.snapshot("model.json", { requests: model.requests, errors: model.errors });
  if (remote) diagnostics.snapshot("remote.json", remote.requests);
  if (registry) diagnostics.snapshot("registry.json", registry.requests);
}
snapshotRequests();
const snapshotTimer = setInterval(snapshotRequests, 1000);
snapshotTimer.unref();
diagnostics.start("resolve-native-binary");
let executable = process.env.HKN_OPENCODE_BINARY ?? "opencode";
if (process.platform === "win32" && !process.env.HKN_OPENCODE_BINARY) {
  const npmRoot = await runCaptureProcess("npm-root", "npm", ["root", "--global"], { cwd: project, env });
  executable = join(npmRoot.stdout.trim(), "@opencode/cli/bin/opencode.exe");
}
diagnostics.complete("resolve-native-binary");
if (effect === "nested") {
  const { opencodeAdapter, opencodeV2Harness } = await import("../../packages/adapter-opencode/src/index.ts");
  const { resolveTargetAdapter } = await import("../../packages/core/src/index.ts");
  const target = { id: "opencode", version: opencodeV2Harness.referenceVersion, delivery: "project", output: "." };
  const adapter = resolveTargetAdapter(opencodeAdapter(), target).adapter;
  const build = (dir, label) => buildPlaybackArtifact(adapter, dir, { delivery: "project", project: true, label });
  try { await diagnostics.run("native-nested", async () => (await import("./nested.mjs")).driveNested({ executable, root, project, env, build })); }
  finally { clearInterval(snapshotTimer); snapshotRequests(); await model.close(); }
  process.exit(0);
}
if (effect === "notifications") {
  try { await diagnostics.run("native-notifications", async () => (await import("./notification-drive.mjs")).driveNotifications({ executable, root, project, env })); }
  finally { clearInterval(snapshotTimer); snapshotRequests(); await model.close(); }
  if (model.requests.length) throw new Error("Notification probe made a model request");
  process.exit(0);
}
if (effect === "lifecycle" || effect.startsWith("sessions") || effect === "stop" || effect.startsWith("provider-") || effect.endsWith("-oauth")) {
  const { driveLifecycle } = await import("./lifecycle.mjs");
  try {
    await diagnostics.run("native-lifecycle", () => driveLifecycle({ executable, root, project, env, model, remote }));
  } finally {
    clearInterval(snapshotTimer);
    snapshotRequests();
    await model.close();
    if (remote) await writeFile(join(root, "remote.json"), JSON.stringify({ requests: remote.requests, errors: remote.errors }, null, 2));
    await remote?.close();
  }
  process.exit(0);
}
diagnostics.start("native-run", { command: executable, cwd: project });
const child = spawn(
  executable,
  ["run", "--standalone", "--auto", "--format", "json", "Use the shell once to create hooknostic-tool.txt, then stop."],
  {
    cwd: project,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let stdout = "",
  stderr = "";
child.stdout?.on("data", (chunk) => {
  stdout += chunk;
  diagnostics.output("native-run", "stdout", String(chunk));
});
child.stderr?.on("data", (chunk) => {
  stderr += chunk;
  diagnostics.output("native-run", "stderr", String(chunk));
});
const timeout = setTimeout(() => child.kill(), 90000);
try {
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  diagnostics.complete("native-run", { code });
  diagnostics.start("write-results");
  process.exitCode = code === 0 ? 0 : 1;
  if (effect === "project-components" || ["package", "package-components"].includes(effect)) {
    const startup = packagePath
      ? join(packagePath, "package/src/startup.json")
      : join(project, "portable/startup.json");
    await copyFile(startup, join(root, "mcp-startup.json"));
  }
  await writeFile(
    join(root, "result.json"),
    JSON.stringify({ code, stdout, stderr, requests: model.requests, errors: model.errors }, null, 2),
  );
  if (registry) await writeFile(join(root, "registry.json"), JSON.stringify(registry.requests, null, 2));
  if (remote) await writeFile(join(root, "remote.json"), JSON.stringify(remote.requests, null, 2));
  const captured = (await readFile(join(root, "captured/events.jsonl"), "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  if (registry) {
    const skill = captured.find(row => row.hook === "skills")?.event.find(skill => skill.id === "combined-example/greet");
    if (!skill) throw new Error("Registry package skill was not registered");
    await copyFile(join(skill.path, "../../../src/startup.json"), join(root, "mcp-startup.json"));
  }
  console.log(
    JSON.stringify({
      code,
      stderr: stderr.slice(-1500),
      requests: model.requests.length,
      errors: model.errors,
      hooks: [...new Set(captured.map((e) => (e.hook === "event" ? e.event.type : e.hook)))],
      original: await readFile(join(project, "hooknostic-tool.txt"), "utf8").catch(() => null),
      rewritten: await readFile(join(project, "hooknostic-rewritten.txt"), "utf8").catch(() => null),
      contextRequests: model.requests.filter((r) => JSON.stringify(r).includes("hooknostic-v2-context-marker")).length,
      replacedOutput: model.requests.some((r) => JSON.stringify(r).includes("hooknostic-v2-replaced-output")),
    }),
  );
  diagnostics.complete("write-results");
} catch (error) {
  diagnostics.fail(error);
  throw error;
} finally {
  clearInterval(snapshotTimer);
  snapshotRequests();
  diagnostics.start("cleanup");
  clearTimeout(timeout);
  await model.close();
  await registry?.close();
  await remote?.close();
  diagnostics.complete("cleanup");
}
