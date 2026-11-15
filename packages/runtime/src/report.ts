// No Node-only imports: in-process shims bundle this module.

/** Convert an arbitrary thrown value without letting hostile proxies escape dispatch. */
export function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error) {
      return typeof error.message === "string" ? error.message : "Error";
    }
  } catch {
    // `instanceof` and property reads can both invoke hostile proxy traps.
  }

  try {
    return String(error);
  } catch {
    return "uninspectable thrown value";
  }
}

/** Whether `HOOKNOSTIC_DEBUG` is set to a non-empty value other than `0`. */
export function debugEnabled(env: Record<string, string | undefined> | undefined = globalThis.process?.env): boolean {
  const flag = env?.["HOOKNOSTIC_DEBUG"];
  return flag !== undefined && flag !== "" && flag !== "0";
}

/**
 * One line naming a Hooknostic defect -- an error the shim itself raised, not
 * a hook's -- and the native hook it interrupted, with the error's stack on
 * the lines after it when `stack` is set. It carries no HN code: those name
 * problems a hook author can act on.
 */
export function formatInternalError(error: unknown, options: { hook?: string; stack?: boolean } = {}): string {
  const line = `hooknostic internal${options.hook ? ` [${options.hook}]` : ""}: ${errorMessage(error)}`;
  if (!options.stack) return line;
  try {
    const stack = error instanceof Error ? error.stack : undefined;
    return typeof stack === "string" && stack !== "" ? `${line}\n${stack}` : line;
  } catch {
    // The same hostile values errorMessage tolerates.
    return line;
  }
}

/**
 * Report an internal error from a shim that is failing open over it. Never
 * throws: a report that failed would turn the fail-open path into a failure.
 * Not deduplicated, like handler errors (ADR-0002).
 */
export function reportInternalError(
  error: unknown,
  hook?: string,
  write: (line: string) => void = (line) => console.error(line),
): void {
  try {
    write(formatInternalError(error, { ...(hook !== undefined ? { hook } : {}), stack: debugEnabled() }));
  } catch {
    // Nowhere left to report it.
  }
}
