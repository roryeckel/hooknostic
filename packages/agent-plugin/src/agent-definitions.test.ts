import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadAgentDefinitions,
  loadProjectComponents,
  parseMarkdownFrontmatter,
  renderMarkdownFrontmatter,
} from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function directory(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hooknostic-agents-"));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  return root;
}

const reviewer = "---\nname: reviewer\ndescription: Reviews diffs. Use after code changes.\n---\nYou review diffs.\n";

describe("loadAgentDefinitions", () => {
  it("parses the portable core and each harness's native block", async () => {
    const root = await directory({
      "reviewer.md": [
        "---",
        "name: reviewer",
        "description: Reviews diffs. Use after code changes.",
        "native:",
        "  claude:",
        "    model: sonnet",
        "    tools: [Read, Grep]",
        "  codex:",
        "    model_reasoning_effort: high",
        "---",
        "You review diffs.",
        "",
      ].join("\r\n"),
    });

    const loaded = await loadAgentDefinitions({ directories: [root] });

    expect(loaded.issues).toEqual([]);
    expect(loaded.agents).toEqual([
      {
        name: "reviewer",
        description: "Reviews diffs. Use after code changes.",
        // A file that does not say is a subagent (ADR-0028, decision 9).
        mode: "subagent",
        // CRLF from a Windows checkout is normalized, so generated files do not
        // depend on git's line-ending settings.
        instructions: "You review diffs.\n",
        native: { claude: { model: "sonnet", tools: ["Read", "Grep"] }, codex: { model_reasoning_effort: "high" } },
        source: join(root, "reviewer.md"),
      },
    ]);
  });

  it("reads each mode, and a file that names none is a subagent", async () => {
    const root = await directory({
      "planner.md": "---\nname: planner\ndescription: Plans work.\nmode: primary\n---\nYou plan.\n",
      "reviewer.md": reviewer,
      "tester.md": "---\nname: tester\ndescription: Tests code.\nmode: subagent\n---\nYou test.\n",
      "writer.md": "---\nname: writer\ndescription: Writes docs.\nmode: all\n---\nYou write.\n",
    });

    const loaded = await loadAgentDefinitions({ directories: [root] });

    expect(loaded.issues).toEqual([]);
    expect(Object.fromEntries(loaded.agents.map((agent) => [agent.name, agent.mode]))).toEqual({
      planner: "primary",
      reviewer: "subagent",
      tester: "subagent",
      writer: "all",
    });
  });

  it.each([
    ["no frontmatter", "You review diffs.\n", "must begin with YAML frontmatter"],
    ["an unknown mode", "---\nname: reviewer\ndescription: d\nmode: main\n---\nx\n", "mode must be one of"],
    ["an empty mode", "---\nname: reviewer\ndescription: d\nmode:\n---\nx\n", "mode must be one of"],
    ["a reserved key", "---\nname: reviewer\ndescription: d\nmodel: sonnet\n---\nx\n", "`model` is reserved"],
    ["an unknown key", "---\nname: reviewer\ndescription: d\ncolour: red\n---\nx\n", "unknown field `colour`"],
    ["a name unlike the file", "---\nname: other\ndescription: d\n---\nx\n", "must equal the file name"],
    ["an invalid name", "---\nname: Reviewer\ndescription: d\n---\nx\n", "lowercase letters and digits"],
    ["a multi-line description", "---\nname: reviewer\ndescription: |\n  a\n  b\n---\nx\n", "single line"],
    ["an empty body", "---\nname: reviewer\ndescription: d\n---\n  \n", "instructions"],
    ["a non-mapping native", "---\nname: reviewer\ndescription: d\nnative: [claude]\n---\nx\n", "native must map"],
    [
      "a malformed harness key",
      "---\nname: reviewer\ndescription: d\nnative:\n  Claude: {}\n---\nx\n",
      "not a harness",
    ],
    [
      "a scalar native block",
      "---\nname: reviewer\ndescription: d\nnative:\n  claude: sonnet\n---\nx\n",
      "native.claude",
    ],
  ])("skips a definition with %s, as a warn issue", async (_label, text, message) => {
    const root = await directory({ "reviewer.md": text });

    const loaded = await loadAgentDefinitions({ directories: [root] });

    expect(loaded.agents).toEqual([]);
    expect(loaded.issues).toEqual([
      expect.objectContaining({
        severity: "warn",
        scope: "agent",
        component: "agents.definition",
        message: expect.stringContaining(message),
      }),
    ]);
  });

  it("rejects a name defined in two directories", async () => {
    const first = await directory({ "reviewer.md": reviewer });
    const second = await directory({ "reviewer.md": reviewer });

    const loaded = await loadAgentDefinitions({ directories: [first, second] });

    expect(loaded.agents.map((agent) => agent.source)).toEqual([join(first, "reviewer.md")]);
    expect(loaded.issues).toEqual([
      expect.objectContaining({ severity: "error", message: expect.stringContaining("duplicate agent name") }),
    ]);
  });

  it("reads only Markdown directly in the directory, and says so about subdirectories", async () => {
    const root = await directory({
      "reviewer.md": reviewer,
      "notes.txt": "not a definition",
      ".draft.md": "---\n---\n",
      "nested/tester.md": reviewer.replaceAll("reviewer", "tester"),
    });

    const loaded = await loadAgentDefinitions({ directories: [root] });

    expect(loaded.agents.map((agent) => agent.name)).toEqual(["reviewer"]);
    expect(loaded.issues).toEqual([
      expect.objectContaining({ severity: "info", message: expect.stringContaining("is not scanned") }),
    ]);
  });

  it("applies exclusion globs to file names", async () => {
    const root = await directory({ "reviewer.md": reviewer, "wip-tester.md": "broken" });

    const loaded = await loadAgentDefinitions({ directories: [root], exclude: ["WIP-*"] });

    expect(loaded.issues).toEqual([]);
    expect(loaded.agents.map((agent) => agent.name)).toEqual(["reviewer"]);
  });

  it("reports a missing directory instead of rejecting", async () => {
    const root = await directory({});

    const loaded = await loadAgentDefinitions({ directories: [join(root, "missing")] });

    expect(loaded.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining("could not read agent directory"),
      }),
    ]);
  });

  it("is loaded as a direct project component", async () => {
    const root = await directory({ "reviewer.md": reviewer });

    const loaded = await loadProjectComponents({ agents: [root] });

    expect(loaded.issues).toEqual([]);
    expect(loaded.source.agents?.map((agent) => agent.name)).toEqual(["reviewer"]);
    expect(loaded.source.skills).toEqual([]);
  });
});

describe("renderMarkdownFrontmatter", () => {
  it("round-trips through the parser, keeping long scalars on one line", () => {
    const description = `Reviews diffs: ${"thoroughly ".repeat(20).trim()} # not a comment`;
    const text = renderMarkdownFrontmatter({ name: "reviewer", description, tools: ["Read"] }, "Body");

    expect(text.split("\n").filter((line) => line.startsWith("description:"))).toHaveLength(1);
    expect(parseMarkdownFrontmatter(text, "test")).toEqual({
      data: { name: "reviewer", description, tools: ["Read"] },
      body: "Body\n",
    });
  });
});
