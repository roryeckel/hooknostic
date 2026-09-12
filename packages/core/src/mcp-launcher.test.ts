import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyStdioCwd, expandStdioServer } from "@hooknostic/agent-plugin";
import { afterEach, describe, expect, it } from "vitest";
import {
  MCP_SERVERS_FILE,
  bundleMcpLauncher,
  type McpLauncherServer,
} from "./mcp-launcher.js";

// Node resolves homedir() from USERPROFILE on Windows and HOME elsewhere, so
// stubbing both keeps every case out of the real ~/.hooknostic.
const home = (path: string) => ({ USERPROFILE: path, HOME: path });

const PROBE = [
  "const fs = require('node:fs');",
  "let wrote = null;",
  "try {",
  "  fs.writeFileSync(require('node:path').join(process.env.PLUGIN_DATA, 'probe.txt'), 'ok');",
  "  wrote = 'ok';",
  "} catch (error) { wrote = error.code; }",
  "console.log(JSON.stringify({",
  "  cwd: process.cwd(),",
  "  pluginRoot: process.env.PLUGIN_ROOT,",
  "  pluginData: process.env.PLUGIN_DATA,",
  "  declared: process.env.DECLARED,",
  // Read through the descriptor: `process.env.__proto__` on an ordinary
  // object would answer with the prototype rather than the variable.
  "  proto: (Object.getOwnPropertyDescriptor(process.env, '__proto__') || {}).value ?? null,",
  // With -e there is no script path, so the first declared argument is argv[1].
  "  args: process.argv.slice(1),",
  "  wrote,",
  "}));",
].join("\n");

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Layout {
  root: string;
  launcher: string;
  homeDir: string;
}

/**
 * A plugin tree shaped the way an installed Codex plugin is: a version-scoped
 * root with the launcher one level down, so `rootOffset` has to climb.
 */
async function layout(
  servers: McpLauncherServer[],
  options: { pluginName?: string; version?: string; document?: string; environmentReferences?: boolean } = {},
): Promise<Layout> {
  const dir = await mkdtemp(join(tmpdir(), "hooknostic-launcher-"));
  dirs.push(dir);
  const root = join(dir, "cache", "pkg", options.version ?? "1.0.0");
  const runtime = join(root, "runtime");
  await mkdir(runtime, { recursive: true });
  const homeDir = join(dir, "home");
  await mkdir(homeDir);
  const launcher = join(runtime, "mcp-launcher.mjs");
  await writeFile(
    launcher,
    await bundleMcpLauncher({
      frontEnd: "self-resolving",
      rootOffset: "..",
      pluginName: options.pluginName ?? "portable-tools",
      ...(options.environmentReferences === undefined ? {} : { environmentReferences: options.environmentReferences }),
    }),
  );
  await writeFile(
    join(runtime, MCP_SERVERS_FILE),
    options.document ?? JSON.stringify({ plugin: options.pluginName ?? "portable-tools", servers }),
  );
  return { root, launcher, homeDir };
}

