// Installed (copied) plugin probe for GitHub Copilot CLI.
//
// usage, where `copilot` is the build to record (a disposable Linux container):
//   node .capture/copilot/installed-plugin-probe.mjs
//
// The live routes (--plugin-dir, a local-path marketplace) copy nothing. This
// probe serves one Agent Plugins 1.0 package from a loopback smart-HTTP git
// server and installs it three ways, each into its own COPILOT_HOME: a direct
// `copilot plugin install <git URL>`, `plugin@marketplace` from a git-hosted
// marketplace, and a `--plugin-dir` control. For each it records the install
// tree, whether a dependency install ran (a postinstall marker), and what
// PLUGIN_ROOT and PLUGIN_DATA a hook and a stdio MCP server saw. The model
// endpoint is unreachable on purpose: sessionStart and stdio servers start
// before any model call.
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

const ROOT = join(tmpdir(), "hooknostic-copilot-installed-plugin");
const SOURCE = join(ROOT, "source");
const PROJECT = join(ROOT, "project");
const LOG = join(ROOT, "events.jsonl");

rmSync(ROOT, { recursive: true, force: true });
for (const dir of [SOURCE, PROJECT]) mkdirSync(dir, { recursive: true });

const recorder = `import { appendFileSync, readFileSync } from "node:fs";
const input = process.argv[3] === "hook" ? readFileSync(0, "utf8") : "";
appendFileSync(process.argv[2], JSON.stringify({ kind: process.argv[3], argv: process.argv.slice(4), cwd: process.cwd(),
  pluginRoot: process.env.PLUGIN_ROOT ?? null, pluginData: process.env.PLUGIN_DATA ?? null, input: input.slice(0, 400) }) + "\\n");
if (process.argv[3] === "mcp") setTimeout(() => process.exit(0), 15000);
`;
const files = {
  "plugin.json": {
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "hooknostic-installed-probe",
    description: "Capture probe",
    version: "1.0.0",
  },
  "recorder.mjs": recorder,
  "mcp.json": {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: {
      probe: {
        type: "stdio",
        command: "node",
        args: ["${PLUGIN_ROOT}/recorder.mjs", LOG, "mcp", "${PLUGIN_ROOT}", "${PLUGIN_DATA}"],
      },
    },
  },
  "com.github.copilot/hooks/hooks.json": {
    version: 1,
    hooks: {
      sessionStart: [
        { type: "command", exec: "node", args: ["${PLUGIN_ROOT}/recorder.mjs", LOG, "hook", "${PLUGIN_ROOT}"] },
      ],
    },
  },
  "skills/probe-skill/SKILL.md": "---\nname: probe-skill\ndescription: Installed probe skill.\n---\n\nProbe body.\n",
  // A dependency install would run this postinstall and leave a marker.
  "package.json": {
    name: "hooknostic-installed-probe",
    version: "1.0.0",
    private: true,
    scripts: { postinstall: `node -e "require('fs').writeFileSync('postinstall-ran','yes')"` },
  },
  "package-lock.json": {
    name: "hooknostic-installed-probe",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "hooknostic-installed-probe", version: "1.0.0" } },
  },
};
for (const [path, contents] of Object.entries(files)) {
  mkdirSync(join(SOURCE, path, ".."), { recursive: true });
  writeFileSync(join(SOURCE, path), typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`);
}
const git = (args, cwd = SOURCE) => execFileSync("git", args, { cwd, encoding: "utf8" });
git(["init", "-q"]);
git(["add", "-A"]);
git(["-c", "user.email=capture@example.invalid", "-c", "user.name=capture", "commit", "-qm", "probe"]);
const bare = join(ROOT, "plugin.git");
git(["clone", "-q", "--bare", SOURCE, bare], ROOT);
git(["update-server-info"], bare);

// A marketplace repository indexing the same plugin, for plugin@marketplace.
const MARKET = join(ROOT, "market-src");
for (const [path, contents] of Object.entries(files)) {
  const target = join(MARKET, "plugins", "hooknostic-installed-probe", path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`);
}
mkdirSync(join(MARKET, ".github", "plugin"), { recursive: true });
writeFileSync(
  join(MARKET, ".github", "plugin", "marketplace.json"),
  `${JSON.stringify(
    {
      name: "hooknostic-probe-market",
      owner: { name: "capture" },
      plugins: [{ name: "hooknostic-installed-probe", source: "./plugins/hooknostic-installed-probe", version: "1.0.0" }],
    },
    null,
    2,
  )}\n`,
);
git(["init", "-q"], MARKET);
git(["add", "-A"], MARKET);
git(["-c", "user.email=capture@example.invalid", "-c", "user.name=capture", "commit", "-qm", "market"], MARKET);
git(["clone", "-q", "--bare", MARKET, join(ROOT, "market.git")], ROOT);

