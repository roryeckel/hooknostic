import type { McpIdentityEvent, McpIdentitySupport } from "./adapter.js";
import { rangeWithin } from "./native-timeout.js";

/**
 * Whether a declared MCP identity source holds for a target (ADR-0032): always
 * for a declaration without a range, otherwise only when `range` -- a target's
 * version range, or one exact build -- is within the range its evidence
 * covers. Outside it the harness is treated as stating nothing.
 */
export function mcpIdentityApplies(identity: McpIdentitySupport, range: string): boolean {
  return identity.range === undefined || rangeWithin(range, identity.range);
}

/**
 * The events on which a target's harness states an MCP tool's server and
 * tool: a `statement` declaration's events where it applies, and none
 * otherwise. `inspect`, `hooknostic dispatch`, and the contract suite all ask
 * this one question, so they cannot disagree about it.
 */
export function statedMcpEvents(identity: McpIdentitySupport | undefined, range: string): readonly McpIdentityEvent[] {
  if (identity?.source !== "statement" || !mcpIdentityApplies(identity, range)) return [];
  return identity.events ?? [];
}
