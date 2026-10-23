// Behavioral probes against a real v2 binary and loopback models. See README.md.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url));
const { runProcess, startModelPlayback } = await import("../../packages/cli/test/harness-playback.ts");
const { opencodeV2Harness } = await import("../../packages/adapter-opencode/src/v2/harness.ts");
const { AGENT_PLUGIN_MANIFEST_SCHEMA, renderMarkdownFrontmatter } = await import("../../packages/agent-plugin/src/index.ts");
const route = process.argv[2] ?? "plugin";
assert.ok(["plugin", "project", "generated"].includes(route));
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;
const artifactDir = process.env.HKN_PLAYBACK_ARTIFACT_DIR ?? tmpdir();
await mkdir(artifactDir, { recursive: true });
const runRoot = await mkdtemp(join(artifactDir, "hooknostic-native-v2-"));
console.log("HKN-NATIVE-ROOT " + runRoot);
const marker = "HN-NATIVE-SYSTEM";
const name = "probe";
const id = "hn-native-probe";
const baseModel = "hooknostic-playback";
const altModel = "hooknostic-playback-alt";
const cases = ["fields", "uncapped", "object-model", "primary", "disabled", "merge"];

async function drive(caseName) {
  const root = join(runRoot, caseName);
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  const env = { ...process.env, HOME: root, USERPROFILE: root, PWD: project,
    XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
    HKN_NATIVE_TRACE: join(root, "agents.jsonl"), HKN_NATIVE_EVENTS: join(root, "events.jsonl"),
    HKN_PLAYBACK_KEY: "local-playback",
  };
  for (const key of Object.keys(env)) if (/API_KEY|AUTH_TOKEN|SECRET|TOKEN|^OPENCODE|^CLAUDE|^AI_AGENT$/.test(key)) delete env[key];
  let executable = process.env.HKN_OPENCODE_BINARY ?? "opencode";
  if (process.platform === "win32" && !process.env.HKN_OPENCODE_BINARY) {
    const npmRoot = await runProcess("npm", ["root", "--global"], { cwd: project, env });
    executable = join(npmRoot.stdout.trim(), "@opencode/cli/bin/opencode.exe");
  }
  const versionResult = await runProcess(executable, ["--version"], { cwd: project, env });
  assert.equal(versionResult.code, 0, versionResult.stderr);
  const version = versionResult.stdout.trim().replace(/^opencode v/, "");
  assert.equal(version, process.env.HOOKNOSTIC_PLAYBACK_VERSION ?? opencodeV2Harness.referenceVersion);
  const seed = join(project, "seed.txt");
  const denied = join(root, "denied.txt");
  await writeFile(seed, "HN-NATIVE-READ-OK\n");
  await writeFile(denied, "HN-NATIVE-SECRET\n");
  const mode = caseName === "primary" ? "primary" : "subagent";
  const native = {
    model: caseName === "object-model"
      ? { providerID: "playback", model: altModel, variant: "probe" }
      : `playback/${altModel}#probe`,
    hidden: false, color: "#123abc", steps: caseName === "uncapped" ? 4 : 2,
    disabled: caseName === "disabled",
    request: { headers: { "x-hn-agent": "overlay" }, body: { hn_agent_overlay: "overlay", shared: "agent" } },
    permissions: [
      { action: "external_directory", resource: "~/*", effect: "allow" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "read", resource: "~/denied.txt", effect: "deny" },
      { action: "read", resource: "$HOME/second-denied.txt", effect: "deny" },
      { action: "read", resource: "$HOME\\third-denied.txt", effect: "deny" },
      { action: "shell", resource: "echo $HOME", effect: "deny" },
    ],
  };
  const childScript = [
    { kind: "tool", toolName: "read", arguments: { path: denied } },
    { kind: "tool", toolName: "read", arguments: { path: seed } },
    { kind: "tool", toolName: "read", arguments: { path: seed } },
    { kind: "text", text: "HN-NATIVE-DONE" },
  ];
  const parentScript = mode === "primary" ? [{ kind: "text", text: "unexpected default agent" }] : [
    { kind: "tool", toolName: "subagent", arguments: { agent: id, description: "native fields probe", prompt: "Read the probe files and report." } },
    { kind: "text", text: "parent complete" },
  ];
  const parent = await startModelPlayback("openai-chat", "rewrite", parentScript);
  const child = await startModelPlayback("openai-chat", "rewrite", childScript);
  const requests = [];
  const sockets = new Set();
  const proxy = createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
      const isChild = (body.messages ?? []).some(message => message.role === "system" && JSON.stringify(message.content).includes(marker));
      requests.push({ lane: isChild ? "child" : "parent", url: req.url, headers: req.headers, body });
      const dest = new URL(isChild ? child.baseUrl : parent.baseUrl);
      const upstream = httpRequest({ hostname: dest.hostname, port: dest.port, path: req.url, method: req.method,
        headers: { ...req.headers, host: dest.host, "content-length": String(raw.length) } }, reply => {
        res.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(res);
      });
      upstream.on("error", error => { res.writeHead(502); res.end(String(error)); });
      upstream.end(raw);
    });
  });
  proxy.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const plugins = [];
  async function plugin(label, source) {
    const dir = join(root, label);
    await mkdir(dir);
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: `hn-${label}`, type: "module", exports: { "./server": "./index.js" } }));
    await writeFile(join(dir, "index.js"), source);
    plugins.push(dir);
  }
  if (caseName === "disabled" || caseName === "merge") await plugin("seed", `export default { id: "hn-native.seed", async setup(ctx) {
    await ctx.agent.transform(editor => editor.update(${JSON.stringify(id)}, agent => {
      agent.system = "STALE-DISABLED";
      agent.request.headers["x-hn-existing"] = "keep";
      agent.request.headers["x-hn-agent"] = "old";
      agent.request.body.existing = "keep";
      agent.request.body.shared = "old";
      agent.request.settings.seed = "keep";
      agent.permissions.push({ action: "read", resource: "seed-guard", effect: "deny" });
    }));
  } };\n`);
  if (route === "generated") {
    const { buildProject } = await import("../../packages/core/src/build.ts");
    const { defaultAdapterRegistry } = await import("../../packages/cli/src/registry.ts");
    await mkdir(join(root, "source")); await mkdir(join(root, "agents"));
    await writeFile(join(root, "source/plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "hn-native", version: "1.0.0" }));
    await writeFile(join(root, "agents/probe.md"), renderMarkdownFrontmatter({ name, description: "Native fields probe", mode, native: { opencode: native } }, marker));
    const configPath = join(root, "hooknostic.config.ts");
    await writeFile(configPath, `export default ${JSON.stringify({ components: { root: "./source", agents: ["./agents"],
      accept: ["opencode:primary-agent-model-ignored", "opencode:agent-request-ignored"] },
      targets: { opencode: { version, delivery: "package", output: "package" } } })};\n`);
    const result = await buildProject({ configPath, registry: defaultAdapterRegistry() });
    await writeFile(join(root, "build.json"), JSON.stringify(result.report, null, 2));
    assert.equal(result.ok, true, JSON.stringify(result.report.diagnostics));
    plugins.push(join(root, "package"));
  } else if (route === "project") {
    assert.ok(!["merge", "disabled"].includes(caseName), "Seeded merge/removal cases exercise the package editor only");
    await mkdir(join(project, ".opencode/agents"), { recursive: true });
    await writeFile(join(project, ".opencode/agents", `${id}.md`), renderMarkdownFrontmatter({ description: "Native fields probe", mode, ...native }, marker));
  } else {
    // Independent, hand-written translation, following the reference loader.
    await plugin("native", `import path from "node:path";
import { homedir } from "node:os";
const native = ${JSON.stringify(native)};
export default { id: "hn-native.raw", async setup(ctx) {
  await ctx.agent.transform(editor => {
    const id = ${JSON.stringify(id)};
    if (native.disabled) { editor.remove(id); return; }
    editor.update(id, agent => {
      agent.description = "Native fields probe"; agent.mode = ${JSON.stringify(mode)}; agent.system = ${JSON.stringify(marker)};
      const model = typeof native.model === "string" ? (() => {
        const slash = native.model.indexOf("/");
        const [model, variant] = native.model.slice(slash + 1).split("#");
        return { providerID: native.model.slice(0, slash), model, ...(variant === undefined ? {} : { variant }) };
      })() : native.model;
      agent.model = { providerID: model.providerID, id: model.model, ...(model.variant === undefined ? {} : { variant: model.variant }) };
      Object.assign(agent.request.headers, native.request.headers);
      Object.assign(agent.request.body, native.request.body);
      agent.hidden = native.hidden; agent.color = native.color; agent.steps = native.steps;
      const home = homedir();
      agent.permissions.push(...native.permissions.map(rule => {
        if (!["read", "edit", "external_directory"].includes(rule.action)) return rule;
        const resource = rule.resource;
        const relative = resource.startsWith("~/") ? resource.slice(2)
          : resource.startsWith("$HOME/") || resource.startsWith("$HOME\\\\") ? resource.slice(6) : undefined;
        return { ...rule, resource: resource === "~" || resource === "$HOME" ? home
          : relative === undefined ? resource : (path.posix.isAbsolute(home) ? path.posix : path.win32).join(home, relative) };
      }));
    });
  });
} };\n`);
  }
  await plugin("observer", `import { appendFileSync } from "node:fs";
export default { id: "hn-native.observer", async setup(ctx) {
  await ctx.agent.transform(editor => appendFileSync(process.env.HKN_NATIVE_TRACE,
    JSON.stringify(editor.list().filter(agent => agent.id === ${JSON.stringify(id)})) + "\\n"));
  for (const hook of ["execute.before", "execute.after"]) await ctx.tool.hook(hook, event =>
    appendFileSync(process.env.HKN_NATIVE_EVENTS, JSON.stringify({ hook, event }) + "\\n"));
} };\n`);
  const model = { limit: { context: 128000, output: 4096 }, variants: [{ id: "probe", body: { hn_variant_overlay: "variant" } }] };
  await writeFile(join(project, "opencode.json"), JSON.stringify({ plugins, model: `playback/${baseModel}`,
    // Keep external-directory admission independent of the home-expansion mutant.
    permissions: [{ action: "external_directory", resource: join(root, "*"), effect: "allow" }],
    providers: { playback: { env: ["HKN_PLAYBACK_KEY"], package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${proxy.address().port}/v1` }, models: { [baseModel]: model, [altModel]: model } } } }));
  let result;
  try {
    result = await runProcess(executable, ["run", "--standalone", "--auto", "--format", "json",
      ...(mode === "primary" ? ["--agent", id] : []), "Run the native fields probe."], { cwd: project, env, timeoutMs: 90_000 });
  } finally {
    await new Promise(resolve => { proxy.close(resolve); for (const socket of sockets) socket.destroy(); });
    await parent.close(); await child.close();
  }
  await writeFile(join(root, "requests.json"), JSON.stringify(requests, null, 2));
  await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2));
  const inventories = (await readFile(env.HKN_NATIVE_TRACE, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  const agent = inventories.at(-1)[0] ?? null;
  const childRequests = requests.filter(req => req.lane === "child" && req.body.tools?.length);
  const summary = { version, route, case: caseName, exit: result.code, root,
    agent, childTurns: childRequests.length, models: childRequests.map(req => req.body.model),
    firstTools: (childRequests[0]?.body.tools ?? []).map(tool => tool.function.name),
    variantInRequest: childRequests.some(req => req.body.hn_variant_overlay === "variant"),
    agentHeaderInRequest: childRequests.some(req => req.headers["x-hn-agent"] === "overlay"),
    agentBodyInRequest: childRequests.some(req => req.body.hn_agent_overlay === "overlay"),
    deniedReadReported: childRequests.some(req => /permission|denied|rejected/i.test(JSON.stringify(req.body.messages?.filter(message => message.role === "tool")))),
    secretInRequest: requests.some(req => JSON.stringify(req.body).includes("HN-NATIVE-SECRET")),
    parentReturned: requests.some(req => req.lane === "parent" && JSON.stringify(req.body).includes("HN-NATIVE-DONE")),
    errors: [...parent.errors, ...child.errors],
  };
  await writeFile(join(root, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(summary.errors, []);
  assert.equal(summary.secretInRequest, false);
  if (caseName === "disabled") {
    assert.equal(agent, null, "disabled must remove the previously seeded agent");
    assert.equal(summary.childTurns, 0);
  } else {
    assert.equal(summary.childTurns, caseName === "uncapped" ? 4 : 2, "steps must cap the live model turns");
    assert.ok(summary.models.every(model => model === (mode === "primary" ? baseModel : altModel)));
    assert.equal(summary.variantInRequest, mode !== "primary");
    assert.equal(summary.agentHeaderInRequest, false, "The reference build ignores per-agent request overlays");
    assert.equal(summary.agentBodyInRequest, false, "The reference build ignores per-agent request overlays");
    assert.equal(summary.deniedReadReported, true);
    assert.equal(summary.parentReturned, caseName === "uncapped");
    if (route !== "project") {
      assert.deepEqual(agent.model, { providerID: "playback", id: altModel, variant: "probe" });
      assert.equal(agent.color, "#123abc"); assert.equal(agent.hidden, false);
      assert.equal(agent.steps, native.steps);
      for (const rule of native.permissions) {
        if (rule.resource === "echo $HOME") assert.ok(agent.permissions.some(value => value.resource === "echo $HOME"));
        else if (rule.resource.startsWith("~/") || rule.resource.startsWith("$HOME"))
          assert.ok(agent.permissions.some(value => value.action === rule.action && value.resource.startsWith(root)));
      }
      if (caseName === "merge") {
        assert.deepEqual(agent.request, { settings: { seed: "keep" }, headers: { "x-hn-existing": "keep", "x-hn-agent": "overlay" }, body: { existing: "keep", shared: "agent", hn_agent_overlay: "overlay" } });
        assert.ok(agent.permissions.some(rule => rule.resource === "seed-guard"));
      }
    }
  }
  console.log("HKN-NATIVE-SUMMARY " + JSON.stringify(summary));
  return summary;
}
const summaries = [];
for (const caseName of cases) if (only === undefined || only === caseName) {
  if (route === "project" && ["disabled", "merge"].includes(caseName)) continue;
  summaries.push(await drive(caseName));
}
await writeFile(join(runRoot, "summaries.json"), JSON.stringify(summaries, null, 2) + "\n");
