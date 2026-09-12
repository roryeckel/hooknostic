import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { applyProject, reconcileProject, type ProjectIntegration } from "./project-files.js";
import { readProjectToml } from "./project-toml.js";
let root: string;
const path = ".codex/config.toml";
const owner = "config.ts";
const value = { command: "node", args: ["a"], env: { REF: "${TOKEN}" } };
const plan = (next: unknown = value): ProjectIntegration => ({ files: [], entries: next === undefined ? [] : [{ path, format: "toml", key: ["mcp_servers", "sample.dot"], kind: "property", value: next }], guidance: [] });
const empty: ProjectIntegration = { files: [], entries: [], guidance: [] };
const unrelated = '# personal settings\n[features]\nflag = true # keep exact\n';
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "hooknostic toml ")); await mkdir(join(root, ".codex")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function sync(input = plan()) { const result = await reconcileProject(root, owner, input); await applyProject(root, owner, result); return result; }
it("adds, verifies, updates and removes TOML ownership while preserving unrelated bytes", async () => {
  await writeFile(join(root, path), unrelated);
  await sync();
  expect((await sync()).changes).toEqual([]);
  expect(await readFile(join(root, path), "utf8")).toContain(unrelated);
  await sync(plan({ ...value, args: ["changed"] }));
  expect((readProjectToml(await readFile(join(root, path), "utf8")).mcp_servers as Record<string, unknown>)["sample.dot"]).toEqual({ ...value, args: ["changed"] });
  await sync(empty);
  expect(await readFile(join(root, path), "utf8")).toContain(unrelated);
  expect((await sync(empty)).changes).toEqual([]);
});
it.each([
  '[mcp_servers."sample.dot"]\ncommand = "node"\nargs = ["a"]\n[mcp_servers."sample.dot".env]\nREF = "${TOKEN}"\n',
  'mcp_servers."sample.dot".command = "node"\nmcp_servers."sample.dot".args = ["a"]\nmcp_servers."sample.dot".env.REF = "${TOKEN}"\n',
  'mcp_servers = { "sample.dot" = { command = "node", args = ["a"], env = { REF = "${TOKEN}" } }, other = {command = "other"} }\n',
  '[mcp_servers]\n"sample.dot" = { command = "node", args = ["a"], env = { REF = "${TOKEN}" } }\n',
  'mcp_servers = { "sample.dot".command = "node", "sample.dot".args = ["a"], "sample.dot".env.REF = "${TOKEN}", other.command = "other" }\n',
])("recognizes equivalent owned syntax and removes only its server: %s", async syntax => {
  await sync();
  await writeFile(join(root, path), syntax + unrelated);
  expect((await sync()).changes).toEqual([]);
  await sync(plan({ ...value, args: ["changed"] }));
  expect((readProjectToml(await readFile(join(root, path), "utf8")).mcp_servers as Record<string, unknown>)["sample.dot"]).toEqual({ ...value, args: ["changed"] });
  await sync(empty);
  const text = await readFile(join(root, path), "utf8");
  expect(text).toContain(unrelated);
  expect((readProjectToml(text).mcp_servers as Record<string, unknown> | undefined)?.["sample.dot"]).toBeUndefined();
  if (syntax.includes("other")) expect((readProjectToml(text).mcp_servers as Record<string, unknown>).other).toEqual({ command: "other" });
});
it("inserts into an existing inline parent without rewriting its sibling", async () => {
  await writeFile(join(root, path), 'mcp_servers = { other = {command="other"} }\n' + unrelated);
  await sync();
  expect(await readFile(join(root, path), "utf8")).toContain('other = {command="other"}');
  expect((await sync()).changes).toEqual([]);
});
it("retains ordinary and nested array-table semantics", () => {
  const parsed = readProjectToml('[[products]]\nname = "hammer"\n[products.details]\nweight = 2\n[[products]]\nname = "nail"\n');
  expect(parsed).toEqual({ products: [{ name: "hammer", details: { weight: 2 } }, { name: "nail" }] });
});
it("repairs missing output and refuses adoption, manual edits, and invalid TOML", async () => {
  await sync();
  const generated = await readFile(join(root, path), "utf8");
  await rm(join(root, path));
  expect((await sync()).changes.map(change => change.path)).toContain(path);
  await writeFile(join(root, path), generated.replace('"node"', '"edited"'));
  await expect(sync()).rejects.toThrow("modified");
  await expect(sync(empty)).rejects.toThrow("modified");
  await rm(join(root, ".hooknostic/integration.json"));
  await writeFile(join(root, path), generated);
  await expect(sync()).rejects.toThrow("unowned");
  await writeFile(join(root, path), 'x = 1\nx = 2\n');
  await expect(sync()).rejects.toThrow();
});
it.each([
  ["__proto__", '[mcp_servers.__proto__]\ncommand = "node"\nargs = ["a"]\nenv = { REF = "${TOKEN}" }\n'],
  ["constructor", 'mcp_servers.constructor = { command = "node", args = ["a"], env = { REF = "${TOKEN}" } }\n'],
  ["prototype", 'mcp_servers = { prototype = { command = "node", args = ["a"], env = { REF = "${TOKEN}" } } }\n'],
])("preserves and reconciles the prototype-key server %s", async (name, syntax) => {
  const named = (next: unknown = value, omit = false): ProjectIntegration => ({
    files: [],
    entries: omit ? [] : [{ path, format: "toml", key: ["mcp_servers", name], kind: "property", value: next }],
    guidance: [],
  });
  await sync(named());
  await writeFile(join(root, path), syntax + unrelated);
  expect((await reconcileProject(root, owner, named())).changes).toEqual([]);
  const parsed = readProjectToml(await readFile(join(root, path), "utf8"));
  expect(Object.hasOwn(parsed.mcp_servers as object, name)).toBe(true);
  await sync(named({ ...value, args: ["changed"] }));
  expect((readProjectToml(await readFile(join(root, path), "utf8")).mcp_servers as Record<string, unknown>)[name]).toEqual({ ...value, args: ["changed"] });
  await sync(named(undefined, true));
  expect(Object.hasOwn((readProjectToml(await readFile(join(root, path), "utf8")).mcp_servers ?? {}) as object, name)).toBe(false);
});
