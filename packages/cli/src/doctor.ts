import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import semver from "semver";

import type { AdapterRegistry, Diagnostic, McpServerCommand, ProjectSdkRelease } from "@hooknostic/core";
import {
  buildProject,
  formatDiagnostics,
  HOOKNOSTIC_VERSION,
  loadConfig,
  mcpAmbientCommands,
  type ProjectCommandResult,
  projectSdkRelease,
  projectSdkReleaseSkew,
  registeredAdapter,
  resolveTargetAdapter,
  runProject,
  targetSpecFromConfig,
} from "@hooknostic/core";

import type { CommandIO } from "./check.js";

type DoctorMcpCommand =
  | (Omit<McpServerCommand, "resolution"> & { resolution: "package" })
  | (Omit<McpServerCommand, "resolution"> & { resolution: "project" })
  | (Omit<McpServerCommand, "resolution"> & {
      resolution: "ambient";
      lookupOrder: "cwd-then-path" | "path";
      pathProbe: { cwd: string; pathCandidate?: string };
    });

/**
 * Advisory probe for the PATH portion of a bare command's ambient lookup.
 *
 * This intentionally does not claim to reproduce a generated launcher's
 * complete resolution: Windows searches the launcher cwd first, and relative
 * or empty PATH entries resolve from a cwd that may differ from this process's.
 * The probe preserves PATH order, quoted Windows entries, empty entries (the
 * current directory), and Windows PATHEXT suffixes.
 */
export function resolveOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const windows = process.platform === "win32";
  const environmentValue = (name: string): string | undefined => {
    if (!windows) return env[name];
    const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
    return key === undefined ? undefined : env[key];
  };
  const path = environmentValue("PATH");
  if (path === undefined) return undefined;
  const directories = path.split(delimiter).map((entry) => (windows ? entry.replace(/^"(.*)"$/, "$1") : entry));
  const pathExt = (environmentValue("PATHEXT") ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
  const suffixes = windows ? (command.includes(".") ? ["", ...pathExt] : pathExt) : [""];
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = resolve(directory, command + suffix);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (!windows) accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep searching later PATH entries and PATHEXT forms.
      }
    }
  }
  return undefined;
}

function mergeMcpCommands(...groups: readonly (readonly McpServerCommand[])[]): McpServerCommand[] {
  const commands = new Map<string, McpServerCommand>();
  for (const group of groups) {
    for (const command of group) {
      const key = JSON.stringify([command.server, command.command, command.resolution]);
      if (!commands.has(key)) commands.set(key, command);
    }
  }
  return [...commands.values()].sort(
    (a, b) =>
      a.server.localeCompare(b.server) ||
      a.command.localeCompare(b.command) ||
      a.resolution.localeCompare(b.resolution),
  );
}

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

/** `path` relative to the current directory when it is inside it, else absolute. */
function shownPath(path: string): string {
  const shown = relative(process.cwd(), path);
  return shown === "" || shown === ".." || shown.startsWith(`..${sep}`) || isAbsolute(shown) ? path : shown;
}

/** What the project's SDK lookup found, as doctor's version line says it. */
function sdkText(sdk: ProjectSdkRelease): string {
  switch (sdk.status) {
    case "found":
      return sdk.version;
    case "not-found":
      return "not found";
    case "unidentified":
      return "version unknown: the resolved package's manifest isn't @hooknostic/sdk's or has no version";
    case "not-looked-up":
      return sdk.reason === "another-pnp-runtime"
        ? "not looked up under another install's Plug'n'Play runtime"
        : `not looked up: ${shownPath(sdk.manifest)} is a Yarn Plug'n'Play manifest, and this process isn't running under Yarn's runtime`;
  }
}

/**
 * Doctor's first line of text: this hooknostic's version, the project's
 * `@hooknostic/sdk` when there is a config, and Node.js's (#246).
 */
export function doctorVersionLine(sdk: ProjectSdkRelease | undefined, node: string = process.version): string {
  const project = sdk === undefined ? "" : `, project @hooknostic/sdk ${sdkText(sdk)}`;
  return `hooknostic ${HOOKNOSTIC_VERSION}${project} (Node.js ${node})`;
}

/**
 * Doctor's own diagnostics for the config in `configDir`, whose SDK lookup
 * found `sdk` (#257). HN110 judges the release doctor's version line shows,
 * whatever the config delivers and even when it fails to load. Only for an SDK
 * that lookup found, so doctor never warns about one its version line calls
 * missing (#246).
 */
