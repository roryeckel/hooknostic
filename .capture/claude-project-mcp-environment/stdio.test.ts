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
    const configPath = join(root, "hooknostic.config.ts");
    await writeFile(
      configPath,
      `export default ${JSON.stringify({
        project: { root: "." },
        components: { root: "./portable", targets: ["claude"] },
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

    const configDir = join(root, "claude-config");
    await mkdir(configDir);
    const servers = ["packaged", "nativeReferences", "nativeProjectDir"];
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
      HOOKNOSTIC_CAPTURE_SET: "expanded-value",
    };
    for (const name of ["HOOKNOSTIC_CAPTURE_UNSET", "CLAUDE_PROJECT_DIR", "PLUGIN_ROOT", "PLUGIN_DATA"]) delete env[name];
    const listed = await runProcess("claude", ["mcp", "list"], { cwd: root, env, timeoutMs: 120_000 });
    const version = await runProcess("claude", ["--version"], { cwd: root, env });
    expect(listed.code, listed.stdout + listed.stderr).toBe(0);

    const records = (
      await Promise.all(
        [join(portable, "records.jsonl"), join(root, "records.jsonl")].map(async (path) =>
          existsSync(path) ? (await readFile(path, "utf8")).trim().split("\n") : [],
        ),
      )
    )
      .flat()
      .map((line) => JSON.parse(line) as { label: string; argv: string[]; cwd: string; env: Record<string, string | null> });
    const normalize = (value: string | null) =>
      value === null ? null : value.replaceAll(root, "<project>").replaceAll(root.replaceAll("\\", "/"), "<project>");
    const first = Object.fromEntries(
      servers.map((label) => {
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
    const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
    const status = Object.fromEntries(
      servers.map((name) => [name, listed.stdout.split("\n").find((line) => line.startsWith(`${name}:`))?.trim() ?? null]),
    );
    const diagnostics = listed.stdout.split("\n").filter((line) => line.includes("[Warning]")).map((line) => line.trim());
    const observations = {
      version: version.stdout.trim().split(" ")[0],
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
