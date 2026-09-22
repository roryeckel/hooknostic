import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { claudeHarness } from "../../packages/adapter-claude/src/harness.js";
import { AGENT_PLUGIN_MANIFEST_SCHEMA, AGENT_PLUGIN_MCP_SCHEMA } from "../../packages/agent-plugin/src/types.js";
import { runProcess } from "../../packages/cli/test/harness-playback.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");

// Writes one record per start next to itself, then answers the MCP handshake
// so `claude mcp list` reports the server connected.
const RECORDER = `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [label, ...argv] = process.argv.slice(2);
appendFileSync(new URL("./records.jsonl", import.meta.url), JSON.stringify({
  label, argv, cwd: process.cwd(),
  env: Object.fromEntries(["CAPTURE_ENV", "PLUGIN_ROOT", "CLAUDE_PROJECT_DIR"].map((name) => [name, process.env[name] ?? null])),
}) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  const result = message.method === "initialize"
    ? { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: {}, serverInfo: { name: "hooknostic-stdio-probe", version: "1.0.0" } }
    : message.method === "tools/list" ? { tools: [] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
});
`;

// Both the packaged server and the native controls carry these texts.
const REFERENCES = ["set=${HOOKNOSTIC_CAPTURE_SET}", "default=${HOOKNOSTIC_CAPTURE_UNSET:-fallback}"];

// A direct source is not governed by Agent Plugins: it is text the project
// wrote for the harness to resolve, so it should resolve as Claude resolves
// the same text in its own declaration.
const DIRECT_REFERENCES = [
  "set=${HOOKNOSTIC_CAPTURE_SET}",
  "default-set=${HOOKNOSTIC_CAPTURE_SET:-fallback}",
  "default-unset=${HOOKNOSTIC_CAPTURE_UNSET:-fallback}",
  "empty=${HOOKNOSTIC_CAPTURE_EMPTY}",
  "default-empty=${HOOKNOSTIC_CAPTURE_EMPTY:-fallback}",
  "default-blank=${HOOKNOSTIC_CAPTURE_UNSET:-}",
];

type ChildRecord = { argv: string[]; cwd: string | null; env: Record<string, string | null> };

async function synchronize(root: string, components: Record<string, unknown>): Promise<void> {
  const configPath = join(root, "hooknostic.config.ts");
  await writeFile(
    configPath,
    `export default ${JSON.stringify({
      project: { root: "." },
      components,
      targets: {
        claude: {
          version: claudeHarness.recommendedRange,
          delivery: "project",
          output: ".hooknostic/artifacts/claude",
        },
      },
    })};`,
  );
  const sync = await runProcess(process.execPath, [join(repo, "packages/cli/bin/hooknostic.mjs"), "sync", "--config", configPath, "--json"], {
    cwd: root,
    env: process.env,
    timeoutMs: 120_000,
  });
  expect(sync.code, sync.stdout + sync.stderr).toBe(0);
}

/** Approves `servers` in an isolated config, runs `claude mcp list`, and reads what each child recorded. */
async function listServers(root: string, servers: string[], recordFiles: string[], variables: Record<string, string>) {
  const configDir = join(root, "claude-config");
  await mkdir(configDir);
  await writeFile(
    join(configDir, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      projects: Object.fromEntries(
        [root, root.replaceAll("\\", "/")].map((key) => [key, { hasTrustDialogAccepted: true, enabledMcpjsonServers: servers }]),
      ),
    }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    ...variables,
  };
  for (const name of ["HOOKNOSTIC_CAPTURE_UNSET", "CLAUDE_PROJECT_DIR", "PLUGIN_ROOT", "PLUGIN_DATA"]) delete env[name];
  const listed = await runProcess("claude", ["mcp", "list"], { cwd: root, env, timeoutMs: 120_000 });
  const version = await runProcess("claude", ["--version"], { cwd: root, env });
  expect(listed.code, listed.stdout + listed.stderr).toBe(0);

  const records = (
    await Promise.all(recordFiles.map(async (path) => (existsSync(path) ? (await readFile(path, "utf8")).trim().split("\n") : [])))
  )
    .flat()
    .map((line) => JSON.parse(line) as ChildRecord & { label: string });
  const normalize = (value: string | null) =>
    value === null ? null : value.replaceAll(root, "<project>").replaceAll(root.replaceAll("\\", "/"), "<project>");
  const first = Object.fromEntries(
    servers.map((label): [string, ChildRecord | null] => {
      const record = records.find((item) => item.label === label);
      return [
        label,
        record === undefined
          ? null
          : {
              argv: record.argv,
              cwd: normalize(record.cwd),
              env: Object.fromEntries(Object.entries(record.env).map(([name, value]) => [name, normalize(value)])),
            },
      ];
    }),
  );
  const status = Object.fromEntries(
    servers.map((name) => [name, listed.stdout.split("\n").find((line) => line.startsWith(`${name}:`))?.trim() ?? null]),
  );
  const diagnostics = listed.stdout.split("\n").filter((line) => line.includes("[Warning]")).map((line) => line.trim());
  return { version: version.stdout.trim().split(" ")[0], records: first, status, diagnostics, normalize };
}

