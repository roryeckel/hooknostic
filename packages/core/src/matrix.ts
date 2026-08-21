import semver from "semver";
import type { CapabilityId } from "@hooknostic/sdk";
import { ALL_CAPABILITY_IDS, leastCapable } from "@hooknostic/sdk";
import type {
  CapabilityEntry,
  CapabilityMatrix,
  CapabilityProfile,
  CapabilityResolutionResult,
} from "./adapter.js";
import type { Diagnostic } from "./diagnostics.js";

/**
 * Resolve an adapter's versioned capability profiles against a requested
 * version range.
 *
 * - No intersecting profile → HN203 (target version outside adapter data).
 * - Multiple intersecting profiles → the least-capable guaranteed
 *   intersection per capability. Never assume the newest profile for a broad
 *   range.
 */
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
      remediation: "use a semver range such as \">=2.1\" in the target's version field.",
    });
    return { profilesUsed: [], diagnostics };
  }

  const used = profiles.filter((p) => semver.intersects(p.range, requestedRange));
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

  if (used.length === 1) {
    return { matrix: used[0]!.matrix, profilesUsed: [...used], diagnostics };
  }

  // Least-capable guaranteed intersection: a capability's level is the lowest
  // level across all intersecting profiles; missing entries are unsupported.
  const matrix: CapabilityMatrix = {};
  for (const id of ALL_CAPABILITY_IDS) {
    let entry: CapabilityEntry | undefined;
    for (const profile of used) {
      const candidate = profile.matrix[id] ?? { level: "unsupported" as const };
      if (entry === undefined) {
        entry = candidate;
      } else if (leastCapable(entry.level, candidate.level) === candidate.level) {
        entry = candidate;
      }
    }
    if (entry && entry.level !== "unsupported") {
      matrix[id as CapabilityId] = entry;
    }
  }
  return { matrix, profilesUsed: [...used], diagnostics };
}
