import { existsSync } from "node:fs";
import { resolve } from "node:path";

import semver from "semver";

import type { AdapterRegistry } from "@hooknostic/core";
import { buildProject, loadConfig, type ProjectCommandResult, runProject } from "@hooknostic/core";

import type { CommandIO } from "./check.js";

export interface DoctorCommandOptions {
  config?: string;
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
    "ok" | "outside-recommended" | "newer-than-validated" | "outside-validated" | "not-detected" | "unknown-version";
  detail?: string;
}

/**
 * `hooknostic doctor` — detect locally installed harnesses and compare them
 * with each adapter's validated capability ranges. Unknown/newer versions
 * warn rather than silently passing; `build` never consults local versions
 * (reproducibility, design §16.2).
 */
export async function runDoctor(options: DoctorCommandOptions): Promise<number> {
  if (options.config === undefined && existsSync(resolve("hooknostic.config.ts")))
    options = { ...options, config: "hooknostic.config.ts" };
  const entries: DoctorEntry[] = [];

  let adapters = Object.values(options.registry);
  const loaded = options.config
    ? await loadConfig(resolve(options.config), undefined, { allowEmptyProjectTargets: true })
    : undefined;
  if (loaded) {
    if (loaded.config) {
      const selected = new Set(Object.entries(loaded.config.targets).map(([name, target]) => target.adapter ?? name));
      adapters = adapters.filter((adapter) => selected.has(adapter.id));
    }
  }
  for (const adapter of adapters) {
    const ranges = adapter.supportedHarnessVersions();
    // Newest validation event across the recommended range's profiles: this is
    // what lets doctor report staleness of OUR validation, not just novelty of
    // the user's install.
    const resolution = adapter.capabilities({
      id: adapter.id,
      version: adapter.harness.recommendedRange,
      delivery: "project",
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
      entries.push({
        ...base,
        installed: false,
        status: "not-detected",
        detail: "detection unavailable for this adapter",
      });
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

  let project: ProjectCommandResult | undefined;
  let configurationErrors: string[] = [];
  if (options.config) {
    if (loaded?.config?.project)
      project = await runProject({
        command: "verify",
        configPath: resolve(options.config),
        registry: options.registry,
        ...(loaded === undefined ? {} : { configResult: loaded }),
      });
    else {
      const checked = await buildProject({
        configPath: resolve(options.config),
        registry: options.registry,
        dryRun: true,
        ...(loaded === undefined ? {} : { configResult: loaded }),
      });
      configurationErrors = checked.report.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
    }
  }
  const ok =
    configurationErrors.length === 0 &&
    entries.every((e) => e.status === "ok") &&
    (project === undefined || project.ok);

  if (options.json) {
    options.io.stdout(
      JSON.stringify(
        {
          schemaVersion: 2,
          command: "doctor",
          ok,
          harnesses: entries,
          configurationErrors,
          runtime: { node: process.version },
          ...(project === undefined
            ? {}
            : { project: { ...project, execution: "not-observed", trust: "not-inspected" } }),
        },
        null,
        2,
      ),
    );
    return ok ? 0 : 2;
  }

  for (const entry of entries) {
    const version = entry.version ?? (entry.installed ? "unknown version" : "not installed");
    const marker = entry.status === "ok" ? "OK  " : entry.status === "not-detected" ? "MISS" : "WARN";
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
  for (const message of configurationErrors) options.io.stderr(message);
  if (project) {
    options.io.stdout(
      `Project wiring: ${project.ok ? "current" : project.errors.length ? "conflict or invalid" : "drifted"}; hook execution has not been observed.`,
    );
    for (const message of [...project.guidance, ...project.errors]) options.io.stdout(message);
  }
  return ok ? 0 : 2;
}
