import { posix, win32 } from "node:path";
import type { GeneratedArtifact } from "./adapter.js";
import type { Diagnostic } from "./diagnostics.js";

export interface ArtifactValidationContext {
  adapterId: string;
  target: string;
}

const ARTIFACT_PATH_RULE =
  "artifact paths must be unique, including on case-insensitive filesystems, POSIX-style relative paths inside the target output directory (no absolute paths, backslashes, or `.`/`..`/empty segments).";

/**
 * Why a generated artifact path is unacceptable, or `undefined` when it is a
 * POSIX-style relative path that cannot leave the output directory on any
 * platform.
 */
export function artifactPathProblem(path: unknown): string | undefined {
  if (typeof path !== "string" || path.length === 0) return "path must be a non-empty string";
  if (path.includes("\0")) return "path must not contain NUL characters";
  if (path.includes("\\")) return "path must use forward slashes";
  if (posix.isAbsolute(path) || win32.isAbsolute(path)) return "path must be relative";
  for (const segment of path.split("/")) {
    if (segment.length === 0) return "path must not contain empty segments";
    if (segment === "." || segment === "..") return `path must not contain "${segment}" segments`;
  }
  return undefined;
}

/**
 * Structural validation of an adapter's artifact set before anything is
 * written to staging. Violations are HN301 diagnostics (an adapter bug that
 * must fail the target), never exceptions; nothing is written for a target
 * with a fatal artifact diagnostic.
 */
export function validateGeneratedArtifacts(
  artifacts: readonly GeneratedArtifact[],
  context: ArtifactValidationContext,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  const seenCaseInsensitive = new Set<string>();
  for (const artifact of artifacts) {
    const problem = artifactPathProblem(artifact.path);
    const shown = JSON.stringify(String(artifact.path));
    if (problem !== undefined) {
      diagnostics.push({
        code: "HN301",
        severity: "error",
        target: context.target,
        message: `adapter "${context.adapterId}" emitted an invalid artifact path ${shown}: ${problem}.`,
        remediation: ARTIFACT_PATH_RULE,
      });
      continue;
    }
    // Write-time invariants: `check` never stages, so anything writeFile would
    // reject must be rejected here or a dry run passes what a build fails.
    if (typeof artifact.contents !== "string" && !(artifact.contents instanceof Uint8Array)) {
      diagnostics.push({
        code: "HN301",
        severity: "error",
        target: context.target,
        message: `adapter "${context.adapterId}" emitted artifact ${shown} with non-string, non-binary contents.`,
        remediation: "artifact contents must be a string or a Uint8Array.",
      });
      continue;
    }
    if (artifact.mode !== undefined && (!Number.isInteger(artifact.mode) || artifact.mode < 0 || artifact.mode > 0o7777)) {
      diagnostics.push({
        code: "HN301",
        severity: "error",
        target: context.target,
        message: `adapter "${context.adapterId}" emitted artifact ${shown} with invalid mode ${String(artifact.mode)}.`,
        remediation: "artifact mode must be an integer of permission bits (0 to 0o7777) or omitted.",
      });
      continue;
    }
    if (seen.has(artifact.path)) {
      diagnostics.push({
        code: "HN301",
        severity: "error",
        target: context.target,
        message: `adapter "${context.adapterId}" emitted duplicate artifact path ${shown}.`,
        remediation: ARTIFACT_PATH_RULE,
      });
      continue;
    }
    const caseFolded = artifact.path.toLowerCase();
    if (seenCaseInsensitive.has(caseFolded)) {
      diagnostics.push({
        code: "HN301",
        severity: "error",
        target: context.target,
        message: `adapter "${context.adapterId}" emitted case-insensitively duplicate artifact path ${shown}.`,
        remediation: ARTIFACT_PATH_RULE,
      });
      continue;
    }
    seen.add(artifact.path);
    seenCaseInsensitive.add(caseFolded);
  }
  // A file cannot also be a directory: `a` beside `a/b` only fails once
  // staging tries to mkdir over the file, which a dry run never reaches.
  const directories = new Set<string>();
  for (const path of seenCaseInsensitive) {
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) directories.add(segments.slice(0, depth).join("/"));
  }
  for (const artifact of artifacts) {
    if (typeof artifact.path !== "string" || !seen.has(artifact.path)) continue;
    if (directories.has(artifact.path.toLowerCase())) {
      diagnostics.push({
        code: "HN301",
        severity: "error",
        target: context.target,
        message: `adapter "${context.adapterId}" emitted artifact path ${JSON.stringify(artifact.path)} that is also a directory of another artifact.`,
        remediation: ARTIFACT_PATH_RULE,
      });
    }
  }
  return diagnostics;
}
