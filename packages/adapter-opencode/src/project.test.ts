import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AGENT_PLUGIN_MCP_SCHEMA, loadProjectComponents, type ProjectComponents } from "@hooknostic/agent-plugin";

import { projectComponents, projectIntegration } from "./project.js";

const roots: string[] = [];
afterEach(async () => {
  delete process.env["HOOKNOSTIC_PROJECT_TOKEN"];
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function source(
  origin: ProjectComponents["origin"],
  mcpServers: NonNullable<ProjectComponents["mcp"]>["config"]["mcpServers"] = {
    remote: {
      type: "streamable-http",
      url: "https://example.invalid/${HOOKNOSTIC_PROJECT_TOKEN}/mcp",
      headers: { Authorization: "Bearer ${HOOKNOSTIC_PROJECT_TOKEN}" },
    },
  },
): ProjectComponents {
  return {
    origin,
    skills: [],
    mcp: { root: ".", config: { $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers } },
  };
}

async function moduleFor(
  origin: ProjectComponents["origin"],
  options: { mcpStartupTimeoutMs?: Record<string, number> } = {},
  mcpServers?: Parameters<typeof source>[1],
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-opencode-project-"));
  roots.push(root);
  const integration = await projectComponents(
    source(origin, mcpServers),
    root,
    ".hooknostic/artifacts/opencode",
    "hooknostic.config.ts",
    options,
  );
  const artifact = integration.files.find((file) => file.path === ".opencode/plugins/hooknostic-components.js")!;
  const text = typeof artifact.contents === "string" ? artifact.contents : new TextDecoder().decode(artifact.contents);
  const path = join(root, artifact.path);
  await mkdir(join(root, ".opencode/plugins"), { recursive: true });
  await writeFile(path, text);
  return path;
}

describe("OpenCode project components", () => {
  it("materializes only the filtered direct skill inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "hooknostic-opencode-skills-"));
    roots.push(root);
    await mkdir(join(root, "skills/review"), { recursive: true });
    await mkdir(join(root, "skills/rejected"), { recursive: true });
    await writeFile(join(root, "skills/review/SKILL.md"), "---\nname: review\ndescription: Review a change\n---\n");
    await writeFile(join(root, "skills/review/credentials.md"), "excluded\n");
    await writeFile(join(root, "skills/rejected/SKILL.md"), "invalid\n");
    const loaded = await loadProjectComponents({
      skills: [join(root, "skills")],
      exclude: ["review/credentials.md"],
    });

    const integration = await projectComponents(
      loaded.source,
      root,
      ".hooknostic/artifacts/opencode",
      "hooknostic.config.ts",
      {},
    );

    expect(integration.files.map((file) => file.path)).toContain(".agents/skills/review/SKILL.md");
    expect(integration.files.map((file) => file.path)).not.toContain(".agents/skills/review/credentials.md");
    expect(integration.files.map((file) => file.path)).not.toContain(".agents/skills/rejected/SKILL.md");
    expect(integration.files.map((file) => file.path)).not.toContain(".opencode/plugins/hooknostic-components.js");
  });

  it("imports generated project modules from URL-significant output paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "hooknostic-opencode-import-"));
    roots.push(root);
    const output = ".hooknostic/artifacts/space # percent % unicode ü";
    const artifact = ".opencode/plugins/hooknostic.js";
    const integration = projectIntegration([{ path: artifact, contents: "export default 1;\n" }], output);
    const wrapper = integration.files.find((file) => file.path === artifact)!;
    const generated = join(root, output, artifact);
    const wrapperPath = join(root, artifact);
    await mkdir(join(generated, ".."), { recursive: true });
    await mkdir(join(wrapperPath, ".."), { recursive: true });
    await writeFile(generated, "export default 1;\n");
    await writeFile(wrapperPath, wrapper.contents);

    const run = spawnSync(process.execPath, [wrapperPath], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
  });

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
    expect(generated).not.toContain("config.skills");

    process.env["HOOKNOSTIC_PROJECT_TOKEN"] = "runtime-secret";
    const plugin = await (await import(pathToFileURL(path).href)).default();
    const config: { mcp?: Record<string, { url: string; headers: Record<string, string> }> } = {};
    plugin.config(config);
    expect(config.mcp?.["remote"]).toMatchObject({
      url: "https://example.invalid/runtime-secret/mcp",
      headers: { Authorization: "Bearer runtime-secret" },
    });
  });

  it("disables only a direct server whose environment is unavailable", async () => {
    const path = await moduleFor("direct");
    const plugin = await (await import(pathToFileURL(path).href + "?missing")).default();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const config: { mcp?: Record<string, { enabled: boolean; url?: string }> } = {
      mcp: { inherited: { enabled: true } },
    };
    plugin.config(config);
    expect(config.mcp?.["remote"]).toMatchObject({
      enabled: false,
      url: "https://example.invalid/${HOOKNOSTIC_PROJECT_TOKEN}/mcp",
    });
    expect(config.mcp?.["inherited"]).toEqual({ enabled: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("HOOKNOSTIC_PROJECT_TOKEN"));
    warn.mockRestore();
  });

  // The rules Claude applies to the same text natively
  // (`.capture/claude-project-mcp-environment`): a defined variable wins even
  // when empty, and only an undefined one takes the default.
  it("resolves a direct `${NAME:-default}` as Claude does, without disabling the server", async () => {
    process.env["HOOKNOSTIC_PROJECT_TOKEN"] = "";
    expect(process.env["HOOKNOSTIC_PROJECT_UNSET"]).toBeUndefined();
    const path = await moduleFor(
      "direct",
      {},
      {
        defaulted: {
          type: "streamable-http",
          url: "https://example.invalid/${HOOKNOSTIC_PROJECT_UNSET:-anonymous}/mcp",
          headers: {
            Authorization: "Bearer ${HOOKNOSTIC_PROJECT_UNSET:-}",
            "X-Empty": "${HOOKNOSTIC_PROJECT_TOKEN:-unused}",
          },
        },
      },
    );
    const plugin = await (await import(pathToFileURL(path).href + "?defaulted")).default();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const config: { mcp?: Record<string, { enabled?: boolean; url: string; headers: Record<string, string> }> } = {};
    plugin.config(config);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    expect(config.mcp?.["defaulted"]?.enabled).toBe(true);
    expect(config.mcp?.["defaulted"]).toMatchObject({
      url: "https://example.invalid/anonymous/mcp",
      headers: { Authorization: "Bearer ", "X-Empty": "" },
    });
  });

  it("lets project MCP declarations replace inherited servers", async () => {
    process.env["HOOKNOSTIC_PROJECT_TOKEN"] = "project-token";
    const path = await moduleFor("direct");
    const plugin = await (await import(pathToFileURL(path).href + "?collision")).default();
    const config: { mcp?: Record<string, { url?: string }> } = {
      mcp: {
        remote: { url: "https://global.invalid/mcp" },
        inherited: { url: "https://inherited.invalid/mcp" },
      },
    };
    plugin.config(config);
    expect(config.mcp?.["remote"]?.url).toBe("https://example.invalid/project-token/mcp");
    expect(config.mcp?.["inherited"]?.url).toBe("https://inherited.invalid/mcp");
  });

  it("emits target-native MCP startup timeouts", async () => {
    process.env["HOOKNOSTIC_PROJECT_TOKEN"] = "project-token";
    const path = await moduleFor("direct", { mcpStartupTimeoutMs: { remote: 60_000 } });
    const plugin = await (await import(pathToFileURL(path).href + "?timeout")).default();
    const config: { mcp?: Record<string, { timeout?: number }> } = {};
    plugin.config(config);
    expect(config.mcp?.["remote"]?.timeout).toBe(60_000);
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
