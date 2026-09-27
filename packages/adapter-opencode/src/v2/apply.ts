import type { HookResult } from "@hooknostic/sdk";

export interface OpenCodeV2Application {
  throwMessage?: string;
  input?: unknown;
  content?: unknown;
  system?: { type: "text"; text: string }[];
  /**
   * turn.stop messages the shim admits with `session.synthetic`, in order.
   * `resume: false` is a notice that starts no execution; `resume: true` is
   * stop prevention. At most one entry resumes and it is last, so every notice
   * is admitted before the instruction that keeps the agent working.
   */
  synthetic?: { text: string; resume: boolean }[];
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
  if (result.event === "turn.stop") {
    const synthetic = result.effects.flatMap(({ effect }) =>
      effect.kind === "notify" ? [{ text: effect.message, resume: false }] : [],
    );
    if (terminal?.kind === "preventStop")
      synthetic.push({ text: terminal.reason ?? "hooknostic: continue working", resume: true });
    if (synthetic.length > 0) application.synthetic = synthetic;
  }
  return application;
}
