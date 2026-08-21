import type {
  CapabilityProfile,
  GeneratedArtifact,
  HarnessAdapter,
  InvocationContext,
  TargetSpec,
} from "@hooknostic/core";
import { resolveCapabilityMatrix } from "@hooknostic/core";
import type { HookEvent, HookResult } from "@hooknostic/sdk";

export interface FakeAdapterOptions {
  id: string;
  adapterVersion?: string;
  profiles: CapabilityProfile[];
  supportedModes?: readonly TargetSpec["mode"][];
  /** Override native decode for runtime tests; defaults to identity-ish. */
  decode?(nativeEvent: unknown, invocation: InvocationContext): Promise<HookEvent>;
}

/**
 * A minimal in-memory adapter used to prove the capability model and the
 * compiler before (and independently of) any native adapter.
 */
export function makeFakeAdapter(options: FakeAdapterOptions): HarnessAdapter {
  const adapterVersion = options.adapterVersion ?? "0.0.0-fake";
  return {
    id: options.id,
    adapterVersion,

    supportedHarnessVersions() {
      return options.profiles.map((p) => p.range);
    },

    supportedModes() {
      return options.supportedModes ?? (["plugin", "local"] as const);
    },

    capabilities(target: TargetSpec) {
      return resolveCapabilityMatrix(options.id, options.profiles, target.version);
    },

    async compile(plugin, target): Promise<GeneratedArtifact[]> {
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
}
