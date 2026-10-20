import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentPluginMcpServer } from "@hooknostic/agent-plugin";
import { AGENT_PLUGIN_MCP_SCHEMA } from "@hooknostic/agent-plugin";
import { reconcileProject } from "@hooknostic/core";

import { legacyPiMcpCells, nativePiMcpCells, piMcpExtensionSource, piNamespace, translatePiMcp } from "./mcp.js";
import { piExtensionsRelative, projectComponents, projectIntegration } from "./project.js";

const stdio = (command = "node", extra: Partial<AgentPluginMcpServer> = {}): AgentPluginMcpServer =>
  ({ type: "stdio", command, ...extra }) as AgentPluginMcpServer;

describe("translatePiMcp", () => {
  it("registers stdio servers by launcher index and remote servers verbatim on pi 1.x", () => {
    const result = translatePiMcp(
      {
        local: stdio("node", { args: ["${PLUGIN_ROOT}/s.mjs"], env: { A: "${PLUGIN_DATA}" } } as never),
        remote: { type: "streamable-http", url: "https://example.test/mcp", headers: { Authorization: "Bearer $X" } },
        second: stdio("uvx"),
      },
      nativePiMcpCells,
    );
    expect(result.omitted).toEqual([]);
    expect(result.registrations).toEqual([
      { name: "local", type: "stdio", index: 0 },
      { name: "remote", type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer $X" } },
      { name: "second", type: "stdio", index: 1 },
    ]);
    expect(result.launcherServers.map((server) => server.name)).toEqual(["local", "second"]);
    expect(result.launcherServers[0]).toEqual({
      name: "local",
      command: "node",
      args: ["${PLUGIN_ROOT}/s.mjs"],
      env: { A: "${PLUGIN_DATA}" },
    });
  });

  it("omits SSE, which pi rejects, and every transport on 0.84", () => {
    const servers = { events: { type: "sse", url: "https://example.test/sse" } } as const;
    expect(translatePiMcp(servers, nativePiMcpCells).omitted).toEqual([
      { component: "agent-plugin.mcp.sse", name: "events", reason: expect.stringContaining("rejects the legacy SSE") },
    ]);
    const legacy = translatePiMcp(
      { local: stdio(), remote: { type: "streamable-http", url: "https://example.test/mcp" } },
      legacyPiMcpCells("no native MCP channel"),
    );
    expect(legacy.registrations).toEqual([]);
    expect(legacy.omitted.map((omission) => omission.component)).toEqual([
      "agent-plugin.mcp.stdio",
      "agent-plugin.mcp.streamable-http",
    ]);
  });

  it("omits names pi rejects or would merge, and stdio paths that are not portable", () => {
    const result = translatePiMcp(
      {
        "has space": stdio(),
        "my-server": stdio(),
        my_server: stdio(),
        backslash: stdio("./bin\\server"),
        escapes: stdio("node", { cwd: "${PLUGIN_ROOT}/../.." } as never),
      },
      nativePiMcpCells,
    );
    expect(result.registrations.map((registration) => registration.name)).toEqual(["my-server"]);
    expect(Object.fromEntries(result.omitted.map((omission) => [omission.name, omission.reason]))).toEqual({
      "has space": expect.stringContaining("letters, digits"),
      my_server: expect.stringContaining('"my-server" already holds it'),
      backslash: expect.stringContaining("backslash"),
      escapes: expect.stringContaining("escapes the directory"),
    });
  });

  // pi 1.3.0's resolveHeadersOrThrow, which builds the headers pi sends.
  const piResolvesHeaders = (headers: Record<string, string>): Record<string, string> => {
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) resolved[key] = value;
    return resolved;
  };
  const remoteWith = (headers: string) =>
    translatePiMcp(
      { remote: { type: "streamable-http", url: "https://example.test/mcp", headers: JSON.parse(headers) } },
      nativePiMcpCells,
    );

  it("registers a __proto__ header under a spelling pi's resolver keeps", () => {
    // The loader hands the declaration over from JSON, so the key is own.
    const result = remoteWith('{"A": "1", "__proto__": "secret", "B": "2"}');
    expect(result.omitted).toEqual([]);
    const headers = (result.registrations[0] as { headers: Record<string, string> }).headers;
    expect(Object.entries(headers)).toEqual([
      ["A", "1"],
      ["__PROTO__", "secret"],
      ["B", "2"],
    ]);
    expect(new Headers(piResolvesHeaders(headers)).get("__proto__")).toBe("secret");
  });

  it("picks a spelling the server does not already declare", () => {
    const result = remoteWith('{"__PROTO__": "first", "__proto__": "second"}');
    const headers = (result.registrations[0] as { headers: Record<string, string> }).headers;
    const names = Object.keys(headers);
    expect(names).toHaveLength(2);
    expect(names[0]).toBe("__PROTO__");
    expect(names[1]).not.toMatch(/^(__proto__|__PROTO__)$/);
    expect(names[1]!.toLowerCase()).toBe("__proto__");
    expect(new Headers(piResolvesHeaders(headers)).get("__proto__")).toBe("first, second");
  });

  it("omits a server that declares every spelling of __proto__", () => {
    const spellings = Array.from(
      { length: 32 },
      (_, mask) => "__" + [..."proto"].map((c, bit) => (mask & (1 << bit) ? c.toUpperCase() : c)).join("") + "__",
    );
    const result = remoteWith(JSON.stringify(Object.fromEntries(spellings.map((name) => [name, "v"]))));
    expect(result.registrations).toEqual([]);
    expect(result.omitted).toEqual([
      { component: "agent-plugin.mcp.streamable-http", name: "remote", reason: expect.stringContaining("__proto__") },
    ]);
  });
});

