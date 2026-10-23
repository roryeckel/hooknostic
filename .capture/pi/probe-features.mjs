// Model-free Pi probes for features added after the adapter's first capture.
// Raw results stay in captured-features/. Run with Node's type stripping.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url).href);
const { describeTools, runProcess, startModelPlayback, writePiProviderExtension } =
  await import("../../packages/cli/test/harness-playback.ts");
const { withoutCredentials } = await import("../../scripts/drive-capture-session.mjs");
const { piHarness } = await import("../../packages/adapter-pi/src/harness.ts");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const executable = process.env.HKN_PI_BINARY ?? "pi";
const mode = process.argv[2] ?? "all";
if (!["all", "shells", "files", "skills", "fields"].includes(mode)) throw new Error("Unknown probe mode: " + mode);
const only = process.argv[3];
const out = resolve(process.env.HKN_PI_FEATURE_OUTPUT ?? join(repo, ".capture/pi/captured-features", process.platform));
mkdirSync(out, { recursive: true });
const detected = await runProcess(executable, ["--version"], { cwd: repo, env: withoutCredentials() });
if (detected.code !== 0) throw new Error(detected.stderr);
const version = detected.stdout.trim();
// A capture session may probe a candidate build before the metadata moves to it.
const expected = process.env.HKN_PI_EXPECTED_VERSION ?? piHarness.referenceVersion;
if (version !== expected) throw new Error(`Expected build ${expected}, found ${version}`);
const metadata = {
  version,
  platform: process.platform,
  date: new Date().toISOString(),
  account: userInfo().username,
  home: homedir(),
};
writeFileSync(join(out, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n");

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}
function readLines(path) {
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
}

async function session(label, options = {}) {
  if (only && label !== only && label !== "file-discovery") return;
  const root = mkdtempSync(join(tmpdir(), "hkn-pi-features-"));
  try {
    const project = join(root, "project");
    const agent = join(root, "agent");
    const capture = join(root, "captured");
    for (const path of [project, agent, capture, join(project, ".git"), join(project, ".pi")])
      mkdirSync(path, { recursive: true });
    const env = {
      ...withoutCredentials(),
      HOME: root,
      USERPROFILE: root,
      PI_CODING_AGENT_DIR: agent,
      HKN_CAPTURE_DIR: capture,
      HKN_PI_PROBE: "tee",
      ...options.env,
    };
    // A disposable home and a repository boundary prevent global/ancestor skills.
    writeFileSync(join(project, ".pi/settings.json"), JSON.stringify(options.settings ?? {}));
    cpSync(join(repo, ".capture/pi/hooknostic-capture.ts"), join(project, "capture.ts"));
    cpSync(join(repo, ".capture/pi/feature-context.js"), join(project, "feature-context.js"));
    cpSync(join(repo, ".capture/shell-dialects/interpreter.cjs"), join(project, "interpreter.cjs"));
    if (process.platform === "linux") {
      // Only our node process, its actual interpreter, and Pi are needed. The
      // container's root-owned su ancestor is intentionally not readable by node.
      const probe = join(project, "interpreter.cjs");
      writeFileSync(probe, readFileSync(probe, "utf8").replaceAll("i < 5", "i < 3"));
    }
    if (options.setup) await options.setup({ root, project, agent, env });
    const server = await startModelPlayback(
      "openai-chat",
      "rewrite",
      options.turns ?? [{ kind: "text", text: "FEATURE_FINAL_REPLY" }],
    );
    let result;
    try {
      const provider = await writePiProviderExtension(project, server.baseUrl);
      result = await runProcess(
        executable,
        [
          "--provider",
          "hooknostic-playback",
          "--model",
          "hooknostic-playback",
          "-e",
          provider,
          "-e",
          join(project, "capture.ts"),
          "-e",
          join(project, "feature-context.js"),
          ...(options.skills ? [] : ["--no-skills"]),
          ...(options.tools ? ["--tools", options.tools] : []),
          "--approve",
          "--no-session",
          "-p",
          options.prompt ?? "Perform the harmless feature probe, then stop.",
        ],
        { cwd: project, env, timeoutMs: 45000 },
      );
    } finally {
      await server.close();
    }
    const target = join(out, label);
    mkdirSync(target, { recursive: true });
    cpSync(capture, join(target, "events"), { recursive: true });
    const observation = {
      label,
      ...metadata,
      settings: options.settings ?? {},
      ...(options.env ? { configuredEnvironment: options.env } : {}),
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      tools: describeTools(server.requests.find((request) => request.tools) ?? {}),
      interpreter: readJson(join(project, "interpreter.json")),
      before: readLines(join(capture, "tool_call.jsonl")),
      after: readLines(join(capture, "tool_result.jsonl")),
      sessionContext: readLines(join(capture, "session-context.jsonl")),
      requests: server.requests,
    };
    writeFileSync(join(target, "observation.json"), JSON.stringify(observation, null, 2) + "\n");
    console.log(
      JSON.stringify({
        label,
        exitCode: result.code,
        requests: server.requests.length,
        interpreter: observation.interpreter?.ancestry?.slice(0, 3),
      }),
    );
    if (result.code !== 0) throw new Error(`${label}: exit ${result.code}: ${result.stderr.slice(-1000)}`);
    if (label.startsWith("bash-") || label.startsWith("powershell-")) {
      if (!observation.interpreter) throw new Error("No interpreter observation for " + label);
    }
    return observation;
  } finally {
    // Remove only the scratch directory this invocation created under tmpdir.
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith("hkn-pi-features-"))
      throw new Error("Unexpected scratch root");
    rmSync(root, { recursive: true, force: true });
  }
}

