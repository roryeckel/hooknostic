import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import * as sdkSchemas from "@hooknostic/sdk/schemas";

const SDK = "@hooknostic/sdk";
const SCHEMAS = `${SDK}/schemas`;
/** The upgrade guide for the move: a link, because an installed CLI has no `docs/` folder. */
const GUIDE = "https://github.com/roryeckel/hooknostic/blob/master/docs/upgrading/sdk-schemas-subpath.md";

/** esbuild's error for an import of a name the module does not export, path and name quoted as JSON strings. */
const NO_MATCHING_EXPORT = /^No matching export in ("(?:[^"\\]|\\.)*") for import ("(?:[^"\\]|\\.)*")$/;
/** A path inside an installed SDK: npm, pnpm's store, and a Yarn zip that cannot be read without Yarn's runtime. */
const INSTALLED_SDK = /(?:^|\/)node_modules\/@hooknostic\/sdk\//;
/** The SDK's schemas entry, built (`schemas.js`) or source (`schemas.ts`), or a `/schemas` subpath with no extension. */
const SCHEMAS_ENTRY = /(?:^|\/)schemas(?:\.[cm]?[jt]s)?$/;

/** Internal (#247): a bundle failure that names schemas the SDK's root no longer exports. */
export interface MovedSchemaImports {
  /** Where the schemas moved, the import to write instead, and the upgrade guide. */
  remediation: string;
  /** Whether those imports are every error of the build, so nothing else needs fixing. */
  only: boolean;
}

/**
 * Internal (#247): whether esbuild failed to bundle a user module because it
 * imports from `@hooknostic/sdk` a schema that 0.13.0 moved to
 * `@hooknostic/sdk/schemas`. Only esbuild's own error entries are read:
 * `failure` is what `build` rejected with, never a value user code threw.
 * `workingDirectory` is the build's `absWorkingDir`, which esbuild's paths are
 * relative to. A name counts only when the schemas subpath of this
 * Hooknostic's own SDK exports it, so a misspelt name is not said to have
 * moved, and the module lacking it must be the SDK's, but not its schemas
 * entry: there the import already names the subpath. Anything unexpected,
 * including a throw, means no.
 */
export function movedSchemaImports(failure: unknown, workingDirectory: string): MovedSchemaImports | undefined {
  try {
    const errors: unknown = (failure as { errors?: unknown }).errors;
    if (!Array.isArray(errors)) return undefined;
    const names: string[] = [];
    let others = false;
    for (const error of errors) {
      const name = movedSchemaName(error, workingDirectory);
      if (name === undefined) others = true;
      else if (!names.includes(name)) names.push(name);
    }
    if (names.length === 0) return undefined;
    return {
      remediation:
        `the SDK's schemas moved from ${SDK} to ${SCHEMAS} in 0.13.0: ` +
        `import { ${names.join(", ")} } from "${SCHEMAS}" instead. See ${GUIDE}.`,
      only: !others,
    };
  } catch {
    return undefined;
  }
}

/** The moved schema one esbuild error entry failed to import from the SDK, if that is what it says. */
function movedSchemaName(error: unknown, workingDirectory: string): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const text: unknown = (error as { text?: unknown }).text;
  if (typeof text !== "string") return undefined;
  const match = NO_MATCHING_EXPORT.exec(text);
  if (match === null) return undefined;
  const path = unquote(match[1]!);
  const name = unquote(match[2]!);
  if (path === undefined || name === undefined || !Object.hasOwn(sdkSchemas, name)) return undefined;
  const forward = path.replaceAll("\\", "/");
  // The module lacking the name is the schemas entry itself: the import already
  // names the subpath, and the project's SDK is older than this Hooknostic's.
  if (SCHEMAS_ENTRY.test(forward)) return undefined;
  if (INSTALLED_SDK.test(forward)) return name;
  return owningPackageName(resolve(workingDirectory, path)) === SDK ? name : undefined;
}

/** A string esbuild quoted, or undefined if it holds an escape JSON does not have. */
function unquote(quoted: string): string | undefined {
  try {
    const value: unknown = JSON.parse(quoted);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The name in the nearest manifest above `file` that has one: the package that
 * owns it, as for the workspace's SDK or one installed with `link:`. A manifest
 * with no name, such as one that only sets the module type, or one that cannot
 * be read, is walked past.
 */
function owningPackageName(file: string): string | undefined {
  for (let directory = dirname(file); ;) {
    const path = join(directory, "package.json");
    if (existsSync(path)) {
      try {
        const name: unknown = (JSON.parse(readFileSync(path, "utf8")) as { name?: unknown } | null)?.name;
        if (typeof name === "string") return name;
      } catch {
        // An unreadable manifest names nothing.
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
