import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyProject, fileHash, type ProjectIntegration, reconcileProject, recoverProject } from "./project-files.js";
let root: string;
const config = "hooknostic.config.ts";
const integration = (): ProjectIntegration => ({
  files: [{ path: "generated/runtime.mjs", contents: "export default 1;\n" }],
  entries: [
    {
      path: "settings.json",
      key: ["hooks", "Stop"],
      kind: "array",
      value: { hooks: [{ command: "node generated/runtime.mjs", timeout: 12 }] },
    },
  ],
  guidance: [],
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hooknostic project "));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function sync(input = integration()) {
  const plan = await reconcileProject(root, config, input);
  await applyProject(root, config, plan);
  return plan;
}
/** A pid that names no process: spawnSync returns after the child has exited. */
function deadPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  expect(pid, "spawn a child to get a dead pid").toBeTypeOf("number");
  return pid;
}
/** The journal of an interrupted replacement of settings.json from `before` to `after`. */
const journal = (before: string, after: string) =>
  JSON.stringify({
    schemaVersion: 1,
    config,
    entries: [
      {
        path: "settings.json",
        before: Buffer.from(before).toString("base64"),
        afterHash: fileHash(after),
        mode: 0o644,
      },
    ],
  });
describe("project reconciliation", () => {
  it("plans without writing and becomes byte-idempotent", async () => {
    const plan = await reconcileProject(root, config, integration());
    await expect(readFile(join(root, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await applyProject(root, config, plan);
    expect((await reconcileProject(root, config, integration())).changes).toEqual([]);
    const manifest = await readFile(join(root, ".hooknostic/integration.json"), "utf8");
    expect(manifest).not.toContain(root);
    expect(manifest).not.toContain("command");
  });
  it("rechecks a discovery fallback before creating the file that would hide it", async () => {
    const input: ProjectIntegration = {
      ...integration(),
      discoveryFallbacks: [{ path: "settings.json", fallback: "fallback.json", key: ["services"] }],
    };
    const plan = await reconcileProject(root, config, input);
    await writeFile(join(root, "fallback.json"), '{"services":{"authored":{}}}');
    await expect(applyProject(root, config, plan)).rejects.toThrow("fallback.json");
    await expect(readFile(join(root, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, "generated/runtime.mjs"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("preserves unrelated JSONC bytes and array ordering", async () => {
    const prefix = '{\n // user configuration\n "theme": "dark",\n "hooks": { "Stop": [{ "custom": true }] }\n}\n';
    await writeFile(join(root, "settings.json"), prefix);
    await sync();
    const text = await readFile(join(root, "settings.json"), "utf8");
    expect(text).toContain('// user configuration\n "theme": "dark",');
    expect(text.indexOf('"custom"')).toBeLessThan(text.indexOf('"command"'));
    expect((await reconcileProject(root, config, integration())).changes).toEqual([]);
  });
  // A root .mcp.json is read by Claude Code and GitHub Copilot CLI alike, so
  // both targets emit the same server key (ADR-0033).
  const mcpEntry = (launcher: string, share: string | undefined) => ({
    path: ".mcp.json",
    key: ["mcpServers", "probe"],
    kind: "property" as const,
    value: { command: "node", args: [`./${launcher}/mcp-launcher.mjs`, "0"], cwd: "." },
    ...(share === undefined ? {} : { share }),
  });
  it("composes one shared entry, the first target's, when every emitter shares the same definition", async () => {
    await sync({
      files: [],
      entries: [mcpEntry("claude", '{"type":"stdio"}'), mcpEntry("copilot", '{"type":"stdio"}')],
      guidance: [],
    });
    const doc = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
    expect(doc.mcpServers.probe.args[0]).toBe("./claude/mcp-launcher.mjs");
    const manifest = JSON.parse(await readFile(join(root, ".hooknostic/integration.json"), "utf8"));
    expect(manifest.owned.filter((owned: { path: string }) => owned.path === ".mcp.json")).toHaveLength(1);
  });
  it("rejects shared entries whose targets define them differently", async () => {
    await expect(
      reconcileProject(root, config, {
        files: [],
        entries: [mcpEntry("claude", '{"args":["a"]}'), mcpEntry("copilot", '{"args":["b"]}')],
        guidance: [],
      }),
    ).rejects.toThrow("conflicting shared entry: .mcp.json:mcpServers.probe");
  });
  it("still rejects a duplicate entry that one emitter does not share", async () => {
    await expect(
      reconcileProject(root, config, {
        files: [],
        entries: [mcpEntry("claude", '{"type":"stdio"}'), mcpEntry("copilot", undefined)],
        guidance: [],
      }),
    ).rejects.toThrow("duplicate integration destination: .mcp.json");
  });
  // A disable list an author may already keep: Hooknostic owns only the names
  // it adds.
  const members = (value: string[]): ProjectIntegration => ({
    files: [],
    entries: [{ path: "settings.json", key: ["disabledMcpServers"], kind: "members", value }],
    guidance: [],
  });
  it("adds members beside an author's own and removes only its own", async () => {
    await writeFile(join(root, "settings.json"), '{"disabledMcpServers":["mine","shared"]}');
    await sync(members(["shared", "ours"]));
    const listed = async () => JSON.parse(await readFile(join(root, "settings.json"), "utf8")).disabledMcpServers;
    expect(await listed()).toEqual(["mine", "shared", "ours"]);
    expect((await reconcileProject(root, config, members(["shared", "ours"]))).changes).toEqual([]);
    await sync(members([]));
    // "shared" was the author's before Hooknostic needed it, so it stays.
    expect(await listed()).toEqual(["mine", "shared"]);
  });
  it("removes a members list it created once nothing needs it", async () => {
    await sync(members(["ours"]));
    await sync(members([]));
    expect(JSON.parse(await readFile(join(root, "settings.json"), "utf8"))).toEqual({});
  });
  it("rejects duplicate JSONC properties before editing", async () => {
    await writeFile(join(root, "settings.json"), '{"hooks":{"Stop":[]},"hooks":{}}');
    await expect(reconcileProject(root, config, integration())).rejects.toThrow("duplicate JSONC property");
  });
  it("repairs a missing registration alongside recorded unrelated entries", async () => {
    await writeFile(join(root, "settings.json"), '{"hooks":{"Stop":[{"custom":true}]}}');
    await sync();
    await writeFile(join(root, "settings.json"), '{"hooks":{"Stop":[{"custom":true}]}}');
    await sync();
    const doc = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
    expect(doc.hooks.Stop).toHaveLength(2);
    expect(doc.hooks.Stop[0]).toEqual({ custom: true });
  });
  it("updates derived registration values without duplicate dispatch", async () => {
    await sync();
    const next = integration();
    next.entries[0]!.value = { hooks: [{ command: "node generated/runtime.mjs", timeout: 99 }] };
    await sync(next);
    const doc = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
    expect(doc.hooks.Stop).toHaveLength(1);
    expect(doc.hooks.Stop[0].hooks[0].timeout).toBe(99);
  });
  it("removes unchanged owned content and keeps shared files", async () => {
    await sync();
    await sync({ files: [], entries: [], guidance: [] });
    await expect(readFile(join(root, "generated/runtime.mjs"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(join(root, "settings.json"), "utf8")).hooks.Stop).toEqual([]);
  });
  it("repairs a missing generated file", async () => {
    await sync();
    await rm(join(root, "generated/runtime.mjs"));
    expect((await reconcileProject(root, config, integration())).changes.map((c) => c.path)).toContain(
      "generated/runtime.mjs",
    );
  });
  it("relinquishes whole-file ownership without changing current bytes", async () => {
    const path = "skills/sample/SKILL.md";
    await sync({ files: [{ path, contents: "generated\n" }], entries: [], guidance: [] });
    await writeFile(join(root, path), "authored\n");
    const relinquished: ProjectIntegration = {
      files: [],
      entries: [],
      guidance: [],
      relinquishFiles: [path],
    };
    await sync(relinquished);
    expect(await readFile(join(root, path), "utf8")).toBe("authored\n");
    expect(await readFile(join(root, ".hooknostic/integration.json"), "utf8")).not.toContain(path);
    await writeFile(join(root, path), "edited after relinquishment\n");
    expect((await reconcileProject(root, config, relinquished)).changes).toEqual([]);
  });
  it("relinquishes every previously owned file below a prefix", async () => {
    const files = [
      { path: "skills/sample/SKILL.md", contents: "generated skill\n" },
      { path: "skills/sample/local.txt", contents: "generated resource\n" },
    ];
    await sync({ files, entries: [], guidance: [] });
    await writeFile(join(root, "skills/sample/local.txt"), "authored resource\n");
    const relinquished = {
      files: [],
      entries: [],
      guidance: [],
      relinquishPrefixes: ["skills/sample"],
    } satisfies ProjectIntegration;

    await sync(relinquished);

    expect(await readFile(join(root, "skills/sample/SKILL.md"), "utf8")).toBe("generated skill\n");
    expect(await readFile(join(root, "skills/sample/local.txt"), "utf8")).toBe("authored resource\n");
    const manifest = await readFile(join(root, ".hooknostic/integration.json"), "utf8");
    expect(manifest).not.toContain("skills/sample/");
  });
  it("rejects generating and relinquishing the same path", async () => {
    await expect(
      reconcileProject(root, config, {
        files: [{ path: "generated/runtime.mjs", contents: "generated\n" }],
        entries: [],
        guidance: [],
        relinquishFiles: ["generated/runtime.mjs"],
      }),
    ).rejects.toThrow("relinquish");
    await expect(
      reconcileProject(root, config, {
        files: [{ path: "skills/sample/SKILL.md", contents: "generated\n" }],
        entries: [],
        guidance: [],
        relinquishPrefixes: ["skills/sample"],
      }),
    ).rejects.toThrow("relinquish");
  });
  it("refuses unowned generated files even when their bytes match", async () => {
    await mkdir(join(root, "generated"));
    await writeFile(join(root, "generated/runtime.mjs"), "export default 1;\n");
    await expect(sync()).rejects.toThrow("unowned");
  });
  it("refuses edited owned files and array entries", async () => {
    await sync();
    await writeFile(join(root, "generated/runtime.mjs"), "changed");
    await expect(sync()).rejects.toThrow("modified");
    await writeFile(join(root, "generated/runtime.mjs"), "export default 1;\n");
    await writeFile(join(root, "settings.json"), '{"hooks":{"Stop":[{"changed":true}]}}');
    await expect(sync()).rejects.toThrow("modified");
  });
  it("refuses duplicate owned entry matches", async () => {
    await sync();
    const doc = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
    doc.hooks.Stop.push(doc.hooks.Stop[0]);
    await writeFile(join(root, "settings.json"), JSON.stringify(doc));
    await expect(sync()).rejects.toThrow("ambiguous");
  });
  it("refuses taking over an equivalent unowned registration", async () => {
    await writeFile(
      join(root, "settings.json"),
      JSON.stringify({ hooks: { Stop: [integration().entries[0]!.value] } }),
    );
    await expect(sync()).rejects.toThrow("unowned matching");
  });
  it("detects edits between planning and commit without overwriting them", async () => {
    const plan = await reconcileProject(root, config, integration());
    await writeFile(join(root, "settings.json"), '{"user":true}');
    await expect(applyProject(root, config, plan)).rejects.toThrow("changed during planning");
    expect(await readFile(join(root, "settings.json"), "utf8")).toBe('{"user":true}');
  });
  it("detects an absent-entry collision added after an otherwise empty plan", async () => {
    const guarded: ProjectIntegration = {
      ...integration(),
      absent: [{ path: "opencode.json", key: ["mcp", "sample"] }],
    };
    await writeFile(join(root, "opencode.json"), '{"mcp":{}}');
    await sync(guarded);
    const plan = await reconcileProject(root, config, guarded);
    expect(plan.changes).toEqual([]);

    const external = '{"mcp":{"sample":{"type":"remote","url":"https://example.com"}}}';
    await writeFile(join(root, "opencode.json"), external);
    await expect(applyProject(root, config, plan)).rejects.toThrow("changed during planning");
    expect(await readFile(join(root, "opencode.json"), "utf8")).toBe(external);
    await expect(readFile(join(root, ".hooknostic/transaction.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("detects prototype-key collisions in unowned JSONC", async () => {
    await writeFile(
      join(root, "opencode.jsonc"),
      '{"mcp":{"__proto__":{"type":"remote","url":"https://example.invalid"}}}',
    );
    await expect(
      reconcileProject(root, config, {
        files: [],
        entries: [],
        guidance: [],
        absent: [{ path: "opencode.jsonc", key: ["mcp", "__proto__"] }],
      }),
    ).rejects.toThrow("unowned component collision");
  });
  it("detects a collision under a key's fold and names the key it found", async () => {
    const fold = (name: string) => name.replaceAll("-", "_");
    const check = (key: string): ProjectIntegration => ({
      files: [],
      entries: [],
      guidance: [],
      absent: [{ path: "servers.json", key: ["mcpServers", key], fold }],
    });
    await writeFile(join(root, "servers.json"), '{"mcpServers":{"a_b-c":{},"--proto--":{}}}');
    await expect(reconcileProject(root, config, check("a-b_c"))).rejects.toThrow(
      "unowned component collision: servers.json:mcpServers.a_b-c",
    );
    await expect(reconcileProject(root, config, check("__proto__"))).rejects.toThrow(
      "unowned component collision: servers.json:mcpServers.--proto--",
    );
    await expect(reconcileProject(root, config, check("other"))).resolves.toBeDefined();
  });
  it.each(["__proto__", "constructor", "prototype"])("reconciles a JSONC property named %s", async (name) => {
    const desired = (command?: string): ProjectIntegration => ({
      files: [],
      entries:
        command === undefined
          ? []
          : [{ path: "settings.json", key: ["mcpServers", name], kind: "property", value: { command } }],
      guidance: [],
    });
    await sync(desired("node"));
    let document = JSON.parse(await readFile(join(root, "settings.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.hasOwn(document.mcpServers, name)).toBe(true);
    await sync(desired("bun"));
    document = JSON.parse(await readFile(join(root, "settings.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(document.mcpServers[name]).toEqual({ command: "bun" });
    await sync(desired());
    document = JSON.parse(await readFile(join(root, "settings.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.hasOwn(document.mcpServers, name)).toBe(false);
  });
  it("rejects another owner and unsafe paths", async () => {
    await sync();
    await expect(reconcileProject(root, "other.ts", integration())).rejects.toThrow("another configuration");
    for (const path of ["../outside", ".git/config", ".env", "C:\\outside"]) {
      await expect(
        reconcileProject(root, config, { files: [{ path, contents: "bad" }], entries: [], guidance: [] }),
      ).rejects.toThrow("unsafe");
    }
  });
  it("rejects symlinked destination ancestors", async () => {
    const outside = await mkdtemp(join(tmpdir(), "hooknostic-outside-"));
    try {
      await symlink(outside, join(root, "generated"), process.platform === "win32" ? "junction" : "dir");
      await expect(sync()).rejects.toThrow("symbolic link");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
  it("rejects a concurrent synchronization and names recover", async () => {
    await mkdir(join(root, ".hooknostic"));
    await writeFile(join(root, ".hooknostic/sync.lock"), String(process.pid));
    const lock = join(await realpath(root), ".hooknostic", "sync.lock");
    await expect(sync()).rejects.toMatchObject({
      message: `another hooknostic sync or recover may be running: ${lock} exists; if neither is, run hooknostic recover with the same configuration, which removes a lock whose recorded process ID has exited`,
      code: "EEXIST",
      path: lock,
      // `link` puts the staging source in the raw cause's `path`, so the
      // wrapper keeps the cause untouched and reports the lock itself.
      cause: { code: "EEXIST" },
    });
    // The failed attempt's own staging link is cleaned up, leaving the peer's lock.
    expect(await readdir(join(root, ".hooknostic/staging"))).toEqual([]);
    await expect(recoverProject(root, config)).rejects.toThrow("still running");
  });
  it("lets recover remove a leftover sync lock from a process that has exited", async () => {
    await mkdir(join(root, ".hooknostic"));
    await writeFile(join(root, ".hooknostic/sync.lock"), String(deadPid()));
    await expect(sync()).rejects.toThrow("run hooknostic recover");
    await recoverProject(root, config);
    await expect(readFile(join(root, ".hooknostic/sync.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await sync();
  });
  it("lets recover remove a dead sync lock and finish the interrupted transaction (#267)", async () => {
    await mkdir(join(root, ".hooknostic"));
    await writeFile(join(root, "settings.json"), "after");
    await writeFile(join(root, ".hooknostic/transaction.json"), journal("before", "after"));
    await writeFile(join(root, ".hooknostic/sync.lock"), String(deadPid()));
    await recoverProject(root, config);
    expect(await readFile(join(root, "settings.json"), "utf8")).toBe("before");
    await expect(readFile(join(root, ".hooknostic/transaction.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, ".hooknostic/sync.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    // The lock was claimed into staging and the claim then removed.
    expect(await readdir(join(root, ".hooknostic/staging"))).toEqual([]);
  });
  it("lets recover take over a recovery lock from a process that has exited, with nothing staged (#267)", async () => {
    // The common case: a recover killed after taking its lock, in a project
    // that has no journal and has never staged a file.
    await mkdir(join(root, ".hooknostic"));
    await writeFile(join(root, ".hooknostic/recovery.lock"), String(deadPid()));
    await recoverProject(root, config);
    await expect(readFile(join(root, ".hooknostic/recovery.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, ".hooknostic/sync.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    // The lock was claimed into staging and the claim then removed.
    expect(await readdir(join(root, ".hooknostic/staging"))).toEqual([]);
  });
  it("validates the configuration path before touching any lock", async () => {
    await expect(recoverProject(root, "../outside.ts")).rejects.toThrow("unsafe project path: ../outside.ts");
    await expect(readdir(join(root, ".hooknostic"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("lets recover take over a dead recovery lock and finish the interrupted transaction (#267)", async () => {
    await mkdir(join(root, ".hooknostic"));
    await writeFile(join(root, "settings.json"), "after");
    await writeFile(join(root, ".hooknostic/transaction.json"), journal("before", "after"));
    await writeFile(join(root, ".hooknostic/recovery.lock"), String(deadPid()));
    await recoverProject(root, config);
    expect(await readFile(join(root, "settings.json"), "utf8")).toBe("before");
    await expect(readFile(join(root, ".hooknostic/transaction.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, ".hooknostic/recovery.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses a recovery lock whose process is running, naming its PID and path, and keeps it (#267)", async () => {
    await mkdir(join(root, ".hooknostic"));
    await writeFile(join(root, ".hooknostic/recovery.lock"), String(process.pid));
    const lock = join(await realpath(root), ".hooknostic", "recovery.lock");
    await expect(recoverProject(root, config)).rejects.toThrow(
      `a hooknostic recover is still running: PID ${process.pid} holds ${lock}; if no such process exists (its PID may have been reused), delete that file and rerun hooknostic recover`,
    );
    expect(await readFile(lock, "utf8")).toBe(String(process.pid));
  });
  it.each([
    // process.kill accepts no pid above 2^31-1, though it is a safe integer.
    ...[".hooknostic/recovery.lock", ".hooknostic/sync.lock"].flatMap((name) =>
      ["garbage", "0", "2147483648"].map((contents) => ({ name, contents })),
    ),
  ])("refuses $name holding $contents, naming its path, and keeps it", async ({ name, contents }) => {
    await mkdir(join(root, ".hooknostic"));
    await writeFile(join(root, name), contents);
    const lock = join(await realpath(root), name);
    await expect(recoverProject(root, config)).rejects.toThrow(
      `invalid lock: ${lock} holds no valid process ID; inspect it, and if no hooknostic sync or recover is running, delete it and rerun hooknostic recover`,
    );
    expect(await readFile(lock, "utf8")).toBe(contents);
  });
  it.each([".hooknostic/recovery.lock", ".hooknostic/sync.lock"])(
    "refuses an empty %s, however old, and says how to remove it",
    async (name) => {
      // Current hooknostic links a flushed staging file, so a half-created
      // lock is unobservable; an older one, another tool, or the no-hard-link
      // fallback can still leave an empty lock, so recover refuses it.
      await mkdir(join(root, ".hooknostic"));
      await writeFile(join(root, name), "");
      const old = new Date(Date.now() - 3_600_000);
      await utimes(join(root, name), old, old);
      const lock = join(await realpath(root), name);
      await expect(recoverProject(root, config)).rejects.toThrow(
        `invalid lock: ${lock} is empty and holds no process ID, as an older hooknostic, another tool, or a filesystem without hard links can leave it; if no hooknostic sync or recover is running, delete it and rerun hooknostic recover`,
      );
      expect(await readFile(lock, "utf8")).toBe("");
    },
  );
  it.each([
    { name: ".hooknostic/recovery.lock", holder: "recover" },
    { name: ".hooknostic/sync.lock", holder: "sync or recover" },
  ])("counts a process it may not signal (EPERM) as running, for $name", async ({ name, holder }) => {
    await mkdir(join(root, ".hooknostic"));
    await writeFile(join(root, name), "4242");
    const lock = join(await realpath(root), name);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM", syscall: "kill" });
    });
    try {
      await expect(recoverProject(root, config)).rejects.toThrow(
        `a hooknostic ${holder} is still running: PID 4242 holds ${lock};`,
      );
      expect(kill).toHaveBeenCalledWith(4242, 0);
    } finally {
      kill.mockRestore();
    }
    expect(await readFile(lock, "utf8")).toBe("4242");
  });
  it("recovers interrupted replacements from preimages", async () => {
    await mkdir(join(root, ".hooknostic"));
    await writeFile(join(root, "settings.json"), "after");
    await writeFile(
      join(root, ".hooknostic/transaction.json"),
      JSON.stringify({
        schemaVersion: 1,
        config,
        entries: [
          {
            path: "settings.json",
            before: Buffer.from("before").toString("base64"),
            afterHash: fileHash("after"),
            mode: 0o644,
          },
        ],
      }),
    );
    await expect(reconcileProject(root, config, integration())).rejects.toThrow("unfinished");
    await recoverProject(root, config);
    expect(await readFile(join(root, "settings.json"), "utf8")).toBe("before");
    await expect(readFile(join(root, ".hooknostic/transaction.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("keeps recovery records when an external edit conflicts", async () => {
    await mkdir(join(root, ".hooknostic"));
    await writeFile(join(root, "settings.json"), "external");
    const journal = JSON.stringify({
      schemaVersion: 1,
      config,
      entries: [{ path: "settings.json", before: null, afterHash: fileHash("after"), mode: 0o644 }],
    });
    await writeFile(join(root, ".hooknostic/transaction.json"), journal);
    await expect(recoverProject(root, config)).rejects.toThrow("recovery conflict");
    expect(await readFile(join(root, ".hooknostic/transaction.json"), "utf8")).toBe(journal);
    expect(await readFile(join(root, "settings.json"), "utf8")).toBe("external");
  });
});
