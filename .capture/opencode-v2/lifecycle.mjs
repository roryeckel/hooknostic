import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function driveLifecycle({ executable, root, project, env, model }) {
  const server = spawn(executable, ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: project,
    env: { ...env, OPENCODE_SERVER_PASSWORD: "hooknostic-local", HOOKNOSTIC_PLAYBACK_EFFECTS: env.HKN_PROBE_EFFECT === "sessions-deny" ? "permission-deny" : env.HKN_PROBE_EFFECT === "stop" ? "prevent-stop-once,notify" : "context-add" },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  server.stdout.on("data", (chunk) => (stdout += chunk));
  server.stderr.on("data", (chunk) => (stderr += chunk));
  const done = new Promise((resolve) => server.on("exit", resolve));
  const records = async () =>
    (await readFile(join(root, "captured/events.jsonl"), "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
  const wait = async (predicate) => {
    for (let i = 0; i < 200; i++) {
      const value = await predicate();
      if (value) return value;
      await delay(100);
    }
    throw new Error("lifecycle probe timed out\n" + stdout + stderr);
  };
  try {
    const url = await wait(() => /http:\/\/127\.0\.0\.1:\d+/.exec(stdout + stderr)?.[0]);
    const api = async (path, body) => {
      const result = await fetch(url + "/api" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Basic " + Buffer.from("opencode:hooknostic-local").toString("base64"),
          "x-opencode-directory": encodeURIComponent(project),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
      });
      if (!result.ok) throw new Error(path + " " + result.status + " " + (await result.text()));
      return result.status === 204 ? undefined : result.json();
    };
    if (env.HKN_PROBE_EFFECT.startsWith("sessions")) {
      const { auditSessions } = await import("./session-audit.mjs");
      const outcomes = await auditSessions({ api, wait, records, model, project, denied: env.HKN_PROBE_EFFECT !== "sessions" });
      await writeFile(join(root, "sessions.json"), JSON.stringify({ outcomes, requests: model.requests, errors: model.errors }, null, 2));
      return;
    }
    if (env.HKN_PROBE_EFFECT === "stop") {
      const audit = await (await import("./stop-audit.mjs")).auditStops({ api, wait, records, model, project });
      await writeFile(join(root, "stops.json"), JSON.stringify({ ...audit, records: await records(), requests: model.requests, errors: model.errors }, null, 2));
      return;
    }
    if (env.HKN_PROBE_EFFECT.endsWith("-oauth")) {
      await (await import("./oauth-audit.mjs")).auditOAuth({ api, wait, records, model, project, root });
      return;
    }
    const sessions = [];
    for (let index = 0; index < 2; index++) {
      if (index) await api("/location/reload", {});
      const response = await api("/session", {
        location: { directory: project },
        model: { id: "hooknostic-playback", providerID: "playback" },
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      });
      const id = response.data.id;
      sessions.push(id);
      await api(`/session/${id}/prompt`, { text: "Use the shell, then stop." });
      await wait(async () =>
        (await records()).some(
          (row) =>
            row.hook === "event" && row.event.type === "session.execution.succeeded" && row.event.data.sessionID === id,
        ),
      );
    }
    const audits = {};
    for (const kind of ["generate", "compact"]) {
      const before = model.requests.length;
      try {
        const response = await api(
          `/session/${sessions[1]}/${kind}`,
          kind === "generate" ? { prompt: "Summarize the session." } : {},
        );
        if (kind === "compact") await wait(async () => (await records()).some((row) =>
          row.hook === "event" && ["session.compaction.ended", "session.compaction.failed"].includes(row.event.type)));
        audits[kind] = {
          response,
          requests: model.requests.length - before,
          contextRequests: model.requests
            .slice(before)
            .filter((request) => JSON.stringify(request).includes("hooknostic-context [model.request.before]")).length,
          compactContextRequests: model.requests.slice(before)
            .filter(request => JSON.stringify(request).includes("hooknostic-context [context.compact.before]")).length,
        };
      } catch (error) {
        audits[kind] = { error: String(error), requests: model.requests.length - before };
      }
    }
    await writeFile(
      join(root, "lifecycle.json"),
      JSON.stringify({ sessions, audits, records: await records(), requests: model.requests, urls: model.urls, errors: model.errors, stdout, stderr }, null, 2),
    );
    console.log(JSON.stringify({ lifecycle: "complete", sessions }));
  } finally {
    server.kill();
    await done;
  }
}
