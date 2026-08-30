import { describe, expect, it } from "vitest";
import { shellCodec } from "./tools.js";

// A Codex-shaped table exercises every feature: two tools disagreeing on the
// command key, one carrying a cwd key, and an uncaptured name absent entirely.
const CODEC = shellCodec({
  Bash: { commandKey: "command" },
  exec_command: { commandKey: "cmd", cwdKey: "workdir" },
});

describe("shellCodec", () => {
  it("round-trips: encode then classify shows the patched command", () => {
    for (const [name, input] of [
      ["Bash", { command: "echo old", description: "d" }],
      ["exec_command", { cmd: "echo old", workdir: "C:/proj", login: false }],
    ] as const) {
      const encoded = CODEC.encode(name, input, { command: "echo new" });
      expect(CODEC.classify(name, encoded)?.command).toBe("echo new");
    }
  });

  it("preserves every sibling key and adds none", () => {
    const input = { cmd: "echo old", workdir: "C:/proj", login: false, shell: "cmd" };
    const encoded = CODEC.encode("exec_command", input, { command: "echo new" }) as Record<
      string,
      unknown
    >;
    // Codex's wire schemas are additionalProperties:false, so the encoded
    // object must contain exactly the keys the wire already carried.
    expect(Object.keys(encoded).sort()).toEqual(Object.keys(input).sort());
    expect(encoded["workdir"]).toBe("C:/proj");
    expect(encoded["login"]).toBe(false);
    expect(input.cmd).toBe("echo old"); // the original is never mutated
  });

  it("declines both directions for an uncaptured tool name", () => {
    expect(CODEC.classify("shell", { cmd: "echo x" })).toBeUndefined();
    expect(CODEC.encode("shell", { cmd: "echo x" }, { command: "y" })).toBeUndefined();
  });

  it("declines a non-plain-object input rather than fabricating one", () => {
    // `{...["a"]}` would silently become `{"0":"a"}` -- a garbage native
    // input, not an honest refusal.
    for (const input of [["echo x"], null, "echo x", 42]) {
      expect(CODEC.encode("Bash", input, { command: "y" })).toBeUndefined();
      expect(CODEC.classify("Bash", input)).toBeUndefined();
    }
  });

  it("exposes the native keys it derived from", () => {
    expect(CODEC.classify("Bash", { command: "x" })).toEqual({
      command: "x",
      commandKey: "command",
    });
    expect(CODEC.classify("exec_command", { cmd: "x", workdir: "C:/p" })).toEqual({
      command: "x",
      cwd: "C:/p",
      commandKey: "cmd",
      cwdKey: "workdir",
    });
    // cwdKey advertised even when this invocation carried no cwd: it says
    // "this tool HAS a working-directory key", not "this call used one".
    expect(CODEC.classify("exec_command", { cmd: "x" })).toEqual({
      command: "x",
      commandKey: "cmd",
      cwdKey: "workdir",
    });
  });

  it("applies normalizeName to the lookup", () => {
    const lower = shellCodec({ bash: { commandKey: "command" } }, {
      normalizeName: (n) => n.toLowerCase(),
    });
    expect(lower.classify("Bash", { command: "x" })?.command).toBe("x");
    expect(lower.encode("BASH", { command: "x" }, { command: "y" })).toEqual({ command: "y" });
  });
});
