// No model requests: observe the real v2 agent inventory and interactive picker.
import assert from "node:assert/strict";
import { createRequire, register } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url));
const require = createRequire(new URL("../../packages/cli/package.json", import.meta.url));
const { spawn } = require("node-pty");
const { Terminal } = require("@xterm/headless");
const { runProcess } = await import("../../packages/cli/test/harness-playback.ts");
const { opencodeV2Harness } = await import("../../packages/adapter-opencode/src/v2/harness.ts");
const { AGENT_PLUGIN_MANIFEST_SCHEMA } = await import("../../packages/agent-plugin/src/types.ts");
const generated = process.argv.includes("--generated");
const artifactDir = process.env.HKN_PLAYBACK_ARTIFACT_DIR ?? tmpdir();
await mkdir(artifactDir, { recursive: true });
const root = await mkdtemp(join(artifactDir, "hooknostic-hidden-v2-"));
console.log("HKN-HIDDEN-ROOT " + root);
const project = join(root, "project");
await mkdir(project, { recursive: true });
const env = { ...process.env, HOME: root, USERPROFILE: root, PWD: project,
  XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"),
  XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
  HKN_HIDDEN_TRACE: join(root, "agents.jsonl"), TERM: "xterm-256color",
};
for (const key of Object.keys(env)) {
  if (/API_KEY|AUTH_TOKEN|SECRET|TOKEN|^OPENCODE|^CLAUDE|^AI_AGENT$/.test(key)) delete env[key];
}
let executable = process.env.HKN_OPENCODE_BINARY ?? "opencode";
if (process.platform === "win32" && !process.env.HKN_OPENCODE_BINARY) {
  const npmRoot = await runProcess("npm", ["root", "--global"], { cwd: project, env });
  executable = join(npmRoot.stdout.trim(), "@opencode/cli/bin/opencode.exe");
}
const versionResult = await runProcess(executable, ["--version"], { cwd: project, env });
assert.equal(versionResult.code, 0, versionResult.stderr);
const version = versionResult.stdout.trim().replace(/^opencode v/, "");
const expected = process.env.HOOKNOSTIC_PLAYBACK_VERSION ?? opencodeV2Harness.referenceVersion;
assert.equal(version, expected, "Use the reference binary or an explicit playback version override");
const names = ["visible-primary", "hidden-primary"];
let packagePath = join(root, "package");
if (generated) {
  const { buildProject } = await import("../../packages/core/src/build.ts");
  const { defaultAdapterRegistry } = await import("../../packages/cli/src/registry.ts");
  await mkdir(join(root, "source"));
  await mkdir(join(root, "agents"));
  await writeFile(join(root, "source/plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "hn-picker", version: "1.0.0" }));
  for (const name of names) await writeFile(join(root, "agents", `${name}.md`),
    `---\nname: ${name}\ndescription: Picker visibility control\nmode: primary\nnative:\n  opencode:\n    hidden: ${name.startsWith("hidden")}\n---\nOnly answer the user.\n`);
  const configPath = join(root, "hooknostic.config.ts");
  await writeFile(configPath, `export default ${JSON.stringify({
    components: { root: "./source", agents: ["./agents"] },
    targets: { opencode: { version, delivery: "package", output: "package" } },
  })};\n`);
  const result = await buildProject({ configPath, registry: defaultAdapterRegistry() });
  await writeFile(join(root, "build.json"), JSON.stringify(result.report, null, 2));
  assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
} else {
  await mkdir(packagePath);
  await writeFile(join(packagePath, "package.json"), JSON.stringify({ name: "hn-picker", type: "module", exports: { "./server": "./index.js" } }));
  await writeFile(join(packagePath, "index.js"), `export default { id: "hn-picker.native", async setup(ctx) {
    await ctx.agent.transform(editor => {
      for (const [id, hidden] of [["hn-picker-visible-primary", false], ["hn-picker-hidden-primary", true]])
        editor.update(id, agent => Object.assign(agent, { id, mode: "primary", system: "Only answer the user.", hidden }));
    });
  } };\n`);
}
// Registered after the package: this reads the actual agent objects the host exposes.
const observer = join(root, "observer");
await mkdir(observer);
await writeFile(join(observer, "package.json"), JSON.stringify({ name: "hn-picker-observer", type: "module", exports: { "./server": "./index.js" } }));
await writeFile(join(observer, "index.js"), `import { appendFileSync } from "node:fs";
export default { id: "hn-picker.observer", async setup(ctx) {
  await ctx.agent.transform(editor => appendFileSync(process.env.HKN_HIDDEN_TRACE,
    JSON.stringify(editor.list().filter(agent => agent.id.startsWith("hn-picker-")).map(({ id, mode, hidden }) => ({ id, mode, hidden }))) + "\\n"));
} };\n`);
await writeFile(join(project, "opencode.json"), JSON.stringify({ plugins: [packagePath, observer] }));
const terminal = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
const child = spawn(executable, ["--standalone", "--auto"], { cwd: project, env, cols: 120, rows: 40, name: "xterm-256color" });
let transcript = "", exited = false;
child.onData(chunk => { transcript += chunk; terminal.write(chunk); });
const done = new Promise(resolve => child.onExit(event => { exited = true; resolve(event); }));
const screen = () => Array.from({ length: terminal.rows }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + i)?.translateToString(true) ?? "").join("\n");
let summary;
try {
  for (let i = 0; i < 200 && !exited; i++) {
    if (/Ask anything|Type a message|Build|Connect a provider/.test(screen())) break;
    await delay(100);
  }
  assert.equal(exited, false, "TUI exited during startup");
  child.write("\x18a");
  for (let i = 0; i < 100 && !exited; i++) {
    if (screen().includes("Select agent") && screen().includes("hn-picker-visible-primary")) break;
    await delay(100);
  }
  const picker = screen();
  const records = (await readFile(env.HKN_HIDDEN_TRACE, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  const agents = records.at(-1);
  summary = { version, generated, agents, picker, visibleInPicker: picker.includes("hn-picker-visible-primary"), hiddenInPicker: picker.includes("hn-picker-hidden-primary") };
  await writeFile(join(root, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  assert.equal(picker.includes("Select agent"), true, picker);
  assert.equal(summary.visibleInPicker, true, picker);
  assert.equal(summary.hiddenInPicker, false, picker);
  assert.deepEqual([...agents].sort((a, b) => a.id.localeCompare(b.id)), [
    { id: "hn-picker-visible-primary", mode: "primary", hidden: false },
    { id: "hn-picker-hidden-primary", mode: "primary", hidden: true },
  ].sort((a, b) => a.id.localeCompare(b.id)));
} finally {
  await writeFile(join(root, "terminal.txt"), transcript);
  if (!exited) {
    child.write("\x03");
    await Promise.race([done, delay(3000)]);
  }
  if (!exited) child.kill();
  await done;
  terminal.dispose();
}
console.log("HKN-HIDDEN-SUMMARY " + JSON.stringify(summary));
