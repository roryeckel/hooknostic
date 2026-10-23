import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { assertEvidence, assertValidationOnly, githubClient, mergeCandidate } from "./merge-harness-watch.mjs";
import { rewriteRollingRecord, ROLLING_WHAT } from "./record-playback-validation.mjs";

const entry = { harness: "claude", latest: "9.0.1", jump: "patch" };
const outcome = { harness: entry.harness, latest: entry.latest, outcome: "pass" };
const drift = { harness: entry.harness, latest: entry.latest, verdict: "clean", exitCode: "0" };
const profilePath = "packages/adapter-claude/src/profile.ts";
const docPath = "docs/harness-support.md";
const previous = { version: "9.0.0", date: "2026-01-01" };
const next = { version: entry.latest, date: "2026-01-08" };
const profile = rewriteRollingRecord(
  "prefix\n// scheduled-playback:begin\n// scheduled-playback:end\nsuffix\n",
  previous,
);
const updatedProfile = rewriteRollingRecord(profile, next);
const row = ({ version, date }) =>
  `| ${version} | ${date} | live-probe | \`.capture/harness-playback\` | ${ROLLING_WHAT} |`;
const doc = `prefix\n${row(previous)}\nsuffix\n`;
const updatedDoc = `prefix\n${row(next)}\nsuffix\n`;
const change = {
  harness: entry.harness,
  version: entry.latest,
  date: next.date,
  files: [profilePath, docPath],
  beforeProfile: profile,
  afterProfile: updatedProfile,
  beforeDoc: doc,
  afterDoc: updatedDoc,
};

function fixture() {
  let head = "head-a";
  let base = "base-a";
  let behind = false;
  const events = [];
  const client = {
    record: vi.fn(async () => ({ ...outcome, date: next.date })),
    find: vi.fn(async () => [{ number: 10 }]),
    pr: vi.fn(async () => ({
      number: 10,
      state: "open",
      draft: false,
      title: `harness-watch: ${entry.harness} ${entry.latest} playback validation`,
      base: { ref: "master", sha: base, repo: { full_name: "owner/repo" } },
      head: { ref: "harness-watch/claude", sha: head, repo: { full_name: "owner/repo" } },
      mergeable_state: behind ? "behind" : "clean",
    })),
    files: vi.fn(async () => change.files),
    mergeBase: vi.fn(async () => "base-a"),
    content: vi.fn(async (path, sha) =>
      path === profilePath
        ? sha.startsWith("base")
          ? profile
          : updatedProfile
        : sha.startsWith("base")
          ? doc
          : updatedDoc,
    ),
    checks: vi.fn(async () => [{ name: "tests", state: "SUCCESS" }]),
    base: vi.fn(async () => base),
    update: vi.fn(async (_number, sha) => {
      events.push(["update", sha]);
      head = "head-b";
      behind = false;
    }),
    commit: vi.fn(async () => ({ parents: [{ sha: "head-a" }, { sha: "base-a" }] })),
    merge: vi.fn(async (_number, sha) => {
      events.push(["merge", sha]);
      return { merged: true, sha: "merged" };
    }),
  };
  return {
    client,
    events,
    setBehind: () => {
      behind = true;
    },
    moveHead: () => {
      head = "foreign";
    },
    moveBase: () => {
      base = "base-b";
      behind = true;
    },
  };
}

