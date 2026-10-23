import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runProject } from "@hooknostic/core";

import { defaultAdapterRegistry } from "../src/registry.js";
import { runProcess, startModelPlayback } from "./harness-playback.js";

// Real GitHub Copilot CLI playback for a synchronized custom agent (ADR-0034).
// The package lane already exercises Copilot's hooks, skills and MCP; this one
// proves the project route: `sync` writes `.github/agents/<id>.agent.md`, and
// `--agent <id>` runs the session on that definition against a loopback model.
// The negative control starts the same project with no `--agent`, where the
// definition's instruction marker must not reach a model request.
const copilotLane = process.env["HOOKNOSTIC_PLAYBACK"] === "copilot";
const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const marker = "HKN-COPILOT-AGENT-INSTRUCTIONS";
const definition = [
  "---",
  "name: probe",
  "description: Reports the instruction marker when selected.",
  "mode: primary",
  "native:",
  "  copilot:",
  '    tools: ["read"]',
  "---",
  `You are ${marker}. Reply DONE.`,
  "",
].join("\n");

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-copilot-agent-"));
  cleanup.push(root);
  await mkdir(join(root, "agents"), { recursive: true });
  await writeFile(join(root, "agents", "probe.md"), definition);
  await writeFile(
    join(root, "hooknostic.config.ts"),
    `export default ${JSON.stringify({
      project: { root: "." },
      components: { agents: ["./agents"] },
      targets: {
        copilot: {
          version: ">=1.0.101 <2",
          delivery: "project",
          output: ".hooknostic/artifacts/copilot",
        },
      },
    })};\n`,
  );
  return root;
}

async function selectedAgents(root: string): Promise<{ agentName?: string; tools?: string[] }[]> {
  const state = join(root, ".copilot-home", "session-state");
  const selected: { agentName?: string; tools?: string[] }[] = [];
  for (const session of await readdir(state).catch(() => [] as string[])) {
    const log = join(state, session, "events.jsonl");
    const text = await readFile(log, "utf8").catch(() => "");
    for (const line of text.split(/\r?\n/)) {
      if (line === "") continue;
      const event = JSON.parse(line) as { type?: string; data?: { agentName?: string; tools?: string[] } };
      if (event.type === "subagent.selected" && event.data !== undefined) selected.push(event.data);
    }
  }
  return selected;
}

async function drive(
  root: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string; requests: readonly unknown[]; errors: string[] }> {
  const server = await startModelPlayback("openai-chat", "rewrite", [{ kind: "text", text: "DONE" }]);
  try {
    const result = await runProcess(
      "copilot",
      [
        "--trust-folder",
        "--allow-all-tools",
        "--disable-client-telemetry",
        "--no-auto-update",
        ...args,
        "-p",
        "Say DONE.",
      ],
      {
        cwd: root,
        timeoutMs: 180_000,
        env: {
          ...process.env,
          COPILOT_HOME: join(root, ".copilot-home"),
          COPILOT_PROVIDER_BASE_URL: `${server.baseUrl}/v1`,
          COPILOT_PROVIDER_TYPE: "openai",
          COPILOT_PROVIDER_WIRE_API: "completions",
          COPILOT_PROVIDER_API_KEY: "hooknostic-playback",
          COPILOT_MODEL: "hooknostic-playback",
          COPILOT_PROVIDER_MODEL_ID: "gpt-5.4",
          COPILOT_PROVIDER_WIRE_MODEL: "hooknostic-playback",
          COPILOT_PROVIDER_MAX_PROMPT_TOKENS: "128000",
          COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: "8192",
        },
      },
    );
    return { ...result, requests: server.requests, errors: server.errors };
  } finally {
    await server.close();
  }
}

describe.skipIf(!copilotLane)("Copilot custom-agent playback", () => {
  it("runs a session as the synchronized agent and delivers its instructions", async () => {
    const root = await project();
    const synced = await runProject({
      configPath: join(root, "hooknostic.config.ts"),
      registry: defaultAdapterRegistry(),
      command: "sync",
    });
    expect(synced.errors).toEqual([]);
    expect(await readFile(join(root, ".github", "agents", "probe.agent.md"), "utf8")).toContain(marker);

    // The positive run selects the agent by its file-stem ID. The loopback's
    // scripted request log is the model-side record: the definition's body
    // must be in the selected agent's instructions, not merely in a file.
    const positive = await drive(root, ["--agent", "probe"]);
    expect(positive.code, `${positive.stdout}\n${positive.stderr}`).toBe(0);
    expect(positive.errors).toEqual([]);
    expect(JSON.stringify(positive.requests)).toContain(marker);
    expect(await selectedAgents(root)).toContainEqual(expect.objectContaining({ agentName: "probe", tools: ["read"] }));

    // Negative control: the same project, no --agent. Copilot may still list
    // the definition, but it must not run the session on it.
    const control = await drive(root, []);
    expect(control.code, `${control.stdout}\n${control.stderr}`).toBe(0);
    expect(control.errors).toEqual([]);
    expect(JSON.stringify(control.requests)).not.toContain(marker);
  }, 240_000);
});
