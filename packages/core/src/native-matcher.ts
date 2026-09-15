import type { ToolKind } from "@hooknostic/sdk";

import type { HookIR } from "./ir.js";

/** How one harness's tool classifier assigns native tools to portable kinds. */
export interface NativeToolVocabulary {
  /** Every exact native name the classifier maps to each kind. */
  readonly names: Partial<Record<ToolKind, readonly string[]>>;
  /** Regex source for kinds the classifier recognizes by pattern (e.g. MCP). */
  readonly patterns?: Partial<Record<ToolKind, string>>;
}

/** The native tools one dispatcher group must receive. */
export interface NativeToolSelection {
  readonly names: readonly string[];
  readonly patterns: readonly string[];
}

/**
 * The native tools that can reach any of `reaching`, so a harness can skip
 * spawning the dispatcher for every other tool.
 *
 * The selection is a union over the hooks and may be coarser than their
 * matches (a `kind` and `nativeName` pair contributes the names alone); the
 * dispatcher re-applies each `match`, so only a narrower selection could lose a
 * dispatch. `undefined` means every tool must reach the dispatcher: a hook
 * without a match, one matching `other` (defined by absence, so unenumerable),
 * or one matching a kind the vocabulary does not describe.
 */
export function nativeToolSelection(
  reaching: readonly HookIR[],
  vocabulary: NativeToolVocabulary,
): NativeToolSelection | undefined {
  const names = new Set<string>();
  const patterns = new Set<string>();
  for (const hook of reaching) {
    const match = hook.match;
    if (match === undefined || (match.kind === undefined && match.nativeName === undefined)) return undefined;
    if (match.nativeName !== undefined) {
      for (const name of [match.nativeName].flat()) names.add(name);
      continue;
    }
    for (const kind of [match.kind!].flat()) {
      const kindNames = vocabulary.names[kind];
      const pattern = vocabulary.patterns?.[kind];
      if (kind === "other" || (kindNames === undefined && pattern === undefined)) return undefined;
      for (const name of kindNames ?? []) names.add(name);
      if (pattern !== undefined) patterns.add(pattern);
    }
  }
  if (names.size === 0 && patterns.size === 0) return undefined;
  return { names: [...names].sort(), patterns: [...patterns].sort() };
}

/** Invert a classifier's exact name table into a vocabulary's `names`. */
export function namesByKind(table: Record<string, ToolKind>): Partial<Record<ToolKind, readonly string[]>> {
  const grouped: Partial<Record<ToolKind, string[]>> = {};
  for (const [name, kind] of Object.entries(table)) (grouped[kind] ??= []).push(name);
  return grouped;
}
