import { describe, expect, it } from "vitest";

import { leakedNames, redactHomes } from "./redact-capture.mjs";

const WINDOWS_HOME = "C:\\Users\\jo";

describe("capture redaction", () => {
  it("redacts the home path in every spelling a JSON record carries", () => {
    const record = JSON.stringify({
      cwd: "C:\\Users\\jo\\project",
      terminal: "C:\\Users\\jo",
      lowerDrive: "c:\\users\\jo\\x",
      forward: "C:/Users/jo/x",
      nested: JSON.stringify({ workdir: "C:\\Users\\jo\\project" }),
    });
    const out = redactHomes(record, [WINDOWS_HOME]);
    expect(JSON.parse(out)).toEqual({
      cwd: "C:\\Users\\user\\project",
      terminal: "C:\\Users\\user",
      lowerDrive: "c:\\users\\user\\x",
      forward: "C:/Users/user/x",
      nested: JSON.stringify({ workdir: "C:\\Users\\user\\project" }),
    });
    expect(leakedNames(out, ["jo"])).toEqual([]);
  });

  it("leaves Users paths that are not the capturing home untouched", () => {
    const record = JSON.stringify({
      doc: "docs/Users/Permissions",
      other: "C:\\Users\\jonas\\x",
      drive: "D:\\Users\\jo\\x",
    });
    expect(redactHomes(record, [WINDOWS_HOME])).toBe(record);
  });

  it("keeps the code after a single-quoted home path", () => {
    const record = JSON.stringify({ source: "const x = 'C:\\Users\\jo'; text('ok')\n" });
    expect(JSON.parse(redactHomes(record, [WINDOWS_HOME]))).toEqual({
      source: "const x = 'C:\\Users\\user'; text('ok')\n",
    });
  });

  it("redacts a POSIX home", () => {
    expect(redactHomes('{"cwd":"/home/jo/p","t":"/home/jo"}', ["/home/jo"])).toBe(
      '{"cwd":"/home/user/p","t":"/home/user"}',
    );
  });

  it("finds a name only as a whole word", () => {
    const record = '{"codexVersion":"codex-cli 0.156.1"}';
    expect(leakedNames(record, ["cod"])).toEqual([]);
    expect(leakedNames(`${record} run by cod`, ["cod"])).toEqual(["cod"]);
    expect(leakedNames('{"cwd":"C:\\\\Users\\\\jo\\\\p"}', ["jo"])).toEqual(["jo"]);
    expect(leakedNames("C:\\x", ["c"])).toEqual([]);
    expect(leakedNames("C:\\Users\\user", ["user"])).toEqual([]);
  });
});
