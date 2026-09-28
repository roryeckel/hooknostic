#!/usr/bin/env node
// File-tool hook capture with no model spend: the real harness binary runs
// against the loopback playback model, which emits one scripted tool call per
// case. Hook payloads are native output; only the model's replies (and so the
// argument VALUES) are ours. See README.md for the question and provenance.
//
//   node --experimental-strip-types .capture/file-tools/drive.mjs <claude|codex|opencode-v1> [--only <case>]
//
// Writes .capture/file-tools/captured/<harness>/<case>/ (git-ignored):
// discovery.json (the tools the harness advertised, with their argument keys)
// and the tee's raw per-event JSONL. Promotion to fixtures is a separate,
// reviewed step (promote.mjs).
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(fileURLToPath(new URL("../..", import.meta.url)));
register(new URL("../../scripts/ts-resolve-hook.mjs", import.meta.url).href);
const { describeTools, prepareOpenCodePluginDependency, startModelPlayback } = await import(
  pathToFileURL(join(REPO, "packages/cli/test/harness-playback.ts")).href
);
const { driveClaude, driveCodex, driveOpencode, prepareScratch, writeOpencodeConfig } = await import(
  pathToFileURL(join(REPO, "scripts/drive-capture-session.mjs")).href
);

const OUT = join(REPO, ".capture/file-tools/captured");
const PROMPT = "Use the requested file tool exactly once, then stop.";
const PROTOCOL = { claude: "anthropic-messages", codex: "openai-responses", "opencode-v1": "openai-chat" };
// A 1x1 transparent PNG, for view_image.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** The first of `candidates` the live schema declares -- never a remembered key. */
function key(tool, candidates) {
  const found = candidates.find((candidate) => tool.properties.includes(candidate));
  if (found === undefined) throw new Error(`${tool.name} declares none of ${candidates.join(", ")}: ${tool.properties}`);
  return found;
}

function seed(scratch) {
  writeFileSync(join(scratch, "seed.txt"), "alpha\n", "utf8");
  writeFileSync(join(scratch, "doomed.txt"), "goodbye\n", "utf8");
  writeFileSync(join(scratch, "probe.png"), PNG);
  writeFileSync(
    join(scratch, "seed.ipynb"),
    JSON.stringify({
      cells: [{ cell_type: "code", id: "probe", metadata: {}, source: ["print('alpha')"], outputs: [], execution_count: null }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }),
    "utf8",
  );
}

/** Cases per harness, built from the tools its discovery turn advertised. */
function casesFor(harness, tools, scratch) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const abs = (name) => join(scratch, name);
  const call = (name, build) => {
    const tool = byName.get(name);
    return tool === undefined ? undefined : { kind: "tool", toolName: name, arguments: build(tool) };
  };
  const cases = {};
  const add = (name, ...turns) => {
    if (turns.every((turn) => turn !== undefined)) cases[name] = [...turns, { kind: "text" }];
  };

  if (harness === "claude") {
    const read = (file) => call("Read", (tool) => ({ [key(tool, ["file_path"])]: abs(file) }));
    add("write", call("Write", (tool) => ({ [key(tool, ["file_path"])]: abs("probe-write.txt"), content: "hooknostic probe\n" })));
    // Claude refuses an edit to a file the session has not read, before hooks run.
    add("edit", read("seed.txt"), call("Edit", (tool) => ({ [key(tool, ["file_path"])]: abs("seed.txt"), old_string: "alpha", new_string: "beta" })));
    add(
      "multiedit",
      read("seed.txt"),
      call("MultiEdit", (tool) => ({ [key(tool, ["file_path"])]: abs("seed.txt"), edits: [{ old_string: "alpha", new_string: "gamma" }] })),
    );
    add(
      "notebookedit",
      read("seed.ipynb"),
      call("NotebookEdit", (tool) => ({
        [key(tool, ["notebook_path"])]: abs("seed.ipynb"),
        ...(tool.properties.includes("cell_id") ? { cell_id: "probe" } : {}),
        new_source: "print('beta')",
      })),
    );
  }

  if (harness === "codex") {
    const patch = (text) => (byName.has("apply_patch") ? { kind: "tool", toolName: "apply_patch", freeformInput: text } : undefined);
    add("patch-add", patch("*** Begin Patch\n*** Add File: added.txt\n+hooknostic probe\n*** End Patch\n"));
    add("patch-update-move", patch("*** Begin Patch\n*** Update File: seed.txt\n*** Move to: moved.txt\n@@\n-alpha\n+beta\n*** End Patch\n"));
    add("patch-delete", patch("*** Begin Patch\n*** Delete File: doomed.txt\n*** End Patch\n"));
    add(
      "patch-multi",
      patch("*** Begin Patch\n*** Add File: one.txt\n+one\n*** Update File: seed.txt\n@@\n-alpha\n+delta\n*** End Patch\n"),
    );
    add("view-image", call("view_image", (tool) => ({ [key(tool, ["path", "file_path"])]: abs("probe.png") })));
  }

  if (harness === "opencode-v1") {
    const read = (file) => call("read", (tool) => ({ [key(tool, ["filePath", "file_path", "path"])]: abs(file) }));
    add("read", read("seed.txt"));
    add("write", call("write", (tool) => ({ [key(tool, ["filePath", "file_path", "path"])]: abs("probe-write.txt"), content: "hooknostic probe\n" })));
    add(
      "edit",
      read("seed.txt"),
      call("edit", (tool) => ({
        [key(tool, ["filePath", "file_path", "path"])]: abs("seed.txt"),
        [key(tool, ["oldString", "old_string"])]: "alpha",
        [key(tool, ["newString", "new_string"])]: "beta",
      })),
    );
    // OpenCode swaps edit/write for apply_patch when the model id looks like a
    // GPT model; the second discovery label exists to reach it.
    add(
      "apply_patch",
      call("apply_patch", (tool) => ({
        [key(tool, ["patchText"])]:
          "*** Begin Patch\n*** Add File: added.txt\n+hooknostic probe\n*** Update File: seed.txt\n@@\n-alpha\n+beta\n*** End Patch",
      })),
    );
  }
  return cases;
}

