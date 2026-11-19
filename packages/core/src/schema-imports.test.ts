import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

// The copy the CLI bundles: the same specifier, resolved as the CLI's bundle resolves it.
import * as sdkSchemas from "@hooknostic/sdk/schemas";

import { movedSchemaImports } from "./schema-imports.js";

const GUIDE = "https://github.com/roryeckel/hooknostic/blob/master/docs/upgrading/sdk-schemas-subpath.md";
const hint = (names: string) =>
  "the SDK's schemas moved from @hooknostic/sdk to @hooknostic/sdk/schemas in 0.13.0: " +
  `import { ${names} } from "@hooknostic/sdk/schemas" instead. See ${GUIDE}.`;

/** esbuild's failure for a build whose errors have these texts. */
const failure = (...texts: string[]) =>
  Object.assign(new Error(`Build failed with ${texts.length} error(s)`), {
    errors: texts.map((text) => ({ id: "", pluginName: "", text, location: null, notes: [], detail: undefined })),
  });
/** esbuild's error text, with the path and the name quoted as esbuild quotes them. */
const noMatchingExport = (path: string, name: string) =>
  `No matching export in ${JSON.stringify(path)} for import ${JSON.stringify(name)}`;

const INSTALLED = "node_modules/@hooknostic/sdk/dist/index.js";
// Nothing exists here: only the path says the module is the SDK's.
const NOWHERE = resolve(tmpdir(), "hooknostic-247-no-such-project");

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
async function root(): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "hooknostic-schema-imports-"));
  roots.push(dir);
  return dir;
}

