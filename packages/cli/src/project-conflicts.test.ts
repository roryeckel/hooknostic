import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, it } from "vitest";

import { runCli } from "./cli.js";

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(relative: string) {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        result[`${path}/`] = "";
        await visit(path);
      } else result[path] = (await readFile(join(root, path))).toString("base64");
    }
  }
  await visit("");
  return result;
}

it.each([false, true])(
  "recovers from build before the first sync in one pass (json=%s)",
  async (json) => {
    const root = await mkdtemp(join(tmpdir(), "hooknostic-cli-conflicts-"));
    const config = join(root, "hooknostic.config.ts");
    const invoke = async (args: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCli([...args, "--config", config, ...(json ? ["--json"] : [])], {
        io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
      });
      return { code, out: out.join("\n"), err: err.join("\n") };
    };
    try {
      expect((await invoke(["init", "--local"])).code).toBe(0);
      // Resolve the SDK in the scratch project without installing dependencies.
      const sdk = resolve(import.meta.dirname, "../../sdk/src/index.ts").replaceAll("\\", "/");
      for (const path of [config, join(root, "hooks.ts")])
        await writeFile(path, (await readFile(path, "utf8")).replace('"@hooknostic/sdk"', JSON.stringify(sdk)));
      const built = await invoke(["build"]);
      expect(built.code, built.out + built.err).toBe(0);
      const before = await snapshot(root);
      const artifacts = Object.keys(before)
        .filter((path) => path.startsWith(".hooknostic/artifacts/") && !path.endsWith("/"))
        .sort();
      expect(artifacts.length).toBeGreaterThan(1);
      expect(before).not.toHaveProperty(".hooknostic/integration.json");

      for (const args of [["sync"], ["sync", "--dry-run"], ["verify"]]) {
        const result = await invoke(args);
        expect(result.code).toBe(2);
        const report = json ? JSON.parse(result.out) : undefined;
        const message: string = json ? report.errors.join("\n") : result.err;
        if (json) {
          expect(report).toMatchObject({ schemaVersion: 1, command: args[0], ok: false, drift: false, changes: [] });
          expect(report.errors).toHaveLength(1);
          expect(result.err).toBe("");
        }
        expect.soft(message).toContain(`${args[0]} failed`);
        expect.soft(message).toContain("ownership");
        expect.soft(message).toContain("same configuration");
        if (args[0] === "verify") {
          expect.soft(message).toContain("verify writes nothing");
          expect.soft(message).toMatch(/run hooknostic sync.*rerun hooknostic verify/s);
        } else expect.soft(message).toContain(`rerun hooknostic ${args.join(" ")}`);
        const reported = [...message.matchAll(/unowned or modified generated file: ([^\n;]+)/g)].map(
          (match) => match[1],
        );
        expect.soft(reported).toEqual(artifacts);
        expect(await snapshot(root)).toEqual(before);
      }

      await rename(join(root, ".hooknostic/artifacts"), join(root, "saved-artifacts"));
      const moved = await snapshot(root);
      expect((await invoke(["sync", "--dry-run"])).code).toBe(0);
      expect(await snapshot(root)).toEqual(moved);
      expect((await invoke(["sync"])).code).toBe(0);
      expect((await invoke(["verify"])).code).toBe(0);
      // The build report is unrelated to ownership and need not be removed.
      expect(await readFile(join(root, "hooknostic-build.json"), "base64")).toBe(before["hooknostic-build.json"]);
      expect((await invoke(["build"])).code).toBe(0);
      const synced = await snapshot(root);
      const repeated = await invoke(["sync"]);
      expect(repeated.code).toBe(0);
      if (json) expect(JSON.parse(repeated.out).changes).toEqual([]);
      else expect(repeated.out).not.toContain("UPDATE ");
      expect(await snapshot(root)).toEqual(synced);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
