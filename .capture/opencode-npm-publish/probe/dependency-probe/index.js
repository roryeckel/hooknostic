import { writeFileSync } from "node:fs";

// Findings rest on this marker, not on log lines: a harness that prints
// "installed" is not evidence that a module resolves.
async function resolves(specifier) {
  try {
    await import(specifier);
    return true;
  } catch {
    return false;
  }
}

export const ProbePlugin = async () => {
  const marker = process.env.HOOKNOSTIC_PROBE_MARKER;
  const record = {
    loadedFrom: import.meta.url,
    shipped: "1.0.1",
    resolved: {
      // Declared in this package's own dependencies.
      "is-number": await resolves("is-number"),
      // Negative control: declared nowhere, must be false, or the check
      // discriminates nothing.
      "hooknostic-absent-control": await resolves("hooknostic-absent-control"),
    },
  };
  if (marker) writeFileSync(marker, JSON.stringify(record, null, 2));
  return {};
};

export default ProbePlugin;
