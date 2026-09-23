import { describe, expect, it } from "vitest";

import {
  AGENT_PLUGIN_MANIFEST_SCHEMA,
  type AgentPluginPackage,
  type AgentPluginProjector,
} from "@hooknostic/agent-plugin";

import type { HarnessAdapter, TargetSpec } from "./adapter.js";
import {
  analyzeAgentPluginProjection,
  diagnosticsFromAgentPluginDegradations,
  diagnosticsFromAgentPluginDeviations,
  diagnosticsFromAgentPluginIssues,
  resolveAgentPluginProjection,
} from "./agent-plugin.js";

const target: TargetSpec = { id: "test", version: ">=2.1 <3", delivery: "package", output: "dist" };
const projector: AgentPluginProjector<TargetSpec> = {
  namespace: "example.test",
  profiles: [
    {
      range: ">=2.1 <2.5",
      components: { "agent-plugin.skills": { level: "exact" } },
      source: {
        date: "2026-09-04",
        validatedOn: [{ version: "2.1.0", date: "2026-09-04", method: "captured", what: "first range" }],
      },
    },
    {
      range: ">=2.5 <3",
      components: { "agent-plugin.skills": { level: "approximate", rationale: "loses metadata" } },
      source: {
        date: "2026-09-04",
        validatedOn: [{ version: "2.5.0", date: "2026-09-04", method: "captured", what: "second range" }],
      },
    },
  ],
  async project() {
    return { files: [], issues: [], summary: { components: {}, omissions: [], copiedPaths: [] } };
  },
};

const manifestOnlyExtensionSource: AgentPluginPackage = {
  specVersion: "1.0.0",
  root: "/portable",
  manifest: {
    $schema: AGENT_PLUGIN_MANIFEST_SCHEMA,
    name: "manifest-only-extension",
    extensions: { "example.test": { enabled: true } },
  },
  skills: [],
  files: [],
  contentDigest: "sha256:test",
};

const adapterWithProjector = { id: "test", agentPluginProjector: projector } as HarnessAdapter;

describe("resolveAgentPluginProjection", () => {
  it("takes the least capable support across every intersected profile", () => {
    const result = resolveAgentPluginProjection(target, projector);
    expect(result.diagnostics).toEqual([]);
    expect(result.matrix?.["agent-plugin.skills"]).toMatchObject({ level: "approximate" });
  });

  it("rejects version ranges not fully covered by projection evidence", () => {
    const result = resolveAgentPluginProjection({ ...target, version: ">=2 <4" }, projector);
    expect(result.matrix).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "HN203", severity: "error" }));
  });

  // A build ships into every version its range admits, so a deviation any of
  // them has belongs to the whole range, even when another profile's level
  // is the one chosen.
  it("carries every intersected profile's deviations, once each", () => {
    const expansion = { id: "expansion", summary: "expands text", evidence: ".capture/one" };
    const other = { id: "other", summary: "drops text", evidence: ".capture/two" };
    // `other` sits only on the profile whose level is NOT chosen, so taking
    // the chosen cell's deviations alone would lose it.
    const deviating: AgentPluginProjector<TargetSpec> = {
      ...projector,
      profiles: [
        {
          ...projector.profiles[0]!,
          components: { "agent-plugin.skills": { level: "exact", deviations: [expansion, other] } },
        },
        {
          ...projector.profiles[1]!,
          components: {
            "agent-plugin.skills": { level: "approximate", rationale: "loses metadata", deviations: [expansion] },
          },
        },
      ],
    };
    const whole = resolveAgentPluginProjection(target, deviating).matrix?.["agent-plugin.skills"];
    expect(whole).toEqual({ level: "approximate", rationale: "loses metadata", deviations: [expansion, other] });
    const late = resolveAgentPluginProjection({ ...target, version: ">=2.5 <3" }, deviating).matrix;
    expect(late?.["agent-plugin.skills"]?.deviations).toEqual([expansion]);
  });

  // The fake projector's skills resolve to `approximate` across the whole range.
  it.each([
    [{ minimum: "emulated", onBelowMinimum: "error" }, ["error"]],
    [{ minimum: "exact", onBelowMinimum: "warn" }, ["warn"]],
    [{ minimum: "approximate", onBelowMinimum: "error" }, []],
    [undefined, []],
  ] as const)("reports a discovered component below compatibility %j", (compatibility, severities) => {
    const withSkill: AgentPluginPackage = {
      ...manifestOnlyExtensionSource,
      manifest: { ...manifestOnlyExtensionSource.manifest, extensions: {} },
      skills: [
        { name: "review", description: "Review", directory: "skills/review", manifestPath: "skills/review/SKILL.md" },
      ],
    };
    const result = analyzeAgentPluginProjection(
      withSkill,
      adapterWithProjector,
      target,
      "error",
      undefined,
      compatibility,
    );
    expect(result.diagnostics.filter((item) => item.component === "agent-plugin.skills")).toEqual(
      severities.map((severity) =>
        expect.objectContaining({
          code: "HN206",
          severity,
          support: "approximate",
          rationale: "loses metadata",
        }),
      ),
    );
  });

  it("reports HN205 for a manifest-only client extension without projector support", () => {
    const result = analyzeAgentPluginProjection(manifestOnlyExtensionSource, adapterWithProjector, target, "error");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HN205",
        severity: "error",
        component: "agent-plugin.client-extension.files",
      }),
    );
  });
});

