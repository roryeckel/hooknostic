import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_PLUGIN_MANIFEST_SCHEMA,
  AGENT_PLUGIN_MCP_SCHEMA,
  loadAgentPlugin,
} from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function packageRoot(manifest: Record<string, unknown> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-agent-plugin-"));
  roots.push(root);
  await writeFile(
    join(root, "plugin.json"),
    JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "portable-tools", ...manifest }),
  );
  return root;
}

describe("loadAgentPlugin", () => {
  it("makes a malformed root manifest fatal but reports unknown fields non-fatally", async () => {
    const invalid = await packageRoot({ $schema: "wrong" });
    const failed = await loadAgentPlugin({ root: invalid });
    expect(failed.package).toBeUndefined();
    expect(failed.issues).toContainEqual(expect.objectContaining({ severity: "error", scope: "manifest" }));

    const valid = await packageRoot({ futureField: true });
    const loaded = await loadAgentPlugin({ root: valid });
    expect(loaded.package?.manifest.name).toBe("portable-tools");
    expect(loaded.issues).toContainEqual(expect.objectContaining({ severity: "info", scope: "manifest" }));
  });

  it("skips only invalid skills and MCP servers at their component boundaries", async () => {
    const root = await packageRoot();
    await mkdir(join(root, "skills/good"), { recursive: true });
    await mkdir(join(root, "skills/bad"), { recursive: true });
    await writeFile(join(root, "skills/good/SKILL.md"), "---\nname: good\ndescription: A valid skill\n---\nBody\n");
    await writeFile(join(root, "skills/bad/SKILL.md"), "---\nname: mismatch\ndescription: Bad\n---\n");
    await writeFile(
      join(root, "mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: {
          good: { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/server.mjs"] },
          bad: { type: "streamable-http", url: "http://example.com/insecure" },
        },
      }),
    );

    const loaded = await loadAgentPlugin({ root });
    expect(loaded.package?.skills.map((skill) => skill.name)).toEqual(["good"]);
    expect(Object.keys(loaded.package?.mcp?.mcpServers ?? {})).toEqual(["good"]);
    expect(loaded.issues.filter((issue) => issue.severity === "warn")).toHaveLength(2);
  });

  it("rejects placeholders in MCP commands while retaining valid sibling servers", async () => {
    const root = await packageRoot();
    await writeFile(
      join(root, "mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: {
          executable: { type: "stdio", command: "node" },
          relative: { type: "stdio", command: "./bin/server" },
          placeholder: { type: "stdio", command: "${PLUGIN_ROOT}/bin/server" },
          placeholderOnly: { type: "stdio", command: "${PLUGIN_ROOT}" },
        },
      }),
    );

    const loaded = await loadAgentPlugin({ root });
    expect(Object.keys(loaded.package?.mcp?.mcpServers ?? {})).toEqual([
      "executable",
      "relative",
    ]);
    expect(loaded.issues).toContainEqual(
      expect.objectContaining({
        severity: "warn",
        scope: "mcp",
        path: "mcp.json#/mcpServers/placeholder",
      }),
    );
  });

  it("applies exclusions before component discovery and rejects excluding plugin.json", async () => {
    const root = await packageRoot();
    await mkdir(join(root, "skills/kept/assets"), { recursive: true });
    await mkdir(join(root, "skills/removed/assets"), { recursive: true });
    await writeFile(
      join(root, "skills/kept/SKILL.md"),
      "---\nname: kept\ndescription: Kept skill\n---\n",
    );
    await writeFile(join(root, "skills/kept/assets/secret.txt"), "omit only this file");
    await writeFile(
      join(root, "skills/removed/SKILL.md"),
      "---\nname: removed\ndescription: Removed skill\n---\n",
    );
    await writeFile(join(root, "skills/removed/assets/resource.txt"), "omit whole skill");
    await writeFile(
      join(root, "mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: { server: { type: "stdio", command: "node" } },
      }),
    );

    const loaded = await loadAgentPlugin({
      root,
      exclude: ["mcp.json", "skills/removed/SKILL.md", "skills/kept/assets/**"],
    });
    expect(loaded.package?.skills.map((skill) => skill.name)).toEqual(["kept"]);
    expect(loaded.package?.mcp).toBeUndefined();
    expect(loaded.package?.files.some((file) => file.path === "mcp.json")).toBe(false);
    expect(
      loaded.package?.files.some((file) => file.path.startsWith("skills/removed/")),
    ).toBe(false);
    expect(
      loaded.package?.files.some((file) => file.path === "skills/kept/assets/secret.txt"),
    ).toBe(false);
    expect(loaded.issues).toEqual([]);

    const missingManifest = await loadAgentPlugin({ root, exclude: ["*.json"] });
    expect(missingManifest.package).toBeUndefined();
    expect(missingManifest.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        scope: "manifest",
        path: "plugin.json",
        message: expect.stringContaining("cannot be excluded"),
      }),
    ]);
  });

  it("inventories binary bytes and modes, applies POSIX exclusions, and hashes deterministically", async () => {
    const root = await packageRoot();
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin/tool"), Uint8Array.from([0, 255, 1, 2]));
    await chmod(join(root, "bin/tool"), 0o755);
    await writeFile(join(root, "secret.txt"), "omit");

    const first = await loadAgentPlugin({ root, exclude: ["secret.txt"] });
    const second = await loadAgentPlugin({ root, exclude: ["secret.txt"] });
    const binary = first.package?.files.find((file) => file.path === "bin/tool");
    expect([...binary!.contents]).toEqual([0, 255, 1, 2]);
    if (process.platform !== "win32") expect(binary!.mode & 0o111).not.toBe(0);
    expect(first.package?.files.some((file) => file.path === "secret.txt")).toBe(false);
    expect(second.package?.contentDigest).toBe(first.package?.contentDigest);
  });

  it("dereferences safe links and rejects links that escape the package", async () => {
    const root = await packageRoot();
    await writeFile(join(root, "inside.txt"), "safe");
    await symlink(join(root, "inside.txt"), join(root, "alias.txt"), "file");
    const safe = await loadAgentPlugin({ root });
    expect(new TextDecoder().decode(safe.package?.files.find((file) => file.path === "alias.txt")?.contents)).toBe("safe");

    const outside = await mkdtemp(join(tmpdir(), "hooknostic-agent-plugin-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "escape.txt"), "unsafe");
    await symlink(join(outside, "escape.txt"), join(root, "escape.txt"), "file");
    const escaped = await loadAgentPlugin({ root });
    expect(escaped.package).toBeUndefined();
    expect(escaped.issues).toContainEqual(
      expect.objectContaining({ severity: "error", scope: "file", message: expect.stringContaining("outside") }),
    );
  });

  it("rejects an escaping skill link before parsing its contents", async () => {
    const root = await packageRoot();
    const outside = await mkdtemp(join(tmpdir(), "hooknostic-agent-plugin-outside-skill-"));
    roots.push(outside);
    await mkdir(join(root, "skills/escape"), { recursive: true });
    await writeFile(join(outside, "SKILL.md"), "---\n[EXTERNAL_PARSE_MARKER\n---\n");
    await symlink(join(outside, "SKILL.md"), join(root, "skills/escape/SKILL.md"), "file");

    const loaded = await loadAgentPlugin({ root });
    expect(loaded.package).toBeUndefined();
    expect(loaded.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        scope: "file",
        message: expect.stringContaining("outside"),
      }),
    ]);
    expect(loaded.issues.some((problem) => problem.scope === "skill")).toBe(false);
    expect(loaded.issues.some((problem) => problem.message.includes("EXTERNAL_PARSE_MARKER"))).toBe(
      false,
    );
  });

  it("rejects symbolic-link directory cycles", async () => {
    const root = await packageRoot();
    await mkdir(join(root, "loop"));
    await symlink(root, join(root, "loop/back"), process.platform === "win32" ? "junction" : "dir");
    const loaded = await loadAgentPlugin({ root });
    expect(loaded.package).toBeUndefined();
    expect(loaded.issues).toContainEqual(
      expect.objectContaining({ severity: "error", message: expect.stringContaining("cycle") }),
    );
  });
});
