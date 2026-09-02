// Capture-shape comparator for the harness-watch drift lane (issue #1 §4).
// Structurally diffs tee-captured native hook payloads against committed
// fixtures, so a harness update that adds, removes, or re-types a payload key
// is reported instead of silently absorbed.
//
//   node --experimental-strip-types scripts/compare-capture-shapes.mjs \
//     <claude|codex|opencode> --captured <dir> [--fixtures <dir>]
//
// Exit codes: 0 clean, 4 drift, 5 inconclusive (empty capture / no tool
// exchange). The workflow treats 4 and 5 as reportable outcomes, never as
// job failures; this script is ADVISORY ONLY — it never writes fixtures and
// never upgrades provenance. A "clean" verdict is a confidence note; drift
// routes humans to the harness-capture skill.
//
// Design points (all regression-pinned in the test file):
// - shapeOf: recursive type skeleton; volatile values (session ids,
//   transcript paths, cwd, timestamps, absolute-path-shaped strings) collapse
//   to "<volatile>" so captures compare by shape, not session identity.
// - Variant-aware matching: fixtures are not unique per native event, so a
//   capture is matched to a fixture by a stable per-harness discriminator —
//   `hook_event_name + tool_name` (claude/codex) or `hook + input.tool` plus
//   `input.event.type` on the generic "event" bus (opencode). A capture
//   matching no fixture is "new variant", never key-level drift against an
//   unrelated variant's payload.
// - OpenCode bus filter: the `event` hook fires for far more than the
//   adapter's mapped events (session.updated, message.updated, ...). The
//   comparator's opencode input is filtered to the mapped `input.event.type`
//   values; all other bus events are reported in a diagnostics appendix only
//   and never affect the verdict.
// - Expected variants: the drive is deterministic, so each harness declares
//   the variant set its session must produce. An expected variant absent from
//   an otherwise nonempty capture is drift when its counterpart fired (a hook
//   stopped being emitted) and inconclusive when the whole tool exchange is
//   absent. Fixture variants outside the expected set stay "not exercised".
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// shapeOf
// ---------------------------------------------------------------------------

/**
 * Per-harness volatile keys: values at these paths compare by type only.
 * Keys are matched on the leaf key name anywhere in the payload.
 */
const VOLATILE_KEYS = new Set([
  // session / message / call / turn / permission / event identifiers
  "session_id",
  "sessionID",
  "sessionId",
  "callID",
  "call_id",
  "tool_use_id",
  "toolCallId",
  "messageID",
  "message_id",
  "turn_id",
  "prompt_id",
  "id",
  "parent_tool_use_id",
  // paths and working directories
  "transcript_path",
  "cwd",
  "directory",
  "workdir",
  // timestamps (numbers or ISO strings)
  "timestamp",
  "time",
  "created",
  "duration_ms",
]);

/** Values that look like absolute paths or model-internal ids. */
const ABSOLUTE_PATH = /^(?:[A-Za-z]:\\|\/|\\\\)/;
const UUID_LIKE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOOLU_LIKE = /^(?:toolu_|call_|msg_|ses_|prt_|per_|evt_|usr_)[0-9A-Za-z]+$/i;

/**
 * Recursive type skeleton. Arrays collapse to `[shapeOf(firstElement)]`
 * (empty arrays stay `[]`); volatile leaves collapse to "<volatile>"; other
 * scalars keep their typeof (so a string→number flip is visible).
 */
export function shapeOf(value, key = undefined) {
  if (key !== undefined && VOLATILE_KEYS.has(key) && value !== null) {
    return "<volatile>";
  }
  if (typeof value === "string") {
    if (ABSOLUTE_PATH.test(value) || UUID_LIKE.test(value) || TOOLU_LIKE.test(value)) {
      return "<volatile>";
    }
    return "string";
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return typeof value;
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? [shapeOf(value[0])] : [];
  }
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = shapeOf(v, k);
    }
    return out;
  }
  return typeof value;
}

// ---------------------------------------------------------------------------
// Variant discrimination
// ---------------------------------------------------------------------------

/** Bus events the opencode adapter maps (decode.ts's `event` switch). */
export const OPENCODE_MAPPED_BUS_EVENTS = new Set([
  "session.created",
  "session.deleted",
  "session.idle",
  "session.compacted",
  "permission.asked",
]);

/**
 * Stable per-harness discriminator for one native payload. Two payloads with
 * the same discriminator are the same variant even if their nested tool
 * argument keys differ (claude Bash vs PowerShell vs Read PreToolUse; codex
 * Bash vs exec_command).
 */
