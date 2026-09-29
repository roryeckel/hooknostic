import { describe, expect, it } from "vitest";

import { readProjectToml, renderTomlDocument } from "./project-toml.js";

describe("renderTomlDocument", () => {
  it("writes prose as a readable multi-line string that parses back exactly", () => {
    const instructions = 'Quote "this", keep C:\\path, a tab\there,\nand """ triple quotes.\nlast line\n';
    const text = renderTomlDocument({ name: "reviewer", developer_instructions: instructions });

    expect(text).toBe(
      'name = "reviewer"\n' +
        'developer_instructions = """\nQuote \\"this\\", keep C:\\\\path, a tab\there,\nand \\"\\"\\" triple quotes.\nlast line\n"""\n',
    );
    expect(readProjectToml(text)).toEqual({ name: "reviewer", developer_instructions: instructions });
  });

  it("escapes every control character TOML forbids, DEL included", () => {
    const value = "bell\u0007 delete\u007f carriage\r";
    const text = renderTomlDocument({ value, multi: `${value}\nsecond` });

    for (const raw of ["\u0007", "\u007f", "\r"]) expect(text).not.toContain(raw);
    expect(readProjectToml(text)).toEqual({ value, multi: `${value}\nsecond` });
  });

  it("writes nested values as inline tables and arrays, quoting keys that need it", () => {
    const fields = {
      model: "gpt-probe",
      nested: { enabled: true, "dotted.key": 3, list: [1, 2.5, "three"], empty: {} },
    };
    const text = renderTomlDocument(fields);

    expect(text).toContain('nested = { enabled = true, "dotted.key" = 3, list = [1, 2.5, "three"], empty = {} }');
    expect(readProjectToml(text)).toEqual(fields);
  });

  it.each([
    ["null", { value: null }, "value is null"],
    ["a non-finite number", { value: Number.NaN }, "not a finite number"],
    ["a nested undefined", { table: { value: undefined } }, "table.value is undefined"],
  ])("refuses %s, which TOML cannot hold", (_label, fields, message) => {
    expect(() => renderTomlDocument(fields)).toThrow(message);
  });
});
