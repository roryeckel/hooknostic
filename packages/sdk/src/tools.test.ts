import { describe, expect, it } from "vitest";

import { matchesTool, rawInputString, shellCodec } from "./tools.js";

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
    const encoded = CODEC.encode("exec_command", input, { command: "echo new" }) as Record<string, unknown>;
    // Codex's wire schemas are additionalProperties:false, so the encoded
    // object must contain exactly the keys the wire already carried.
    expect(Object.keys(encoded).sort()).toEqual(Object.keys(input).sort());
    expect(encoded["workdir"]).toBe("C:/proj");
    expect(encoded["login"]).toBe(false);
    expect(input.cmd).toBe("echo old"); // the original is never mutated
  });

  it("declines encode when the input does not currently classify", () => {
    // The command key must presently hold a string. classify() and encode()
    // agree on this, so event.tool.shell being defined is the one signal for
    // both directions.
    expect(CODEC.encode("Bash", { notCommand: true }, { command: "y" })).toBeUndefined();
    expect(CODEC.encode("exec_command", { cmd: 42 }, { command: "y" })).toBeUndefined();
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

  it("declines prototype-member tool names and non-plain instances", () => {
    // A tool named "constructor" must not resolve Object.prototype members,
    // and OpenCode's in-process shim can hand the codec live class instances
    // -- spreading one strips its prototype silently instead of declining.
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      expect(CODEC.classify(name, { command: "x" })).toBeUndefined();
      expect(CODEC.encode(name, { command: "x" }, { command: "y" })).toBeUndefined();
    }
    class Boxed {
      command = "echo x";
    }
    expect(CODEC.classify("Bash", new Boxed())).toBeUndefined();
    expect(CODEC.encode("Bash", new Boxed(), { command: "y" })).toBeUndefined();
    expect(CODEC.classify("Bash", new Date())).toBeUndefined();
    // Null-prototype objects are honest data and stay accepted.
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, {
      command: "echo x",
    });
    expect(CODEC.classify("Bash", bare)?.command).toBe("echo x");
  });

  it("applies normalizeName to the lookup", () => {
    const lower = shellCodec(
      { bash: { commandKey: "command" } },
      {
        normalizeName: (n) => n.toLowerCase(),
      },
    );
    expect(lower.classify("Bash", { command: "x" })?.command).toBe("x");
    expect(lower.encode("BASH", { command: "x" }, { command: "y" })).toEqual({ command: "y" });
  });
});

describe("rawInputString", () => {
  it("reads an own string argument by its native key", () => {
    expect(rawInputString({ input: { file_path: "/repo/.env" } }, "file_path")).toBe("/repo/.env");
  });

  it("is undefined for anything that is not an own string on a plain object", () => {
    expect(rawInputString({ input: { file_path: 42 } }, "file_path")).toBeUndefined();
    expect(rawInputString({ input: {} }, "file_path")).toBeUndefined();
    // Prototype members are not arguments, whatever they resolve to.
    expect(rawInputString({ input: {} }, "toString")).toBeUndefined();
    expect(rawInputString({ input: Object.create({ file_path: "inherited" }) as object }, "file_path")).toBeUndefined();
    for (const input of [null, "file_path", ["file_path"], new Date()]) {
      expect(rawInputString({ input }, "file_path")).toBeUndefined();
    }
  });

  it("does not read a key a polluted Object.prototype supplies", () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto["file_path"] = "polluted";
    try {
      expect(rawInputString({ input: {} }, "file_path")).toBeUndefined();
    } finally {
      delete proto["file_path"];
    }
  });
});

describe("matchesTool", () => {
  const tool = { kind: "shell", nativeName: "Bash", input: {} } as const;

  it("accepts single values and readonly lists for both fields", () => {
    const kinds = ["file.read", "shell"] as const;
    const names = ["PowerShell", "Bash"] as const;
    expect(matchesTool({ kind: kinds }, tool)).toBe(true);
    expect(matchesTool({ nativeName: names }, tool)).toBe(true);
    expect(matchesTool({ kind: "file.read" }, tool)).toBe(false);
    expect(matchesTool({ kind: "shell", nativeName: "PowerShell" }, tool)).toBe(false);
    expect(matchesTool(undefined, tool)).toBe(true);
  });
});