describe("harness-watch merge evidence", () => {
  it("accepts a patch pass without drift and requires clean drift for other jumps or forced runs", () => {
    expect(() => assertEvidence(entry, outcome)).not.toThrow();
    expect(() => assertEvidence({ ...entry, jump: "minor" }, outcome, drift)).not.toThrow();
    expect(() => assertEvidence(entry, outcome, drift, true)).not.toThrow();
    for (const verdict of [
      undefined,
      { ...drift, verdict: "drift" },
      { ...drift, verdict: "inconclusive" },
      { ...drift, latest: "8.0.0" },
      { ...drift, exitCode: "6" },
    ]) {
      expect(() => assertEvidence({ ...entry, jump: "minor" }, outcome, verdict)).toThrow(/drift/);
      expect(() => assertEvidence(entry, outcome, verdict, true)).toThrow(/drift/);
    }
  });

  it.each([
    undefined,
    { ...outcome, latest: "8.0.0" },
    { ...outcome, harness: "codex" },
    { ...outcome, outcome: "playback-failure" },
  ])("holds missing, stale, or failed playback evidence: %j", (value) => {
    expect(() => assertEvidence(entry, value)).toThrow(/playback/);
  });

  it("allows exactly the recorder output and its generated row", () => {
    expect(() => assertValidationOnly(change)).not.toThrow();
    for (const mutation of [
      { files: [...change.files, "scripts/extra.mjs"] },
      { files: ["packages/adapter-codex/src/profile.ts", docPath] },
      { afterProfile: updatedProfile.replace("prefix", "changed range") },
      { afterProfile: updatedProfile.replace('method: "live-probe"', 'method: "captured"') },
      { afterDoc: `${updatedDoc}extra claim\n` },
      { afterDoc: updatedDoc.replace(ROLLING_WHAT, "new capability claim") },
      { version: "9.0.2" },
      { date: undefined },
      { beforeProfile: updatedProfile, beforeDoc: updatedDoc },
    ])
      expect(() => assertValidationOnly({ ...change, ...mutation })).toThrow();
  });

  it("rejects matching profile and document edits with a falsified date", () => {
    for (const date of ["2025-01-01", "2099-12-31"]) {
      expect(() =>
        assertValidationOnly({
          ...change,
          afterProfile: rewriteRollingRecord(profile, { ...next, date }),
          afterDoc: `prefix\n${row({ ...next, date })}\nsuffix\n`,
        }),
      ).toThrow(/date/);
    }
  });
});

