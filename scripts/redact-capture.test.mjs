import { describe, expect, it } from "vitest";

import { capturingHomes, redactHomes, unredactedHomes } from "./redact-capture.mjs";

const WINDOWS_HOME = "C:\\Users\\jo";
const POSIX_HOME = "/home/jo";

const redact = (text, homes = [WINDOWS_HOME]) => redactHomes(text, homes);

/** What the probe does: write only when there is no near miss and no surviving home. */
const writable = (text, homes = [WINDOWS_HOME]) => {
  const { text: out, nearMisses } = redactHomes(text, homes);
  return nearMisses.length === 0 && unredactedHomes(out, homes).length === 0;
};

describe("capture redaction", () => {
  it("redacts the home path at any escape depth and with mixed separators", () => {
    const record = JSON.stringify({
      cwd: "C:\\Users\\jo\\project",
      terminal: "C:\\Users\\jo",
      lowerDrive: "c:\\users\\jo\\x",
      forward: "C:/Users/jo/x",
      mixed: "C:\\Users/jo/x",
      nested: JSON.stringify({ workdir: "C:\\Users\\jo\\project" }),
      nestedTerminal: JSON.stringify({ workdir: "C:\\Users\\jo" }),
      deeper: JSON.stringify(JSON.stringify({ workdir: "C:\\Users\\jo\\project" })),
    });
    const { text, nearMisses } = redact(record);
    expect(nearMisses).toEqual([]);
    expect(JSON.parse(text)).toEqual({
      cwd: "C:\\Users\\user\\project",
      terminal: "C:\\Users\\user",
      lowerDrive: "c:\\users\\user\\x",
      forward: "C:/Users/user/x",
      mixed: "C:\\Users/user/x",
      nested: JSON.stringify({ workdir: "C:\\Users\\user\\project" }),
      nestedTerminal: JSON.stringify({ workdir: "C:\\Users\\user" }),
      deeper: JSON.stringify(JSON.stringify({ workdir: "C:\\Users\\user\\project" })),
    });
    expect(unredactedHomes(text, [WINDOWS_HOME])).toEqual([]);
    expect(unredactedHomes(record, [WINDOWS_HOME]).length).toBe(8);
  });

  it("redacts a one-character profile name", () => {
    const record = JSON.stringify({ p: "C:\\Users/j/project" });
    const { text } = redactHomes(record, ["C:\\Users\\j"]);
    expect(JSON.parse(text)).toEqual({ p: "C:\\Users/user/project" });
    expect(unredactedHomes(record, ["C:\\Users\\j"])).toEqual(["C:\\Users\\j"]);
  });

  it("does not mistake the redacted segment for a profile named like a prefix of user", () => {
    const record = JSON.stringify({ p: "C:\\Users\\us\\x", q: "C:\\Users\\us" });
    expect(writable(record, ["C:\\Users\\us"])).toBe(true);
    expect(JSON.parse(redactHomes(record, ["C:\\Users\\us"]).text)).toEqual({
      p: "C:\\Users\\user\\x",
      q: "C:\\Users\\user",
    });
  });

  it("leaves non-home text untouched", () => {
    const record = JSON.stringify({ doc: "docs/Users/Permissions", drive: "D:\\Users\\jo\\x", word: "node -e jo" });
    expect(redact(record)).toEqual({ text: record, nearMisses: [] });
    expect(redactHomes(record, [POSIX_HOME])).toEqual({ text: record, nearMisses: [] });
    expect(writable(record, [WINDOWS_HOME, POSIX_HOME])).toBe(true);
  });

  it("never rewrites a profile that continues past the home's name, and refuses instead", () => {
    const paths = [
      "C:\\Users\\jonas\\x",
      "C:\\Users\\jo@corp\\x",
      "C:\\Users\\joé",
      "C:\\Users\\jo smith\\project",
      "C:\\Users\\jo's\\x",
      "path C:/Users/jo, then continue",
    ];
    for (const path of paths) {
      const record = JSON.stringify({ path });
      const { text, nearMisses } = redact(record);
      expect(text, path).toBe(record);
      expect(nearMisses, path).toHaveLength(1);
      expect(writable(record), path).toBe(false);
    }
    const { text, nearMisses } = redactHomes('{"p":"/home/jo@corp/x"}', [POSIX_HOME]);
    expect(text).toBe('{"p":"/home/jo@corp/x"}');
    expect(nearMisses).toEqual(["/home/jo@corp"]);
  });

  it("refuses a single-quoted home path rather than guess where it ends", () => {
    const record = JSON.stringify({ source: "const x = 'C:\\Users\\jo'; text('ok')\n" });
    expect(redact(record).text).toBe(record);
    expect(writable(record)).toBe(false);
  });

  it("refuses a home path glued to an option that redaction does not recognise", () => {
    const record = JSON.stringify({ cmd: "tool -oC:/Users/jo/file" });
    expect(redact(record)).toEqual({ text: record, nearMisses: [] });
    expect(unredactedHomes(record, [WINDOWS_HOME])).toEqual([WINDOWS_HOME]);
    expect(writable(record)).toBe(false);
  });

  it("matches a POSIX home case-sensitively and a Windows home case-insensitively", () => {
    expect(redactHomes('{"a":"/home/jo/p","b":"/home/JO/p","c":"/home/jo"}', [POSIX_HOME]).text).toBe(
      '{"a":"/home/user/p","b":"/home/JO/p","c":"/home/user"}',
    );
    expect(unredactedHomes('{"b":"/home/JO/p"}', [POSIX_HOME])).toEqual([]);
    expect(redact('{"a":"C:\\\\USERS\\\\JO\\\\p"}').text).toBe('{"a":"C:\\\\USERS\\\\user\\\\p"}');
  });

  it("adds the temp directory's profile only when it resolves to the home", () => {
    const realpaths = {
      "C:\\Users\\Alice": "C:\\Users\\Alice",
      "C:\\Users\\ALICE~1": "C:\\Users\\Alice",
      "C:\\Users\\Public": "C:\\Users\\Public",
    };
    const realpath = (path) => {
      if (!(path in realpaths)) throw new Error(`ENOENT ${path}`);
      return realpaths[path];
    };
    const home = "C:\\Users\\Alice";
    expect(capturingHomes({ home, temp: "C:\\Users\\ALICE~1\\AppData\\Local\\Temp", realpath })).toEqual([
      home,
      "C:\\Users\\ALICE~1",
    ]);
    expect(capturingHomes({ home, temp: "C:\\Users\\Public\\Temp", realpath })).toEqual([home]);
    expect(capturingHomes({ home, temp: "D:\\tmp", realpath })).toEqual([home]);
  });

  it("compares POSIX real paths with case preserved", () => {
    const realpath = (path) => path;
    const home = "/Users/Alice";
    expect(capturingHomes({ home, temp: "/Users/alice/tmp", realpath })).toEqual([home]);
    expect(capturingHomes({ home, temp: "/Users/Alice/tmp", realpath })).toEqual([home]);
  });

  it("finds a home path, not an account name in ordinary text", () => {
    const home = "C:\\Users\\node";
    expect(unredactedHomes('{"cmd":"node -e 1","v":"codex"}', [home])).toEqual([]);
    expect(unredactedHomes('{"cwd":"C:\\\\Users\\\\node\\\\p"}', [home])).toEqual([home]);
  });
});
