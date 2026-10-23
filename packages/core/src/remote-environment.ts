/**
 * Source for a generated module that resolves a direct project source's remote
 * MCP declarations at load time, on a target whose harness would not resolve
 * them as the other targets do. It defines two functions:
 *
 * - `expandEnvironment(value, missing)` resolves `${NAME}` and
 *   `${NAME:-default}` from the launch environment by the launcher's rules (a
 *   defined variable wins even when empty; only an undefined one takes the
 *   default) and adds a variable that is neither to `missing`, leaving its
 *   reference in place.
 * - `warnMissingEnvironment(name, missing)` reports the server it disables.
 *
 * One copy, so every target that resolves a project's declarations itself
 * resolves them identically.
 */
export const REMOTE_ENVIRONMENT_SOURCE = `const expandEnvironment = (value, missing) =>
  value.replace(/\\$\\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\\}/g, (reference, name, fallback) => {
    const resolved = process.env[name];
    if (resolved !== undefined) return resolved;
    if (fallback !== undefined) return fallback;
    missing.add(name);
    return reference;
  });
const warnMissingEnvironment = (name, missing) =>
  console.warn("Hooknostic disabled MCP " + JSON.stringify(name) + ": missing environment " + [...missing].sort().join(", "));`;