async function session(harness, script, modelLabel = "hooknostic-playback") {
  const teeHarness = harness === "opencode-v1" ? "opencode" : harness;
  const scratch = join(mkdtempSync(join(tmpdir(), "hkn-file-tools-")), teeHarness);
  prepareScratch(REPO, teeHarness, scratch);
  seed(scratch);
  if (harness === "opencode-v1") {
    const version = process.env["HOOKNOSTIC_PLAYBACK_VERSION"];
    if (!version) throw new Error("HOOKNOSTIC_PLAYBACK_VERSION is required for opencode-v1");
    await prepareOpenCodePluginDependency(scratch, version);
  }
  const server = await startModelPlayback(
    PROTOCOL[harness],
    "rewrite",
    typeof script === "function" ? script(scratch) : script,
    // Codex advertises view_image only to a model that accepts images.
    harness === "codex" ? { input_modalities: ["text", "image"] } : {},
  );
  let result;
  try {
    if (harness === "claude") result = await driveClaude(scratch, { url: server.baseUrl }, PROMPT);
    else if (harness === "codex")
      result = await driveCodex(scratch, { baseUrl: `${server.baseUrl}/v1`, name: "hooknostic-playback" }, PROMPT);
    else {
      writeOpencodeConfig(scratch, server.baseUrl, "hooknostic-playback", modelLabel);
      result = await driveOpencode(scratch, modelLabel, PROMPT);
    }
  } finally {
    await server.close();
  }
  const captured = teeHarness === "opencode" ? join(scratch, ".opencode", "plugins", "captured") : join(scratch, "captured");
  return { scratch, captured, result, server };
}

async function main() {
  const harness = process.argv[2];
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;
  if (!(harness in PROTOCOL)) {
    console.error("usage: drive.mjs <claude|codex|opencode-v1> [--only <case>]");
    process.exit(2);
  }
  const labels = harness === "opencode-v1" ? ["hooknostic-playback", "gpt-5-playback"] : ["hooknostic-playback"];
  const discovered = {};
  for (const label of labels) {
    const probe = await session(harness, [{ kind: "text", text: "discovery complete" }], label);
    const request = probe.server.requests.find((entry) => describeTools(entry).length > 0);
    discovered[label] = request === undefined ? [] : describeTools(request);
    console.log(`[discover ${label}] exit=${probe.result.code} tools=${discovered[label].map((t) => t.name).join(", ")}`);
  }
  mkdirSync(join(OUT, harness), { recursive: true });
  writeFileSync(join(OUT, harness, "discovery.json"), JSON.stringify(discovered, null, 2) + "\n", "utf8");

  for (const label of labels) {
    const names = Object.keys(casesFor(harness, discovered[label], "<scratch>"));
    for (const name of names) {
      const caseName = label === labels[0] ? name : `${name}@${label}`;
      if (only !== undefined && only !== caseName) continue;
      // An OpenCode label only earns a second pass for tools the default lacked.
      if (label !== labels[0] && discovered[labels[0]].some((tool) => tool.name === name)) continue;
      const run = await session(harness, (scratch) => casesFor(harness, discovered[label], scratch)[name], label);
      const dest = join(OUT, harness, caseName);
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dest, { recursive: true });
      try {
        cpSync(run.captured, dest, { recursive: true });
      } catch {
        // No tee output at all is itself the finding; the summary says so.
      }
      writeFileSync(
        join(dest, "drive.json"),
        JSON.stringify({ exit: run.result.code, errors: run.server.errors, tail: (run.result.stdout + run.result.stderr).slice(-2000) }, null, 2) + "\n",
        "utf8",
      );
      console.log(`[${caseName}] exit=${run.result.code} playbackErrors=${run.server.errors.length} -> ${dest}`);
    }
  }
}

await main();