describe("pi project MCP integration", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /** A real project root with a canonical `tools` source root, as the loader produces. */
  async function projectRoot(): Promise<string> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "hkn-pi-project-mcp-")));
    roots.push(root);
    await mkdir(join(root, "tools"));
    return root;
  }

  const components = (root: string, servers: Record<string, AgentPluginMcpServer>) => ({
    origin: "direct" as const,
    skills: [],
    mcp: { root: join(root, "tools"), config: { $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: servers } },
  });
  const extensionOf = (result: { files: { path: string; contents: unknown }[] }) =>
    result.files.find((file) => file.path === ".pi/extensions/hooknostic-mcp.js")!.contents as string;

  it("registers servers from .pi/extensions, anchored on the source root, and claims their .pi/mcp.json names", async () => {
    const root = await projectRoot();
    const result = await projectComponents(
      components(root, {
        local: stdio("node", { args: ["${PLUGIN_ROOT}/server.mjs"] } as never),
        remote: { type: "streamable-http", url: "https://example.test/mcp" },
      }),
      root,
      ".hooknostic/artifacts/pi",
      "hooknostic.config.ts",
      {},
    );
    expect(result.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        ".hooknostic/artifacts/pi/mcp-launcher.mjs",
        ".hooknostic/artifacts/pi/mcp-servers.json",
        ".pi/extensions/hooknostic-mcp.js",
      ]),
    );
    const extension = extensionOf(result);
    expect(extension).toContain('const root = resolve(here, "../../tools");');
    expect(extension).toContain('resolve(here, "../../.hooknostic/artifacts/pi/mcp-launcher.mjs")');
    // A direct source resolves its own references before escaping for pi.
    expect(extension).toContain("const expand = (value, missing) =>");
    expect(result.absent).toEqual([
      { path: ".pi/mcp.json", key: ["mcpServers", "local"], fold: piNamespace },
      { path: ".pi/mcp.json", key: ["mcpServers", "remote"], fold: piNamespace },
    ]);
    expect(result.omissions).toBeUndefined();
  });

  it("refuses a .pi/mcp.json entry under any spelling pi treats as the same name", async () => {
    // pi 1.3.0 lets a .pi/mcp.json `a_b-c` take precedence over a registered `a-b_c`.
    const root = await projectRoot();
    const result = await projectComponents(components(root, { "a-b_c": stdio() }), root, "out", "c.ts", {});
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi/mcp.json"), '{"mcpServers":{"a_b-c":{"command":"node"}}}');
    await expect(reconcileProject(root, "c.ts", result)).rejects.toThrow(
      "unowned component collision: .pi/mcp.json:mcpServers.a_b-c",
    );
    // A name with many separators is claimed whole, not given up on.
    const long = Array.from({ length: 12 }, (_, i) => `p${i}`).join("-");
    const many = await projectComponents(components(root, { [long]: stdio() }), root, "out", "c.ts", {});
    expect(many.omissions).toBeUndefined();
    await writeFile(join(root, ".pi/mcp.json"), JSON.stringify({ mcpServers: { [long.replaceAll("-", "_")]: {} } }));
    await expect(reconcileProject(root, "c.ts", many)).rejects.toThrow("unowned component collision");
  });

  it("omits, through core's policy, a server pi would reject", async () => {
    const root = await projectRoot();
    const result = await projectComponents(
      components(root, { "bad name": stdio(), "my-server": stdio(), my_server: stdio(), ok: stdio() }),
      root,
      "out",
      "c.ts",
      {},
    );
    expect(Object.fromEntries((result.omissions ?? []).map((omission) => [omission.name, omission.component]))).toEqual(
      {
        "bad name": "agent-plugin.mcp.stdio",
        my_server: "agent-plugin.mcp.stdio",
      },
    );
    // The servers pi accepts are still delivered.
    expect(registrations(extensionOf(result))).toEqual([
      { name: "my-server", type: "stdio", index: 0 },
      { name: "ok", type: "stdio", index: 1 },
    ]);
  });

  it("resolves its offsets from .pi/extensions, absolutely across Windows drives", () => {
    expect(piExtensionsRelative("C:\\work\\consumer", "C:\\work\\consumer\\tools", win32)).toBe("../../tools");
    expect(piExtensionsRelative("C:\\work\\consumer", "C:\\work\\consumer", win32)).toBe("../..");
    // No relative path crosses drives; a ../../ prefix would corrupt this one.
    expect(piExtensionsRelative("C:\\work\\consumer", "D:\\portable", win32)).toBe("D:/portable");
    expect(piExtensionsRelative("/work/consumer", "/work/shared/tools", posix)).toBe("../../../shared/tools");
  });

  it("keeps both generated .pi/extensions modules out of line-ending conversion", () => {
    const attributes = projectIntegration([], ".hooknostic/artifacts/pi").files.find(
      (file) => file.path === ".pi/extensions/.gitattributes",
    )!.contents as string;
    expect(attributes.split("\n")).toEqual(expect.arrayContaining(["hooknostic.js -text", "hooknostic-mcp.js -text"]));
  });

  it("projects a server named __proto__, as the loader hands it over from JSON", async () => {
    const root = await projectRoot();
    const servers = JSON.parse('{"__proto__": {"type": "stdio", "command": "node"}}') as Record<
      string,
      AgentPluginMcpServer
    >;
    const result = await projectComponents(components(root, servers), root, "out", "c.ts", {});
    expect(registrations(extensionOf(result))).toEqual([{ name: "__proto__", type: "stdio", index: 0 }]);
    expect(result.absent).toEqual([{ path: ".pi/mcp.json", key: ["mcpServers", "__proto__"], fold: piNamespace }]);
  });

  it("computes the source offset between real paths when the project is reached through a link", async () => {
    const root = await projectRoot();
    const alias = join(await realpath(tmpdir()), `hkn-pi-alias-${process.pid}-${Date.now()}`);
    await symlink(root, alias, "junction");
    roots.push(alias);
    // The loader hands over a canonical source root; the project root keeps the alias.
    const result = await projectComponents(components(root, { local: stdio() }), alias, "out", "c.ts", {});
    expect(extensionOf(result)).toContain('const root = resolve(here, "../../tools");');
  });
});

