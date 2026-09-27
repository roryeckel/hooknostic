import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Two checkouts with generated project wiring, one nested inside the other as
// linked worktrees often are. Which copy serves a session in each?
export async function driveNested({ executable, root, project, env, build }) {
  const nested = join(project, ".claude", "worktrees", "nested");
  await build(project, "outer");
  await build(nested, "nested");
  const server = spawn(executable, ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: nested, env: { ...env, OPENCODE_SERVER_PASSWORD: "hooknostic-local" }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk) => (output += chunk));
  server.stderr.on("data", (chunk) => (output += chunk));
  const done = new Promise((resolve) => server.on("exit", resolve));
  const wait = async (predicate, label) => {
    for (let i = 0; i < 300; i++) {
      const value = await predicate();
      if (value) return value;
      await delay(100);
    }
    throw new Error(`nested probe timed out: ${label}\n${output}`);
  };
  const trace = async () => (await readFile(env.HOOKNOSTIC_PLAYBACK_TRACE, "utf8").catch(() => ""))
    .trim().split("\n").filter(Boolean).map(JSON.parse);
  try {
    const url = await wait(() => /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0], "server url");
    const api = async (path, body, directory) => {
      const response = await fetch(url + "/api" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", "x-opencode-directory": encodeURIComponent(directory),
          authorization: "Basic " + Buffer.from("opencode:hooknostic-local").toString("base64") },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`${path} ${response.status} ${await response.text()}`);
      return response.json();
    };
    const result = {};
    for (const [name, directory] of [["nested", nested], ["outer", project]]) {
      const before = (await trace()).length;
      const { data: { id } } = await api("/session", { location: { directory }, model: { id: "hooknostic-playback", providerID: "playback" },
        permissions: [{ action: "*", resource: "*", effect: "allow" }] }, directory);
      await api(`/session/${id}/prompt`, { text: "Run the shell probe once, then stop." }, directory);
      await wait(async () => (await trace()).slice(before).some((row) => row.event === "turn.stop"), `${name} turn.stop`);
      await delay(1000);
      result[name] = {
        plugins: (await api("/plugin", undefined, directory)).data.filter((p) => p.id.startsWith("hooknostic.harness-playback"))
          .map((p) => ({ id: p.id, path: p.source?.path, status: p.state?.status, error: p.state?.error })),
        dispatches: (await trace()).slice(before).map((row) => `${row.label}:${row.event}`),
      };
    }
    await writeFile(join(root, "nested.json"), JSON.stringify(result, null, 2));
  } finally {
    server.kill();
    await done;
  }
}
