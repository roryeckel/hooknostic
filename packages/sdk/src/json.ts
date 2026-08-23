/**
 * Canonical JSON values.
 *
 * Effect payloads that cross the native wire boundary (`replaceInput`,
 * `replaceOutput`) must be JSON values: every harness protocol is JSON, and
 * anything else is silently dropped (`undefined`, functions, symbols), throws
 * (`bigint`, cycles), or changes type (`Date`, `Map`, class instances) on the
 * way out. The dispatcher rejects non-JSON payloads as HN401 instead.
 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** JSON.stringify invokes toJSON before it visits an object's data fields. */
function hasToJson(value: object): boolean {
  let prototype: object | null = value;
  while (prototype !== null) {
    if (Object.getOwnPropertyDescriptor(prototype, "toJSON") !== undefined) return true;
    prototype = Object.getPrototypeOf(prototype);
  }
  return false;
}

function dataProperty(
  value: object,
  key: PropertyKey,
): { value: unknown } | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? { value: descriptor.value } : undefined;
}

/** JSON ignores symbols, non-enumerable object fields, and non-index array fields. */
function hasIgnoredOwnProperties(value: object): boolean {
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1) return true; // sparse or extra fields
    return keys.some((key) => {
      if (key === "length") return false;
      if (typeof key !== "string") return true;
      const index = Number(key);
      return !Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key;
    });
  }
  return Reflect.ownKeys(value).some((key) => {
    if (typeof key !== "string") return true;
    return Object.getOwnPropertyDescriptor(value, key)?.enumerable !== true;
  });
}

/**
 * Locate the first value that is not a canonical JSON value (null, boolean,
 * finite number, string, array, plain object — acyclic). Returns a path such
 * as `$`, `$.tool.args[2]` or `undefined` when the whole value is JSON.
 */
export function findNonJsonPath(value: unknown): string | undefined {
  const ancestors = new Set<object>();
  const visit = (current: unknown, path: string): string | undefined => {
    try {
      switch (typeof current) {
        case "string":
        case "boolean":
          return undefined;
        case "number":
          return Number.isFinite(current) ? undefined : path;
        case "object":
          break;
        default:
          return path; // undefined, function, symbol, bigint
      }
      if (current === null) return undefined;
      if (ancestors.has(current)) return path; // cycle
      if (hasToJson(current)) return path;
      if (hasIgnoredOwnProperties(current)) return path;
      if (Array.isArray(current)) {
        ancestors.add(current);
        for (let index = 0; index < current.length; index += 1) {
          const item = dataProperty(current, String(index));
          if (item === undefined) return `${path}[${index}]`;
          const found = visit(item.value, `${path}[${index}]`);
          if (found !== undefined) return found;
        }
        ancestors.delete(current);
        return undefined;
      }
      if (!isPlainObject(current)) return path;
      ancestors.add(current);
      for (const key of Object.keys(current)) {
        const property = dataProperty(current, key);
        if (property === undefined) return `${path}.${key}`;
        const found = visit(property.value, `${path}.${key}`);
        if (found !== undefined) return found;
      }
      ancestors.delete(current);
      return undefined;
    } catch {
      // Proxies/accessors can throw during inspection. They cannot be proven
      // JSON-safe, so reject them like any other non-JSON payload.
      return path;
    }
  };
  return visit(value, "$");
}

/** True when `value` survives JSON serialization unchanged. */
export function isJsonValue(value: unknown): value is JsonValue {
  return findNonJsonPath(value) === undefined;
}
