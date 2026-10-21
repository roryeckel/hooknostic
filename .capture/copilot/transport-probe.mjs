// Remote MCP transport probe for the GitHub Copilot capture project.
//
// usage: node .capture/copilot/transport-probe.mjs [streamable-http|sse]
//
// Starts the loopback MCP transports in a child process, projects an Agent
// Plugins 1.0 plugin whose mcp.json points at them with placeholders in
// `headers`, and drives one `copilot -p` session per transport. Captures the
// hook payloads, the session output, and the headers the client actually sent.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEE = join(HERE, "tee.mjs");
const RUNNER = join(HERE, "mcp-transport-runner.mjs");
const CAPTURE_ROOT = join(HERE, "captured");

function resolveCopilotBinary() {
  if (process.env.COPILOT_BINARY !== undefined) return process.env.COPILOT_BINARY;
  const packageName = `@github/copilot-${process.platform}-${process.arch}`;
  const executable = process.platform === "win32" ? "copilot.exe" : "copilot";
  const roots = [];
  if (process.platform === "win32" && process.env.APPDATA !== undefined) {
    roots.push(join(process.env.APPDATA, "npm", "node_modules"));
  }
  for (const root of roots) {
    const candidate = join(root, "@github", "copilot", "node_modules", ...packageName.split("/"), executable);
    if (existsSync(candidate)) return candidate;
  }
  return process.platform === "win32" ? "copilot.cmd" : "copilot";
}

async function startRunner(logPath) {
  rmSync(logPath, { force: true });
  const child = spawn(process.execPath, [RUNNER, logPath], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolvePort, reject) => {
    let buffered = "";
    const timer = setTimeout(() => reject(new Error("transport runner did not start")), 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      const line = buffered.split("\n")[0];
      if (line === undefined || !line.startsWith("{")) return;
      clearTimeout(timer);
      resolvePort(JSON.parse(line).port);
    });
    child.on("exit", (code) => reject(new Error(`transport runner exited early (${code})`)));
  });
  return { child, port };
}

async function main() {
  const transports = process.argv[2] === undefined ? ["streamable-http", "sse"] : [process.argv[2]];
  for (const transport of transports) {
    const name = `mcp-${transport}`;
    const scratch = join(tmpdir(), "hooknostic-copilot-capture", name);
    rmSync(scratch, { recursive: true, force: true });
    const captured = join(CAPTURE_ROOT, name);
    rmSync(captured, { recursive: true, force: true });
    mkdirSync(captured, { recursive: true });
    mkdirSync(join(scratch, ".github", "hooks"), { recursive: true });
    mkdirSync(join(scratch, "plugin"), { recursive: true });
    mkdirSync(join(scratch, ".copilot-home"), { recursive: true });

    const logPath = join(captured, "requests.jsonl");
    const { child, port } = await startRunner(logPath);
    try {
      const tee = (label) => ({
        type: "command",
        exec: process.execPath,
        args: [TEE, captured, label, "", "0"],
      });
      writeFileSync(
        join(scratch, ".github", "hooks", "hooknostic.json"),
        `${JSON.stringify({ version: 1, hooks: { preToolUse: [tee("preToolUse")], postToolUse: [tee("postToolUse")] } }, null, 2)}\n`,
      );
      writeFileSync(
        join(scratch, "plugin", "plugin.json"),
        `${JSON.stringify(
          {
            $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
            name: "hooknostic-probe-plugin",
            version: "1.0.0",
          },
          null,
          2,
        )}\n`,
      );
      writeFileSync(
        join(scratch, "plugin", "mcp.json"),
        `${JSON.stringify(
          {
            $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
            mcpServers: {
              probe: {
                type: transport,
                url: `http://127.0.0.1:${port}/${transport === "sse" ? "sse" : "mcp"}`,
                headers: {
                  "X-Probe-Root": "${PLUGIN_ROOT}",
                  "X-Probe-Data": "${PLUGIN_DATA}",
                  "X-Probe-Ambient": "${USERPROFILE}",
                },
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      writeFileSync(join(scratch, "README.md"), "# copilot transport probe\n");
      execFileSync("git", ["init", "-q"], { cwd: scratch });
      execFileSync("git", ["add", "-A"], { cwd: scratch });
      execFileSync("git", ["-c", "user.email=capture@example.invalid", "-c", "user.name=capture", "commit", "-qm", "probe"], {
        cwd: scratch,
      });

      const result = spawnSync(
        resolveCopilotBinary(),
        [
          "--trust-folder",
          "--allow-all-tools",
          "--disable-client-telemetry",
          "--excluded-tools",
          "powershell",
          "view",
          "read_powershell",
          "list_powershell",
          "stop_powershell",
          "--plugin-dir",
          join(scratch, "plugin"),
          "-p",
          "Use the probe_echo MCP tool from the probe server once with message TRANSPORT-PROBE, quote its response " +
            "verbatim, then reply DONE. If the tool is missing, reply MCP-MISSING and stop immediately.",
        ],
        {
          cwd: scratch,
          env: { ...process.env, COPILOT_HOME: join(scratch, ".copilot-home") },
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          timeout: 120000,
        },
      );
      writeFileSync(join(scratch, "session.stdout.txt"), result.stdout ?? "");
      writeFileSync(join(scratch, "session.stderr.txt"), result.stderr ?? "");
      console.log(`${name}: exit=${result.status}`);
      console.log((result.stdout ?? "").trim().slice(-1600));
      console.log((result.stderr ?? "").trim().slice(-600));
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.on("exit", resolve));
      const requests = existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean) : [];
      console.log(`${name}: ${requests.length} request(s)`);
    }
  }
}

await main();
