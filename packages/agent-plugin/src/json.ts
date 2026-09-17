/**
 * Decoding shared by everything that reads an inventoried or generated file.
 * Package files and build artifacts carry their contents as either text or
 * UTF-8 bytes, and every reader used to spell the same ternary; a document
 * that has to be a JSON object was parsed and checked in as many ways.
 */

/** The text of a file whose contents may be a string or UTF-8 bytes. */
export function contentsText(input: string | Uint8Array): string {
  return typeof input === "string" ? input : new TextDecoder().decode(input);
}

/** Whether `value` is a JSON object: not null and not an array. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ParsedJsonObject = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/**
 * Parse a document that must be a JSON object.
 *
 * The error is a clause that follows the document's name -- `<file> is not
 * valid JSON: ...`, `<file> is not a JSON object` -- so a caller reports it
 * against the file the author wrote, in whichever way it reports: as an issue
 * on a projection plan, or thrown with a label.
 */
export function parseJsonObject(input: string | Uint8Array): ParsedJsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentsText(input));
  } catch (error) {
    return { ok: false, error: `is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  return isJsonObject(parsed) ? { ok: true, value: parsed } : { ok: false, error: "is not a JSON object" };
}
