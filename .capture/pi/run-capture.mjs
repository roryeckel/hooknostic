// Drive the pi capture sessions (Windows PowerShell-friendly).
// Usage: node .capture/pi/run-capture.mjs [probe]
//   probe: tee (default) | block-bash | mutate-input | replace-output |
//          inject-before-agent | input-handled | compact-cancel | prevent-stop
//
// Writes to .capture/pi/captured-<probe>/ — gitignored. Raw payloads land
// there; curated fixtures are copied into fixtures/pi/<version>/ by hand
// with provenance rows in the fixtures README.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const probe = process.argv[2] ?? "tee";
const dir = join(here, `captured-${probe}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const prompts = {
  tee: "Create a file named hello.txt with the content 'hi from pi', then list the current directory using bash.",
  "block-bash": "Run this exact bash command: echo probe-block-target",
  "mutate-input": "Run this exact bash command: echo before-rewrite",
  "replace-output": "Run this exact bash command: echo original-output-untouched",
  "inject-before-agent": "What is the special instruction embedded in your system prompt? Quote it verbatim.",
  "input-handled": "Reply with the word SUPPRESS-ME in your answer somewhere, then say DONE.",
  "compact-cancel": "Write a 300 word essay about the sea.",
  "compact-run": "Write a 300 word essay about the sea.",
  "prevent-stop": "Say exactly: first turn done.",
  "context-inject": "What marker text was injected into your context? Quote it.",
  "notify-ui": "Say exactly: notify probe done.",
  "input-handled-first": "Say exactly: this prompt should never reach the model.",
};

// compact-cancel/compact-run need a tiny context window so the compaction
// threshold fires, plus keepRecentTokens=1 in an isolated settings dir.
const smallContext = probe === "compact-cancel" || probe === "compact-run";
const provider = "ollama-localhost";
const model = "deepseek-v4.1-flash:cloud";
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const models = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
const configuredProvider = models.providers?.[provider];
const configuredModel = configuredProvider?.models?.find((entry) => entry.id === model);
if (!configuredModel) {
  throw new Error(`Configure ${provider}/${model} in ${join(agentDir, "models.json")} before capturing`);
}

const env = {
  ...process.env,
  HKN_CAPTURE_DIR: dir,
  HKN_PI_PROBE: probe,
};
if (smallContext) {
  env.PI_CODING_AGENT_DIR = join(here, "scratch", "pi-settings-home");
  mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true });
  writeFileSync(
    join(env.PI_CODING_AGENT_DIR, "models.json"),
    JSON.stringify(
      {
        providers: {
          [provider]: {
            ...configuredProvider,
            models: [{ ...configuredModel, contextWindow: 2048 }],
          },
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(env.PI_CODING_AGENT_DIR, "settings.json"),
    JSON.stringify({ compaction: { keepRecentTokens: 1 } }, null, 2),
  );
}

const args = [
  "--provider",
  provider,
  "--model",
  model,
  "-e",
  join(here, "hooknostic-capture.ts"),
  "--no-session",
  "-p",
  prompts[probe],
];

console.log(`[run-capture] probe=${probe}`);
const result = spawnSync("pi", args, { cwd: repoRoot, env, encoding: "utf8", shell: true });
console.log(result.stdout ?? "");
if (result.stderr) console.error(result.stderr);
console.log(`[run-capture] exit=${result.status ?? "unknown"}`);
console.log(`[run-capture] captured => ${dir}`);