describe("diagnosticsFromAgentPluginIssues", () => {
  const issue = { severity: "warn", scope: "projection", component: "agent-plugin.skills", message: "m" } as const;

  it("reports a projection issue for a component as an omission", () => {
    expect(diagnosticsFromAgentPluginIssues([issue], "t")).toEqual([
      expect.objectContaining({ code: "HN205", severity: "warn", target: "t", component: "agent-plugin.skills" }),
    ]);
  });

  it("reports a package issue as invalid", () => {
    expect(diagnosticsFromAgentPluginIssues([{ ...issue, scope: "skill" }], "t")).toEqual([
      expect.objectContaining({ code: "HN503" }),
    ]);
  });
});

describe("diagnosticsFromAgentPluginDeviations", () => {
  const support = {
    "agent-plugin.mcp.stdio": {
      level: "exact" as const,
      deviations: [{ id: "mcp-environment-expansion", summary: "expands text", evidence: ".capture/probe" }],
    },
  };
  const deviation = {
    id: "mcp-environment-expansion",
    component: "agent-plugin.mcp.stdio" as const,
    name: "worker",
    path: "mcp.json#worker",
    reason: "MCP server worker contains ${TOKEN}.",
  };

  it.each(["warn", "error"] as const)("reports a declared deviation as HN106 at severity %s", (onDeviation) => {
    expect(
      diagnosticsFromAgentPluginDeviations([deviation], { target: "claude", adapter: "claude", onDeviation, support }),
    ).toEqual([
      expect.objectContaining({
        code: "HN106",
        severity: onDeviation,
        target: "claude",
        component: "agent-plugin.mcp.stdio",
        deviation: "claude:mcp-environment-expansion",
        location: { file: "mcp.json#worker" },
        message: deviation.reason,
        rationale: "expands text (.capture/probe)",
      }),
    ]);
  });

  // Declared for one component is not declared for another: a projector that
  // reports an id its profile does not carry is a defect, and warn mode must
  // not soften that into an unexplained warning.
  it.each([
    { ...deviation, id: "undeclared" },
    { ...deviation, component: "agent-plugin.mcp.sse" as const },
  ])("fails a deviation the resolved profile does not declare: %j", (reported) => {
    expect(
      diagnosticsFromAgentPluginDeviations([reported], {
        target: "claude",
        adapter: "claude",
        onDeviation: "warn",
        support,
      }),
    ).toEqual([expect.objectContaining({ code: "HN301", severity: "error" })]);
  });

  // Seen and chosen, which is different from nobody having looked: still
  // reported, never at a severity that fails or nags.
  it("reports an accepted deviation as information whatever the policy", () => {
    expect(
      diagnosticsFromAgentPluginDeviations([deviation], {
        target: "claude",
        adapter: "claude",
        onDeviation: "error",
        support,
        accept: ["claude:mcp-environment-expansion"],
      }),
    ).toEqual([expect.objectContaining({ code: "HN106", severity: "info" })]);
  });

  it("does not let an accepted id excuse an undeclared report", () => {
    expect(
      diagnosticsFromAgentPluginDeviations([{ ...deviation, id: "undeclared" }], {
        target: "claude",
        adapter: "claude",
        onDeviation: "warn",
        support,
        accept: ["claude:undeclared"],
      }),
    ).toEqual([expect.objectContaining({ code: "HN301", severity: "error" })]);
  });
});

describe("diagnosticsFromAgentPluginDegradations", () => {
  const support = {
    "agent-plugin.skills": {
      level: "emulated" as const,
      degradations: [{ id: "skill-name-unqualified", summary: "keeps its name", evidence: ".capture/probe" }],
      // A deviation of the same id must not satisfy a degradation report.
      deviations: [{ id: "deviation-only", summary: "other", evidence: ".capture/probe" }],
    },
  };
  const degradation = {
    id: "skill-name-unqualified",
    component: "agent-plugin.skills" as const,
    name: "status",
    path: "skills/status/SKILL.md",
    reason: "skill status keeps its bare name.",
  };

  it.each(["warn", "error"] as const)("reports a declared degradation as HN101 at severity %s", (onDegraded) => {
    expect(
      diagnosticsFromAgentPluginDegradations([degradation], {
        target: "opencode",
        adapter: "opencode",
        onDegraded,
        support,
      }),
    ).toEqual([
      expect.objectContaining({
        code: "HN101",
        severity: onDegraded,
        component: "agent-plugin.skills",
        degradation: "opencode:skill-name-unqualified",
        location: { file: "skills/status/SKILL.md" },
        message: degradation.reason,
        rationale: "keeps its name (.capture/probe)",
      }),
    ]);
  });

  it("reports an accepted degradation as information", () => {
    expect(
      diagnosticsFromAgentPluginDegradations([degradation], {
        target: "opencode",
        adapter: "opencode",
        onDegraded: "error",
        support,
        accept: ["opencode:skill-name-unqualified"],
      }),
    ).toEqual([expect.objectContaining({ code: "HN101", severity: "info" })]);
  });

  // Accepting one id accepts nothing else, and an id qualified by another
  // adapter is a different id.
  it.each([["opencode:other"], ["claude:skill-name-unqualified"]])(
    "applies the policy when only %s is accepted",
    (accepted) => {
      expect(
        diagnosticsFromAgentPluginDegradations([degradation], {
          target: "opencode",
          adapter: "opencode",
          onDegraded: "error",
          support,
          accept: [accepted],
        }),
      ).toEqual([expect.objectContaining({ severity: "error" })]);
    },
  );

  it("fails a degradation declared only as a deviation", () => {
    expect(
      diagnosticsFromAgentPluginDegradations([{ ...degradation, id: "deviation-only" }], {
        target: "opencode",
        adapter: "opencode",
        onDegraded: "warn",
        support,
      }),
    ).toEqual([expect.objectContaining({ code: "HN301", severity: "error" })]);
  });
});
