import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, fsync } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { applyEdits, modify, type Node as JsonNode, type ParseError, parseTree } from "jsonc-parser/lib/esm/main.js";

import type { AgentPluginComponentId, AgentPluginDegradation, AgentPluginDeviation } from "@hooknostic/agent-plugin";

import { recordsFileModes } from "./file-modes.js";
import { editProjectToml, readProjectToml } from "./project-toml.js";

export interface ProjectFile {
  path: string;
  contents: string | Uint8Array;
  mode?: number;
}
export interface ProjectEntry {
  format?: "jsonc" | "toml";
  path: string;
  key: string[];
  /**
   * `property` owns the value at `key`; `array` owns one element of the array
   * there. `members` owns string members of the array there and leaves every
   * other member alone: `value` is the list of names Hooknostic needs present,
   * and only the ones it added are removed again.
   */
  kind: "array" | "property" | "members";
  value: unknown;
  /**
   * Marks an entry in a file several harnesses read natively, such as a root
   * `.mcp.json` that Claude Code and GitHub Copilot CLI both load. Targets that
   * emit the same path and key compose into one entry, the first target's,
   * when every emitter shares it with the same string: each value is then
   * correct for every reader. Different strings, or a duplicate that does not
   * share, are a conflict, because the file can hold one value per key
   * (ADR-0033).
   */
  share?: string;
}
export interface ProjectComponentOmission {
  component: AgentPluginComponentId;
  name: string;
  reason: string;
}
/**
 * A key an unowned document must not hold. With `fold`, the last segment also
 * matches any sibling key that folds to the same string, for a harness that
 * treats such names as one entry.
 */
