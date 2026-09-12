import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { flattenCaptured, isEntrypoint, listCaptured } from "./drive-capture-session-utils.mjs";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("drive capture-session helpers", () => {
  it("recognizes an absolute CLI path as its own module URL", () => {
    const script = join(process.cwd(), "scripts", "drive-capture-session.mjs");
    expect(isEntrypoint(pathToFileURL(script).href, script)).toBe(true);
  });

  it("keeps OpenCode plugin-load diagnostics out of comparator input", () => {
    const captured = mkdtempSync(join(tmpdir(), "hooknostic-drive-capture-"));
    tempDirs.push(captured);
    writeFileSync(join(captured, "plugin-load.jsonl"), '{"hook":"plugin-load"}\n', "utf8");
    writeFileSync(join(captured, "chat.message.jsonl"), '{"hook":"chat.message","input":{}}\n', "utf8");

    expect(listCaptured(captured).sort()).toEqual(["chat.message.jsonl", "plugin-load.jsonl"]);
    const { dst, count } = flattenCaptured(captured, "opencode");
    expect(count).toBe(1);
    expect(readdirSync(dst)).toEqual(["chat.message-0.json"]);
  });
});
