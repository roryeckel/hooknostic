import { expect, it } from "vitest";
import { z } from "zod/v4";

import { baseHookEventSchema, runtimePolicySchema, toolInvocationSchema } from "./index.js";

it("exports native Zod 4 schemas composable with the consumer's schemas and errors", () => {
  expect(toolInvocationSchema).toBeInstanceOf(z.ZodObject);
  const schema = z.object({ tool: toolInvocationSchema.extend({ label: z.string() }) });
  expect(schema.parse({ tool: { kind: "other", nativeName: "probe", input: null, label: "ok" } }).tool.label).toBe(
    "ok",
  );

  const parsed = schema.safeParse({ tool: { kind: "other", nativeName: "probe", input: null, label: 1 } });
  expect(parsed.success).toBe(false);
  if (parsed.success) throw new Error("invalid label was accepted");
  expect(parsed.error).toBeInstanceOf(z.ZodError);
  expect(parsed.error).not.toHaveProperty("errors");
  expect(parsed.error.issues).toContainEqual(
    expect.objectContaining({ code: "invalid_type", expected: "string", path: ["tool", "label"] }),
  );
});

it.each([
  ["input", toolInvocationSchema, { kind: "other", nativeName: "probe" }],
  [
    "raw",
    baseHookEventSchema,
    {
      schemaVersion: 1,
      event: "tool.before",
      harness: { id: "fake", nativeEvent: "fake.before" },
      session: { cwd: "/repo" },
      correlation: {},
    },
  ],
] as const)("requires the %s key while accepting an explicitly undefined payload", (key, schema, envelope) => {
  expect(schema.safeParse(envelope).success).toBe(false);
  expect(schema.safeParse({ ...envelope, [key]: undefined }).success).toBe(true);
  expect(schema.parse({ ...envelope, [key]: null })).toEqual({ ...envelope, [key]: null });
});

it("rejects unsafe integer character limits under the V4 integer contract", () => {
  expect(runtimePolicySchema.safeParse({ contextCharLimit: Number.MAX_SAFE_INTEGER }).success).toBe(true);
  expect(runtimePolicySchema.safeParse({ contextCharLimit: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
});

it.each(["max", "length"] as const)("rejects an oversized V4 array's %s bound before parsing its elements", (bound) => {
  let visits = 0;
  const element = z.preprocess((value) => {
    visits++;
    return value;
  }, z.number());
  const schema = z.array(element)[bound](2);
  const parsed = schema.safeParse(Array.from({ length: 8 }, () => "invalid"));
  expect(parsed.success).toBe(false);
  expect(visits).toBe(0);
  if (parsed.success) throw new Error("oversized array was accepted");
  expect(parsed.error.issues).toEqual([expect.objectContaining({ code: "too_big" })]);
});
