import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { piHarness } from "@hooknostic/adapter-pi";
import { AGENT_PLUGIN_MANIFEST_SCHEMA, AGENT_PLUGIN_MCP_SCHEMA } from "@hooknostic/agent-plugin";

import { runBuild } from "./build.js";
import { runCheck } from "./check.js";
import { runInspect } from "./inspect.js";
import { defaultAdapterRegistry } from "./registry.js";

const transports = ["stdio", "streamable-http", "sse"] as const;
const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture(delivery: "package" | "project", accept: string[]) {
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
      targets: { reader: { adapter: "pi", version: piHarness.referenceVersion, delivery, output: "dist/pi" } },
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

describe.each(["package", "project"] as const)("Pi omission acceptance: %s", (delivery) => {
  it.each([true, false])("exposes omission IDs through inspect (json=%s)", async (json) => {
    const lines: string[] = [];
    expect(
      await runInspect({
        target: "pi",
        version: piHarness.referenceVersion,
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
