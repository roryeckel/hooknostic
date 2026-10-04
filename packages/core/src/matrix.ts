import semver from "semver";

import type { CapabilityId, EventFieldId } from "@hooknostic/sdk";
import { ALL_CAPABILITY_IDS, ALL_EVENT_FIELD_IDS, leastCapable } from "@hooknostic/sdk";

import type { CapabilityEntry, CapabilityProfile, CapabilityResolutionResult, FieldMatrix } from "./adapter.js";
import type { Diagnostic } from "./diagnostics.js";

interface StableInterval {
  lower?: semver.SemVer;
  lowerInclusive: boolean;
  upper?: semver.SemVer;
  upperInclusive: boolean;
}

function withoutSentinelPrerelease(version: semver.SemVer): semver.SemVer {
  if (version.prerelease.length === 1 && version.prerelease[0] === 0) {
    return new semver.SemVer(`${version.major}.${version.minor}.${version.patch}`);
  }
  return version;
}

function strongerLower(
  current: Pick<StableInterval, "lower" | "lowerInclusive">,
  candidate: semver.SemVer,
  inclusive: boolean,
): Pick<StableInterval, "lower" | "lowerInclusive"> {
  if (!current.lower) return { lower: candidate, lowerInclusive: inclusive };
  const compared = candidate.compare(current.lower);
  if (compared > 0) return { lower: candidate, lowerInclusive: inclusive };
  if (compared < 0) return current;
  return { lower: current.lower, lowerInclusive: current.lowerInclusive && inclusive };
}

function strongerUpper(
  current: Pick<StableInterval, "upper" | "upperInclusive">,
  candidate: semver.SemVer,
  inclusive: boolean,
): Pick<StableInterval, "upper" | "upperInclusive"> {
  if (!current.upper) return { upper: candidate, upperInclusive: inclusive };
  const compared = candidate.compare(current.upper);
  if (compared < 0) return { upper: candidate, upperInclusive: inclusive };
  if (compared > 0) return current;
  return { upper: current.upper, upperInclusive: current.upperInclusive && inclusive };
}

/** Convert node-semver comparator sets into intervals over stable versions. */
function stableIntervals(range: semver.Range): StableInterval[] {
  return range.set.map((comparators) => {
    let interval: StableInterval = { lowerInclusive: false, upperInclusive: false };
    for (const comparator of comparators) {
      if (comparator.value === "") continue;
      const operator = comparator.operator;
      const version = withoutSentinelPrerelease(comparator.semver);
      if (operator === ">" || operator === ">=") {
        interval = {
          ...interval,
          ...strongerLower(interval, version, operator === ">="),
        };
      } else if (operator === "<" || operator === "<=") {
        interval = {
          ...interval,
          ...strongerUpper(interval, version, operator === "<="),
        };
      } else {
        interval = {
          lower: version,
          lowerInclusive: true,
          upper: version,
          upperInclusive: true,
        };
      }
    }
    return interval;
  });
}

function compareLower(a: StableInterval, b: StableInterval): number {
  if (!a.lower) return b.lower ? -1 : 0;
  if (!b.lower) return 1;
  const compared = a.lower.compare(b.lower);
  if (compared !== 0) return compared;
  return Number(b.lowerInclusive) - Number(a.lowerInclusive);
}

function intervalsConnect(left: StableInterval, right: StableInterval): boolean {
  if (!left.upper || !right.lower) return true;
  const compared = left.upper.compare(right.lower);
  return compared > 0 || (compared === 0 && (left.upperInclusive || right.lowerInclusive));
}

function widerUpper(left: StableInterval, right: StableInterval): StableInterval {
  if (!left.upper || !right.upper) {
    const unbounded: StableInterval = {
      lowerInclusive: left.lowerInclusive,
      upperInclusive: false,
    };
    if (left.lower) unbounded.lower = left.lower;
    return unbounded;
  }
  const compared = left.upper.compare(right.upper);
  if (compared > 0) return left;
  if (compared < 0) {
    return { ...left, upper: right.upper, upperInclusive: right.upperInclusive };
  }
  return { ...left, upperInclusive: left.upperInclusive || right.upperInclusive };
}

function containsInterval(container: StableInterval, candidate: StableInterval): boolean {
  const lowerCovered =
    !container.lower ||
    (candidate.lower !== undefined &&
      (container.lower.compare(candidate.lower) < 0 ||
        (container.lower.compare(candidate.lower) === 0 && (container.lowerInclusive || !candidate.lowerInclusive))));
  const upperCovered =
    !container.upper ||
    (candidate.upper !== undefined &&
      (container.upper.compare(candidate.upper) > 0 ||
        (container.upper.compare(candidate.upper) === 0 && (container.upperInclusive || !candidate.upperInclusive))));
  return lowerCovered && upperCovered;
}

function hasExplicitPrerelease(range: string): boolean {
  return /\d+\.\d+\.\d+-[0-9A-Za-z]/.test(range);
}

