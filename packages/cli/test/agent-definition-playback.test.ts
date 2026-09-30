import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { expectAgentScope } from "./agent-scope.js";
import { runProcess } from "./harness-playback.js";

// Model-free proof that what a build writes for an agent definition reaches the real
// harness (ADR-0029). The .capture/agents drive writes a portable Hooknostic
// Agent Definition, delivers it the way a user's build would, then makes the
// installed harness delegate to it against loopback playback models, routing
// the child's requests to their own script by a per-run nonce. Its README has
// the method and the provenance boundary.
//
// - `generated` synchronizes the definition through project delivery.
// - `packaged` configures it beside an Agent Plugins package and builds for
//   package delivery; the harness loads the built package. Codex has no
//   package route (openai/codex#18988), so its lanes run only `generated`.
// - `generated-primary` and `packaged-primary` do the same with a
//   `mode: primary` definition, and start the session as the agent. Codex has
//   no agent a session runs as, so its lanes run neither.
// - `generated-default` names that definition components.defaultAgent and starts
//   the session with no --agent. Every lane runs it: Codex emulates the default
//   through its project configuration.
const LANES: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  opencode: "opencode-v1",
  "opencode-v1": "opencode-v1",
  "opencode-v2": "opencode-v2",
};
const lane = LANES[process.env["HOOKNOSTIC_PLAYBACK"] ?? ""];
const repository = fileURLToPath(new URL("../../..", import.meta.url));

interface Summary {
  playbackErrors: string[];
  parent: { descriptionInRequest: boolean; childResultReturned: boolean; toolBearingRequests: number };
  child: { turns: { model?: string; tools: string[]; markerInSystem: boolean }[] };
  identity: string[];
}

async function drive(name: string): Promise<{ summary: Summary; output: string }> {
  const result = await runProcess(
    process.execPath,
    ["--experimental-strip-types", ".capture/agents/drive.mjs", lane!, "--only", name],
    { cwd: repository, env: process.env, timeoutMs: 240_000 },
  );
  const output = result.stdout + result.stderr;
  expect(result.code, output).toBe(0);
  const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith("HKN-SUMMARY "));
  expect(line, output).toBeDefined();
  return { summary: JSON.parse(line!.slice("HKN-SUMMARY ".length)) as Summary, output };
}

const ALT_MODEL = "hooknostic-playback-alt";
const CASES = (lane === "codex" ? ["generated"] : ["generated", "packaged"]).map((name) => ({
  name,
  // OpenCode v2's package route registers agents through its plugin agent API,
  // which cannot carry native fields; the child runs on the parent's model.
  model: name === "packaged" && lane === "opencode-v2" ? "hooknostic-playback" : ALT_MODEL,
}));

// How each lane names the agent a session runs as, and the model such a
// session uses: OpenCode v2 runs it on the configured model, which the drive's
// accepted opencode:primary-agent-model-ignored degradation reports.
const PRIMARY_CASES = (lane === "codex" ? [] : ["generated-primary", "packaged-primary"]).map((name) => {
  const packaged = name === "packaged-primary";
  const agent =
    lane === "claude"
      ? `PreToolUse:${packaged ? "hn-plugin:hn-probe" : "hn-probe"}`
      : lane === "opencode-v2"
        ? `execute.before:${packaged ? "hn-plugin-hn-probe" : "hn-probe"}`
        : `chat.message:${packaged ? "hn-plugin-hn-probe" : "hn-probe"}`;
  return { name, agent, model: lane === "opencode-v2" ? "hooknostic-playback" : ALT_MODEL };
});

// The default agent: named where the lane's harness names a session's agent,
// on the model each harness gives such a session -- OpenCode v2 its configured
// one, and the Codex lane its -c session override, which outranks the project
// configuration the default is written to.
const DEFAULT_CASE: { model: string; agent?: string } =
  lane === "claude"
    ? { model: ALT_MODEL, agent: "SessionStart:hn-probe" }
    : lane === "opencode-v2"
      ? { model: "hooknostic-playback", agent: "execute.before:hn-probe" }
      : lane === "codex"
        ? { model: "hooknostic-playback" }
        : { model: ALT_MODEL, agent: "chat.message:hn-probe" };

describe.skipIf(lane === undefined)(`agent definition playback (${lane ?? "off"})`, () => {
  it.each(CASES)(
    "$name: advertises the definition, delegates to it, and runs it on its instructions",
    async ({ name, model }) => {
      const { summary, output } = await drive(name);

      expect(summary.playbackErrors).toEqual([]);
      // The parent was told about the subagent: its description nonce reached
      // the parent's request, whichever channel the harness lists agents on.
      expect(summary.parent.descriptionInRequest).toBe(true);
      // Every child request carried the instructions nonce at system or
      // developer level, and ran on the native model where the route carries it.
      expect(summary.child.turns.length, output).toBeGreaterThan(0);
      for (const turn of summary.child.turns) {
        expect(turn.markerInSystem).toBe(true);
        expect(turn.model).toBe(model);
      }
      // native.claude.tools is the child's exact tool set.
      if (lane === "claude") expect(summary.child.turns[0]!.tools).toEqual(["Read", "Grep"]);
      expect(summary.parent.childResultReturned).toBe(true);
    },
    300_000,
  );

  it.each(PRIMARY_CASES)(
    "$name: runs the session as a primary definition, on its instructions",
    async ({ name, agent, model }) => {
      const { summary, output } = await drive(name);

      expect(summary.playbackErrors).toEqual([]);
      // Every request of the session carried the instructions nonce, so the
      // session ran as the agent, and none ran as the harness's default agent.
      expect(summary.child.turns.length, output).toBeGreaterThan(0);
      for (const turn of summary.child.turns) {
        expect(turn.markerInSystem).toBe(true);
        expect(turn.model).toBe(model);
      }
      expect(summary.parent.toolBearingRequests, output).toBe(0);
      if (lane === "claude") expect(summary.child.turns[0]!.tools).toEqual(["Read", "Grep"]);
      // The session's own events name the agent, as the harness reports it.
      expect(summary.identity).toContain(agent);
    },
    300_000,
  );

  it("generated-default: starts the session as the project's default agent, with no --agent", async () => {
    const { summary, output } = await drive("generated-default");

    expect(summary.playbackErrors).toEqual([]);
    expect(summary.child.turns.length, output).toBeGreaterThan(0);
    for (const turn of summary.child.turns) {
      expect(turn.markerInSystem).toBe(true);
      expect(turn.model).toBe(DEFAULT_CASE.model);
    }
    expect(summary.parent.toolBearingRequests, output).toBe(0);
    if (DEFAULT_CASE.agent === undefined) {
      // Codex only emulates the default through its configuration: the
      // session's hooks cannot tell it is the agent (ADR-0029, decision 10).
      expect(summary.identity.some((row) => row.endsWith(":hn-probe"))).toBe(false);
    } else expect(summary.identity).toContain(DEFAULT_CASE.agent);
  }, 300_000);

  it.skipIf(lane === "codex")(
    "scoped-primary: a hook scoped to the agent acts in a session running as it (ADR-0030)",
    () => expectAgentScope(lane!, "scoped-primary"),
    300_000,
  );

  // The harness-playback suite's agent-scope scenario covers the other lanes;
  // it has no OpenCode v2 adapter lane, so v2 runs the same check here.
  it.skipIf(lane !== "opencode-v2")(
    "scoped: a hook scoped to the subagent acts inside it and nowhere else (ADR-0030)",
    () => expectAgentScope("opencode-v2"),
    300_000,
  );
});
