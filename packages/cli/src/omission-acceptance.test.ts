import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { piCapabilityProfiles, piHarness, piMcpIdentity } from "@hooknostic/adapter-pi";
import { AGENT_PLUGIN_MANIFEST_SCHEMA, AGENT_PLUGIN_MCP_SCHEMA } from "@hooknostic/agent-plugin";

import { runBuild } from "./build.js";
import { runCheck } from "./check.js";
import { runInspect } from "./inspect.js";
import { defaultAdapterRegistry } from "./registry.js";

const transports = ["stdio", "streamable-http", "sse"] as const;
// The three omissions belong to pi 0.84, which has no native MCP channel. 1.x
// registers stdio and streamable-HTTP servers natively and omits only SSE.
const LEGACY = piCapabilityProfiles.find((profile) => profile.range.startsWith(">=0.84"))!.range;
const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture(delivery: "package" | "project", accept: string[], version = LEGACY) {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-omissions-"));
  scratch.push(root);
  await mkdir(join(root, "skills/review"), { recursive: true });
  await writeFile(
    join(root, "plugin.json"),
    JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "omission-example", version: "1.0.0" }),
  );
  await writeFile(
    join(root, "skills/review/SKILL.md"),
    "---\nname: review\ndescription: Review code.\n---\nReview the changes.\n",
  );
  await writeFile(
    join(root, "mcp.json"),
    JSON.stringify({
      $schema: AGENT_PLUGIN_MCP_SCHEMA,
      mcpServers: {
        local: { type: "stdio", command: "node", args: ["--version"] },
        remote: { type: "streamable-http", url: "https://example.invalid/mcp" },
        legacy: { type: "sse", url: "https://example.invalid/sse" },
      },
    }),
  );
  const config = join(root, "hooknostic.config.ts");
  await writeFile(
    config,
    `export default ${JSON.stringify({
      ...(delivery === "project" ? { project: { root: "." } } : {}),
      components: { root: ".", accept },
      targets: { reader: { adapter: "pi", version, delivery, output: "dist/pi" } },
    })};`,
  );
  return { root, config };
}

async function invoke(run: typeof runBuild | typeof runCheck, config: string) {
  let output = "";
  const code = await run({
    config,
    json: true,
    registry: defaultAdapterRegistry(),
    evaluate: { alias: { "@hooknostic/sdk": fileURLToPath(new URL("../../sdk/src/index.ts", import.meta.url)) } },
    io: {
      stdout: (text: string) => {
        output += text;
      },
      stderr: () => {},
    },
  });
  return { code, report: JSON.parse(output) };
}

describe.each(["package", "project"] as const)("Pi 1.x omission acceptance: %s", (delivery) => {
  it("exposes only the SSE omission through inspect", async () => {
    const lines: string[] = [];
    expect(
      await runInspect({
        target: "pi",
        version: piHarness.referenceVersion,
        delivery,
        json: true,
        registry: defaultAdapterRegistry(),
        io: {
          stdout: (text) => {
            lines.push(text);
          },
          stderr: () => {},
        },
      }),
    ).toBe(0);
    const output = lines.join("\n");
    expect(JSON.parse(output).mcpIdentity).toMatchObject({ source: "statement", applies: true });
    expect(output).toContain("pi:mcp-sse-omitted");
    expect(output).not.toContain("pi:mcp-stdio-omitted");
    expect(output).not.toContain("pi:mcp-streamable-http-omitted");
  });

  it("projects stdio and streamable-HTTP servers once the SSE omission is accepted", async () => {
    const { config } = await fixture(delivery, ["pi:mcp-sse-omitted"], piHarness.referenceVersion);
    const { code, report } = await invoke(runCheck, config);
    expect(code, JSON.stringify(report.diagnostics)).toBe(0);
    const hn205 = report.diagnostics.filter((item: { code: string }) => item.code === "HN205");
    expect(hn205).toEqual([
      expect.objectContaining({
        target: "reader",
        component: "agent-plugin.mcp.sse",
        severity: "info",
        omission: "pi:mcp-sse-omitted",
      }),
    ]);
  });
});

