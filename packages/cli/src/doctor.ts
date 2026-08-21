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
  installed: boolean;
  version?: string;
  status: "ok" | "newer-than-validated" | "outside-validated" | "not-detected" | "unknown-version";
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
    const base: Omit<DoctorEntry, "installed" | "status"> = {
      adapter: adapter.id,
      adapterVersion: adapter.adapterVersion,
      validatedRanges: ranges,
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
    let status: DoctorEntry["status"] = "ok";
    if (!inRange) {
      const newer = ranges.every((range) => semver.gtr(detection.version!, range));
      status = newer ? "newer-than-validated" : "outside-validated";
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
      JSON.stringify({ schemaVersion: 1, command: "doctor", ok, harnesses: entries }, null, 2),
    );
    return ok ? 0 : 1;
  }

  for (const entry of entries) {
    const version = entry.version ?? (entry.installed ? "unknown version" : "not installed");
    const marker =
      entry.status === "ok" ? "OK  " : entry.status === "not-detected" ? "MISS" : "WARN";
    options.io.stdout(
      `${marker}  ${entry.adapter}  ${version}  (validated: ${entry.validatedRanges.join(", ")})${
        entry.status === "newer-than-validated"
          ? " — newer than the adapter's validated range; capability data may be stale"
          : entry.status === "outside-validated"
            ? " — outside the adapter's validated range"
            : ""
      }`,
    );
  }
  return ok ? 0 : 1;
}
