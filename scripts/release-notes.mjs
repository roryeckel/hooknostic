// Release-notes composition: three sections into one body.
//
//   1. Harness support table -- the part a consumer of this project actually
//      needs ("which harness versions does this release work against"),
//      generated from the adapter metadata. No generic tool produces it.
//   2. PR-grouped section -- GitHub's own generate-notes API output, taken as
//      text so composition is deterministic.
//   3. Direct commits -- direct-to-master commits (allowed in this repo, and
//      their long-form bodies are load-bearing) that native notes silently
//      omit: every first-parent commit in range that is neither a PR merge
//      commit nor a squash commit whose PR section 2 lists, rendered as a
//      bullet with a <details> body. Without section 2 (local dry runs), PR
//      merge commits stay too.
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
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./is-main-module.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// GitHub caps release bodies at 125k characters; past the budget, drop the
// <details> bodies rather than truncating silently.
const BODY_BUDGET = 120_000;

function escapeHtml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function unwrapProse(markdown) {
  // Release bodies render source newlines as <br>. Join prose, leaving structural blocks verbatim.
  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/);
  const output = [];
  let prose = null;
  const listContainers = [];
  let fence = null;
  let html = null;
  let table = false;
  const flush = () => {
    if (prose !== null) output.push(prose);
    prose = null;
  };
  const tableSeparator = (line) => /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/.test(line);
  const columns = (whitespace) =>
    [...whitespace].reduce((column, char) => column + (char === "\t" ? 4 - (column % 4) : 1), 0);
  const openingFence = (line) => {
    const opening = line.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
    return opening?.[1][0] === "`" && opening[2].includes("`") ? null : opening;
  };
  // CommonMark HTML types 1–5 end at a terminator; types 6–7 end at a blank line.
  const htmlTerminator = (line) => {
    if (/^\s*<(?:script|pre|style|textarea)(?:[ \t>]|$)/i.test(line)) return /<\/(?:script|pre|style|textarea)>/i;
    if (/^\s*<!--/.test(line)) return /-->/;
    if (/^\s*<\?/.test(line)) return /\?>/;
    if (/^\s*<![A-Z]/i.test(line)) return />/;
    if (/^\s*<!\[CDATA\[/.test(line)) return /\]\]>/;
    return null;
  };
  // A destination and a title may start on following lines; title text may span lines.
  const referenceEnd = (start, remainder) => {
    let end = start;
    if (remainder.trim() === "") remainder = lines[++end] ?? "";
    const destination = remainder.trimStart().match(/^(<[^<>]*>|(?:\\.|[^\s])+)(?:[ \t]+(.*))?$/);
    if (!destination) return start;
    let title = destination[2] ?? "";
    let titleStart = end;
    if (title.trim() === "") {
      title = (lines[end + 1] ?? "").trimStart();
      titleStart++;
    }
    const delimiter = { '"': '"', "'": "'", "(": ")" }[title[0]];
    if (!delimiter) return end;
    for (let index = titleStart; index < lines.length; index++) {
      const text = index === titleStart ? title.slice(1) : lines[index];
      if (text.trim() === "" && index !== titleStart) break;
      for (let char = 0; char < text.length; char++) {
        if (text[char] === "\\") char++;
        else if (text[char] === delimiter) return text.slice(char + 1).trim() === "" ? index : end;
      }
    }
    return end;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (fence !== null) {
      output.push(line);
      const closing = line.match(new RegExp(`^([ \\t]*)${fence.marker}{${fence.length},}[ \\t]*$`));
      const indent = closing ? columns(closing[1]) - fence.containerIndent : -1;
      if (indent >= 0 && indent <= 3) fence = null;
      continue;
    }
    if (html !== null) {
      if (html.terminator !== null || line.trim() !== "") {
        output.push(line);
        if (html.terminator?.test(line)) html = null;
        continue;
      }
      html = null;
    }
    if (line.trim() === "") {
      flush();
      output.push(line);
      table = false;
      continue;
    }
    const indent = columns(line.match(/^[ \t]*/)[0]);
    const opening = openingFence(line);
    const item = line.match(/^([ \t]*(?:[-+*]|\d+[.)])([ \t]+))/);
    const reference = line.match(/^\s*\[(?:\\.|[^\]\\])+\]:[ \t]*(.*)$/);
    const structural =
      reference !== null ||
      /^\s*(?:#{1,6}(?:\s|$)|>|<)/.test(line) ||
      /^ {0,3}(?:[=-]+|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})[ \t]*$/.test(line);
    // Less indentation only exits a list when this is not lazy paragraph continuation text.
    if (prose === null || opening || item || structural) {
      while (listContainers.length && indent < listContainers.at(-1)) listContainers.pop();
    }
    const containerIndent = listContainers.at(-1) ?? 0;
    // Indented code is literal, even when its contents resemble a list or another Markdown block.
    if (indent >= containerIndent + 4) {
      flush();
      output.push(line);
      continue;
    }
    if (opening && indent - containerIndent <= 3) {
      flush();
      fence = { marker: opening[1][0], length: opening[1].length, containerIndent };
      output.push(line);
      continue;
    }
    if ((table && line.includes("|")) || line.trimStart().startsWith("|") || tableSeparator(lines[index + 1] ?? "")) {
      flush();
      table = true;
      output.push(line);
      continue;
    }
    table = false;
    if (reference) {
      flush();
      const end = referenceEnd(index, reference[1]);
      output.push(...lines.slice(index, end + 1));
      index = end;
      continue;
    }
    if (structural) {
      flush();
      if (line.trimStart().startsWith("<")) {
        const terminator = htmlTerminator(line);
        html = terminator?.test(line) ? null : { terminator };
      }
      output.push(line);
      continue;
    }
    if (item) {
      flush();
      const markerIndent = columns(item[1].slice(0, -item[2].length));
      const padding = columns(item[1]) - markerIndent;
      // Five or more padding columns begin indented code; only one belongs to the list marker.
      const contentIndent = markerIndent + (padding > 4 ? 1 : padding);
      listContainers.push(contentIndent);
      const itemOpening = padding > 4 ? null : openingFence(line.slice(item[1].length));
      if (itemOpening) {
        fence = { marker: itemOpening[1][0], length: itemOpening[1].length, containerIndent: contentIndent };
        output.push(line);
      } else if (padding > 4) {
        output.push(line);
      } else {
        prose = line;
      }
      continue;
    }
    if (prose !== null && !/(?: {2,}|\\)$/.test(prose)) {
      prose += " " + line.trimStart();
    } else {
      flush();
      prose = line;
    }
  }
  flush();
  return output.join(newline);
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
  // A merge commit always stands for a PR, which the generated body either
  // lists or excludes on purpose (release.yml's `release`/`skip-changelog`);
  // either way it is not a direct commit. Only without a generated body (local
  // dry runs) does it stay, as the sole record of that PR.
  //
  // A squash commit is covered when the generated body lists its (#N).
  // generate-notes ends each entry with "in .../pull/N"; only that trailing
  // link counts, so a PR or issue cited inside a title covers nothing. Bare
  // "in #N" is accepted too.
  const hasGeneratedBody = generatedBody.trim() !== "";
  const covered = new Set([...generatedBody.matchAll(/\bin (?:\S+\/pull\/|#)(\d+)\s*$/gm)].map((match) => match[1]));
  const direct = commits.filter((commit) => {
    if (/^Merge pull request #\d+ from /.test(commit.subject)) return !hasGeneratedBody;
    const ref = commit.subject.match(/\(#(\d+)\)\s*$/);
    return ref === null || !covered.has(ref[1]);
  });

  const render = (withBodies) => {
    const parts = [
      ...(highlights.trim() ? [unwrapProse(highlights.trim()), ""] : []),
      "## Harness support",
      "",
      harnessTable.trim(),
      "",
    ];
    if (generatedBody.trim() !== "") {
      parts.push(generatedBody.trim(), "");
    }
    if (direct.length > 0) {
      parts.push("## Direct commits", "");
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

  // Links are relative to docs/; normalize so ../README.md leaves docs/.
  const highlights = readFileSync(resolve(ROOT, "docs/release-highlights.md"), "utf8").replaceAll(
    /\]\(([\w./-]+\.md(?:#[\w-]+)?)\)/g,
    (_, path) => {
      const target = posix.normalize(`docs/${path}`);
      return repo ? `](https://github.com/${repo}/blob/${sha}/${target})` : `](${target})`;
    },
  );
  const body = composeNotes({ highlights, harnessTable, generatedBody, commits });
  writeFileSync(resolve(ROOT, output), body, "utf8");
  console.log(`release notes written to ${output} (${body.length} chars, ${commits.length} commits in range)`);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await main();
}
