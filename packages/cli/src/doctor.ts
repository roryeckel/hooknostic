import semver from "semver";
import type { AdapterRegistry } from "@hooknostic/core";
import type { CommandIO } from "./check.js";

export interface DoctorCommandOptions {
  json?: boolean;
  registry: AdapterRegistry;
  io: CommandIO;
}

interface DoctorEntry {
  adapter: string;
  adapterVersion: string;
  validatedRanges: string[];
  recommendedRange: string;
  /** Newest build any profile records a validation event for, with its date. */
  newestValidated?: { version: string; date: string; method: string };
  installed: boolean;
  version?: string;
  status:
    | "ok"
    | "outside-recommended"
    | "newer-than-validated"
    | "outside-validated"
    | "not-detected"
    | "unknown-version";
  detail?: string;
}

/**
 * `hooknostic doctor` — detect locally installed harnesses and compare them
 * with each adapter's validated capability ranges. Unknown/newer versions
 * warn rather than silently passing; `build` never consults local versions
 * (reproducibility, design §16.2).
 */
export async function runDoctor(options: DoctorCommandOptions): Promise<number> {
  const entries: DoctorEntry[] = [];

  for (const adapter of Object.values(options.registry)) {
    const ranges = adapter.supportedHarnessVersions();
    // Newest validation event across the recommended range's profiles: this is
    // what lets doctor report staleness of OUR validation, not just novelty of
    // the user's install.
    const resolution = adapter.capabilities({
      id: adapter.id,
      version: adapter.harness.recommendedRange,
      mode: "local",
      output: ".",
    });
    const newestValidated = resolution.profilesUsed
      .flatMap((profile) => profile.source.validatedOn)
      .reduce<DoctorEntry["newestValidated"]>(
        (best, record) =>
          best === undefined || semver.gt(record.version, best.version)
            ? { version: record.version, date: record.date, method: record.method }
            : best,
        undefined,
      );
    const base: Omit<DoctorEntry, "installed" | "status"> = {
      adapter: adapter.id,
      adapterVersion: adapter.adapterVersion,
      validatedRanges: ranges,
      recommendedRange: adapter.harness.recommendedRange,
      ...(newestValidated !== undefined ? { newestValidated } : {}),
    };
    if (!adapter.detect) {
      entries.push({ ...base, installed: false, status: "not-detected", detail: "detection unavailable for this adapter" });
      continue;
    }
    const detection = await adapter.detect();
    if (!detection.installed) {
      entries.push({
        ...base,
        installed: false,
        status: "not-detected",
        ...(detection.detail !== undefined ? { detail: detection.detail } : {}),
      });
      continue;
    }
    if (detection.version === undefined) {
      entries.push({
        ...base,
        installed: true,
        status: "unknown-version",
        ...(detection.detail !== undefined ? { detail: detection.detail } : {}),
      });
      continue;
    }
    const inRange = ranges.some((range) => semver.satisfies(detection.version!, range));
    const inRecommended = semver.satisfies(detection.version!, adapter.harness.recommendedRange);
    let status: DoctorEntry["status"] = "ok";
    if (!inRange) {
      const newer = ranges.every((range) => semver.gtr(detection.version!, range));
      status = newer ? "newer-than-validated" : "outside-validated";
    } else if (!inRecommended) {
      // Validated but outside the range consumers are told to target -- its
      // own advisory, distinct from outside-validated.
      status = "outside-recommended";
    }
    entries.push({
      ...base,
      installed: true,
      version: detection.version,
      status,
      ...(detection.detail !== undefined ? { detail: detection.detail } : {}),
    });
  }

  const ok = entries.every((e) => e.status === "ok");

  if (options.json) {
    options.io.stdout(
      JSON.stringify({ schemaVersion: 2, command: "doctor", ok, harnesses: entries }, null, 2),
    );
    return ok ? 0 : 1;
  }

  for (const entry of entries) {
    const version = entry.version ?? (entry.installed ? "unknown version" : "not installed");
    const marker =
      entry.status === "ok" ? "OK  " : entry.status === "not-detected" ? "MISS" : "WARN";
    const drift =
      entry.status === "ok" &&
      entry.version !== undefined &&
      entry.newestValidated !== undefined &&
      semver.gt(entry.version, entry.newestValidated.version)
        ? ` — newer than the newest validated build (${entry.newestValidated.version}, ` +
          `${entry.newestValidated.method} ${entry.newestValidated.date}); behavior may ` +
          `have drifted since — see docs/harness-support.md`
        : "";
    options.io.stdout(
      `${marker}  ${entry.adapter}  ${version}  (recommended: ${entry.recommendedRange}; ` +
        `validated: ${entry.validatedRanges.join(", ")})${
          entry.status === "newer-than-validated"
            ? " — newer than the adapter's validated range; capability data may be stale"
            : entry.status === "outside-validated"
              ? " — outside the adapter's validated range"
              : entry.status === "outside-recommended"
                ? " — validated, but outside the recommended target range (docs/harness-support.md)"
                : drift
        }`,
    );
  }
  return ok ? 0 : 1;
}
