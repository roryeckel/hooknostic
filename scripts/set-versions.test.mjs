import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const scratch = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hooknostic-release-versions-"));
  scratch.push(root);
  const files = ["package.json", "scripts/set-versions.mjs", "packages/core/src/build.ts"];
  for (const name of readdirSync(join(ROOT, "packages"))) {
    files.push(`packages/${name}/package.json`);
    if (name.startsWith("adapter-")) files.push(`packages/${name}/src/index.ts`);
  }
  files.push("packages/adapter-opencode/src/v2/index.ts");
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(ROOT, file), join(root, file));
  }
  const current = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const next = `${Number(current.split(".")[0]) + 1}.0.0-rehearsal.0`;
  const run = (...args) =>
    spawnSync(process.execPath, [join(root, "scripts/set-versions.mjs"), ...args], { encoding: "utf8" });
  return { root, current, next, run };
}

it("bumps both OpenCode implementations and checks the resulting release", () => {
  const { root, next, run } = fixture();
  const bump = run(next);
  expect(bump.status, bump.stderr).toBe(0);
  for (const family of ["index.ts", "v2/index.ts"]) {
    const source = readFileSync(join(root, "packages/adapter-opencode/src", family), "utf8");
    expect(source, family).toContain(`adapterVersion: "${next}"`);
  }
  const check = run("--check", next);
  expect(check.status, check.stderr).toBe(0);
});

it("rejects a stale v2 version without rewriting it in check mode", () => {
  const { root, current, next, run } = fixture();
  expect(run(next).status).toBe(0);
  const path = join(root, "packages/adapter-opencode/src/v2/index.ts");
  const stale = readFileSync(path, "utf8").replace(/adapterVersion: "[^"]+"/, `adapterVersion: "${current}"`);
  writeFileSync(path, stale);
  const check = run("--check", next);
  expect(check.status).toBe(1);
  expect(check.stderr).toContain("packages/adapter-opencode/src/v2/index.ts");
  expect(readFileSync(path, "utf8")).toBe(stale);
});
