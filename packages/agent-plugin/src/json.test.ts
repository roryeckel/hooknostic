import { describe, expect, it } from "vitest";

import { contentsText, parseJsonObject } from "./json.js";

describe("contentsText", () => {
  it("returns text as is and decodes bytes as UTF-8", () => {
    expect(contentsText("plain")).toBe("plain");
    expect(contentsText(new TextEncoder().encode("café"))).toBe("café");
  });
});

describe("parseJsonObject", () => {
  it("accepts an object from text or bytes", () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonObject(new TextEncoder().encode('{"a":1}'))).toEqual({ ok: true, value: { a: 1 } });
  });

  it("rejects valid JSON that is not an object, in a clause that follows the file name", () => {
    // Arrays and scalars parse; every caller needs a keyed document, and the
    // error reads as `<file> is not a JSON object`.
    expect(parseJsonObject("[]")).toEqual({ ok: false, error: "is not a JSON object" });
    expect(parseJsonObject("null")).toEqual({ ok: false, error: "is not a JSON object" });
    expect(parseJsonObject('"text"')).toEqual({ ok: false, error: "is not a JSON object" });
  });

  it("reports malformed JSON with the parser's reason rather than throwing", () => {
    const parsed = parseJsonObject("{ not json");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/^is not valid JSON: /);
  });
});
