import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runProcess } from "./harness-playback.js";

// Model-free proof that what a build writes for a subagent reaches the real
// harness (ADR-0027). The .capture/agents drive writes a portable Hooknostic
// Subagent Definition, delivers it the way a user's build would, then makes the
// installed harness delegate to it against loopback playback models, routing
// the child's requests to their own script by a per-run nonce. Its README has
// the method and the provenance boundary.
//
// - `generated` synchronizes the definition through project delivery.
// - `packaged` configures it beside an Agent Plugins package and builds for
//   package delivery; the harness loads the built package. Codex has no
//   package route (openai/codex#18988), so its lanes run only `generated`.
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
  parent: { descriptionInRequest: boolean; childResultReturned: boolean };
  child: { turns: { model?: string; tools: string[]; markerInSystem: boolean }[] };
}

const ALT_MODEL = "hooknostic-playback-alt";
const CASES = (lane === "codex" ? ["generated"] : ["generated", "packaged"]).map((name) => ({
  name,
  // OpenCode v2's package route registers agents through its plugin agent API,
  // which cannot carry native fields; the child runs on the parent's model.
  model: name === "packaged" && lane === "opencode-v2" ? "hooknostic-playback" : ALT_MODEL,
}));

describe.skipIf(lane === undefined)(`subagent playback (${lane ?? "off"})`, () => {
  it.each(CASES)(
    "$name: advertises the definition, delegates to it, and runs it on its instructions",
    async ({ name, model }) => {
      const result = await runProcess(
        process.execPath,
        ["--experimental-strip-types", ".capture/agents/drive.mjs", lane!, "--only", name],
        { cwd: repository, env: process.env, timeoutMs: 240_000 },
      );
      const output = result.stdout + result.stderr;
      expect(result.code, output).toBe(0);
      const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith("HKN-SUMMARY "));
      expect(line, output).toBeDefined();
      const summary = JSON.parse(line!.slice("HKN-SUMMARY ".length)) as Summary;

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
});
