import type {
  AdapterCompileOptions,
  CapabilityProfile,
  Diagnostic,
  HarnessMetadata,
  GeneratedArtifact,
  HarnessAdapter,
  InvocationContext,
  PluginIR,
  RuntimeBundle,
  ShimEntryOptions,
  TargetSpec,
} from "@hooknostic/core";
import { resolveCapabilityMatrix } from "@hooknostic/core";
import type { HookEvent, HookResult } from "@hooknostic/sdk";

export interface FakeAdapterOptions {
  id: string;
  adapterVersion?: string;
  profiles: CapabilityProfile[];
  supportedDeliveries?: readonly TargetSpec["delivery"][];
  /** Override native decode for runtime tests; defaults to identity-ish. */
  decode?(nativeEvent: unknown, invocation: InvocationContext): Promise<HookEvent>;
  /**
   * Shim entry source (or generator) so the build pipeline can bundle and
   * emit for this fake. `"export {};"` is enough to exercise staging and
   * commit; omit it for analysis-only fakes (the pipeline then stops at HN301).
   */
  shimEntry?: string | ((options: ShimEntryOptions) => string);
  /** How the fake harness runs the artifact; undeclared means unknown. */
  shimExecution?: "command" | "module";
  /** Override the harness metadata (default: synthetic values off the first profile). */
  harness?: HarnessMetadata;
  /** Override the emitted artifacts (default: one fake-plugin.json). */
  compile?(
    plugin: PluginIR,
    target: TargetSpec,
    bundle: RuntimeBundle,
    options: AdapterCompileOptions,
  ): GeneratedArtifact[] | Promise<GeneratedArtifact[]>;
  /** Optional artifact validator, forwarded verbatim (may throw, for pipeline tests). */
  validateArtifacts?(
    artifacts: GeneratedArtifact[],
    target: TargetSpec,
  ): Diagnostic[] | Promise<Diagnostic[]>;
  /** Optional Agent Plugin projector, forwarded verbatim (omit for a projector-less fake). */
  agentPluginProjector?: HarnessAdapter["agentPluginProjector"];
}

/**
 * A minimal in-memory adapter used to prove the capability model and the
 * compiler before (and independently of) any native adapter.
 */
export function makeFakeAdapter(options: FakeAdapterOptions): HarnessAdapter {
  const adapterVersion = options.adapterVersion ?? "0.0.0-fake";
  const adapter: HarnessAdapter = {
    id: options.id,
    adapterVersion,
    harness: options.harness ?? {
      displayName: options.id,
      recommendedRange: options.profiles[0]?.range ?? ">=1.0 <2",
      fixtureDir: "fake",
      referenceVersion: "1.0.0",
    },
    ...(options.shimExecution !== undefined ? { shimExecution: options.shimExecution } : {}),
    ...(options.agentPluginProjector !== undefined
      ? { agentPluginProjector: options.agentPluginProjector }
      : {}),

    supportedHarnessVersions() {
      return options.profiles.map((p) => p.range);
    },

    supportedDeliveries() {
      return options.supportedDeliveries ?? (["package", "project"] as const);
    },

    capabilities(target: TargetSpec) {
      return resolveCapabilityMatrix(options.id, options.profiles, target.version);
    },

    async compile(plugin, target, bundle, compileOptions): Promise<GeneratedArtifact[]> {
      if (options.compile) return options.compile(plugin, target, bundle, compileOptions);
      return [
        {
          path: "fake-plugin.json",
          contents: JSON.stringify(
            { adapter: options.id, target: target.id, plugin: plugin.name },
            null,
            2,
          ),
        },
      ];
    },

    runtime: {
      decode:
        options.decode ??
        (async (nativeEvent) => nativeEvent as HookEvent),
      async apply(result: HookResult) {
        return { body: result };
      },
    },
  };

  const shimEntry = options.shimEntry;
  if (shimEntry !== undefined) {
    adapter.shimEntry = (shimOptions) =>
      typeof shimEntry === "string" ? shimEntry : shimEntry(shimOptions);
  }
  const validateArtifacts = options.validateArtifacts;
  if (validateArtifacts !== undefined) {
    adapter.validateArtifacts = async (artifacts, target) => validateArtifacts(artifacts, target);
  }
  return adapter;
}

/**
 * A minimal valid `CapabilityProfile.source` for synthetic test profiles.
 * Real adapters never use this -- their provenance is the point; fake ones
 * should not have to invent it.
 */
export function syntheticSource(): CapabilityProfile["source"] {
  return {
    date: "2026-01-01",
    validatedOn: [
      { version: "1.0.0", date: "2026-01-01", method: "doc-derived", what: "synthetic test profile" },
    ],
  };
}
