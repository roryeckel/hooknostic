/**
 * Print an opt-in test's diagnostic output straight to the worker's stderr.
 * Vitest's reporter hides a passing test's `console` output in some
 * environments (the minimal reporter, chosen when it detects a coding agent);
 * the worker's stderr reaches the terminal under every reporter (#263).
 */
export function report(text: string): void {
  process.stderr.write(`${text}\n`);
}
