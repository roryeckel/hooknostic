import type { AgentPluginProjectionProfile } from "@hooknostic/agent-plugin";

import { codexHarness } from "./harness.js";

type Validation = AgentPluginProjectionProfile["source"]["validatedOn"][number];
export const codexAgentSchemaValidation: readonly Validation[] = [
  {
    version: codexHarness.referenceVersion,
    date: "2026-10-17",
    method: "schema-derived",
    artifact: ".capture/agents",
    what: "Native agent validation uses the reference build's published ConfigToml JSON schema plus the standalone role file's nickname metadata. Unknown keys and invalid nested values fail before emission. Schema acceptance alone does not establish an effective role override.",
  },
  {
    version: "0.156.1",
    date: "2026-10-17",
    method: "schema-derived",
    artifact: ".capture/agents",
    what: "A second published ConfigToml schema validates newer agent files. A target spanning both schema families must satisfy both. The source-derived role override audit is recorded separately; a parsed root-config key need not affect a child.",
  },
];

export const codexAgentLoaderValidation: Validation = {
  version: codexAgentSchemaValidation[1]!.version,
  date: "2026-10-17",
  method: "type-derived",
  artifact: ".capture/agents",
  what: "Published role.rs and child_config.rs restrict role overrides to model/instruction settings and supported capability disabling, then reapply the parent's live permissions. Other schema-valid fields, true/unsupported feature flags, and ignored skill settings are reported conditionally. This loader audit is source-derived, not additional live behavioral coverage.",
};

export const codexAgentPolicyValidation: Validation = {
  version: codexHarness.referenceVersion,
  date: "2026-10-17",
  method: "type-derived",
  artifact: ".capture/agents",
  what: "The reference role loader rebuilds configuration from its role layer, then multi_agents_common.rs reapplies the parent's approval policy, reviewer, cwd and permission profile. Permission-related native fields therefore cannot replace the live child policy. Wider root configuration reloads on this build are not equivalent to the newer bounded override list.",
};

export const codexAgentNativeValidation: readonly Validation[] = codexAgentSchemaValidation.map(({ version }) => ({
  version,
  date: "2026-10-17",
  method: "live-probe",
  artifact: ".capture/agents",
  what: "With an isolated parent configured for full access, both a native agent file and a generated portable agent requested read-only. Each child reported danger-full-access and its scripted write landed. Generated delivery preserved sandbox_mode in TOML and explicitly accepted the reported shortfall. Loopback-only evidence: evidence/codex-agent-native.json.",
}));
