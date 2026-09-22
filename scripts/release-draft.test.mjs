import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const workflow = () => read(".github/workflows/release-draft.yml");
const steps = (source) => source.split(/\n {6}- /).slice(1);
const stepNamed = (source, name) => {
  const step = steps(source).find((step) => step.startsWith(`name: ${name}\n`));
  if (!step) throw new Error(`missing workflow step ${name}`);
  return step;
};

// Extract the actual run body, so the probe exercises what Actions executes.
function runBody(step) {
  const match = /^ {8}run: (.*)(?:\n|$)/m.exec(step);
  if (!match) return undefined;
  if (match[1] !== "|") return match[1];
  const lines = step.slice(match.index + match[0].length).split("\n");
  const body = [];
  for (const line of lines) {
    if (line && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

const context = {
  "github.event_name": "pull_request",
  "github.event.pull_request.head.ref": "release/v0.2.0",
  "github.event.pull_request.merge_commit_sha": "a".repeat(40),
  "inputs.version": "0.2.0",
  "inputs.target_ref": "master",
  "inputs.draft": "true",
  "inputs.previous_tag": "",
};
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runStep(name, overrides = {}) {
  const values = { ...context, ...overrides };
  const interpolate = (text) =>
    text.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_match, key) => {
      if (!(key in values)) throw new Error(`unhandled workflow expression ${key}`);
      return values[key];
    });
  const step = stepNamed(workflow(), name);
  const env = Object.fromEntries(
    [...step.matchAll(/^ {10}([A-Z_]+): (.+)$/gm)].map(([, name, value]) => [name, interpolate(value)]),
  );
  const root = mkdtempSync(join(tmpdir(), "hooknostic-release-step-"));
  dirs.push(root);
  // Git for Windows supplies Bash; do not accidentally launch WSL's bash.exe.
  const bash =
    process.platform === "win32" ? join(process.env.ProgramFiles ?? "C:/Program Files", "Git/bin/bash.exe") : "bash";
  const result = spawnSync(bash, ["--noprofile", "--norc", "-eo", "pipefail"], {
    input: interpolate(runBody(step)),
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, ...env, GITHUB_OUTPUT: "outputs.txt" },
  });
  expect(result.error).toBeUndefined();
  return {
    ...result,
    marker: existsSync(join(root, "marker")),
    output: existsSync(join(root, "outputs.txt")) ? readFileSync(join(root, "outputs.txt"), "utf8") : "",
  };
}

it("keeps expression interpolation out of every draft workflow run body", () => {
  for (const step of steps(workflow())) expect(runBody(step) ?? "").not.toContain("${{");
});

it.each(["branch", "dispatch"])("rejects a %s version containing shell substitution without executing it", (source) => {
  const payload = "$(printf${IFS}executed>marker)";
  const result = runStep(
    "Resolve version and target",
    source === "branch"
      ? {
          "github.event.pull_request.head.ref": `release/v${payload}`,
        }
      : {
          "github.event_name": "workflow_dispatch",
          "inputs.version": payload,
        },
  );
  expect(result.marker).toBe(false);
  expect(result.status).not.toBe(0);
  expect(result.output).toBe("");
});

it.each(["version", "target_ref", "draft", "previous_tag"])(
  "rejects newlines in the %s input before emitting metadata",
  (field) => {
    for (const separator of ["\n", "\r"]) {
      const result = runStep("Resolve version and target", {
        "github.event_name": "workflow_dispatch",
        [`inputs.${field}`]: `${context[`inputs.${field}`]}${separator}injected=value`,
      });
      expect(result.status).not.toBe(0);
      expect(result.output).toBe("");
    }
  },
);

it("accepts normal release metadata and treats manual refs as literal data", () => {
  const merged = runStep("Resolve version and target");
  expect(merged.status, merged.stderr).toBe(0);
  expect(merged.output).toBe(`version=0.2.0\nref=${"a".repeat(40)}\ndraft=true\n`);
  const ref = "release/$(printf${IFS}executed>marker)";
  const manual = runStep("Resolve version and target", {
    "github.event_name": "workflow_dispatch",
    "inputs.target_ref": ref,
    "inputs.draft": "false",
  });
  expect(manual.status, manual.stderr).toBe(0);
  expect(manual.marker).toBe(false);
  expect(manual.output).toBe(`version=0.2.0\nref=${ref}\ndraft=false\n`);
});

it("refuses an invalid draft flag before emitting metadata", () => {
  const result = runStep("Resolve version and target", {
    "github.event_name": "workflow_dispatch",
    "inputs.draft": "maybe",
  });
  expect(result.status).not.toBe(0);
  expect(result.output).toBe("");
});

it("passes a previous tag through literally instead of executing its contents", () => {
  const tag = "v$(printf${IFS}executed>marker)";
  const result = runStep("Previous tag", { "inputs.previous_tag": tag });
  expect(result.status, result.stderr).toBe(0);
  expect(result.marker).toBe(false);
  expect(result.output).toBe(`tag=${tag}\n`);
});

it("limits automatic releases and branch deletion to this repository's release branches", () => {
  const source = workflow();
  expect(source.slice(0, source.indexOf("    runs-on:"))).toContain(
    "github.event.pull_request.head.repo.full_name == github.repository",
  );
  expect(stepNamed(source, "Delete the release branch")).toContain(
    "github.event.pull_request.head.repo.full_name == github.repository",
  );
});

it("uses the canonical example rebuild during release preparation", () => {
  expect(
    runBody(
      stepNamed(read(".github/workflows/release-prepare.yml"), "Rebuild committed example artifacts (repo root)"),
    ).trim(),
  ).toBe("pnpm build:examples");
});
