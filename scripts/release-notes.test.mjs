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
    expect(notes).toContain("## Other changes");
    expect(notes).toContain("- chore: initial (dddddddd)");
  });
});
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