describe("serialized protected merges", () => {
  it("holds missing or mismatched trusted recorder evidence", async () => {
    for (const record of [undefined, { ...outcome, date: next.date, latest: "8.0.0" }, { ...outcome, date: "bad" }]) {
      const f = fixture();
      f.client.record.mockResolvedValue(record);
      await expect(mergeCandidate({ entry, client: f.client })).rejects.toThrow(/recorder/);
      expect(f.client.merge).not.toHaveBeenCalled();
    }
  });

  it("retries a prior run's PR using its trusted recorded date", async () => {
    const f = fixture();
    await mergeCandidate({ entry, client: f.client });
    expect(f.client.record).toHaveBeenCalledWith(entry);
    expect(f.client.merge).toHaveBeenCalledWith(10, "head-a");
  });

  it("compares a stale PR against its merge base before updating it", async () => {
    const f = fixture();
    f.moveBase();
    await mergeCandidate({ entry, client: f.client, sleep: async () => {} });
    expect(f.client.mergeBase).toHaveBeenCalledWith("base-b", "head-a");
    expect(f.client.content).not.toHaveBeenCalledWith(docPath, "base-b");
    expect(f.events).toEqual([
      ["update", "head-a"],
      ["merge", "head-b"],
    ]);
  });

  it("updates a stale branch, waits for its fresh checks, then merges the resulting exact head", async () => {
    const f = fixture();
    f.setBehind();
    f.client.checks.mockResolvedValueOnce([{ name: "tests", state: "QUEUED" }]);
    const sleep = vi.fn(async () => {});
    await expect(mergeCandidate({ entry, client: f.client, sleep })).resolves.toContain("merged");
    expect(f.events).toEqual([
      ["update", "head-a"],
      ["merge", "head-b"],
    ]);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(f.client.content).toHaveBeenCalledWith(profilePath, "head-b");
  });

  it("waits for an accepted branch update to become visible before using its checks", async () => {
    const f = fixture();
    f.setBehind();
    const completeUpdate = f.client.update.getMockImplementation();
    f.client.update.mockResolvedValue({ message: "Updating pull request branch" });
    let polls = 0;
    await mergeCandidate({
      entry,
      client: f.client,
      sleep: async () => {
        if (++polls === 2) await completeUpdate(10, "head-a");
      },
    });
    expect(polls).toBe(2);
    expect(f.client.update).toHaveBeenCalledTimes(1);
    expect(f.client.merge).toHaveBeenCalledWith(10, "head-b");
  });

  it("holds manual code added after checks complete", async () => {
    const f = fixture();
    f.client.checks.mockImplementationOnce(async () => {
      f.client.files.mockResolvedValue([...change.files, "scripts/code.mjs"]);
      return [{ state: "SUCCESS" }];
    });
    await expect(mergeCandidate({ entry, client: f.client })).rejects.toThrow(/only/);
    expect(f.client.merge).not.toHaveBeenCalled();
  });

  it("holds a PR retargeted to another branch at the same commit during checks", async () => {
    const f = fixture();
    const readPR = f.client.pr.getMockImplementation();
    f.client.checks.mockImplementationOnce(async () => {
      f.client.pr.mockImplementation(async () => {
        const pr = await readPR();
        return { ...pr, base: { ...pr.base, ref: "other" } };
      });
      return [{ state: "SUCCESS" }];
    });
    await expect(mergeCandidate({ entry, client: f.client })).rejects.toThrow(/identity/);
    expect(f.client.merge).not.toHaveBeenCalled();
  });

  it("holds a contributor push during the final check or during branch update", async () => {
    const f = fixture();
    f.client.checks.mockImplementationOnce(async () => {
      f.moveHead();
      return [{ state: "SUCCESS" }];
    });
    await expect(mergeCandidate({ entry, client: f.client })).rejects.toThrow(/head changed/);
    expect(f.client.merge).not.toHaveBeenCalled();
    const g = fixture();
    g.setBehind();
    g.client.commit.mockResolvedValue({ parents: [{ sha: "foreign" }] });
    await expect(mergeCandidate({ entry, client: g.client, sleep: async () => {} })).rejects.toThrow(/Unexpected head/);
    expect(g.client.merge).not.toHaveBeenCalled();
  });

  it("revisits branch freshness when master advances during checks", async () => {
    const f = fixture();
    f.client.checks.mockImplementationOnce(async () => {
      f.moveBase();
      return [{ state: "SUCCESS" }];
    });
    await mergeCandidate({ entry, client: f.client, sleep: async () => {} });
    expect(f.events).toEqual([
      ["update", "head-a"],
      ["merge", "head-b"],
    ]);
  });

  it.each(["FAILURE", "CANCELLED", "TIMED_OUT", "SKIPPED"])("holds required check state %s", async (state) => {
    const f = fixture();
    f.client.checks.mockResolvedValue([{ name: "tests", state }]);
    await expect(mergeCandidate({ entry, client: f.client })).rejects.toThrow(/checks/);
    expect(f.client.merge).not.toHaveBeenCalled();
  });

  it("times out on missing or pending checks instead of merging", async () => {
    for (const checks of [[], [{ state: "IN_PROGRESS" }]]) {
      const f = fixture();
      f.client.checks.mockResolvedValue(checks);
      await expect(mergeCandidate({ entry, client: f.client, attempts: 2, sleep: async () => {} })).rejects.toThrow(
        /Timed out/,
      );
      expect(f.client.merge).not.toHaveBeenCalled();
    }
  });

  it("waits while only some required checks have been registered", async () => {
    const f = fixture();
    const readPR = f.client.pr.getMockImplementation();
    let blocked = true;
    f.client.pr.mockImplementation(async () => ({
      ...(await readPR()),
      mergeable_state: blocked ? "blocked" : "clean",
    }));
    f.client.checks.mockResolvedValueOnce([{ name: "Renovate artifact readiness", state: "SKIPPED" }]);
    const sleep = vi.fn(async () => {
      expect(f.client.merge).not.toHaveBeenCalled();
      blocked = false;
    });
    await mergeCandidate({ entry, client: f.client, attempts: 3, sleep });
    expect(sleep).toHaveBeenCalledOnce();
    expect(f.client.merge).toHaveBeenCalledOnce();
  });

  it("rechecks protection readiness immediately before merging", async () => {
    const f = fixture();
    const readPR = f.client.pr.getMockImplementation();
    f.client.pr.mockImplementationOnce(readPR).mockImplementationOnce(async () => ({
      ...(await readPR()),
      mergeable_state: "blocked",
    }));
    const sleep = vi.fn(async () => expect(f.client.merge).not.toHaveBeenCalled());
    await mergeCandidate({ entry, client: f.client, attempts: 3, sleep });
    expect(sleep).toHaveBeenCalledOnce();
    expect(f.client.merge).toHaveBeenCalledOnce();
  });

  it("preserves GitHub's refusal instead of bypassing protection", async () => {
    const f = fixture();
    f.client.merge.mockResolvedValue({ merged: false });
    await expect(mergeCandidate({ entry, client: f.client })).rejects.toThrow(/declined/);
    expect(f.client.merge).toHaveBeenCalledWith(10, "head-a");
  });
});

