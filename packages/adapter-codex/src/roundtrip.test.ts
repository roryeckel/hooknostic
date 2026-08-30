import { describe, expect, it } from "vitest";
import { block, definePlugin, hook, updateShell } from "@hooknostic/sdk";
import { dispatch } from "@hooknostic/runtime";
import { loadFixture } from "@hooknostic/testkit";
import { applyCodex } from "./apply.js";
import { decodeCodex } from "./decode.js";
import { codexCapabilityProfiles } from "./profile.js";
import { codexShellCodec } from "./toolmap.js";
import { codexHarness } from "./harness.js";

const INVOCATION = { targetId: "codex", harnessVersion: codexHarness.referenceVersion };
const LEVELS = Object.fromEntries(
  Object.entries(codexCapabilityProfiles[0]!.matrix).map(([id, e]) => [id, e.level]),
);

const plugin = definePlugin({
  name: "roundtrip",
  hooks: [
    hook("tool.before", {
      id: "protect-and-normalize-shell",
      match: { kind: "shell" },
      capabilities: {
        "tool.before.block": "required",
        "tool.before.input.replace": "optional",
      },
      async run(event, ctx) {
        // One hook body serving both Codex shell tools: the codec lowers the
        // rewrite to `command` for Bash and `cmd` for exec_command.
        const raw = (event.tool.input as { command?: unknown }).command;
        const command = event.tool.shell?.command ?? (typeof raw === "string" ? raw : "");
        if (command.includes("rm -rf /")) return block("Refusing destructive root deletion");
        if (
          ctx.capabilities.has("tool.before.input.replace") &&
          event.tool.shell !== undefined &&
          command.startsWith("npm ")
        ) {
          return updateShell({ command: command.replace(/^npm /, "pnpm ") });
        }
      },
    }),
  ],
});

async function roundTrip(nativeInput: unknown) {
  const event = decodeCodex(nativeInput, INVOCATION);
  const result = await dispatch(plugin.hooks, event, {
    targetId: "codex",
    harness: event.harness,
    capabilities: LEVELS,
    shellCodec: codexShellCodec,
  });
  return applyCodex(result, nativeInput, INVOCATION);
}

describe("golden round-trip (codex)", () => {
  it("blocks a destructive shell command", async () => {
    const input = loadFixture<Record<string, unknown>>(
      "codex",
      "0.148",
      "pre-tool-bash.input.json",
    );
    const native = await roundTrip({ ...input, tool_input: { command: "rm -rf /" } });
    expect(native).toEqual(loadFixture("codex", "0.148", "pre-tool-block.output.json"));
  });

  it("rewrites npm to pnpm through the allow+updatedInput protocol", async () => {
    const input = loadFixture<Record<string, unknown>>(
      "codex",
      "0.148",
      "pre-tool-bash.input.json",
    );
    const native = await roundTrip({ ...input, tool_input: { command: "npm install" } });
    expect(native).toEqual(loadFixture("codex", "0.148", "pre-tool-rewrite.output.json"));
  });

  it("rewrites an exec_command invocation under its own native key", async () => {
    // The pairing whose absence hid the key mismatch: the same hook body as
    // above, landing under `cmd`/`workdir` instead of `command`.
    const input = loadFixture<Record<string, unknown>>(
      "codex",
      "0.148",
      "pre-tool-exec-command.input.json",
    );
    const toolInput = input["tool_input"] as Record<string, unknown>;
    const native = await roundTrip({
      ...input,
      tool_input: { ...toolInput, cmd: "npm install" },
    });
    expect(native).toEqual(
      loadFixture("codex", "0.148", "pre-tool-exec-command-rewrite.output.json"),
    );
  });

  it("continues unchanged for benign commands", async () => {
    const native = await roundTrip(loadFixture("codex", "0.148", "pre-tool-bash.input.json"));
    expect(native).toEqual({ exitCode: 0 });
  });
});