export interface AbsentKey {
  path: string;
  key: string[];
  fold?: (segment: string) => string;
}
export interface ProjectIntegration {
  files: ProjectFile[];
  entries: ProjectEntry[];
  guidance: string[];
  absent?: AbsentKey[];
  /**
   * Creating `path` changes discovery from `fallback` to that file. Refuse
   * creation if the fallback's object at `key` contains authored entries;
   * an existing primary file or an empty fallback needs no migration.
   */
  discoveryFallbacks?: { path: string; fallback: string; key: string[] }[];
  /** An omitted copy must not leave an unowned native skill discoverable. */
  omittedFiles?: readonly string[];
  omissions?: ProjectComponentOmission[];
  /**
   * Emitted entries the harness will treat differently from the specification.
   * Core applies `components.onDeviation`; each id must be declared in
   * `ProjectComponentOptions.support` (ADR-0019).
   */
  deviations?: AgentPluginDeviation[];
  /**
   * Emitted items the target cannot deliver at their component's level, such
   * as a skill reference it shows as written. Core applies
   * `components.onDegraded`; each id must be declared in
   * `ProjectComponentOptions.support` (ADR-0022).
   */
  degradations?: AgentPluginDegradation[];
  /**
   * Declared-executable files inside a tree this target discovers in place.
   *
   * Hooknostic owns nothing there, so it cannot honour the declaration -- and
   * must not try. ADR-0013 is a pair of rules, 0755 on declared files *and*
   * 0644 on every other file; applying it to a tree the author owns would
   * strip `+x` from files they set themselves. Reported instead, because the
   * same declaration is usually live on the other targets.
   */
  unappliedModes?: { skill: string; path: string }[];
  /** Preserve these files while removing any prior whole-file ownership. */
  relinquishFiles?: string[];
  /** Preserve every previously owned whole file below these directories while removing ownership. */
  relinquishPrefixes?: string[];
}
interface Owned {
  format?: "jsonc" | "toml";
  path: string;
  hash: string;
  key?: string[];
  kind?: "array" | "property" | "members";
  context?: string[];
  mode?: number;
}
interface Manifest {
  schemaVersion: 1;
  config: string;
  owned: Owned[];
}
export interface FileChange {
  path: string;
  before: Buffer | null;
  after: Buffer | null;
  mode: number;
  beforeMode?: number;
}
export interface ProjectFilePrecondition {
  path: string;
  before: Buffer | null;
}
export interface Reconciliation {
  changes: FileChange[];
  manifest: Manifest;
  preconditions: ProjectFilePrecondition[];
}
const STATE = ".hooknostic/integration.json";
const JOURNAL = ".hooknostic/transaction.json";
const LOCK = ".hooknostic/sync.lock";
const RECOVERY_LOCK = ".hooknostic/recovery.lock";
/** Whole-file ownership used when distinguishing authored discovery from stale generated copies. */
export async function ownedProjectFiles(root: string, config: string): Promise<ReadonlySet<string>> {
  const manifest = readManifest(await bytes(await projectPath(root, STATE)), config);
  return new Set(manifest.owned.filter((entry) => entry.key === undefined).map((entry) => entry.path));
}
export const fileHash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const valueHash = (value: unknown): string => fileHash(canonical(value));
const identity = (entry: Pick<Owned, "path" | "key">): string => JSON.stringify([entry.path, entry.key ?? null]);
function validatePath(path: string): void {
  if (
    typeof path !== "string" ||
    isAbsolute(path) ||
    /[:"<>|?*]/.test(path) ||
    [...path].some((character) => character.charCodeAt(0) < 32) ||
    path.includes("\\") ||
    path
      .split("/")
      .some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          p.toLowerCase() === ".git" ||
          /[. ]$/.test(p) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p) ||
          /^\.env(?:\.|$)/i.test(p),
      )
  )
    throw new Error(`unsafe project path: ${path}`);
}
function validateDestination(path: string): void {
  validatePath(path);
  if (
    [STATE, JOURNAL, LOCK, RECOVERY_LOCK].includes(path.toLowerCase()) ||
    /^\.hooknostic\/(?:data|staging)(?:\/|$)/i.test(path)
  )
    throw new Error(`reserved integration destination: ${path}`);
}
function pathAtOrBelow(path: string, prefix: string): boolean {
  const candidate = path.toLowerCase();
  const directory = prefix.toLowerCase();
  return candidate === directory || candidate.startsWith(`${directory}/`);
}
export async function projectPath(root: string, path: string): Promise<string> {
  validatePath(path);
  const canonicalRoot = await realpath(root);
  let cursor = canonicalRoot;
  for (const part of path.split("/")) {
    cursor = join(cursor, part);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error(`project destination is a symbolic link: ${path}`);
      const actual = await realpath(cursor);
      const rel = relative(canonicalRoot, actual);
      if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
        throw new Error(`project path escapes root: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return cursor;
}
async function bytes(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
interface FileState {
  contents: Buffer | null;
  mode?: number;
}
// A filesystem that keeps no permission bits (Windows, or WSL's DrvFs without
// `metadata`) reports no mode, so only content is compared there (#248).
async function fileState(path: string): Promise<FileState> {
  const contents = await bytes(path);
  if (contents === null || !(await recordsFileModes(path))) return { contents };
  return { contents, mode: (await lstat(path)).mode & 0o777 };
}
function sameState(left: FileState, right: FileState): boolean {
  if (!same(left.contents, right.contents)) return false;
  if (process.platform === "win32" || left.contents === null || right.contents === null) return true;
  // Older schema-v1 journals did not necessarily record a preimage mode. An
  // absent mode therefore remains a wildcard for compatibility; new plans and
  // journals always capture it for existing files.
  return left.mode === undefined || right.mode === undefined || left.mode === right.mode;
}
// Owned files are committed, and git checks 0644 and 0755 out as 0666 or 0777
// less the local umask, which cannot add an execute bit. Any other expected mode
// (e.g. 0600) is compared exactly, as are a new request and a transaction.
function sameCommittedMode(observed: number, expected: number): boolean {
  if (expected === 0o644) return (observed & 0o111) === 0;
  if (expected === 0o755) return (observed & 0o100) !== 0;
  return observed === expected;
}
function beforeState(change: Pick<FileChange, "before" | "beforeMode">): FileState {
  return { contents: change.before, ...(change.beforeMode === undefined ? {} : { mode: change.beforeMode }) };
}
function dataObject(): Record<string, unknown> {
  return {};
}
function define(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}
function jsonNodeValue(node: JsonNode): unknown {
  if (node.type === "array") return (node.children ?? []).map(jsonNodeValue);
  if (node.type === "object") {
    const value = dataObject();
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const [key, child] = property.children ?? [];
      if (key?.type !== "string" || child === undefined) throw new Error("invalid JSONC property node");
      const name = String(key.value);
      if (seen.has(name)) throw new Error(`duplicate JSONC property ${JSON.stringify(name)}`);
      seen.add(name);
      define(value, name, jsonNodeValue(child));
    }
    return value;
  }
  return node.value;
}
function document(text: string, path: string, format?: "jsonc" | "toml"): Record<string, unknown> {
  if (format === "toml") return readProjectToml(text);
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true });
  if (errors.length || tree?.type !== "object") throw new Error(`invalid object document: ${path}`);
  return jsonNodeValue(tree) as Record<string, unknown>;
}
function get(value: unknown, key: string[]): unknown {
  for (const part of key) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
/** The key an absent check finds present, under its fold when it has one. */
function presentKey(value: unknown, check: AbsentKey): string[] | undefined {
  const { key, fold } = check;
  if (fold === undefined || key.length === 0) return get(value, key) === undefined ? undefined : key;
  const parent = get(value, key.slice(0, -1));
  if (!parent || typeof parent !== "object" || Array.isArray(parent)) return undefined;
  const wanted = fold(key.at(-1)!);
  const found = Object.keys(parent).find(
    (name) => fold(name) === wanted && (parent as Record<string, unknown>)[name] !== undefined,
  );
  return found === undefined ? undefined : [...key.slice(0, -1), found];
}
function edit(text: string, key: (string | number)[], value: unknown): string {
  return applyEdits(
    text,
    modify(text, key, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" },
    }),
  );
}
function readManifest(raw: Buffer | null, config: string): Manifest {
  if (!raw) return { schemaVersion: 1, config, owned: [] };
  const value = JSON.parse(raw.toString()) as Manifest;
  if (value.schemaVersion !== 1 || value.config !== config || !Array.isArray(value.owned))
    throw new Error("integration ownership belongs to another configuration or has an unsupported schema");
  const seen = new Set<string>();
  for (const entry of value.owned) {
    if (!entry || typeof entry !== "object") throw new Error("invalid integration ownership entry");
    validatePath(entry.path);
    if (
      !/^[a-f0-9]{64}$/.test(entry.hash) ||
      (entry.key !== undefined &&
        (!Array.isArray(entry.key) || entry.key.length === 0 || entry.key.some((k) => typeof k !== "string")))
    )
      throw new Error("invalid integration ownership entry");
    if (entry.key !== undefined && entry.kind !== "array" && entry.kind !== "property" && entry.kind !== "members")
      throw new Error("invalid integration entry kind");
    if (
      entry.context !== undefined &&
      (!Array.isArray(entry.context) || entry.context.some((hash) => !/^[a-f0-9]{64}$/.test(hash)))
    )
      throw new Error("invalid ownership context");
    if (entry.format !== undefined && entry.format !== "jsonc" && entry.format !== "toml")
      throw new Error("invalid ownership format");
    const id = identity(entry);
    if (seen.has(id)) throw new Error("duplicate integration ownership entry");
    seen.add(id);
  }
  return value;
}

export class GeneratedFileConflictError extends Error {
  readonly paths: readonly string[];

  constructor(paths: readonly string[]) {
    const sorted = [...new Set(paths)].sort();
    super(sorted.map((path) => `unowned or modified generated file: ${path}`).join("\n"));
    this.name = "GeneratedFileConflictError";
    this.paths = sorted;
  }
}

export async function reconcileProject(
  root: string,
  config: string,
  integration: ProjectIntegration,
): Promise<Reconciliation> {
  validatePath(config);
  const observedAbsentFiles = new Map<string, Buffer | null>();
  const absentDocuments = new Map<string, Record<string, unknown>>();
  for (const check of integration.absent ?? []) {
    let raw = observedAbsentFiles.get(check.path);
    if (raw === undefined && !observedAbsentFiles.has(check.path)) {
      raw = await bytes(await projectPath(root, check.path));
      observedAbsentFiles.set(check.path, raw);
    }
    if (!raw) continue;
    let parsed = absentDocuments.get(check.path);
    if (parsed === undefined) {
      parsed = document(raw.toString(), check.path);
      absentDocuments.set(check.path, parsed);
    }
    const collision = presentKey(parsed, check);
    if (collision !== undefined) throw new Error(`unowned component collision: ${check.path}:${collision.join(".")}`);
  }
  if (await bytes(await projectPath(root, JOURNAL)))
    throw new Error("unfinished integration transaction; run hooknostic recover");
  const manifestState = await fileState(await projectPath(root, STATE));
  const manifestBytes = manifestState.contents;
  const prior = readManifest(manifestBytes, config);
  for (const path of integration.omittedFiles ?? []) {
    validateDestination(path);
    const raw = await bytes(await projectPath(root, path));
    observedAbsentFiles.set(path, raw);
    if (raw && !prior.owned.some((entry) => entry.path === path && entry.key === undefined)) {
      throw new Error(
        `cannot omit an unowned native skill: ${path}; move the authored source to a separate directory such as skills/`,
      );
    }
  }
  const previous = new Map(prior.owned.map((entry) => [identity(entry), entry]));
  const desired = new Map<string, ProjectFile | ProjectEntry>();
  const relinquished = new Set(integration.relinquishFiles ?? []);
  const relinquishPrefixes = [...new Set(integration.relinquishPrefixes ?? [])];
  for (const path of relinquished) validateDestination(path);
  for (const prefix of relinquishPrefixes) {
    validateDestination(prefix);
    for (const entry of prior.owned) {
      if (!pathAtOrBelow(entry.path, prefix)) continue;
      if (entry.key !== undefined) throw new Error(`cannot relinquish structural ownership below prefix: ${prefix}`);
      relinquished.add(entry.path);
    }
  }
  for (const entry of [...integration.files, ...integration.entries]) {
    validateDestination(entry.path);
    if ("key" in entry && (!entry.key.length || entry.key.some((k) => typeof k !== "string")))
      throw new Error("unsafe structural key");
    const id = identity(entry);
    const sameDestination = desired.get(id);
    if (sameDestination) {
      if (
        "contents" in sameDestination &&
        "contents" in entry &&
        fileHash(sameDestination.contents) === fileHash(entry.contents) &&
        (sameDestination.mode ?? 0o644) === (entry.mode ?? 0o644)
      )
        continue;
      const existingShare = "share" in sameDestination ? sameDestination.share : undefined;
      const share = "share" in entry ? entry.share : undefined;
      if (existingShare !== undefined && share !== undefined && "key" in entry) {
        if (existingShare === share) continue;
        throw new Error(
          `conflicting shared entry: ${entry.path}:${entry.key.join(".")} is read by more than one harness, ` +
            "and the targets that write it define it differently",
        );
      }
      throw new Error(`duplicate integration destination: ${entry.path}`);
    }
    desired.set(id, entry);
  }
  for (const check of integration.discoveryFallbacks ?? []) {
    if (![...desired.values()].some((entry) => entry.path === check.path)) continue;
    const primary = await bytes(await projectPath(root, check.path));
    observedAbsentFiles.set(check.path, primary);
    if (primary !== null) continue;
    const fallback = await bytes(await projectPath(root, check.fallback));
    // Preserve the observation through applyProject: a fallback added or
    // populated after planning must not be hidden by this transaction either.
    observedAbsentFiles.set(check.fallback, fallback);
    if (fallback === null) continue;
    const entries = get(document(fallback.toString(), check.fallback), check.key);
    if (entries && typeof entries === "object" && !Array.isArray(entries) && Object.keys(entries).length > 0)
      throw new Error(
        `configuration conflict: creating ${check.path} would hide existing entries in ` +
          `${check.fallback}:${check.key.join(".")}; migrate those entries to ${check.path} before synchronizing`,
      );
  }
  for (const path of relinquished) {
    if ([...desired.values()].some((entry) => entry.path.toLowerCase() === path.toLowerCase()))
      throw new Error(`cannot generate and relinquish the same project path: ${path}`);
  }
  for (const prefix of relinquishPrefixes) {
    if ([...desired.values()].some((entry) => pathAtOrBelow(entry.path, prefix)))
      throw new Error(`cannot generate below relinquished project prefix: ${prefix}`);
  }
  const paths = new Set([
    ...prior.owned.map((e) => e.path),
    ...[...desired.values()].map((e) => e.path),
    ...relinquished,
  ]);
  const pathNames = [...paths];
  for (const path of pathNames)
    for (const other of pathNames) {
      if (path === other) continue;
      if (path.toLowerCase() === other.toLowerCase() || other.toLowerCase().startsWith(path.toLowerCase() + "/"))
        throw new Error(`colliding project destinations: ${path} and ${other}`);
    }
  // Collect whole-file conflicts before structural reconciliation can hide later
  // paths. Reuse these observations so planning uses the same bytes and modes.
  const observations = [];
  const conflicts: string[] = [];
  for (const path of [...paths].sort()) {
    const observed = await fileState(await projectPath(root, path));
    const before = observed.contents;
    const oldEntries = prior.owned.filter((e) => e.path === path);
    const nextEntries = [...desired.values()].filter((e) => e.path === path);
    const whole = nextEntries.find((e) => !("key" in e));
    const oldWhole = oldEntries.find((e) => e.key === undefined);
    if (relinquished.has(path)) {
      if (oldEntries.some((entry) => entry.key !== undefined))
        throw new Error(`cannot relinquish structural ownership as a file: ${path}`);
      continue;
    }
    if (whole || oldWhole) {
      if (nextEntries.length > 1 || oldEntries.length > 1 || nextEntries.some((e) => "key" in e))
        throw new Error(`overlapping file and entry ownership: ${path}`);
      if (
        before &&
        (!oldWhole ||
          fileHash(before) !== oldWhole.hash ||
          (observed.mode !== undefined &&
            oldWhole.mode !== undefined &&
            !sameCommittedMode(observed.mode, oldWhole.mode)))
      )
        conflicts.push(path);
    }
    observations.push({ path, observed, oldEntries, nextEntries, whole, oldWhole });
  }
  if (conflicts.length > 0) throw new GeneratedFileConflictError(conflicts);

  const owned: Owned[] = [];
  const changes: FileChange[] = [];
  for (const { path, observed, oldEntries, nextEntries, whole, oldWhole } of observations) {
    const before = observed.contents;
    let after: Buffer | null = before;
    const beforeMode = observed.mode ?? 0o644;
    let mode = beforeMode;
    let modeRequested = false;
    if (whole || oldWhole) {
      if (whole && "contents" in whole) {
        after = Buffer.from(whole.contents);
        mode = whole.mode ?? 0o644;
        modeRequested = oldWhole?.mode !== undefined && oldWhole.mode !== mode;
        owned.push({ path, hash: fileHash(after), mode });
      } else after = null;
    } else {
      const formats = new Set(
        [...oldEntries, ...nextEntries].map((entry) => (entry as ProjectEntry).format ?? "jsonc"),
      );
      if (formats.size !== 1) throw new Error(`conflicting structural formats: ${path}`);
      const format = [...formats][0]!;
      const update = (text: string, key: (string | number)[], value: unknown) =>
        format === "toml" ? editProjectToml(text, key as string[], value) : edit(text, key, value);
      let text = before?.toString("utf8") ?? (format === "toml" ? "" : "{}\n");
      const structural = [...oldEntries, ...nextEntries.filter((e): e is ProjectEntry => "key" in e)];
      for (const a of structural)
        for (const b of structural) {
          if (a.key && b.key && a.key.length < b.key.length && a.key.every((k, i) => k === b.key![i]))
            throw new Error(`overlapping structural ownership: ${path}`);
        }
      const keys = new Set([...oldEntries.map(identity), ...nextEntries.map(identity)]);
      for (const id of [...keys].sort()) {
        const old = previous.get(id);
        const next = desired.get(id) as ProjectEntry | undefined;
        const key = next?.key ?? old!.key!;
        const kind = next?.kind ?? old!.kind!;
        const current = get(document(text, path, format), key);
        let context: string[] | undefined;
        if (format === "toml" && kind !== "property") throw new Error("TOML supports property ownership only");
        if (kind === "members") {
          if (current !== undefined && (!Array.isArray(current) || current.some((v) => typeof v !== "string")))
            throw new Error(`expected an array of strings at ${path}:${key.join(".")}`);
          const values = (current as string[] | undefined) ?? [];
          // Members recorded (by hash) as added last time are Hooknostic's; every
          // other member belongs to the author and is kept as written.
          const previous = new Set(old?.context ?? []);
          const kept = values.filter((member) => !previous.has(valueHash(member)));
          const wanted = next === undefined ? [] : (next.value as string[]);
          const added = wanted.filter((member, index) => !kept.includes(member) && wanted.indexOf(member) === index);
          const result = [...kept, ...added];
          context = added.map(valueHash);
          if (JSON.stringify(result) !== JSON.stringify(values))
            text = update(text, key, result.length === 0 && kept.length === 0 ? undefined : result);
        } else if (kind === "array") {
          if (current !== undefined && !Array.isArray(current))
            throw new Error(`expected array at ${path}:${key.join(".")}`);
          const values: unknown[] = (current as unknown[]) ?? [];
          const matches = old ? values.flatMap((v, i) => (valueHash(v) === old.hash ? [i] : [])) : [];
          if (
            old &&
            (matches.length > 1 ||
              (matches.length === 0 &&
                values.length > 0 &&
                JSON.stringify(values.map(valueHash)) !== JSON.stringify(old.context)))
          )
            throw new Error(`modified or ambiguous owned entry: ${path}:${key.join(".")}`);
          if (next && values.some((v, i) => !matches.includes(i) && valueHash(v) === valueHash(next.value)))
            throw new Error(`unowned matching entry: ${path}:${key.join(".")}`);
          context = values.filter((_, i) => !matches.includes(i)).map(valueHash);
          if (matches.length) {
            if (!next || valueHash(next.value) !== old!.hash) text = update(text, [...key, matches[0]!], next?.value);
          } else if (next) {
            text =
              current === undefined
                ? update(text, key, [next.value])
                : update(text, [...key, values.length], next.value);
          }
        } else {
          if (current !== undefined && (!old || valueHash(current) !== old.hash))
            throw new Error(`unowned or modified setting: ${path}:${key.join(".")}`);
          if (
            (next || current !== undefined) &&
            !(next && current !== undefined && valueHash(current) === valueHash(next.value))
          )
            text = update(text, key, next?.value);
        }
        if (next)
          owned.push({
            path,
            key,
            kind,
            ...(format === "toml" ? { format } : {}),
            hash: valueHash(next.value),
            ...(context === undefined ? {} : { context }),
          });
      }
      after = before === null && nextEntries.length === 0 ? null : Buffer.from(text);
    }
    if (
      !same(before, after) ||
      (observed.mode !== undefined && (modeRequested || !sameCommittedMode(beforeMode, mode)))
    )
      changes.push({ path, before, after, mode, beforeMode });
  }
  const manifest: Manifest = {
    schemaVersion: 1,
    config,
    owned: owned.sort((a, b) => (identity(a) < identity(b) ? -1 : identity(a) > identity(b) ? 1 : 0)),
  };
  const afterManifest = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  // The `?? 0o644` fallback is what keeps an unobserved manifest mode (Windows,
  // or DrvFs without `metadata`) from planning a rewrite on every run (#248);
  // the platform test alone would not.
  if (
    !same(manifestBytes, afterManifest) ||
    (process.platform !== "win32" && manifestBytes !== null && !sameCommittedMode(manifestState.mode ?? 0o644, 0o644))
  ) {
    changes.push({
      path: STATE,
      before: manifestBytes,
      after: afterManifest,
      mode: 0o644,
      ...(manifestState.mode === undefined ? {} : { beforeMode: manifestState.mode }),
    });
  }
  const preconditions = [...observedAbsentFiles]
    .map(([path, before]) => ({ path, before }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { changes, manifest, preconditions };
}
function same(a: Buffer | null, b: Buffer | null): boolean {
  return a === null ? b === null : b !== null && a.equals(b);
}
interface JournalEntry {
  path: string;
  before: string | null;
  afterHash: string | null;
  mode: number;
  beforeMode?: number;
}
interface Journal {
  schemaVersion: 1;
  config: string;
  entries: JournalEntry[];
}
async function replace(
  root: string,
  path: string,
  value: Buffer | null,
  mode: number,
  expected?: FileState,
  staged?: string,
): Promise<void> {
  const destination = await projectPath(root, path);
  if (expected !== undefined && !sameState(await fileState(destination), expected))
    throw new Error(`write precondition changed: ${path}`);
  if (value === null) {
    await rm(destination, { force: true });
    return;
  }
  await mkdir(dirname(destination), { recursive: true });
  const temp = staged ?? (await stage(root, value, mode));
  try {
    await projectPath(root, path);
    if (expected !== undefined && !sameState(await fileState(destination), expected))
      throw new Error(`write precondition changed: ${path}`);
    await rename(temp, destination);
  } finally {
    await rm(temp, { force: true });
  }
}
/**
 * Creates `path` exclusively, writes `value`, flushes it to disk and closes
 * it. If anything after the create fails, the file is removed again, so a
 * failed lock or staged file never outlives the error. A failed create
 * removes nothing: the file belongs to whoever created it, such as a
 * concurrent synchronization holding the lock.
 *
 * The flush is `fs.fsync` on the handle's descriptor rather than
 * `FileHandle.sync()`, the same system call on Node. Yarn Plug'n'Play's
 * patched `FileHandle` throws "Method not implemented." from `sync()` and
 * `datasync()`, but leaves `fs.fsync` unpatched and gives a file outside a
 * mounted archive its real descriptor (#229). A project inside a Yarn-mounted
 * archive would get a remapped descriptor instead; project files never live
 * there.
 *
 * `chmod` applies `mode` exactly, past a restrictive umask, as a staged file
 * needs; the lock keeps the mode its open gives it, as it always has. Windows
 * has no such bits.
 */
async function createFlushed(path: string, value: Buffer | string, mode: number, chmod: boolean): Promise<void> {
  const handle = await open(path, "wx", mode);
  try {
    try {
      if (chmod && process.platform !== "win32") await handle.chmod(mode);
      await handle.writeFile(value);
      await new Promise<void>((resolve, reject) => fsync(handle.fd, (error) => (error ? reject(error) : resolve())));
    } catch (error) {
      // Never mask the first error with a failed close.
      await handle.close().catch(() => undefined);
      throw error;
    }
    await handle.close();
  } catch (error) {
    // Nor with a failed cleanup.
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}
async function stage(root: string, value: Buffer, mode: number): Promise<string> {
  const temp = await projectPath(root, `.hooknostic/staging/${randomUUID()}`);
  await mkdir(dirname(temp), { recursive: true });
  await createFlushed(temp, value, mode, true);
  return temp;
}
/**
 * Takes the lock `name` by creating it with this process's pid. A lock that
 * already exists becomes an error that names `hooknostic recover`; it keeps
 * the raw error as `cause` and its `code` and `path`, so a caller that checks
 * for EEXIST still sees it. The messages hedge on purpose: recover removes a
 * lock only when it was left by a process that has exited (`clearDeadLock`),
 * and refuses one whose process may be alive or that holds no valid pid.
 * Recover clears a dead recovery lock before taking its own, so it meets an
 * existing one here only when another recover created it in between.
 */
async function acquire(root: string, name = LOCK): Promise<() => Promise<void>> {
  const lock = await projectPath(root, name);
  await mkdir(dirname(lock), { recursive: true });
  try {
    await createFlushed(lock, String(process.pid), 0o600, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw Object.assign(
        new Error(
          name === LOCK
            ? `another hooknostic sync or recover may be running: ${lock} exists; if neither is, run hooknostic recover with the same configuration, which removes a lock left by a process that has exited`
            : `another hooknostic recover may be running: ${lock} exists; rerun hooknostic recover, which removes a lock left by a process that has exited`,
          { cause: error },
        ),
        { code: "EEXIST", path: lock },
      );
    throw error;
  }
  return () => rm(lock, { force: true });
}
async function verifyPreconditions(root: string, preconditions: readonly ProjectFilePrecondition[]): Promise<void> {
  for (const precondition of preconditions) {
    if (!same(await bytes(await projectPath(root, precondition.path)), precondition.before)) {
      throw new Error(`project changed during planning: ${precondition.path}`);
    }
  }
}
export async function applyProject(root: string, config: string, plan: Reconciliation): Promise<void> {
  const release = await acquire(root);
  let journalWritten = false;
  const staged = new Map<string, string>();
  try {
    if (await bytes(await projectPath(root, JOURNAL)))
      throw new Error("unfinished transaction; run hooknostic recover");
    await verifyPreconditions(root, plan.preconditions);
    for (const change of plan.changes)
      if (!sameState(await fileState(await projectPath(root, change.path)), beforeState(change)))
        throw new Error(`project changed during planning: ${change.path}`);
    if (!plan.changes.length) return;
    for (const change of plan.changes)
      if (change.after !== null) staged.set(change.path, await stage(root, change.after, change.mode));
    await verifyPreconditions(root, plan.preconditions);
    const journal: Journal = {
      schemaVersion: 1,
      config,
      entries: plan.changes.map((c) => ({
        path: c.path,
        before: c.before?.toString("base64") ?? null,
        afterHash: c.after === null ? null : fileHash(c.after),
        mode: c.mode,
        ...(c.beforeMode === undefined ? {} : { beforeMode: c.beforeMode }),
      })),
    };
    await replace(root, JOURNAL, Buffer.from(JSON.stringify(journal)), 0o600);
    journalWritten = true;
    for (const change of plan.changes) {
      const expected = beforeState(change);
      if (!sameState(await fileState(await projectPath(root, change.path)), expected))
        throw new Error(`project changed during synchronization: ${change.path}`);
      await replace(root, change.path, change.after, change.mode, expected, staged.get(change.path));
    }
    await rm(await projectPath(root, JOURNAL));
  } catch (error) {
    if (journalWritten) await restore(root, config);
    throw error;
  } finally {
    try {
      for (const path of staged.values()) await rm(path, { force: true });
    } finally {
      await release();
    }
  }
}
async function restore(root: string, config: string): Promise<void> {
  const raw = await bytes(await projectPath(root, JOURNAL));
  if (!raw) return;
  const journal = JSON.parse(raw.toString()) as Journal;
  if (journal.schemaVersion !== 1 || journal.config !== config || !Array.isArray(journal.entries))
    throw new Error("invalid recovery journal");
  const actions: { entry: JournalEntry; before: FileState; current: FileState }[] = [];
  const seen = new Set<string>();
  for (const entry of journal.entries) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      seen.has(entry.path) ||
      [JOURNAL, LOCK, RECOVERY_LOCK].includes(entry.path) ||
      (entry.before !== null && typeof entry.before !== "string") ||
      (entry.afterHash !== null && !/^[a-f0-9]{64}$/.test(entry.afterHash)) ||
      !Number.isInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o777 ||
      (entry.beforeMode !== undefined &&
        (!Number.isInteger(entry.beforeMode) || entry.beforeMode < 0 || entry.beforeMode > 0o777))
    )
      throw new Error("invalid recovery journal entry");
    seen.add(entry.path);
    const beforeContents = entry.before === null ? null : Buffer.from(entry.before, "base64");
    const before: FileState = {
      contents: beforeContents,
      ...(entry.beforeMode === undefined ? {} : { mode: entry.beforeMode }),
    };
    const current = await fileState(await projectPath(root, entry.path));
    const matchesAfter =
      entry.afterHash === null
        ? current.contents === null
        : current.contents !== null &&
          fileHash(current.contents) === entry.afterHash &&
          (current.mode === undefined || current.mode === entry.mode);
    if (!sameState(current, before) && !matchesAfter)
      throw new Error(
        `recovery conflict at ${entry.path}; preserve the journal and resolve the external edit manually`,
      );
    actions.push({ entry, before, current });
  }
  for (const { entry, before, current } of actions.reverse()) {
    if (!sameState(await fileState(await projectPath(root, entry.path)), current))
      throw new Error(`recovery precondition changed: ${entry.path}`);
    if (!sameState(current, before))
      await replace(root, entry.path, before.contents, before.mode ?? entry.mode, current);
  }
  await rm(await projectPath(root, JOURNAL));
}
/** Who may hold each lock, as the messages about it name them. */
const LOCK_HOLDERS: Readonly<Record<string, string>> = { [LOCK]: "sync or recover", [RECOVERY_LOCK]: "recover" };
/**
 * How old an empty lock must be before recover treats it as left by a hard
 * kill between its creation and the write of its pid (`createFlushed`), a
 * window of one write. A younger one may belong to a live process about to
 * write its pid; an mtime in the future, from a skewed clock, counts as young.
 */
const EMPTY_LOCK_AGE_MS = 10_000;
interface LockState {
  stat: BigIntStats;
  contents: Buffer;
}
function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}
async function lockState(path: string): Promise<LockState | null> {
  try {
    return { stat: await lstat(path, { bigint: true }), contents: await readFile(path) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
/**
 * Removes the lock `name` when the process that created it has exited, so a
 * hard kill during sync or recover does not block recover for good (#267).
 *
 * - The lock is judged by its pid: `process.kill(pid, 0)` failing with ESRCH
 *   means no such process. Success or EPERM (a process this one may not
 *   signal, such as another user's or an elevated one on Windows) counts as
 *   alive. A pid reused by an unrelated process therefore makes recover
 *   refuse, never take a live lock; the message names the pid and the path so
 *   the user can check and delete the file.
 * - An empty lock is what a kill between creating it and writing the pid
 *   leaves; it counts as dead once it is `EMPTY_LOCK_AGE_MS` old.
 * - The lock is claimed by renaming it into `.hooknostic/staging/` and then
 *   checked to be the very file judged dead (same inode, mtime and bytes)
 *   before it is removed. A plain check-then-remove could remove a lock that a
 *   peer created in between: two recovers both judging the same dead recovery
 *   lock, or a sync taking the sync lock after someone deleted a dead one. A
 *   claimed file that turns out to be a peer's is renamed back and recover
 *   stops. That rename replaces whatever is at the lock path, so a third
 *   process that created the lock in that instant would lose it: concurrent
 *   recovers are best-effort, not serialized.
 * - The staging directory is created first, so an ENOENT from the rename can
 *   only mean the lock itself is gone, taken by a peer; the lock is then
 *   contended for normally by `acquire`. A claim left by a crash stays in
 *   staging, which `.hooknostic/.gitignore` ignores wherever it exists and
 *   nothing reads.
 * - A process in another pid namespace (WSL and Windows sharing a checkout, a
 *   container with a bind mount, two hosts on a network share) looks dead from
 *   here. Recover cannot tell, so it must be run from one environment at a
 *   time.
 */
async function clearDeadLock(root: string, name: string): Promise<void> {
  const holder = LOCK_HOLDERS[name];
  const path = await projectPath(root, name);
  const seen = await lockState(path);
  if (!seen) return;
  if (seen.contents.length === 0) {
    if (Date.now() - Number(seen.stat.mtimeMs) < EMPTY_LOCK_AGE_MS)
      throw new Error(
        `${path} is empty and less than ten seconds old, so the hooknostic process creating it may not have written its PID yet; rerun hooknostic recover in a few seconds`,
      );
  } else {
    const pid = Number(seen.contents.toString());
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error(
        `invalid lock: ${path} holds no process ID; inspect it, and if no hooknostic sync or recover is running, delete it and rerun hooknostic recover`,
      );
    if (processRunning(pid))
      throw new Error(
        `a hooknostic ${holder} is still running: PID ${pid} holds ${path}; if no such process exists (its PID may have been reused), delete that file and rerun hooknostic recover`,
      );
  }
  const claim = await projectPath(root, `.hooknostic/staging/${randomUUID()}`);
  await mkdir(dirname(claim), { recursive: true });
  try {
    await rename(path, claim);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const claimed = await lockState(claim);
  if (
    claimed &&
    claimed.stat.ino === seen.stat.ino &&
    claimed.stat.mtimeNs === seen.stat.mtimeNs &&
    claimed.contents.equals(seen.contents)
  ) {
    await rm(claim, { force: true });
    return;
  }
  if (claimed) await rename(claim, path);
  throw new Error(
    `another hooknostic ${holder} is running: it took ${path} while recover was checking it; rerun hooknostic recover after it finishes`,
  );
}
export async function recoverProject(root: string, config: string): Promise<void> {
  validatePath(config);
  await clearDeadLock(root, RECOVERY_LOCK);
  const recoveryRelease = await acquire(root, RECOVERY_LOCK);
  try {
    await clearDeadLock(root, LOCK);
    const release = await acquire(root);
    try {
      await restore(root, config);
    } finally {
      await release();
    }
  } finally {
    await recoveryRelease();
  }
}
