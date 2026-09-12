import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyProject, fileHash, reconcileProject, recoverProject, type ProjectIntegration } from "./project-files.js";
let root: string;
const config = "hooknostic.config.ts";
const integration = (): ProjectIntegration => ({ files: [{ path: "generated/runtime.mjs", contents: "export default 1;\n" }], entries: [{ path: "settings.json", key: ["hooks", "Stop"], kind: "array", value: { hooks: [{ command: "node generated/runtime.mjs", timeout: 12 }] } }], guidance: [] });
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "hooknostic project ")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function sync(input = integration()) { const plan = await reconcileProject(root, config, input); await applyProject(root, config, plan); return plan; }
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
  it("preserves unrelated JSONC bytes and array ordering", async () => {
    const prefix = '{\n // user configuration\n "theme": "dark",\n "hooks": { "Stop": [{ "custom": true }] }\n}\n';
    await writeFile(join(root, "settings.json"), prefix);
    await sync();
    const text = await readFile(join(root, "settings.json"), "utf8");
    expect(text).toContain('// user configuration\n "theme": "dark",');
    expect(text.indexOf('"custom"')).toBeLessThan(text.indexOf('"command"'));
    expect((await reconcileProject(root, config, integration())).changes).toEqual([]);
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
    const next = integration(); next.entries[0]!.value = { hooks: [{ command: "node generated/runtime.mjs", timeout: 99 }] };
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
    await sync(); await rm(join(root, "generated/runtime.mjs"));
    expect((await reconcileProject(root, config, integration())).changes.map(c => c.path)).toContain("generated/runtime.mjs");
  });
  it("refuses unowned generated files even when their bytes match", async () => {
    await mkdir(join(root, "generated")); await writeFile(join(root, "generated/runtime.mjs"), "export default 1;\n");
    await expect(sync()).rejects.toThrow("unowned");
  });
  it("refuses edited owned files and array entries", async () => {
    await sync(); await writeFile(join(root, "generated/runtime.mjs"), "changed");
    await expect(sync()).rejects.toThrow("modified");
    await writeFile(join(root, "generated/runtime.mjs"), "export default 1;\n");
    await writeFile(join(root, "settings.json"), '{"hooks":{"Stop":[{"changed":true}]}}');
    await expect(sync()).rejects.toThrow("modified");
  });
  it("refuses duplicate owned entry matches", async () => {
    await sync(); const doc = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
    doc.hooks.Stop.push(doc.hooks.Stop[0]); await writeFile(join(root, "settings.json"), JSON.stringify(doc));
    await expect(sync()).rejects.toThrow("ambiguous");
  });
  it("refuses taking over an equivalent unowned registration", async () => {
    await writeFile(join(root, "settings.json"), JSON.stringify({ hooks: { Stop: [integration().entries[0]!.value] } }));
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
  it("rejects another owner and unsafe paths", async () => {
    await sync(); await expect(reconcileProject(root, "other.ts", integration())).rejects.toThrow("another configuration");
    for (const path of ["../outside", ".git/config", ".env", "C:\\outside"]) {
      await expect(reconcileProject(root, config, { files: [{ path, contents: "bad" }], entries: [], guidance: [] })).rejects.toThrow("unsafe");
    }
  });
  it("rejects symlinked destination ancestors", async () => {
    const outside = await mkdtemp(join(tmpdir(), "hooknostic-outside-"));
    try {
      await symlink(outside, join(root, "generated"), process.platform === "win32" ? "junction" : "dir");
      await expect(sync()).rejects.toThrow("symbolic link");
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
  it("rejects a concurrent synchronization", async () => {
    await mkdir(join(root, ".hooknostic")); await writeFile(join(root, ".hooknostic/sync.lock"), String(process.pid));
    await expect(sync()).rejects.toMatchObject({ code: "EEXIST" });
    await expect(recoverProject(root, config)).rejects.toThrow("still running");
  });
  it("recovers interrupted replacements from preimages", async () => {
    await mkdir(join(root, ".hooknostic")); await writeFile(join(root, "settings.json"), "after");
    await writeFile(join(root, ".hooknostic/transaction.json"), JSON.stringify({ schemaVersion: 1, config, entries: [{ path: "settings.json", before: Buffer.from("before").toString("base64"), afterHash: fileHash("after"), mode: 0o644 }] }));
    await expect(reconcileProject(root, config, integration())).rejects.toThrow("unfinished");
    await recoverProject(root, config);
    expect(await readFile(join(root, "settings.json"), "utf8")).toBe("before");
    await expect(readFile(join(root, ".hooknostic/transaction.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("keeps recovery records when an external edit conflicts", async () => {
    await mkdir(join(root, ".hooknostic")); await writeFile(join(root, "settings.json"), "external");
    const journal = JSON.stringify({ schemaVersion: 1, config, entries: [{ path: "settings.json", before: null, afterHash: fileHash("after"), mode: 0o644 }] });
    await writeFile(join(root, ".hooknostic/transaction.json"), journal);
    await expect(recoverProject(root, config)).rejects.toThrow("recovery conflict");
    expect(await readFile(join(root, ".hooknostic/transaction.json"), "utf8")).toBe(journal);
    expect(await readFile(join(root, "settings.json"), "utf8")).toBe("external");
  });
});