describe.each(["package", "project"] as const)("Pi 0.84 omission acceptance: %s", (delivery) => {
  it.each([true, false])("exposes omission IDs through inspect (json=%s)", async (json) => {
    const lines: string[] = [];
    expect(
      await runInspect({
        target: "pi",
        version: LEGACY,
        delivery,
        json,
        registry: defaultAdapterRegistry(),
        io: {
          stdout: (text) => {
            lines.push(text);
          },
          stderr: () => {},
        },
      }),
    ).toBe(0);
    const output = lines.join("\n");
    for (const type of transports) expect(output).toContain(`pi:mcp-${type}-omitted`);
    // ADR-0032: the MCP identity statement is established for 1.x only.
    if (json) expect(JSON.parse(output).mcpIdentity).toMatchObject({ applies: false });
    else expect(output).toContain(`tool.mcp source (outside ${piMcpIdentity.range})`);
  });

  it.each(transports)("accepts only the named %s transport", async (transport) => {
    const { config } = await fixture(delivery, [`pi:mcp-${transport}-omitted`]);
    const { code, report } = await invoke(runCheck, config);
    expect(code).toBe(2);
    for (const type of transports) {
      expect(report.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "HN205",
          target: "reader",
          component: `agent-plugin.mcp.${type}`,
          severity: type === transport ? "info" : "error",
          support: "unsupported",
          omission: `pi:mcp-${type}-omitted`,
        }),
      );
    }
  });

  it("checks and builds accepted omissions with truthful skipped counts", async () => {
    const { root, config } = await fixture(
      delivery,
      transports.map((type) => `pi:mcp-${type}-omitted`),
    );
    for (const run of [runCheck, runBuild]) {
      const { code, report } = await invoke(run, config);
      expect(code, JSON.stringify(report.diagnostics)).toBe(0);
      const target = report.targets.reader;
      expect(run === runCheck ? target.ok : target.status).toBe(run === runCheck ? true : "success");
      expect(report.diagnostics.filter((item: { code: string }) => item.code === "HN205")).toHaveLength(3);
      if (run === runCheck && delivery === "project") continue;
      const summary = delivery === "package" ? target.projection : target.project;
      for (const type of transports) {
        expect(summary.components[`agent-plugin.mcp.${type}`]).toEqual({
          support: "unsupported",
          discovered: 1,
          emitted: 0,
          skipped: 1,
        });
        expect(summary.omissions).toContainEqual(expect.objectContaining({ component: `agent-plugin.mcp.${type}` }));
      }
      expect(summary.components["agent-plugin.skills"]).toMatchObject({ emitted: 1, skipped: 0 });
    }
    if (delivery === "package") {
      const manifest = JSON.parse(await readFile(join(root, "dist/pi/package.json"), "utf8"));
      expect(manifest.pi).toEqual({ skills: ["./package/skills/review"] });
    }
  });

  it("does not accept misspelled or target-name-qualified IDs", async () => {
    for (const id of ["pi:mcp-http-omitted", "reader:mcp-stdio-omitted"]) {
      const { config } = await fixture(delivery, [id]);
      const { code, report } = await invoke(runCheck, config);
      expect(code).toBe(2);
      expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: "HN501", severity: "error" }));
    }
  });

  it("keeps invalid MCP input fatal even when its omission is accepted", async () => {
    const { root, config } = await fixture(
      delivery,
      transports.map((type) => `pi:mcp-${type}-omitted`),
    );
    await writeFile(
      join(root, "mcp.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: { broken: { type: "stdio", args: [] } } }),
    );
    const { code, report } = await invoke(runCheck, config);
    expect(code).toBe(2);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: "HN503", severity: "error" }));
  });

  it("does not waive required hook capabilities", async () => {
    const { root, config } = await fixture(
      delivery,
      transports.map((type) => `pi:mcp-${type}-omitted`),
    );
    await writeFile(
      join(root, "hooks.ts"),
      `import { definePlugin, hook } from "@hooknostic/sdk";
      export default definePlugin({ name: "required-approval", hooks: [hook("tool.before", {
        id: "approval", capabilities: { requestApproval: "required" }, run() {},
      })] });`,
    );
    const authored = await readFile(config, "utf8");
    await writeFile(config, authored.replace("export default {", 'export default {"entry":"./hooks.ts",'));
    const { code, report } = await invoke(runCheck, config);
    expect(code).toBe(2);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HN201", severity: "error", capability: "tool.before.requestApproval" }),
    );
  });
});
