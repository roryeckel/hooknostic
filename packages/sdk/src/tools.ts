/**
 * Best-effort normalized classification of a tool invocation. The category
 * exists for portable matching; the native tool name and raw event remain
 * available so a plugin can intentionally use harness-specific behavior.
 */
export const TOOL_KINDS = [
  "shell",
  "file.read",
  "file.write",
  "file.edit",
  "web.fetch",
  "web.search",
  "agent",
  "mcp",
  "other",
] as const;

export type ToolKind = (typeof TOOL_KINDS)[number];

export interface ToolInvocation {
  kind: ToolKind;

  /** The harness's own name for the tool (escape hatch; never normalized away). */
  nativeName: string;

  /** The tool input exactly as the harness reports it. */
  input: unknown;

  /** Present when the tool is an MCP tool and the harness exposes the split. */
  mcp?: {
    server?: string;
    tool?: string;
  };

  /**
   * The shell invocation, normalized, when the adapter knows this tool's
   * argument shape.
   *
   * `kind` is portable but `input` is not: Claude's `Bash` names the command
   * `command`, Codex's `exec_command` names it `cmd` (captured on 0.151.0 --
   * see `.capture/codex-tools/README.md`). A guard matching `kind: "shell"` and
   * reading `input.command` therefore compiles, checks and matches everywhere
   * while silently permitting a whole harness's shell calls.
   *
   * Deliberately optional, and its absence is informative: where a shell-kind
   * tool's argument shape has not been captured, the adapter leaves this
   * undefined rather than guessing, and a hook should fall back to `input`.
   * `input` always stays the verbatim payload -- this is derived from it, never
   * a replacement for it.
   */
  shell?: ToolShell;
}

/**
 * The normalized shell view plus the native key names it was derived from.
 * `commandKey`/`cwdKey` are descriptive data for the raw escape hatch: a hook
 * that must hand-build a native input (because it also touches keys outside
 * the normalized view) writes `replaceInput({ ...input, [shell.commandKey]:
 * next })` instead of restating per-harness knowledge. `cwdKey` absent means
 * "this tool has no working-directory key", not "this invocation had none".
 */
export interface ToolShell {
  command: string;
  cwd?: string;
  commandKey: string;
  cwdKey?: string;
}

/**
 * The native argument keys of one shell tool. Absence of a table entry means
 * the shape is uncaptured -- both codec directions decline rather than guess.
 */
export interface ShellShape {
  /** Native key carrying the command string. */
  commandKey: string;
  /** Native key carrying the working directory, when the tool has one. */
  cwdKey?: string;
}

/** Native tool name -> argument shape. Lookup is exact after `normalizeName`. */
export type ShellShapes = Readonly<Record<string, ShellShape>>;

export interface ShellCodec {
  /** Derive the normalized view; `undefined` when uncaptured or mismatched. */
  classify(nativeName: string, input: unknown): ToolShell | undefined;
  /**
   * Merge a command patch into the native input, preserving every sibling key
   * and adding none the tool's own shape does not name. `undefined` when the
   * shape is uncaptured or `input` is not a plain object -- never a guess.
   */
  encode(nativeName: string, input: unknown, patch: { command: string }): unknown | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  // Prototype check, not just non-array: OpenCode is in-process and hands the
  // codec live objects, so a Date/Map/class instance can reach here. Spreading
  // one silently strips its prototype and non-enumerable state -- decline it,
  // as the codec contract promises for anything it does not understand.
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Own-property table lookup: a tool named "constructor" must not resolve Object.prototype. */
function shapeOf(shapes: ShellShapes, key: string): ShellShape | undefined {
  return Object.hasOwn(shapes, key) ? shapes[key] : undefined;
}

/**
 * Build a two-way shell codec from a shape table. Both directions read the
 * same keys, so the normalized read and the encoded write cannot skew: revert
 * a key in the table and the decode fixtures and the rewrite roundtrips fail
 * together.
 */
export function shellCodec(
  shapes: ShellShapes,
  options?: { normalizeName?: (nativeName: string) => string },
): ShellCodec {
  const normalize = options?.normalizeName ?? ((name: string) => name);
  return {
    classify(nativeName, input) {
      const shape = shapeOf(shapes, normalize(nativeName));
      if (shape === undefined || !isPlainObject(input)) return undefined;
      const command = input[shape.commandKey];
      if (typeof command !== "string") return undefined;
      const cwd = shape.cwdKey !== undefined ? input[shape.cwdKey] : undefined;
      return {
        command,
        ...(typeof cwd === "string" ? { cwd } : {}),
        commandKey: shape.commandKey,
        ...(shape.cwdKey !== undefined ? { cwdKey: shape.cwdKey } : {}),
      };
    },
    encode(nativeName, input, patch) {
      const shape = shapeOf(shapes, normalize(nativeName));
      // A non-plain-object input is declined: `{...["a"]}` would silently
      // produce `{"0":"a"}` -- a garbage native input, not an honest refusal.
      if (shape === undefined || !isPlainObject(input)) return undefined;
      // Decline exactly when classify() would: an input whose command key is
      // not currently a string does not classify, so "reading works" stays
      // the one feature-detect signal for "writing works". Writing anyway
      // would fabricate a command on a payload we no longer understand.
      if (typeof input[shape.commandKey] !== "string") return undefined;
      return { ...input, [shape.commandKey]: patch.command };
    },
  };
}

/** Declarative matcher applied to tool-scoped events before handlers run. */
export interface ToolMatch {
  /** Match one or more normalized categories. */
  kind?: ToolKind | ToolKind[];
  /** Match exact native tool name(s). */
  nativeName?: string | string[];
}

export function matchesTool(match: ToolMatch | undefined, tool: ToolInvocation): boolean {
  if (!match) return true;
  if (match.kind !== undefined) {
    const kinds = Array.isArray(match.kind) ? match.kind : [match.kind];
    if (!kinds.includes(tool.kind)) return false;
  }
  if (match.nativeName !== undefined) {
    const names = Array.isArray(match.nativeName) ? match.nativeName : [match.nativeName];
    if (!names.includes(tool.nativeName)) return false;
  }
  return true;
}