export function variantOf(harness, payload) {
  if (harness === "claude" || harness === "codex") {
    const event = payload?.["hook_event_name"];
    const tool = payload?.["tool_name"];
    return tool === undefined || tool === null ? String(event) : `${event}+${tool}`;
  }
  // opencode: callback name, plus input.tool for tool callbacks, plus the
  // bus event type on the generic "event" hook.
  const hook = payload?.["hook"];
  const input = payload?.["input"] ?? {};
  if (hook === "event") {
    return `event+${input?.event?.type}`;
  }
  const tool = input?.tool;
  return tool === undefined || tool === null ? String(hook) : `${hook}+${tool}`;
}

/**
 * OpenCode bus filter: mapped events stay in the compared set; unmapped bus
 * events move to the diagnostics appendix. Non-bus callbacks always stay.
 * Returns {compared, appendix}.
 */
export function filterOpenCodeBus(payloads) {
  const compared = [];
  const appendix = [];
  for (const payload of payloads) {
    if (payload?.["hook"] === "event") {
      const type = payload?.["input"]?.event?.type;
      if (typeof type === "string" && !OPENCODE_MAPPED_BUS_EVENTS.has(type)) {
        appendix.push(payload);
        continue;
      }
    }
    compared.push(payload);
  }
  return { compared, appendix };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object") {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
    return ak.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/** Added/removed keys and leaf type changes between two shapes, as lines. */
export function shapeDiff(capturedShape, fixtureShape, path = "$") {
  const lines = [];
  if (deepEqual(capturedShape, fixtureShape)) return lines;
  if (
    typeof capturedShape !== "object" ||
    typeof fixtureShape !== "object" ||
    capturedShape === null ||
    fixtureShape === null ||
    Array.isArray(capturedShape) ||
    Array.isArray(fixtureShape)
  ) {
    lines.push(`${path}: captured ${JSON.stringify(capturedShape)} vs fixture ${JSON.stringify(fixtureShape)}`);
    return lines;
  }
  const capturedKeys = new Set(Object.keys(capturedShape));
  const fixtureKeys = new Set(Object.keys(fixtureShape));
  for (const k of fixtureKeys) {
    if (!capturedKeys.has(k)) lines.push(`${path}.${k}: missing in capture (fixture ${JSON.stringify(fixtureShape[k])})`);
  }
  for (const k of capturedKeys) {
    if (!fixtureKeys.has(k)) lines.push(`${path}.${k}: NEW in capture (${JSON.stringify(capturedShape[k])})`);
  }
  for (const k of capturedKeys) {
    if (fixtureKeys.has(k)) {
      lines.push(...shapeDiff(capturedShape[k], fixtureShape[k], `${path}.${k}`));
    }
  }
  return lines;
}

/**
 * Pure comparator. `captured` and `fixtures` are arrays of parsed native
 * payloads (harness-native envelope). `expectedVariants` is the drive's
 * declared variant set (discriminator strings); missing expected captures
 * are non-clean per the issue contract:
 * - counterpart (any tool.* variant) present + expected absent  → drift
 * - no tool-exchange capture at all                              → inconclusive
 * Returns {verdict, report}.
 */
export function compareCaptures({
  harness,
  captured,
  fixtures,
  expectedVariants = [],
}) {
  const report = [];
  let busAppendix = [];
  let payloads = captured;
  if (harness === "opencode") {
    const filtered = filterOpenCodeBus(captured);
    payloads = filtered.compared;
    busAppendix = filtered.appendix;
  }

  if (payloads.length === 0) {
    return {
      verdict: "inconclusive",
      report: "capture is empty after filtering — nothing to compare",
    };
  }

  const fixturesByVariant = new Map();
  for (const fixture of fixtures) {
    const variant = variantOf(harness, fixture);
    if (!fixturesByVariant.has(variant)) fixturesByVariant.set(variant, []);
    fixturesByVariant.get(variant).push(fixture);
  }

  const capturedByVariant = new Map();
  for (const payload of payloads) {
    const variant = variantOf(harness, payload);
    if (!capturedByVariant.has(variant)) capturedByVariant.set(variant, []);
    capturedByVariant.get(variant).push(payload);
  }

  const driftLines = [];
  const newVariants = [];
  const notExercised = [];
  for (const [variant, payloadsForVariant] of capturedByVariant) {
    const variantFixtures = fixturesByVariant.get(variant);
    if (variantFixtures === undefined) {
      newVariants.push(variant);
      continue;
    }
    const capturedShapes = payloadsForVariant.map((p) => shapeOf(p));
    const fixtureShapes = variantFixtures.map((f) => shapeOf(f));
    // Clean if the capture's shape matches ANY committed fixture of this
    // variant (fixtures may legitimately differ among themselves).
    const clean = capturedShapes.some((cs) =>
      fixtureShapes.some((fs) => deepEqual(cs, fs)),
    );
    if (!clean) {
      driftLines.push(
        `variant ${variant}: shape differs from every committed fixture`,
      );
      for (const cs of capturedShapes) {
        for (const fs of fixtureShapes) {
          for (const line of shapeDiff(cs, fs)) {
            driftLines.push(`  ${line}`);
          }
        }
      }
    }
  }

  // Expected-variant accounting. The tool exchange fired iff any capture is
  // a tool variant; that is the "counterpart" in the issue's partial-capture
  // rule: an expected variant missing while the exchange ran is drift (a
  // hook stopped being emitted); with no tool capture at all, the drive
  // never exercised the exchange, so absence is not a drift claim.
  const isToolVariant = (variant) =>
    variant.includes("tool") ||
    variant.includes("PreToolUse") ||
    variant.includes("PostToolUse");
  const toolExchangeFired = [...capturedByVariant.keys()].some(isToolVariant);
  for (const expected of expectedVariants) {
    if (capturedByVariant.has(expected)) continue;
    if (toolExchangeFired) {
      driftLines.push(
        `expected variant ${expected} absent from the capture (the tool exchange ran)`,
      );
    }
    // else: whole tool exchange absent — inconclusive territory, not drift.
  }

  for (const variant of fixturesByVariant.keys()) {
    if (!capturedByVariant.has(variant)) notExercised.push(variant);
  }

  if (driftLines.length > 0) {
    report.push("## Verdict: drift", "");
    report.push(...driftLines);
  } else if (newVariants.length > 0) {
    report.push("## Verdict: drift (new variants need capture)", "");
    for (const v of newVariants) {
      report.push(`- new variant: ${v} — needs capture, not present in fixtures`);
    }
  } else {
    report.push("## Verdict: clean", "");
    report.push("All captured variants match committed fixture shapes.");
  }
  if (notExercised.length > 0) {
    report.push("", "### Fixture variants not exercised", "");
    for (const v of notExercised) report.push(`- ${v}`);
  }
  if (busAppendix.length > 0) {
    report.push("", "### Unmapped OpenCode bus events (diagnostics only)", "");
    for (const p of busAppendix) {
      report.push(`- ${p?.input?.event?.type}`);
    }
  }
  const verdict = driftLines.length > 0 || newVariants.length > 0 ? "drift" : "clean";
  return { verdict, report: report.join("\n") };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { captured: undefined, fixtures: undefined, harness: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--captured") {
      opts.captured = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--fixtures") {
      opts.fixtures = argv[i + 1];
      i += 1;
    } else {
      opts.harness = argv[i];
    }
  }
  return opts;
}

