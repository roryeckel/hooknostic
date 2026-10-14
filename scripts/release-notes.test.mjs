import { describe, expect, it } from "vitest";

import { composeNotes, unwrapProse } from "./release-notes.mjs";

it("embeds current release highlights and separate reference rows for both OpenCode families", async () => {
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
        "--previous-tag",
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
    // A release body resolves relative links against /releases/tag/..., so
    // every highlights link must leave absolute, including ../ paths.
    const highlightsSection = notes.slice(0, notes.indexOf("\n## Harness support\n"));
    // Check all curated prose without tying the release gate to an older announcement.
    const prose = (text) =>
      text
        .replace(/\]\([^)]+\)/g, "]")
        .replace(/\s+/g, " ")
        .trim();
    expect(prose(highlightsSection)).toBe(prose(highlights));
    expect(highlightsSection.match(/\]\((?!https:\/\/)[^)]*\)/g) ?? []).toEqual([]);
    expect(notes).toContain(`https://github.com/owner/example/blob/${sha}/README.md)`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

const TABLE = "| Harness | Range |\n| --- | --- |\n| Fake | `>=1 <2` |";

describe("release prose wrapping", () => {
  it.each([
    ["", "-", "```"],
    ["", "10.", "~~~"],
    ["- Parent\n", "  -", "```"],
  ])("preserves a fence starting the list item %j %j %j", (prefix, marker, fence) => {
    const indent = " ".repeat(marker.length + 1);
    const block = `${prefix}${marker} ${fence}sh\n${indent}echo one\n${indent}echo two\n${indent}${fence}`;
    const source = `# Highlights\n\n${block}\n\nFollowing\nprose.\n`;
    const expected = `# Highlights\n\n${block}\n\nFollowing prose.\n`;
    expect(unwrapProse(source)).toBe(expected);
    expect(composeNotes({ highlights: source, harnessTable: TABLE, generatedBody: "", commits: [] })).toContain(
      expected.trim(),
    );
  });

  it.each([
    ["", "    ", "-"],
    ["", "\t", "1."],
    ["- Item\n\n", "      ", "-"],
  ])("preserves indented code beginning with a list marker %j %j %j", (prefix, indent, marker) => {
    const block = `${prefix}${indent}${marker} name: foo\n${indent}  value: bar`;
    const source = `# Highlights\n\n${block}\n\nFollowing\nprose.\n`;
    const expected = `# Highlights\n\n${block}\n\nFollowing prose.\n`;
    expect(unwrapProse(source)).toBe(expected);
    expect(composeNotes({ highlights: source, harnessTable: TABLE, generatedBody: "", commits: [] })).toContain(
      expected.trim(),
    );
  });

  it("keeps a fence marker literal when a list item starts with indented code", () => {
    const block = "-     ```sh\n      echo one\n      echo two";
    const source = `# Highlights\n\n${block}\n\nFollowing\nprose.\n`;
    const expected = `# Highlights\n\n${block}\n\nFollowing prose.\n`;
    expect(unwrapProse(source)).toBe(expected);
    expect(composeNotes({ highlights: source, harnessTable: TABLE, generatedBody: "", commits: [] })).toContain(
      expected.trim(),
    );
  });

  it("preserves escaped brackets in reference labels", () => {
    const definition = '[a\\]b]: /url\n  "Title"';
    expect(unwrapProse(`${definition}\nFollowing\nprose with [a\\]b].\n`)).toBe(
      `${definition}\nFollowing prose with [a\\]b].\n`,
    );
  });

  it("treats a backtick in a backtick-fence info string as prose", () => {
    expect(unwrapProse("``` js`\nFollowing\nprose.\n")).toBe("``` js` Following prose.\n");
  });

  it("retains list containers across lazy paragraph continuations", () => {
    const source = "10. item\nlazy continuation\n    ```text\n    one\n    two\n    ```\n\nFollowing\nprose.\n";
    expect(unwrapProse(source)).toBe(
      "10. item lazy continuation\n    ```text\n    one\n    two\n    ```\n\nFollowing prose.\n",
    );
  });

  it.each([
    '[foo]: /url\n  "Title"',
    '[foo]:\n  /url\n  "Title"',
    "[foo]:\n  /url",
    '[foo]: /url "Multi\n  line title"',
    "[foo]: /url\n  'Multi\n  line title'",
    "[foo]: /url\n  (Multi\n  line title)",
  ])("preserves the reference definition %j", (definition) => {
    expect(unwrapProse(`${definition}\nFollowing\nprose with [foo].\n`)).toBe(
      `${definition}\nFollowing prose with [foo].\n`,
    );
  });

  it.each(["    ", "\t"])("keeps %j-indented fence markers inside top-level code", (indent) => {
    const block = `\`\`\`text\none\n${indent}\`\`\`\ntwo\nthree\n\`\`\``;
    expect(unwrapProse(`${block}\n\nFollowing\nprose.\n`)).toBe(`${block}\n\nFollowing prose.\n`);
  });

  it("measures closing fence indentation inside its list container", () => {
    const block = "- Item\n\n  ```text\n  one\n      ```\n  two\n  three\n     ```";
    expect(unwrapProse(`${block}\n\nFollowing\nprose.\n`)).toBe(`${block}\n\nFollowing prose.\n`);
  });

  it.each([
    ["<pre>", "</pre>"],
    ["<SCRIPT>", "</SCRIPT>"],
    ["<style>", "</style>"],
    ["<textarea>", "</textarea>"],
    ["<!--", "-->"],
    ["<?processing", "?>"],
    ["<!DECLARATION", ">"],
    ["<![CDATA[", "]]>"],
  ])("preserves blank lines until the terminator of %s", (opening, closing) => {
    const block = `${opening}\none\n\ntwo\nthree\n${closing}`;
    expect(unwrapProse(`${block}\nFollowing\nprose.\n`)).toBe(`${block}\nFollowing prose.\n`);
  });

  it("ends single-line raw HTML at its terminator and generic HTML at a blank", () => {
    expect(unwrapProse("<!-- comment -->\nFollowing\nprose.\n\n<div>\none\ntwo\n\nMore\nprose.\n")).toBe(
      "<!-- comment -->\nFollowing prose.\n\n<div>\none\ntwo\n\nMore prose.\n",
    );
  });

  it("joins prose continuations within paragraphs and list items", () => {
    const source =
      "# Highlights\n\nA paragraph that\nwraps in source.\n\n- First item that\n  continues here.\n- Next item\n  with a [link](https://example.com).\n\nAnother paragraph.\n";
    const expected =
      "# Highlights\n\nA paragraph that wraps in source.\n\n- First item that continues here.\n- Next item with a [link](https://example.com).\n\nAnother paragraph.\n";
    expect(unwrapProse(source)).toBe(expected);
    expect(composeNotes({ highlights: source, harnessTable: TABLE, generatedBody: "", commits: [] })).toContain(
      expected.trim(),
    );
  });

  it("preserves nested lists, fenced code, tables, headings and intentional breaks", () => {
    const source =
      "## Structure\n\n- Parent item\n  - Nested item\n    continues here.\n  - Next child\n\n```yaml\nmetadata:\n  setting: false\n```\n\n~~~~text\none\n~~~\ntwo\n~~~~\n\n| Name | Value |\n| --- | --- |\n| One | Two |\n\nName | Value\n--- | ---\nOne | Two\n\n    indented code\n    stays separate\n\nLine with a break  \nNext line\\\nFinal line\n\n> A quotation\n> on two lines\n\n<div>\nraw HTML\n</div>\n\n---\n";
    expect(unwrapProse(source)).toBe(
      source.replace("  - Nested item\n    continues here.", "  - Nested item continues here."),
    );
  });
});

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

  it("drops merge commits for PRs the generated body excludes", () => {
    // release.yml excludes `release` and `skip-changelog` PRs; their merge
    // commits must not resurface as direct commits.
    const notes = composeNotes({
      harnessTable: TABLE,
      generatedBody: "## What's Changed\n* feat: listed by @owner in https://github.com/owner/example/pull/41",
      commits: [
        { sha: "9".repeat(40), subject: "Merge pull request #42 from owner/release/v1.0.0", body: "chore: release" },
        { sha: "0".repeat(40), subject: "fix: direct commit", body: "" },
      ],
    });
    expect(notes).not.toContain("Merge pull request #42");
    expect(notes).toContain("- fix: direct commit (00000000)");
  });

  it("keeps merge commits when no generated body is available", () => {
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
        { sha: "5".repeat(40), subject: "fix: one (#36)", body: "" },
        { sha: "6".repeat(40), subject: "fix: two (#37)", body: "" },
        { sha: "7".repeat(40), subject: "fix: three (#38)", body: "" },
      ],
    });
    expect(notes).toContain("- fix: one (#36) (55555555)");
    expect(notes).toContain("- fix: two (#37) (66666666)");
    expect(notes).not.toContain("fix: three");
  });

  it("recognizes a merge subject despite a trailing (#N)", () => {
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