describe("GitHub check startup responses", () => {
  it.each(["no checks reported", "no required checks reported"])("polls after %s", async (message) => {
    const error = Object.assign(new Error(message), {
      status: 1,
      stdout: "",
      stderr: `${message} on the 'harness-watch/claude' branch\n`,
    });
    const run = vi
      .fn()
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockReturnValueOnce(JSON.stringify([{ name: "tests", state: "SUCCESS" }]));
    const f = fixture();
    f.client.checks = githubClient("owner/repo", run).checks;
    const sleep = vi.fn(async () => {});
    await mergeCandidate({ entry, client: f.client, attempts: 3, sleep });
    expect(sleep).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledTimes(2);
    expect(f.client.merge).toHaveBeenCalledOnce();
  });

  it.each(["GraphQL: Resource not accessible", "HTTP 503: Service Unavailable", "not logged in"])(
    "preserves actual CLI errors: %s",
    (message) => {
      const error = Object.assign(new Error(message), { status: 1, stdout: "", stderr: message });
      const client = githubClient("owner/repo", () => {
        throw error;
      });
      expect(() => client.checks(10)).toThrow(error);
    },
  );
});

describe("trusted recorder artifacts", () => {
  const name = `watch-record-${entry.harness}-${entry.latest}`;
  const artifact = { name, expired: false, workflow_run: { id: 20, head_branch: "master" } };
  const workflow = {
    path: ".github/workflows/harness-watch.yml",
    event: "schedule",
    head_branch: "master",
    repository: { full_name: "owner/repo" },
    head_repository: { full_name: "owner/repo" },
  };

  it("retrieves the original date with the read-only evidence token", async () => {
    const record = { harness: entry.harness, latest: entry.latest, date: next.date };
    let directory;
    const run = vi
      .fn(() => "{}")
      .mockReturnValueOnce(JSON.stringify([{ artifacts: [artifact] }]))
      .mockReturnValueOnce(JSON.stringify(workflow))
      .mockImplementationOnce((_command, args) => {
        directory = args[args.indexOf("--dir") + 1];
        writeFileSync(join(directory, `watch-record-${entry.harness}.json`), JSON.stringify(record));
        return "";
      });
    const client = githubClient("owner/repo", run, "read-only-evidence-token");
    expect(await client.record(entry)).toEqual(record);
    expect(run.mock.calls[0][1]).toContain("--paginate");
    for (const [, , options] of run.mock.calls) expect(options.env.GH_TOKEN).toBe("read-only-evidence-token");
    await client.update(10, "head-a");
    expect(run.mock.calls[3][2].env).toBeUndefined();
  });

  it.each([
    { event: "pull_request" },
    { path: ".github/workflows/ci.yml" },
    { head_branch: "contributor" },
    { head_repository: { full_name: "fork/repo" } },
  ])("ignores artifacts from an untrusted workflow run: %j", async (mutation) => {
    const run = vi
      .fn()
      .mockReturnValueOnce(JSON.stringify([{ artifacts: [artifact] }]))
      .mockReturnValueOnce(JSON.stringify({ ...workflow, ...mutation }));
    expect(await githubClient("owner/repo", run).record(entry)).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("ignores expired artifacts", async () => {
    const run = vi.fn(() => JSON.stringify([{ artifacts: [{ ...artifact, expired: true }] }]));
    expect(await githubClient("owner/repo", run).record(entry)).toBeUndefined();
    expect(run).toHaveBeenCalledOnce();
  });
});

it("uses expected SHAs for GitHub updates and squash merges, and paginates changed files", async () => {
  const run = vi.fn(() => "{}");
  const client = githubClient("owner/repo", run);
  await client.update(10, "before-update");
  expect(JSON.parse(run.mock.calls[0][2].input)).toEqual({ expected_head_sha: "before-update" });
  await client.merge(10, "reviewed-head");
  expect(JSON.parse(run.mock.calls[1][2].input)).toEqual({ sha: "reviewed-head", merge_method: "squash" });
  run.mockReturnValueOnce(JSON.stringify([[{ filename: "one" }], [{ filename: "two" }]]));
  expect(await client.files(10)).toEqual(["one", "two"]);
  expect(run.mock.calls[2][1]).toContain("--paginate");
});