const FIXTURE_DIRS = {
  claude: "fixtures/claude/2.1",
  codex: "fixtures/codex/0.148",
  opencode: "fixtures/opencode/1.18",
};

/**
 * Expected variant sets: the deterministic drive session must produce exactly
 * these (session start, prompt, PreToolUse+PostToolUse for the shell tool,
 * stop) — the partial-capture rule from the issue's review round 5.
 */
const EXPECTED_VARIANTS = {
  claude: [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse+Bash",
    "PostToolUse+Bash",
    "Stop",
  ],
  codex: ["SessionStart", "UserPromptSubmit", "PreToolUse+Bash", "PostToolUse+Bash", "Stop"],
  opencode: [
    "event+session.created",
    "chat.message",
    "tool.execute.before+bash",
    "tool.execute.after+bash",
    "event+session.idle",
  ],
};

function readJsonDir(dir, { suffix = ".json" } = {}) {
  const out = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(suffix))) {
    // Strip a UTF-8 BOM if a Windows writer added one.
    const text = readFileSync(join(dir, name), "utf8").replace(/^\uFEFF/, "");
    out.push(JSON.parse(text));
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.harness === undefined || opts.captured === undefined) {
    process.stderr.write(
      `usage: node --experimental-strip-types ${process.argv[1]} <claude|codex|opencode> --captured <dir> [--fixtures <dir>]\n`,
    );
    process.exit(2);
  }
  const fixtureDir = opts.fixtures ?? FIXTURE_DIRS[opts.harness];
  if (fixtureDir === undefined) {
    process.stderr.write(`unknown harness: ${opts.harness}\n`);
    process.exit(2);
  }
  const captured = readJsonDir(opts.captured);
  const fixtures = readJsonDir(fixtureDir, { suffix: ".input.json" });
  const { verdict, report } = compareCaptures({
    harness: opts.harness,
    captured,
    fixtures,
    expectedVariants: EXPECTED_VARIANTS[opts.harness] ?? [],
  });
  process.stdout.write(`${report}\n`);
  process.exit(verdict === "clean" ? 0 : verdict === "drift" ? 4 : 5);
}

// Same CLI guard as release-notes.mjs: pure helpers stay importable.
if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll("\\", "/")}`).href) {
  await main();
}