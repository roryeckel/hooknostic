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

  /**
   * The files a file tool targets, normalized, when the adapter knows this
   * tool's argument shape (ADR-0026).
   *
   * `kind` is portable but the path argument is not: Claude names it
   * `file_path`, OpenCode 1.x `filePath`, OpenCode 2.x `path`, and a Codex or
   * OpenCode patch tool carries its paths inside the patch text. Absent for an
   * uncaptured shape, for tools with no target file (glob/grep search), and
   * for anything the adapter cannot read with certainty -- fall back to
   * `input`, and decide whether a guard fails open or closed. File access
   * through a shell command is a shell call and never appears here.
   */
  file?: ToolFile;
}

/**
 * The normalized file view. `paths` holds every file the call targets, in the
 * order the tool names them and verbatim as the harness sent them -- relative
 * paths stay relative. `pathKey`/`patchKey` say which native argument they came
 * from, as data for the raw escape hatch.
 */
export interface ToolFile {
  paths: string[];
  /** The native argument naming the one target file, for a path-argument tool. */
  pathKey?: string;
  /** The native argument holding the patch the paths were parsed from. */
  patchKey?: string;
}

/**
 * One file tool's argument shape: an argument naming a single file, or an
 * argument holding patch text in the Codex patch grammar.
 */
export type FileShape = { readonly pathKey: string } | { readonly patchKey: string };

/** Native tool name -> file argument shape. Lookup is exact after `normalizeName`. */
export type FileShapes = Readonly<Record<string, FileShape>>;

export interface FileCodec {
  /** Derive the file view; `undefined` when uncaptured, mismatched or unparseable. */
  classify(nativeName: string, input: unknown): ToolFile | undefined;
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
function shapeOf<S>(shapes: Readonly<Record<string, S>>, key: string): S | undefined {
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

const PATCH_BEGIN = "*** Begin Patch";
const PATCH_END = "*** End Patch";
const PATCH_ENVIRONMENT = "*** Environment ID:";
const PATCH_END_OF_FILE = "*** End of File";
const PATCH_UPDATE = "*** Update File: ";
const PATCH_FILE_HEADERS = ["*** Add File: ", "*** Delete File: ", PATCH_UPDATE] as const;
const PATCH_MOVE = "*** Move to: ";

/**
 * Every file a patch in the Codex patch grammar targets, or `undefined` when
 * the text is not one.
 *
 * Mirrors the parser Codex runs (`codex-rs/apply-patch`), not just its lark
 * grammar, so the paths reported are the ones that will be written; captures
 * show OpenCode's `apply_patch`/`patch` tools take the same text. The whole
 * text and the envelope markers are trimmed; file headers match on the trimmed
 * line, so paths carry no surrounding whitespace; an environment header may
 * open the body; `Move to` counts only directly after an `Update File` header.
 * Strict where it matters, because a partial answer is worse than none: any
 * other `***` line is off-grammar and yields `undefined`. Hunk bodies are not
 * validated -- only headers name files. Paths come back in patch order,
 * de-duplicated; a patch with no file operation targets nothing (`[]`).
 */
export function parsePatchPaths(text: string): string[] | undefined {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2 || lines[0]!.trim() !== PATCH_BEGIN || lines[lines.length - 1]!.trim() !== PATCH_END) {
    return undefined;
  }
  const body = lines.slice(1, -1);
  if (body[0]?.trim().startsWith(PATCH_ENVIRONMENT)) body.shift();
  const paths: string[] = [];
  let afterUpdateHeader = false;
  for (const line of body) {
    const trimmed = line.trim();
    const header = PATCH_FILE_HEADERS.find((prefix) => trimmed.startsWith(prefix));
    if (header !== undefined) {
      const path = trimmed.slice(header.length);
      if (path === "") return undefined;
      paths.push(path);
      afterUpdateHeader = header === PATCH_UPDATE;
      continue;
    }
    const untrailed = line.trimEnd();
    if (untrailed.startsWith(PATCH_MOVE)) {
      const path = untrailed.slice(PATCH_MOVE.length);
      if (!afterUpdateHeader || path === "") return undefined;
      paths.push(path);
      afterUpdateHeader = false;
      continue;
    }
    // Hunk lines carry a +, - or space prefix, so " *** bold" is content; a bare
    // unknown marker is what Codex itself would refuse.
    if (line.startsWith("***") && untrailed !== PATCH_END_OF_FILE) return undefined;
    afterUpdateHeader = false;
  }
  return [...new Set(paths)];
}

/**
 * Build a file codec from a shape table. Read side only (ADR-0026): there is
 * no portable file rewrite, so unlike {@link shellCodec} there is no encode.
 * A name absent from the table yields no view -- uncaptured shapes are never
 * guessed.
 */
export function fileCodec(shapes: FileShapes, options?: { normalizeName?: (nativeName: string) => string }): FileCodec {
  const normalize = options?.normalizeName ?? ((name: string) => name);
  return {
    classify(nativeName, input) {
      const shape = shapeOf(shapes, normalize(nativeName));
      if (shape === undefined || !isPlainObject(input)) return undefined;
      if ("pathKey" in shape) {
        const path = input[shape.pathKey];
        return typeof path === "string" ? { paths: [path], pathKey: shape.pathKey } : undefined;
      }
      const patch = input[shape.patchKey];
      const paths = typeof patch === "string" ? parsePatchPaths(patch) : undefined;
      return paths === undefined ? undefined : { paths, patchKey: shape.patchKey };
    },
  };
}

/**
 * Read one string argument from a tool's native input by its native key.
 *
 * The deliberate escape hatch for harness-specific code. Keys differ per
 * harness (a file tool names its path `file_path` on Claude and `path` on
 * OpenCode v2), so a portable hook reading one key compiles everywhere and
 * silently matches nothing on the others. Pair this with a `nativeName` check,
 * and prefer the normalized views wherever they exist.
 *
 * Own properties of a plain-object input only; anything else -- a missing key,
 * a non-string value, a prototype member -- is `undefined`, never a coercion.
 */
export function rawInputString(tool: Pick<ToolInvocation, "input">, key: string): string | undefined {
  const { input } = tool;
  if (!isPlainObject(input) || !Object.hasOwn(input, key)) return undefined;
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

/** Declarative matcher applied to tool-scoped events before handlers run. */
export interface ToolMatch {
  /** Match one or more normalized categories. */
  kind?: ToolKind | readonly ToolKind[];
  /** Match exact native tool name(s). */
  nativeName?: string | readonly string[];
}

/**
 * The tool kinds a matcher admits: exactly the listed ones when it constrains
 * `kind`, every kind otherwise (a `nativeName`-only matcher says nothing about
 * the category). Narrows `event.tool.kind` inside a matched hook's handler.
 */
export type MatchedKind<M> = M extends { readonly kind: infer K }
  ? K extends ToolKind
    ? K
    : K extends readonly (infer Listed extends ToolKind)[]
      ? Listed
      : ToolKind
  : ToolKind;

function listOf<T>(value: T | readonly T[]): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : [value as T];
}

export function matchesTool(match: ToolMatch | undefined, tool: ToolInvocation): boolean {
  if (!match) return true;
  if (match.kind !== undefined && !listOf(match.kind).includes(tool.kind)) return false;
  if (match.nativeName !== undefined && !listOf(match.nativeName).includes(tool.nativeName)) return false;
  return true;
}