/** The registrations a generated hooknostic-mcp.js embeds as a JSON string literal. */
const registrations = (module: string): unknown =>
  JSON.parse(JSON.parse(/const registrations = JSON\.parse\(("(?:[^"\\]|\\.)*")\);/.exec(module)![1]!) as string);

describe("generated pi MCP extension", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    vi.unstubAllEnvs();
  });

  async function load(source: string) {
    const dir = await mkdtemp(join(tmpdir(), "hkn-pi-mcp-unit-"));
    dirs.push(dir);
    const path = join(dir, "hooknostic-mcp.mjs");
    await writeFile(path, source);
    const registered: [string, Record<string, unknown>][] = [];
    const module = (await import(pathToFileURL(path).href)) as {
      default: (pi: { registerMcpServer(name: string, config: Record<string, unknown>): void }) => void;
    };
    return { dir, registered, module };
  }

  it("registers stdio servers as pi's Node running the launcher, anchored on the root", async () => {
    const { dir, registered, module } = await load(
      piMcpExtensionSource({
        registrations: [{ name: "local", type: "stdio", index: 3 }],
        rootFromHere: "package",
        launcherFromHere: "hooknostic-runtime/mcp-launcher.mjs",
        resolveEnvironment: false,
      }),
    );
    module.default({ registerMcpServer: (name, config) => registered.push([name, config]) });
    expect(registered).toEqual([
      [
        "local",
        {
          command: process.execPath,
          args: [resolve(dir, "hooknostic-runtime/mcp-launcher.mjs"), "3"],
          cwd: resolve(dir, "package"),
        },
      ],
    ]);
  });

  it("escapes a package's header values so pi sends them as written", async () => {
    vi.stubEnv("HKN_UNIT_SET", "expanded");
    const { registered, module } = await load(
      piMcpExtensionSource({
        registrations: [
          {
            name: "remote",
            type: "http",
            url: "https://example.test/${HKN_UNIT_SET}",
            headers: { A: "Bearer ${HKN_UNIT_SET}", B: "!command", C: "cost $5 and $$", D: "plain" },
          },
        ],
        rootFromHere: ".",
        launcherFromHere: "launcher.mjs",
        resolveEnvironment: false,
      }),
    );
    module.default({ registerMcpServer: (name, config) => registered.push([name, config]) });
    // pi's $$ and $! escapes (.capture/pi-mcp http-headers): each value below
    // is resolved by pi back to exactly the declared text.
    expect(registered).toEqual([
      [
        "remote",
        {
          url: "https://example.test/${HKN_UNIT_SET}",
          headers: { A: "Bearer $${HKN_UNIT_SET}", B: "$!command", C: "cost $$5 and $$$$", D: "plain" },
        },
      ],
    ]);
  });

  it("resolves a direct source's references first, and disables a server whose variable is missing", async () => {
    vi.stubEnv("HKN_UNIT_SET", "expanded");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { registered, module } = await load(
      piMcpExtensionSource({
        registrations: [
          {
            name: "resolved",
            type: "http",
            url: "https://example.test/${HKN_UNIT_SET}",
            headers: { A: "Bearer ${HKN_UNIT_SET}-$tail", B: "${HKN_UNIT_UNSET:-fallback}" },
          },
          { name: "missing", type: "http", url: "https://example.test/${HKN_UNIT_UNSET}" },
        ],
        rootFromHere: ".",
        launcherFromHere: "launcher.mjs",
        resolveEnvironment: true,
      }),
    );
    module.default({ registerMcpServer: (name, config) => registered.push([name, config]) });
    expect(registered).toEqual([
      ["resolved", { url: "https://example.test/expanded", headers: { A: "Bearer expanded-$$tail", B: "fallback" } }],
      ["missing", { url: "https://example.test/${HKN_UNIT_UNSET}", enabled: false }],
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Hooknostic disabled MCP "missing"'));
    warn.mockRestore();
  });

  it("registers the remaining servers when pi refuses one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { registered, module } = await load(
      piMcpExtensionSource({
        registrations: [
          { name: "taken", type: "http", url: "https://example.test/a" },
          { name: "free", type: "http", url: "https://example.test/b" },
        ],
        rootFromHere: ".",
        launcherFromHere: "launcher.mjs",
        resolveEnvironment: false,
      }),
    );
    module.default({
      registerMcpServer: (name, config) => {
        if (name === "taken") throw new Error("registered by another extension");
        registered.push([name, config]);
      },
    });
    expect(registered.map(([name]) => name)).toEqual(["free"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not register MCP "taken"'));
    warn.mockRestore();
  });
});