const tool = (name, args) => ({ kind: "tool", toolName: name, arguments: args });
const complete = { kind: "text", text: "FEATURE_FINAL_REPLY" };

if (mode === "all" || mode === "shells") {
  const command = "node interpreter.cjs; echo hooknostic-shell-finished";
  const cases = [["bash-default", "bash", {}, {}]];
  if (process.platform === "win32") {
    const windowsPS = join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
    const pwsh = process.env.HKN_PWSH_BINARY;
    cases.push(
      ["bash-shell-env-powershell", "bash", {}, { SHELL: windowsPS }],
      ["bash-configured-powershell", "bash", { shellPath: windowsPS }, {}],
      ["powershell-default", "powershell", {}, {}],
      [
        "powershell-windows",
        "powershell",
        {},
        {
          PATH: [dirname(process.execPath), dirname(windowsPS), join(process.env.SystemRoot, "System32")].join(
            delimiter,
          ),
        },
      ],
    );
    if (pwsh)
      cases.push(
        ["bash-configured-pwsh", "bash", { shellPath: pwsh }, {}],
        ["powershell-pwsh", "powershell", {}, { PATH: dirname(pwsh) + delimiter + process.env.PATH }],
      );
  } else {
    for (const shell of ["/bin/sh", "/usr/bin/zsh", "/usr/bin/fish", "/usr/bin/tcsh"]) {
      if (existsSync(shell))
        cases.push(["bash-configured-" + shell.split("/").at(-1), "bash", { shellPath: shell }, {}]);
    }
  }
  for (const [label, name, settings, env] of cases)
    await session(label, { settings, env, tools: name, turns: [tool(name, { command }), complete] });
}

if (mode === "all" || mode === "files") {
  const discovery = await session("file-discovery", { tools: "read,write,edit,grep,find,ls" });
  const declared = new Map(discovery.tools.map((entry) => [entry.name, entry.properties]));
  for (const [name, args] of [
    ["read", { path: "seed.txt" }],
    ["write", { path: "created.txt", content: "written\n" }],
    ["edit", { path: "seed.txt", edits: [{ oldText: "alpha", newText: "beta" }] }],
    ["grep", { pattern: "alpha", path: "." }],
    ["find", { pattern: "*.txt", path: "." }],
    ["ls", { path: "." }],
  ]) {
    if (!declared.get(name)?.includes("path")) throw new Error("No advertised path key for " + name);
    await session("file-" + name, {
      tools: name,
      setup: ({ project }) => writeFileSync(join(project, "seed.txt"), "alpha\n"),
      turns: [tool(name, args), complete],
    });
  }
}

const references = [
  "CLAUDE_SKILL_DIR",
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_DATA",
  "CLAUDE_SESSION_ID",
  "SKILL_DIR",
  "PLUGIN_ROOT",
  "PLUGIN_DATA",
  "HOME",
];
if (mode === "all" || mode === "fields")
  await session("turn-fields", { turns: [tool("bash", { command: "echo feature-probe" }), complete] });
if (mode === "all" || mode === "skills") {
  for (const route of ["project", "package", "agents", "ancestor-agents"]) {
    for (const state of ["absent", "denied", "allowed", "explicit"]) {
      await session(`skill-${route}-${state}`, {
        skills: true,
        prompt:
          state === "explicit" ? "/skill:feature-probe report the probe body" : "Reply done without loading any skill.",
        setup: async ({ root, project, agent, env }) => {
          const base =
            route === "package"
              ? join(root, "package/skills")
              : route === "agents"
                ? join(project, ".agents/skills")
                : route === "ancestor-agents"
                  ? join(root, ".agents/skills")
                  : join(project, ".pi/skills");
          if (route === "ancestor-agents") {
            // The parent is a separate configured source. Move the git boundary there.
            const { rmdirSync } = await import("node:fs");
            rmdirSync(join(project, ".git"));
            mkdirSync(join(root, ".git"));
          }
          const skillDir = join(base, "feature-probe");
          mkdirSync(skillDir, { recursive: true });
          writeFileSync(
            join(skillDir, "SKILL.md"),
            "---\nname: feature-probe\ndescription: FEATURE_SKILL_DESCRIPTION ${SKILL_DIR}\n" +
              (state === "absent" ? "" : `disable-model-invocation: ${state !== "allowed"}\n`) +
              "---\n\nFEATURE_SKILL_BODY\n" +
              references.map((name) => name + "=${" + name + "}").join("\n") +
              "\nrelative=./scripts/where.mjs\n",
          );
          if (route === "package") {
            const pkg = join(root, "package");
            writeFileSync(
              join(pkg, "package.json"),
              JSON.stringify({ name: "pi-feature-probe", version: "1.0.0", pi: { skills: ["./skills"] } }),
            );
            const installed = await runProcess(executable, ["install", "-l", "--approve", pkg], { cwd: project, env });
            if (installed.code !== 0) throw new Error(installed.stderr);
          }
          writeFileSync(join(agent, "settings.json"), "{}\n");
        },
      });
    }
  }
}
