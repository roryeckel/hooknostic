import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

it.each(["release-notes.mjs", "compare-capture-shapes.mjs"])(
  "runs %s directly from a path with spaces and stays inert on import",
  (script) => {
    const root = mkdtempSync(join(tmpdir(), "hooknostic entrypoints "));
    try {
      cpSync(join(ROOT, "scripts"), join(root, "scripts"), { recursive: true });
      writeFileSync(join(root, "package.json"), '{"type":"module"}');
      symlinkSync(join(root, "scripts"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
      const file = join(root, "alias", script);
      const direct = spawnSync(process.execPath, ["--experimental-strip-types", file], { encoding: "utf8" });
      expect(direct.error).toBeUndefined();
      expect(direct.status).toBe(2);
      expect(direct.stderr).toMatch(/usage|required/i);
      const imported = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          `await import(${JSON.stringify(pathToFileURL(file).href)}); console.log("imported");`,
        ],
        { encoding: "utf8" },
      );
      expect(imported.status, imported.stderr).toBe(0);
      expect(imported.stdout.trim()).toBe("imported");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
