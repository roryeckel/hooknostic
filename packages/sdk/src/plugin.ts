import type { HookDefinition } from "./hook.js";

export interface PluginSpec {
  /** Plugin name; reused for generated native manifests. */
  name: string;
  version?: string;
  description?: string;
  hooks: HookDefinition[];
}

export function definePlugin(spec: PluginSpec): PluginSpec {
  return spec;
}
