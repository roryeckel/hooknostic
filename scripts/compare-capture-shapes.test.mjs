import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  compareCaptures,
  filterOpenCodeBus,
  OPENCODE_MAPPED_BUS_EVENTS,
  shapeDiff,
  shapeOf,
  variantOf,
} from "./compare-capture-shapes.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readFixtureInputs(harnessDir) {
  const dir = join(ROOT, "fixtures", harnessDir);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".input.json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

const CLAUDE_FIXTURES = readFixtureInputs("claude/2.1");
const CODEX_FIXTURES = readFixtureInputs("codex/0.148");
const OPENCODE_FIXTURES = readFixtureInputs("opencode/1.18");

// ---------------------------------------------------------------------------
// shapeOf
// ---------------------------------------------------------------------------

describe("shapeOf", () => {
  it("keeps scalar types but collapses volatile values", () => {
    const shape = shapeOf({
      session_id: "1d998646-7c2a-4a64-befa-c1b0e23e53cf",
      transcript_path: "C:\\Users\\user\\.claude\\projects\\x.jsonl",
      cwd: "C:\\Users\\user\\source\\repos\\hooknostic",
      count: 3,
      flag: true,
      note: "hello",
    });
    expect(shape.session_id).toBe("<volatile>");
    expect(shape.transcript_path).toBe("<volatile>");
    expect(shape.cwd).toBe("<volatile>");
    expect(shape.count).toBe("number");
    expect(shape.flag).toBe("boolean");
    expect(shape.note).toBe("string");
  });

  it("collapses id-shaped and path-shaped strings anywhere", () => {
    expect(shapeOf("toolu_0151it73t7gtgxu121A1oTdT")).toBe("<volatile>");
    expect(shapeOf("call_Wjhr7Wj4xokTqvqtaQZb4zwE")).toBe("<volatile>");
    expect(shapeOf("ses_8f2a1c")).toBe("<volatile>");
    expect(shapeOf("/usr/local/bin/node")).toBe("<volatile>");
    expect(shapeOf("plain words")).toBe("string");
  });

  it("collapses arrays to their first element's shape", () => {
    expect(shapeOf(["a", "b"])).toEqual(["string"]);
    expect(shapeOf([])).toEqual([]);
    expect(shapeOf([{ x: 1 }, { x: 2 }])).toEqual([{ x: "number" }]);
  });

  it("collapses a nested volatile object value under its key", () => {
    expect(shapeOf({ time: { created: 1755600000000 } })).toEqual({
      time: "<volatile>",
    });
  });
});

// ---------------------------------------------------------------------------
// variantOf
// ---------------------------------------------------------------------------

