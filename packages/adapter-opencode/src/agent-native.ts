import type { AgentDefinition, AgentPluginComponentSupport, AgentPluginDegradation } from "@hooknostic/agent-plugin";
import { servesAsSubagent } from "@hooknostic/agent-plugin";

export const AGENT_STEP_LIMIT_IGNORED = "agent-step-limit-ignored";

/** Enabled only by a profile with observed ineffective native step caps. */
export function stepLimitDegradations(
  agents: readonly AgentDefinition[],
  cell: AgentPluginComponentSupport | undefined,
): AgentPluginDegradation[] {
  if (!cell?.degradations?.some((item) => item.id === AGENT_STEP_LIMIT_IGNORED)) return [];
  return agents.flatMap((agent) => {
    if (!servesAsSubagent(agent.mode)) return [];
    const native = agent.native["opencode"] ?? {};
    const keys = ["steps", "maxSteps"].filter((key) => native[key] !== undefined);
    return keys.length
      ? [
          {
            id: AGENT_STEP_LIMIT_IGNORED,
            component: "agents.native" as const,
            name: agent.name,
            path: agent.source,
            reason: `agent ${JSON.stringify(agent.name)} sets native.opencode ${keys.join(", ")}, but the validated OpenCode v1 task route does not enforce that child step limit on either project or package delivery.`,
          },
        ]
      : [];
  });
}
