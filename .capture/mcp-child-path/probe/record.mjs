// Records the environment this stdio child was spawned with, then behaves as a
// minimal MCP server so the harness completes its handshake rather than
// reporting a failed connection.
//
// The record is written before anything else: if the handshake is what fails,
// the measurement has already survived.
import { appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

// Deliberately not taken from a declared `env` value: what the harness puts in
// the child's environment is the thing being measured, so the recorder must not
// depend on having been given anything.
const OUT = process.env["PATH_RECORDER_OUT"] ?? join(tmpdir(), "hooknostic-path-recorder.jsonl");

/** PATH-only approximation: PATH order plus PATHEXT, without launcher-cwd precedence. */
function resolveOnPath(command, env) {
  const directories = (env["PATH"] ?? env["Path"] ?? "").split(delimiter).filter(Boolean);
  const suffixes =
    process.platform === "win32"
      ? ["", ...(env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
      : [""];
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = resolve(directory, command + suffix);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        // An unreadable PATH entry is not a resolution.
      }
    }
  }
  return null;
}

const path = process.env["PATH"] ?? process.env["Path"] ?? "";
const record = {
  at: new Date().toISOString(),
  label: process.env["PATH_RECORDER_LABEL"] ?? "unlabelled",
  cwd: process.cwd(),
  platform: process.platform,
  pathPresent: path.length > 0,
  pathEntryCount: path === "" ? 0 : path.split(delimiter).filter(Boolean).length,
  path,
  pathextPresent: process.env["PATHEXT"] !== undefined,
  // The question the runner-command strategy actually turns on: can the child
  // find the tools a non-Node server would be declared as?
  resolved: Object.fromEntries(
    ["node", "npx", "uvx", "uv", "docker", "python3", "python"].map((command) => [
      command,
      resolveOnPath(command, process.env),
    ]),
  ),
  // Placeholders the Agent Plugins contract may or may not bind.
  pluginRoot: process.env["PLUGIN_ROOT"] ?? null,
  pluginData: process.env["PLUGIN_DATA"] ?? null,
  syntheticMarker: process.env["SYNTHETIC_MARKER"] ?? null,
  envKeyCount: Object.keys(process.env).length,
};

appendFileSync(OUT, JSON.stringify(record) + "\n", "utf8");

// A minimal stdio MCP server: answer `initialize` and `tools/list`, ignore the
// rest. Nothing is written to stdout but JSON-RPC frames.
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line === "") continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined) continue;
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "path-recorder", version: "1.0.0" },
          }
        : message.method === "tools/list"
          ? { tools: [] }
          : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
  }
});