describe("variantOf", () => {
  it("discriminates claude/codex by event + tool", () => {
    expect(
      variantOf(
        "claude",
        CLAUDE_FIXTURES.find((f) => f.tool_name === "Bash" && f.hook_event_name === "PreToolUse"),
      ),
    ).toBe("PreToolUse+Bash");
    expect(
      variantOf(
        "codex",
        CODEX_FIXTURES.find((f) => f.tool_name === "exec_command"),
      ),
    ).toBe("PreToolUse+exec_command");
    expect(
      variantOf(
        "codex",
        CODEX_FIXTURES.find((f) => f.hook_event_name === "Stop"),
      ),
    ).toBe("Stop");
  });

  it("discriminates opencode tool callbacks by hook + tool", () => {
    const toolBefore = OPENCODE_FIXTURES.find((f) => f.hook === "tool.execute.before");
    expect(variantOf("opencode", toolBefore)).toBe("tool.execute.before+bash");
    expect(
      variantOf(
        "opencode",
        OPENCODE_FIXTURES.find((f) => f.hook === "chat.message"),
      ),
    ).toBe("chat.message");
  });

  it("discriminates the opencode generic bus by event type", () => {
    expect(
      variantOf(
        "opencode",
        OPENCODE_FIXTURES.find((f) => f.hook === "event" && f.input.event.type === "session.created"),
      ),
    ).toBe("event+session.created");
    expect(
      variantOf(
        "opencode",
        OPENCODE_FIXTURES.find((f) => f.hook === "event" && f.input.event.type === "permission.asked"),
      ),
    ).toBe("event+permission.asked");
    expect(
      variantOf(
        "opencode",
        OPENCODE_FIXTURES.find((f) => f.hook === "event" && f.input.event.type === "session.idle"),
      ),
    ).not.toBe(
      variantOf(
        "opencode",
        OPENCODE_FIXTURES.find((f) => f.hook === "event" && f.input.event.type === "session.created"),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// OpenCode bus filter
// ---------------------------------------------------------------------------

describe("filterOpenCodeBus", () => {
  it("keeps mapped bus events and moves unmapped ones to the appendix", () => {
    const mapped = OPENCODE_FIXTURES.find((f) => f.hook === "event" && f.input.event.type === "session.created");
    const asked = OPENCODE_FIXTURES.find((f) => f.hook === "event" && f.input.event.type === "permission.asked");
    const unmapped = {
      hook: "event",
      directory: "D:\\tmp",
      input: { event: { type: "session.updated", properties: {} } },
    };
    const unmapped2 = {
      hook: "event",
      directory: "D:\\tmp",
      input: { event: { type: "message.updated", properties: {} } },
    };
    const { compared, appendix } = filterOpenCodeBus([mapped, unmapped, asked, unmapped2]);
    expect(compared).toHaveLength(2);
    expect(appendix.map((p) => p.input.event.type)).toEqual(["session.updated", "message.updated"]);
  });

  it("never filters non-bus callbacks", () => {
    const tool = OPENCODE_FIXTURES.find((f) => f.hook === "tool.execute.before");
    const { compared, appendix } = filterOpenCodeBus([tool]);
    expect(compared).toHaveLength(1);
    expect(appendix).toHaveLength(0);
  });

  it("matches the adapter's mapped event set", () => {
    expect([...OPENCODE_MAPPED_BUS_EVENTS].sort()).toEqual([
      "permission.asked",
      "session.compacted",
      "session.created",
      "session.deleted",
      "session.idle",
    ]);
  });
});

// ---------------------------------------------------------------------------
// compareCaptures
// ---------------------------------------------------------------------------

describe("compareCaptures", () => {
  it("a claude Bash capture in a set with PowerShell/Read PreToolUse fixtures is clean, not cross-variant drift", () => {
    // The captured Bash payload differs from the fixture only in volatile
    // values; other PreToolUse variants exist in the fixture set.
    const captured = [
      {
        ...CLAUDE_FIXTURES.find((f) => f.hook_event_name === "PreToolUse" && f.tool_name === "Bash"),
        session_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        tool_use_id: "toolu_zzz",
        cwd: "C:\\some\\other\\dir",
      },
    ];
    const { verdict, report } = compareCaptures({
      harness: "claude",
      captured,
      fixtures: CLAUDE_FIXTURES,
      expectedVariants: [],
    });
    expect(verdict).toBe("clean");
    expect(report).toContain("clean");
  });

  it("a changed key under a matched variant is drift", () => {
    const fixture = CLAUDE_FIXTURES.find((f) => f.hook_event_name === "PreToolUse" && f.tool_name === "Bash");
    const captured = [{ ...fixture, tool_input: { ...fixture.tool_input, timeout: 30 } }];
    const { verdict, report } = compareCaptures({
      harness: "claude",
      captured,
      fixtures: CLAUDE_FIXTURES,
      expectedVariants: [],
    });
    expect(verdict).toBe("drift");
    expect(report).toContain("NEW in capture");
    expect(report).toContain("timeout");
  });

  it("reports drift when one of several captured instances of a variant changes shape", () => {
    const fixture = CLAUDE_FIXTURES.find((f) => f.hook_event_name === "PreToolUse" && f.tool_name === "Bash");
    const captured = [fixture, { ...fixture, tool_input: { ...fixture.tool_input, timeout: 30 } }];
    const { verdict, report } = compareCaptures({
      harness: "claude",
      captured,
      fixtures: CLAUDE_FIXTURES,
      expectedVariants: [],
    });
    expect(verdict).toBe("drift");
    expect(report).toContain("timeout");
  });

  it("a removed fixture key in the capture is drift", () => {
    const fixture = CODEX_FIXTURES.find((f) => f.hook_event_name === "PreToolUse" && f.tool_name === "Bash");
    const withoutToolInput = { ...fixture };
    delete withoutToolInput.tool_input;
    const { verdict, report } = compareCaptures({
      harness: "codex",
      captured: [{ ...withoutToolInput, tool_input: {} }],
      fixtures: CODEX_FIXTURES,
      expectedVariants: [],
    });
    expect(verdict).toBe("drift");
    expect(report).toContain("missing in capture");
  });

  it("a type flip (string -> number) is drift", () => {
    const fixture = CLAUDE_FIXTURES.find((f) => f.hook_event_name === "Stop");
    const captured = [{ ...fixture, stop_hook_active: "false" }];
    const { verdict } = compareCaptures({
      harness: "claude",
      captured,
      fixtures: CLAUDE_FIXTURES,
      expectedVariants: [],
    });
    expect(verdict).toBe("drift");
  });

  it("an unknown discriminator is a new variant, not key-level drift", () => {
    const captured = [
      {
        ...CODEX_FIXTURES.find((f) => f.hook_event_name === "PreToolUse" && f.tool_name === "Bash"),
        tool_name: "brand_new_tool",
      },
    ];
    const { verdict, report } = compareCaptures({
      harness: "codex",
      captured,
      fixtures: CODEX_FIXTURES,
      expectedVariants: [],
    });
    expect(verdict).toBe("drift");
    expect(report).toContain("new variant");
    expect(report).toContain("brand_new_tool");
    expect(report).not.toContain("NEW in capture");
  });

  it("an empty capture is inconclusive", () => {
    const { verdict, report } = compareCaptures({
      harness: "claude",
      captured: [],
      fixtures: CLAUDE_FIXTURES,
      expectedVariants: ["PreToolUse+Bash"],
    });
    expect(verdict).toBe("inconclusive");
    expect(report).toContain("empty");
  });

  it("the whole tool exchange absent is inconclusive, not clean or drift", () => {
    // Only lifecycle events fired — no tool capture at all. Expected tool
    // variants are NOT reported drift because their counterpart never fired.
    const captured = [
      CODEX_FIXTURES.find((f) => f.hook_event_name === "SessionStart"),
      CODEX_FIXTURES.find((f) => f.hook_event_name === "Stop"),
    ];
    const { verdict, report } = compareCaptures({
      harness: "codex",
      captured,
      fixtures: CODEX_FIXTURES,
      expectedVariants: ["PreToolUse+Bash", "PostToolUse+Bash", "Stop"],
    });
    expect(verdict).toBe("inconclusive");
    expect(report).toContain("inconclusive");
    expect(report).not.toContain("expected variant PreToolUse+Bash absent");
  });

  it("a missing expected variant WITH its counterpart present is drift (partial capture)", () => {
    const captured = [
      CODEX_FIXTURES.find((f) => f.hook_event_name === "SessionStart"),
      CODEX_FIXTURES.find((f) => f.hook_event_name === "Stop"),
      // PreToolUse fired...
      CODEX_FIXTURES.find((f) => f.hook_event_name === "PreToolUse" && f.tool_name === "Bash"),
      // ...but PostToolUse went missing: a hook stopped being emitted.
    ];
    const { verdict, report } = compareCaptures({
      harness: "codex",
      captured,
      fixtures: CODEX_FIXTURES,
      expectedVariants: ["PreToolUse+Bash", "PostToolUse+Bash", "Stop"],
    });
    expect(verdict).toBe("drift");
    expect(report).toContain("expected variant PostToolUse+Bash absent");
  });

  it("unmapped opencode bus events never affect the verdict and appear in the appendix", () => {
    const sessionCreated = OPENCODE_FIXTURES.find(
      (f) => f.hook === "event" && f.input.event.type === "session.created",
    );
    const toolBefore = OPENCODE_FIXTURES.find((f) => f.hook === "tool.execute.before");
    const noise = [
      { hook: "event", directory: "D:\\t", input: { event: { type: "session.updated", properties: {} } } },
      { hook: "event", directory: "D:\\t", input: { event: { type: "message.updated", properties: {} } } },
      { hook: "event", directory: "D:\\t", input: { event: { type: "session.status", properties: {} } } },
    ];
    const { verdict, report } = compareCaptures({
      harness: "opencode",
      captured: [sessionCreated, toolBefore, ...noise],
      fixtures: OPENCODE_FIXTURES,
      expectedVariants: [],
    });
    expect(verdict).toBe("clean");
    expect(report).toContain("session.updated");
    expect(report).toContain("diagnostics only");
  });

  it("a changed opencode bus event type does NOT read clean against the generic event fixture", () => {
    // If a mapped event type changes, the variant changes — a renamed or
    // replaced mapped event must surface, not collapse into the generic
    // "event" variant. The renamed type is itself unmapped (diagnostics
    // appendix), but the drive's expected variant for the mapped event is
    // then absent while the tool exchange ran — drift via the expected-
    // variant rule, which is exactly how a real renamed event surfaces.
    const sessionCreated = OPENCODE_FIXTURES.find(
      (f) => f.hook === "event" && f.input.event.type === "session.created",
    );
    const toolBefore = OPENCODE_FIXTURES.find((f) => f.hook === "tool.execute.before");
    const renamed = {
      ...sessionCreated,
      input: { event: { type: "session.replaced", properties: { info: { id: "ses_x" } } } },
    };
    const { verdict, report } = compareCaptures({
      harness: "opencode",
      captured: [renamed, toolBefore],
      fixtures: OPENCODE_FIXTURES,
      expectedVariants: ["event+session.created", "tool.execute.before+bash"],
    });
    expect(verdict).toBe("drift");
    expect(report).toContain("expected variant event+session.created absent");
    // The renamed event itself appears in the diagnostics appendix...
    expect(report).toContain("session.replaced");
    // ...and the still-present tool variant stays clean against its fixture.
    expect(report).not.toContain("tool.execute.before+bash: shape differs");
  });

  it("a brand-new non-bus opencode callback is a new variant, not key-level drift", () => {
    const toolBefore = OPENCODE_FIXTURES.find((f) => f.hook === "tool.execute.before");
    const novel = { ...toolBefore, hook: "tool.execute.supercede" };
    const { verdict, report } = compareCaptures({
      harness: "opencode",
      captured: [toolBefore, novel],
      fixtures: OPENCODE_FIXTURES,
      expectedVariants: [],
    });
    expect(verdict).toBe("drift");
    expect(report).toContain("new variant");
    expect(report).toContain("tool.execute.supercede");
    expect(report).not.toContain("NEW in capture");
  });
});

describe("shapeDiff", () => {
  it("reports missing, new, and changed leaves with paths", () => {
    const diff = shapeDiff({ a: "string", c: "x" }, { a: "number", b: "boolean", c: "x" });
    expect(diff.some((l) => l.includes("$.a") && l.includes("captured"))).toBe(true);
    expect(diff.some((l) => l.includes("$.b") && l.includes("missing"))).toBe(true);
  });
  it("returns empty for identical shapes", () => {
    expect(shapeDiff({ a: ["string"] }, { a: ["string"] })).toEqual([]);
  });
});
