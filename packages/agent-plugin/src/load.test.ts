import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_PLUGIN_MANIFEST_SCHEMA,
  AGENT_PLUGIN_MCP_SCHEMA,
  loadAgentPlugin,
  loadProjectComponents,
} from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("loadProjectComponents", () => {
  it("reports a missing direct MCP source instead of rejecting", async () => {
    const root = await mkdtemp(join(tmpdir(), "hooknostic-project-mcp-missing-"));
    roots.push(root);
    const path = join(root, "missing-mcp.json");

    const loaded = await loadProjectComponents({ mcp: path, projectRoot: root });

    expect(loaded.source.mcp).toBeUndefined();
    expect(loaded.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        scope: "mcp",
        path,
        message: expect.stringContaining("could not load direct MCP source"),
      }),
    ]);
  });

  it("reports an excluded direct MCP source instead of rejecting", async () => {
    const root = await mkdtemp(join(tmpdir(), "hooknostic-project-mcp-excluded-"));
    roots.push(root);
    const path = join(root, ".env");
    await writeFile(
      path,
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: {},
      }),
    );

    const loaded = await loadProjectComponents({ mcp: path, projectRoot: root });

    expect(loaded.source.mcp).toBeUndefined();
    expect(loaded.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        scope: "mcp",
        path,
        message: expect.stringContaining("excluded secret/configuration file"),
      }),
    ]);
  });

  it("preserves target-native frontmatter while validating portable skill fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "hooknostic-project-skills-"));
    roots.push(root);
    await mkdir(join(root, "review"), { recursive: true });
    const manifest = [
      "---",
      "name: review",
      "description: Review a change",
      "disable-model-invocation: true",
      "---",
      "Body",
      "",
    ].join("\n");
    await writeFile(join(root, "review/SKILL.md"), manifest);

    const loaded = await loadProjectComponents({ skills: [root] });

    expect(loaded.issues).toEqual([]);
    expect(loaded.source.origin).toBe("direct");
    expect(loaded.source.skills.map((skill) => skill.name)).toEqual(["review"]);
    expect(new TextDecoder().decode(loaded.source.skills[0]!.files[0]!.contents)).toBe(manifest);
  });

  it("applies configured exclusions relative to every direct skill root", async () => {
    const root = await mkdtemp(join(tmpdir(), "hooknostic-project-skill-excludes-"));
    roots.push(root);
    await mkdir(join(root, "review/assets"), { recursive: true });
    await mkdir(join(root, "review/scripts/__pycache__"), { recursive: true });
    await writeFile(join(root, "review/SKILL.md"), "---\nname: review\ndescription: Review a change\n---\n");
    await writeFile(join(root, "review/assets/local.txt"), "local-only");
    await writeFile(join(root, "review/credentials.md"), "secret");
    await writeFile(join(root, "review/scripts/__pycache__/helper.pyc"), "bytecode");
    await writeFile(join(root, "review/reference.md"), "included");

    const loaded = await loadProjectComponents({
      skills: [root],
      exclude: ["**/assets/**", "**/__pycache__/**", "review/credentials.md"],
    });

    expect(loaded.issues).toEqual([]);
    expect(loaded.source.skills[0]!.files.map((file) => file.path)).toEqual(["reference.md", "SKILL.md"]);
  });

  it("allows a direct MCP cwd to leave its source directory only within the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "hooknostic-project-mcp-cwd-"));
    roots.push(root);
    await mkdir(join(root, ".agents"));
    const path = join(root, ".agents/mcp.json");
    const document = (cwd: string) =>
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: { probe: { type: "stdio", command: "node", cwd } },
      });
    await writeFile(path, document("${PLUGIN_ROOT}/.."));

    const packagedSemantics = await loadProjectComponents({ mcp: path });
    expect(packagedSemantics.source.mcp?.config.mcpServers).toEqual({});
    const direct = await loadProjectComponents({ mcp: path, projectRoot: root });
    expect(direct.issues).toEqual([]);
    expect(direct.source.mcp?.config.mcpServers.probe).toMatchObject({ cwd: "${PLUGIN_ROOT}/.." });

    await writeFile(path, document("${PLUGIN_ROOT}/../.."));
    const escaping = await loadProjectComponents({ mcp: path, projectRoot: root });
    expect(escaping.source.mcp?.config.mcpServers).toEqual({});
  });

  it("rejects direct MCP paths that escape through a symlink or junction", async () => {
    const root = await mkdtemp(join(tmpdir(), "hooknostic-project-mcp-canonical-"));
    const outside = await mkdtemp(join(tmpdir(), "hooknostic-project-mcp-outside-"));
    roots.push(root, outside);
    const source = join(root, ".agents");
    await mkdir(source);
    await writeFile(join(outside, "tool.mjs"), "export {};\n");
    await symlink(outside, join(source, "linked"), process.platform === "win32" ? "junction" : "dir");
    const path = join(source, "mcp.json");
    await writeFile(
      path,
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: {
          cwdEscape: { type: "stdio", command: "node", cwd: "./linked" },
          commandEscape: { type: "stdio", command: "./linked/tool.mjs" },
          containedMissing: { type: "stdio", command: "node", cwd: "./missing/child" },
        },
      }),
    );

    const loaded = await loadProjectComponents({ mcp: path, projectRoot: root });
    expect(Object.keys(loaded.source.mcp!.config.mcpServers)).toEqual(["containedMissing"]);
    expect(loaded.issues.filter((issue) => issue.message.includes("invalid and was skipped"))).toHaveLength(2);
  });
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

  it("keeps packaged skill frontmatter strict", async () => {
    const root = await packageRoot();
    await mkdir(join(root, "skills/review"), { recursive: true });
    await writeFile(
      join(root, "skills/review/SKILL.md"),
      "---\nname: review\ndescription: Review a change\ndisable-model-invocation: true\n---\n",
    );

    const loaded = await loadAgentPlugin({ root });

    expect(loaded.package?.skills).toEqual([]);
    expect(loaded.issues).toContainEqual(
      expect.objectContaining({
        severity: "warn",
        scope: "skill",
        message: expect.stringContaining("unknown field"),
      }),
    );
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

  it("preserves schema-valid MCP server names that shadow Object.prototype", async () => {
    const root = await packageRoot();
    // JSON.parse creates an own `__proto__` key; an assignment into `{}` would
    // instead invoke Object.prototype's inherited setter and lose this server.
    await writeFile(
      join(root, "mcp.json"),
      `{"$schema":"${AGENT_PLUGIN_MCP_SCHEMA}","mcpServers":{"__proto__":{"type":"stdio","command":"node"}}}`,
    );

    const loaded = await loadAgentPlugin({ root });
    expect(loaded.issues).toEqual([]);
    expect(Object.keys(loaded.package?.mcp?.mcpServers ?? {})).toEqual(["__proto__"]);
    expect(loaded.package?.mcp?.mcpServers["__proto__"]).toEqual({
      type: "stdio",
      command: "node",
    });
  });

  it("rejects placeholders in MCP commands while retaining valid sibling servers", async () => {
    const root = await packageRoot();
    // A `./` command has to name a file the package ships, declared executable
    // -- otherwise `checkContainedCommands` skips it and this test would be
    // asserting the survival of a server that cannot start.
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(join(root, "bin", "server"), "exec cat");
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

    const loaded = await loadAgentPlugin({ root, executableFiles: ["bin/server"] });
    expect(Object.keys(loaded.package?.mcp?.mcpServers ?? {})).toEqual(["executable", "relative"]);
    expect(loaded.issues).toContainEqual(
      expect.objectContaining({
        severity: "warn",
        scope: "mcp",
        path: "mcp.json#/mcpServers/placeholder",
      }),
    );
  });

  it("skips a contained command the package does not ship", async () => {
    const root = await packageRoot();
    await writeFile(
      join(root, "mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: { ghost: { type: "stdio", command: "./bin/server" } },
      }),
    );

    const loaded = await loadAgentPlugin({ root });

    expect(Object.keys(loaded.package?.mcp?.mcpServers ?? {})).toEqual([]);
    expect(loaded.issues).toContainEqual(
      expect.objectContaining({
        severity: "warn",
        scope: "mcp",
        path: "mcp.json#/mcpServers/ghost",
        message: expect.stringContaining("does not contain"),
      }),
    );
  });

  it("normalizes a contained POSIX command before matching the package inventory", async () => {
    const root = await packageRoot();
    await writeFile(join(root, "server"), "exec external-runner");
    await writeFile(
      join(root, "mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: { normalized: { type: "stdio", command: "./bin/../server" } },
      }),
    );

    const loaded = await loadAgentPlugin({ root, executableFiles: ["server"] });

    expect(loaded.issues).toEqual([]);
    expect(Object.keys(loaded.package?.mcp?.mcpServers ?? {})).toEqual(["normalized"]);
  });

  it("skips a contained command that was never declared executable, and names the remedy", async () => {
    const root = await packageRoot();
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(join(root, "bin", "server"), "exec external-runner");
    await writeFile(
      join(root, "mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: { scripted: { type: "stdio", command: "./bin/server" } },
      }),
    );

    // Host permissions are deliberately not consulted (ADR-0013), so making the
    // file executable on disk must not rescue it -- only the declaration does.
    await chmod(join(root, "bin", "server"), 0o755);
    const loaded = await loadAgentPlugin({ root });

    expect(Object.keys(loaded.package?.mcp?.mcpServers ?? {})).toEqual([]);
    expect(loaded.issues).toContainEqual(
      expect.objectContaining({
        severity: "warn",
        scope: "mcp",
        path: "mcp.json#/mcpServers/scripted",
        message: expect.stringContaining("components.executableFiles"),
      }),
    );

    const declared = await loadAgentPlugin({ root, executableFiles: ["bin/server"] });
    expect(Object.keys(declared.package?.mcp?.mcpServers ?? {})).toEqual(["scripted"]);
    expect(declared.issues).toEqual([]);
  });

  it("names components.exclude when a link escapes the package root", async () => {
    const root = await packageRoot();
    const outside = await mkdtemp(join(tmpdir(), "hooknostic-agent-plugin-escape-"));
    roots.push(outside);
    await writeFile(join(outside, "payload"), "outside");
    await mkdir(join(root, "toolchain"), { recursive: true });
    await symlink(outside, join(root, "toolchain", "linked"), process.platform === "win32" ? "junction" : "dir");

    const loaded = await loadAgentPlugin({ root });

    expect(loaded.package).toBeUndefined();
    expect(loaded.issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        scope: "file",
        message: expect.stringContaining("components.exclude"),
      }),
    );
    // The remedy is only useful if the message says what to exclude.
    expect(loaded.issues[0]?.message).toContain("toolchain/linked");

    const excluded = await loadAgentPlugin({ root, exclude: ["toolchain/**"] });
    expect(excluded.issues).toEqual([]);
  });

  it("never inventories version control, installed dependencies, or environment secrets", async () => {
    const root = await packageRoot();
    for (const dir of [".git/objects", "node_modules/dep", "skills/tool/node_modules/x", "lib/NODE_MODULES/y"]) {
      await mkdir(join(root, dir), { recursive: true });
    }
    await writeFile(join(root, ".git/objects/abc"), "blob");
    await writeFile(join(root, "node_modules/dep/index.js"), "module.exports = 1;");
    // Exclusions are case-insensitive: a `.ENV` inventoried on Linux is `.env`
    // to every Windows and macOS consumer the package is installed for.
    await writeFile(join(root, "lib/NODE_MODULES/y/index.js"), "shouting dependency");
    await writeFile(join(root, ".ENV.staging"), "SECRET=3");
    await writeFile(join(root, "skills/tool/node_modules/x/index.js"), "nested dependency");
    // A submodule-style `.git` *file* must be excluded as well as the directory form.
    await writeFile(join(root, "skills/tool/.git"), "gitdir: ../../.git/modules/tool");
    await writeFile(join(root, "skills/tool/SKILL.md"), "---\nname: tool\ndescription: Tool\n---\n");
    await writeFile(join(root, "skills/tool/.env"), "NESTED=1");
    await writeFile(join(root, ".env"), "SECRET=1");
    await writeFile(join(root, ".env.production"), "SECRET=2");
    await writeFile(join(root, ".npmrc"), "//registry.npmjs.org/:_authToken=token");
    await writeFile(join(root, ".environment.md"), "documentation, not a secret");
    await writeFile(join(root, "environment.json"), "{}");

    const loaded = await loadAgentPlugin({ root });
    expect(loaded.issues).toEqual([]);
    expect(loaded.package?.files.map((file) => file.path)).toEqual([
      ".environment.md",
      "environment.json",
      "plugin.json",
      "skills/tool/SKILL.md",
    ]);
    expect(loaded.package?.skills.map((skill) => skill.name)).toEqual(["tool"]);
  });

  it("applies exclusions before component discovery and rejects excluding plugin.json", async () => {
    const root = await packageRoot();
    await mkdir(join(root, "skills/kept/assets"), { recursive: true });
    await mkdir(join(root, "skills/removed/assets"), { recursive: true });
    await writeFile(join(root, "skills/kept/SKILL.md"), "---\nname: kept\ndescription: Kept skill\n---\n");
    await writeFile(join(root, "skills/kept/assets/secret.txt"), "omit only this file");
    await writeFile(join(root, "skills/removed/SKILL.md"), "---\nname: removed\ndescription: Removed skill\n---\n");
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
    expect(loaded.package?.files.some((file) => file.path.startsWith("skills/removed/"))).toBe(false);
    expect(loaded.package?.files.some((file) => file.path === "skills/kept/assets/secret.txt")).toBe(false);
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

  it("inventories binary bytes and explicit modes, applies POSIX exclusions, and hashes deterministically", async () => {
    const root = await packageRoot();
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin/tool"), Uint8Array.from([0, 255, 1, 2]));
    await chmod(join(root, "bin/tool"), 0o755);
    await writeFile(join(root, "secret.txt"), "omit");

    const options = { root, exclude: ["secret.txt"], executableFiles: ["bin/tool"] };
    const first = await loadAgentPlugin(options);
    await chmod(join(root, "bin/tool"), 0o644);
    const second = await loadAgentPlugin(options);
    const binary = first.package?.files.find((file) => file.path === "bin/tool");
    expect([...binary!.contents]).toEqual([0, 255, 1, 2]);
    expect(binary!.mode).toBe(0o755);
    expect(second.package?.files.find((file) => file.path === "bin/tool")?.mode).toBe(0o755);
    expect(first.package?.files.some((file) => file.path === "secret.txt")).toBe(false);
    expect(second.package?.contentDigest).toBe(first.package?.contentDigest);
  });

  it("ignores host permissions unless an included file is explicitly executable", async () => {
    const root = await packageRoot();
    const file = join(root, "data.txt");
    await writeFile(file, "data");
    await chmod(file, 0o777);
    const first = await loadAgentPlugin({ root });
    expect(first.package?.files.find((entry) => entry.path === "data.txt")?.mode).toBe(0o644);
    await chmod(file, 0o600);
    expect((await loadAgentPlugin({ root })).package?.contentDigest).toBe(first.package?.contentDigest);
  });

  it("rejects invalid, missing, excluded, directory, and incorrectly cased executable paths", async () => {
    const root = await packageRoot();
    await writeFile(join(root, "data.txt"), "data");
    for (const path of [
      "",
      "/data.txt",
      "../data.txt",
      "./data.txt",
      "a/../data.txt",
      "a//b",
      "a\\b",
      "C:/data.txt",
      "missing",
      "DATA.txt",
      "skills",
      "data.txt",
    ]) {
      const options = { root, executableFiles: [path], ...(path === "data.txt" ? { exclude: [path] } : {}) };
      const result = await loadAgentPlugin(options);
      expect(result.package, path).toBeUndefined();
      expect(result.issues, path).toContainEqual(expect.objectContaining({ severity: "error", scope: "file" }));
    }
  });

  it("dereferences safe links and rejects links that escape the package", async () => {
    const root = await packageRoot();
    await writeFile(join(root, "inside.txt"), "safe");
    await symlink(join(root, "inside.txt"), join(root, "alias.txt"), "file");
    const safe = await loadAgentPlugin({ root });
    expect(new TextDecoder().decode(safe.package?.files.find((file) => file.path === "alias.txt")?.contents)).toBe(
      "safe",
    );

    const outside = await mkdtemp(join(tmpdir(), "hooknostic-agent-plugin-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "escape.txt"), "unsafe");
    await symlink(join(outside, "escape.txt"), join(root, "escape.txt"), "file");
    const escaped = await loadAgentPlugin({ root });
    expect(escaped.package).toBeUndefined();
    // Pinned to the whole sentence, not the word "outside". An escaping link is
    // nearly always machine-local state -- a virtualenv interpreter, a
    // toolchain cache -- and core deliberately carries no list of those names
    // (ADR-0017), so naming the path and the one line that fixes it IS the
    // feature. Asserting a substring the generic inventory wrapper also
    // contains would pass just as happily against the message that does not.
    expect(escaped.issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        scope: "file",
        message: expect.stringContaining(
          "escape.txt resolves outside the Agent Plugin root. Add it to components.exclude",
        ),
      }),
    );
  });

  it("names a broken link and the line that fixes it", async () => {
    const root = await packageRoot();
    // The `realpath` ENOENT branch, which nothing reached: no test in the
    // repository builds a dangling link. It is what a machine-local tree
    // leaves behind once its absolute target moves, so it lands on authors
    // who never chose to ship a link at all.
    await symlink(join(root, "gone.txt"), join(root, "dangling.txt"), "file");

    const loaded = await loadAgentPlugin({ root });
    expect(loaded.package).toBeUndefined();
    expect(loaded.issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        scope: "file",
        message: expect.stringContaining("dangling.txt is a broken symbolic link. Remove it, or add it to"),
      }),
    );
  });

  it("rejects links whose targets are excluded, whatever the link is named", async () => {
    for (const [link, target, kind] of [
      ["notes.txt", ".env", "file"],
      ["renamed.mjs", "src/server.mjs", "file"],
      ["lib", "node_modules/dep", "junction"],
    ] as const) {
      const root = await packageRoot();
      await mkdir(join(root, "node_modules/dep"), { recursive: true });
      await mkdir(join(root, "src"));
      await writeFile(join(root, ".env"), "SECRET=1");
      await writeFile(join(root, "src/server.mjs"), "export {};");
      await writeFile(join(root, "node_modules/dep/index.js"), "module.exports = 1;");
      await symlink(join(root, target), join(root, link), kind);

      const loaded = await loadAgentPlugin({ root, exclude: ["src/server.mjs"] });
      expect(loaded.package, link).toBeUndefined();
      expect(loaded.issues).toContainEqual(
        expect.objectContaining({
          severity: "error",
          scope: "file",
          message: expect.stringContaining(`${link} resolves to excluded path ${target}`),
        }),
      );
    }
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
        message: expect.stringContaining("skills/escape/SKILL.md resolves outside the Agent Plugin root."),
      }),
    ]);
    expect(loaded.issues.some((problem) => problem.scope === "skill")).toBe(false);
    expect(loaded.issues.some((problem) => problem.message.includes("EXTERNAL_PARSE_MARKER"))).toBe(false);
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