test("captures how Claude project MCP launches packaged and native stdio servers", async () => {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-claude-stdio-probe-"));
  try {
    const portable = join(root, "portable");
    await mkdir(portable, { recursive: true });
    await writeFile(join(portable, "recorder.mjs"), RECORDER);
    await writeFile(join(root, "recorder.mjs"), RECORDER);
    await writeFile(
      join(portable, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "stdio-probe" }),
    );
    await writeFile(
      join(portable, "mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: {
          packaged: {
            type: "stdio",
            command: "node",
            args: ["${PLUGIN_ROOT}/recorder.mjs", "packaged", ...REFERENCES],
            env: { CAPTURE_ENV: "${HOOKNOSTIC_CAPTURE_SET}" },
          },
        },
      }),
    );
    // Native controls written beside the projection: Claude's own reading of
    // the same text, and of the variable it sets for hooks.
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          nativeReferences: {
            command: "node",
            args: ["./recorder.mjs", "nativeReferences", ...REFERENCES],
            env: { CAPTURE_ENV: "${HOOKNOSTIC_CAPTURE_SET}" },
          },
          nativeProjectDir: {
            command: "node",
            args: ["${CLAUDE_PROJECT_DIR}/recorder.mjs", "nativeProjectDir"],
          },
        },
      }),
    );
    await synchronize(root, { root: "./portable", targets: ["claude"] });

    const servers = ["packaged", "nativeReferences", "nativeProjectDir"];
    const { version, records: first, status, diagnostics, normalize } = await listServers(
      root,
      servers,
      [join(portable, "records.jsonl"), join(root, "records.jsonl")],
      { HOOKNOSTIC_CAPTURE_SET: "expanded-value" },
    );
    const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
    const observations = {
      version,
      platform: process.platform,
      method: "live-probe",
      projected: mcp.mcpServers["packaged"],
      status,
      diagnostics,
      records: first,
    };
    console.log(JSON.stringify(observations, null, 2));
    await writeFile(join(here, "stdio-observations.json"), JSON.stringify(observations, null, 2) + "\n");

    // The projection shows Claude none of the package's text.
    expect(mcp.mcpServers["packaged"]).toEqual({ command: "node", args: ["./.hooknostic/artifacts/claude/mcp-launcher.mjs", "0"] });
    // The package's references reach the server literally.
    expect(first["packaged"]).toEqual({
      argv: REFERENCES,
      cwd: normalize(portable),
      env: { CAPTURE_ENV: "${HOOKNOSTIC_CAPTURE_SET}", PLUGIN_ROOT: normalize(portable), CLAUDE_PROJECT_DIR: "<project>" },
    });
    // Claude expands the same text when it reads it in its own declaration.
    expect(first["nativeReferences"]).toEqual({
      argv: ["set=expanded-value", "default=fallback"],
      cwd: "<project>",
      env: { CAPTURE_ENV: "expanded-value", PLUGIN_ROOT: null, CLAUDE_PROJECT_DIR: "<project>" },
    });
    // Claude sets CLAUDE_PROJECT_DIR for the child but does not expand it in
    // the declaration, so a project `.mcp.json` has no variable naming the
    // project or a package root.
    expect(diagnostics).toContainEqual(expect.stringContaining("Missing environment variables: CLAUDE_PROJECT_DIR"));
    expect(first["nativeProjectDir"]).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("captures a direct source's stdio references against Claude's native reading", async () => {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-claude-direct-probe-"));
  try {
    await writeFile(join(root, "recorder.mjs"), RECORDER);
    const direct = (label: string, args: string[]) => ({
      command: "node",
      args: ["./recorder.mjs", label, ...args],
      env: { CAPTURE_ENV: "${HOOKNOSTIC_CAPTURE_UNSET:-env-fallback}" },
    });
    await writeFile(
      join(root, "mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: {
          direct: { type: "stdio", ...direct("direct", DIRECT_REFERENCES) },
          directUnset: { type: "stdio", ...direct("directUnset", ["unset=${HOOKNOSTIC_CAPTURE_UNSET}"]) },
        },
      }),
    );
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          native: direct("native", DIRECT_REFERENCES),
          nativeUnset: direct("nativeUnset", ["unset=${HOOKNOSTIC_CAPTURE_UNSET}"]),
        },
      }),
    );
    await synchronize(root, { mcp: "./mcp.json" });

    const servers = ["direct", "native", "directUnset", "nativeUnset"];
    const { version, records, status, diagnostics } = await listServers(root, servers, [join(root, "records.jsonl")], {
      HOOKNOSTIC_CAPTURE_SET: "expanded-value",
      HOOKNOSTIC_CAPTURE_EMPTY: "",
    });
    const observations = { version, platform: process.platform, method: "live-probe", status, diagnostics, records };
    console.log(JSON.stringify(observations, null, 2));
    await writeFile(join(here, "direct-observations.json"), JSON.stringify(observations, null, 2) + "\n");

    // Every form Claude resolves resolves the same way through the launcher.
    // PLUGIN_ROOT is the launcher's own binding, which a native server lacks.
    expect(records["native"]).not.toBeNull();
    expect(records["direct"]?.argv).toEqual(records["native"]?.argv);
    expect(records["direct"]?.env["CAPTURE_ENV"]).toBe(records["native"]?.env["CAPTURE_ENV"]);
    // An unset name without a default: Claude starts the server with the text
    // literal, and the launcher refuses to start it (ADR-0015).
    expect(records["nativeUnset"]?.argv).toEqual(["unset=${HOOKNOSTIC_CAPTURE_UNSET}"]);
    expect(records["directUnset"]).toBeNull();
    expect(status["directUnset"]).toContain("Failed to connect");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
