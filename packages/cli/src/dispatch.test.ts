import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { claudeHarness } from "@hooknostic/adapter-claude";
import { CODEX_PLUGIN_MODE_RANGE, codexHarness } from "@hooknostic/adapter-codex";
import { opencodeHarness } from "@hooknostic/adapter-opencode";

import { runCli } from "./cli.js";
import type { DispatchResult } from "./dispatch.js";
import { DISPATCH_NATIVE_EVENT, dispatchEvents } from "./dispatch.js";
import { defaultAdapterRegistry } from "./registry.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SDK_PATH = resolve(HERE, "../../sdk/src/index.ts");
const EVALUATE = { alias: { "@hooknostic/sdk": SDK_PATH } };
const CLI_BIN = resolve(HERE, "../bin/hooknostic.mjs");

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const TARGETS = `{
  claude: { version: ${JSON.stringify(claudeHarness.recommendedRange)}, delivery: "package", output: "./dist/claude" },
  codex: { version: ${JSON.stringify(codexHarness.recommendedRange)}, delivery: "project", output: "./dist/codex" },
  opencode: {
    version: ${JSON.stringify(opencodeHarness.recommendedRange)},
    delivery: "project",
    output: "./dist/opencode",
    compatibility: { minimum: "approximate" },
  },
}`;

const HOOKS = `
import { addContext, block, definePlugin, hook, notify, preventStop } from "@hooknostic/sdk";

// Survives between dispatches only where the harness keeps one module instance.
let stops = 0;

export default definePlugin({
  name: "dispatch-fixture",
  hooks: [
    hook("tool.before", {
      id: "guard",
      match: { kind: "shell" },
      capabilities: { "tool.before.block": "required" },
      run(event) {
        const command = event.tool.shell?.command;
        if (command !== undefined && command.includes("rm -rf /")) return block("no: " + command);
      },
    }),
    hook("tool.before", {
      id: "mcp-guard",
      match: { kind: "mcp" },
      capabilities: { "tool.before.block": "required" },
      run(event) {
        return block("mcp " + event.tool.mcp?.server + "/" + event.tool.mcp?.tool);
      },
    }),
    hook("prompt.before", {
      id: "echo",
      capabilities: { "prompt.before.context.add": "optional" },
      run(event, ctx) {
        if (!ctx.capabilities.has("prompt.before.context.add")) return;
        return addContext(
          JSON.stringify({ nativeEvent: event.harness.nativeEvent, cwd: event.session.cwd, raw: event.raw }),
        );
      },
    }),
    hook("turn.stop", {
      id: "notice",
      capabilities: { "turn.stop.notify": "optional" },
      run(_event, ctx) {
        stops += 1;
        if (ctx.capabilities.has("turn.stop.notify")) return notify("stop " + stops);
      },
    }),
    hook("turn.stop", {
      id: "keep-working",
      capabilities: { "turn.stop.prevent": "required" },
      run(event) {
        if (event.session.id === "unfinished") return preventStop("tests are not run");
      },
    }),
  ],
});
`;

async function project(hooks: string, targets = TARGETS, extra = ""): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hooknostic-dispatch-"));
  tempDirs.push(dir);
  await writeFile(join(dir, "hooks.ts"), hooks);
  await writeFile(
    join(dir, "hooknostic.config.ts"),
    `export default { entry: "./hooks.ts", ${extra} targets: ${targets} };`,
  );
  return dir;
}

async function dispatched(dir: string, target: string, events: unknown[]): Promise<DispatchResult[]> {
  const outcome = await dispatchEvents({
    config: join(dir, "hooknostic.config.ts"),
    target,
    events,
    registry: defaultAdapterRegistry(),
    evaluate: EVALUATE,
  });
  if (!outcome.ok) throw new Error(outcome.errors.join("\n"));
  return outcome.results;
}

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) },
    out,
    err: () => err.join("\n"),
  };
}

const toolBefore = (nativeName: string, input: Record<string, unknown>) => ({
  event: "tool.before",
  session: { id: "s" },
  tool: { nativeName, input },
});

