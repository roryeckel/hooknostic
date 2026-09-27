import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  it("unwraps Pi tee records without changing raw capture files", () => {
    const captured = mkdtempSync(join(tmpdir(), "hooknostic-drive-pi-"));
    tempDirs.push(captured, `${captured}-json`);
    const payload = {
      event: { type: "tool_call", toolName: "bash", input: { command: "echo probe" } },
      ctx: { cwd: "/project", mode: "print" },
    };
    const raw = JSON.stringify({ event: "tool_call", payload }) + "\n";
    writeFileSync(join(captured, "tool_call.jsonl"), raw);
    const { dst, count } = flattenCaptured(captured, "pi");
    expect(count).toBe(1);
    expect(JSON.parse(readFileSync(join(dst, "tool_call-0.json"), "utf8"))).toEqual(payload);
    expect(readFileSync(join(captured, "tool_call.jsonl"), "utf8")).toBe(raw);
  });
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
