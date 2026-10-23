// Native Pi default-role investigation. Transport/observation extensions only;
// role behavior comes from Pi's own prompt files, settings, and CLI options.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url).href);
const { describeTools, runProcess, startModelPlayback } = await import("../../packages/cli/test/harness-playback.ts");
const { withoutCredentials } = await import("../../scripts/drive-capture-session.mjs");
const { piHarness } = await import("../../packages/adapter-pi/src/harness.ts");
const { piAdapter } = await import("../../packages/adapter-pi/src/index.ts");
const { runProject } = await import("../../packages/core/src/project.ts");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const generatedOnly = process.argv.includes("--generated-only");
const output = resolve(
  process.env.HKN_PI_DEFAULT_OUTPUT ??
    join(repo, ".capture/pi-default-agent/captured", process.platform + (generatedOnly ? "-generated" : "")),
);
mkdirSync(output, { recursive: true });
const executable = process.env.HKN_PI_BINARY ?? "pi";
const detected = await runProcess(executable, ["--version"], { cwd: repo, env: withoutCredentials() });
assert.equal(detected.code, 0, detected.stderr);
const version = detected.stdout.trim();
assert.equal(version, process.env.HOOKNOSTIC_PLAYBACK_VERSION || piHarness.referenceVersion);
writeFileSync(join(output, "metadata.json"), JSON.stringify({ account: userInfo().username, home: homedir() }) + "\n");
const markers = {
  projectSystem: "HKN-PROJECT-SYSTEM",
  projectAppend: "HKN-PROJECT-APPEND",
  globalSystem: "HKN-GLOBAL-SYSTEM",
  globalAppend: "HKN-GLOBAL-APPEND",
  context: "HKN-PROJECT-CONTEXT",
  skill: "HKN-ROLE-SKILL",
  cliSystem: "HKN-CLI-SYSTEM",
  cliAppend: "HKN-CLI-APPEND",
  injectedRole: "HKN-INJECTED-ROLE",
  generatedRole: "HKN-GENERATED-DEFAULT-ROLE",
};
const observations = [];
let nativePrefix;
const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const readLines = (path) =>
  existsSync(path) ? readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];

