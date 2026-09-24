import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Node resolves an entrypoint's symlinks before assigning import.meta.url. */
export function isMainModule(moduleUrl, argv1) {
  if (argv1 === undefined) return false;
  const modulePath = fileURLToPath(moduleUrl);
  if (modulePath === resolve(argv1)) return true;
  try {
    return realpathSync(modulePath) === realpathSync(argv1);
  } catch {
    return false;
  }
}
