import { describe, expect, it } from "vitest";
import { composeNotes } from "./release-notes.mjs";

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
