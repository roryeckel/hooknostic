import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { applyEdits, modify, type Node as JsonNode, type ParseError, parseTree } from "jsonc-parser/lib/esm/main.js";

import type { AgentPluginComponentId } from "@hooknostic/agent-plugin";

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
  kind: "array" | "property";
  value: unknown;
}
export interface ProjectComponentOmission {
  component: AgentPluginComponentId;
  name: string;
  reason: string;
}
export interface ProjectIntegration {
  files: ProjectFile[];
  entries: ProjectEntry[];
  guidance: string[];
  absent?: { path: string; key: string[] }[];
  omissions?: ProjectComponentOmission[];
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
  kind?: "array" | "property";
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
async function fileState(path: string): Promise<FileState> {
  const contents = await bytes(path);
  if (contents === null || process.platform === "win32") return { contents };
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
    if (entry.key !== undefined && entry.kind !== "array" && entry.kind !== "property")
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

export async function reconcileProject(
  root: string,
  config: string,
  integration: ProjectIntegration,
): Promise<Reconciliation> {
  validatePath(config);
  const observedAbsentFiles = new Map<string, Buffer | null>();
  for (const check of integration.absent ?? []) {
    let raw = observedAbsentFiles.get(check.path);
    if (raw === undefined && !observedAbsentFiles.has(check.path)) {
      raw = await bytes(await projectPath(root, check.path));
      observedAbsentFiles.set(check.path, raw);
    }
    if (raw && get(document(raw.toString(), check.path), check.key) !== undefined)
      throw new Error(`unowned component collision: ${check.path}:${check.key.join(".")}`);
  }
  if (await bytes(await projectPath(root, JOURNAL)))
    throw new Error("unfinished integration transaction; run hooknostic recover");
  const manifestState = await fileState(await projectPath(root, STATE));
  const manifestBytes = manifestState.contents;
  const prior = readManifest(manifestBytes, config);
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
      throw new Error(`duplicate integration destination: ${entry.path}`);
    }
    desired.set(id, entry);
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
  const owned: Owned[] = [];
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const observed = await fileState(await projectPath(root, path));
    const before = observed.contents;
    const oldEntries = prior.owned.filter((e) => e.path === path);
    const nextEntries = [...desired.values()].filter((e) => e.path === path);
    const whole = nextEntries.find((e) => !("key" in e));
    const oldWhole = oldEntries.find((e) => e.key === undefined);
    let after: Buffer | null = before;
    const beforeMode = observed.mode ?? 0o644;
    let mode = beforeMode;
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
          (process.platform !== "win32" && oldWhole.mode !== undefined && beforeMode !== oldWhole.mode))
      )
        throw new Error(`unowned or modified generated file: ${path}; move it aside before synchronizing`);
      if (whole && "contents" in whole) {
        after = Buffer.from(whole.contents);
        mode = whole.mode ?? 0o644;
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
        if (kind === "array") {
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
    if (!same(before, after) || (process.platform !== "win32" && before !== null && beforeMode !== mode))
      changes.push({ path, before, after, mode, beforeMode });
  }
  const manifest: Manifest = {
    schemaVersion: 1,
    config,
    owned: owned.sort((a, b) => (identity(a) < identity(b) ? -1 : identity(a) > identity(b) ? 1 : 0)),
  };
  const afterManifest = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  if (
    !same(manifestBytes, afterManifest) ||
    (process.platform !== "win32" && manifestBytes !== null && manifestState.mode !== 0o644)
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
async function stage(root: string, value: Buffer, mode: number): Promise<string> {
  const temp = await projectPath(root, `.hooknostic/staging/${randomUUID()}`);
  await mkdir(dirname(temp), { recursive: true });
  const handle = await open(temp, "wx", mode);
  try {
    if (process.platform !== "win32") await handle.chmod(mode);
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return temp;
}
async function acquire(root: string, name = LOCK): Promise<() => Promise<void>> {
  const lock = await projectPath(root, name);
  await mkdir(dirname(lock), { recursive: true });
  const handle = await open(lock, "wx", 0o600);
  try {
    await handle.writeFile(String(process.pid));
    await handle.sync();
  } finally {
    await handle.close();
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
          (process.platform === "win32" || current.mode === entry.mode);
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
export async function recoverProject(root: string, config: string): Promise<void> {
  validatePath(config);
  const recoveryRelease = await acquire(root, RECOVERY_LOCK);
  try {
    const lock = await projectPath(root, LOCK);
    const existing = await bytes(lock);
    if (existing) {
      const pid = Number(existing.toString());
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid lock; inspect it before recovery");
      try {
        process.kill(pid, 0);
        throw new Error("synchronization is still running");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      await rm(lock);
    }
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
