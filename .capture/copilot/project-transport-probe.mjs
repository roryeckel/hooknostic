// Project-level remote MCP probe for the GitHub Copilot capture project.
//
// usage: node .capture/copilot/project-transport-probe.mjs [http|sse]
//
// Runs the same loopback MCP transports as transport-probe.mjs, but declares
// them in the workspace `.mcp.json` instead of an installed plugin. Records
// whether the client reaches the server and which placeholders it expands in
// the declaration's URL query and headers.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEE = join(HERE, "tee.mjs");
const RUNNER = join(HERE, "mcp-transport-runner.mjs");
const CAPTURE_ROOT = join(HERE, "captured");

function resolveCopilotBinary() {
  if (process.env.COPILOT_BINARY !== undefined) return process.env.COPILOT_BINARY;
  const packageName = `@github/copilot-${process.platform}-${process.arch}`;
  const executable = process.platform === "win32" ? "copilot.exe" : "copilot";
  const root = join(process.env.APPDATA ?? "", "npm", "node_modules");
  const candidate = join(root, "@github", "copilot", "node_modules", ...packageName.split("/"), executable);
  return existsSync(candidate) ? candidate : process.platform === "win32" ? "copilot.cmd" : "copilot";
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
  const transport = process.argv[2] ?? "http";
  const name = `project-mcp-${transport}`;
  const scratch = join(tmpdir(), "hooknostic-copilot-capture", name);
  rmSync(scratch, { recursive: true, force: true });
  const captured = join(CAPTURE_ROOT, name);
  rmSync(captured, { recursive: true, force: true });
  mkdirSync(captured, { recursive: true });
  mkdirSync(join(scratch, ".github", "hooks"), { recursive: true });
  mkdirSync(join(scratch, ".copilot-home"), { recursive: true });

  const logPath = join(captured, "requests.jsonl");
  const { child, port } = await startRunner(logPath);
  try {
    const tee = (label) => ({ type: "command", exec: process.execPath, args: [TEE, captured, label, "", "0"] });
    writeFileSync(
      join(scratch, ".github", "hooks", "hooknostic.json"),
      `${JSON.stringify({ version: 1, hooks: { preToolUse: [tee("preToolUse")], postToolUse: [tee("postToolUse")] } }, null, 2)}\n`,
    );
    writeFileSync(
      join(scratch, ".mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            probe: {
              type: transport,
              url: `http://127.0.0.1:${port}/${transport === "sse" ? "sse" : "mcp"}?probe=\${USERPROFILE}&fallback=\${HOOKNOSTIC_PROBE_MISSING:-fallback-url}`,
              headers: {
                "X-Probe-Root": "${PLUGIN_ROOT}",
                "X-Probe-Ambient": "${USERPROFILE}",
                "X-Probe-Fallback": "${HOOKNOSTIC_PROBE_MISSING:-fallback-header}",
                "X-Probe-SetFallback": "${HOOKNOSTIC_PROBE_SET:-fallback-header}",
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(scratch, "README.md"), "# copilot project transport probe\n");
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
        "-p",
        "Use the probe_echo MCP tool from the probe server once with message PROJECT-TRANSPORT-PROBE, quote its " +
          "response verbatim, then reply DONE. If the tool is missing, reply MCP-MISSING and stop immediately.",
      ],
      {
        cwd: scratch,
        env: { ...process.env, HOOKNOSTIC_PROBE_SET: "set-value", COPILOT_HOME: join(scratch, ".copilot-home") },
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

await main();