async function probe(label, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "hkn-pi-default-"));
  const project = join(root, "project");
  const agent = join(root, "agent");
  const cwd = options.nested ? join(project, "nested") : project;
  const log = join(root, "events.jsonl");
  const env = {
    ...withoutCredentials(),
    HOME: root,
    USERPROFILE: root,
    PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: "1",
    HKN_PI_DEFAULT_TRACE: log,
  };
  // No ambient model credential or cloud configuration enters the probe.
  for (const name of Object.keys(env)) if (/API_KEY|AUTH_TOKEN|SECRET|TOKEN|CREDENTIAL/.test(name)) delete env[name];
  let server;
  try {
    for (const path of [project, agent, cwd, join(project, ".git"), join(project, ".pi")])
      mkdirSync(path, { recursive: true });
    write(
      join(agent, "settings.json"),
      JSON.stringify({
        defaultProvider: "hooknostic-role-probe",
        defaultModel: "base",
        defaultThinkingLevel: "low",
        ...options.globalSettings,
      }),
    );
    write(join(project, ".pi/settings.json"), JSON.stringify(options.settings ?? {}));
    for (const [scope, file, marker] of [
      ["project", "SYSTEM.md", "projectSystem"],
      ["project", "APPEND_SYSTEM.md", "projectAppend"],
      ["agent", "SYSTEM.md", "globalSystem"],
      ["agent", "APPEND_SYSTEM.md", "globalAppend"],
    ])
      if (options[marker])
        write(
          join(scope === "project" ? join(project, ".pi") : agent, file),
          markers[marker] + "\nYou perform the harmless role probe.\n",
        );
    if (options.context) write(join(project, "AGENTS.md"), markers.context + "\n");
    if (options.skill)
      write(
        join(project, options.generated ? "skills/role/SKILL.md" : ".pi/skills/role/SKILL.md"),
        `---\nname: role\ndescription: ${markers.skill}\n---\nHarmless role instructions.\n`,
      );
    if (options.emptyProject) write(join(project, ".pi/APPEND_SYSTEM.md"), "");
    if (options.namedAgent)
      write(
        join(project, ".pi/agents/reviewer.md"),
        `---\nname: reviewer\ndescription: ${markers.skill}\n---\n${markers.projectSystem}\n`,
      );
    write(join(root, "cli-system.md"), markers.cliSystem + "\n");
    write(join(root, "cli-append.md"), markers.cliAppend + "\n");
    if (options.generated) {
      const instructions = markers.generatedRole + "\nYou perform the harmless generated role probe.\n";
      write(
        join(project, "agents/planner.md"),
        `---\nname: planner\ndescription: A generated role probe.\nmode: primary\n---\n${instructions}`,
      );
      const configPath = join(project, "hooknostic.config.ts");
      write(
        configPath,
        `export default ${JSON.stringify({
          project: { root: "." },
          components: {
            agents: ["./agents"],
            defaultAgent: "planner",
            ...(options.skill ? { skills: ["./skills"] } : {}),
          },
          targets: {
            pi: { version: piHarness.recommendedRange, delivery: "project", output: ".hooknostic/artifacts/pi" },
          },
        })};`,
      );
      const buildOptions = { configPath, registry: { pi: piAdapter() } };
      const synced = await runProject({ ...buildOptions, command: "sync" });
      assert.equal(synced.ok, true, synced.errors.join("\n"));
      assert.equal((await runProject({ ...buildOptions, command: "verify" })).ok, true);
      assert.equal(readFileSync(join(project, ".pi/APPEND_SYSTEM.md"), "utf8"), instructions);
    }
    server = await startModelPlayback(
      "openai-chat",
      "rewrite",
      options.tool
        ? [
            { kind: "tool", toolName: "read", arguments: { path: join(project, "seed.txt") } },
            { kind: "text", text: "HKN-ROLE-COMPLETE" },
          ]
        : [{ kind: "text", text: "HKN-ROLE-COMPLETE" }],
    );
    write(join(project, "seed.txt"), "harmless seed\n");
    const provider = join(root, "provider.js");
    write(
      provider,
      `export default function (pi) {
  pi.registerProvider("hooknostic-role-probe", {
    baseUrl: ${JSON.stringify(server.baseUrl)}, apiKey: "loopback-only", api: "openai-completions",
    models: ["base", "role", "override"].map(id => ({ id, name: id, reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 })),
  });
}
`,
    );
    const observer = options.observerProject ? join(project, ".pi/extensions/probe-role.js") : join(root, "observe.js");
    write(
      observer,
      `import { appendFileSync } from "node:fs";
export default function (pi) {
  ${
    options.extraTool
      ? `pi.registerTool({ name: "probe_extra", label: "Probe extra", description: "Harmless extra tool",
    parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "unused" }] }) });`
      : ""
  }
  for (const name of ["session_start", "before_agent_start", "tool_call", "tool_result", "agent_settled"]) {
    pi.on(name, (event, ctx) => {
      appendFileSync(process.env.HKN_PI_DEFAULT_TRACE,
        JSON.stringify({ event, context: { cwd: ctx.cwd, mode: ctx.mode, systemPrompt: ctx.getSystemPrompt(), thinking: pi.getThinkingLevel() } }) + "\\n");
      ${options.injectDefault ? `if (name === "before_agent_start") return { systemPrompt: event.systemPrompt + "\\n${markers.injectedRole}\\n" };` : ""}
    });
  }
}
`,
    );
    const args = [
      "--offline",
      ...(options.observerProject ? [] : ["--no-extensions"]),
      "-e",
      provider,
      ...(options.observerProject ? [] : ["-e", observer]),
      "--no-session",
      "-p",
      ...(options.trusted === false ? ["--no-approve"] : ["--approve"]),
      ...(options.cliSystem ? ["--system-prompt", join(root, "cli-system.md")] : []),
      ...(options.cliAppend ? ["--append-system-prompt", join(root, "cli-append.md")] : []),
      ...(options.modelOverride ? ["--model", "hooknostic-role-probe/override", "--thinking", "minimal"] : []),
      ...(options.toolOverride ? ["--tools", "read,ls"] : []),
      "Complete the harmless role probe.",
    ];
    const result = await runProcess(executable, args, { cwd, env, timeoutMs: 45_000 });
    const events = readLines(log);
    const request = server.requests[0];
    const promptMessages = request?.messages?.filter((message) => ["system", "developer"].includes(message.role)) ?? [];
    const system = promptMessages
      .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
      .join("\n");
    if (label === "control") nativePrefix = system.split("\n")[0];
    const flags = Object.fromEntries(Object.entries(markers).map(([name, marker]) => [name, system.includes(marker)]));
    const summary = {
      label,
      exit: result.code,
      requestCount: server.requests.length,
      model: request?.model,
      thinking: events.find((value) => value.event.type === "before_agent_start")?.context.thinking,
      requestThinking: request?.reasoning_effort,
      tools: describeTools(request ?? {}).map((value) => value.name),
      promptRoles: promptMessages.map((message) => message.role),
      nativePrompt: !!nativePrefix && system.includes(nativePrefix),
      markers: flags,
      markerOrder: Object.entries(markers)
        .filter(([, marker]) => system.includes(marker))
        .sort((a, b) => system.indexOf(a[1]) - system.indexOf(b[1]))
        .map(([name]) => name),
      toolEvents: events
        .filter((value) => ["tool_call", "tool_result"].includes(value.event.type))
        .map((value) => value.event),
      eventTypes: events.map((value) => value.event.type),
      stderr: result.stderr.trim(),
    };
    write(
      join(output, label, "raw.json"),
      JSON.stringify({ args, options, result, requests: server.requests, events }, null, 2) + "\n",
    );
    observations.push(summary);
    console.log(JSON.stringify(summary));
    assert.equal(result.code, 0, `${label}: ${result.stderr}`);
    assert.equal(server.errors.length, 0, `${label}: ${JSON.stringify(server.errors)}`);
    assert.ok(request, `${label}: no model request`);
    assert.equal(promptMessages.length, 1, `${label}: no single high-priority prompt`);
    return summary;
  } finally {
    if (server) await server.close();
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("hkn-pi-default-"))
      throw new Error("Unexpected probe root");
    rmSync(root, { recursive: true, force: true });
  }
}

