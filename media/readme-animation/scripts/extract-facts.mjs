// Derives every harness fact the README animation shows from the adapter
// registry and the captured fixtures, the sources docs/harness-support.md is
// generated from. Nothing here is typed in: a fact the adapters and fixtures
// do not state fails the script rather than being guessed. Run after the root
// `pnpm build` (imports the built CLI):
//
//   pnpm facts            write src/facts.json
//   pnpm facts --check    exit 1 if src/facts.json is stale
import { readFileSync, writeFileSync } from "node:fs";

const repo = new URL("../../../", import.meta.url);
const out = new URL("../src/facts.json", import.meta.url);
const { defaultAdapterRegistry } = await import(new URL("packages/cli/dist/index.js", repo).href);

// Matrix columns, in order. The levels are what the animation knows how to draw.
const CAPABILITIES = ["tool.before.block", "tool.before.input.replace", "tool.before.context.add", "turn.stop.prevent"];
const LEVELS = new Set(["exact", "emulated", "approximate", "unsupported"]);

// Which captured tool.before shell payload stands for each harness family. The
// choice of evidence file is the only input; every value shown is read from it.
// Each entry must be marked captured in its fixture directory's README: Codex's
// pre-tool-exec-command is constructed defensive coverage that no hook has been
// observed receiving, so Codex uses its captured Bash payload.
const SHELL_FIXTURES = {
  "Claude Code": "pre-tool-bash",
  "Codex CLI": "pre-tool-bash",
  "GitHub Copilot CLI": "tool-before-bash",
  OpenCode: "tool-before",
  "OpenCode v2": "tool-before",
  pi: "tool-call-bash",
};

const fail = (message) => {
  throw new Error(`extract-facts: ${message}`);
};

// The same family expansion as scripts/generate-harness-support.mjs.
const adapters = Object.values(defaultAdapterRegistry()).flatMap((adapter) =>
  adapter.harnessFamilies
    ? adapter.harnessFamilies.map(
        (harness) =>
          adapter.resolveTarget({ id: adapter.id, version: harness.recommendedRange, delivery: "project", output: "." })
            .adapter,
      )
    : [adapter],
);

const harnesses = adapters.map((adapter) => {
  const meta = adapter.harness;
  const name = meta.displayName;
  const { matrix } = adapter.capabilities({
    id: adapter.id,
    version: meta.recommendedRange,
    delivery: "project",
    output: ".",
  });
  // An absent matrix entry is the adapter's way of saying unsupported.
  const grades = Object.fromEntries(CAPABILITIES.map((id) => [id, matrix[id]?.level ?? "unsupported"]));
  for (const [id, level] of Object.entries(grades)) {
    if (!LEVELS.has(level)) fail(`${name}: unknown support level ${level} for ${id}`);
  }

  const fixture = SHELL_FIXTURES[name] ?? fail(`${name}: no shell fixture chosen; add one to SHELL_FIXTURES`);
  const evidence = `fixtures/${adapter.id}/${meta.fixtureDir}/${fixture}.canonical.json`;
  const event = JSON.parse(readFileSync(new URL(evidence, repo), "utf8"));
  if (event.event !== "tool.before" || event.tool?.kind !== "shell") fail(`${evidence}: not a tool.before shell event`);
  const commandKey = event.tool.shell?.commandKey;
  if (typeof commandKey !== "string" || commandKey === "") fail(`${evidence}: missing tool.shell.commandKey`);
  return { name, grades, commandKey, evidence };
});

const unused = Object.keys(SHELL_FIXTURES).filter((name) => !harnesses.some((h) => h.name === name));
if (unused.length > 0) fail(`SHELL_FIXTURES names unknown families: ${unused.join(", ")}`);

const facts = `${JSON.stringify({ capabilities: CAPABILITIES, harnesses }, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(out, "utf8") !== facts) {
    console.error("src/facts.json is stale: run `pnpm facts`, then re-render the GIFs");
    process.exit(1);
  }
  console.log("src/facts.json is current");
} else {
  writeFileSync(out, facts);
  console.log(`wrote src/facts.json (${harnesses.length} harness families)`);
}