export function isRangeFullyCovered(requestedRange: string, profileRanges: readonly string[]): boolean {
  const union = profileRanges.join(" || ");
  const options = hasExplicitPrerelease(requestedRange) ? { includePrerelease: true } : undefined;
  if (semver.subset(requestedRange, union, options)) return true;
  // node-semver treats the synthetic `-0` boundaries used for `<major/minor>`
  // ranges as prerelease gaps. Retry over stable-version intervals so adjacent
  // profiles such as `<1.5 || >=1.5` are recognized as continuous. Explicit
  // prerelease requests still require node-semver's exact subset proof above.
  if (hasExplicitPrerelease(requestedRange) || profileRanges.some(hasExplicitPrerelease)) {
    return false;
  }

  const coverage = profileRanges.flatMap((range) => stableIntervals(new semver.Range(range))).sort(compareLower);
  const merged: StableInterval[] = [];
  for (const interval of coverage) {
    const previous = merged.at(-1);
    if (!previous || !intervalsConnect(previous, interval)) {
      merged.push(interval);
    } else {
      merged[merged.length - 1] = widerUpper(previous, interval);
    }
  }
  return stableIntervals(new semver.Range(requestedRange)).every((requested) =>
    merged.some((validated) => containsInterval(validated, requested)),
  );
}

/**
 * Resolve an adapter's versioned capability profiles against a requested
 * version range.
 *
 * - No intersecting profile → HN203 (target version outside adapter data).
 * - Multiple intersecting profiles → the least-capable guaranteed
 *   intersection per capability. Never assume the newest profile for a broad
 *   range.
 */
/**
 * Whether an exact harness version falls inside a validated range. Exported so
 * the contract suite (and third-party adapters) can pin metadata like
 * `referenceVersion` against `recommendedRange` without a second semver dep.
 * `includePrerelease` so a prerelease build of an in-range version still
 * counts -- validation evidence is about the build actually run.
 */
export function rangeCoversVersion(range: string, version: string): boolean {
  return semver.satisfies(version, range, { includePrerelease: true });
}

export function resolveCapabilityMatrix(
  adapterId: string,
  profiles: readonly CapabilityProfile[],
  requestedRange: string,
): CapabilityResolutionResult {
  const diagnostics: Diagnostic[] = [];

  if (!semver.validRange(requestedRange)) {
    diagnostics.push({
      code: "HN203",
      severity: "error",
      target: adapterId,
      message: `"${requestedRange}" is not a valid semver range.`,
      remediation: 'use a bounded semver range such as ">=2.1 <3" in the target\'s version field.',
    });
    return { profilesUsed: [], diagnostics };
  }

  const rangeOptions = hasExplicitPrerelease(requestedRange) ? { includePrerelease: true } : undefined;
  const used = profiles.filter((p) => semver.intersects(p.range, requestedRange, rangeOptions));
  if (used.length === 0) {
    diagnostics.push({
      code: "HN203",
      severity: "error",
      target: adapterId,
      message: `requested version range "${requestedRange}" is outside the adapter's validated capability data (${profiles.map((p) => p.range).join(", ") || "none"}).`,
      remediation:
        "narrow the target's version range to a validated range, or update the adapter's capability profiles.",
    });
    return { profilesUsed: [], diagnostics };
  }

  if (
    !isRangeFullyCovered(
      requestedRange,
      used.map((profile) => profile.range),
    )
  ) {
    diagnostics.push({
      code: "HN203",
      severity: "error",
      target: adapterId,
      message: `requested version range "${requestedRange}" is not fully covered by the adapter's validated capability data (${profiles.map((p) => p.range).join(", ") || "none"}).`,
      remediation:
        "add explicit lower and upper bounds that stay within validated profiles, or update the adapter's capability data.",
    });
    return { profilesUsed: [...used], diagnostics };
  }

  if (used.length === 1) {
    return { matrix: used[0]!.matrix, fields: used[0]!.fields ?? {}, profilesUsed: [...used], diagnostics };
  }

  return {
    matrix: leastCapableMatrix(
      ALL_CAPABILITY_IDS,
      used.map((profile) => profile.matrix),
    ),
    fields: leastCapableMatrix(
      ALL_EVENT_FIELD_IDS,
      used.map((profile) => profile.fields ?? {}),
    ) as FieldMatrix,
    profilesUsed: [...used],
    diagnostics,
  };
}

/**
 * Least-capable guaranteed intersection: an id's level is the lowest level
 * across all intersecting profiles; missing entries are unsupported. Shared by
 * capabilities and event fields, which resolve by the same rule (ADR-0027).
 */
function leastCapableMatrix<Id extends CapabilityId | EventFieldId>(
  ids: readonly Id[],
  matrices: readonly Partial<Record<Id, CapabilityEntry>>[],
): Partial<Record<Id, CapabilityEntry>> {
  const matrix: Partial<Record<Id, CapabilityEntry>> = {};
  for (const id of ids) {
    let entry: CapabilityEntry | undefined;
    for (const profileMatrix of matrices) {
      const candidate = profileMatrix[id] ?? { level: "unsupported" as const };
      if (entry === undefined) {
        entry = candidate;
      } else if (leastCapable(entry.level, candidate.level) === candidate.level) {
        entry = candidate;
      }
    }
    if (entry && entry.level !== "unsupported") {
      matrix[id] = entry;
    }
  }
  return matrix;
}
