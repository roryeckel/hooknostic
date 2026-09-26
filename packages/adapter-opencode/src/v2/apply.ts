import type { HookResult } from "@hooknostic/sdk";

export interface OpenCodeV2Application {
  throwMessage?: string;
  input?: unknown;
  content?: unknown;
  system?: { type: "text"; text: string }[];
}
export function planOpenCodeV2Application(result: HookResult): OpenCodeV2Application {
  const application: OpenCodeV2Application = {};
  const terminal = result.terminatedBy ? result.effects.at(-1)?.effect : undefined;
  if (terminal?.kind === "block") return { throwMessage: terminal.reason };
  for (const { effect } of result.effects) {
    if (effect.kind === "replaceInput") application.input = effect.input;
    if (effect.kind === "replaceOutput")
      application.content = typeof effect.output === "string" ? effect.output : JSON.stringify(effect.output);
    if (effect.kind === "addContext") (application.system ??= []).push({ type: "text", text: effect.context });
  }
  return application;
}