function doctorDiagnostics(configDir: string | undefined, sdk: ProjectSdkRelease | undefined): Diagnostic[] {
  // HN110 now resolves the SDK as the version line does (#258), so every status
  // but `found` leaves it silent anyway and this gate is redundant. It stays so
  // the two cannot drift apart again.
  if (configDir === undefined || sdk?.status !== "found") return [];
  const skew = projectSdkReleaseSkew(configDir);
  return skew === undefined ? [] : [skew];
}

/**
 * Prints `diagnostics` on stdout as doctor's text output does: as `check` and
 * `sync` print them, remediation included, then a blank line (#260).
 */
function printDiagnostics(write: (text: string) => void, diagnostics: readonly Diagnostic[]): void {
  if (diagnostics.length === 0) return;
  write(formatDiagnostics(diagnostics));
  write("");
}

/**
 * `hooknostic doctor` — detect locally installed harnesses and compare them
 * with each adapter's validated capability ranges. Unknown/newer versions
 * warn rather than silently passing; `build` never consults local versions
 * (reproducibility, design §16.2). With a config, it also reports HN110 for
 * any delivery, never in its exit code.
 */
export async function runDoctor(options: DoctorCommandOptions): Promise<number> {
  if (options.config === undefined && existsSync(resolve("hooknostic.config.ts")))
    options = { ...options, config: "hooknostic.config.ts" };
  // The versions a bug report asks for. Facts only: HN110 alone judges a
  // mismatch, printed with them. Both come before the config loads, so they
  // are out even when the load never finishes or doctor fails before its
  // report, and a load the skew may have broken is reported beside it.
  const configDir = options.config === undefined ? undefined : dirname(resolve(options.config));
  const sdk = configDir === undefined ? undefined : projectSdkRelease(configDir);
  const diagnostics = doctorDiagnostics(configDir, sdk);
  if (!options.json) {
    options.io.stdout(doctorVersionLine(sdk));
    printDiagnostics(options.io.stdout, diagnostics);
  }
  const entries: DoctorEntry[] = [];

  let adapters = Object.values(options.registry);
  const loaded = options.config
    ? await loadConfig(resolve(options.config), undefined, { allowEmptyProjectTargets: true })
    : undefined;
  if (loaded) {
    if (loaded.config) {
      const selected = Object.entries(loaded.config.targets).flatMap(([name, target]) => {
        const registered = registeredAdapter(options.registry, target.adapter ?? name);
        if (!registered) return [];
        const adapter = resolveTargetAdapter(registered, targetSpecFromConfig(name, target)).adapter;
        return adapter ? [{ ...adapter, ...(registered.detect ? { detect: registered.detect } : {}) }] : [];
      });
      adapters = [
        ...new Map(selected.map((adapter) => [`${adapter.id}:${adapter.harness.referenceVersion}`, adapter])).values(),
      ];
    }
  }
  for (const registered of adapters) {
    const detection = registered.detect ? await registered.detect() : undefined;
    const familyFor = (version: string) =>
      resolveTargetAdapter(registered, { id: registered.id, version, delivery: "project", output: "." }).adapter;
    const adapter =
      options.config === undefined
        ? (familyFor(detection?.version ?? registered.harness.recommendedRange) ??
          familyFor(registered.harness.recommendedRange) ??
          registered)
        : registered;
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
    if (!detection) {
      entries.push({
        ...base,
        installed: false,
        status: "not-detected",
        detail: "detection unavailable for this adapter",
      });
      continue;
    }
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
  // The errors of doctor's own builds of the config, kept whole so their
  // remediation reaches the output (#260).
  const configuration: Diagnostic[] = [];
  let commands: readonly McpServerCommand[] = [];
  if (options.config) {
    if (loaded?.config?.project) {
      project = await runProject({
        command: "verify",
        configPath: resolve(options.config),
        registry: options.registry,
        executeMaterializers: false,
        ...(loaded === undefined ? {} : { configResult: loaded }),
      });
      commands = mergeMcpCommands(commands, project.mcpServers);
      const packageTargets = Object.entries(loaded.config.targets)
        .filter(([, target]) => target.delivery === "package")
        .map(([name]) => name);
      if (packageTargets.length > 0) {
        const checked = await buildProject({
          configPath: resolve(options.config),
          registry: options.registry,
          targets: packageTargets,
          dryRun: true,
          executeMaterializers: false,
          configResult: loaded,
        });
        configuration.push(...checked.report.diagnostics.filter((d) => d.severity === "error"));
        commands = mergeMcpCommands(commands, checked.report.mcpServers ?? []);
      }
    } else {
      const checked = await buildProject({
        configPath: resolve(options.config),
        registry: options.registry,
        dryRun: true,
        executeMaterializers: false,
        ...(loaded === undefined ? {} : { configResult: loaded }),
      });
      configuration.push(...checked.report.diagnostics.filter((d) => d.severity === "error"));
      commands = mergeMcpCommands(checked.report.mcpServers ?? []);
    }
  }
  // The JSON contract since before #260: the same errors, as messages.
  const configurationErrors = configuration.map((d) => d.message);
  // Probed, but deliberately not folded into `ok`: the command belongs to
  // the machine the plugin is finally installed on, not the one building it.
  // A builder without an optional runner still produces a valid artifact, and
  // failing it there would teach authors to ignore the check.
  const pathCandidates = new Map(mcpAmbientCommands(commands).map((command) => [command, resolveOnPath(command)]));
  const lookupOrder = process.platform === "win32" ? "cwd-then-path" : "path";
  const mcpCommands: DoctorMcpCommand[] = commands.map((entry): DoctorMcpCommand => {
    if (entry.resolution === "package") return { ...entry, resolution: "package" };
    if (entry.resolution === "project") return { ...entry, resolution: "project" };
    const candidate = pathCandidates.get(entry.command);
    return {
      ...entry,
      lookupOrder,
      pathProbe: {
        cwd: process.cwd(),
        ...(candidate === undefined ? {} : { pathCandidate: candidate }),
      },
    };
  });
  const ok =
    configurationErrors.length === 0 &&
    entries.every((e) => e.status === "ok") &&
    (project === undefined || project.ok);
  const projectReport =
    project === undefined
      ? undefined
      : (() => {
          const { mcpServers: _mcpServers, ...visible } = project;
          return visible;
        })();

  if (options.json) {
    options.io.stdout(
      JSON.stringify(
        {
          schemaVersion: 2,
          command: "doctor",
          ok,
          harnesses: entries,
          configurationErrors,
          mcpCommands,
          // Doctor's own; `project.diagnostics` keeps verify's, which may
          // repeat HN110. Additive, so schemaVersion stays 2 (#257). Then
          // each configuration error, whole (#260): errors only, so never
          // a second HN110.
          diagnostics: [...diagnostics, ...configuration],
          // Additive, so schemaVersion stays 2 (#246).
          runtime: { node: process.version, hooknostic: HOOKNOSTIC_VERSION, ...(sdk === undefined ? {} : { sdk }) },
          ...(projectReport === undefined
            ? {}
            : { project: { ...projectReport, execution: "not-observed", trust: "not-inspected" } }),
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
  if (mcpCommands.length > 0) {
    options.io.stdout("");
    options.io.stdout("Declared MCP command resolution (ambient probes are advisory; launcher cwd may differ):");
    for (const command of mcpCommands) {
      if (command.resolution === "package") {
        options.io.stdout(`INFO  ${command.server}: command ${command.command} is shipped by the package`);
      } else if (command.resolution === "project") {
        options.io.stdout(
          `INFO  ${command.server}: command ${command.command} is resolved relative to the project MCP source`,
        );
      } else {
        const marker = command.pathProbe.pathCandidate === undefined ? "MISS" : "OK  ";
        const where = command.pathProbe.pathCandidate ?? "no candidate on this PATH";
        const order = command.lookupOrder === "cwd-then-path" ? "launcher cwd, then PATH" : "PATH";
        options.io.stdout(
          `${marker}  ${command.server}: command ${command.command} uses ambient lookup (${order}); PATH probe — ${where}`,
        );
      }
    }
  }
  // Nothing follows them on stderr, so no blank line, as `check` prints its failure.
  if (configuration.length > 0) options.io.stderr(formatDiagnostics(configuration));
  if (project) {
    options.io.stdout(
      `Project wiring: ${project.ok ? "current" : project.errors.length ? "conflict or invalid" : "drifted"}; hook execution has not been observed.`,
    );
    // As `sync` prints them. A wiring warning such as HN107 has no other
    // witness: the harness's own output still looks hooked. One doctor
    // printed beside its version line, as HN110, is not repeated here; the
    // JSON keeps both copies. Same code and same message: verify's build
    // words HN110 with core's same projectSdkReleaseSkew, from the same
    // config directory, so the two match unless they judged different SDKs,
    // and then both are printed. A change to HN110's wording or remediation
    // (#256, #259) changes both copies alike.
    printDiagnostics(
      options.io.stdout,
      project.diagnostics.filter(
        (diagnostic) => !diagnostics.some((own) => own.code === diagnostic.code && own.message === diagnostic.message),
      ),
    );
    for (const message of [...project.guidance, ...project.errors]) options.io.stdout(message);
  }
  return ok ? 0 : 2;
}
