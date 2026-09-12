import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_PLUGIN_MCP_SCHEMA, type ProjectComponents } from "@hooknostic/agent-plugin";
import { projectComponents, projectIntegration } from "./project.js";

const roots: string[] = [];
afterEach(async () => {
  delete process.env["HOOKNOSTIC_PROJECT_TOKEN"];
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function source(origin: ProjectComponents["origin"]): ProjectComponents {
  return {
    origin,
    skills: [],
    mcp: {
      root: ".",
      config: {
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: {
          remote: {
            type: "streamable-http",
            url: "https://example.invalid/${HOOKNOSTIC_PROJECT_TOKEN}/mcp",
            headers: { Authorization: "Bearer ${HOOKNOSTIC_PROJECT_TOKEN}" },
          },
        },
      },
    },
  };
}

async function moduleFor(origin: ProjectComponents["origin"]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-opencode-project-"));
  roots.push(root);
  const integration = await projectComponents(source(origin), root, ".hooknostic/artifacts/opencode");
  const artifact = integration.files.find(file => file.path === ".opencode/plugins/hooknostic-components.js")!;
  const text = typeof artifact.contents === "string" ? artifact.contents : new TextDecoder().decode(artifact.contents);
  const path = join(root, artifact.path);
  await mkdir(join(root, ".opencode/plugins"), { recursive: true });
  await writeFile(path, text);
  return path;
}

describe("OpenCode project components", () => {
  it("pins generated project modules against Git line-ending conversion", () => {
    expect(projectIntegration([], "out").files).toContainEqual({
      path: ".opencode/plugins/.gitattributes",
      contents: ".gitattributes -text\nhooknostic.js -text\nhooknostic-components.js -text\n",
    });
  });

  it("resolves direct MCP environment references at module load without writing secrets", async () => {
    const path = await moduleFor("direct");
    const generated = await readFile(path, "utf8");
    expect(generated).toContain("${HOOKNOSTIC_PROJECT_TOKEN}");
    expect(generated).not.toContain("runtime-secret");

    process.env["HOOKNOSTIC_PROJECT_TOKEN"] = "runtime-secret";
    const plugin = await (await import(pathToFileURL(path).href)).default();
    const config: { mcp?: Record<string, { url: string; headers: Record<string, string> }> } = {};
    plugin.config(config);
    expect(config.mcp?.["remote"]).toMatchObject({
      url: "https://example.invalid/runtime-secret/mcp",
      headers: { Authorization: "Bearer runtime-secret" },
    });
  });

  it("fails direct activation when a referenced variable is unavailable", async () => {
    const path = await moduleFor("direct");
    const plugin = await (await import(pathToFileURL(path).href + "?missing")).default();
    expect(() => plugin.config({})).toThrow("environment variable HOOKNOSTIC_PROJECT_TOKEN is required");
  });

  it("keeps Agent Plugin package remote fields literal", async () => {
    const path = await moduleFor("package");
    const generated = await readFile(path, "utf8");
    expect(generated).not.toContain("process.env");
    process.env["HOOKNOSTIC_PROJECT_TOKEN"] = "must-not-expand";
    const plugin = await (await import(pathToFileURL(path).href)).default();
    const config: { mcp?: Record<string, { url: string }> } = {};
    plugin.config(config);
    expect(config.mcp?.["remote"]?.url).toContain("${HOOKNOSTIC_PROJECT_TOKEN}");
  });
});
