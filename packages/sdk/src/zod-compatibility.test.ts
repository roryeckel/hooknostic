import { expect, it } from "vitest";
import { z as v3 } from "zod/v3";
import { z as v4 } from "zod/v4";

import { toolInvocationSchema } from "./index.js";

it("keeps exported schemas composable with the Zod 3 API and error format", () => {
  const schema = v3.object({ tool: toolInvocationSchema.extend({ label: v3.string() }) });
  expect(toolInvocationSchema).toBeInstanceOf(v3.ZodObject);
  expect(schema.parse({ tool: { kind: "other", nativeName: "probe", input: null, label: "ok" } }).tool.label).toBe(
    "ok",
  );

  const parsed = schema.safeParse({ tool: { kind: "other", nativeName: "probe", input: null, label: 1 } });
  expect(parsed.success).toBe(false);
  if (parsed.success) throw new Error("invalid label was accepted");
  expect(parsed.error).toBeInstanceOf(v3.ZodError);
  expect(parsed.error.errors).toBe(parsed.error.issues);
  expect(parsed.error.issues).toContainEqual(
    expect.objectContaining({ code: "invalid_type", expected: "string", received: "number", path: ["tool", "label"] }),
  );
});

// The advisory fixes the V4 parser shipped in the dependency, while the SDK's
// exported schema API stays on the package's supported V3 compatibility entry.
it.each(["max", "length"] as const)("rejects an oversized V4 array's %s bound before parsing its elements", (bound) => {
  let visits = 0;
  const element = v4.preprocess((value) => {
    visits++;
    return value;
  }, v4.number());
  const schema = v4.array(element)[bound](2);
  const parsed = schema.safeParse(Array.from({ length: 8 }, () => "invalid"));
  expect(parsed.success).toBe(false);
  expect(visits).toBe(0);
  if (parsed.success) throw new Error("oversized array was accepted");
  expect(parsed.error.issues).toEqual([expect.objectContaining({ code: "too_big" })]);
});
