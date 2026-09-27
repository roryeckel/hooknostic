// Release-notes composition: three sections into one body.
//
//   1. Harness support table -- the part a consumer of this project actually
//      needs ("which harness versions does this release work against"),
//      generated from the adapter metadata. No generic tool produces it.
//   2. PR-grouped section -- GitHub's own generate-notes API output, taken as
//      text so composition is deterministic.
//   3. Other changes -- direct-to-master commits (allowed in this repo, and
//      their long-form bodies are load-bearing) that native notes silently
//      omit: every first-parent commit in range not already covered by a PR
//      reference in section 2, rendered as a bullet with a <details> body.
//
// The composition is a pure function (composeNotes) with a unit test; the CLI
// wrapper gathers the inputs. Usage (from the draft-release workflow):
//
//   node scripts/release-notes.mjs --version 0.2.0 --sha <sha> \
//     [--previous-tag v0.1.0] --repo owner/name --output body.md
//
// Requires GITHUB_TOKEN for the generate-notes API call; without it (local
// dry runs) section 2 is a placeholder and the script says so.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./is-main-module.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// GitHub caps release bodies at 125k characters; past the budget, drop the
// <details> bodies rather than truncating silently.
const BODY_BUDGET = 120_000;

function escapeHtml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * @param {object} input
 * @param {string} [input.highlights] curated scope and migration notes for this release
 * @param {string} input.harnessTable  markdown table of harness support
 * @param {string} input.generatedBody GitHub generate-notes markdown ("" if unavailable)
 * @param {{sha: string, subject: string, body: string}[]} input.commits first-parent commits, newest first
 * @returns {string}
 */
export function composeNotes({ highlights = "", harnessTable, generatedBody, commits }) {
  // A commit already grouped under a PR in the generated body is covered;
  // match by the (#N) reference GitHub appends to squash/merge subjects.
  const covered = new Set([...generatedBody.matchAll(/#(\d+)/g)].map((match) => match[1]));
  const direct = commits.filter((commit) => {
    const ref = commit.subject.match(/\(#(\d+)\)\s*$/);
    return ref === null || !covered.has(ref[1]);
  });

  const render = (withBodies) => {
    const parts = [
      ...(highlights.trim() ? [highlights.trim(), ""] : []),
      "## Harness support",
      "",
      harnessTable.trim(),
      "",
    ];
    if (generatedBody.trim() !== "") {
      parts.push(generatedBody.trim(), "");
    }
    if (direct.length > 0) {
      parts.push("## Other changes", "");
      for (const commit of direct) {
        const subject = escapeHtml(commit.subject);
        const body = commit.body.trim();
        if (withBodies && body !== "") {
          parts.push(
            `<details><summary>${subject} (${commit.sha.slice(0, 8)})</summary>`,
            "",
            escapeHtml(body),
            "</details>",
            "",
          );
        } else {
          parts.push(`- ${subject} (${commit.sha.slice(0, 8)})`);
        }
      }
      parts.push("");
    }
    return parts.join("\n");
  };

  const full = render(true);
  return full.length > BODY_BUDGET ? render(false) : full;
}

export function commitsInRange(range, cwd = ROOT) {
  // %x1f field / %x1e record separators dodge every quoting hazard in bodies.
  const raw = execFileSync("git", ["log", "--first-parent", "--format=%H%x1f%s%x1f%b%x1e", range], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return raw
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, subject, body] = record.split("\x1f");
      return { sha, subject, body: body ?? "" };
    });
}

async function main() {
  const args = new Map();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) args.set(argv[i], argv[i + 1]);
  const version = args.get("--version");
  const sha = args.get("--sha");
  const previousTag = args.get("--previous-tag");
  const repo = args.get("--repo");
  const output = args.get("--output") ?? "release-notes.md";
  if (!version || !sha) {
    console.error(
      "usage: release-notes.mjs --version X.Y.Z --sha <sha> [--previous-tag vA.B.C] --repo owner/name [--output file]",
    );
    process.exit(2);
  }

  // Section 1: reuse the generated support table's summary block.
  const { defaultAdapterRegistry } = await import(new URL("../packages/cli/dist/index.js", import.meta.url).href);
  const adapters = Object.values(defaultAdapterRegistry()).flatMap((adapter) =>
    adapter.harnessFamilies
      ? adapter.harnessFamilies.map(
          (harness) =>
            adapter.resolveTarget({
              id: adapter.id,
              version: harness.recommendedRange,
              delivery: "project",
              output: ".",
            }).adapter,
        )
      : [adapter],
  );
  const harnessTable = [
    "| Harness | Recommended target range | Validated ranges | Reference build |",
    "| --- | --- | --- | --- |",
    ...adapters.map(
      (adapter) =>
        `| ${adapter.harness.displayName} | \`${adapter.harness.recommendedRange}\` | ` +
        `${adapter
          .supportedHarnessVersions()
          .map((r) => `\`${r}\``)
          .join(", ")} | ` +
        `${adapter.harness.referenceVersion} |`,
    ),
  ].join("\n");

  // Section 2: GitHub's generate-notes, as text.
  let generatedBody = "";
  const token = process.env.GITHUB_TOKEN;
  if (token && repo) {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/generate-notes`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        tag_name: `v${version}`,
        target_commitish: sha,
        ...(previousTag ? { previous_tag_name: previousTag } : {}),
      }),
    });
    if (!response.ok) {
      console.error(`generate-notes API failed: ${response.status} ${await response.text()}`);
      process.exit(1);
    }
    generatedBody = (await response.json()).body ?? "";
  } else {
    console.error("no GITHUB_TOKEN/--repo: skipping the PR-grouped section (local dry run)");
  }

  // Section 3 inputs.
  const range = previousTag ? `${previousTag}..${sha}` : sha;
  const commits = commitsInRange(range);

  const highlights = readFileSync(resolve(ROOT, "docs/release-highlights.md"), "utf8").replaceAll(
    /\]\(([\w/-]+\.md(?:#[\w-]+)?)\)/g,
    (_, path) => (repo ? `](https://github.com/${repo}/blob/${sha}/docs/${path})` : `](docs/${path})`),
  );
  const body = composeNotes({ highlights, harnessTable, generatedBody, commits });
  writeFileSync(resolve(ROOT, output), body, "utf8");
  console.log(`release notes written to ${output} (${body.length} chars, ${commits.length} commits in range)`);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await main();
}