// Smart-HTTP git through `git http-backend` as CGI: Copilot clones with
// --depth 1, which the dumb protocol cannot serve.
const server = createServer((request, response) => {
  const target = new URL(request.url, "http://x");
  const cgi = spawn("git", ["http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: ROOT,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: decodeURIComponent(target.pathname),
      QUERY_STRING: target.search.replace(/^\?/, ""),
      REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers["content-type"] ?? "",
      ...(request.headers["git-protocol"] === undefined ? {} : { GIT_PROTOCOL: request.headers["git-protocol"] }),
    },
  });
  request.pipe(cgi.stdin);
  const chunks = [];
  cgi.stdout.on("data", (chunk) => chunks.push(chunk));
  cgi.on("close", () => {
    const output = Buffer.concat(chunks);
    const split = output.indexOf("\r\n\r\n");
    const head = output.subarray(0, split).toString("utf8").split("\r\n");
    let status = 200;
    const headers = {};
    for (const line of head) {
      const [name, ...rest] = line.split(":");
      const value = rest.join(":").trim();
      if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
      else headers[name] = value;
    }
    response.writeHead(status, headers).end(output.subarray(split + 4));
  });
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${server.address().port}/plugin.git`;

const env = {
  ...process.env,
  COPILOT_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1",
  COPILOT_PROVIDER_TYPE: "openai",
  COPILOT_PROVIDER_API_KEY: "hooknostic-capture",
  COPILOT_MODEL: "probe",
};
// Asynchronous: a synchronous spawn would block the git server above.
const run = (args, cwd = PROJECT) =>
  new Promise((done) => {
    const child = spawn("copilot", args, { cwd, env, timeout: 120_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => done({ status, stdout: stdout.trim(), stderr: stderr.trim() }));
  });

const walk = (dir) =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? (name === ".git" ? [] : walk(path)) : [path];
      })
    : [];
const marketUrl = `http://127.0.0.1:${server.address().port}/market.git`;
const session = ["--trust-folder", "--allow-all-tools", "--disable-client-telemetry", "--no-auto-update"];
git(["init", "-q"], PROJECT);

// Each route gets its own COPILOT_HOME; the recorder log is read per route.
async function route(name, setup, extraArgs = []) {
  env.COPILOT_HOME = join(ROOT, `home-${name}`);
  mkdirSync(env.COPILOT_HOME, { recursive: true });
  rmSync(LOG, { force: true });
  const steps = [];
  for (const args of setup) steps.push({ args: args.join(" "), ...(await run(args)) });
  const list = await run(["plugin", "list"]);
  const result = await run([...session, ...extraArgs, "-p", "Reply OK."]);
  await new Promise((done) => setTimeout(done, 2000));
  return {
    steps,
    list: list.stdout,
    sessionStatus: result.status,
    files: walk(env.COPILOT_HOME)
      .filter((path) => path.includes(`${sep}installed-plugins${sep}`) || path.endsWith("postinstall-ran"))
      .map((path) => relative(env.COPILOT_HOME, path)),
    sourceMarker: existsSync(join(SOURCE, "postinstall-ran")),
    events: existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [],
  };
}

const version = (await run(["--version"])).stdout.split("\n")[0];
const evidence = {
  version,
  direct: await route("direct", [["plugin", "install", url]]),
  marketplace: await route("marketplace", [
    ["plugin", "marketplace", "add", marketUrl],
    ["plugin", "install", "hooknostic-installed-probe@hooknostic-probe-market"],
  ]),
  live: await route("live", [], ["--plugin-dir", SOURCE]),
};
server.close();
writeFileSync(join(ROOT, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));