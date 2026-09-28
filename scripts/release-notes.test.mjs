import { describe, expect, it } from "vitest";

import { composeNotes } from "./release-notes.mjs";

it("generates release scope and separate reference rows for both OpenCode families", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "hooknostic-release-notes-"));
  try {
    const output = join(scratch, "notes.md");
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    execFileSync(
      process.execPath,
      [
        join(root, "scripts/release-notes.mjs"),
        "--version",
        "1.0.0-rehearsal.0",
        "--sha",
        sha,
        "--repo",
        "owner/example",
        "--output",
        output,
      ],
      {
        cwd: root,
        env: { ...process.env, GITHUB_TOKEN: "" },
        stdio: "pipe",
      },
    );
    const notes = readFileSync(output, "utf8");
    const { defaultAdapterRegistry } = await import("../packages/cli/dist/index.js");
    const adapter = defaultAdapterRegistry().opencode;
    for (const family of adapter.harnessFamilies) {
      const selected = adapter.resolveTarget({
        id: "opencode",
        version: family.recommendedRange,
        delivery: "project",
        output: ".",
      }).adapter;
      const ranges = selected
        .supportedHarnessVersions()
        .map((range) => `\`${range}\``)
        .join(", ");
      expect(notes).toContain(
        `| ${family.displayName} | \`${family.recommendedRange}\` | ${ranges} | ${family.referenceVersion} |`,
      );
    }
    const highlights = readFileSync(join(root, "docs/release-highlights.md"), "utf8");
    expect(notes.startsWith(highlights.trim().split("\n")[0])).toBe(true);
    expect(notes).toContain("Stop prevention and notification are approximate. Both post a synthetic");
    expect(notes).toContain(`https://github.com/owner/example/blob/${sha}/docs/opencode-families.md`);
    // A release body resolves relative links against /releases/tag/..., so
    // every highlights link must leave absolute, including ../ paths.
    const highlightsSection = notes.slice(0, notes.indexOf("\n## Harness support\n"));
    expect(highlightsSection.match(/\]\((?!https:\/\/)[^)]*\)/g) ?? []).toEqual([]);
    expect(notes).toContain(`https://github.com/owner/example/blob/${sha}/README.md)`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

const TABLE = "| Harness | Range |\n| --- | --- |\n| Fake | `>=1 <2` |";

describe("composeNotes", () => {
  it("keeps direct-to-master commits that native notes would omit", () => {
    const notes = composeNotes({
      harnessTable: TABLE,
      generatedBody: "## What's Changed\n* feat: something by @owner in #12",
      commits: [
        { sha: "a".repeat(40), subject: "feat: something (#12)", body: "" },
        { sha: "b".repeat(40), subject: "fix: direct commit", body: "Long body.\nWith detail." },
      ],
    });
    // The PR-covered commit is not duplicated; the direct one survives with
    // its body foldable.
    expect(notes).toContain("## Harness support");
    expect(notes).toContain("#12");
    expect(notes.match(/feat: something/g)).toHaveLength(1);
    expect(notes).toContain("<details><summary>fix: direct commit (bbbbbbbb)</summary>");
    expect(notes).toContain("Long body.");
  });

  it("escapes html in subjects and bodies", () => {
    const notes = composeNotes({
      harnessTable: TABLE,
      generatedBody: "",
      commits: [{ sha: "c".repeat(40), subject: "fix: <script> & co", body: "a < b" }],
    });
    expect(notes).toContain("fix: &lt;script&gt; &amp; co");
    expect(notes).toContain("a &lt; b");
    expect(notes).not.toContain("<script>");
  });

  it("drops details bodies past the size budget instead of truncating silently", () => {
    const commits = Array.from({ length: 30 }, (_, i) => ({
      sha: String(i).padStart(40, "0"),
      subject: `commit ${i}`,
      body: "x".repeat(5000),
    }));
    const notes = composeNotes({ harnessTable: TABLE, generatedBody: "", commits });
    expect(notes.length).toBeLessThan(125_000);
    expect(notes).not.toContain("<details>");
    expect(notes).toContain("- commit 0 (");
  });

  it("handles the first release (no generated body, all commits direct)", () => {
    const notes = composeNotes({
      harnessTable: TABLE,
      generatedBody: "",
      commits: [{ sha: "d".repeat(40), subject: "chore: initial", body: "" }],
    });
    expect(notes).toContain("## Direct commits");
    expect(notes).toContain("- chore: initial (dddddddd)");
  });

  it("treats merge-commit subjects as covered by the PR they merge", () => {
    const notes = composeNotes({
      harnessTable: TABLE,
      generatedBody: "## What's Changed\n* feat: merged by @owner in #31",
      commits: [
        { sha: "e".repeat(40), subject: "Merge pull request #31 from owner/feature", body: "feat: merged" },
        { sha: "f".repeat(40), subject: "fix: direct commit", body: "" },
      ],
    });
    expect(notes).not.toContain("Merge pull request #31");
    expect(notes).toContain("- fix: direct commit (ffffffff)");
  });

  it("reads PR references from the pull URLs GitHub's generated body uses", () => {
    // generate-notes cites PRs as full URLs, never as bare #N.
    const notes = composeNotes({
      harnessTable: TABLE,
      generatedBody:
        "## What's Changed\n" +
        "* feat: squashed by @owner in https://github.com/owner/example/pull/32\n" +
        "* feat: merged by @owner in https://github.com/owner/example/pull/33",
      commits: [
        { sha: "1".repeat(40), subject: "feat: squashed (#32)", body: "" },
        { sha: "2".repeat(40), subject: "Merge pull request #33 from owner/feature", body: "" },
      ],
    });
    expect(notes.match(/feat: squashed/g)).toHaveLength(1);
    expect(notes).not.toContain("Merge pull request #33");
    expect(notes).not.toContain("## Direct commits");
  });

  it("keeps merge commits whose PR the generated body does not list", () => {
    const notes = composeNotes({
      harnessTable: TABLE,
      generatedBody: "",
      commits: [{ sha: "3".repeat(40), subject: "Merge pull request #34 from owner/feature", body: "" }],
    });
    expect(notes).toContain("## Direct commits");
    expect(notes).toContain("- Merge pull request #34 from owner/feature (33333333)");
  });

  it("counts only each entry's own PR link, not references inside titles", () => {
    const notes = composeNotes({
      harnessTable: TABLE,
      generatedBody:
        "## What's Changed\n" +
        "* docs: cite https://github.com/other/repo/pull/36 by @owner in https://github.com/owner/example/pull/38\n" +
        "* fix: follow up #37 by @owner in https://github.com/owner/example/pull/39",
      commits: [
        { sha: "5".repeat(40), subject: "Merge pull request #36 from owner/one", body: "" },
        { sha: "6".repeat(40), subject: "Merge pull request #37 from owner/two", body: "" },
        { sha: "7".repeat(40), subject: "Merge pull request #38 from owner/three", body: "" },
      ],
    });
    expect(notes).toContain("- Merge pull request #36 from owner/one (55555555)");
    expect(notes).toContain("- Merge pull request #37 from owner/two (66666666)");
    expect(notes).not.toContain("Merge pull request #38");
  });

  it("reads a merge subject's PR number before any trailing (#N)", () => {
    const notes = composeNotes({
      harnessTable: TABLE,
      generatedBody: "## What's Changed\n* feat: merged by @owner in https://github.com/owner/example/pull/40",
      commits: [{ sha: "8".repeat(40), subject: "Merge pull request #40 from owner/feature (#99)", body: "" }],
    });
    expect(notes).not.toContain("Merge pull request #40");
  });

  it("does not reuse the generated body's Other changes category heading", () => {
    const notes = composeNotes({
      harnessTable: TABLE,
      generatedBody:
        "## What's Changed\n### Other changes\n* chore: tidy by @owner in https://github.com/owner/example/pull/35",
      commits: [{ sha: "4".repeat(40), subject: "fix: direct commit", body: "" }],
    });
    expect(notes.match(/Other changes/g)).toHaveLength(1);
    expect(notes).toContain("## Direct commits\n\n- fix: direct commit (44444444)");
  });
});
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
