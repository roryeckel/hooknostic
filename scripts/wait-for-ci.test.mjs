import { expect, it, vi } from "vitest";

import { ciState, waitForCI } from "./wait-for-ci.mjs";

const run = (fields = {}) => ({
  id: 1,
  run_number: 1,
  run_attempt: 1,
  head_sha: "target",
  event: "push",
  path: ".github/workflows/ci.yml",
  status: "completed",
  conclusion: "success",
  ...fields,
});

it("accepts only successful CI push runs at the exact SHA and ignores the release's own pending check", () => {
  expect(ciState([], "target")).toBe("pending");
  for (const fields of [
    { head_sha: "other" },
    { event: "pull_request" },
    { path: ".github/workflows/release-draft.yml" },
  ])
    expect(ciState([run(fields)], "target")).toBe("pending");
  expect(ciState([run(), run({ path: ".github/workflows/release-draft.yml", status: "in_progress" })], "target")).toBe(
    "success",
  );
});

it("waits for pending CI and rejects failed, skipped, neutral, and cancelled CI", () => {
  expect(ciState([run({ status: "in_progress" })], "target")).toBe("pending");
  for (const conclusion of ["failure", "cancelled", "skipped", "neutral", "timed_out", null])
    expect(ciState([run({ conclusion })], "target")).toBe("failed");
});

it("uses the newest run and its latest attempt instead of an older success or failure", () => {
  expect(ciState([run(), run({ id: 2, run_number: 2, status: "queued" })], "target")).toBe("pending");
  expect(ciState([run({ conclusion: "failure" }), run({ run_attempt: 2 })], "target")).toBe("success");
  expect(ciState([run(), run({ run_attempt: 2, conclusion: "failure" })], "target")).toBe("failed");
});

it("polls boundedly, stops on success/failure, and propagates API errors", async () => {
  const sleep = vi.fn();
  const log = vi.fn();
  const query = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([run({ status: "queued" })])
    .mockResolvedValue([run()]);
  await waitForCI({ repo: "owner/repo", sha: "target", query, sleep, log });
  expect(query).toHaveBeenCalledTimes(3);
  expect(sleep).toHaveBeenCalledTimes(2);
  await expect(
    waitForCI({ repo: "owner/repo", sha: "target", attempts: 2, query: async () => [], sleep, log }),
  ).rejects.toThrow("Timed out");
  await expect(
    waitForCI({ repo: "owner/repo", sha: "target", query: async () => [run({ conclusion: "failure" })], sleep, log }),
  ).rejects.toThrow("CI failed");
  await expect(
    waitForCI({
      repo: "owner/repo",
      sha: "target",
      query: async () => {
        throw new Error("API denied");
      },
      sleep,
      log,
    }),
  ).rejects.toThrow("API denied");
});