await probe("control");
if (!generatedOnly) {
  await probe("project-system", { projectSystem: true, context: true, skill: true, tool: true });
  await probe("project-append", { projectAppend: true, context: true, tool: true });
  await probe("project-both", { projectSystem: true, projectAppend: true });
  await probe("global-both", { globalSystem: true, globalAppend: true });
  await probe("project-over-global", {
    projectSystem: true,
    projectAppend: true,
    globalSystem: true,
    globalAppend: true,
  });
  await probe("project-system-global-append", { projectSystem: true, globalSystem: true, globalAppend: true });
  await probe("project-append-global-system", { projectAppend: true, globalSystem: true, globalAppend: true });
  await probe("untrusted", {
    projectSystem: true,
    projectAppend: true,
    globalSystem: true,
    globalAppend: true,
    context: true,
    skill: true,
    settings: { defaultModel: "role", defaultThinkingLevel: "high", defaultTools: ["read", "grep"] },
    trusted: false,
  });
  await probe("project-settings", {
    projectAppend: true,
    settings: { defaultModel: "role", defaultThinkingLevel: "high", defaultTools: ["read", "grep"] },
  });
  await probe("settings-with-extension-tool", {
    projectAppend: true,
    extraTool: true,
    settings: { defaultTools: ["read", "grep"] },
  });
  await probe("cli-overrides", {
    projectSystem: true,
    projectAppend: true,
    cliSystem: true,
    cliAppend: true,
    settings: { defaultModel: "role", defaultThinkingLevel: "high", defaultTools: ["read", "grep"] },
    modelOverride: true,
    toolOverride: true,
  });
  await probe("cli-append", { projectAppend: true, globalAppend: true, cliAppend: true });
  await probe("nested-directory", {
    projectSystem: true,
    projectAppend: true,
    context: true,
    nested: true,
    settings: { defaultModel: "role", defaultThinkingLevel: "high", defaultTools: ["read", "grep"] },
  });
  await probe("empty-project-append", { projectAppend: true, globalAppend: true, emptyProject: true });
  await probe("named-definition-only", { namedAgent: true });
  await probe("generated-style-role", { globalAppend: true, injectDefault: true, observerProject: true });
  await probe("generated-style-custom-system", {
    projectSystem: true,
    globalAppend: true,
    injectDefault: true,
    observerProject: true,
  });
  await probe("generated-style-cli", { cliSystem: true, cliAppend: true, injectDefault: true, observerProject: true });
  await probe("generated-style-untrusted", {
    globalAppend: true,
    injectDefault: true,
    observerProject: true,
    trusted: false,
  });
}
await probe("generated-default", { generated: true, globalAppend: true, context: true, skill: true, tool: true });
await probe("generated-custom-system", { generated: true, projectSystem: true, globalAppend: true, tool: true });
await probe("generated-cli-override", { generated: true, globalAppend: true, cliAppend: true });
await probe("generated-untrusted", { generated: true, globalAppend: true, trusted: false });
const expectedMarkers = {
  control: [],
  "project-system": ["projectSystem", "context", "skill"],
  "project-append": ["projectAppend", "context"],
  "project-both": ["projectSystem", "projectAppend"],
  "global-both": ["globalSystem", "globalAppend"],
  "project-over-global": ["projectSystem", "projectAppend"],
  "project-system-global-append": ["projectSystem", "globalAppend"],
  "project-append-global-system": ["projectAppend", "globalSystem"],
  untrusted: ["globalSystem", "globalAppend", "context"],
  "project-settings": ["projectAppend"],
  "settings-with-extension-tool": ["projectAppend"],
  "cli-overrides": ["cliSystem", "cliAppend"],
  "cli-append": ["cliAppend"],
  "nested-directory": ["context"],
  "empty-project-append": [],
  "named-definition-only": [],
  "generated-style-role": ["globalAppend", "injectedRole"],
  "generated-style-custom-system": ["projectSystem", "globalAppend", "injectedRole"],
  "generated-style-cli": ["cliSystem", "cliAppend", "injectedRole"],
  "generated-style-untrusted": ["globalAppend"],
  "generated-default": ["generatedRole", "context", "skill"],
  "generated-custom-system": ["projectSystem", "generatedRole"],
  "generated-cli-override": ["cliAppend"],
  "generated-untrusted": ["globalAppend"],
};
for (const result of observations) {
  assert.deepEqual(
    Object.keys(result.markers)
      .filter((name) => result.markers[name])
      .sort(),
    expectedMarkers[result.label].toSorted(),
    result.label,
  );
  assert.equal(
    result.nativePrompt,
    ![
      "project-system",
      "project-both",
      "global-both",
      "project-over-global",
      "project-system-global-append",
      "project-append-global-system",
      "untrusted",
      "cli-overrides",
      "generated-style-custom-system",
      "generated-style-cli",
      "generated-custom-system",
    ].includes(result.label),
    result.label,
  );
}
const observation = (label) => observations.find((value) => value.label === label);
if (!generatedOnly) {
  assert.equal(observation("project-settings").model, "role");
  assert.equal(observation("project-settings").thinking, "high");
  assert.equal(observation("project-settings").requestThinking, "high");
  assert.deepEqual(observation("project-settings").tools, ["read", "grep"]);
  assert.deepEqual(observation("settings-with-extension-tool").tools, ["read", "grep", "probe_extra"]);
  assert.equal(observation("untrusted").model, "base");
  assert.equal(observation("untrusted").thinking, "low");
  assert.equal(observation("cli-overrides").model, "override");
  assert.equal(observation("cli-overrides").thinking, "minimal");
  assert.equal(observation("cli-overrides").requestThinking, "minimal");
  assert.deepEqual(observation("cli-overrides").tools, ["read", "ls"]);
  assert.equal(observation("nested-directory").model, "base");
  for (const label of ["project-system", "project-append"]) {
    const events = observation(label).toolEvents;
    assert.equal(events.length, 2);
    assert.ok(
      events.every(
        (event) => !["agentType", "agent_type", "agentId", "agent_id"].some((key) => Object.hasOwn(event, key)),
      ),
    );
  }
}
for (const label of ["generated-default", "generated-custom-system"]) {
  const result = observation(label);
  assert.equal(result.model, "base");
  assert.deepEqual(result.tools, ["read", "bash", "edit", "write"]);
  assert.equal(result.toolEvents.length, 2);
  assert.ok(
    result.toolEvents.every(
      (event) => !["agentType", "agent_type", "agentId", "agent_id"].some((key) => Object.hasOwn(event, key)),
    ),
  );
}
write(
  join(output, "summary.json"),
  JSON.stringify(
    {
      version,
      platform: process.platform,
      runtime: process.version,
      date: new Date().toISOString(),
      nativePrefix,
      observations,
    },
    null,
    2,
  ) + "\n",
);
console.log(`COMPLETED ${observations.length} native Pi probes; ${output}`);
