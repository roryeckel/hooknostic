import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { AGENT_PLUGIN_MCP_SCHEMA } from "@hooknostic/agent-plugin";

import { projectOpenCodeV2Components, projectOpenCodeV2Integration } from "./project.js";

type Plugin = { id: string; setup(ctx: unknown): unknown };
const roots: string[] = [];
const served: string[] = [];
(globalThis as { served?: string[] }).served = served;
afterEach(async () => {
  served.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const output = ".hooknostic/artifacts/opencode";
const text = (contents: string | Uint8Array): string =>
  typeof contents === "string" ? contents : new TextDecoder().decode(contents);

/** A checkout with generated v2 wiring whose probe artifact records which copy served. */
async function checkout(
  root: string,
  label: string,
  integrated = true,
): Promise<{ plugin: Plugin; components: Plugin }> {
  const artifact = ".opencode/plugins/hooknostic.js";
  await mkdir(join(root, output, ".opencode/plugins"), { recursive: true });
  await writeFile(
    join(root, output, artifact),
    `export default { id: "hooknostic.probe.opencode", setup() { globalThis.served.push(${JSON.stringify(label)}); } };\n`,
  );
  const integration = projectOpenCodeV2Integration([{ path: artifact, contents: "" }], output, "hooknostic.config.ts");
  const components = await projectOpenCodeV2Components(
    {
      origin: "direct",
      skills: [],
      mcp: {
        root: ".",
        config: {
          $schema: AGENT_PLUGIN_MCP_SCHEMA,
          mcpServers: { probe: { type: "streamable-http", url: `https://${label}.invalid/mcp` } },
        },
      },
    },
    root,
    output,
    "hooknostic.config.ts",
    {},
  );
  for (const file of [...integration.files, ...components.files].filter((f) => f.path.startsWith(".opencode/"))) {
    await mkdir(join(root, file.path, ".."), { recursive: true });
    await writeFile(join(root, file.path), text(file.contents));
  }
  if (integrated) {
    await mkdir(join(root, ".hooknostic"), { recursive: true });
    await writeFile(join(root, ".hooknostic/integration.json"), "{}\n");
  }
  const load = async (path: string) =>
    ((await import(pathToFileURL(join(root, path)).href)) as { default: Plugin }).default;
  return { plugin: await load(artifact), components: await load(".opencode/plugins/hooknostic-components.js") };
}

async function layout(nestedIntegrated = true) {
  const base = await mkdtemp(join(tmpdir(), "hooknostic-v2-nested-"));
  roots.push(base);
  const outerRoot = join(base, "outer");
  const nestedRoot = join(outerRoot, ".claude", "worktrees", "nested");
  const inside = join(nestedRoot, "src");
  await mkdir(inside, { recursive: true });
  return {
    outerRoot,
    inside,
    outer: await checkout(outerRoot, "outer"),
    nested: await checkout(nestedRoot, "nested", nestedIntegrated),
  };
}

async function serve(copies: Plugin[], directory: string): Promise<string[]> {
  const urls: string[] = [];
  const ctx = {
    location: { directory },
    mcp: {
      transform: async (edit: (editor: { set(name: string, server: { url: string }): void }) => void) =>
        edit({ set: (_name, server) => urls.push(server.url) }),
    },
  };
  for (const copy of copies) await copy.setup(ctx);
  return urls;
}

describe("OpenCode v2 project wiring in nested checkouts", () => {
  it("serves a nested checkout from its own copy, under a distinct id", async () => {
    const { outer, nested, inside } = await layout();
    expect(outer.plugin.id).not.toBe(nested.plugin.id);
    expect(outer.components.id).not.toBe(nested.components.id);
    expect(outer.plugin.id).toMatch(/^hooknostic\.probe\.opencode\.[0-9a-f]{12}$/);
    const urls = await serve([outer.plugin, nested.plugin, outer.components, nested.components], inside);
    expect(served).toEqual(["nested"]);
    expect(urls).toEqual(["https://nested.invalid/mcp"]);
  });

  it("leaves the outer checkout's own sessions to the outer copy", async () => {
    const { outer, nested, outerRoot } = await layout();
    const urls = await serve([outer.plugin, nested.plugin, outer.components, nested.components], outerRoot);
    expect(served).toEqual(["outer"]);
    expect(urls).toEqual(["https://outer.invalid/mcp"]);
  });

  it("falls back to the outer copy when the nested checkout has no integration", async () => {
    const { outer, inside } = await layout(false);
    const urls = await serve([outer.plugin, outer.components], inside);
    expect(served).toEqual(["outer"]);
    expect(urls).toEqual(["https://outer.invalid/mcp"]);
  });
});