describe("movedSchemaImports (#247)", () => {
  it("recognises a Yarn Plug'n'Play zip path, which cannot be read without Yarn's runtime", () => {
    const zip =
      "../.yarn/cache/@hooknostic-sdk-npm-0.13.0-0123456789-abcdef.zip/node_modules/@hooknostic/sdk/dist/index.js";
    expect(movedSchemaImports(failure(noMatchingExport(zip, "effectSchema")), NOWHERE)).toEqual({
      remediation: hint("effectSchema"),
      only: true,
    });
  });

  it("recognises a pnpm store path", () => {
    const store = "node_modules/.pnpm/@hooknostic+sdk@0.13.0/node_modules/@hooknostic/sdk/dist/index.js";
    expect(movedSchemaImports(failure(noMatchingExport(store, "effectSchema")), NOWHERE)?.remediation).toBe(
      hint("effectSchema"),
    );
  });

  it.each([
    ["the installed subpath", "node_modules/@hooknostic/sdk/dist/schemas.js"],
    ["the workspace's source", "node_modules/@hooknostic/sdk/src/schemas.ts"],
    ["an extensionless subpath", "node_modules/@hooknostic/sdk/schemas"],
  ])(
    "gives no hint when the module lacking the name is the SDK's schemas entry: %s, an SDK older than the CLI's",
    (_, path) => {
      // The import already names the subpath; telling it to import from there would repeat it.
      expect(movedSchemaImports(failure(noMatchingExport(path, "effectSchema")), NOWHERE)).toBeUndefined();
    },
  );

  it("does not take a package whose name only starts with the SDK's for the SDK", () => {
    const lookalike = "node_modules/@hooknostic/sdk-extras/dist/index.js";
    expect(movedSchemaImports(failure(noMatchingExport(lookalike, "effectSchema")), NOWHERE)).toBeUndefined();
  });

  describe("names every export of @hooknostic/sdk/schemas", () => {
    it("which include every schema the upgrade guide lists", async () => {
      // A stale or partial SDK build would under-cover the cases below; fail loudly instead.
      // A subset, not equality: a schema added later must not be written into the 0.13.0 guide.
      const guide = await readFile(
        resolve(import.meta.dirname, "../../../docs/upgrading/sdk-schemas-subpath.md"),
        "utf8",
      );
      const listed = guide.slice(guide.indexOf("## Who is affected"), guide.indexOf("Nothing else moves"));
      const names = [...listed.matchAll(/`(\w+Schema)`/g)].map((match) => match[1]);
      expect(names).toHaveLength(22);
      expect(Object.keys(sdkSchemas)).toEqual(expect.arrayContaining(names));
    });

    it.each(Object.keys(sdkSchemas))("%s", (name) => {
      expect(movedSchemaImports(failure(noMatchingExport(INSTALLED, name)), NOWHERE)).toEqual({
        remediation: hint(name),
        only: true,
      });
    });
  });

  it("keeps esbuild's order, names each schema once, and says when other errors remain", () => {
    const result = movedSchemaImports(
      failure(
        noMatchingExport(INSTALLED, "hookResultSchema"),
        noMatchingExport(INSTALLED, "effectSchema"),
        noMatchingExport(INSTALLED, "hookResultSchema"),
        noMatchingExport(INSTALLED, "missingHelper"),
      ),
      NOWHERE,
    );
    expect(result).toEqual({ remediation: hint("hookResultSchema, effectSchema"), only: false });
    expect(
      movedSchemaImports(
        failure(noMatchingExport(INSTALLED, "effectSchema"), 'Could not resolve "./missing.ts"'),
        NOWHERE,
      )?.only,
    ).toBe(false);
  });

  it.each([
    ["an inherited name", "toString"],
    ["a name the subpath does not export", "missingSchema"],
    ["a root export", "defineConfig"],
  ])("ignores %s", (_, name) => {
    expect(movedSchemaImports(failure(noMatchingExport(INSTALLED, name)), NOWHERE)).toBeUndefined();
  });

  it("reads the path and the name as esbuild quotes them", () => {
    // A quote cannot be in a Windows file name, so only the text carries one.
    const quoted = 'node_modules/@hooknostic/sdk/dist/"quoted"/index.js';
    expect(movedSchemaImports(failure(noMatchingExport(quoted, "effectSchema")), NOWHERE)?.remediation).toBe(
      hint("effectSchema"),
    );
    // An absolute path, as esbuild may print one on another drive, with escaped backslashes.
    const backslashed = "D:\\project\\node_modules\\@hooknostic\\sdk\\dist\\index.js";
    expect(movedSchemaImports(failure(noMatchingExport(backslashed, "effectSchema")), NOWHERE)?.remediation).toBe(
      hint("effectSchema"),
    );
  });

  describe("finds the SDK by the nearest manifest that has a name", () => {
    async function layout(manifests: Record<string, unknown>): Promise<string> {
      const dir = await root();
      for (const [path, manifest] of Object.entries(manifests)) {
        await mkdir(join(dir, path), { recursive: true });
        await writeFile(join(dir, path, "package.json"), JSON.stringify(manifest));
      }
      return dir;
    }

    it("as the workspace's SDK, aliased to its source", async () => {
      const dir = await layout({ "packages/sdk": { name: "@hooknostic/sdk" } });
      const project = join(dir, "project");
      expect(
        movedSchemaImports(failure(noMatchingExport("../packages/sdk/src/index.ts", "effectSchema")), project)
          ?.remediation,
      ).toBe(hint("effectSchema"));
    });

    it("walking past a manifest that only sets the module type", async () => {
      const dir = await layout({ sdk: { name: "@hooknostic/sdk" }, "sdk/dist": { type: "module" } });
      expect(movedSchemaImports(failure(noMatchingExport("sdk/dist/index.js", "effectSchema")), dir)?.remediation).toBe(
        hint("effectSchema"),
      );
    });

    it("and stops at another package's", async () => {
      const dir = await layout({ sdk: { name: "@hooknostic/sdk" }, "sdk/vendor": { name: "vendored" } });
      expect(movedSchemaImports(failure(noMatchingExport("sdk/vendor/index.js", "effectSchema")), dir)).toBeUndefined();
    });

    it("or finds none", async () => {
      const dir = await root();
      expect(movedSchemaImports(failure(noMatchingExport("local.ts", "effectSchema")), dir)).toBeUndefined();
    });
  });

  it.each([
    ["a string", "Build failed"],
    ["null", null],
    ["an error without esbuild's errors", new Error("esbuild produced no output")],
    [
      "a value whose errors getter throws",
      new Proxy(
        {},
        {
          get() {
            throw new Error("getter");
          },
        },
      ),
    ],
    ["errors that are not objects", { errors: [null, 1, { text: 2 }] }],
  ])("returns nothing, without throwing, for %s", (_, value) => {
    expect(movedSchemaImports(value, NOWHERE)).toBeUndefined();
  });
});