describe("hooknostic dispatch", () => {
  it("classifies the tool as the target's decoder would and answers in its native reply", async () => {
    const dir = await project(HOOKS);

    const [denied, allowed, write, mcp] = await dispatched(dir, "claude", [
      toolBefore("Bash", { command: "rm -rf /" }),
      toolBefore("Bash", { command: "ls" }),
      // Claude classifies Write as a file write, whatever its input holds.
      toolBefore("Write", { command: "rm -rf /" }),
      toolBefore("mcp__gitea__issue_write", {}),
    ]);
    expect(denied!.effects).toEqual([{ hookId: "guard", effect: { kind: "block", reason: "no: rm -rf /" } }]);
    expect(denied!.terminatedBy).toBe("guard");
    expect(denied!.native.body).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "no: rm -rf /",
      },
    });
    expect(allowed!.effects).toEqual([]);
    expect(write!.effects).toEqual([]);
    expect(mcp!.effects).toEqual([{ hookId: "mcp-guard", effect: { kind: "block", reason: "mcp gitea/issue_write" } }]);

    // Codex's exec_command carries its command under `cmd`; only the classifier knows that.
    const [codex] = await dispatched(dir, "codex", [toolBefore("exec_command", { cmd: "rm -rf /", workdir: "." })]);
    expect(codex!.terminatedBy).toBe("guard");

    const [opencode] = await dispatched(dir, "opencode", [toolBefore("bash", { command: "rm -rf /" })]);
    expect(opencode!.native.body).toEqual({ throwMessage: "no: rm -rf /" });
  });

  it("resolves capabilities and module lifetime from the target", async () => {
    const dir = await project(HOOKS);
    const stops = [
      { event: "turn.stop", session: { id: "done" } },
      { event: "turn.stop", session: { id: "unfinished" } },
    ];

    // A command harness runs every dispatch in a fresh process.
    const claude = await dispatched(dir, "claude", stops);
    expect(claude.map((result) => result.native.body)).toEqual([
      { systemMessage: "stop 1" },
      { systemMessage: "stop 1", decision: "block", reason: "tests are not run" },
    ]);

    // Codex cannot render a stop notice, so the optional capability is unavailable.
    const codex = await dispatched(dir, "codex", stops);
    expect(codex.map((result) => result.effects.map((applied) => applied.effect.kind))).toEqual([[], ["preventStop"]]);
    expect(codex[1]!.native.body).toEqual({ decision: "block", reason: "tests are not run" });

    // OpenCode keeps one plugin instance, and posts both effects into the session.
    const opencode = await dispatched(dir, "opencode", stops);
    expect(opencode.map((result) => result.native.body)).toEqual([
      { prompts: [{ text: "stop 1", reply: false }] },
      {
        prompts: [
          { text: "stop 2", reply: false },
          { text: "tests are not run", reply: true },
        ],
      },
    ]);
  });

  it("completes the envelope as a decoder would, marking the event as synthetic", async () => {
    const dir = await project(HOOKS);
    const [defaulted, explicit] = await dispatched(dir, "claude", [
      { event: "prompt.before", prompt: "hi" },
      {
        event: "prompt.before",
        prompt: "hi",
        harness: { nativeEvent: "UserPromptSubmit" },
        session: { cwd: dir },
        raw: { prompt_id: "p" },
      },
    ]);
    const echoed = (result: DispatchResult) =>
      JSON.parse((result.effects[0]!.effect as { context: string }).context) as Record<string, unknown>;
    expect(echoed(defaulted!)).toEqual({ nativeEvent: DISPATCH_NATIVE_EVENT, cwd: process.cwd(), raw: null });
    expect(echoed(explicit!)).toEqual({ nativeEvent: "UserPromptSubmit", cwd: dir, raw: { prompt_id: "p" } });
  });

  it("rejects an event no harness could send, before running any hook", async () => {
    const dir = await project(HOOKS);
    const events = join(dir, "events.jsonl");
    await writeFile(
      events,
      [
        JSON.stringify({
          event: "tool.before",
          tool: { nativeName: "Bash", input: { command: "ls" }, kind: "shell", shell: { command: "ls" } },
        }),
        JSON.stringify({ event: "tool.before" }),
        JSON.stringify({ event: "turn.stop", harness: { id: "codex" } }),
        JSON.stringify({ event: "turn.stop", tool: toolBefore("Bash", { command: "ls" }).tool }),
        JSON.stringify({ event: "no.such.event" }),
        JSON.stringify({ event: "prompt.before" }),
        JSON.stringify({ event: "agent.start" }),
        JSON.stringify({ event: "turn.stop", lastmessage: "done" }),
        JSON.stringify({ event: "tool.before", tool: { nativeName: "Bash", input: { command: "ls" }, cwd: "." } }),
      ].join("\n") + "\n",
    );
    const cli = captureIO();
    const argv = ["dispatch", "--config", join(dir, "hooknostic.config.ts"), "--target", "claude", "--events", events];
    expect(await runCli(argv, { io: cli.io })).toBe(2);
    expect(cli.out).toEqual([]);
    expect(cli.err().split("\n")).toEqual([
      "event 1: tool.kind and tool.shell are derived from tool.nativeName and tool.input by the target's classifier; omit them",
      "event 2: tool.before needs a tool",
      'event 3: harness.id "codex" is not this target\'s adapter, "claude"',
      "event 4: turn.stop is not tool-scoped, so it takes no tool",
      expect.stringMatching(/^event 5: event: /),
      "event 6: prompt must be a string",
      "event 7: agent must be an object with optional string id and type",
      'event 8: turn.stop has no field "lastmessage"',
      'event 9: tool has no field "cwd"',
    ]);

    await writeFile(events, `${JSON.stringify({ event: "turn.stop" })}\n\n{nope\n`);
    const broken = captureIO();
    expect(await runCli(argv, { io: broken.io })).toBe(2);
    expect(broken.err()).toMatch(/^line 2: not JSON .*\nline 3: not JSON /);
  });

  it("refuses a target the hooks could not be built for", async () => {
    const dir = await project(`
      import { definePlugin, hook, notify } from "@hooknostic/sdk";
      export default definePlugin({
        name: "needs-notice",
        hooks: [hook("turn.stop", { id: "notice", capabilities: { "turn.stop.notify": "required" }, run: () => notify("x") })],
      });
    `);
    await expect(dispatched(dir, "claude", [{ event: "turn.stop" }])).resolves.toHaveLength(1);
    const outcome = await dispatchEvents({
      config: join(dir, "hooknostic.config.ts"),
      target: "codex",
      events: [{ event: "turn.stop" }],
      registry: defaultAdapterRegistry(),
      evaluate: EVALUATE,
    });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.errors.join("\n")).toContain("HN201");
  });

  it("hands hooks the ctx.plugin.root the built runtime would resolve", async () => {
    // Reported through block, the one tool.before effect every target honours.
    const rooted = `
      import { block, definePlugin, hook } from "@hooknostic/sdk";
      export default definePlugin({
        name: "rooted",
        hooks: [
          hook("tool.before", {
            id: "root",
            capabilities: { "tool.before.block": "required" },
            run: (_event, ctx) => block(ctx.plugin?.root ?? "absent"),
          }),
        ],
      });
    `;
    const targets = (delivery: string) => `{
      claude: { version: ${JSON.stringify(claudeHarness.recommendedRange)}, delivery: "${delivery}", output: "./dist/claude" },
      codex: { version: ${JSON.stringify(CODEX_PLUGIN_MODE_RANGE)}, delivery: "${delivery}", output: "./dist/codex" },
      opencode: {
        version: ${JSON.stringify(opencodeHarness.recommendedRange)},
        delivery: "${delivery}",
        output: "./dist/opencode",
        compatibility: { minimum: "approximate" },
      },
    }`;
    const rootOf = async (dir: string, target: string) => {
      const [result] = await dispatched(dir, target, [
        toolBefore(target === "opencode" ? "bash" : "Bash", { command: "ls" }),
      ]);
      return (result!.effects[0]?.effect as { reason?: string } | undefined)?.reason;
    };

    // The same expectations build.test.ts holds the built runtimes to (ADR-0020).
    const packaged = await project(rooted, targets("package"), 'components: { root: "." },');
    expect(await rootOf(packaged, "claude")).toBe(join(packaged, "dist/claude"));
    expect(await rootOf(packaged, "codex")).toBe(join(packaged, "dist/codex"));
    expect(await rootOf(packaged, "opencode")).toBe(join(packaged, "dist/opencode/package"));

    const projected = await project(rooted, targets("project"), 'project: { root: "." }, components: { root: "." },');
    for (const target of ["claude", "codex", "opencode"]) expect(await rootOf(projected, target)).toBe(projected);

    const hooksOnly = await project(rooted, targets("package"));
    expect(await rootOf(hooksOnly, "claude")).toBe("absent");
  });

  it("keeps hook stdout out of the result lines and exits despite a leaked handle", async () => {
    // Plain data rather than SDK helpers: the spawned CLI has no alias for the
    // workspace SDK, and a plugin needs nothing from it at run time.
    const dir = await project(
      `export default {
        name: "noisy",
        hooks: [{
          event: "prompt.before",
          id: "noisy",
          capabilities: {},
          run() {
            console.log("noise from console.log");
            process.stdout.write("noise from process.stdout\\n");
            setInterval(() => {}, 60_000);
          },
        }],
      };`,
    );
    const child = spawnSync(
      process.execPath,
      [CLI_BIN, "dispatch", "--config", join(dir, "hooknostic.config.ts"), "--target", "claude"],
      { input: `${JSON.stringify({ event: "prompt.before", prompt: "hi" })}\n`, encoding: "utf8", timeout: 60_000 },
    );
    expect(child.status, child.stderr).toBe(0);
    const lines = child.stdout.trim().split("\n");
    expect(lines.map((line) => (JSON.parse(line) as DispatchResult).event)).toEqual(["prompt.before"]);
    expect(child.stderr).toContain("noise from console.log");
    expect(child.stderr).toContain("noise from process.stdout");
  });
});