function launch(
  { launcher, homeDir }: Layout,
  index: string | number,
  env: Record<string, string> = {},
) {
  return spawnSync(process.execPath, [launcher, String(index)], {
    // A directory that is neither the plugin root nor any declared cwd, so a
    // launcher that simply inherited its own would be visible.
    cwd: tmpdir(),
    env: { ...process.env, ...home(homeDir), PLUGIN_ROOT: "", PLUGIN_DATA: "", ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
}

const probeServer = (extra: Partial<McpLauncherServer> = {}): McpLauncherServer => ({
  name: "probe",
  command: process.execPath,
  args: ["-e", PROBE],
  ...extra,
});

describe("generated MCP launcher", () => {
  it("binds both variables absolutely and anchors the root above itself", async () => {
    const tree = await layout([probeServer()]);
    const result = launch(tree, 0);
    expect(result.status, result.stderr).toBe(0);
    const observed = JSON.parse(result.stdout);
    expect(observed.pluginRoot).toBe(tree.root);
    expect(observed.pluginData).toBe(join(tree.homeDir, ".hooknostic", "plugin-data", "portable-tools"));
    // An omitted cwd means the plugin root, which the specification states
    // rather than leaving to the client.
    expect(observed.cwd).toBe(tree.root);
  });

  it("creates PLUGIN_DATA before the server starts and leaves it writable", async () => {
    const tree = await layout([probeServer()]);
    const result = launch(tree, 0);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).wrote).toBe("ok");
  });

  it("keeps PLUGIN_DATA stable across a version-scoped reinstall", async () => {
    const first = await layout([probeServer()], { version: "1.0.0" });
    const second = await layout([probeServer()], { version: "1.0.1" });
    const shared = home(first.homeDir);
    const one = launch(first, 0, shared);
    const two = launch({ ...second, homeDir: first.homeDir }, 0, shared);
    expect(one.status, one.stderr).toBe(0);
    expect(two.status, two.stderr).toBe(0);
    expect(JSON.parse(one.stdout).pluginRoot).not.toBe(JSON.parse(two.stdout).pluginRoot);
    // The install root carries a version segment, so anything derived from it
    // would be discarded by an upgrade.
    expect(JSON.parse(one.stdout).pluginData).toBe(JSON.parse(two.stdout).pluginData);
  });

  it("names the data directory after the plugin, under one home location", async () => {
    const tree = await layout([probeServer()], { pluginName: "other-plugin" });
    const result = launch(tree, 0);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).pluginData).toBe(
      join(tree.homeDir, ".hooknostic", "plugin-data", "other-plugin"),
    );
  });

  it("resolves a plugin-relative command against the root, not against cwd", async () => {
    // The specification resolves a plugin-relative command "against the plugin
    // root". Resolving it against cwd instead looks under <root>/worker/bin,
    // where nothing is installed, so this only runs if the root won.
    const windows = process.platform === "win32";
    const executable = windows ? "serve.cmd" : "serve";
    const tree = await layout([
      { name: "probe", command: `./bin/${executable}`, cwd: "${PLUGIN_ROOT}/worker" },
    ]);
    await mkdir(join(tree.root, "worker"), { recursive: true });
    await mkdir(join(tree.root, "bin"), { recursive: true });
    await writeFile(
      join(tree.root, "bin", executable),
      windows ? "@echo off\r\necho %CD%\r\n" : "#!/bin/sh\npwd\n",
      { mode: 0o755 },
    );
    const result = launch(tree, 0);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(join(tree.root, "worker"));
  });

  it("creates a working directory inside PLUGIN_DATA and nowhere else", async () => {
    const tree = await layout([probeServer({ cwd: "${PLUGIN_DATA}/state" })]);
    const result = launch(tree, 0);
    expect(result.status, result.stderr).toBe(0);
    const observed = JSON.parse(result.stdout);
    expect(observed.cwd).toBe(join(observed.pluginData, "state"));

    // A package-relative cwd is never created: doing so would mask a directory
    // the package failed to ship.
    const missing = await layout([probeServer({ cwd: "./absent" })]);
    const failed = launch(missing, 0);
    expect(failed.status).not.toBe(0);
    expect(existsSync(join(missing.root, "absent"))).toBe(false);
  });

  it("expands exactly the fields the specification expands", async () => {
    const tree = await layout([
      probeServer({
        args: [
          "-e",
          PROBE,
          "${PLUGIN_ROOT}/a",
          "x${PLUGIN_ROOT}y${PLUGIN_ROOT}z",
          "${PLUGIN_DATA}/d",
          "${TOKEN}",
          "${PLUGIN_ROOT",
        ],
        env: { DECLARED: "${PLUGIN_ROOT}/env", "${PLUGIN_ROOT}": "key-is-literal" },
      }),
    ]);
    const result = launch(tree, 0);
    expect(result.status, result.stderr).toBe(0);
    const observed = JSON.parse(result.stdout);
    const data = join(tree.homeDir, ".hooknostic", "plugin-data", "portable-tools");
    expect(observed.args).toEqual([
      // Substitution is textual, so the separator the package wrote survives.
      `${tree.root}/a`,
      `x${tree.root}y${tree.root}z`,
      `${data}/d`,
      // Unrecognized placeholder-like text MUST remain literal, and an
      // unterminated one is not a placeholder at all.
      "${TOKEN}",
      "${PLUGIN_ROOT",
    ]);
    expect(observed.declared).toBe(`${tree.root}/env`);
  });

  it("resolves direct project environment references only when requested", async () => {
    const direct = await layout([
      probeServer({ args: ["-e", PROBE, "prefix-${HOOKNOSTIC_PROJECT_TOKEN}"], env: { DECLARED: "${HOOKNOSTIC_PROJECT_TOKEN}" } }),
    ], { environmentReferences: true });
    const resolved = launch(direct, 0, { HOOKNOSTIC_PROJECT_TOKEN: "runtime-value" });
    expect(resolved.status, resolved.stderr).toBe(0);
    expect(JSON.parse(resolved.stdout)).toMatchObject({ declared: "runtime-value", args: ["prefix-runtime-value"] });

    const missing = launch(direct, 0);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("environment variable HOOKNOSTIC_PROJECT_TOKEN is required");

    const packaged = await layout([
      probeServer({ env: { DECLARED: "${HOOKNOSTIC_PROJECT_TOKEN}" } }),
    ]);
    const literal = launch(packaged, 0, { HOOKNOSTIC_PROJECT_TOKEN: "must-not-expand" });
    expect(literal.status, literal.stderr).toBe(0);
    expect(JSON.parse(literal.stdout).declared).toBe("${HOOKNOSTIC_PROJECT_TOKEN}");
  });

  it("agrees with the TypeScript placeholder oracle", async () => {
    const cases: { cwd?: string; args: string[] }[] = [
      { args: ["${PLUGIN_ROOT}/a", "x${PLUGIN_ROOT}y${PLUGIN_ROOT}z", "${TOKEN}"] },
      { cwd: "./worker/./", args: ["${PLUGIN_ROOT}/a"] },
      { cwd: "${PLUGIN_ROOT}/worker/..", args: [] },
      { cwd: "${PLUGIN_ROOT}", args: [] },
    ];
    for (const item of cases) {
      const tree = await layout([
        probeServer({ args: ["-e", PROBE, ...item.args], ...(item.cwd === undefined ? {} : { cwd: item.cwd }) }),
      ]);
      for (const segment of ["worker"]) await mkdir(join(tree.root, segment), { recursive: true });
      const result = launch(tree, 0);
      expect(result.status, result.stderr).toBe(0);
      const observed = JSON.parse(result.stdout);

      const oracle = expandStdioServer(
        { type: "stdio", command: "node", args: item.args },
        tree.root,
      );
      expect(observed.args).toEqual(oracle.args ?? []);
      const classified = classifyStdioCwd(item.cwd)!;
      expect(observed.cwd).toBe(
        classified.relative === "." ? tree.root : join(tree.root, classified.relative),
      );
    }
  });

  // The schema puts no pattern on an env key, and JSON.parse gives `__proto__`
  // as an own property -- but assigning it into an ordinary object reaches the
  // inherited setter, and the variable would vanish with no diagnostic.
  it("passes through an environment variable named __proto__", async () => {
    // Built by JSON.parse, because an object literal's `__proto__:` sets the
    // prototype and never creates the key -- the same trap on the way in.
    const env = JSON.parse('{"__proto__":"survived","DECLARED":"also-survived"}') as Record<
      string,
      string
    >;
    const tree = await layout([probeServer({ env })]);
    const result = launch(tree, 0);
    expect(result.status, result.stderr).toBe(0);
    const observed = JSON.parse(result.stdout);
    expect(observed.proto).toBe("survived");
    expect(observed.declared).toBe("also-survived");
  });

  it("defers to a client that already implements the contract", async () => {
    const tree = await layout([probeServer()]);
    const clientData = join(tree.homeDir, "client-managed");
    await mkdir(clientData, { recursive: true });
    const result = launch(tree, 0, { PLUGIN_ROOT: tree.root, PLUGIN_DATA: clientData });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).pluginData).toBe(clientData);
    // Nothing is re-derived, so the harness's own directory is untouched.
    expect(existsSync(join(tree.homeDir, ".hooknostic"))).toBe(false);
  });

  it.each([
    [
      "an unrelated PLUGIN_ROOT",
      () => ({ PLUGIN_ROOT: tmpdir(), PLUGIN_DATA: join(tmpdir(), "elsewhere") }),
    ],
    [
      "PLUGIN_DATA with no PLUGIN_ROOT",
      () => ({ PLUGIN_ROOT: "", PLUGIN_DATA: join(tmpdir(), "elsewhere") }),
    ],
    ["an empty PLUGIN_DATA", (root: string) => ({ PLUGIN_ROOT: root, PLUGIN_DATA: "" })],
    ["a relative PLUGIN_DATA", (root: string) => ({ PLUGIN_ROOT: root, PLUGIN_DATA: "relative/state" })],
  ])("does not defer on %s", async (_label, env) => {
    const tree = await layout([probeServer()]);
    const result = launch(tree, 0, env(tree.root));
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).pluginData).toBe(
      join(tree.homeDir, ".hooknostic", "plugin-data", "portable-tools"),
    );
  });

  it.each([
    ["absent", { document: "" }, "could not read"],
    ["not JSON", { document: "{" }, "could not read"],
    ["without a servers array", { document: '{"plugin":"p"}' }, "declares no servers array"],
  ])("reports a %s servers document", async (_label, options, message) => {
    const tree = await layout([probeServer()], options);
    if (options.document === "") await rm(join(tree.root, "runtime", MCP_SERVERS_FILE));
    const result = launch(tree, 0);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it.each([
    ["out of range", 4, "no server at index"],
    ["not a number", "x", "no server at index"],
  ])("reports an index %s", async (_label, index, message) => {
    const tree = await layout([probeServer()]);
    const result = launch(tree, index);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it("reports an entry declaring no command", async () => {
    const tree = await layout([], {
      document: JSON.stringify({ plugin: "p", servers: [{ name: "broken" }] }),
    });
    const result = launch(tree, 0);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("declares no command");
  });
});
